'use strict';

/**
 * Weighted mixing of several TMDB feeds into one row.
 *
 * This is how Indian movies and series are blended into general rows: a row
 * (or collection folder) lists several components, for example "trending
 * worldwide" with weight 3 and "popular Indian titles" with weight 1. The row
 * is one endless stream that interleaves them in that ratio with smooth
 * weighted round-robin (the nginx algorithm): with weights 2:1 the order is
 * A, A, B, A, A, B rather than clumps.
 *
 * Paging works on positions in that stream, not on page numbers. Nuvio asks
 * for the next page with skip = skip + items received, and drops titles it
 * already shows, so after a short page (an item without an IMDb id, a
 * duplicate) the next page overlaps a little and nothing is skipped. Any skip
 * maps to an exact place: how many items each component used before it, and
 * which component owns each following slot.
 */

const TMDB_PAGE = 20;
// TMDB serves at most 500 pages (10,000 titles) per feed. Positions beyond a
// generous multiple of that hold nothing, and a cap keeps the arithmetic exact.
const MAX_POSITION = 100000;

/**
 * Fetch items [start, start + count) of one paginated TMDB endpoint.
 * @param {object} client TMDB client
 * @param {string} endpoint
 * @param {object} params resolved query params
 * @param {number} start
 * @param {number} count
 * @returns {Promise<object[]>}
 */
async function fetchWindow(client, endpoint, params, start, count) {
  if (count <= 0) return [];
  const first = Math.floor(start / TMDB_PAGE) + 1;
  const last = Math.floor((start + count - 1) / TMDB_PAGE) + 1;
  const out = [];
  for (let page = first; page <= last && page <= 500; page++) {
    let data;
    try {
      data = await client.get(endpoint, { ...params, page });
    } catch (err) {
      if (err && err.code === 'NO_TMDB_KEY') throw err;
      break; // keep what we have on a transient failure
    }
    const results = (data && data.results) || [];
    const base = (page - 1) * TMDB_PAGE;
    results.forEach((r, i) => {
      const abs = base + i;
      if (abs >= start && abs < start + count) out.push(r);
    });
    if (results.length < TMDB_PAGE || (data.total_pages && page >= data.total_pages)) break;
  }
  return out;
}

/**
 * Positions in the smooth weighted round-robin stream: how many slots each
 * component used before `start`, and which component owns each of the next
 * `count` slots. Pure arithmetic. With whole-number weights the stream repeats
 * every sum(weights) slots, so a deep `start` costs nothing extra.
 * @param {number[]} weights
 * @param {number} start
 * @param {number} count
 * @returns {{before: number[], order: number[]}}
 */
function roundRobinWindow(weights, start, count) {
  // Whole-number weights only: the stream then repeats every sum(weights) slots.
  const w = weights.map((x) => (Number(x) > 0 ? Math.max(1, Math.round(Number(x))) : 0));
  const total = w.reduce((a, b) => a + b, 0);
  const before = w.map(() => 0);
  const order = [];
  if (!total || count <= 0) return { before, order };

  let skip = Math.min(MAX_POSITION, Math.max(0, Math.floor(Number(start) || 0)));
  const cycles = Math.floor(skip / total);
  w.forEach((x, i) => {
    before[i] += cycles * x;
  });
  skip -= cycles * total; // now below total, so the walk below is short
  const current = w.map(() => 0);
  for (let step = 0; step < skip + count; step++) {
    let best = -1;
    for (let i = 0; i < w.length; i++) {
      if (!w[i]) continue;
      current[i] += w[i];
      if (best < 0 || current[i] > current[best]) best = i;
    }
    current[best] -= total;
    if (step < skip) before[best]++;
    else order.push(best);
  }
  return { before, order };
}

/**
 * Items [start, start + count) of a mixed feed. Slots owned by a feed that has
 * run out stay empty, so the page comes back short; duplicates within the page
 * are dropped (Nuvio also drops items it already shows in the row).
 * @param {object} client TMDB client
 * @param {Array<{endpoint: string, params?: object, weight: number}>} components
 * @param {number} start position in the stream
 * @param {number} count
 * @returns {Promise<object[]>} raw TMDB items in display order
 */
async function fetchMixedWindow(client, components, start, count) {
  const live = components.filter((c) => c && c.endpoint && Number(c.weight) > 0);
  if (!live.length || count <= 0) return [];
  const { before, order } = roundRobinWindow(live.map((c) => c.weight), start, count);
  const need = live.map((_, i) => order.filter((x) => x === i).length);
  const lists = await Promise.all(
    live.map((c, i) => fetchWindow(client, c.endpoint, c.params || {}, before[i], need[i]))
  );
  const cursor = live.map(() => 0);
  const seen = new Set();
  const out = [];
  for (const i of order) {
    const item = lists[i][cursor[i]++];
    if (!item || item.id === undefined || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

module.exports = { roundRobinWindow, fetchWindow, fetchMixedWindow, TMDB_PAGE, MAX_POSITION };

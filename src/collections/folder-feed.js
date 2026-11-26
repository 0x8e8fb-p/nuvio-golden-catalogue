'use strict';

/**
 * Fetches one page of a collection folder's titles.
 *
 * A folder tab is one of:
 *   - a blended TMDB feed: weighted components, e.g. worldwide + Indian;
 *   - { franchise: id }: a TMDB collection, released films oldest first;
 *   - { parts: { collections, movies } }: a shared universe assembled from
 *     several TMDB collections plus single films, in release order;
 *   - { director: personId }: the films a person directed, newest first
 *     (from their credits, so films they only produced are left out);
 *   - { list: url }: a public MDBList list.
 * All but lists return raw TMDB items, so the same mapper turns them into
 * Nuvio tiles.
 */

const { fetchMixedWindow } = require('../lib/mix');
const { TtlLruCache } = require('../lib/cache');
const { mapWithConcurrency } = require('../tmdb/mappers');

const DAY = 24 * 60 * 60 * 1000;
const listCache = new TtlLruCache({ ttl: DAY, max: 500 });

const today = () => new Date().toISOString().slice(0, 10);
const released = (p) => p && !p.adult && p.release_date && p.release_date <= today();
const byDate = (a, b) => String(a.release_date).localeCompare(String(b.release_date));

/** Cache a computed list per key for a day; failures and partial lists are not cached. */
async function cachedList(key, build) {
  const hit = listCache.get(key);
  if (hit) return hit;
  const { items, complete } = await build();
  if (complete) listCache.set(key, items);
  return items;
}

/**
 * Films of a TMDB collection, released ones only, oldest first.
 * @returns {Promise<object[]>} raw TMDB movie items
 */
async function franchiseParts(client, collectionId) {
  return cachedList(`franchise:${collectionId}`, async () => {
    const data = await client.get(`/collection/${collectionId}`);
    return { items: ((data && data.parts) || []).filter(released).sort(byDate), complete: true };
  });
}

/**
 * A universe from several collections and single films, released ones only,
 * in release order. A collection or film that fails to load is skipped for
 * this request, and the incomplete list is not cached, so it is tried again.
 * @param {{collections?: number[], movies?: number[]}} parts
 */
async function universeParts(client, parts) {
  const collections = parts.collections || [];
  const movies = parts.movies || [];
  return cachedList(`parts:${collections.join(',')}:${movies.join(',')}`, async () => {
    let complete = true;
    const fromCollections = await mapWithConcurrency(collections, 4, async (id) => {
      try {
        return await franchiseParts(client, id);
      } catch (err) {
        if (!(err && err.status === 404)) complete = false;
        return [];
      }
    });
    const singles = await mapWithConcurrency(movies, 4, async (id) => {
      try {
        return await client.get(`/movie/${id}`);
      } catch (err) {
        if (!(err && err.status === 404)) complete = false;
        return null;
      }
    });
    const seen = new Set();
    const items = fromCollections
      .flat()
      .concat(singles)
      .filter((m) => released(m) && !seen.has(m.id) && seen.add(m.id))
      .sort(byDate);
    return { items, complete };
  });
}

/**
 * Films a person directed, released ones only, newest first.
 * @param {number} personId TMDB person id
 */
async function directedFilms(client, personId) {
  return cachedList(`director:${personId}`, async () => {
    const data = await client.get(`/person/${personId}/movie_credits`);
    const seen = new Set();
    const items = ((data && data.crew) || [])
      .filter((c) => c.job === 'Director' && released(c) && !seen.has(c.id) && seen.add(c.id))
      .sort((a, b) => byDate(b, a));
    return { items, complete: true };
  });
}

/**
 * One page of a folder tab.
 * @param {object} client TMDB client
 * @param {object} source folder.sources[type]: components array, or one of
 *   {franchise}, {parts}, {director}, {list}, {related, mode}
 * @param {'movie'|'series'} type
 * @param {number} skip position in the folder's item stream (items already shown)
 * @param {number} pageSize
 * @param {{mdblist: object}} deps
 * @returns {Promise<{items?: object[], imdbIds?: string[]}>}
 */
async function folderPage(client, source, type, skip, pageSize, deps) {
  if (Array.isArray(source)) {
    return { items: await fetchMixedWindow(client, source, skip, pageSize) };
  }
  if (!source) return { items: [] };
  if (source.list) {
    if (!deps || !deps.mdblist) return { items: [] };
    return { imdbIds: await deps.mdblist.imdbIds(source.list, type, skip, skip + pageSize) };
  }
  let all = [];
  try {
    if (source.related) return { items: (await relatedFilms(client, source.related, source.mode)).slice(skip, skip + pageSize) };
    if (source.franchise) all = await franchiseParts(client, source.franchise);
    else if (source.parts) all = await universeParts(client, source.parts);
    else if (source.director) all = await directedFilms(client, source.director);
  } catch (err) {
    if (err && err.code === 'NO_TMDB_KEY') throw err;
    all = []; // TMDB unavailable: an empty tab, never an error
  }
  return { items: ordered(all, source.order, Boolean(source.director)).slice(skip, skip + pageSize) };
}

// Related titles are drawn from this many of the list's best-known films.
const RELATED_SEEDS = 4;
const RELATED_MODES = new Set(['recommendations', 'similar', 'cast', 'era']);
// The cast and era rows read this many of the list's best-known films.
const PROFILE_SEEDS = 6;

/** The films of a list source ({franchise}, {parts} or {director}). */
async function listFilms(client, list) {
  if (list.franchise) return franchiseParts(client, list.franchise);
  if (list.parts) return universeParts(client, list.parts);
  if (list.director) return directedFilms(client, list.director);
  return [];
}

/**
 * Films related to a franchise, universe or director's work: TMDB's
 * recommendations (mode "recommendations", what viewers also watched) or
 * similar films (mode "similar", by genre and keywords) of the list's most
 * voted films, interleaved; the other films of its leading faces (mode
 * "cast"); or its genre from its own years (mode "era"). Never the list's
 * own films, adult or unreleased titles. Cached when every lookup succeeded.
 * @returns {Promise<object[]>} raw TMDB movie items
 */
async function relatedFilms(client, list, mode) {
  if (!RELATED_MODES.has(mode)) return [];
  const key = `related:${mode}:${JSON.stringify(list)}`;
  return cachedList(key, async () => {
    const films = await listFilms(client, list);
    const own = new Set(films.map((f) => f.id));
    const byVotes = [...films].sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    if (mode === 'cast' || mode === 'era') {
      const found = mode === 'cast' ? await castQuery(client, byVotes.slice(0, PROFILE_SEEDS), list) : eraQuery(byVotes.slice(0, PROFILE_SEEDS));
      if (!found.params) return { items: [], complete: found.complete && films.length > 0 };
      let complete = found.complete;
      const pages = await mapWithConcurrency([1, 2], 2, async (page) => {
        try {
          const data = await client.get('/discover/movie', { ...found.params, page });
          return (data && data.results) || [];
        } catch {
          complete = false;
          return [];
        }
      });
      const seen = new Set();
      const items = pages.flat().filter((m) => m && !own.has(m.id) && !m.adult && released(m) && !seen.has(m.id) && seen.add(m.id));
      return { items, complete: complete && films.length > 0 };
    }
    const seeds = byVotes.slice(0, RELATED_SEEDS);
    let complete = true;
    const lists = await mapWithConcurrency(seeds, 4, async (seed) => {
      try {
        const data = await client.get(`/movie/${seed.id}/${mode}`, { page: 1 });
        return (data && data.results) || [];
      } catch (err) {
        if (!(err && err.status === 404)) complete = false;
        return [];
      }
    });
    const seen = new Set();
    const items = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const m = l[i];
        if (!m || own.has(m.id) || seen.has(m.id) || !released(m)) continue;
        seen.add(m.id);
        items.push(m);
      }
    }
    return { items, complete: complete && films.length > 0 };
  });
}

/**
 * The "Leading Faces" row: other films of the actors the list keeps casting
 * (a franchise's leads, a director's regulars). An actor counts when billed in
 * the top four; one who leads two or more of the seeds wins over a one-off.
 */
async function castQuery(client, seeds, list) {
  let complete = true;
  const credits = await mapWithConcurrency(seeds, 4, async (film) => {
    try {
      const data = await client.get(`/movie/${film.id}/credits`);
      return (data && data.cast) || [];
    } catch (err) {
      if (!(err && err.status === 404)) complete = false;
      return [];
    }
  });
  const score = new Map();
  credits.forEach((cast, i) => {
    for (const c of cast) {
      if (!c || !c.id || (c.order !== undefined && c.order > 3) || c.id === list.director) continue;
      const s = score.get(c.id) || { n: 0, first: i * 10 + (c.order || 0) };
      s.n++;
      score.set(c.id, s);
    }
  });
  const ranked = [...score.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first);
  const regulars = ranked.filter(([, s]) => s.n >= 2);
  const picked = (regulars.length ? regulars : ranked).slice(0, 3).map(([id]) => id);
  if (!picked.length) return { params: null, complete };
  return { params: { with_cast: picked.join('|'), sort_by: 'vote_count.desc', 'vote_count.gte': 150 }, complete };
}

/**
 * The "Same Era" row: the list's own genre(s) from the years its best-known
 * films came out, best known first.
 */
function eraQuery(seeds) {
  const genres = new Map();
  const years = [];
  for (const f of seeds) {
    const ids = f.genre_ids || (f.genres || []).map((g) => g.id);
    for (const g of ids || []) genres.set(g, (genres.get(g) || 0) + 1);
    const y = Number(String(f.release_date || '').slice(0, 4));
    if (y > 1900) years.push(y);
  }
  if (!genres.size || !years.length) return { params: null, complete: true };
  const top = [...genres.entries()].sort((a, b) => b[1] - a[1]);
  const pick = [top[0][0]];
  if (top[1] && top[1][1] * 2 >= seeds.length) pick.push(top[1][0]);
  years.sort((a, b) => a - b);
  const mid = years[Math.floor(years.length / 2)];
  const from = Math.max(years[0], mid - 6);
  const to = Math.min(years[years.length - 1], mid + 6);
  return {
    params: {
      with_genres: pick.join(','),
      'primary_release_date.gte': `${from - 2}-01-01`,
      'primary_release_date.lte': `${to + 2}-12-31`,
      sort_by: 'vote_count.desc',
      'vote_count.gte': 300,
    },
    complete: true,
  };
}

/**
 * A list in the order a folder row asks for. Lists arrive oldest first
 * (franchises, universes) or newest first (a director's films).
 *   release: oldest first; newest: newest first; top: best rated first, with
 *   films that have few votes after the rest, so one 10/10 vote cannot lead.
 */
function ordered(items, order, newestFirst) {
  if (!order) return items;
  if (order === 'release') return newestFirst ? [...items].sort(byDate) : items;
  if (order === 'newest') return newestFirst ? items : [...items].sort((a, b) => byDate(b, a));
  if (order === 'top') {
    const score = (m) => ((m.vote_count || 0) >= 50 ? 100 : 0) + (Number(m.vote_average) || 0);
    return [...items].sort((a, b) => score(b) - score(a) || byDate(a, b));
  }
  return items;
}

module.exports = { folderPage, franchiseParts, universeParts, directedFilms, relatedFilms, ordered, _listCache: listCache };

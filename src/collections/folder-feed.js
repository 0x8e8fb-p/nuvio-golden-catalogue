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
 *   {franchise}, {parts}, {director}, {list}
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
    if (source.franchise) all = await franchiseParts(client, source.franchise);
    else if (source.parts) all = await universeParts(client, source.parts);
    else if (source.director) all = await directedFilms(client, source.director);
  } catch (err) {
    if (err && err.code === 'NO_TMDB_KEY') throw err;
    all = []; // TMDB unavailable: an empty tab, never an error
  }
  return { items: all.slice(skip, skip + pageSize) };
}

module.exports = { folderPage, franchiseParts, universeParts, directedFilms, _listCache: listCache };

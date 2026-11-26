'use strict';

/**
 * Config-driven catalog handler.
 *
 * Serves three kinds of catalogs:
 *   1. Home rows from data/catalogue.config.json. A row reads one TMDB
 *      endpoint, or blends several ("mix": worldwide plus Indian titles), or a
 *      public MDBList list.
 *   2. Collection folder rows through the search-only engine catalogs. A row
 *      asks for "gc-movie,<folder>" (the folder's plain feed) or a facet of it,
 *      "gc-movie-top,<folder>" ("Top Rated Movies"; see src/collections/facets.js).
 *      Nuvio resolves the catalog by the part before the comma, so pageSize and
 *      skip still apply and the row is labelled with that catalog's name. The
 *      oldest form, the folder as the genre extra ("IN.netflix"), still works.
 *      These catalogs never appear on Nuvio's Home, Discover or search screens.
 *   3. Search, through the same two catalogs: worldwide and Indian results
 *      are merged, so a search for "Pushpa" or "Interstellar" both work.
 *
 * Every catalog is region-aware: the edition's region (from the install URL)
 * picks streaming services and the Indian mix ratio.
 *
 * Pagination: Nuvio asks for the next page with skip = skip + items received,
 * so skip is treated as an exact position in the row's item stream (see
 * src/lib/mix.js), never as a page number. Rows declare pageSize so the first
 * request already has the right size. Nuvio ends a row at the first empty
 * page, so a window whose titles are all filtered out (no IMDb id, no art)
 * looks a few windows further before answering empty.
 *
 * Cache hints: a page built after a TMDB failure carries none, so neither the
 * CDN nor the TV keeps a short or empty page for an hour.
 *
 * Degrades gracefully: with no TMDB key, returns an empty catalog instead of
 * throwing, so the addon still boots and installs.
 */

const { getTmdbClient } = require('../tmdb/shared');
const { toMetaPreviews, previewsFromImdbIds } = require('../tmdb/mappers');
const { resolveParams, hasUnavailable } = require('../lib/templating');
const { onThisWeekWindow, rotationPage } = require('../lib/schedule');
const { regionTimeZone } = require('../lib/region');
const { createMdblistSource } = require('../sources/mdblist');
const { fetchMixedWindow, fetchWindow, TMDB_PAGE, MAX_POSITION } = require('../lib/mix');
const { CATALOG_IDS, decodeFolderGenre, decodeFolderCatalog, rowOwner, INDIAN_LANGS } = require('../collections/engine');
const { rowCatalogId } = require('../collections/facets');
const { folderPage } = require('../collections/folder-feed');

const STREMIO_PAGE = 100; // Stremio's default catalogue page size
const FOLDER_PAGE = 40; // folder tabs page in steps of 40 (declared as pageSize)
// No title twice on a folder page: a row leaves out the first DEDUPE_HEAD
// titles of the rows above it (same type), over its first DEDUPE_DEPTH titles.
// Deeper pages use raw positions; nobody scrolls a row that far to compare.
const DEDUPE_HEAD = 30; // a screenful and then some: some titles drop out on the way to metas
const DEDUPE_DEPTH = 120;

/** The list a list-based source reorders ({franchise}, {parts}, {director}), as a key, or null. */
function listKey(source) {
  if (!source || Array.isArray(source)) return null;
  for (const k of ['franchise', 'parts', 'director']) if (source[k]) return `${k}:${JSON.stringify(source[k])}`;
  return null;
}
const SEARCH_FIRST_PAGE = 40; // the first search page covers TMDB's first two pages
const SEARCH_TOP = 10; // Indian matches move up to follow the top 10 results
const ROTATE_PAGES = 5; // rotating rows start 0 to 4 pages deep, chosen per day
const LOOK_AHEAD = 3; // extra windows to try when every title in one was filtered out
const LIMIT_READ = 2; // limited rows (Top 10) read twice the limit, so drops are refilled

const CACHE_ROW = { cacheMaxAge: 3600, staleRevalidate: 6 * 3600, staleError: 86400 };
const CACHE_LIST = { cacheMaxAge: 6 * 3600, staleRevalidate: 6 * 3600, staleError: 86400 };
const CACHE_SEARCH = { cacheMaxAge: 1800, staleRevalidate: 3600, staleError: 86400 };

const EMPTY = { metas: [] };
const INDIAN = new Set(INDIAN_LANGS.split('|'));

/**
 * A TMDB client that remembers whether any request failed. The feeds turn
 * failures into short or empty windows, so the handler would otherwise not
 * know that a page is incomplete.
 */
function watched(client) {
  const state = { failed: false };
  const proxy = Object.create(client);
  proxy.get = async (...args) => {
    try {
      return await client.get(...args);
    } catch (err) {
      if (!(err && err.status === 404)) state.failed = true; // a missing title is an answer
      throw err;
    }
  };
  return { client: proxy, state };
}

/** Response for metas, with cache hints only when every request succeeded. */
function reply(metas, cache, state) {
  return state.failed ? { metas } : { metas, ...cache };
}

function createCatalogHandler(config, deps = {}) {
  const getClient = () => deps.client || getTmdbClient();
  const byId = new Map(config.catalogues.map((c) => [c.id, c]));
  const genres = config.genres || {};
  const mdblist = deps.mdblist || createMdblistSource();
  const region = config.defaults.region || 'US';
  const timeZone = regionTimeZone(region);

  function rowParams(row, extra = {}) {
    const params = resolveParams(row.source.params || {}, { region });
    for (const def of row.extra || []) {
      const value = extra[def.name];
      if (def.name === 'genre' && value) {
        // data/genres.json keys shows as "tv" (TMDB's name); rows say "series".
        const table = genres[row.type] || genres[row.type === 'series' ? 'tv' : row.type] || {};
        const id = table[value];
        const param = (def.mapTo && def.mapTo.param) || 'with_genres';
        if (id !== undefined) params[param] = id;
      }
      if (def.name === 'search' && value) params.query = value;
    }
    if (row.window === 'onThisWeek') {
      const w = onThisWeekWindow(Date.now());
      params['primary_release_date.gte'] = w.params['primary_release_date.gte'];
      params['primary_release_date.lte'] = w.params['primary_release_date.lte'];
    }
    return params;
  }

  function mapItems(client, items, row, opts = {}) {
    return toMetaPreviews(client, items, {
      stremioType: row.type,
      posterShape: row.posterShape || config.defaults.posterShape,
      art: row.art,
      rankStart: opts.rankStart,
    });
  }

  /**
   * One page of metas from position `start`. When a full window maps to no
   * titles at all, the next windows are tried, up to LOOK_AHEAD of them, so
   * one unlucky window does not end the row. Nuvio drops titles it already
   * shows, so the overlap this creates on the next request is harmless.
   */
  async function pageFrom(fetchSlots, start, count, toMetas) {
    let metas = [];
    for (let i = 0, pos = start; i <= LOOK_AHEAD && pos < MAX_POSITION; i++, pos += count) {
      const items = await fetchSlots(pos, count);
      metas = await toMetas(items);
      if (metas.length || items.length < count) break; // titles found, or the feed ended
    }
    return metas;
  }

  /**
   * Search. The first page holds TMDB's first 40 results, with Indian-language
   * matches moved up to follow the top 10, so a regional title is not buried
   * under worldwide titles that share a word with it. Later pages continue at
   * the exact position Nuvio asks for.
   */
  async function search(client, state, type, query, skip) {
    const endpoint = type === 'series' ? '/search/tv' : '/search/movie';
    let items;
    if (skip === 0) {
      const found = await fetchWindow(client, endpoint, { query }, 0, SEARCH_FIRST_PAGE);
      const top = found.slice(0, SEARCH_TOP);
      const rest = found.slice(SEARCH_TOP);
      items = top.concat(
        rest.filter((it) => INDIAN.has(it.original_language)),
        rest.filter((it) => !INDIAN.has(it.original_language))
      );
    } else {
      items = await fetchWindow(client, endpoint, { query }, skip, TMDB_PAGE);
    }
    const metas = await toMetaPreviews(client, items, { stremioType: type, art: 'poster' });
    return reply(metas, CACHE_SEARCH, state);
  }

  /** A collection folder row (a folder's plain feed or one of its facets). */
  async function folder(client, state, type, source, skip, catalogId) {
    if (!source) return EMPTY;
    const rawSlots = async (start, count) => {
      const page = await folderPage(client, source, type, start, count, { mdblist });
      return page.imdbIds ? page.imdbIds.map((id) => ({ imdbId: id })) : page.items || [];
    };
    const seen = skip < DEDUPE_DEPTH && catalogId ? await titlesAbove(client, type, source, catalogId) : null;
    const fetchSlots = seen ? dedupedSlots(rawSlots, seen) : rawSlots;
    const toMetas = (items) =>
      items.length && items[0].imdbId
        ? previewsFromImdbIds(client, items.map((x) => x.imdbId), { stremioType: type, art: 'tile' })
        : toMetaPreviews(client, items, { stremioType: type, art: 'tile' });
    const metas = await pageFrom(fetchSlots, skip, FOLDER_PAGE, toMetas);
    return reply(metas, CACHE_ROW, state);
  }

  /**
   * The TMDB ids of the first titles of the rows above this one on its tile
   * (same type), or null when there is nothing to leave out. Rows of the same
   * list (a franchise in saga and rating order) and curated lists keep their
   * titles: there the order is the point.
   */
  async function titlesAbove(client, type, source, catalogId) {
    if (source.list) return null;
    const owner = rowOwner(type, catalogId, region);
    if (!owner || owner.index === 0) return null;
    const own = listKey(source);
    const above = owner.tile.rows.slice(0, owner.index).filter((row) => row.type === type);
    // Each row above shows its own stream less the rows above it, so their
    // heads are worked out top to bottom, as the page shows them.
    const streams = await Promise.all(
      above.map(async (row) => {
        const decoded = decodeFolderCatalog(rowCatalogId(row.type, row.key, row.facet), region);
        const src = decoded && decoded.source;
        if (!src || src.list) return null;
        try {
          const page = await folderPage(client, src, type, 0, DEDUPE_HEAD + FOLDER_PAGE, { mdblist });
          return { key: listKey(src), items: page.items || [] };
        } catch (err) {
          if (err && err.code === 'NO_TMDB_KEY') throw err;
          return null;
        }
      })
    );
    const heads = [];
    for (const stream of streams) {
      if (!stream) continue;
      const avoid = new Set();
      for (const h of heads) if (!stream.key || h.key !== stream.key) for (const id of h.ids) avoid.add(id);
      const ids = [];
      for (const it of stream.items) {
        if (!it || !it.id || avoid.has(it.id) || ids.includes(it.id)) continue;
        ids.push(it.id);
        if (ids.length >= DEDUPE_HEAD) break;
      }
      heads.push({ key: stream.key, ids });
    }
    const seen = new Set();
    for (const h of heads) if (!own || h.key !== own) for (const id of h.ids) seen.add(id);
    return seen.size ? seen : null;
  }

  /**
   * A slot reader over the row's stream with `seen` titles left out. Inside
   * DEDUPE_DEPTH, positions count the filtered stream, read from its start.
   */
  function dedupedSlots(rawSlots, seen) {
    return async (start, count) => {
      if (start >= DEDUPE_DEPTH) return rawSlots(start, count);
      const kept = [];
      let pos = 0;
      let chunk = start + count + FOLDER_PAGE;
      while (pos < MAX_POSITION) {
        const raw = await rawSlots(pos, chunk);
        for (const it of raw) if (!(it && it.id && seen.has(it.id))) kept.push(it);
        pos += raw.length;
        if (kept.length >= start + count || raw.length < chunk) break;
        chunk = FOLDER_PAGE * 2;
      }
      return kept.slice(start, start + count);
    };
  }

  return async function catalogHandler(args) {
    const extra = args.extra || {};
    const raw = Math.floor(Number(extra.skip) || 0);
    // TMDB stops at page 500 (10,000 titles per feed), so a deeper skip has
    // nothing to show. The cap also keeps the position arithmetic exact.
    if (raw >= MAX_POSITION) return EMPTY;
    const skip = Math.max(0, raw);
    const base = getClient();
    if (!base.hasKey()) return EMPTY; // no key configured yet: valid empty catalogue
    const { client, state } = watched(base);

    // Collections engine + search (search-only catalogs per type).
    const engineType = Object.keys(CATALOG_IDS).find((t) => String(args.id).startsWith(CATALOG_IDS[t]));
    if (engineType && engineType === args.type) {
      if (extra.search) return search(client, state, args.type, String(extra.search).slice(0, 120), skip);
      const decoded = decodeFolderCatalog(args.id, region);
      if (decoded) return folder(client, state, args.type, decoded.source, skip, args.id);
      const legacy = extra.genre ? decodeFolderGenre(String(extra.genre)) : null;
      if (legacy) return folder(client, state, args.type, legacy.folder.sources[args.type], skip);
      return EMPTY;
    }

    const row = byId.get(args.id);
    if (!row || row.type !== args.type) return EMPTY;

    const needsSearch = (row.extra || []).some((e) => e.name === 'search' && e.isRequired);
    if (needsSearch && !extra.search) return EMPTY;

    const pageSize = row.pageSize || config.defaults.pageSize || STREMIO_PAGE;
    // Rows with a limit (Top 10) end at the limit, whatever the client asks for.
    const size = row.limit ? Math.min(pageSize, row.limit) : pageSize;
    const take = row.limit ? Math.min(size, row.limit - skip) : size;
    if (take <= 0) return EMPTY;

    // Curated public list (MDBList): ordered IMDb ids, enriched from TMDB.
    if (row.source.list) {
      const ids = await mdblist.imdbIds(row.source.list, row.type, skip, skip + take);
      const metas = await previewsFromImdbIds(client, ids, {
        stremioType: row.type,
        posterShape: row.posterShape || config.defaults.posterShape,
        art: row.art,
        rankStart: skip + 1,
      });
      return reply(metas, CACHE_LIST, state);
    }

    let fetchSlots;
    if (Array.isArray(row.source.mix)) {
      // Blended row: several weighted feeds (e.g. worldwide + Indian).
      const components = row.source.mix.map((c) => ({
        endpoint: c.endpoint,
        params: resolveParams(c.params || {}, { region }),
        weight: weightFor(c, region),
      }));
      if (components.some((c) => hasUnavailable(c.params))) return EMPTY;
      fetchSlots = (start, count) => fetchMixedWindow(client, components, start, count);
    } else {
      const params = rowParams(row, extra);
      if (hasUnavailable(params)) return EMPTY;
      fetchSlots = (start, count) => fetchWindow(client, row.source.endpoint, params, start, count);
    }

    const offset = row.rotate ? await rotationOffset(fetchSlots, size, Date.now(), timeZone) : 0;

    if (row.limit) {
      // A title can be dropped (no IMDb id, no art) or appear in two feeds, so
      // a limited row reads more than it shows and keeps the first `take`.
      const items = await fetchSlots(offset + skip, take * LIMIT_READ);
      const metas = await mapItems(client, items, row, { rankStart: skip + 1 });
      return reply(metas.slice(0, take), CACHE_ROW, state);
    }

    const metas = await pageFrom(fetchSlots, offset + skip, take, (items) => mapItems(client, items, row, { rankStart: skip + 1 }));
    return reply(metas, CACHE_ROW, state);
  };
}

/**
 * Daily rotation for rows with `rotate`: the row starts 0 to 4 pages deep,
 * chosen by the edition's local date, so it is stable within that day and
 * different the next, and never flips in the middle of an evening. When the
 * rotated first page is thin (a small feed), the row is not rotated. TMDB
 * responses are cached, so the probe is free on the first page and cheap later.
 * @param {(start: number, count: number) => Promise<object[]>} fetchSlots
 * @param {number} size items per page
 * @param {number} [now]
 * @param {string} [timeZone] the edition's IANA zone
 * @returns {Promise<number>} position offset in items
 */
async function rotationOffset(fetchSlots, size, now = Date.now(), timeZone) {
  const pages = rotationPage(now, ROTATE_PAGES, timeZone) - 1;
  if (pages <= 0) return 0;
  const start = pages * size;
  const probe = await fetchSlots(start, size);
  return probe.length >= Math.ceil(size / 2) ? start : 0;
}

/**
 * Weight of a mix component in a region: a whole number (fractions are
 * rounded, so the round-robin arithmetic stays exact). A component may carry a
 * fixed "weight", or "weightBy": {"IN": 2, "_default": 1}.
 */
function weightFor(component, region) {
  const raw = component.weightBy
    ? component.weightBy[region] ?? component.weightBy._default
    : component.weight ?? 1;
  const w = Math.round(Number(raw));
  return Number.isFinite(w) && w > 0 ? w : 0;
}

module.exports = { createCatalogHandler, weightFor, rotationOffset, FOLDER_PAGE };

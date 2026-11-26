'use strict';
/**
 * Facets: the named rows inside a collection folder.
 *
 * Nuvio labels a folder row with the name of the manifest catalog it points
 * at. To get rows such as "Trending Movies" or "Top Rated Shows" inside every
 * folder, the manifest declares one small catalog per facet and type, with
 * `search` AND `genre` both required. Nuvio then keeps them off the home
 * screen, out of Discover and out of search (each of those skips catalogs
 * that require an extra they cannot fill), yet a collection source still
 * resolves them by the part of its catalogId before the comma:
 *
 *   gc-movie-top,netflix   -> "Top Rated Movies" row of the Netflix folder
 *   gc-series-orig,netflix -> "Original Series" row of the Netflix folder
 *   gc-movie,netflix       -> the plain "Movies" row (the base feed)
 *
 * A facet rewrites a folder's base TMDB query before the Indian blend is
 * added, so every facet of a general folder still mixes in Indian titles.
 * Facets that make no sense for a folder kind are simply not offered there.
 */

/** Base engine catalog per type. Facet catalogs are "<base>-<facet>". */
const CATALOG_IDS = Object.freeze({ movie: 'gc-movie', series: 'gc-series' });

/** Row name per facet and type, as shown in Nuvio. */
const FACETS = Object.freeze({
  movie: Object.freeze({
    trend: 'Trending Movies',
    new: 'New Movies',
    top: 'Top Rated Movies',
    gems: 'Hidden Gems',
    hits: 'Blockbusters',
    classic: 'Classics',
    soon: 'Coming Soon',
    saga: 'In Release Order',
    more: 'More Like This',
    like: 'Similar Films',
    cast: 'Leading Faces, Elsewhere',
    era: 'From the Same Era',
  }),
  series: Object.freeze({
    trend: 'Trending Shows',
    new: 'New Shows',
    top: 'Top Rated Shows',
    air: 'Airing This Week',
    orig: 'Original Series',
    classic: 'Classic Shows',
  }),
});

/**
 * Default rows per folder kind, in display order: "facet:type" ("base" = the plain feed).
 * Sub-folder rows (data/lenses.json) follow these.
 */
const PRESETS = Object.freeze({
  provider: ['trend:movie', 'trend:series', 'orig:series', 'new:movie', 'new:series', 'top:movie', 'top:series'],
  network: ['trend:series', 'new:series', 'top:series', 'air:series'],
  company: ['new:movie', 'hits:movie', 'top:movie', 'gems:movie', 'classic:movie', 'soon:movie', 'base:series'],
  language: ['trend:movie', 'new:movie', 'hits:movie', 'top:movie', 'gems:movie', 'classic:movie', 'trend:series', 'top:series'],
  genre: ['trend:movie', 'trend:series', 'new:movie', 'top:movie', 'top:series', 'gems:movie', 'hits:movie'],
  keyword: ['base:movie', 'base:series', 'new:movie', 'top:movie', 'top:series', 'gems:movie'],
  mood: ['base:movie', 'top:movie', 'gems:movie'],
  trending: ['trend:movie', 'trend:series'],
  collection: ['saga:movie', 'top:movie', 'more:movie', 'cast:movie', 'like:movie', 'era:movie'],
  parts: ['saga:movie', 'top:movie', 'more:movie', 'cast:movie', 'like:movie', 'era:movie'],
  person: ['base:movie', 'top:movie', 'more:movie', 'cast:movie', 'like:movie', 'era:movie'],
  discover: ['base:movie', 'base:series'],
  list: ['base:movie', 'base:series'],
});

// vote_count floors for "Top Rated", [movie, series], per folder kind. The Indian
// twin of a blended folder scales these down (engine.indianTwin).
const TOP_FLOOR = {
  provider: [300, 150],
  network: [150, 150],
  company: [200, 80],
  language: [60, 20],
  genre: [1500, 400],
  keyword: [300, 100],
  mood: [500, 200],
};
// vote_count window for "Hidden Gems" (movies), per folder kind.
const GEMS_WINDOW = {
  provider: [80, 1200],
  company: [50, 900],
  language: [20, 250],
  genre: [200, 2000],
  keyword: [100, 1500],
  mood: [150, 1500],
};
const DISCOVER_KINDS = new Set(['provider', 'network', 'company', 'language', 'genre', 'keyword', 'mood']);
const LIST_KINDS = new Set(['collection', 'parts', 'person']);

const isFacet = (type, facet) => Boolean(FACETS[type] && FACETS[type][facet]);

function floorOf(params, fallback) {
  const n = Number(params['vote_count.gte']);
  return Number.isFinite(n) ? n : fallback;
}

/** Drop the sort and date window a base query brings, so a facet sets its own. */
function stripWindow(p) {
  for (const k of Object.keys(p)) {
    if (/^(primary_release_date|first_air_date|air_date|release_date)\./.test(k)) {
      // Keep "released by today" style upper bounds only when the facet adds none.
      delete p[k];
    }
  }
  delete p.sort_by;
  return p;
}

/**
 * Apply a facet to one base TMDB discover query of a folder.
 * @param {string} facet
 * @param {'movie'|'series'} type
 * @param {string} kind folder kind
 * @param {object} params base discover params (templates unresolved)
 * @returns {object|null} new params, or null when the facet does not apply
 */
function facetParams(facet, type, kind, params) {
  if (facet === 'base') return params;
  if (!DISCOVER_KINDS.has(kind) || !isFacet(type, facet)) return null;
  const p = { ...params };
  const movie = type === 'movie';
  const floor = floorOf(p, movie ? 80 : 40);
  switch (facet) {
    case 'trend': {
      stripWindow(p);
      p.sort_by = 'popularity.desc';
      p['vote_count.gte'] = Math.max(5, Math.round(floor / 2));
      if (movie) {
        p['primary_release_date.gte'] = '{{now-365d}}';
        p['primary_release_date.lte'] = '{{now}}';
      } else {
        p['air_date.gte'] = '{{now-45d}}';
        p['air_date.lte'] = '{{now+7d}}';
      }
      return p;
    }
    case 'new': {
      stripWindow(p);
      p.sort_by = 'popularity.desc';
      p['vote_count.gte'] = Math.max(3, Math.round(floor / 4));
      if (movie) {
        p['primary_release_date.gte'] = '{{now-120d}}';
        p['primary_release_date.lte'] = '{{now}}';
      } else {
        p['first_air_date.gte'] = '{{now-180d}}';
        p['first_air_date.lte'] = '{{now}}';
      }
      return p;
    }
    case 'top': {
      const f = (TOP_FLOOR[kind] || [500, 150])[movie ? 0 : 1];
      delete p['vote_count.lte'];
      p.sort_by = 'vote_average.desc';
      p['vote_count.gte'] = f;
      return p;
    }
    case 'gems': {
      if (kind === 'network') return null;
      const [lo, hi] = GEMS_WINDOW[kind] || [150, 1500];
      p.sort_by = 'vote_average.desc';
      p['vote_average.gte'] = 7.2;
      p['vote_count.gte'] = lo;
      p['vote_count.lte'] = hi;
      return p;
    }
    case 'hits': {
      p.sort_by = 'revenue.desc';
      p['primary_release_date.lte'] = '{{now}}';
      return p;
    }
    case 'classic': {
      stripWindow(p);
      p.sort_by = 'vote_count.desc';
      if (movie) p['primary_release_date.lte'] = '1999-12-31';
      else p['first_air_date.lte'] = '2005-12-31';
      return p;
    }
    case 'soon': {
      // Streaming catalogues only list released titles.
      if (kind === 'provider' || kind === 'network') return null;
      stripWindow(p);
      delete p['vote_count.gte'];
      p.sort_by = 'popularity.desc';
      p['primary_release_date.gte'] = '{{now+1d}}';
      p['primary_release_date.lte'] = '{{now+180d}}';
      return p;
    }
    case 'air': {
      stripWindow(p);
      p.sort_by = 'popularity.desc';
      p['vote_count.gte'] = 5;
      p['air_date.gte'] = '{{now}}';
      p['air_date.lte'] = '{{now+7d}}';
      return p;
    }
    default:
      return null; // orig, saga, more, like, cast and era are not query rewrites
  }
}

/**
 * The list order a facet asks of a list-backed folder (franchise, universe,
 * director), or null when the facet does not apply.
 * @returns {'release'|'newest'|'top'|null}
 */
function facetOrder(facet, kind) {
  if (!LIST_KINDS.has(kind)) return null;
  if (facet === 'base') return kind === 'person' ? 'newest' : 'release';
  if (facet === 'saga') return 'release';
  if (facet === 'top') return 'top';
  return null;
}

/** Related-titles facets of list-backed folders: TMDB recommendations or similar films. */
const RELATED = Object.freeze({ more: 'recommendations', like: 'similar', cast: 'cast', era: 'era' });

/**
 * The related-titles mode a facet asks of a list-backed folder, or null.
 * @returns {'recommendations'|'similar'|'cast'|'era'|null}
 */
function facetRelated(facet, kind) {
  return LIST_KINDS.has(kind) && RELATED[facet] ? RELATED[facet] : null;
}

/**
 * Catalog id of a folder row: "gc-movie,netflix" (base) or "gc-movie-top,netflix".
 * @param {'movie'|'series'} type
 * @param {string} key folder id
 * @param {string} [facet]
 */
function rowCatalogId(type, key, facet = 'base') {
  const base = CATALOG_IDS[type];
  return facet && facet !== 'base' ? `${base}-${facet},${key}` : `${base},${key}`;
}

/** Parse "gc-movie-top,netflix" into { type, facet, key }, or null. */
function parseRowCatalogId(id) {
  const m = /^gc-(movie|series)(?:-([a-z]{2,8}))?,([a-z0-9-]{1,64})$/.exec(String(id || ''));
  if (!m) return null;
  const type = m[1];
  const facet = m[2] || 'base';
  if (facet !== 'base' && !isFacet(type, facet)) return null;
  return { type, facet, key: m[3] };
}

/** Parse a row spec "trend:movie" into { facet, type }. */
function parseRowSpec(spec) {
  const m = /^([a-z]{2,8}):(movie|series)$/.exec(String(spec || ''));
  if (!m) return null;
  if (m[1] !== 'base' && !isFacet(m[2], m[1])) return null;
  return { facet: m[1], type: m[2] };
}

/**
 * Manifest entries for every facet catalog. Both extras are required, which
 * keeps them out of Nuvio's home, Discover and search; skip lets folder rows
 * page.
 */
function facetCatalogs() {
  const out = [];
  for (const type of ['movie', 'series']) {
    for (const [facet, name] of Object.entries(FACETS[type])) {
      out.push({
        type,
        id: `${CATALOG_IDS[type]}-${facet}`,
        name,
        extra: [{ name: 'search', isRequired: true }, { name: 'genre', isRequired: true }, { name: 'skip' }],
      });
    }
  }
  return out;
}

module.exports = {
  CATALOG_IDS,
  FACETS,
  PRESETS,
  facetParams,
  facetOrder,
  facetRelated,
  rowCatalogId,
  parseRowCatalogId,
  parseRowSpec,
  facetCatalogs,
  isFacet,
};

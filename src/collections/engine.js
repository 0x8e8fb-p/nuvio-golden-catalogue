'use strict';

/**
 * Golden Collections engine.
 *
 * Turns data/collections.json into:
 *   - per-region folder definitions (which folders exist in a region, and
 *     which TMDB feeds back each folder's Movies and Shows tabs);
 *   - the Nuvio collections pack (an array Nuvio imports from a URL);
 *   - folder catalog ids that travel through Nuvio ("gc-movie,netflix").
 *
 * How folders reach this addon: the manifest declares two search-only
 * catalogs (gc-movie, gc-series). Nuvio never shows search-only catalogs on
 * the home screen, in the catalog-order screen or in Discover, so they add
 * no clutter. Each folder tab is an addon source with catalogId
 * "gc-movie,<folderId>". Nuvio finds the declared catalog by the part before
 * the comma (so pageSize and skip apply) and requests the full id; the
 * region comes from the edition the addon was installed from. Packs imported
 * before this change send genre = "<region>.<folderId>" instead, which is
 * still decoded (decodeFolderGenre).
 *
 * Indian movies and series are mixed into general folders (genres, moods,
 * decades, curated): every such folder is a weighted blend of a worldwide
 * feed and an Indian feed, with the weight depending on the region.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveParams, hasUnavailable } = require('../lib/templating');
const { providerIds, brandInfo, normalizeRegion } = require('../lib/region');

const PACK = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'collections.json'), 'utf8')
);
const PROVIDERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'providers.json'), 'utf8')
);

const TYPES = ['movie', 'series'];
const CATALOG_IDS = { movie: 'gc-movie', series: 'gc-series' };
const INDIAN_LANGS = 'hi|te|ta|ml|kn|bn|mr|pa|gu';

/** Folder kinds that get a blended Indian feed. */
const MIXABLE = new Set(['genre', 'keyword', 'discover', 'mood']);

function discoverEndpoint(type) {
  return type === 'series' ? '/discover/tv' : '/discover/movie';
}

/** Indian-mix weights [global, india] for a region (folder override wins), as whole numbers. */
function mixWeights(region, folder, collection) {
  const override = folder.indiaMix || collection.indiaMix;
  const table = PROVIDERS.indiaMix || {};
  const pair = Array.isArray(override) && override.length === 2 ? override : table[region] || table._default || [3, 1];
  return pair.map((w) => Math.max(0, Math.round(Number(w) || 0)));
}

/** Sensible base sort and vote floor per type when a folder gives none. */
function baseParams(type) {
  return type === 'series'
    ? { sort_by: 'popularity.desc', 'vote_count.gte': 40 }
    : { sort_by: 'popularity.desc', 'vote_count.gte': 80 };
}

/** The Indian twin of a global feed: same filters, Indian original languages. */
function indianTwin(type, params) {
  const p = { ...params, with_original_language: INDIAN_LANGS };
  // Indian titles have fewer TMDB votes; scale the floor down so good films qualify.
  if (p['vote_count.gte'] !== undefined) {
    p['vote_count.gte'] = Math.max(5, Math.round(Number(p['vote_count.gte']) / 12));
  }
  delete p['vote_count.lte'];
  delete p.without_original_language;
  return p;
}

/**
 * Per-type feeds for one folder in one region.
 * @returns {{movie?: Array, series?: Array}} each an array of components
 *   { endpoint, params, weight }, or a list descriptor { list: url }.
 */
function folderSources(folder, collection, region) {
  const types = folder.types || collection.types || TYPES;
  const extra = folder.params || {};
  const out = {};

  for (const type of types) {
    let components = null;

    if (folder.provider) {
      const ids = providerIds(folder.provider, region);
      if (!ids) continue; // service not offered in this region
      components = [
        {
          endpoint: discoverEndpoint(type),
          params: {
            ...baseParams(type),
            'vote_count.gte': type === 'series' ? 10 : 20,
            with_watch_providers: ids,
            watch_region: region,
            with_watch_monetization_types: 'flatrate|free|ads',
            ...extra,
          },
          weight: 1,
        },
      ];
    } else if (folder.network) {
      if (type !== 'series') continue; // TMDB networks only carry shows
      components = [
        {
          endpoint: '/discover/tv',
          params: { sort_by: 'popularity.desc', 'vote_count.gte': 30, with_networks: String(folder.network), 'first_air_date.lte': '{{now}}', ...extra },
          weight: 1,
        },
      ];
    } else if (folder.company) {
      components = [
        {
          endpoint: discoverEndpoint(type),
          params: {
            sort_by: type === 'series' ? 'popularity.desc' : 'primary_release_date.desc',
            'vote_count.gte': 15,
            with_companies: String(folder.company),
            ...(type === 'series' ? { 'first_air_date.lte': '{{now}}' } : { 'primary_release_date.lte': '{{now}}' }),
            ...extra,
          },
          weight: 1,
        },
      ];
    } else if (folder.collection) {
      if (type !== 'movie') continue;
      out.movie = { franchise: Number(folder.collection) };
      continue;
    } else if (folder.parts) {
      // A shared universe assembled from several collections and single films.
      if (type !== 'movie') continue;
      out.movie = {
        parts: {
          collections: (folder.parts.collections || []).map(Number),
          movies: (folder.parts.movies || []).map(Number),
        },
      };
      continue;
    } else if (folder.person) {
      // Films the person directed (from their credits), newest first.
      if (type !== 'movie') continue;
      out.movie = { director: Number(folder.person) };
      continue;
    } else if (folder.language) {
      components = [
        {
          endpoint: discoverEndpoint(type),
          params: { ...baseParams(type), 'vote_count.gte': type === 'series' ? 5 : 10, with_original_language: folder.language, ...extra },
          weight: 1,
        },
      ];
    } else if (folder.list) {
      const url = typeof folder.list === 'string' ? folder.list : folder.list[type];
      if (!url) continue;
      out[type] = { list: url };
      continue;
    } else if (folder.genre) {
      const g = folder.genre[type];
      if (!g) continue;
      components = [{ endpoint: discoverEndpoint(type), params: { ...baseParams(type), with_genres: g, ...extra }, weight: 1 }];
    } else if (folder.keyword) {
      components = [
        { endpoint: discoverEndpoint(type), params: { ...baseParams(type), 'vote_count.gte': 30, with_keywords: String(folder.keyword), ...extra }, weight: 1 },
      ];
    } else if (folder.discover) {
      const d = folder.discover[type];
      if (!d) continue;
      components = [{ endpoint: discoverEndpoint(type), params: { ...d }, weight: 1 }];
    } else if (folder.trending) {
      components = [
        { endpoint: type === 'series' ? '/trending/tv/week' : '/trending/movie/week', params: {}, weight: 1 },
      ];
    }

    if (!components) continue;

    // Resolve templates now, so a region without a needed service drops the folder.
    components = components.map((c) => ({ ...c, params: resolveParams(c.params, { region }) }));
    if (components.some((c) => hasUnavailable(c.params))) continue;

    // Blend Indian titles into general folders.
    const kind = folderKind(folder);
    const mixable = MIXABLE.has(kind) && folder.indiaMix !== false && collection.indiaMix !== false;
    if (mixable && components.length === 1 && components[0].endpoint.startsWith('/discover/')) {
      const [gw, iw] = mixWeights(region, folder, collection);
      const base = components[0];
      components = [
        { ...base, weight: gw },
        { endpoint: base.endpoint, params: indianTwin(type, base.params), weight: iw },
      ];
    }
    out[type] = components;
  }
  return out;
}

/** The folder's kind, from whichever source field it sets. */
function folderKind(folder) {
  for (const k of ['provider', 'network', 'company', 'collection', 'parts', 'person', 'language', 'list', 'genre', 'keyword', 'discover', 'trending']) {
    if (folder[k] !== undefined) return k === 'discover' && folder.mood ? 'mood' : k;
  }
  return 'unknown';
}

/** Art data for a folder: brand logo (if any), the label, and whether it is a brand. */
function folderArtSpec(folder) {
  const spec = {
    wordmark: folder.wordmark || folder.title,
    logoPath: folder.logo || null,
    logoKind: null,
    logoId: null,
    // Streaming services, networks and studios are brands: their covers centre the
    // logo, or the name when no usable logo exists.
    brand: Boolean(folder.provider || folder.network || folder.company),
  };
  if (!spec.logoPath && folder.provider) {
    const b = brandInfo(folder.provider);
    if (b && b.logo) spec.logoPath = b.logo;
    else if (b && b.network) {
      spec.logoKind = 'network';
      spec.logoId = b.network;
    }
  } else if (!spec.logoPath && folder.network) {
    spec.logoKind = 'network';
    spec.logoId = Number(folder.network);
  } else if (!spec.logoPath && folder.company) {
    spec.logoKind = 'company';
    spec.logoId = Number(folder.logoCompany || String(folder.company).split('|')[0]);
  }
  return spec;
}

/** Collections in display order for a region. */
function orderedCollections(region) {
  const order = (PACK.regionOrder && (PACK.regionOrder[region] || PACK.regionOrder._default)) || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...PACK.collections].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : 1000;
    const rb = rank.has(b.id) ? rank.get(b.id) : 1000;
    return ra - rb;
  });
}

const regionCache = new Map();
let regionCacheDay = '';
const REGION_CACHE_MAX = 24; // a handful of real editions; unlisted codes share one entry

/**
 * Every folder available in a region, with its resolved sources.
 * @param {string} region e.g. "IN"
 * @returns {{collections: Array, folders: Map<string, object>}}
 */
function regionFolders(region) {
  const r = normalizeRegion(region) || 'US';
  // Cached per region for the current UTC day (templates like {{now}} change
  // daily). A new day drops every region's entry at once. The cache is small
  // and least recently used goes first, so cycling through every two-letter
  // code cannot fill memory.
  const day = new Date().toISOString().slice(0, 10);
  if (day !== regionCacheDay) {
    regionCache.clear();
    regionCacheDay = day;
  }
  if (regionCache.has(r)) {
    const hit = regionCache.get(r);
    regionCache.delete(r);
    regionCache.set(r, hit);
    return hit;
  }

  const folders = new Map();
  const collections = [];
  for (const collection of orderedCollections(r)) {
    if (collection.regions && !collection.regions.includes(r)) continue;
    const list = [];
    for (const folder of collection.folders) {
      if (folder.regions && !folder.regions.includes(r)) continue;
      const sources = folderSources(folder, collection, r);
      const types = TYPES.filter((t) => sources[t]);
      if (!types.length) continue;
      const entry = {
        key: folder.id,
        title: folder.title,
        collectionId: collection.id,
        shape: (folder.tileShape || collection.tileShape || 'LANDSCAPE').toLowerCase(),
        kind: folderKind(folder),
        types,
        sources,
        art: folderArtSpec(folder),
        raw: folder,
      };
      if (folders.has(entry.key)) throw new Error(`duplicate folder id "${entry.key}"`);
      folders.set(entry.key, entry);
      list.push(entry);
    }
    if (list.length) collections.push({ ...collection, entries: list });
  }
  const value = { region: r, collections, folders };
  regionCache.set(r, value);
  while (regionCache.size > REGION_CACHE_MAX) regionCache.delete(regionCache.keys().next().value);
  return value;
}

/**
 * Catalog id of a folder tab: "gc-movie,netflix". Nuvio resolves a collection
 * source's catalog by the part before the first comma, so the tab keeps the
 * declared catalog's pageSize and skip support, and its label is the catalog
 * name ("Movies") rather than the catalog name plus a genre value.
 * @param {'movie'|'series'} type
 * @param {string} key folder id
 */
function folderCatalogId(type, key) {
  return `${CATALOG_IDS[type]},${key}`;
}

/**
 * Decode a folder tab catalog id ("gc-movie,netflix") for a region edition.
 * @returns {{region: string, folder: object}|null}
 */
function decodeFolderCatalog(catalogId, region) {
  const m = /^gc-(?:movie|series),([a-z0-9-]{1,64})$/.exec(String(catalogId || ''));
  if (!m) return null;
  const r = normalizeRegion(region) || 'US';
  const folder = regionFolders(r).folders.get(m[1]);
  return folder ? { region: r, folder } : null;
}

/** Encode a folder reference for Nuvio's genre field: "IN.netflix". */
function encodeFolderGenre(region, key) {
  return `${region}.${key}`;
}

/** Decode a genre value into { region, folder } or null. */
function decodeFolderGenre(value) {
  const m = /^([A-Z]{2})\.([a-z0-9-]{1,64})$/.exec(String(value || ''));
  if (!m) return null;
  const folder = regionFolders(m[1]).folders.get(m[2]);
  return folder ? { region: m[1], folder } : null;
}

module.exports = {
  PACK,
  TYPES,
  CATALOG_IDS,
  INDIAN_LANGS,
  regionFolders,
  folderSources,
  folderArtSpec,
  folderCatalogId,
  decodeFolderCatalog,
  encodeFolderGenre,
  decodeFolderGenre,
  mixWeights,
  indianTwin,
};

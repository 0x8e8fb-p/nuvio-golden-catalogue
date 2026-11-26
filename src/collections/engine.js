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
const LENSES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'lenses.json'), 'utf8'));

const { CATALOG_IDS, PRESETS, facetParams, facetOrder, facetRelated, parseRowCatalogId, parseRowSpec, rowCatalogId } = require('./facets');
const TYPES = ['movie', 'series'];
const INDIAN_LANGS = 'hi|te|ta|ml|kn|bn|mr|pa|gu';

/** Most rows a folder page shows (its own rows first, then sub-folders). */
const MAX_ROWS = 14;
/** Separator between a folder id and a sub-folder id in a sub-folder's key. */
const SUB_SEP = '--';

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
function folderSources(folder, collection, region, facet = 'base', lens = null) {
  const types = (folder.types || collection.types || TYPES).filter((t) => !lens || !lens.types || lens.types.includes(t));
  const extra = folder.params || {};
  const kind = folderKind(folder);
  const out = {};
  // A sub-folder narrows a discover feed; list-backed folders have none.
  if (lens && LIST_SOURCE_KINDS.has(kind)) return out;

  for (const type of types) {
    let components = null;
    if (lens && !lens[type]) continue;
    // List-backed folders (franchise, universe, director): the facet picks the order,
    // or asks for titles related to the list (More Like This, Similar Films).
    const order = facetOrder(facet, kind);
    const related = facetRelated(facet, kind);

    if (facet === 'orig') {
      // A streaming service's own shows, from its TMDB network (no Indian blend).
      const o = folder.originals;
      if (kind !== 'provider' || type !== 'series' || !o || !providerIds(folder.provider, region)) continue;
      const net = typeof o === 'object' ? o.network : o;
      const params = {
        sort_by: 'popularity.desc',
        'vote_count.gte': 10,
        with_networks: String(net),
        'first_air_date.lte': '{{now}}',
        ...((typeof o === 'object' && o.params) || {}),
      };
      out[type] = [{ endpoint: '/discover/tv', params: resolveParams(params, { region }), weight: 1 }];
      continue;
    } else if (folder.provider) {
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
      if (type !== 'movie' || !(order || related)) continue;
      out.movie = related ? { related: { franchise: Number(folder.collection) }, mode: related } : { franchise: Number(folder.collection), order };
      continue;
    } else if (folder.parts) {
      // A shared universe assembled from several collections and single films.
      if (type !== 'movie' || !(order || related)) continue;
      const parts = {
        collections: (folder.parts.collections || []).map(Number),
        movies: (folder.parts.movies || []).map(Number),
      };
      out.movie = related ? { related: { parts }, mode: related } : { parts, order };
      continue;
    } else if (folder.person) {
      // Films the person directed (from their credits), newest first.
      if (type !== 'movie' || !(order || related)) continue;
      out.movie = related ? { related: { director: Number(folder.person) }, mode: related } : { director: Number(folder.person), order };
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
      if (!url || facet !== 'base') continue;
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
      if (facet !== 'base' && facet !== 'trend') continue;
      components = lens
        ? // A sub-folder of a trending folder: what is popular right now, narrowed.
          [{ endpoint: discoverEndpoint(type), params: facetParams('trend', type, 'genre', baseParams(type)), weight: 1 }]
        : [{ endpoint: type === 'series' ? '/trending/tv/week' : '/trending/movie/week', params: {}, weight: 1 }];
    }

    if (!components) continue;

    if (lens) {
      const narrowed = applyLens(components[0].params, lens[type], lens, type);
      if (!narrowed) continue;
      components = [{ ...components[0], params: narrowed }];
    } else if (!folder.trending) {
      // Rewrite the base query for the facet, before the Indian blend is added.
      const rewritten = facetParams(facet, type, kind, components[0].params);
      if (!rewritten) continue;
      components = [{ ...components[0], params: rewritten }];
    }

    // Resolve templates now, so a region without a needed service drops the folder.
    components = components.map((c) => ({ ...c, params: resolveParams(c.params, { region }) }));
    if (components.some((c) => hasUnavailable(c.params))) continue;

    // Blend Indian titles into general folders.
    const mixable = MIXABLE.has(kind) && folder.indiaMix !== false && collection.indiaMix !== false && !(lens && lens.language);
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

const LIST_SOURCE_KINDS = new Set(['collection', 'parts', 'person', 'list']);
const DATE_KEYS = {
  movie: /^(primary_release_date|release_date)\./,
  series: /^(first_air_date|air_date)\./,
};

/** Join two TMDB AND-lists ("28,35"); null when `base` is an OR-list or `add` adds nothing. */
function andJoin(base, add) {
  if (base === undefined || base === null || base === '') return String(add);
  if (String(base).includes('|')) return null;
  const have = String(base).split(',');
  const extra = String(add)
    .split(',')
    .filter((x) => !have.includes(x));
  return extra.length ? [...have, ...extra].join(',') : null;
}

/**
 * Narrow one discover query with a lens (a sub-folder): genres and keywords are
 * ANDed with the folder's own, a language replaces the folder's (unless the folder
 * is itself about a language), and a date window replaces the folder's.
 * @returns {object|null} new params, or null when the lens does not apply here
 */
function applyLens(params, overlay, lens, type) {
  if (!overlay) return null;
  const p = { ...params };
  if (lens.dates) for (const k of Object.keys(p)) if (DATE_KEYS[type].test(k)) delete p[k];
  for (const [k, v] of Object.entries(overlay)) {
    if (k === 'with_genres' || k === 'with_keywords') {
      const joined = andJoin(p[k], v);
      if (joined === null) return null;
      p[k] = joined;
      // A lens that asks for a genre the folder leaves out wins.
      if (k === 'with_genres' && p.without_genres) {
        const out = String(p.without_genres)
          .split(/[,|]/)
          .filter((g) => !String(v).split(',').includes(g));
        if (out.length) p.without_genres = out.join(',');
        else delete p.without_genres;
      }
    } else if (k === 'with_original_language') {
      if (p.with_original_language || p.with_origin_country) return null;
      p[k] = v;
      delete p.without_original_language;
    } else {
      p[k] = v;
    }
  }
  return p;
}

/** Parse a sub-folder spec ("indian", "action:movie", "comedy:movie=Action Comedy" or an object). */
function parseSubSpec(spec) {
  if (spec && typeof spec === 'object') {
    if (!/^[a-z0-9]{2,24}$/.test(String(spec.id || ''))) return null;
    const base = spec.lens ? LENSES.lenses[spec.lens] : null;
    const lens = { ...(base || {}), ...spec };
    if (!lens.movie && !lens.series) return null;
    return { id: spec.id, title: spec.title || lens.title || spec.id, lens };
  }
  const m = /^([a-z0-9]{2,24})(?::(movie|series))?(?:=(.{1,48}))?$/.exec(String(spec || ''));
  if (!m) return null;
  const base = LENSES.lenses[m[1]];
  if (!base) return null;
  const lens = m[2] ? { ...base, types: [m[2]] } : base;
  return { id: m[2] ? `${m[1]}-${m[2]}` : m[1], title: m[3] || base.title, lens };
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
 * The rows a folder shows, as [{ type, facet, key, label? }]. A folder lists
 * them in `rows` ("trend:movie"), else its kind's preset applies. A row whose
 * facet gives no feed for this folder in this region is left out.
 */
function folderRows(entry) {
  const specs = Array.isArray(entry.raw.rows) ? entry.raw.rows : PRESETS[entry.kind] || ['base:movie', 'base:series'];
  const rows = [];
  for (const spec of specs) {
    const row = parseRowSpec(spec);
    if (!row) continue;
    if (facetSource(entry, row.facet, row.type)) rows.push({ ...row, key: entry.key });
  }
  // A folder always has at least its plain feeds.
  if (!rows.length) for (const type of entry.types) rows.push({ type, facet: 'base', key: entry.key });
  return rows;
}

/**
 * The feed behind one row of a folder: its base source, or a facet of it.
 * Computed once per folder, facet and region, then kept with the folder.
 * @returns {Array|object|null} components array, list descriptor, or null
 */
function facetSource(entry, facet, type) {
  if (facet === 'base' || !facet) return entry.sources[type] || null;
  if (entry.members || entry.lens) return null; // a group's rows are its members; a sub-folder has one feed
  if (!entry.facetCache) entry.facetCache = new Map();
  if (!entry.facetCache.has(facet)) {
    entry.facetCache.set(facet, folderSources(entry.raw, entry.collection, entry.region, facet));
  }
  return entry.facetCache.get(facet)[type] || null;
}

function makeEntry(folder, collection, region) {
  const sources = folderSources(folder, collection, region);
  const types = TYPES.filter((t) => sources[t]);
  if (!types.length) return null;
  return {
    key: folder.id,
    title: folder.title,
    collectionId: collection.id,
    collection,
    region,
    shape: (folder.tileShape || collection.tileShape || 'LANDSCAPE').toLowerCase(),
    kind: folderKind(folder),
    types,
    sources,
    art: folderArtSpec(folder),
    raw: folder,
  };
}

/**
 * Sub-folders of a folder (data/lenses.json): hidden entries keyed
 * "<folder>--<sub>", each one row per type on the folder page, labelled with
 * the sub-folder's name. A sub-folder that gives no feed here is left out.
 * @returns {object[]} sub-folder entries
 */
function makeSubs(entry) {
  const specs = Array.isArray(entry.raw.subs) ? entry.raw.subs : (LENSES.presets && LENSES.presets[entry.kind]) || [];
  const subs = [];
  const seen = new Set();
  for (const spec of specs) {
    const sub = parseSubSpec(spec);
    if (!sub || seen.has(sub.id)) continue;
    seen.add(sub.id);
    const sources = folderSources(entry.raw, entry.collection, entry.region, 'base', sub.lens);
    const types = TYPES.filter((t) => sources[t]);
    if (!types.length) continue;
    const title = String(sub.title).replace('{p}', entry.title);
    subs.push({
      key: `${entry.key}${SUB_SEP}${sub.id}`,
      title,
      collectionId: entry.collectionId,
      collection: entry.collection,
      region: entry.region,
      shape: entry.shape,
      kind: entry.kind,
      types,
      sources,
      lens: sub.lens,
      parent: entry.key,
      art: entry.art,
      raw: entry.raw,
      rows: types.map((type) => ({ type, facet: 'base', key: `${entry.key}${SUB_SEP}${sub.id}` })),
    });
  }
  return subs;
}

/**
 * A group folder: a tile whose rows are other folders (its members), each row
 * labelled with the member's name. Members usually live in the hidden library
 * collection. The group's own plain feed per type is its first member's.
 */
function makeGroup(folder, collection, region, folders) {
  const members = folder.group.map((id) => folders.get(id)).filter(Boolean);
  if (!members.length) return null;
  const types = TYPES.filter((t) => members.some((m) => m.sources[t]));
  const sources = {};
  for (const t of types) sources[t] = members.find((m) => m.sources[t]).sources[t];
  const entry = {
    key: folder.id,
    title: folder.title,
    collectionId: collection.id,
    collection,
    region,
    shape: (folder.tileShape || collection.tileShape || 'LANDSCAPE').toLowerCase(),
    kind: 'group',
    types,
    sources,
    members,
    art: folderArtSpec(folder),
    raw: folder,
  };
  entry.rows = members.flatMap((m) => m.types.map((type) => ({ type, facet: 'base', key: m.key, label: m.title })));
  return entry;
}

/**
 * Every folder available in a region, with its resolved sources and rows.
 * Folders of hidden collections (the library) are addressable but not shown.
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
  const add = (entry) => {
    if (folders.has(entry.key)) throw new Error(`duplicate folder id "${entry.key}"`);
    folders.set(entry.key, entry);
  };
  const visible = (x) => !x.regions || x.regions.includes(r);
  const ordered = orderedCollections(r).filter(visible);

  // Pass 1: plain folders everywhere (groups need their members first).
  const lists = new Map(ordered.map((c) => [c.id, []]));
  for (const collection of ordered) {
    for (const folder of collection.folders) {
      if (!visible(folder) || Array.isArray(folder.group)) continue;
      const entry = makeEntry(folder, collection, r);
      if (!entry) continue;
      entry.rows = folderRows(entry);
      add(entry);
      // Tiles get sub-folders; library members are rows of a group already.
      if (!collection.hidden) {
        for (const sub of makeSubs(entry)) {
          if (entry.rows.length >= MAX_ROWS) break;
          add(sub);
          for (const type of sub.types) if (entry.rows.length < MAX_ROWS) entry.rows.push({ type, facet: 'base', key: sub.key, label: sub.title });
        }
      }
    }
  }
  // Pass 2: groups, then each visible collection in its folder order.
  for (const collection of ordered) {
    for (const folder of collection.folders) {
      if (!visible(folder)) continue;
      if (Array.isArray(folder.group)) {
        const entry = makeGroup(folder, collection, r, folders);
        if (!entry) continue;
        add(entry);
        lists.get(collection.id).push(entry);
      } else if (folders.has(folder.id)) {
        lists.get(collection.id).push(folders.get(folder.id));
      }
    }
  }
  const collections = [];
  for (const collection of ordered) {
    const list = lists.get(collection.id);
    if (collection.hidden || !list.length) continue;
    collections.push({ ...collection, entries: list });
  }

  // Which tile owns each row, and where on its page (for row dedupe).
  const owners = new Map();
  for (const c of collections) {
    for (const tile of c.entries) {
      tile.rows.forEach((row, index) => {
        const id = `${row.type}|${rowCatalogId(row.type, row.key, row.facet)}`;
        if (!owners.has(id)) owners.set(id, { tile, index });
      });
    }
  }

  const value = { region: r, collections, folders, owners };
  regionCache.set(r, value);
  while (regionCache.size > REGION_CACHE_MAX) regionCache.delete(regionCache.keys().next().value);
  return value;
}

/**
 * Catalog id of a folder's plain feed: "gc-movie,netflix". Nuvio resolves a
 * collection source's catalog by the part before the first comma, so the row
 * keeps the declared catalog's pageSize and skip support and its name.
 * @param {'movie'|'series'} type
 * @param {string} key folder id
 */
function folderCatalogId(type, key) {
  return `${CATALOG_IDS[type]},${key}`;
}

/**
 * Decode a folder row catalog id ("gc-movie,netflix", "gc-series-top,netflix")
 * for a region edition.
 * @returns {{region: string, folder: object, facet: string, source: any}|null}
 */
function decodeFolderCatalog(catalogId, region) {
  const parsed = parseRowCatalogId(catalogId);
  if (!parsed) return null;
  const r = normalizeRegion(region) || 'US';
  const folder = regionFolders(r).folders.get(parsed.key);
  if (!folder) return null;
  const source = facetSource(folder, parsed.facet, parsed.type);
  return source ? { region: r, folder, facet: parsed.facet, source } : null;
}

/**
 * The tile a folder row belongs to and its position on the tile's page, or null.
 * @param {'movie'|'series'} type
 * @param {string} catalogId e.g. "gc-movie-top,netflix"
 * @param {string} region
 * @returns {{tile: object, index: number}|null}
 */
function rowOwner(type, catalogId, region) {
  const r = normalizeRegion(region) || 'US';
  return regionFolders(r).owners.get(`${type}|${catalogId}`) || null;
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
  rowOwner,
  facetSource,
  applyLens,
  parseSubSpec,
  LENSES,
  MAX_ROWS,
  encodeFolderGenre,
  decodeFolderGenre,
  mixWeights,
  indianTwin,
};

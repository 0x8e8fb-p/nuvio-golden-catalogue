'use strict';

/**
 * Compiles the golden config into a Stremio manifest.
 *
 * - Rows are already sorted by `order` by the loader, so the catalogs array
 *   order == the row order the user sees in Nuvio.
 * - Each row becomes a catalog { type, id, name, extra, pageSize? }.
 *   pageSize is a Nuvio manifest field: the client then pages in exactly
 *   that step, matching what the handler returns.
 * - Rows that need a streaming service the edition's region lacks are left out
 *   (e.g. no "On Hulu" row in India).
 * - Two search-only engine catalogs (gc-movie, gc-series) carry search and the
 *   collection folders. Nuvio never shows search-only catalogs on the home
 *   screen, the catalog-order screen or Discover. They are added only when
 *   opts.engine is true (all public editions). Their names double as folder
 *   tab labels ("Movies", "Shows").
 */

const { loadConfig } = require('./lib/config-loader');
const { isActive, resolveName } = require('./lib/schedule');
const { resolveParams, hasUnavailable } = require('./lib/templating');
const { regionTimeZone } = require('./lib/region');
const { CATALOG_IDS } = require('./collections/engine');

// Shown as the tab label of every collection folder, and in Nuvio's search
// results, where the addon name is shown next to it.
const ENGINE_NAMES = { movie: 'Movies', series: 'Shows' };

function buildCatalogExtra(row, genres) {
  if (!Array.isArray(row.extra) || row.extra.length === 0) return undefined;
  // data/genres.json keys shows as "tv" (TMDB's name); rows say "series".
  const table = genres[row.type] || genres[row.type === 'series' ? 'tv' : row.type] || {};

  return row.extra.map((ex) => {
    const out = { name: ex.name };
    if (ex.isRequired) out.isRequired = true;

    if (ex.name === 'genre') {
      // Full option lists only for required-genre browse rows; optional-genre
      // rows omit them to keep the manifest small.
      if (ex.isRequired) {
        const options = ex.options && ex.options.length ? ex.options : Object.keys(table);
        if (options.length) out.options = options;
      } else if (ex.options && ex.options.length) {
        out.options = ex.options;
      }
    }
    return out;
  });
}

/** Does a row only make sense in regions that offer the services it needs? */
function isRowAvailable(row, region) {
  const parts = row.source.mix || [row.source];
  return parts.every((p) => !hasUnavailable(resolveParams(p.params || {}, { region })));
}

function engineCatalogs() {
  return ['movie', 'series'].map((type) => ({
    type,
    id: CATALOG_IDS[type],
    name: ENGINE_NAMES[type],
    pageSize: 40,
    extra: [{ name: 'search', isRequired: true }, { name: 'genre' }, { name: 'skip' }],
  }));
}

function buildManifest(config = loadConfig(), opts = {}) {
  const { addon, genres } = config;
  // The default manifest includes only `featured` rows (to stay under 8KB);
  // presets pass featuredOnly:false to include all their rows.
  const featuredOnly = opts.featuredOnly !== false;
  const now = opts.now || Date.now();
  const region = config.defaults.region || 'US';
  // Time-aware rows follow the edition's local clock (evening in India is IST).
  const timeZone = opts.timeZone || regionTimeZone(region);
  const catalogues = config.catalogues.filter(
    (row) =>
      (!featuredOnly || row.featured !== false) &&
      isActive(row, now, timeZone) &&
      isRowAvailable(row, region)
  );

  const catalogs = catalogues.map((row) => {
    const catalog = { type: row.type, id: row.id, name: resolveName(row, now, timeZone) };
    const extra = buildCatalogExtra(row, genres);
    if (extra) catalog.extra = extra;
    if (row.pageSize) catalog.pageSize = row.pageSize;
    return catalog;
  });
  if (opts.engine) catalogs.push(...engineCatalogs());

  const types = [...new Set(catalogs.map((c) => c.type))];

  const manifest = {
    id: addon.id,
    version: addon.version,
    name: addon.name,
    description: addon.description,
    resources: ['catalog'],
    types,
    idPrefixes: ['tt'],
    catalogs,
    behaviorHints: {
      adult: false,
      p2p: false,
    },
  };

  if (addon.logo) manifest.logo = addon.logo;
  if (addon.background) manifest.background = addon.background;
  if (addon.contactEmail) manifest.contactEmail = addon.contactEmail;

  return manifest;
}

module.exports = { buildManifest, isRowAvailable, engineCatalogs };

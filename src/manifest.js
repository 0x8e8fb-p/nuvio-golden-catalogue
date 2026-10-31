'use strict';

/**
 * Compiles the golden config into a Stremio manifest.
 *
 * - Rows are already sorted by `order` by the loader, so the catalogs array
 *   order == the row order the user sees in Nuvio.
 * - Each row becomes a catalog { type, id, name, extra }.
 * - `extra` is emitted in the modern SDK form: { name, isRequired?, options?, optionsLimit? }.
 *   For genre rows we expand the options from the row (or, if omitted, from the
 *   full genre table for that type) so Nuvio renders the genre dropdown.
 * - types / resources / idPrefixes are derived from the rows.
 */

const { loadConfig } = require('./lib/config-loader');
const { isActive, resolveName } = require('./lib/schedule');

function buildCatalogExtra(row, genres) {
  if (!Array.isArray(row.extra) || row.extra.length === 0) return undefined;

  return row.extra.map((ex) => {
    const out = { name: ex.name };
    if (ex.isRequired) out.isRequired = true;

    if (ex.name === 'genre') {
      // Emit the full options list only for required-genre "browse" rows (the
      // dedicated by-genre catalogs). For optional-genre rows we omit options
      // to keep the manifest under the SDK's 8KB limit — the row is still
      // genre-filterable via the shared genre picker.
      if (ex.isRequired) {
        const options =
          ex.options && ex.options.length
            ? ex.options
            : Object.keys(genres[row.type] || {});
        if (options.length) out.options = options;
      } else if (ex.options && ex.options.length) {
        out.options = ex.options;
      }
    }
    return out;
  });
}

function buildManifest(config = loadConfig(), opts = {}) {
  const { addon, genres } = config;
  // The default manifest includes only `featured` rows (to stay under 8KB);
  // presets pass featuredOnly:false to include all their rows.
  const featuredOnly = opts.featuredOnly !== false;
  const now = opts.now || Date.now();
  const catalogues = config.catalogues.filter(
    (row) => (!featuredOnly || row.featured !== false) && isActive(row, now)
  );

  const catalogs = catalogues.map((row) => {
    const catalog = {
      type: row.type,
      id: row.id,
      name: resolveName(row, now),
    };
    const extra = buildCatalogExtra(row, genres);
    if (extra) catalog.extra = extra;
    return catalog;
  });

  const types = [...new Set(catalogues.map((c) => c.type))];

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

module.exports = { buildManifest };

'use strict';

/**
 * Addon assembly.
 *
 * `buildAddon(config)` compiles a Stremio addon interface from any config
 * object — used both for the default catalogue and for each preset (see
 * src/presets.js), so every variant reuses the same TMDB-backed catalog
 * pipeline. The module's default export is the interface for the full config.
 */

const { addonBuilder } = require('stremio-addon-sdk');
const { loadConfig } = require('./lib/config-loader');
const { buildManifest } = require('./manifest');
const { createCatalogHandler } = require('./handlers/catalog');
const { createMetaHandler } = require('./handlers/meta');

function buildAddon(config, opts = {}) {
  const manifest = buildManifest(config, opts);

  // Advertise the meta resource only when enrichment is actually available
  // (Task 7). Emitting tt ids means Cinemeta supplies detail pages otherwise.
  const metaHandler = createMetaHandler(config);
  if (metaHandler) {
    manifest.resources = [...new Set([...manifest.resources, 'meta'])];
  }

  const builder = new addonBuilder(manifest);
  builder.defineCatalogHandler(createCatalogHandler(config));
  if (metaHandler) {
    builder.defineMetaHandler(metaHandler);
  }
  return builder.getInterface();
}

const defaultConfig = loadConfig();
const addonInterface = buildAddon(defaultConfig);

module.exports = addonInterface;
module.exports.buildAddon = buildAddon;

#!/usr/bin/env node
'use strict';

/**
 * Standalone validator (no network). Used by `npm run validate:config` and by
 * CI. Exits 0 when the data is valid, 1 with a clear report otherwise.
 *
 * Checks:
 *   - data/catalogue.config.json against the JSON schema (via the loader);
 *   - every region edition's manifest stays under the SDK's 8KB limit at
 *     worst case (all time-aware rows active at once);
 *   - data/collections.json: unique collection and folder ids, ids the
 *     folder decoder accepts, valid tile shapes, every folder resolvable in at
 *     least one region, and a Nuvio pack that builds for every region.
 */

const { loadConfig, ConfigError } = require('../src/lib/config-loader');
const { buildManifest } = require('../src/manifest');
const { knownRegions } = require('../src/lib/region');
const { PACK, regionFolders } = require('../src/collections/engine');
const { buildPack } = require('../src/collections/pack');

const MANIFEST_LIMIT = 8192; // SDK addonCollection hard limit
const ID_RE = /^[a-z0-9-]{1,64}$/; // what decodeFolderGenre accepts
const SHAPES = new Set(['POSTER', 'LANDSCAPE', 'SQUARE']);
const SAMPLE_UNLISTED = 'BR'; // a region without its own provider table

function fail(problems) {
  console.error(`\nValidation FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

function withRegion(config, region) {
  return Object.assign({}, config, { defaults: Object.assign({}, config.defaults, { region }) });
}

function checkManifests(config, regions, problems) {
  // Worst case: every time-aware row active at once.
  const worst = Object.assign({}, config, {
    catalogues: config.catalogues.map((c) => {
      const clone = Object.assign({}, c);
      delete clone.activeWhen;
      return clone;
    }),
  });
  const sizes = {};
  for (const region of regions) {
    const m = buildManifest(withRegion(worst, region), { engine: true });
    const bytes = Buffer.byteLength(JSON.stringify(m));
    sizes[region] = { bytes, rows: m.catalogs.length - 2 };
    if (bytes >= MANIFEST_LIMIT) {
      problems.push(`${region} manifest is ${bytes} bytes, over the ${MANIFEST_LIMIT}-byte SDK limit`);
    }
  }
  return sizes;
}

function checkCollections(regions, problems) {
  const collectionIds = new Set();
  const folderIds = new Map();
  for (const c of PACK.collections) {
    if (!ID_RE.test(c.id)) problems.push(`collection id "${c.id}" must match ${ID_RE}`);
    if (collectionIds.has(c.id)) problems.push(`duplicate collection id "${c.id}"`);
    collectionIds.add(c.id);
    if (!c.title) problems.push(`collection "${c.id}" has no title`);
    if (c.tileShape && !SHAPES.has(c.tileShape)) problems.push(`collection "${c.id}" tileShape "${c.tileShape}"`);
    if (!Array.isArray(c.folders) || !c.folders.length) problems.push(`collection "${c.id}" has no folders`);
    for (const f of c.folders || []) {
      if (!ID_RE.test(f.id)) problems.push(`folder id "${f.id}" in "${c.id}" must match ${ID_RE}`);
      if (folderIds.has(f.id)) problems.push(`folder id "${f.id}" is used in "${folderIds.get(f.id)}" and "${c.id}"`);
      folderIds.set(f.id, c.id);
      if (!f.title) problems.push(`folder "${f.id}" has no title`);
      if (f.tileShape && !SHAPES.has(f.tileShape)) problems.push(`folder "${f.id}" tileShape "${f.tileShape}"`);
    }
  }

  const resolved = new Set();
  const counts = {};
  for (const region of regions) {
    let folders;
    try {
      ({ folders } = regionFolders(region));
      const pack = buildPack({ region, origin: 'https://example.invalid', addonId: 'validate' });
      counts[region] = { collections: pack.length, folders: folders.size };
    } catch (err) {
      problems.push(`${region}: ${err.message}`);
      continue;
    }
    for (const key of folders.keys()) resolved.add(key);
  }
  for (const [id, collection] of folderIds) {
    if (!resolved.has(id)) problems.push(`folder "${id}" in "${collection}" has no feed in any region`);
  }
  return counts;
}

try {
  const config = loadConfig({ fresh: true });
  const regions = [...knownRegions(), SAMPLE_UNLISTED];
  const problems = [];
  const sizes = checkManifests(config, regions, problems);
  const counts = checkCollections(regions, problems);
  if (problems.length) fail(problems);

  console.log(`OK: ${config.catalogues.length} rows, ${PACK.collections.length} collections.`);
  for (const region of regions) {
    const s = sizes[region];
    const c = counts[region];
    console.log(
      `  ${region}  manifest ${s.bytes}/${MANIFEST_LIMIT} bytes, ${s.rows} rows   pack ${c.collections} collections, ${c.folders} folders`
    );
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) fail([err.message]);
  throw err;
}

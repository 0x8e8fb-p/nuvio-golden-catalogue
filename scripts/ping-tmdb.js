#!/usr/bin/env node
'use strict';

/**
 * Nightly canary / live validation against TMDB.
 *
 * For each region in PING_REGIONS (default "IN,US"):
 *   - every home row: each feed it reads (each part of a mix) returns a
 *     non-empty, adult-free first page; list rows return IMDb ids;
 *   - every collection folder tab: its feed returns titles (franchises,
 *     universes and director credits included);
 * and once: every brand logo and director portrait path in data/ still
 * exists on TMDB's image CDN.
 *
 * Catches TMDB auth breakage, renamed endpoints, bad provider/network/
 * keyword/collection ids and empty rows before a user sees them.
 *
 * Skips (exit 0) when TMDB_API_KEY is absent, so it no-ops on fork PRs where
 * secrets are unavailable. If api.themoviedb.org is blocked on your network,
 * run it with TMDB_API_BASE=https://api.tmdb.org/3.
 */

const { loadConfig } = require('../src/lib/config-loader');
const { createTmdbClient } = require('../src/tmdb/client');
const { resolveParams, hasUnavailable } = require('../src/lib/templating');
const { normalizeRegion } = require('../src/lib/region');
const { regionFolders, PACK } = require('../src/collections/engine');
const { folderPage } = require('../src/collections/folder-feed');
const { createMdblistSource } = require('../src/sources/mdblist');
const { weightFor } = require('../src/handlers/catalog');
const { mapWithConcurrency } = require('../src/tmdb/mappers');

const PROVIDERS = require('../data/providers.json');

const regions = String(process.env.PING_REGIONS || 'IN,US')
  .split(',')
  .map(normalizeRegion)
  .filter(Boolean);

async function main() {
  const config = loadConfig({ fresh: true });
  const client = createTmdbClient({ language: config.defaults.language });
  if (!client.hasKey()) {
    console.log('TMDB_API_KEY not set, skipping the live ping (exit 0).');
    process.exit(0);
  }
  const mdblist = createMdblistSource();
  const failures = [];
  let adult = 0;
  let checks = 0;

  async function feed(label, endpoint, params) {
    checks++;
    try {
      const data = await client.get(endpoint, { ...params, page: 1 });
      const results = (data && data.results) || [];
      if (results.some((r) => r.adult === true)) adult++;
      if (!results.length) failures.push(`${label}: no results`);
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }

  for (const region of regions) {
    console.log(`\n${region}: home rows`);
    for (const row of config.catalogues) {
      const label = `${region} row ${row.id}`;
      if (row.source.list) {
        checks++;
        const ids = await mdblist.imdbIds(row.source.list, row.type, 0, 10).catch(() => []);
        if (!ids.length) failures.push(`${label}: list returned no items`);
        continue;
      }
      const parts = row.source.mix || [row.source];
      for (const [i, part] of parts.entries()) {
        if (row.source.mix && weightFor(part, region) === 0) continue;
        const params = resolveParams(part.params || {}, { region });
        if (hasUnavailable(params)) continue; // row is not offered in this region
        await feed(row.source.mix ? `${label} (part ${i + 1})` : label, part.endpoint, params);
      }
    }

    const { folders } = regionFolders(region);
    console.log(`${region}: ${folders.size} collection folders`);
    const tabs = [...folders.values()].flatMap((f) => f.types.map((type) => ({ f, type })));
    await mapWithConcurrency(tabs, 6, async ({ f, type }) => {
      checks++;
      const label = `${region} folder ${f.collectionId}/${f.key} (${type})`;
      try {
        const page = await folderPage(client, f.sources[type], type, 0, 20, { mdblist });
        const n = (page.items || page.imdbIds || []).length;
        if (!n) failures.push(`${label}: empty`);
        if ((page.items || []).some((it) => it.adult === true)) adult++;
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
      }
    });
  }

  // Image paths kept in data/: brand logos and director portraits.
  const paths = new Set();
  for (const b of Object.values(PROVIDERS.brands)) if (b.logo) paths.add(b.logo);
  for (const c of PACK.collections) {
    for (const f of c.folders) {
      if (f.logo) paths.add(f.logo);
      if (f.portrait) paths.add(f.portrait);
    }
  }
  console.log(`\nimage paths: ${paths.size}`);
  await mapWithConcurrency([...paths], 8, async (p) => {
    checks++;
    try {
      const res = await fetch(`https://image.tmdb.org/t/p/w92${p}`, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (!res.ok) failures.push(`image ${p}: HTTP ${res.status}`);
    } catch (err) {
      failures.push(`image ${p}: ${err.message}`);
    }
  });

  console.log('');
  if (adult) {
    console.warn(`WARNING: ${adult} feed(s) returned an adult-flagged item; the mapper filters these, but review the params.`);
  }
  if (failures.length) {
    console.error(`Ping FAILED, ${failures.length} of ${checks} checks:`);
    for (const f of failures.sort()) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`All ${checks} checks passed for ${regions.join(', ')}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

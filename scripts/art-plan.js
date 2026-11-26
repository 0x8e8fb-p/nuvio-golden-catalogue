#!/usr/bin/env node
'use strict';
/**
 * Generate the zero-repeat art plan of a region: every tile's focus loop and
 * hero images and every collection's backdrop, no image used twice.
 *
 *   node scripts/art-plan.js [REGION] [--origin https://your-deployment] [--partial]
 *
 * --partial writes a plan even when some tiles' candidates fail; those tiles
 * are left out and sample their art live, clear of every planned image.
 *
 * Reads each visible tile's candidates from the deployment
 * (/art/candidates/:region/:key.json, which holds the TMDB key), allocates
 * them with src/art/plan.js allocate(), and writes data/art-plan/<REGION>.json.
 * Commit the file: folder art URLs then carry the plan's hash, so Nuvio and
 * the CDN fetch the new art.
 */
const fs = require('node:fs');
const path = require('node:path');
const { regionFolders } = require('../src/collections/engine');
const { allocate, PLAN_DIR } = require('../src/art/plan');
const { mapWithConcurrency } = require('../src/tmdb/mappers');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const region = (args.find((a) => /^[A-Za-z]{2}$/.test(a)) || 'IN').toUpperCase();
const origin = flag('--origin', process.env.ADDON_ORIGIN || 'https://nuvio-golden-catalogue-mocha.vercel.app').replace(/\/$/, '');

async function candidates(key) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${origin}/art/candidates/${region}/${key}.json`, { signal: AbortSignal.timeout(55000) });
      if (res.ok) {
        const body = await res.json();
        if (!body.failed || attempt === 3) return body;
      }
    } catch {
      // retried below
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return { titles: [], failed: true };
}

(async () => {
  const { collections } = regionFolders(region);
  const keys = [...new Set(collections.flatMap((c) => c.entries.map((e) => e.key)))];
  console.log(`${region}: ${keys.length} tiles in ${collections.length} collections, from ${origin}`);
  let done = 0;
  const failed = [];
  const tiles = await mapWithConcurrency(keys, 6, async (key) => {
    const found = await candidates(key);
    if (found.failed) failed.push(key);
    if (++done % 20 === 0) console.log(`  ${done}/${keys.length}`);
    return { key, titles: found.titles || [], extra: found.extra || {} };
  });
  if (failed.length) {
    console.error(`candidates failed for ${failed.length} tiles: ${failed.join(', ')}`);
    if (!args.includes('--partial')) {
      console.error('not writing a partial plan (pass --partial to leave those tiles out)');
      process.exit(1);
    }
  }
  const plan = allocate(
    tiles.filter((t) => !failed.includes(t.key)),
    collections.map((c) => ({ id: c.id, tiles: c.entries.map((e) => e.key) }))
  );
  const out = { region, generated: new Date().toISOString().slice(0, 10), tiles: plan.tiles, collections: plan.collections };
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  const file = path.join(PLAN_DIR, `${region}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  const { stats } = plan;
  console.log(`wrote ${path.relative(process.cwd(), file)}: ${stats.images} distinct images from ${stats.titles} titles`);
  console.log(`collections with their own backdrop: ${Object.keys(plan.collections).length}/${collections.length}`);
  if (stats.short.length) console.log(`short of distinct images (focus/hero/posters): ${stats.short.join(', ')}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

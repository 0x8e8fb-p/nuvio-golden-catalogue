#!/usr/bin/env node
'use strict';
/**
 * Warm the CDN for a deployed addon: fetch a region's collections pack, then
 * every tile's cover, focus loop, hero still and hero video, and the collection
 * backdrops, for the first few collections. A cold hero video takes a few seconds to render; a warm one is
 * served from the CDN at once, which is what Nuvio's 8 s player timeout needs.
 *
 *   node scripts/prewarm.js [--url https://addon.example] [--regions IN,US]
 *                           [--collections 2] [--concurrency 3]
 *
 * Exits 0 even when some files fail (it is a cache warmer, not a test); the
 * summary lists failures. Exits 1 only when no pack could be fetched.
 */
const DEFAULT_URL = 'https://nuvio-golden-catalogue-mocha.vercel.app';

function args(argv) {
  const out = { url: process.env.ADDON_URL || DEFAULT_URL, regions: 'IN,US', collections: 2, concurrency: 3 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || '').replace(/^--/, '');
    if (key in out) out[key] = argv[i + 1];
  }
  out.url = String(out.url).replace(/\/+$/, '');
  out.regions = String(out.regions).split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  out.collections = Math.max(1, Number(out.collections) || 2);
  out.concurrency = Math.max(1, Math.min(8, Number(out.concurrency) || 3));
  return out;
}

async function timed(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const body = await res.arrayBuffer();
    return { url, status: res.status, bytes: body.byteLength, ms: Date.now() - started, cache: res.headers.get('x-vercel-cache') };
  } catch (err) {
    return { url, status: 0, bytes: 0, ms: Date.now() - started, error: err.message };
  }
}

async function pool(items, size, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    })
  );
  return results;
}

async function main() {
  const opt = args(process.argv.slice(2));
  const urls = [];
  for (const region of opt.regions) {
    const res = await timed(`${opt.url}/r/${region}/collections.json`);
    if (res.status !== 200) {
      console.error(`${region}: pack answered ${res.status} ${res.error || ''}`);
      continue;
    }
    const pack = await (await fetch(`${opt.url}/r/${region}/collections.json`)).json();
    for (const c of pack.slice(0, opt.collections)) {
      if (c.backdropImageUrl) urls.push(c.backdropImageUrl);
      for (const f of c.folders) {
        for (const key of ['coverImageUrl', 'focusGifUrl', 'heroBackdropUrl', 'heroVideoUrl']) {
          if (f[key]) urls.push(f[key]);
        }
      }
    }
  }
  if (!urls.length) {
    console.error('Nothing to warm: no pack could be fetched.');
    process.exit(1);
  }
  const unique = [...new Set(urls)];
  console.log(`Warming ${unique.length} files with ${opt.concurrency} at a time...`);
  const results = await pool(unique, opt.concurrency, timed);
  const bad = results.filter((r) => r.status !== 200);
  const videos = results.filter((r) => r.url.includes('/hero.mp4') && r.status === 200);
  const slowest = videos.reduce((m, r) => Math.max(m, r.ms), 0);
  const mb = results.reduce((n, r) => n + r.bytes, 0) / 1e6;
  console.log(`Done: ${results.length - bad.length}/${results.length} OK, ${mb.toFixed(1)} MB, ${videos.length} hero videos (slowest ${slowest} ms).`);
  for (const r of bad) console.log(`  FAILED ${r.status} ${r.url} ${r.error || ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

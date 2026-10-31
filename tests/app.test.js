'use strict';

/**
 * Integration test for the Express app: landing page, region editions,
 * presets, the collections pack, artwork routes and status endpoints. Runs
 * without a TMDB key, which is also how a fresh deployment starts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../api/index');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server && server.close());

test('landing page renders both install links for the default country', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Add Addon/);
  assert.ok(html.includes(`${base}/r/US/manifest.json`), 'manifest link is server-rendered');
  assert.ok(html.includes(`${base}/r/US/collections.json`), 'pack link is server-rendered');
  assert.match(html, /id="presets"/);
  assert.ok(html.includes('stremio://127.0.0.1'), 'Stremio deep link');
  assert.match(html, /no TMDB key yet/, 'warns when the deployment has no key');
});

test('default manifest is served and CORS-enabled', async () => {
  const res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const m = await res.json();
  assert.equal(m.id, 'com.nuvio.golden.catalogue');
  assert.ok(m.catalogs.length > 0);
  assert.ok(m.catalogs.some((c) => c.id === 'gc-movie'), 'engine catalogs in public editions');
});

test('region edition is namespaced and region-specific', async () => {
  const m = await (await fetch(`${base}/r/IN/manifest.json`)).json();
  assert.equal(m.id, 'com.nuvio.golden.catalogue.in');
  assert.ok(m.catalogs.some((c) => c.id === 'on-jiohotstar'));
  const us = await (await fetch(`${base}/r/US/manifest.json`)).json();
  assert.equal(us.id, 'com.nuvio.golden.catalogue', 'default region keeps the plain id');
});

test('presets.json lists presets', async () => {
  const res = await fetch(`${base}/presets.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.presets) && body.presets.length > 0);
});

test('a preset manifest is served and lean', async () => {
  const { presets } = await (await fetch(`${base}/presets.json`)).json();
  const slug = presets[0].slug;
  const res = await fetch(`${base}/c/${slug}/manifest.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.id, `com.nuvio.golden.catalogue.${slug}`);
  assert.ok(!m.catalogs.some((c) => c.id.startsWith('gc-')), 'presets carry no engine catalogs');
  assert.ok(Buffer.byteLength(JSON.stringify(m)) < 8192);
});

test('unknown preset returns 404', async () => {
  const res = await fetch(`${base}/c/nonsense/manifest.json`);
  assert.equal(res.status, 404);
});

test('region-scoped preset applies the region and namespaces the id', async () => {
  const res = await fetch(`${base}/r/IN/c/streaming/manifest.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.id, 'com.nuvio.golden.catalogue.streaming.in');
  assert.ok(m.catalogs.some((c) => c.id === 'on-jiohotstar'), 'India rows');
});

test('invalid region is rejected', async () => {
  assert.equal((await fetch(`${base}/r/XYZ/c/streaming/manifest.json`)).status, 400);
  assert.equal((await fetch(`${base}/r/1N/manifest.json`)).status, 400);
  assert.equal((await fetch(`${base}/r/XYZ/collections.json`)).status, 400);
});

test('collections pack points every folder at the region edition', async () => {
  const res = await fetch(`${base}/r/IN/collections.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const pack = await res.json();
  assert.ok(Array.isArray(pack) && pack.length > 0);
  const folder = pack[0].folders[0];
  assert.ok(folder.coverImageUrl.startsWith(`${base}/art/folder/IN/`));
  assert.ok(folder.titleLogoUrl.startsWith(`${base}/art/folder/IN/`), 'generated title logo');
  for (const s of folder.sources) {
    assert.equal(s.addonId, 'com.nuvio.golden.catalogue.in');
    assert.match(s.catalogId, /^gc-(movie|series),[a-z0-9-]+$/);
    assert.equal(s.genre, undefined, 'no genre: the tab label stays "Movies" or "Shows"');
  }
});

test('a folder tab is served through its catalog id, and the v2 genre form still works', async () => {
  const pack = await (await fetch(`${base}/r/IN/collections.json`)).json();
  const s = pack[0].folders[0].sources[0];
  const tab = await fetch(`${base}/r/IN/catalog/${s.type}/${encodeURIComponent(s.catalogId)}.json`);
  assert.equal(tab.status, 200);
  assert.deepEqual(await tab.json(), { metas: [] }, 'empty without a TMDB key, but routed');
  const paged = await fetch(`${base}/r/IN/catalog/${s.type}/${s.catalogId}/skip=40.json`);
  assert.equal(paged.status, 200);
  const legacy = await fetch(`${base}/r/IN/catalog/movie/gc-movie/genre=IN.netflix.json`);
  assert.equal(legacy.status, 200);
});

test('engine catalogs are named for their tabs', async () => {
  const m = await (await fetch(`${base}/r/IN/manifest.json`)).json();
  assert.equal(m.catalogs.find((c) => c.id === 'gc-movie').name, 'Movies');
  assert.equal(m.catalogs.find((c) => c.id === 'gc-series').name, 'Shows');
});

test('v2 preset URLs keep working under their v2 addon ids', async () => {
  for (const [path, id] of [
    ['/c/anime/manifest.json', 'com.nuvio.golden.catalogue.anime'],
    ['/c/movies/manifest.json', 'com.nuvio.golden.catalogue.movies'],
    ['/r/US/c/streaming/manifest.json', 'com.nuvio.golden.catalogue.streaming.us'],
    ['/r/IN/c/kids/manifest.json', 'com.nuvio.golden.catalogue.kids.in'],
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    const m = await res.json();
    assert.equal(m.id, id, path);
    assert.ok(m.catalogs.length > 0, `${path} has rows`);
  }
  assert.equal((await fetch(`${base}/c/__proto__/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/c/constructor/manifest.json`)).status, 404);
});

test('a skip beyond any feed answers empty at once', async () => {
  const started = Date.now();
  const res = await fetch(`${base}/catalog/movie/horror/skip=1.3959108817495173e308.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { metas: [] });
  assert.ok(Date.now() - started < 1000);
});

test('default pack lives at /collections.json', async () => {
  const pack = await (await fetch(`${base}/collections.json`)).json();
  assert.equal(pack[0].folders[0].sources[0].addonId, 'com.nuvio.golden.catalogue');
  assert.match(pack[0].folders[0].focusGifUrl, /\/focus\.webp\?/);
});

test('?focus=gif links GIF focus loops, with the same ids', async () => {
  const webp = await (await fetch(`${base}/r/IN/collections.json`)).json();
  const gif = await (await fetch(`${base}/r/IN/collections.json?focus=gif`)).json();
  const ids = (p) => p.map((c) => [c.id, c.folders.map((f) => f.id)]);
  assert.deepEqual(ids(gif), ids(webp));
  for (const f of gif.flatMap((c) => c.folders)) assert.match(f.focusGifUrl, /\/focus\.gif\?v=1&shape=(landscape|poster|square)$/);
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(html.includes(`${base}/r/US/collections.json?focus=gif`), 'landing page offers the GIF pack');
});

test('signed art routes reject a bad signature', async () => {
  const res = await fetch(`${base}/art/tile.jpg?t=movie&id=603&v=1&s=AAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(res.status, 403);
  assert.equal((await fetch(`${base}/art/rank.jpg?r=1`)).status, 403);
});

test('folder art: unknown folder is 404, a known one renders without TMDB', async () => {
  assert.equal((await fetch(`${base}/art/folder/IN/not-a-folder/cover.jpg`)).status, 404);
  const pack = await (await fetch(`${base}/r/IN/collections.json`)).json();
  const res = await fetch(pack[0].folders[0].coverImageUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
});

test('/configure redirects to the presets on the landing page', async () => {
  const res = await fetch(`${base}/configure`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/#presets');
});

test('health endpoint reports status without leaking secrets', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.status, 'ok');
  assert.ok(h.rows > 0);
  assert.ok(h.presets > 0);
  assert.ok(h.collections.folders > 0);
  assert.equal(typeof h.tmdbKeyConfigured, 'boolean');
  assert.deepEqual(h.tmdb, { ok: false, error: 'TMDB_API_KEY is not set' }, 'reports that rows will be empty');
  assert.equal(h.renderer.ok, true, 'sharp and the bundled font work on this host');
  assert.equal(typeof h.renderer.ms, 'number');
  // never expose the key itself
  assert.ok(!('TMDB_API_KEY' in h) && !JSON.stringify(h).match(/[0-9a-f]{32}/));
});

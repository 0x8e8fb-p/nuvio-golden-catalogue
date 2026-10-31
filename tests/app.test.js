'use strict';

/**
 * Integration test for the Express app: landing page, default manifest, preset
 * manifests, presets.json, and the 404 for an unknown preset.
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

test('landing page renders HTML with install links', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Add Addon/);
  assert.match(html, /manifest\.json/);
});

test('default manifest is served and CORS-enabled', async () => {
  const res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const m = await res.json();
  assert.ok(m.catalogs.length > 0);
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
  assert.ok(m.id.endsWith(`.${slug}`));
  assert.ok(Buffer.byteLength(JSON.stringify(m)) < 8192);
});

test('unknown preset returns 404', async () => {
  const res = await fetch(`${base}/c/nonsense/manifest.json`);
  assert.equal(res.status, 404);
});

test('configure page renders with region and preset controls', async () => {
  const res = await fetch(`${base}/configure`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Configure/);
  assert.match(html, /region/);
  assert.match(html, /class="preset"/);
});

test('health endpoint reports status without leaking secrets', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.status, 'ok');
  assert.ok(h.rows > 0);
  assert.ok(h.presets > 0);
  assert.equal(typeof h.tmdbKeyConfigured, 'boolean');
  // never expose the key itself
  assert.ok(!('TMDB_API_KEY' in h) && !JSON.stringify(h).match(/[0-9a-f]{32}/));
});

test('region-scoped preset applies the region and namespaces the id', async () => {
  const res = await fetch(`${base}/r/IN/c/streaming/manifest.json`);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.ok(m.id.endsWith('.in'), 'id should be region-namespaced');
});

test('invalid region is rejected', async () => {
  const res = await fetch(`${base}/r/XYZ/c/streaming/manifest.json`);
  assert.equal(res.status, 400);
});

'use strict';

/**
 * Task 1 smoke test (go/no-go gate).
 *
 * Boots the addon over HTTP via the SDK's serveHTTP and asserts that:
 *   - /manifest.json returns a valid, schema-shaped manifest with CORS headers
 *   - /catalog/movie/<id>.json returns a { metas: [...] } array of valid
 *     meta-preview objects (id/type/name/poster)
 *
 * Uses the real server + fetch so it exercises the same path Nuvio hits.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('../src/addon');

let server;
let baseUrl;

before(async () => {
  // Port 0 → OS assigns a free port, so tests never collide.
  const res = await serveHTTP(addonInterface, { port: 0 });
  server = res.server;
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  if (server) server.close();
});

test('manifest.json is valid and CORS-enabled', async () => {
  const res = await fetch(`${baseUrl}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    '*',
    'addon must send permissive CORS for Stremio/Nuvio clients'
  );

  const manifest = await res.json();
  assert.ok(manifest.id, 'manifest.id required');
  assert.ok(manifest.name, 'manifest.name required');
  assert.ok(manifest.version, 'manifest.version required');
  assert.ok(manifest.description, 'manifest.description required');
  assert.ok(Array.isArray(manifest.resources), 'resources must be an array');
  assert.ok(Array.isArray(manifest.types), 'types must be an array');
  assert.ok(Array.isArray(manifest.catalogs), 'catalogs must be an array');
  assert.ok(manifest.catalogs.length > 0, 'at least one catalog expected');
  assert.ok(
    manifest.resources.includes('catalog'),
    'catalog resource expected'
  );
});

test('catalog endpoint responds with a metas array', async () => {
  const manifest = await (await fetch(`${baseUrl}/manifest.json`)).json();
  const cat = manifest.catalogs[0];

  const res = await fetch(`${baseUrl}/catalog/${cat.type}/${cat.id}.json`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body.metas), 'response must contain metas array');
  // Without a TMDB key the handler returns an empty (but valid) catalog.
  // Any metas present must be well-formed tt-id previews.
  for (const meta of body.metas) {
    assert.ok(meta.id && meta.id.startsWith('tt'), 'meta id should be a tt IMDB id');
    assert.ok(meta.type, 'meta.type required');
    assert.ok(meta.name, 'meta.name required');
    assert.ok(meta.poster, 'meta.poster required for previews');
  }
});

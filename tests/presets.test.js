'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/lib/config-loader');
const { configForPreset, listPresets } = require('../src/presets');
const { buildManifest } = require('../src/manifest');
const { installLinks } = require('../src/landing');

const config = loadConfig({ fresh: true });

test('listPresets returns only non-empty presets with counts', () => {
  const presets = listPresets(config);
  assert.ok(presets.length > 0);
  for (const p of presets) {
    assert.ok(p.rows > 0, `${p.slug} should have rows`);
    assert.ok(p.slug && p.name);
  }
});

test('each preset config contains only its group rows and a unique addon id', () => {
  const presets = listPresets(config);
  for (const p of presets) {
    const cfg = configForPreset(p.slug, config);
    assert.ok(cfg, `preset ${p.slug} should resolve`);
    assert.equal(cfg.catalogues.length, p.rows);
    assert.ok(cfg.addon.id.endsWith(`.${p.slug}`), 'preset id should be namespaced');
  }
});

test('every preset manifest is well under the 8KB limit', () => {
  for (const p of listPresets(config)) {
    const cfg = configForPreset(p.slug, config);
    const bytes = Buffer.byteLength(JSON.stringify(buildManifest(cfg)));
    assert.ok(bytes < 8192, `${p.slug} manifest is ${bytes} bytes`);
  }
});

test('unknown preset resolves to null', () => {
  assert.equal(configForPreset('does-not-exist', config), null);
});

test('install links derive stremio:// and web installer from manifest URL', () => {
  const { stremio, web } = installLinks('https://ex.vercel.app/manifest.json');
  assert.equal(stremio, 'stremio://ex.vercel.app/manifest.json');
  assert.ok(web.startsWith('https://web.stremio.com/#/addons?addon='));
  assert.ok(web.includes(encodeURIComponent('https://ex.vercel.app/manifest.json')));
});

test('presets collectively cover more rows than a single manifest can hold', () => {
  const total = listPresets(config).reduce((a, p) => a + p.rows, 0);
  // Sanity: the whole catalogue is large; presets expose all of it in lean chunks.
  assert.ok(total >= config.catalogues.length - 2, 'presets should cover ~all rows');
});

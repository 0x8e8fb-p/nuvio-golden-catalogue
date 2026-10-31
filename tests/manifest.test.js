'use strict';

/**
 * Task 3 — manifest compiled from the golden config.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/lib/config-loader');
const { buildManifest } = require('../src/manifest');
const { isActive } = require('../src/lib/schedule');

const config = loadConfig({ fresh: true });
// Fix the clock so activation is deterministic across the file: Mon 20:00 UTC.
const NOW = Date.UTC(2026, 5, 15, 20, 0, 0);
const manifest = buildManifest(config, { now: NOW });

test('manifest has required top-level fields', () => {
  assert.ok(manifest.id);
  assert.ok(manifest.version);
  assert.ok(manifest.name);
  assert.ok(manifest.description);
  assert.deepEqual(manifest.idPrefixes, ['tt']);
  assert.ok(manifest.resources.includes('catalog'));
});

test('catalogs are the featured and active rows, in config order', () => {
  const ids = manifest.catalogs.map((c) => c.id);
  const expected = config.catalogues
    .filter((c) => c.featured !== false && isActive(c, NOW))
    .map((c) => c.id);
  assert.deepEqual(ids, expected, 'default manifest = featured + active rows, sorted');
});

test('non-featured rows are excluded from the default manifest', () => {
  const ids = new Set(manifest.catalogs.map((c) => c.id));
  const nonFeatured = config.catalogues.filter((c) => c.featured === false);
  assert.ok(nonFeatured.length > 0, 'fixture should have some non-featured rows');
  for (const row of nonFeatured) {
    assert.ok(!ids.has(row.id), `${row.id} should not be in the default manifest`);
  }
});

test('catalog ids are unique', () => {
  const ids = manifest.catalogs.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('types are derived from rows and de-duplicated', () => {
  const expected = [...new Set(config.catalogues.map((c) => c.type))];
  assert.deepEqual(manifest.types.sort(), expected.sort());
});

test('genre browse rows surface options as extra', () => {
  // movies-by-genre declares a REQUIRED genre extra, so it carries options
  // (optional-genre rows omit options to keep the manifest under 8KB).
  const browse = manifest.catalogs.find((c) => c.id === 'movies-by-genre');
  assert.ok(browse, 'expected movies-by-genre row');
  const genreExtra = (browse.extra || []).find((e) => e.name === 'genre');
  assert.ok(genreExtra, 'movies-by-genre should expose a genre extra');
  assert.ok(
    Array.isArray(genreExtra.options) && genreExtra.options.length > 0,
    'required-genre row should have options for the dropdown'
  );
});

test('optional-genre rows still expose a genre extra (without bloating options)', () => {
  const popular = manifest.catalogs.find((c) => c.id === 'popular-movies');
  assert.ok(popular);
  const genreExtra = (popular.extra || []).find((e) => e.name === 'genre');
  assert.ok(genreExtra, 'popular-movies should still be genre-filterable');
});

test('manifest stays under the SDK 8KB limit', () => {
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  assert.ok(
    bytes < 8192,
    `manifest is ${bytes} bytes; must stay < 8192 (SDK addonCollection limit)`
  );
});

test('required extras are marked isRequired', () => {
  const search = manifest.catalogs.find((c) => c.id === 'search-movies');
  assert.ok(search);
  const searchExtra = (search.extra || []).find((e) => e.name === 'search');
  assert.equal(searchExtra.isRequired, true);
});

test('adult content is disabled at manifest level', () => {
  assert.equal(manifest.behaviorHints.adult, false);
});

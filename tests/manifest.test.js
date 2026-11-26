'use strict';

/**
 * Manifest compiled from the golden config: featured, active and
 * region-available rows in order, the two search-only engine catalogs, and
 * the 8KB SDK limit.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/lib/config-loader');
const { buildManifest, isRowAvailable } = require('../src/manifest');
const { isActive } = require('../src/lib/schedule');

const config = loadConfig({ fresh: true });
// Fix the clock so activation is deterministic across the file: Mon 20:00 UTC.
const NOW = Date.UTC(2026, 5, 15, 20, 0, 0);
const manifest = buildManifest(config, { now: NOW, timeZone: 'UTC' });

function withRegion(region) {
  return Object.assign({}, config, { defaults: Object.assign({}, config.defaults, { region }) });
}

test('manifest has required top-level fields', () => {
  assert.ok(manifest.id);
  assert.ok(manifest.version);
  assert.ok(manifest.name);
  assert.ok(manifest.description);
  assert.deepEqual(manifest.idPrefixes, ['tt']);
  assert.ok(manifest.resources.includes('catalog'));
});

test('catalogs are the featured, active and available rows, in config order', () => {
  const ids = manifest.catalogs.map((c) => c.id);
  const region = config.defaults.region;
  const expected = config.catalogues
    .filter((c) => c.featured !== false && isActive(c, NOW, 'UTC') && isRowAvailable(c, region))
    .map((c) => c.id);
  assert.deepEqual(ids, expected);
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
  const expected = [...new Set(manifest.catalogs.map((c) => c.type))];
  assert.deepEqual([...manifest.types].sort(), expected.sort());
});

test('rows declare their page size, Top 10 rows a page of 10', () => {
  const top = manifest.catalogs.find((c) => c.id === 'top10-movies');
  assert.ok(top, 'expected the Top 10 row');
  assert.equal(top.pageSize, 10);
  assert.ok(!(top.extra || []).some((e) => e.name === 'skip'), 'Top 10 does not page');
});

test('rows that need a missing service are left out of that region', () => {
  const ids = (region) => buildManifest(withRegion(region), { now: NOW, featuredOnly: false }).catalogs.map((c) => c.id);
  assert.ok(ids('IN').includes('on-jiohotstar'), 'JioHotstar row in India');
  assert.ok(!ids('US').includes('on-jiohotstar'), 'no JioHotstar row in the US');
  assert.ok(ids('US').includes('on-hbo-max'), 'HBO Max row in the US');
  assert.ok(!ids('IN').includes('on-hbo-max'), 'no HBO Max row in India');
});

test('engine catalogs are search-only and carry genre and skip', () => {
  const m = buildManifest(config, { now: NOW, engine: true });
  for (const [type, id] of [['movie', 'gc-movie'], ['series', 'gc-series']]) {
    const c = m.catalogs.find((x) => x.id === id);
    assert.ok(c, `${id} present`);
    assert.equal(c.type, type);
    const search = c.extra.find((e) => e.name === 'search');
    assert.equal(search.isRequired, true, 'search-only keeps it off the home screen');
    assert.ok(c.extra.some((e) => e.name === 'genre' && !e.isRequired));
    assert.ok(c.extra.some((e) => e.name === 'skip'));
  }
  assert.ok(!manifest.catalogs.some((c) => c.id.startsWith('gc-')), 'not added without opts.engine');
});

test('required-genre rows carry the genre list as options', () => {
  const cfg = Object.assign({}, config, {
    catalogues: [
      {
        id: 'by-genre',
        type: 'movie',
        name: 'By Genre',
        source: { endpoint: '/discover/movie', params: {} },
        extra: [{ name: 'genre', isRequired: true }, { name: 'skip' }],
      },
    ],
  });
  const c = buildManifest(cfg, { now: NOW }).catalogs[0];
  const genre = c.extra.find((e) => e.name === 'genre');
  assert.equal(genre.isRequired, true);
  assert.deepEqual(genre.options, Object.keys(config.genres.movie));
});

test('every region edition stays under the SDK 8KB limit', () => {
  for (const region of ['US', 'IN', 'GB', 'DE', 'BR']) {
    const m = buildManifest(withRegion(region), { now: NOW, engine: true, featuredOnly: true });
    const bytes = Buffer.byteLength(JSON.stringify(m));
    assert.ok(bytes < 8192, `${region} manifest is ${bytes} bytes; must stay < 8192`);
  }
});

test('adult content is disabled at manifest level', () => {
  assert.equal(manifest.behaviorHints.adult, false);
});

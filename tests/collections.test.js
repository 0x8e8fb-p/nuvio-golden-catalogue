'use strict';

/**
 * Golden Collections: per-region folders (src/collections/engine.js), the
 * Nuvio import pack (src/collections/pack.js) and folder feeds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  regionFolders,
  encodeFolderGenre,
  decodeFolderGenre,
  decodeFolderCatalog,
  folderCatalogId,
  mixWeights,
  indianTwin,
  CATALOG_IDS,
  INDIAN_LANGS,
} = require('../src/collections/engine');
const { buildPack } = require('../src/collections/pack');
const { folderPage, _listCache } = require('../src/collections/folder-feed');

const ORIGIN = 'https://golden.example';
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

test('streaming folders follow what each country offers', () => {
  const india = regionFolders('IN').folders;
  const us = regionFolders('US').folders;
  assert.ok(india.has('jiohotstar') && !us.has('jiohotstar'));
  assert.ok(us.has('hulu') && !india.has('hulu'));
  const p = india.get('netflix').sources.movie[0].params;
  assert.equal(p.watch_region, 'IN');
  assert.equal(p.with_watch_providers, '8');
});

test('general folders blend in an Indian feed, weighted by region', () => {
  const inAction = regionFolders('IN').folders.get('action').sources.movie;
  const usAction = regionFolders('US').folders.get('action').sources.movie;
  assert.equal(inAction.length, 2);
  assert.equal(inAction[1].params.with_original_language, INDIAN_LANGS);
  assert.deepEqual(inAction.map((c) => c.weight), [1, 1], 'India: half Indian');
  assert.deepEqual(usAction.map((c) => c.weight), [3, 1], 'elsewhere: one in four');
});

test('the Indian twin lowers the vote floor and keeps the filters', () => {
  const twin = indianTwin('movie', { with_genres: '28', 'vote_count.gte': 120, 'vote_count.lte': 900, without_original_language: 'en' });
  assert.equal(twin.with_genres, '28');
  assert.equal(twin['vote_count.gte'], 10);
  assert.equal(twin['vote_count.lte'], undefined);
  assert.equal(twin.without_original_language, undefined);
});

test('franchise, universe and director folders are movie-only special feeds', () => {
  const f = regionFolders('IN').folders;
  assert.deepEqual(f.get('kgf').sources, { movie: { franchise: 657153 } });
  assert.deepEqual(f.get('conjuring-universe').sources.movie.parts.collections, [313086, 402074, 968052]);
  assert.deepEqual(f.get('christopher-nolan').sources, { movie: { director: 525 } });
  assert.deepEqual(f.get('kgf').types, ['movie']);
});

test('folder genre values round-trip and reject anything else', () => {
  const v = encodeFolderGenre('IN', 'netflix');
  assert.equal(v, 'IN.netflix');
  assert.equal(decodeFolderGenre(v).folder.key, 'netflix');
  for (const bad of ['in.netflix', 'IN.', 'IN.not-a-folder', 'IN.../x', 'Action', '', null]) {
    assert.equal(decodeFolderGenre(bad), null, String(bad));
  }
});

test('folder catalog ids carry the folder and resolve in the edition region', () => {
  assert.equal(folderCatalogId('movie', 'netflix'), 'gc-movie,netflix');
  assert.equal(folderCatalogId('series', 'jiohotstar'), 'gc-series,jiohotstar');
  assert.equal(decodeFolderCatalog('gc-series,jiohotstar', 'IN').folder.key, 'jiohotstar');
  assert.equal(decodeFolderCatalog('gc-series,jiohotstar', 'US'), null, 'not offered in the US');
  for (const bad of ['gc-movie', 'gc-movie,', 'gc-movie,Netflix', 'gc-movie,net/flix', 'gc-tv,netflix', 'x,netflix']) {
    assert.equal(decodeFolderCatalog(bad, 'IN'), null, bad);
  }
});

test('mix weights are whole numbers', () => {
  assert.deepEqual(mixWeights('IN', {}, {}), [1, 1]);
  assert.deepEqual(mixWeights('GB', {}, {}), [3, 1]);
  assert.deepEqual(mixWeights('GB', { indiaMix: [2.6, 0.4] }, {}), [3, 0]);
});

test('every two-letter code builds folders without growing memory', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letters) for (const b of letters) regionFolders(a + b);
  assert.ok(regionFolders('IN').folders.size > 150, 'a real edition still resolves afterwards');
});

test('pack follows Nuvio import rules', () => {
  const pack = buildPack({ region: 'IN', origin: ORIGIN, addonId: 'com.nuvio.golden.catalogue.in' });
  const folderIds = new Set();
  for (const c of pack) {
    assert.match(c.id, /^golden-[a-z0-9-]+$/);
    assert.equal(c.viewMode, 'TABBED_GRID');
    assert.ok(c.title && !EMOJI_RE.test(c.title));
    for (const f of c.folders) {
      assert.match(f.id, new RegExp(`^${c.id}-`));
      assert.ok(!folderIds.has(f.id), `duplicate folder id ${f.id}`);
      folderIds.add(f.id);
      assert.ok(['POSTER', 'LANDSCAPE', 'SQUARE'].includes(f.tileShape));
      assert.ok(!EMOJI_RE.test(f.title));
      for (const key of ['coverImageUrl', 'focusGifUrl', 'heroBackdropUrl']) {
        assert.ok(f[key].startsWith(`${ORIGIN}/art/folder/IN/`), `${f.id} ${key}`);
      }
      assert.ok(f.sources.length > 0);
      for (const s of f.sources) {
        assert.equal(s.provider, 'addon');
        assert.ok(['movie', 'series'].includes(s.type));
        assert.equal(s.catalogId.split(',')[0], CATALOG_IDS[s.type], 'Nuvio resolves the part before the comma');
        assert.ok(decodeFolderCatalog(s.catalogId, 'IN'), `${f.id} source resolves`);
        assert.equal(s.genre, undefined);
      }
      assert.match(f.titleLogoUrl, /\/logo\.png\?v=1$/);
    }
  }
  assert.ok(folderIds.size > 150, `pack has ${folderIds.size} folders`);
});

test('pack ids are stable, so importing again updates in place', () => {
  const a = buildPack({ region: 'IN', origin: ORIGIN, addonId: 'x' });
  const b = buildPack({ region: 'IN', origin: 'https://other.example', addonId: 'x' });
  assert.deepEqual(
    a.map((c) => [c.id, c.folders.map((f) => f.id)]),
    b.map((c) => [c.id, c.folders.map((f) => f.id)])
  );
});

test('cover and focus URLs carry the tile shape so the art matches the tile', () => {
  const pack = buildPack({ region: 'US', origin: ORIGIN, addonId: 'x' });
  const directors = pack.find((c) => c.id === 'golden-directors');
  const f = directors.folders[0];
  assert.equal(f.tileShape, 'POSTER');
  assert.match(f.coverImageUrl, /shape=poster/);
  assert.match(f.focusGifUrl, /focus\.webp\?.*shape=poster/);
});

function fakeTmdb(routes) {
  return {
    hasKey: () => true,
    async get(endpoint) {
      if (!(endpoint in routes)) {
        const err = new Error(`TMDB request failed: 404 ${endpoint}`);
        err.status = 404;
        throw err;
      }
      return routes[endpoint];
    },
  };
}

test('universe folders merge collections and films in release order', async () => {
  _listCache.clear();
  const client = fakeTmdb({
    '/collection/1': { parts: [{ id: 11, release_date: '2013-07-19' }, { id: 12, release_date: '2099-01-01' }] },
    '/collection/2': { parts: [{ id: 21, release_date: '2014-10-03' }, { id: 11, release_date: '2013-07-19' }] },
    '/movie/31': { id: 31, release_date: '2010-01-01' },
  });
  const page = await folderPage(client, { parts: { collections: [1, 2, 404], movies: [31] } }, 'movie', 0, 40, {});
  assert.deepEqual(page.items.map((m) => m.id), [31, 11, 21], 'unreleased and missing parts dropped');
});

test('director folders list only films the person directed, newest first', async () => {
  _listCache.clear();
  const client = fakeTmdb({
    '/person/525/movie_credits': {
      crew: [
        { id: 1, job: 'Director', release_date: '2010-07-16' },
        { id: 2, job: 'Producer', release_date: '2016-01-01' },
        { id: 3, job: 'Director', release_date: '2023-07-21' },
        { id: 3, job: 'Screenplay', release_date: '2023-07-21' },
        { id: 4, job: 'Director', release_date: '' },
      ],
    },
  });
  const page = await folderPage(client, { director: 525 }, 'movie', 0, 40, {});
  assert.deepEqual(page.items.map((m) => m.id), [3, 1]);
  const second = await folderPage(client, { director: 525 }, 'movie', 1, 40, {});
  assert.deepEqual(second.items.map((m) => m.id), [1], 'skip is an item offset');
});

test('a universe with a part that failed to load is not cached', async () => {
  _listCache.clear();
  let fail = true;
  const client = {
    hasKey: () => true,
    async get(endpoint) {
      if (endpoint === '/collection/7' && fail) throw new Error('TMDB 503');
      if (endpoint === '/collection/7') return { parts: [{ id: 71, release_date: '2001-01-01' }] };
      return { parts: [{ id: 81, release_date: '2005-01-01' }] };
    },
  };
  const source = { parts: { collections: [7, 8] } };
  assert.deepEqual((await folderPage(client, source, 'movie', 0, 40, {})).items.map((m) => m.id), [81]);
  fail = false;
  assert.deepEqual((await folderPage(client, source, 'movie', 0, 40, {})).items.map((m) => m.id), [71, 81], 'retried, not cached');
});

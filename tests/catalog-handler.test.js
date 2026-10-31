'use strict';

/**
 * Task 5 — config-driven catalog handler tests (no network; fake client).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogHandler } = require('../src/handlers/catalog');
const { _imdbCache } = require('../src/tmdb/mappers');

// Build a tiny config inline so tests don't depend on the live golden config.
const config = {
  defaults: { language: 'en-US', posterShape: 'poster', pageSize: 100 },
  genres: { movie: { Action: 28, Comedy: 35 }, tv: {} },
  catalogues: [
    {
      id: 'popular-movies',
      type: 'movie',
      name: 'Popular',
      source: { endpoint: '/discover/movie', params: { sort_by: 'popularity.desc' } },
      extra: [
        { name: 'genre', mapTo: { param: 'with_genres', lookup: 'tmdbGenreId' } },
        { name: 'skip' },
      ],
    },
    {
      id: 'search-movies',
      type: 'movie',
      name: 'Search',
      source: { endpoint: '/search/movie', params: {} },
      extra: [{ name: 'search', isRequired: true }, { name: 'skip' }],
    },
  ],
};

// Fake TMDB client that records endpoint + params and returns synthetic pages.
function fakeClient(pages, record) {
  return {
    hasKey: () => true,
    language: 'en-US',
    async get(endpoint, params) {
      record.push({ endpoint, params: { ...params } });
      // external_ids lookups for the mapper
      const m = endpoint.match(/\/(movie|tv)\/(\d+)\/external_ids/);
      if (m) return { imdb_id: `tt${m[2].padStart(7, '0')}` };
      const page = params.page || 1;
      return pages[endpoint] ? pages[endpoint](page) : { results: [], total_pages: 0 };
    },
  };
}

function makeResults(page, count, total) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const n = (page - 1) * 20 + i + 1;
    results.push({
      id: n,
      title: `Movie ${n}`,
      poster_path: `/p${n}.jpg`,
      backdrop_path: `/b${n}.jpg`,
      release_date: '2020-01-01',
      vote_average: 7,
      adult: false,
    });
  }
  return { results, total_pages: total, page };
}

test('wrong id/type returns empty', async () => {
  _imdbCache.clear();
  const record = [];
  const handler = createCatalogHandler(config, { client: fakeClient({}, record) });
  assert.deepEqual((await handler({ type: 'movie', id: 'nope' })).metas, []);
  assert.deepEqual((await handler({ type: 'series', id: 'popular-movies' })).metas, []);
});

test('selects the row endpoint and static params', async () => {
  _imdbCache.clear();
  const record = [];
  const pages = { '/discover/movie': (p) => makeResults(p, 20, 10) };
  const handler = createCatalogHandler(config, { client: fakeClient(pages, record) });

  await handler({ type: 'movie', id: 'popular-movies', extra: {} });
  const discoverCall = record.find((r) => r.endpoint === '/discover/movie');
  assert.ok(discoverCall);
  assert.equal(discoverCall.params.sort_by, 'popularity.desc');
});

test('genre extra maps to with_genres via lookup', async () => {
  _imdbCache.clear();
  const record = [];
  const pages = { '/discover/movie': (p) => makeResults(p, 20, 10) };
  const handler = createCatalogHandler(config, { client: fakeClient(pages, record) });

  await handler({ type: 'movie', id: 'popular-movies', extra: { genre: 'Action' } });
  const call = record.find((r) => r.endpoint === '/discover/movie');
  assert.equal(call.params.with_genres, 28);
});

test('search-required row returns empty without a query', async () => {
  _imdbCache.clear();
  const record = [];
  const handler = createCatalogHandler(config, { client: fakeClient({}, record) });
  const res = await handler({ type: 'movie', id: 'search-movies', extra: {} });
  assert.deepEqual(res.metas, []);
  assert.equal(record.length, 0, 'should not call TMDB without a query');
});

test('search maps to the query param', async () => {
  _imdbCache.clear();
  const record = [];
  const pages = { '/search/movie': (p) => makeResults(p, 20, 10) };
  const handler = createCatalogHandler(config, { client: fakeClient(pages, record) });
  await handler({ type: 'movie', id: 'search-movies', extra: { search: 'matrix' } });
  const call = record.find((r) => r.endpoint === '/search/movie');
  assert.equal(call.params.query, 'matrix');
});

test('skip pagination requests the right TMDB pages', async () => {
  _imdbCache.clear();
  const record = [];
  // 10 TMDB pages available (200 items).
  const pages = { '/discover/movie': (p) => makeResults(p, 20, 10) };
  const handler = createCatalogHandler(config, { client: fakeClient(pages, record) });

  // skip=100 with pageSize 100 => window [100,200) => TMDB pages 6..10
  await handler({ type: 'movie', id: 'popular-movies', extra: { skip: 100 } });
  const discoverPages = record
    .filter((r) => r.endpoint === '/discover/movie')
    .map((r) => r.params.page);
  assert.deepEqual(discoverPages, [6, 7, 8, 9, 10]);
});

test('short final page signals end of catalog (stops paging)', async () => {
  _imdbCache.clear();
  const record = [];
  // Page 1 returns only 5 items (< 20) => end of catalog.
  const pages = { '/discover/movie': (p) => makeResults(p, p === 1 ? 5 : 20, 3) };
  const handler = createCatalogHandler(config, { client: fakeClient(pages, record) });

  const res = await handler({ type: 'movie', id: 'popular-movies', extra: {} });
  const discoverPages = record
    .filter((r) => r.endpoint === '/discover/movie')
    .map((r) => r.params.page);
  assert.deepEqual(discoverPages, [1], 'should stop after the short page');
  assert.equal(res.metas.length, 5);
});

test('no TMDB key returns empty catalog gracefully', async () => {
  _imdbCache.clear();
  const record = [];
  const noKeyClient = { hasKey: () => false, get: async () => ({}) };
  const handler = createCatalogHandler(config, { client: noKeyClient });
  const res = await handler({ type: 'movie', id: 'popular-movies', extra: {} });
  assert.deepEqual(res.metas, []);
});

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

// ---- v3: mixed rows, rotation, engine catalogs ------------------------------

const { rotationOffset, weightFor } = require('../src/handlers/catalog');
const { runWithOrigin } = require('../src/lib/request-context');

/** Fake client whose endpoints return ids offset by a per-endpoint base. */
function streamClient(bases, record = []) {
  return {
    hasKey: () => true,
    async get(endpoint, params) {
      record.push({ endpoint, params: { ...params } });
      const m = endpoint.match(/\/(movie|tv)\/(\d+)\/external_ids/);
      if (m) return { imdb_id: `tt${m[2].padStart(7, '0')}` };
      const base = bases[endpoint];
      if (base === undefined) return { results: [], total_pages: 0 };
      const page = params.page || 1;
      const results = Array.from({ length: 20 }, (_, i) => {
        const id = base + (page - 1) * 20 + i + 1;
        return {
          id,
          title: `T${id}`,
          poster_path: `/p${id}aaaa.jpg`,
          backdrop_path: `/b${id}aaaa.jpg`,
          original_language: endpoint.includes('search') && i % 5 === 0 ? 'te' : 'en',
        };
      });
      return { results, total_pages: 10, page };
    },
  };
}

const mixConfig = {
  defaults: { region: 'US', posterShape: 'landscape', pageSize: 40 },
  genres: {},
  catalogues: [
    {
      id: 'top10',
      type: 'movie',
      name: 'Top 10',
      art: 'rank',
      limit: 10,
      pageSize: 10,
      source: {
        mix: [
          { endpoint: '/trending/movie/day', params: {}, weightBy: { IN: 1, _default: 2 } },
          { endpoint: '/discover/movie', params: {}, weightBy: { IN: 1, _default: 0 } },
        ],
      },
      extra: [],
    },
  ],
};

test('Top 10 rows stop at the limit and skip the zero-weight feed', async () => {
  _imdbCache.clear();
  const record = [];
  const handler = createCatalogHandler(mixConfig, { client: streamClient({ '/trending/movie/day': 1000 }, record) });
  const res = await handler({ type: 'movie', id: 'top10', extra: {} });
  assert.equal(res.metas.length, 10);
  assert.ok(!record.some((r) => r.endpoint === '/discover/movie'), 'weight 0 in the US: never fetched');
  const after = await handler({ type: 'movie', id: 'top10', extra: { skip: 10 } });
  assert.deepEqual(after.metas, [], 'nothing past the limit');
});

test('Top 10 in India is half worldwide, half Indian', async () => {
  _imdbCache.clear();
  const cfg = Object.assign({}, mixConfig, { defaults: Object.assign({}, mixConfig.defaults, { region: 'IN' }) });
  const handler = createCatalogHandler(cfg, {
    client: streamClient({ '/trending/movie/day': 1000, '/discover/movie': 5000 }),
  });
  const res = await handler({ type: 'movie', id: 'top10', extra: {} });
  const ids = res.metas.map((m) => Number(m.id.slice(2)));
  assert.equal(ids.filter((n) => n > 5000).length, 5);
  assert.equal(ids.filter((n) => n < 5000).length, 5);
});

test('weightFor honours fixed weights, per-region weights and zero', () => {
  assert.equal(weightFor({}, 'US'), 1);
  assert.equal(weightFor({ weight: 0 }, 'US'), 0);
  assert.equal(weightFor({ weight: 3 }, 'US'), 3);
  assert.equal(weightFor({ weightBy: { IN: 1, _default: 3 } }, 'IN'), 1);
  assert.equal(weightFor({ weightBy: { IN: 1, _default: 3 } }, 'GB'), 3);
});

test('rotation starts the row deeper on some days, never on a thin page', async () => {
  const full = async (start, count) => Array.from({ length: count }, (_, i) => start + i);
  const thin = async (start) => (start === 0 ? [1, 2, 3] : [1]);
  const offsets = new Set();
  for (let day = 0; day < 10; day++) {
    const now = Date.UTC(2026, 0, 1 + day, 12);
    const off = await rotationOffset(full, 40, now);
    assert.equal(off % 40, 0);
    assert.ok(off >= 0 && off <= 160);
    offsets.add(off);
    assert.equal(await rotationOffset(thin, 40, now), 0);
  }
  assert.ok(offsets.size > 1, 'varies by day');
});

test('engine search pulls Indian-language matches up after the top 10', async () => {
  _imdbCache.clear();
  const handler = createCatalogHandler(mixConfig, { client: streamClient({ '/search/movie': 0 }) });
  const res = await handler({ type: 'movie', id: 'gc-movie', extra: { search: 'don' } });
  assert.equal(res.metas.length, 40);
  // Results 1..40; every fifth is Telugu (1, 6, 11, ...). After the top 10, Telugu first.
  const ids = res.metas.map((m) => Number(m.id.slice(2)));
  assert.deepEqual(ids.slice(10, 16), [11, 16, 21, 26, 31, 36]);
  assert.equal(res.metas[0].posterShape, undefined, 'search uses portrait posters');
});

test('engine folder tab serves landscape title tiles for a folder key', async () => {
  _imdbCache.clear();
  const record = [];
  const handler = createCatalogHandler(mixConfig, { client: streamClient({ '/discover/movie': 0 }, record) });
  const res = await runWithOrigin('https://golden.example', () =>
    handler({ type: 'movie', id: 'gc-movie', extra: { genre: 'IN.netflix' } })
  );
  assert.equal(res.metas.length, 40);
  const call = record.find((r) => r.endpoint === '/discover/movie');
  assert.equal(call.params.watch_region, 'IN');
  const m = res.metas[0];
  assert.equal(m.posterShape, 'landscape');
  assert.ok(m.landscapePoster.startsWith('https://golden.example/art/tile.jpg?'));
  assert.ok(m._rawPosterUrl.startsWith('https://image.tmdb.org/t/p/w780/'));
});

test('engine catalogs ignore unknown folders and bare requests', async () => {
  const handler = createCatalogHandler(mixConfig, { client: streamClient({}) });
  assert.deepEqual((await handler({ type: 'movie', id: 'gc-movie', extra: { genre: 'IN.nope' } })).metas, []);
  assert.deepEqual((await handler({ type: 'movie', id: 'gc-movie', extra: {} })).metas, []);
  assert.deepEqual((await handler({ type: 'series', id: 'gc-series', extra: { genre: 'IN.kgf' } })).metas, [], 'movie-only folder');
  assert.deepEqual((await handler({ type: 'series', id: 'gc-movie,netflix', extra: {} })).metas, [], 'type must match the catalog');
});

test('folder tabs resolve "gc-movie,<folder>" in the edition region', async () => {
  _imdbCache.clear();
  const record = [];
  const cfg = Object.assign({}, mixConfig, { defaults: Object.assign({}, mixConfig.defaults, { region: 'IN' }) });
  const handler = createCatalogHandler(cfg, { client: streamClient({ '/discover/tv': 0 }, record) });
  const res = await runWithOrigin('https://golden.example', () =>
    handler({ type: 'series', id: 'gc-series,jiohotstar', extra: { skip: '40' } })
  );
  assert.equal(res.metas.length, 40);
  const call = record.find((r) => r.endpoint === '/discover/tv');
  assert.equal(call.params.watch_region, 'IN');
  assert.equal(call.params.with_watch_providers, '2336');
  assert.equal(call.params.page, 3, 'skip 40 starts at the third TMDB page');
  assert.equal(res.cacheMaxAge, 3600);
});

test('a skip beyond any feed is empty without touching TMDB', async () => {
  const record = [];
  const handler = createCatalogHandler(config, { client: fakeClient({}, record) });
  for (const skip of ['1.3959108817495173e308', '1e400', '100000', 'Infinity']) {
    assert.deepEqual((await handler({ type: 'movie', id: 'popular-movies', extra: { skip } })).metas, [], skip);
  }
  assert.equal(record.length, 0);
});

test('Top 10 refills titles that drop out, and never shows more than 10', async () => {
  _imdbCache.clear();
  // Every third trending title has no IMDb id.
  const client = streamClient({ '/trending/movie/day': 1000 });
  const get = client.get;
  client.get = async (endpoint, params) => {
    const m = endpoint.match(/\/movie\/(\d+)\/external_ids/);
    if (m && Number(m[1]) % 3 === 0) return { imdb_id: null };
    return get(endpoint, params);
  };
  const handler = createCatalogHandler(mixConfig, { client });
  const res = await handler({ type: 'movie', id: 'top10', extra: {} });
  assert.equal(res.metas.length, 10);
});

test('a window whose titles are all filtered out looks further instead of ending the row', async () => {
  _imdbCache.clear();
  const cfg = {
    defaults: { region: 'US', posterShape: 'poster', pageSize: 20 },
    genres: {},
    catalogues: [{ id: 'deep', type: 'movie', name: 'Deep', art: 'poster', source: { endpoint: '/discover/movie', params: {} }, extra: [{ name: 'skip' }] }],
  };
  const client = {
    hasKey: () => true,
    async get(endpoint, params) {
      const m = endpoint.match(/\/movie\/(\d+)\/external_ids/);
      if (m) return { imdb_id: `tt${m[1].padStart(7, '0')}` };
      const page = params.page;
      // Page 2 has no posters at all; page 3 is normal.
      const results = Array.from({ length: 20 }, (_, i) => ({
        id: (page - 1) * 20 + i + 1,
        title: 'x',
        poster_path: page === 2 ? null : `/p${page}${i}aaaa.jpg`,
      }));
      return { results, total_pages: 5 };
    },
  };
  const handler = createCatalogHandler(cfg, { client });
  const res = await handler({ type: 'movie', id: 'deep', extra: { skip: '20' } });
  assert.equal(res.metas.length, 20, 'served the next window');
  assert.equal(res.metas[0].id, 'tt0000041');
});

test('a page built after a TMDB failure carries no cache hints', async () => {
  _imdbCache.clear();
  const client = streamClient({ '/discover/movie': 0 });
  const get = client.get;
  let calls = 0;
  client.get = async (endpoint, params) => {
    if (endpoint === '/discover/movie' && ++calls === 2) throw new Error('TMDB 503');
    return get(endpoint, params);
  };
  const handler = createCatalogHandler(config, { client });
  const res = await handler({ type: 'movie', id: 'popular-movies', extra: {} });
  assert.ok(res.metas.length > 0, 'keeps what it has');
  assert.equal(res.cacheMaxAge, undefined);
  const ok = await createCatalogHandler(config, { client: streamClient({ '/discover/movie': 0 }) })({ type: 'movie', id: 'popular-movies', extra: {} });
  assert.equal(ok.cacheMaxAge, 3600);
});

test('rotation follows the edition day, not the UTC day', async () => {
  const full = async (start, count) => Array.from({ length: count }, (_, i) => start + i);
  // 2026-06-15 23:30 in New York is already the 16th in UTC.
  const t = Date.UTC(2026, 5, 16, 3, 30);
  const ny = await rotationOffset(full, 40, t, 'America/New_York');
  const nyEarlier = await rotationOffset(full, 40, Date.UTC(2026, 5, 15, 16, 0), 'America/New_York');
  assert.equal(ny, nyEarlier, 'same local day, same offset');
});

'use strict';

/**
 * Task 7 — optional enrichment tests (RPDB poster badges + fanart meta).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient, rpdbPosterUrl, posterUrl } = require('../src/tmdb/client');
const { toMetaPreviews, _imdbCache } = require('../src/tmdb/mappers');
const { createMetaHandler } = require('../src/handlers/meta');

function fakeFetch(externalIds) {
  return async (urlStr) => {
    const url = new URL(urlStr);
    const m = url.pathname.match(/\/3\/(movie|tv)\/(\d+)\/external_ids/);
    if (m) {
      return { ok: true, status: 200, json: async () => ({ imdb_id: externalIds[m[2]] ?? null }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

test('rpdbPosterUrl builds the expected URL and no-ops without a key', () => {
  assert.equal(rpdbPosterUrl(null, 'tt0133093'), undefined);
  assert.equal(
    rpdbPosterUrl('t0-free-rpdb', 'tt0133093'),
    'https://api.ratingposterdb.com/t0-free-rpdb/imdb/poster-default/tt0133093.jpg'
  );
});

test('mapper swaps poster to RPDB badge version when key is set', async () => {
  _imdbCache.clear();
  const client = createTmdbClient({
    apiKey: 'k',
    rpdbKey: 't0-free-rpdb',
    fetch: fakeFetch({ 603: 'tt0133093' }),
    ttlMs: 0,
  });
  const results = [
    { id: 603, title: 'The Matrix', poster_path: '/m.jpg', backdrop_path: '/b.jpg', release_date: '1999-03-30', adult: false },
  ];
  const metas = await toMetaPreviews(client, results, { stremioType: 'movie' });
  assert.equal(metas[0].poster, rpdbPosterUrl('t0-free-rpdb', 'tt0133093'));
});

test('mapper keeps TMDB poster when no RPDB key', async () => {
  _imdbCache.clear();
  const client = createTmdbClient({ apiKey: 'k', fetch: fakeFetch({ 603: 'tt0133093' }), ttlMs: 0 });
  const results = [
    { id: 603, title: 'The Matrix', poster_path: '/m.jpg', backdrop_path: '/b.jpg', release_date: '1999-03-30', adult: false },
  ];
  const metas = await toMetaPreviews(client, results, { stremioType: 'movie' });
  assert.equal(metas[0].poster, posterUrl('/m.jpg'));
});

test('meta handler is disabled (null) when there is no TMDB key', () => {
  // No injected client and no env key -> cannot build richer metadata than
  // Cinemeta, so the handler is disabled and Cinemeta supplies detail pages.
  const prev = process.env.TMDB_API_KEY;
  delete process.env.TMDB_API_KEY;
  try {
    const handler = createMetaHandler(
      { defaults: { language: 'en-US' } },
      { fanart: null }
    );
    assert.equal(handler, null);
  } finally {
    if (prev !== undefined) process.env.TMDB_API_KEY = prev;
  }
});

test('meta handler enriches with fanart logo when enabled', async () => {
  const fakeTmdb = {
    hasKey: () => true,
    language: 'en-US',
    async get(endpoint) {
      if (endpoint.startsWith('/find/')) {
        return { movie_results: [{ id: 603 }], tv_results: [] };
      }
      if (/^\/movie\/\d+$/.test(endpoint)) {
        return {
          id: 603,
          title: 'The Matrix',
          poster_path: '/m.jpg',
          backdrop_path: '/b.jpg',
          overview: 'x',
          release_date: '1999-03-30',
          vote_average: 8.2,
          genres: [],
          credits: { cast: [], crew: [] },
          videos: { results: [] },
          external_ids: { imdb_id: 'tt0133093' },
        };
      }
      return {};
    },
  };
  const fakeFanart = {
    async movie(imdbId) {
      assert.equal(imdbId, 'tt0133093');
      return { logo: 'https://fanart/logo.png' };
    },
    async tv() {
      return {};
    },
  };
  const handler = createMetaHandler(
    { defaults: { language: 'en-US' } },
    { fanart: fakeFanart, client: fakeTmdb }
  );
  assert.ok(handler);
  const res = await handler({ type: 'movie', id: 'tt0133093' });
  assert.equal(res.meta.id, 'tt0133093');
  assert.equal(res.meta.name, 'The Matrix');
  assert.equal(res.meta.logo, 'https://fanart/logo.png');
  assert.equal(res.meta.imdbRating, '8.2');
});

test('meta handler returns minimal meta when TMDB find fails', async () => {
  const fakeTmdb = {
    hasKey: () => true,
    language: 'en-US',
    async get() {
      return { movie_results: [], tv_results: [] };
    },
  };
  const handler = createMetaHandler(
    { defaults: { language: 'en-US' } },
    { fanart: { movie: async () => ({}), tv: async () => ({}) }, client: fakeTmdb }
  );
  const res = await handler({ type: 'movie', id: 'tt9999999' });
  assert.equal(res.meta.id, 'tt9999999');
  assert.equal(res.meta.type, 'movie');
});

test('meta handler rejects non-tt ids gracefully', async () => {
  const fakeTmdb = { hasKey: () => true, language: 'en-US', get: async () => ({}) };
  const handler = createMetaHandler(
    { defaults: { language: 'en-US' } },
    { fanart: { movie: async () => ({}), tv: async () => ({}) }, client: fakeTmdb }
  );
  const res = await handler({ type: 'movie', id: 'tmdb:603' });
  assert.equal(res.meta, null);
});

'use strict';

/**
 * Task 4 — TMDB mapper tests (no network; fake fetch injected).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient, posterUrl, backdropUrl } = require('../src/tmdb/client');
const { toMetaPreviews, _imdbCache } = require('../src/tmdb/mappers');

// A fake fetch that serves external_ids per TMDB id.
function fakeFetch(externalIds) {
  return async (urlStr) => {
    const url = new URL(urlStr);
    // include_adult must always be forced false by the client.
    assert.equal(
      url.searchParams.get('include_adult'),
      'false',
      'client must force include_adult=false'
    );
    const m = url.pathname.match(/\/3\/(movie|tv)\/(\d+)\/external_ids/);
    if (m) {
      const id = Number(m[2]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ imdb_id: externalIds[id] ?? null }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function client(externalIds) {
  return createTmdbClient({
    apiKey: 'test-key',
    fetch: fakeFetch(externalIds),
    ttlMs: 0,
  });
}

const MOVIE_RESULTS = [
  {
    id: 603,
    title: 'The Matrix',
    poster_path: '/matrix.jpg',
    backdrop_path: '/matrix-bg.jpg',
    release_date: '1999-03-30',
    vote_average: 8.2,
    overview: 'A hacker learns the truth.',
    adult: false,
  },
  {
    id: 999,
    title: 'Adult Film',
    poster_path: '/x.jpg',
    release_date: '2020-01-01',
    vote_average: 5,
    adult: true, // must be filtered out
  },
  {
    id: 777,
    title: 'No Poster Movie',
    poster_path: null, // must be filtered out (no poster)
    release_date: '2021-01-01',
    adult: false,
  },
  {
    id: 555,
    title: 'No Imdb Movie',
    poster_path: '/np.jpg',
    release_date: '2022-01-01',
    adult: false,
  },
];

test('maps movie results to tt-id previews, filters adult + poster-less + unmappable', async () => {
  _imdbCache.clear();
  const c = client({ 603: 'tt0133093', 555: null });
  const metas = await toMetaPreviews(c, MOVIE_RESULTS, { stremioType: 'movie' });

  // Only The Matrix survives: adult filtered, no-poster filtered, no-imdb dropped.
  assert.equal(metas.length, 1);
  const m = metas[0];
  assert.equal(m.id, 'tt0133093');
  assert.equal(m.type, 'movie');
  assert.equal(m.name, 'The Matrix');
  assert.equal(m.poster, posterUrl('/matrix.jpg'));
  assert.equal(m.background, backdropUrl('/matrix-bg.jpg'));
  assert.equal(m.releaseInfo, '1999');
  assert.equal(m.imdbRating, '8.2');
});

test('landscape rows use the backdrop as the poster image', async () => {
  _imdbCache.clear();
  const c = client({ 603: 'tt0133093' });
  const metas = await toMetaPreviews(c, [MOVIE_RESULTS[0]], {
    stremioType: 'movie',
    posterShape: 'landscape',
  });
  assert.equal(metas.length, 1);
  assert.equal(metas[0].posterShape, 'landscape');
  assert.equal(metas[0].poster, backdropUrl('/matrix-bg.jpg'));
});

test('maps series results (name/first_air_date) correctly', async () => {
  _imdbCache.clear();
  const c = client({ 1399: 'tt0944947' });
  const results = [
    {
      id: 1399,
      name: 'Game of Thrones',
      poster_path: '/got.jpg',
      first_air_date: '2011-04-17',
      vote_average: 8.4,
      adult: false,
    },
  ];
  const metas = await toMetaPreviews(c, results, { stremioType: 'series' });
  assert.equal(metas.length, 1);
  assert.equal(metas[0].id, 'tt0944947');
  assert.equal(metas[0].type, 'series');
  assert.equal(metas[0].name, 'Game of Thrones');
  assert.equal(metas[0].releaseInfo, '2011');
});

test('empty / null results resolve to empty array', async () => {
  _imdbCache.clear();
  const c = client({});
  assert.deepEqual(await toMetaPreviews(c, [], { stremioType: 'movie' }), []);
  assert.deepEqual(await toMetaPreviews(c, null, { stremioType: 'movie' }), []);
});

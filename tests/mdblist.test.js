'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMdblistSource, normaliseListUrl, _listCache } = require('../src/sources/mdblist');
const { previewsFromImdbIds, _imdbCache } = require('../src/tmdb/mappers');
const { createTmdbClient } = require('../src/tmdb/client');

const SAMPLE = [
  { imdb_id: 'tt0111161', mediatype: 'movie', adult: 0, title: 'The Shawshank Redemption' },
  { imdb_id: 'tt0068646', mediatype: 'movie', adult: 0, title: 'The Godfather' },
  { imdb_id: 'tt0903747', mediatype: 'show', adult: 0, title: 'Breaking Bad' },
  { imdb_id: 'tt9999999', mediatype: 'movie', adult: 1, title: 'Adult' },
  { title: 'No id', mediatype: 'movie' },
];

function fakeListFetch(items) {
  return async () => ({ ok: true, status: 200, json: async () => items });
}

test('normaliseListUrl appends /json when missing', () => {
  assert.equal(
    normaliseListUrl('https://mdblist.com/lists/u/s'),
    'https://mdblist.com/lists/u/s/json'
  );
  assert.equal(
    normaliseListUrl('https://mdblist.com/lists/u/s/json'),
    'https://mdblist.com/lists/u/s/json'
  );
});

test('imdbIds filters by type, drops adult and id-less items, preserves order', async () => {
  _listCache.clear();
  const src = createMdblistSource({ fetch: fakeListFetch(SAMPLE) });
  const movies = await src.imdbIds('https://mdblist.com/lists/u/s/json', 'movie', 0, 50);
  assert.deepEqual(movies, ['tt0111161', 'tt0068646']);
  const shows = await src.imdbIds('https://mdblist.com/lists/u/s/json', 'series', 0, 50);
  assert.deepEqual(shows, ['tt0903747']);
});

test('imdbIds paginates with the window', async () => {
  _listCache.clear();
  const src = createMdblistSource({ fetch: fakeListFetch(SAMPLE) });
  const page = await src.imdbIds('https://mdblist.com/lists/u/s/json', 'movie', 1, 2);
  assert.deepEqual(page, ['tt0068646']);
});

test('fetch failure yields empty list, not an error', async () => {
  _listCache.clear();
  const src = createMdblistSource({ fetch: async () => { throw new Error('down'); } });
  const ids = await src.imdbIds('https://mdblist.com/lists/u/s/json', 'movie');
  assert.deepEqual(ids, []);
});

test('previewsFromImdbIds enriches tt ids via TMDB find, preserves order', async () => {
  _imdbCache.clear();
  const tmdb = {
    hasKey: () => true,
    rpdbKey: null,
    language: 'en-US',
    async get(endpoint) {
      const m = endpoint.match(/\/find\/(tt\d+)/);
      if (m) {
        const id = m[1];
        return {
          movie_results: [{ id: 1, title: 'Title ' + id, poster_path: '/p.jpg', backdrop_path: '/b.jpg', release_date: '2000-01-01', vote_average: 8, adult: false }],
          tv_results: [],
        };
      }
      return {};
    },
  };
  const metas = await previewsFromImdbIds(tmdb, ['tt0111161', 'tt0068646'], { stremioType: 'movie' });
  assert.equal(metas.length, 2);
  assert.equal(metas[0].id, 'tt0111161');
  assert.equal(metas[1].id, 'tt0068646');
  assert.ok(metas[0].poster);
});

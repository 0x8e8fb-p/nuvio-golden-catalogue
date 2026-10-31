'use strict';

/**
 * Full detail-page meta tests: cast/director/writer, trailers, genres, runtime,
 * and the series episode `videos` array with correct Stremio ids.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMeta, runtimeString } = require('../src/tmdb/meta');

// A fake TMDB client whose /find, detail, and season responses are scripted.
function fakeClient(script) {
  return {
    hasKey: () => true,
    language: 'en-US',
    async get(endpoint, params = {}) {
      if (endpoint.startsWith('/find/')) return script.find;
      if (/^\/movie\/\d+$/.test(endpoint)) return script.movieDetail;
      if (/^\/tv\/\d+$/.test(endpoint)) {
        // season append call vs base detail call
        if (params.append_to_response && params.append_to_response.includes('season/')) {
          return script.tvWithSeasons;
        }
        return script.tvDetail;
      }
      return {};
    },
  };
}

test('runtimeString formats hours and minutes', () => {
  assert.equal(runtimeString(136), '2h 16m');
  assert.equal(runtimeString(45), '45m');
  assert.equal(runtimeString(0), undefined);
});

test('movie meta includes cast, director, writer, trailers, runtime, genres', async () => {
  const client = fakeClient({
    find: { movie_results: [{ id: 603 }], tv_results: [] },
    movieDetail: {
      id: 603,
      title: 'The Matrix',
      poster_path: '/m.jpg',
      backdrop_path: '/b.jpg',
      overview: 'A hacker learns the truth.',
      release_date: '1999-03-30',
      vote_average: 8.2,
      runtime: 136,
      genres: [{ name: 'Action' }, { name: 'Science Fiction' }],
      credits: {
        cast: [{ name: 'Keanu Reeves' }, { name: 'Carrie-Anne Moss' }],
        crew: [
          { job: 'Director', name: 'Lana Wachowski' },
          { job: 'Director', name: 'Lilly Wachowski' },
          { job: 'Writer', name: 'Lana Wachowski' },
        ],
      },
      videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'abc123' }] },
      external_ids: { imdb_id: 'tt0133093' },
    },
  });

  const { meta } = await buildMeta(client, 'tt0133093', 'movie');
  assert.equal(meta.id, 'tt0133093');
  assert.equal(meta.name, 'The Matrix');
  assert.deepEqual(meta.genres, ['Action', 'Science Fiction']);
  assert.equal(meta.runtime, '2h 16m');
  assert.equal(meta.imdbRating, '8.2');
  assert.deepEqual(meta.cast, ['Keanu Reeves', 'Carrie-Anne Moss']);
  assert.deepEqual(meta.director, ['Lana Wachowski', 'Lilly Wachowski']);
  assert.deepEqual(meta.writer, ['Lana Wachowski']);
  assert.equal(meta.trailers[0].source, 'abc123');
  assert.equal(meta.trailers[0].type, 'Trailer');
});

test('series meta builds the episode videos array with Stremio ids', async () => {
  const client = fakeClient({
    find: { movie_results: [], tv_results: [{ id: 1399 }] },
    tvDetail: {
      id: 1399,
      name: 'Game of Thrones',
      poster_path: '/got.jpg',
      backdrop_path: '/gotbg.jpg',
      overview: 'Noble families vie for the throne.',
      first_air_date: '2011-04-17',
      last_air_date: '2019-05-19',
      status: 'Ended',
      vote_average: 8.4,
      episode_run_time: [60],
      genres: [{ name: 'Drama' }],
      credits: { cast: [{ name: 'Emilia Clarke' }], crew: [] },
      videos: { results: [] },
      external_ids: { imdb_id: 'tt0944947', tvdb_id: 121361 },
      seasons: [
        { season_number: 0 },
        { season_number: 1 },
      ],
    },
    tvWithSeasons: {
      'season/1': {
        episodes: [
          { episode_number: 1, name: 'Winter Is Coming', air_date: '2011-04-17', overview: 'x', still_path: '/s1e1.jpg' },
          { episode_number: 2, name: 'The Kingsroad', air_date: '2011-04-24' },
        ],
      },
    },
  });

  const { meta } = await buildMeta(client, 'tt0944947', 'series');
  assert.equal(meta.type, 'series');
  assert.equal(meta.releaseInfo, '2011-2019');
  assert.equal(meta.runtime, '1h 0m');
  assert.ok(Array.isArray(meta.videos));
  assert.equal(meta.videos.length, 2);
  assert.equal(meta.videos[0].id, 'tt0944947:1:1');
  assert.equal(meta.videos[0].title, 'Winter Is Coming');
  assert.equal(meta.videos[0].season, 1);
  assert.equal(meta.videos[0].episode, 1);
  assert.ok(meta.videos[0].released.startsWith('2011-04-17'));
});

test('unresolvable tt id returns null', async () => {
  const client = fakeClient({ find: { movie_results: [], tv_results: [] } });
  const res = await buildMeta(client, 'tt0000000', 'movie');
  assert.equal(res, null);
});

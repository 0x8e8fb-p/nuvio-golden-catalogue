'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnilistClient } = require('../src/sources/anilist');
const { createMetaHandler } = require('../src/handlers/meta');

function fakeAnilistFetch(media) {
  return async () => ({ ok: true, status: 200, json: async () => ({ data: { Media: media } }) });
}

test('anilist client is disabled unless forced or ENABLE_ANILIST=1', () => {
  const prev = process.env.ENABLE_ANILIST;
  delete process.env.ENABLE_ANILIST;
  try {
    assert.equal(createAnilistClient(), null);
    assert.ok(createAnilistClient({ force: true, fetch: fakeAnilistFetch(null) }));
  } finally {
    if (prev !== undefined) process.env.ENABLE_ANILIST = prev;
  }
});

test('anilist enrich maps averageScore to 0-10 and returns genres', async () => {
  const client = createAnilistClient({
    force: true,
    fetch: fakeAnilistFetch({ averageScore: 84, genres: ['Action', 'Adventure'], title: { romaji: 'x' } }),
  });
  const out = await client.enrich('Attack on Titan', '2013');
  assert.equal(out.anilistRating, '8.4');
  assert.deepEqual(out.genres, ['Action', 'Adventure']);
});

test('anilist miss returns empty object', async () => {
  const client = createAnilistClient({ force: true, fetch: fakeAnilistFetch(null) });
  assert.deepEqual(await client.enrich('Nonexistent', '1900'), {});
});

test('meta handler merges anilist genres for anime series', async () => {
  const fakeTmdb = {
    hasKey: () => true,
    language: 'en-US',
    async get(endpoint) {
      if (endpoint.startsWith('/find/')) return { movie_results: [], tv_results: [{ id: 1 }] };
      if (/^\/tv\/\d+$/.test(endpoint)) {
        return {
          id: 1,
          name: 'Attack on Titan',
          first_air_date: '2013-04-07',
          genres: [{ name: 'Animation' }],
          credits: { cast: [], crew: [] },
          videos: { results: [] },
          external_ids: {},
          seasons: [],
        };
      }
      return {};
    },
  };
  const fakeAnilist = { enrich: async () => ({ genres: ['Shounen'], anilistRating: '8.9' }) };
  const handler = createMetaHandler(
    { defaults: { language: 'en-US' } },
    { client: fakeTmdb, fanart: null, anilist: fakeAnilist }
  );
  const res = await handler({ type: 'series', id: 'tt2560140' });
  assert.ok(res.meta.genres.includes('Animation'));
  assert.ok(res.meta.genres.includes('Shounen'));
  assert.equal(res.meta.imdbRating, '8.9');
});

'use strict';

/**
 * TMDB credentials: the v3 API Key goes in the api_key parameter, the v4 API
 * Read Access Token is sent as a Bearer token, and pasted keys are trimmed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTmdbClient } = require('../src/tmdb/client');

// Shaped like a TMDB read access token; not a real one.
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoxfQ.c2lnbmF0dXJlLXRlc3Q';

function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), headers: (init && init.headers) || {} });
    return { ok: true, status: 200, json: async () => ({ images: {} }) };
  };
  return { calls, fetchImpl };
}

test('a v3 API key goes in the api_key parameter', async () => {
  const { calls, fetchImpl } = recorder();
  const client = createTmdbClient({ apiKey: 'abc123', fetch: fetchImpl });
  await client.get('/configuration');
  assert.equal(calls[0].url.searchParams.get('api_key'), 'abc123');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(client.authMode, 'api-key');
});

test('a v4 read access token is sent as a Bearer token, never in the URL', async () => {
  const { calls, fetchImpl } = recorder();
  const client = createTmdbClient({ apiKey: FAKE_TOKEN, fetch: fetchImpl });
  await client.get('/configuration');
  assert.equal(calls[0].url.searchParams.has('api_key'), false);
  assert.equal(calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(client.buildUrl('/movie/603').toString().includes(FAKE_TOKEN), false);
  assert.equal(client.authMode, 'read-access-token');
});

test('spaces and line breaks around a pasted key are ignored', async () => {
  const { calls, fetchImpl } = recorder();
  await createTmdbClient({ apiKey: '  abc123\n', fetch: fetchImpl }).get('/configuration');
  assert.equal(calls[0].url.searchParams.get('api_key'), 'abc123');
  const token = recorder();
  await createTmdbClient({ apiKey: `\t${FAKE_TOKEN} `, fetch: token.fetchImpl }).get('/configuration');
  assert.equal(token.calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(createTmdbClient({ apiKey: '   ' }).hasKey(), false, 'blank is no key');
});

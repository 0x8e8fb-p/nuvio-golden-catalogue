'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker } = require('../src/lib/circuit-breaker');
const { createTmdbClient } = require('../src/tmdb/client');

test('breaker opens after threshold failures and short-circuits', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 100, now: () => t });
  assert.equal(cb.canRequest(), true);
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, 'closed');
  cb.recordFailure(); // hits threshold
  assert.equal(cb.state, 'open');
  assert.equal(cb.canRequest(), false); // still within cooldown
});

test('breaker half-opens after cooldown and closes on success', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => t });
  cb.recordFailure();
  cb.recordFailure(); // open
  assert.equal(cb.canRequest(), false);
  t = 150; // past cooldown
  assert.equal(cb.canRequest(), true); // half-open trial allowed
  assert.equal(cb.state, 'half-open');
  cb.recordSuccess();
  assert.equal(cb.state, 'closed');
});

test('breaker re-opens if the half-open trial fails', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => t });
  cb.recordFailure();
  cb.recordFailure();
  t = 150;
  cb.canRequest(); // -> half-open
  cb.recordFailure();
  assert.equal(cb.state, 'open');
});

test('client serves stale data when a live fetch fails', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ results: [{ id: 1 }], total_pages: 1 }) };
    }
    throw new Error('network down');
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl, ttlMs: 1, maxRetries: 0 });

  // First call populates cache + stale store.
  const first = await client.get('/discover/movie', { page: 1 });
  assert.equal(first.results.length, 1);

  // Let the short cache expire, then the next live fetch fails -> stale served.
  await new Promise((r) => setTimeout(r, 5));
  const second = await client.get('/discover/movie', { page: 1 });
  assert.equal(second.results.length, 1, 'stale copy should be served on failure');
});

test('client exposes breaker stats', () => {
  const client = createTmdbClient({ apiKey: 'k' });
  const s = client.breakerStats();
  assert.ok(s && typeof s.state === 'string');
});

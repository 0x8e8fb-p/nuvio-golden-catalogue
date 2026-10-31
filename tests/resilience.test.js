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

// ---- Concurrency limit, shared lookups, retries ------------------------------

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('at most maxConcurrent requests are in flight, and every one finishes', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url) => {
    active++;
    peak = Math.max(peak, active);
    await tick(5);
    active--;
    return ok({ url: String(url) });
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl, maxConcurrent: 3 });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => client.get(`/movie/${i + 1}/external_ids`)));
  assert.equal(results.length, 20);
  assert.equal(peak, 3, `peak was ${peak}`);
  assert.deepEqual(client.queueStats(), { active: 0, waiting: 0, max: 3 });
});

test('concurrent requests for the same URL share one fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await tick(5);
    return ok({ imdb_id: 'tt0133093' });
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl });
  const all = await Promise.all(Array.from({ length: 5 }, () => client.get('/movie/603/external_ids')));
  assert.equal(calls, 1);
  assert.ok(all.every((v) => v.imdb_id === 'tt0133093'));
});

test('a 404 is not retried and does not count against TMDB', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl });
  await assert.rejects(client.get('/movie/999999999'), (err) => err.status === 404);
  assert.equal(calls, 1);
  assert.equal(client.breakerStats().failures, 0);
});

test('a 429 waits for Retry-After before trying again', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0.08' : null) }, json: async () => ({}) };
    }
    return ok({ results: [] });
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl });
  const started = Date.now();
  await client.get('/trending/movie/day');
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 70, 'waited about 80 ms');
});

test('a failed request frees its slot', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) throw new Error('network down');
    return ok({ fine: true });
  };
  const client = createTmdbClient({ apiKey: 'k', fetch: fetchImpl, maxConcurrent: 1, maxRetries: 0 });
  await assert.rejects(client.get('/a'));
  assert.deepEqual(await client.get('/b'), { fine: true });
  assert.deepEqual(client.queueStats(), { active: 0, waiting: 0, max: 1 });
});

'use strict';

/**
 * Weighted mixing (src/lib/mix.js): the round-robin stream, and exact paging
 * at any skip, which is what Nuvio sends (skip + items received).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundRobinWindow, fetchMixedWindow, fetchWindow } = require('../src/lib/mix');

/** Fake TMDB client: endpoint "/a" has `sizes.a` items with ids a1, a2, ... */
function fakeClient(sizes, calls = []) {
  return {
    async get(endpoint, params) {
      calls.push(`${endpoint}:${params.page}`);
      const name = endpoint.slice(1);
      const total = sizes[name] || 0;
      const results = [];
      for (let i = (params.page - 1) * 20; i < Math.min(total, params.page * 20); i++) {
        results.push({ id: `${name}${i + 1}` });
      }
      return { results, total_pages: Math.ceil(total / 20) };
    },
  };
}

const ids = (items) => items.map((x) => x.id);

test('round robin spreads a 3:1 mix evenly', () => {
  const { order } = roundRobinWindow([3, 1], 0, 8);
  assert.deepEqual(order, [0, 0, 1, 0, 0, 0, 1, 0]);
});

test('round robin windows stitch into the full stream', () => {
  const weights = [3, 1];
  const full = roundRobinWindow(weights, 0, 200).order;
  for (const start of [0, 1, 7, 37, 40, 123]) {
    const { before, order } = roundRobinWindow(weights, start, 50);
    assert.deepEqual(order, full.slice(start, start + 50), `window at ${start}`);
    assert.deepEqual(
      before,
      [0, 1].map((i) => full.slice(0, start).filter((x) => x === i).length),
      `slots used before ${start}`
    );
  }
});

test('weight 0 components never get a slot', () => {
  const { order } = roundRobinWindow([1, 0], 0, 5);
  assert.deepEqual(order, [0, 0, 0, 0, 0]);
});

test('round robin stays fast and exact at the position cap, with any weights', () => {
  for (const weights of [[4, 1], [2, 1], [1.5, 1], [3, 1]]) {
    const started = Date.now();
    const { before, order } = roundRobinWindow(weights, 1e308, 40);
    assert.ok(Date.now() - started < 50, `${weights}: fast`);
    assert.equal(order.length, 40);
    assert.ok(before.every(Number.isSafeInteger), `${weights}: exact counts`);
  }
});

test('mixed pages continue exactly from any skip', async () => {
  const client = fakeClient({ a: 300, b: 300 });
  const comps = [
    { endpoint: '/a', weight: 3 },
    { endpoint: '/b', weight: 1 },
  ];
  const whole = ids(await fetchMixedWindow(client, comps, 0, 120));
  // A short page (37 of 40) followed by a page from skip=37, as Nuvio asks.
  const first = ids(await fetchMixedWindow(client, comps, 0, 37));
  const next = ids(await fetchMixedWindow(client, comps, 37, 40));
  assert.deepEqual(first.concat(next), whole.slice(0, 77));
  assert.equal(new Set(whole).size, whole.length, 'no repeats');
  assert.equal(whole.filter((x) => x.startsWith('b')).length, 30, 'one in four is from b');
});

test('a feed that runs out leaves its slots empty and the rest continue', async () => {
  const client = fakeClient({ a: 100, b: 3 });
  const comps = [
    { endpoint: '/a', weight: 1 },
    { endpoint: '/b', weight: 1 },
  ];
  const page = ids(await fetchMixedWindow(client, comps, 0, 10));
  assert.deepEqual(page, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'a5']);
});

test('duplicates across feeds are dropped within a page', async () => {
  const client = {
    async get(endpoint) {
      return { results: [{ id: 1 }, { id: endpoint === '/a' ? 2 : 3 }], total_pages: 1 };
    },
  };
  const page = await fetchMixedWindow(client, [{ endpoint: '/a', weight: 1 }, { endpoint: '/b', weight: 1 }], 0, 4);
  assert.deepEqual(ids(page), [1, 2, 3]);
});

test('fetchWindow asks only for the TMDB pages it needs and stops at the end', async () => {
  const calls = [];
  const client = fakeClient({ a: 45 }, calls);
  const items = await fetchWindow(client, '/a', {}, 15, 40);
  assert.deepEqual(calls, ['/a:1', '/a:2', '/a:3']);
  assert.equal(items.length, 30); // items 16..45
  assert.equal(items[0].id, 'a16');
});

test('fetchWindow keeps what it has when a later page fails', async () => {
  let n = 0;
  const client = {
    async get() {
      n++;
      if (n > 1) throw new Error('TMDB 500');
      return { results: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })), total_pages: 5 };
    },
  };
  const items = await fetchWindow(client, '/a', {}, 0, 40);
  assert.equal(items.length, 20);
});

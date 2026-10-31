'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TtlLruCache } = require('../src/lib/cache');

test('stores and retrieves values; tracks hits/misses', () => {
  const c = new TtlLruCache({ max: 10, ttl: 1000 });
  assert.equal(c.get('a'), undefined);
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.hitRate, 0.5);
});

test('expires entries after ttl', () => {
  const c = new TtlLruCache({ max: 10, ttl: 5 });
  c.set('a', 1);
  const future = Date.now() + 10;
  const realNow = Date.now;
  Date.now = () => future;
  try {
    assert.equal(c.get('a'), undefined);
    assert.equal(c.stats().expirations, 1);
  } finally {
    Date.now = realNow;
  }
});

test('evicts least-recently-used beyond max', () => {
  const c = new TtlLruCache({ max: 2, ttl: 0 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a'); // bump a to most-recent
  c.set('c', 3); // should evict b (LRU)
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
  assert.ok(c.stats().evictions >= 1);
});

test('ttl=0 means no expiry', () => {
  const c = new TtlLruCache({ max: 10, ttl: 0 });
  c.set('a', 1);
  const realNow = Date.now;
  Date.now = () => Date.now.base + 1e9;
  Date.now.base = realNow();
  try {
    assert.equal(c.get('a'), 1);
  } finally {
    Date.now = realNow;
  }
});

test('client exposes cache stats', () => {
  const { createTmdbClient } = require('../src/tmdb/client');
  const client = createTmdbClient({ apiKey: 'k' });
  const stats = client.cacheStats();
  assert.ok(stats && typeof stats.hitRate === 'number');
});

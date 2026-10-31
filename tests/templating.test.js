'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveParams, resolveValue } = require('../src/lib/templating');

const FIXED = Date.UTC(2026, 5, 15); // 2026-06-15

test('{{region}} resolves to configured region', () => {
  assert.equal(resolveValue('{{region}}', { region: 'IN', now: FIXED }), 'IN');
});

test('{{now}} resolves to today (UTC, YYYY-MM-DD)', () => {
  assert.equal(resolveValue('{{now}}', { region: 'US', now: FIXED }), '2026-06-15');
});

test('{{now-90d}} subtracts days', () => {
  assert.equal(resolveValue('{{now-90d}}', { region: 'US', now: FIXED }), '2026-03-17');
});

test('{{now+30d}} adds days', () => {
  assert.equal(resolveValue('{{now+30d}}', { region: 'US', now: FIXED }), '2026-07-15');
});

test('{{year}} resolves to current year', () => {
  assert.equal(resolveValue('{{year}}', { region: 'US', now: FIXED }), '2026');
});

test('numbers and unknown strings pass through', () => {
  assert.equal(resolveValue(213, { now: FIXED }), 213);
  assert.equal(resolveValue('popularity.desc', { now: FIXED }), 'popularity.desc');
});

test('resolveParams templates a whole params object', () => {
  const out = resolveParams(
    { with_watch_providers: 8, watch_region: '{{region}}', 'air_date.gte': '{{now-90d}}' },
    { region: 'GB', now: FIXED }
  );
  assert.deepEqual(out, {
    with_watch_providers: 8,
    watch_region: 'GB',
    'air_date.gte': '2026-03-17',
  });
});

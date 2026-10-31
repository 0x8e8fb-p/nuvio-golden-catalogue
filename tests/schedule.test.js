'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isActive, rotationPage, onThisWeekWindow, resolveName } = require('../src/lib/schedule');
const { buildManifest } = require('../src/manifest');
const { loadConfig } = require('../src/lib/config-loader');

// Fixed reference: 2026-06-15 is a Monday, 20:00 UTC.
const MON_EVENING = Date.UTC(2026, 5, 15, 20, 0, 0);
const SAT_NOON = Date.UTC(2026, 5, 13, 12, 0, 0); // Saturday
const DEC_DAY = Date.UTC(2026, 11, 10, 10, 0, 0); // December

test('isActive: no activeWhen means always active', () => {
  assert.equal(isActive({ name: 'x' }, MON_EVENING), true);
});

test('isActive: hours window (evening row)', () => {
  const row = { activeWhen: { hours: [17, 23] } };
  assert.equal(isActive(row, MON_EVENING), true);
  assert.equal(isActive(row, SAT_NOON), false);
});

test('isActive: hours window crossing midnight (late night)', () => {
  const row = { activeWhen: { hours: [23, 4] } };
  assert.equal(isActive(row, Date.UTC(2026, 5, 15, 2, 0, 0)), true); // 02:00
  assert.equal(isActive(row, Date.UTC(2026, 5, 15, 12, 0, 0)), false); // noon
});

test('isActive: weekday window (weekend only)', () => {
  const row = { activeWhen: { weekdays: [5, 6, 0] } };
  assert.equal(isActive(row, SAT_NOON), true); // Saturday
  assert.equal(isActive(row, MON_EVENING), false); // Monday
});

test('isActive: month window (December only)', () => {
  const row = { activeWhen: { months: [12] } };
  assert.equal(isActive(row, DEC_DAY), true);
  assert.equal(isActive(row, MON_EVENING), false);
});

test('rotationPage is stable within a day and changes across days', () => {
  const d1a = Date.UTC(2026, 5, 15, 2, 0, 0);
  const d1b = Date.UTC(2026, 5, 15, 22, 0, 0);
  const d2 = Date.UTC(2026, 5, 16, 2, 0, 0);
  assert.equal(rotationPage(d1a), rotationPage(d1b));
  assert.notEqual(rotationPage(d1a), rotationPage(d2));
  assert.ok(rotationPage(d1a) >= 1 && rotationPage(d1a) <= 15);
});

test('onThisWeekWindow returns a past-year date range', () => {
  const w = onThisWeekWindow(MON_EVENING);
  assert.ok(w.params['primary_release_date.gte'] < w.params['primary_release_date.lte']);
  assert.ok(Number(w.targetYear) < 2026);
});

test('resolveName applies partOfDay token', () => {
  const row = { name: 'x', dynamicName: 'Good {partOfDay}' };
  assert.equal(resolveName(row, MON_EVENING), 'Good Evening');
  assert.equal(resolveName(row, Date.UTC(2026, 5, 15, 8, 0, 0)), 'Good Morning');
  assert.equal(resolveName(row, Date.UTC(2026, 5, 15, 2, 0, 0)), 'Good Late Night');
});

test('manifest hides inactive time-aware rows and shows active ones', () => {
  const config = loadConfig({ fresh: true });
  // Saturday noon: weekend-epic active, weeknight-short inactive, tonight inactive (hours 17-23).
  const sat = buildManifest(config, { now: SAT_NOON, featuredOnly: false });
  const ids = sat.catalogs.map((c) => c.id);
  assert.ok(ids.includes('time-weekend-epic'), 'weekend row should show on Saturday');
  assert.ok(!ids.includes('time-weeknight-short'), 'weeknight row should hide on Saturday');
});

test('manifest uses dynamic name for the tonight row when active', () => {
  const config = loadConfig({ fresh: true });
  const m = buildManifest(config, { now: MON_EVENING, featuredOnly: false });
  const tonight = m.catalogs.find((c) => c.id === 'time-tonight');
  assert.ok(tonight, 'tonight row active Monday evening');
  assert.equal(tonight.name, 'Good Evening');
});

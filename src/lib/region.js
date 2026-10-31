'use strict';

/**
 * Region data: which streaming services exist in a country, their TMDB
 * watch-provider ids there, and how strongly Indian titles are mixed into
 * general rows for that region.
 *
 * Source of truth: data/providers.json (verified ids per region). A region
 * that is not listed falls back to the "_default" tables.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'providers.json'), 'utf8')
);

/** Marker returned by templating when a region lacks a service. */
const UNAVAILABLE = '__unavailable__';

/**
 * Normalise a country code to two upper-case letters, or null.
 * @param {string} cc
 * @returns {string|null}
 */
function normalizeRegion(cc) {
  if (typeof cc !== 'string') return null;
  const v = cc.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/**
 * The region used when a request does not name one: DEFAULT_REGION env, then
 * the config default, then US.
 * @param {{defaults?: {region?: string}}} [config]
 */
function defaultRegion(config) {
  return (
    normalizeRegion(process.env.DEFAULT_REGION) ||
    normalizeRegion(config && config.defaults && config.defaults.region) ||
    'US'
  );
}

function regionTable(region) {
  return DATA.regions[region] || DATA.regions._default;
}

/**
 * TMDB watch-provider ids for a brand in a region ("8", "2303|2616"), or null
 * when the service is not offered there.
 * @param {string} brandKey e.g. "netflix"
 * @param {string} region e.g. "IN"
 */
function providerIds(brandKey, region) {
  const ids = regionTable(region)[brandKey];
  return ids ? String(ids) : null;
}

/** Display data for a brand: { name, network?, logo? }. */
function brandInfo(brandKey) {
  return DATA.brands[brandKey] || null;
}

/** Brand keys that count as the region's major services. */
function majorBrands(region) {
  const list = DATA.major[region] || DATA.major._default;
  return list.filter((b) => providerIds(b, region));
}

/** Pipe-joined provider ids of the region's major services. */
function majorProviderIds(region) {
  const ids = new Set();
  for (const b of majorBrands(region)) {
    for (const id of providerIds(b, region).split('|')) ids.add(id);
  }
  return [...ids].join('|');
}

/** Human name for a region, e.g. "India". */
function regionName(region) {
  return (DATA.regionNames && DATA.regionNames[region]) || region;
}

/** IANA time zone used for a region's time-aware rows, e.g. "Asia/Kolkata". */
function regionTimeZone(region) {
  const zones = DATA.timeZones || {};
  return (region && zones[region]) || 'UTC';
}

/** Regions with their own provider table (for the configure page). */
function knownRegions() {
  return Object.keys(DATA.regions).filter((r) => r !== '_default');
}

module.exports = {
  UNAVAILABLE,
  normalizeRegion,
  defaultRegion,
  providerIds,
  brandInfo,
  majorBrands,
  majorProviderIds,
  regionName,
  regionTimeZone,
  knownRegions,
};

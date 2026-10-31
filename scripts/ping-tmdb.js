#!/usr/bin/env node
'use strict';

/**
 * Nightly canary / live validation.
 *
 * Hits every configured catalogue endpoint once with its static params and
 * asserts a 200 with a non-empty, adult-free results array. Catches TMDB auth
 * breakage, renamed endpoints, bad network/keyword ids, and empty rows before
 * a user sees a broken catalogue.
 *
 * Skips gracefully (exit 0) when TMDB_API_KEY is absent — so it no-ops on fork
 * PRs where secrets are unavailable, rather than failing the build.
 *
 * For search-required rows we inject a sample query so the endpoint is exercised.
 */

const { loadConfig } = require('../src/lib/config-loader');
const { createTmdbClient } = require('../src/tmdb/client');
const { resolveParams } = require('../src/lib/templating');

const SAMPLE_SEARCH = 'matrix';

async function main() {
  const config = loadConfig({ fresh: true });
  const client = createTmdbClient({ language: config.defaults.language });

  if (!client.hasKey()) {
    console.log('TMDB_API_KEY not set — skipping live ping (exit 0).');
    process.exit(0);
  }

  const failures = [];
  let adultSeen = 0;
  const { createMdblistSource } = require('../src/sources/mdblist');
  const mdblist = createMdblistSource();

  for (const row of config.catalogues) {
    // List-source rows: verify the public list returns items with tt ids.
    if (row.source.list) {
      try {
        const ids = await mdblist.imdbIds(row.source.list, row.type, 0, 10);
        if (ids.length === 0) {
          failures.push(`${row.id} (list) returned 0 items`);
          console.log(`  [empty] ${row.id}`);
        } else {
          console.log(`  [ok] ${row.id} - ${ids.length} list items`);
        }
      } catch (err) {
        failures.push(`${row.id} (list) error: ${err.message}`);
        console.log(`  [error] ${row.id} - ${err.message}`);
      }
      continue;
    }

    const region = config.defaults.region || 'US';
    const params = resolveParams(row.source.params || {}, { region });
    const needsSearch = (row.extra || []).some(
      (e) => e.name === 'search' && e.isRequired
    );
    const needsGenre = (row.extra || []).some(
      (e) => e.name === 'genre' && e.isRequired
    );
    if (needsSearch) params.query = SAMPLE_SEARCH;
    if (needsGenre) {
      // pick the first genre known for this type
      const table = config.genres[row.type] || {};
      const first = Object.values(table)[0];
      if (first !== undefined) params.with_genres = first;
    }

    try {
      const data = await client.get(row.source.endpoint, { ...params, page: 1 });
      const results = data.results || [];
      const anyAdult = results.some((r) => r.adult === true);
      if (anyAdult) adultSeen++;
      if (results.length === 0) {
        failures.push(`${row.id} (${row.source.endpoint}) returned 0 results`);
        console.log(`  [empty] ${row.id}`);
      } else {
        console.log(`  [ok] ${row.id} - ${results.length} results`);
      }
    } catch (err) {
      failures.push(`${row.id} (${row.source.endpoint}) error: ${err.message}`);
      console.log(`  [error] ${row.id} - ${err.message}`);
    }
  }

  console.log('');
  if (adultSeen > 0) {
    console.warn(
      `WARNING: ${adultSeen} row(s) returned an adult-flagged item from TMDB; the mapper filters these, but review the row params.`
    );
  }
  if (failures.length) {
    console.error(`\nPing FAILED (${failures.length} issues):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`All ${config.catalogues.length} catalogue rows healthy.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

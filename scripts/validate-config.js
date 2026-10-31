#!/usr/bin/env node
'use strict';

/**
 * Standalone config validator (no network). Used by `npm run validate:config`
 * and by CI. Exits 0 when the golden config is valid, 1 with a clear report
 * otherwise.
 */

const { loadConfig, ConfigError } = require('../src/lib/config-loader');
const { buildManifest } = require('../src/manifest');

const MANIFEST_LIMIT = 8192; // SDK addonCollection hard limit

try {
  const config = loadConfig({ fresh: true });
  const rows = config.catalogues.length;

  // Guard: the compiled manifest must stay under the SDK's 8KB limit — checked
  // at WORST CASE (all time-aware rows active at once), since activeWhen means
  // the live manifest size varies with the clock.
  const worstCase = Object.assign({}, config, {
    catalogues: config.catalogues.map((c) => {
      const clone = Object.assign({}, c);
      delete clone.activeWhen;
      return clone;
    }),
  });
  const manifest = buildManifest(worstCase);
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  if (bytes >= MANIFEST_LIMIT) {
    console.error(
      `\nConfig validation FAILED:\n  - compiled manifest is ${bytes} bytes, exceeding the ${MANIFEST_LIMIT}-byte SDK limit.\n    Trim row names/description, or split rows into a second addon instance.\n`
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `OK: catalogue.config.json is valid (${rows} rows, manifest ${bytes}/${MANIFEST_LIMIT} bytes).`
  );
  for (const c of config.catalogues) {
    // eslint-disable-next-line no-console
    console.log(`  ${String(c.order ?? '-').padStart(3)}  [${c.type}] ${c.id} — ${c.name}`);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) {
    // eslint-disable-next-line no-console
    console.error(`\nConfig validation FAILED:\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

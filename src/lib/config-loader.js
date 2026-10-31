'use strict';

/**
 * Loads and validates the golden config (data/catalogue.config.json) against
 * the JSON Schema (schema/catalogue.schema.json). Fails loudly with clear,
 * aggregated messages so a bad edit is caught at boot and in CI rather than
 * surfacing as a broken row on the TV.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'catalogue.config.json');
const SCHEMA_PATH = path.join(ROOT, 'schema', 'catalogue.schema.json');
const GENRES_PATH = path.join(ROOT, 'data', 'genres.json');

class ConfigError extends Error {}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read ${path.relative(ROOT, file)}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${path.relative(ROOT, file)}: ${err.message}`);
  }
}

function formatAjvErrors(errors) {
  return (errors || [])
    .map((e) => {
      const where = e.instancePath || '(root)';
      return `  - ${where} ${e.message}${
        e.params && e.params.allowedValues
          ? ` (allowed: ${e.params.allowedValues.join(', ')})`
          : ''
      }`;
    })
    .join('\n');
}

/**
 * Validates semantic rules the JSON Schema cannot express.
 * Returns an array of human-readable error strings (empty if valid).
 */
function semanticErrors(config, genres) {
  const errors = [];
  const seen = new Set();

  for (const [i, cat] of config.catalogues.entries()) {
    const label = `catalogues[${i}] (${cat.id || 'no-id'})`;

    // 1. Unique ids.
    if (cat.id) {
      if (seen.has(cat.id)) {
        errors.push(`${label}: duplicate id "${cat.id}"`);
      }
      seen.add(cat.id);
    }

    // 2. Genre options must resolve in the lookup table for this type.
    const genreExtra = (cat.extra || []).find((x) => x.name === 'genre');
    if (genreExtra && genreExtra.options) {
      const table = genres[cat.type] || {};
      for (const opt of genreExtra.options) {
        if (!(opt in table)) {
          errors.push(
            `${label}: genre option "${opt}" is not in the ${cat.type} genre table (data/genres.json)`
          );
        }
      }
    }
  }

  return errors;
}

let cached = null;

/**
 * Load + validate the config. Throws ConfigError with an aggregated message on
 * any problem. Result is cached for the process lifetime.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] bypass the cache (used by tests/CLI)
 */
function loadConfig(opts = {}) {
  if (cached && !opts.fresh) return cached;

  const schema = readJson(SCHEMA_PATH);
  const config = readJson(CONFIG_PATH);
  const genres = readJson(GENRES_PATH);

  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(config)) {
    throw new ConfigError(
      `catalogue.config.json failed schema validation:\n${formatAjvErrors(validate.errors)}`
    );
  }

  const semErrors = semanticErrors(config, genres);
  if (semErrors.length) {
    throw new ConfigError(
      `catalogue.config.json failed validation:\n${semErrors.map((e) => `  - ${e}`).join('\n')}`
    );
  }

  // Normalise defaults.
  const defaults = Object.assign(
    { language: 'en-US', region: 'US', posterShape: 'poster', pageSize: 20 },
    config.defaults || {}
  );

  // Sort rows by order (undefined orders keep their array position, after
  // ordered ones), so downstream code can rely on catalogue order.
  const sorted = config.catalogues
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => {
      const ao = a.c.order ?? Number.POSITIVE_INFINITY;
      const bo = b.c.order ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return a.idx - b.idx;
    })
    .map(({ c }) => c);

  cached = {
    addon: config.addon,
    defaults,
    catalogues: sorted,
    genres,
  };
  return cached;
}

module.exports = { loadConfig, ConfigError, CONFIG_PATH, SCHEMA_PATH, GENRES_PATH };

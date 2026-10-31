'use strict';

/**
 * One TMDB client per process.
 *
 * Every handler (catalogs, meta, artwork) shares this client, so its response
 * cache, stale-on-error store and circuit breaker are actually reused between
 * requests on a warm serverless instance. The client is rebuilt only if the
 * TMDB_API_KEY environment variable changes (tests flip it).
 */

const { createTmdbClient } = require('./client');

let shared = null;
let sharedKey = null;

/** @returns {ReturnType<typeof createTmdbClient>} */
function getTmdbClient() {
  const key = process.env.TMDB_API_KEY || '';
  if (!shared || sharedKey !== key) {
    shared = createTmdbClient({
      apiKey: key || undefined,
      language: process.env.TMDB_LANGUAGE || 'en-US',
    });
    sharedKey = key;
  }
  return shared;
}

module.exports = { getTmdbClient };

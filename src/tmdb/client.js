'use strict';

/**
 * Minimal TMDB API v3 client.
 *
 * - API key from env (TMDB_API_KEY). Never logged.
 * - Always forces include_adult=false (defence in depth; the mapper also
 *   filters, and we exclude adult genres in the config).
 * - In-memory TTL cache to stay well under TMDB rate limits and keep the
 *   catalogue snappy on the TV.
 * - Small retry with backoff on 429/5xx.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const { TtlLruCache } = require('../lib/cache');
const { CircuitBreaker } = require('../lib/circuit-breaker');

// Image CDN base + sensible sizes. Posters portrait, backdrops wide.
const IMG_BASE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

function imageUrl(pathPart, size) {
  if (!pathPart) return undefined;
  return `${IMG_BASE}/${size}${pathPart}`;
}

const posterUrl = (p) => imageUrl(p, POSTER_SIZE);
const backdropUrl = (p) => imageUrl(p, BACKDROP_SIZE);

/**
 * Build an RPDB poster URL (ratings badge baked onto the poster) for a tt id.
 * Returns undefined when no RPDB key is configured. Free-tier keys exist, e.g.
 * t0-free-rpdb (see README).
 */
function rpdbPosterUrl(rpdbKey, imdbId) {
  if (!rpdbKey || !imdbId) return undefined;
  return `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
}

function createTmdbClient(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TMDB_API_KEY;
  const language = opts.language ?? process.env.TMDB_LANGUAGE ?? 'en-US';
  // TMDB_API_BASE lets tests and local runs point at a mock server.
  const apiBase = String(opts.baseUrl || process.env.TMDB_API_BASE || TMDB_BASE).replace(/\/+$/, '');
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const rpdbKey = opts.rpdbKey ?? process.env.RPDB_API_KEY ?? null;

  const cache = opts.cache || new TtlLruCache({ ttl, max: opts.cacheMax || 2000 });
  // A long-lived "stale" store: last-known-good responses served when the live
  // fetch fails or the breaker is open, so a TMDB blip never empties a row.
  const staleTtl = opts.staleTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  const stale = opts.staleCache || new TtlLruCache({ ttl: staleTtl, max: opts.cacheMax || 2000 });
  const breaker = opts.breaker || new CircuitBreaker({
    threshold: opts.breakerThreshold || 5,
    cooldownMs: opts.breakerCooldownMs || 30 * 1000,
  });

  function hasKey() {
    return Boolean(apiKey);
  }

  function buildUrl(endpoint, params = {}) {
    const url = new URL(apiBase + endpoint);
    url.searchParams.set('api_key', apiKey);
    // language: null omits the parameter (image endpoints filter by it).
    if (params.language !== null) url.searchParams.set('language', params.language || language);
    url.searchParams.set('include_adult', 'false');
    for (const [k, v] of Object.entries(params)) {
      if (k === 'language' || v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    return url;
  }

  async function get(endpoint, params = {}) {
    if (!apiKey) {
      const err = new Error('TMDB_API_KEY is not set');
      err.code = 'NO_TMDB_KEY';
      throw err;
    }

    const url = buildUrl(endpoint, params);
    const cacheKey = url.toString();

    const cachedValue = cache.get(cacheKey);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    // Circuit open: skip the network, serve stale if we have it.
    if (!breaker.canRequest()) {
      const staleValue = stale.get(cacheKey);
      if (staleValue !== undefined) return staleValue;
      const err = new Error('TMDB circuit open and no stale data');
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetchImpl(cacheKey, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network error or timeout: worth another try.
        lastErr = err;
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`TMDB ${res.status}`);
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        // 4xx other than 429 (an unknown id, a removed title): the request is
        // wrong, TMDB is fine. No retry, and the breaker is left alone.
        const err = new Error(`TMDB request failed: ${res.status} ${endpoint}`);
        err.status = res.status;
        throw err;
      }
      try {
        const value = await res.json();
        cache.set(cacheKey, value);
        stale.set(cacheKey, value); // refresh last-known-good
        breaker.recordSuccess();
        return value;
      } catch (err) {
        lastErr = err; // truncated or invalid body
        await sleep(250 * (attempt + 1));
      }
    }

    // All attempts failed: trip the breaker and serve stale if available.
    breaker.recordFailure();
    const staleValue = stale.get(cacheKey);
    if (staleValue !== undefined) return staleValue;
    throw lastErr || new Error('TMDB request failed');
  }

  return {
    hasKey,
    get,
    buildUrl, // exposed for the nightly ping / tests (contains the key — never log)
    language,
    rpdbKey,
    cacheStats: () => (cache.stats ? cache.stats() : null),
    breakerStats: () => (breaker.stats ? breaker.stats() : null),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  createTmdbClient,
  posterUrl,
  backdropUrl,
  rpdbPosterUrl,
  imageUrl,
  TMDB_BASE,
  IMG_BASE,
};

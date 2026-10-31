'use strict';

/**
 * Minimal TMDB API v3 client.
 *
 * - API key from env (TMDB_API_KEY). Never logged.
 * - Always forces include_adult=false (defence in depth; the mapper also
 *   filters, and we exclude adult genres in the config).
 * - In-memory TTL cache to stay well under TMDB rate limits and keep the
 *   catalogue snappy on the TV, a long-lived stale copy served when TMDB
 *   fails, and a circuit breaker.
 * - At most `maxConcurrent` requests in flight per process, and concurrent
 *   requests for the same URL share one fetch. A cold home screen asks for
 *   hundreds of records at once (one IMDb id lookup per title), TMDB allows
 *   about 20 connections per IP, and serverless instances share outbound IPs,
 *   so extra requests wait for a free slot instead of drawing 429s.
 * - Small retry with backoff on 429/5xx (honouring Retry-After, capped) and on
 *   network errors; no retry on other 4xx.
 */

const TMDB_BASE = 'https://api.themoviedb.org/3';
const { TtlLruCache } = require('../lib/cache');
const { CircuitBreaker } = require('../lib/circuit-breaker');

// Image CDN base + sensible sizes. Posters portrait, backdrops wide.
const IMG_BASE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_CONCURRENT = 12; // below TMDB's ~20 connections per IP
const MAX_RETRY_AFTER_MS = 3000;

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

/** Free a response body that will not be read, so its connection can be reused. */
function discard(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  } catch {
    // nothing to free
  }
}

/** Back-off a 429 or 5xx asks for (Retry-After, in seconds), capped; 0 when absent. */
function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const seconds = Number(raw);
  return raw !== null && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
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
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
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

  // One slot per request in flight. A freed slot passes straight to the next
  // waiting request, so the limit holds exactly.
  let active = 0;
  const waiting = [];
  function acquire() {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  const inflight = new Map(); // url -> Promise of the response, while a fetch runs

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

  /**
   * One request to TMDB, inside a slot. The slot is held only while the
   * request runs, never during a back-off.
   * @returns {Promise<{ok: true, value: any}|{retry: Error, waitMs?: number}|{fail: Error}>}
   */
  async function attempt(endpoint, url) {
    await acquire();
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { retry: err }; // network error or timeout: worth another try
      }
      if (res.status === 429 || res.status >= 500) {
        discard(res);
        return { retry: new Error(`TMDB ${res.status}`), waitMs: retryAfterMs(res) };
      }
      if (!res.ok) {
        discard(res);
        // 4xx other than 429 (an unknown id, a removed title): the request is
        // wrong, TMDB is fine. No retry, and the breaker is left alone.
        const err = new Error(`TMDB request failed: ${res.status} ${endpoint}`);
        err.status = res.status;
        return { fail: err };
      }
      try {
        return { ok: true, value: await res.json() };
      } catch (err) {
        return { retry: err }; // truncated or invalid body
      }
    } finally {
      release();
    }
  }

  async function fetchLive(endpoint, url) {
    // Circuit open: skip the network, serve stale if we have it.
    if (!breaker.canRequest()) {
      const staleValue = stale.get(url);
      if (staleValue !== undefined) return staleValue;
      const err = new Error('TMDB circuit open and no stale data');
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    let lastErr;
    let wait = 0;
    for (let i = 0; i <= maxRetries; i++) {
      if (i > 0) await sleep(wait);
      const out = await attempt(endpoint, url);
      if (out.ok) {
        cache.set(url, out.value);
        stale.set(url, out.value); // refresh last-known-good
        breaker.recordSuccess();
        return out.value;
      }
      if (out.fail) throw out.fail;
      lastErr = out.retry;
      wait = out.waitMs || 250 * (i + 1);
    }

    // All attempts failed: trip the breaker and serve stale if available.
    breaker.recordFailure();
    const staleValue = stale.get(url);
    if (staleValue !== undefined) return staleValue;
    throw lastErr || new Error('TMDB request failed');
  }

  async function get(endpoint, params = {}) {
    if (!apiKey) {
      const err = new Error('TMDB_API_KEY is not set');
      err.code = 'NO_TMDB_KEY';
      throw err;
    }

    const url = buildUrl(endpoint, params).toString();
    const cachedValue = cache.get(url);
    if (cachedValue !== undefined) return cachedValue;

    // A title shown in three rows at once is looked up once.
    const pending = inflight.get(url);
    if (pending) return pending;
    const task = fetchLive(endpoint, url);
    inflight.set(url, task);
    try {
      return await task;
    } finally {
      inflight.delete(url);
    }
  }

  return {
    hasKey,
    get,
    buildUrl, // exposed for the nightly ping / tests (contains the key, never log)
    language,
    rpdbKey,
    cacheStats: () => (cache.stats ? cache.stats() : null),
    breakerStats: () => (breaker.stats ? breaker.stats() : null),
    queueStats: () => ({ active, waiting: waiting.length, max: maxConcurrent }),
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

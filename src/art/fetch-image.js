'use strict';

/**
 * Downloads source images from TMDB's image CDN for the renderer.
 *
 * - Only image.tmdb.org paths are accepted (a strict path pattern), so the
 *   art endpoints cannot be used to fetch arbitrary URLs.
 * - A byte-bounded LRU keeps recently used images on a warm instance; folder
 *   art and tiles share backdrops, so this saves most downloads.
 * - Concurrent requests for the same image share one download.
 * - Every failure (timeout, 404, bad path) resolves to null; the renderer then
 *   treats that input as missing.
 */

const IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p').replace(/\/+$/, '');
const SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'original']);
const PATH_RE = /^\/[A-Za-z0-9_-]{4,64}\.(?:jpe?g|png|svg|webp)$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ITEM = 6 * 1024 * 1024;

const cache = new Map(); // key -> Buffer (insertion order = LRU order)
let cachedBytes = 0;
const inflight = new Map();

/** Is this a plausible TMDB image file path, e.g. "/abc123.jpg"? */
function isImagePath(p) {
  return typeof p === 'string' && PATH_RE.test(p);
}

function remember(key, buf) {
  if (cache.has(key)) {
    cachedBytes -= cache.get(key).length;
    cache.delete(key);
  }
  cache.set(key, buf);
  cachedBytes += buf.length;
  while (cachedBytes > MAX_BYTES && cache.size) {
    const [oldKey, oldBuf] = cache.entries().next().value;
    cache.delete(oldKey);
    cachedBytes -= oldBuf.length;
  }
}

/**
 * Fetch one TMDB image. SVG paths are requested as PNG (TMDB renders them).
 * @param {string} size e.g. "w780"
 * @param {string} filePath e.g. "/abc.jpg"
 * @param {{timeoutMs?: number, fetch?: Function}} [opts]
 * @returns {Promise<Buffer|null>}
 */
async function fetchTmdbImage(size, filePath, opts = {}) {
  if (!SIZES.has(size) || !isImagePath(filePath)) return null;
  const pathPng = filePath.replace(/\.svg$/i, '.png');
  const key = `${size}${pathPng}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (inflight.has(key)) return inflight.get(key);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const task = (async () => {
    try {
      const res = await fetchImpl(`${IMAGE_BASE}/${size}${pathPng}`, {
        signal: AbortSignal.timeout(opts.timeoutMs || 3500),
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_ITEM) return null;
      remember(key, buf);
      return buf;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/** Public TMDB image URL (no download). */
function tmdbImageUrl(size, filePath) {
  if (!isImagePath(filePath)) return undefined;
  return `https://image.tmdb.org/t/p/${size}${filePath.replace(/\.svg$/i, '.png')}`;
}

function cacheStats() {
  return { images: cache.size, bytes: cachedBytes };
}

module.exports = { fetchTmdbImage, tmdbImageUrl, isImagePath, cacheStats };

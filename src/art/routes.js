'use strict';

/**
 * HTTP routes that render and serve artwork.
 *
 *   GET /art/tile.jpg?t&id&b&p&n&ol&v&s   signed: 16:9 title tile (backdrop or poster, plus logo)
 *   GET /art/rank.jpg?r&p&b&v&s           signed: Top 10 tile
 *   GET /art/logo.png?t&id&ol&v&s         signed: redirect to the best TMDB title logo
 *   GET /art/folder/:region/:key/cover.jpg?v&shape   collection folder cover
 *   GET /art/folder/:region/:key/focus.webp?v&shape  animated focus loop (GIF below Android 9)
 *   GET /art/folder/:region/:key/hero.jpg?v          hero still (frame 0 of the hero video)
 *   GET /art/folder/:region/:key/hero.mp4?v          hero video in the folder's signature motion
 *                                                    (H.264, Range requests answered)
 *   GET /art/folder/:region/:key/logo.png?v          transparent folder title logo (home hero)
 *   GET /art/collection/:region/:id/backdrop.jpg?v   a collection's own backdrop
 *   GET /art/candidates/:region/:key.json            a tile's candidate titles, for the art plan
 *
 * Images are long-lived on Vercel's CDN (s-maxage), and rendered results are
 * also kept in a small in-memory cache for warm instances. Any failure while
 * gathering inputs still yields a valid image, so a tile never shows broken.
 * Such a degraded image is cached only briefly and is not kept in memory, so a
 * later request tries the failed input again.
 */

const crypto = require('node:crypto');
const express = require('express');
const { verify } = require('./sign');
const { getTmdbClient } = require('../tmdb/shared');
const { fetchTmdbImage, isImagePath } = require('./fetch-image');
const { bestLogo } = require('./logos');
const { findFolder, folderArtInputs, folderLogo, artCandidates, sampleItems } = require('./folder-art');
const { regionFolders } = require('../collections/engine');
const { collectionPlan, plannedPaths } = require('./plan');
const { normalizeRegion } = require('../lib/region');
const { videoEnabled, encodeHeroVideo } = require('./video');

const ITEM_CACHE = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800';
const FOLDER_CACHE = 'public, max-age=21600, s-maxage=86400, stale-while-revalidate=604800';
// Drawn without an input that failed to load: short, so the CDN asks again soon.
const DEGRADED_CACHE = 'public, max-age=60, s-maxage=300';
const REDIRECT_CACHE = 'public, max-age=86400';
const SHAPES = new Set(['landscape', 'poster', 'square']);
const FOLDER_FILES = new Set(['cover.jpg', 'focus.webp', 'focus.gif', 'hero.jpg', 'hero.mp4', 'logo.png']);
const SHAPED_FILES = new Set(['cover.jpg', 'focus.webp', 'focus.gif']);

/**
 * LRU cache for rendered images, bounded by total bytes and by entry count,
 * with a TTL. A focus GIF can be over 1 MB, so a count alone does not bound
 * memory.
 */
class RenderCache {
  /**
   * @param {{maxBytes: number, maxEntries: number, maxItemBytes: number, ttlMs: number}} opts
   *   maxItemBytes: larger buffers are not cached at all
   */
  constructor({ maxBytes, maxEntries, maxItemBytes, ttlMs }) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.maxItemBytes = maxItemBytes;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { buf, expires }; Map order is least to most recently used
    this.bytes = 0;
  }

  /** The cached buffer, or undefined. A hit becomes the most recently used entry. */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.buf;
  }

  /** Store a buffer, evicting least recently used entries until both bounds hold. */
  set(key, buf) {
    this.delete(key);
    if (!Buffer.isBuffer(buf) || buf.length > this.maxItemBytes) return;
    this.map.set(key, { buf, expires: Date.now() + this.ttlMs });
    this.bytes += buf.length;
    while (this.map.size && (this.map.size > this.maxEntries || this.bytes > this.maxBytes)) {
      this.delete(this.map.keys().next().value);
    }
  }

  /** Remove an entry, if present. */
  delete(key) {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.bytes -= entry.buf.length;
  }

  get size() {
    return this.map.size;
  }
}

const rendered = new RenderCache({
  maxBytes: 48 * 1024 * 1024,
  maxEntries: 300,
  maxItemBytes: 8 * 1024 * 1024,
  ttlMs: 60 * 60 * 1000,
});
const inflight = new Map();

let renderer = null;
function render() {
  if (!renderer) renderer = require('./render');
  return renderer;
}
let motionModule = null;
function motion() {
  if (!motionModule) motionModule = require('./motion');
  return motionModule;
}

/**
 * Render once per key at a time. A complete render is kept in memory; a
 * degraded one is returned but not kept, so the next request retries it.
 * @param {string} key
 * @param {() => Promise<{buf: Buffer, degraded: boolean}>} fn
 * @returns {Promise<{buf: Buffer, degraded: boolean}>}
 */
async function cachedRender(key, fn) {
  const hit = rendered.get(key);
  if (hit) return { buf: hit, degraded: false };
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    try {
      const out = await fn();
      if (!out.degraded) rendered.set(key, out.buf);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

function send(res, out, type, cacheControl) {
  res.set('content-type', type);
  res.set('cache-control', out.degraded ? DEGRADED_CACHE : cacheControl);
  res.set('access-control-allow-origin', '*');
  res.send(out.buf);
}

// Strong ETags per video buffer, so 206 parts carry the ETag of the whole file.
const etags = new WeakMap();
function etagOf(buf) {
  let tag = etags.get(buf);
  if (!tag) {
    tag = `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 27)}"`;
    etags.set(buf, tag);
  }
  return tag;
}

/**
 * Send a video, answering a single byte range with 206 (players seek and resume with
 * Range requests). A whole-file 200 is what the CDN keeps.
 */
function sendVideo(req, res, out, cacheControl) {
  const buf = out.buf;
  const total = buf.length;
  res.set('content-type', 'video/mp4');
  res.set('accept-ranges', 'bytes');
  res.set('cache-control', out.degraded ? DEGRADED_CACHE : cacheControl);
  res.set('access-control-allow-origin', '*');
  res.set('etag', etagOf(buf));
  const header = req.headers.range;
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(String(header).trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) {
    res.send(buf);
    return;
  }
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!(start <= end) || start >= total) {
    res.status(416).set('content-range', `bytes */${total}`).end();
    return;
  }
  res.status(206).set('content-range', `bytes ${start}-${end}/${total}`);
  res.send(buf.subarray(start, end + 1));
}

function failure(res, err) {
  if (res.headersSent) return; // a response is already on its way; a second one would throw
  if (err && err.code === 'SHARP_UNAVAILABLE') {
    res.status(503).set('cache-control', 'no-store').json({ err: 'image renderer unavailable' });
    return;
  }
  if (err && err.code === 'FFMPEG_UNAVAILABLE') {
    res.status(503).set('cache-control', 'no-store').json({ err: 'video encoder unavailable' });
    return;
  }
  res.status(500).set('cache-control', 'no-store').json({ err: 'render failed' });
}

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
};
const toLang = (v) => (/^[a-z]{2}$/.test(String(v || '')) ? String(v) : undefined);

/** A valid image path whose download failed: the image was drawn without it. */
const missing = (path, buf) => isImagePath(path) && !buf;

/**
 * Canonical query for folder art: `v` as given and, for covers and focus loops,
 * a valid `shape`. The CDN cache key includes the query string, so any other
 * parameter would force a fresh render.
 * @param {string} file e.g. "cover.jpg"
 * @param {URLSearchParams} given the request's query
 * @returns {string|null} query to redirect to, or null when `given` is already canonical
 */
function canonicalFolderQuery(file, given) {
  const keep = new URLSearchParams();
  if (given.has('v')) keep.set('v', given.get('v'));
  if (SHAPED_FILES.has(file) && SHAPES.has(given.get('shape'))) keep.set('shape', given.get('shape'));
  // Every entry is kept unless it is another key, a repeat or an invalid shape.
  // Key order alone does not change the rendered image, so it is left alone.
  return given.size === keep.size ? null : keep.toString();
}

/**
 * Path (with the mount prefix) and raw query string of a request. The path comes
 * from the parsed URL, never a client-sent host, so a redirect stays on this site.
 */
function splitUrl(req) {
  const i = req.url.indexOf('?');
  return [`${req.baseUrl}${req.path}`, i < 0 ? '' : req.url.slice(i + 1)];
}

/**
 * Transparent title logo for a folder: the brand logo prepared for dark art,
 * else the folder name as a wordmark.
 * @param {object} folder
 * @returns {Promise<{buf: Buffer, degraded: boolean}>}
 */
async function folderLogoImage(folder) {
  const brand = await folderLogo(folder);
  const buf = brand.path ? await fetchTmdbImage('w500', brand.path) : null;
  const logo = buf ? await render().normalizeLogo(buf, { maxWidth: 1200, maxHeight: 480 }) : null;
  const degraded = !brand.ok || missing(brand.path, buf);
  if (logo) return { buf: logo.png, degraded };
  // No logo, an unusable one (an opaque box) or a failed download.
  const wordmark = await render().renderWordmark(folder.art.wordmark, { height: 180, maxWidth: 1200 });
  return { buf: wordmark, degraded };
}

/**
 * Express router for the artwork routes, to be mounted at /art.
 * @returns {import('express').Router}
 */
function createArtRouter() {
  const router = express.Router();

  // Every signed route checks the signature before doing any work. The router
  // is mounted at /art, so the signed path is "/art" plus the route path.
  function signed(req, res, next) {
    if (!verify(`/art${req.path}`, req.query)) {
      res.status(403).set('cache-control', 'no-store').json({ err: 'invalid signature' });
      return;
    }
    next();
  }

  router.get('/tile.jpg', signed, async (req, res) => {
    try {
      const { t, b, p, n } = req.query;
      const id = toId(req.query.id);
      const ol = toLang(req.query.ol);
      const type = t === 'series' ? 'tv' : 'movie';
      const out = await cachedRender(`tile:${type}:${id}:${b}:${p}:${ol}`, async () => {
        const [backdrop, poster, found] = await Promise.all([
          isImagePath(b) ? fetchTmdbImage('w1280', b) : null,
          isImagePath(p) ? fetchTmdbImage('w500', p) : null,
          id ? bestLogo(getTmdbClient(), type, id, ol) : { path: null, ok: true },
        ]);
        const logo = found.path ? await fetchTmdbImage('w500', found.path) : null;
        const buf = await render().renderTile({ backdrop, poster, logo, title: String(n || '').slice(0, 80) });
        const degraded = missing(b, backdrop) || missing(p, poster) || !found.ok || missing(found.path, logo);
        return { buf, degraded };
      });
      send(res, out, 'image/jpeg', ITEM_CACHE);
    } catch (err) {
      failure(res, err);
    }
  });

  router.get('/rank.jpg', signed, async (req, res) => {
    try {
      const rank = toId(req.query.r);
      const { p, b } = req.query;
      const out = await cachedRender(`rank:${rank}:${p}:${b}`, async () => {
        const [poster, backdrop] = await Promise.all([
          isImagePath(p) ? fetchTmdbImage('w500', p) : null,
          isImagePath(b) ? fetchTmdbImage('w780', b) : null,
        ]);
        const buf = await render().renderRankTile({ rank, poster, backdrop });
        return { buf, degraded: missing(p, poster) || missing(b, backdrop) };
      });
      send(res, out, 'image/jpeg', ITEM_CACHE);
    } catch (err) {
      failure(res, err);
    }
  });

  router.get('/logo.png', signed, async (req, res) => {
    try {
      const id = toId(req.query.id);
      const type = req.query.t === 'series' ? 'tv' : 'movie';
      const found = id ? await bestLogo(getTmdbClient(), type, id, toLang(req.query.ol)) : { path: null, ok: true };
      if (!found.ok) {
        // The lookup failed, so the answer may differ next time: nobody may keep it.
        res.status(404).set('cache-control', 'no-store').json({ err: 'logo lookup failed' });
        return;
      }
      if (!found.path) {
        res.status(404).set('cache-control', 'public, max-age=86400, s-maxage=604800').json({ err: 'no logo' });
        return;
      }
      res.set('cache-control', 'public, max-age=86400, s-maxage=2592000');
      res.redirect(302, `https://image.tmdb.org/t/p/w500${found.path}`);
    } catch (err) {
      failure(res, err);
    }
  });

  router.get('/folder/:region/:key/:file', async (req, res) => {
    try {
      const region = normalizeRegion(req.params.region);
      const folder = region ? findFolder(region, String(req.params.key)) : null;
      if (!folder) {
        res.status(404).set('cache-control', 'public, max-age=300').json({ err: 'unknown folder' });
        return;
      }
      const file = req.params.file;
      if (!FOLDER_FILES.has(file)) {
        res.status(404).json({ err: 'unknown art file' });
        return;
      }
      const [path, rawQuery] = splitUrl(req);
      const query = new URLSearchParams(rawQuery);
      const target = canonicalFolderQuery(file, query);
      if (target !== null) {
        res.set('cache-control', REDIRECT_CACHE);
        res.redirect(301, target ? `${path}?${target}` : path);
        return;
      }
      const shape = SHAPES.has(query.get('shape')) ? query.get('shape') : folder.shape;

      if (file === 'cover.jpg') {
        const out = await cachedRender(`cover:${region}:${folder.key}:${shape}`, async () => {
          const { degraded, ...input } = await folderArtInputs(region, folder, 'cover', { shape });
          const family = motion().familyFor(folder);
          const buf = await motion().renderMotionCover({ shape, ...input, wordmark: folder.art.wordmark, brand: folder.art.brand, family });
          return { buf, degraded };
        });
        send(res, out, 'image/jpeg', FOLDER_CACHE);
        return;
      }
      if (file === 'focus.webp' || file === 'focus.gif') {
        const format = file.endsWith('.gif') ? 'gif' : 'webp';
        const out = await cachedRender(`focus:${region}:${folder.key}:${shape}:${format}`, async () => {
          const { degraded, ...input } = await folderArtInputs(region, folder, 'focus');
          const family = motion().familyFor(folder);
          const buf = await motion().renderMotionFocus({ ...input, wordmark: folder.art.wordmark, format, shape, brand: folder.art.brand, family });
          return { buf, degraded };
        });
        send(res, out, format === 'gif' ? 'image/gif' : 'image/webp', FOLDER_CACHE);
        return;
      }
      if (file === 'hero.jpg') {
        const out = await cachedRender(`hero:${region}:${folder.key}`, async () => {
          const { degraded, backdrops } = await folderArtInputs(region, folder, 'hero');
          const buf = await motion().renderMotionHero({ backdrops, family: motion().familyFor(folder) });
          return { buf, degraded };
        });
        send(res, out, 'image/jpeg', FOLDER_CACHE);
        return;
      }
      if (file === 'hero.mp4') {
        if (!videoEnabled()) {
          res.status(503).set('cache-control', 'no-store').json({ err: 'hero videos are off on this deployment' });
          return;
        }
        const out = await cachedRender(`video:${region}:${folder.key}`, async () => {
          const { degraded, backdrops } = await folderArtInputs(region, folder, 'hero');
          const video = await motion().motionVideoFrames({ backdrops, family: motion().familyFor(folder) });
          // No picture to show: not worth a video. Nuvio keeps the hero still.
          if (!video) return { buf: null, degraded: true };
          return { buf: await encodeHeroVideo(video), degraded };
        });
        if (!out.buf) {
          res.status(404).set('cache-control', DEGRADED_CACHE).json({ err: 'no pictures for a hero video yet' });
          return;
        }
        sendVideo(req, res, out, FOLDER_CACHE);
        return;
      }
      // logo.png, the only file left.
      const out = await cachedRender(`logo:${region}:${folder.key}`, () => folderLogoImage(folder));
      send(res, out, 'image/png', FOLDER_CACHE);
    } catch (err) {
      failure(res, err);
    }
  });

  // A collection's own backdrop: the art plan's image for it, else a title of its
  // first folder past the ones that folder's own art shows.
  router.get('/collection/:region/:id/backdrop.jpg', async (req, res) => {
    try {
      const region = normalizeRegion(req.params.region);
      const id = String(req.params.id);
      const collection = region ? regionFolders(region).collections.find((c) => c.id === id) : null;
      if (!collection) {
        res.status(404).set('cache-control', 'public, max-age=300').json({ err: 'unknown collection' });
        return;
      }
      const [path, rawQuery] = splitUrl(req);
      const given = new URLSearchParams(rawQuery);
      const keep = new URLSearchParams();
      if (given.has('v')) keep.set('v', given.get('v'));
      if ([...given.keys()].length !== [...keep.keys()].length) {
        res.set('cache-control', REDIRECT_CACHE);
        res.redirect(301, keep.size ? `${path}?${keep}` : path);
        return;
      }
      const out = await cachedRender(`collection:${region}:${id}`, async () => {
        let pick = collectionPlan(region, id);
        let degraded = false;
        if (!pick) {
          const first = findFolder(region, collection.entries[0].key);
          const sample = first ? await sampleItems(region, first, 40) : { items: [], failed: true };
          const avoid = plannedPaths(region);
          const free = sample.items.map((it) => it.backdrop_path).filter((p) => isImagePath(p) && !avoid.has(p));
          // Past the slots the folder's own focus loop and hero take.
          pick = free[8] || free[free.length - 1] || null;
          degraded = Boolean(sample.failed);
        }
        const buf = pick ? await fetchTmdbImage('w1280', pick) : null;
        if (!pick || !buf) degraded = true;
        const jpeg = await motion().renderMotionHero({ backdrops: buf ? [buf] : [], family: motion().collectionFamily(id) });
        return { buf: jpeg, degraded };
      });
      send(res, out, 'image/jpeg', FOLDER_CACHE);
    } catch (err) {
      failure(res, err);
    }
  });
  // A tile's candidate titles for scripts/art-plan.js: public TMDB ids and image paths.
  router.get('/candidates/:region/:file', async (req, res) => {
    try {
      const region = normalizeRegion(req.params.region);
      const m = String(req.params.file).match(/^([a-z0-9-]+)\.json$/);
      const folder = region && m ? findFolder(region, m[1]) : null;
      if (!folder) {
        res.status(404).set('cache-control', 'public, max-age=300').json({ err: 'unknown folder' });
        return;
      }
      const found = await artCandidates(region, folder);
      res.set('cache-control', found.failed ? 'no-store' : 'public, max-age=3600, s-maxage=21600');
      res.set('access-control-allow-origin', '*');
      res.json(found);
    } catch (err) {
      failure(res, err);
    }
  });
  return router;
}

module.exports = { createArtRouter, _RenderCache: RenderCache, _sendVideo: sendVideo };

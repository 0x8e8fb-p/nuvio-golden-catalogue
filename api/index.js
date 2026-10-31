'use strict';

/**
 * Vercel serverless entry point (also mounted by src/index.js for local dev).
 *
 * Routes:
 *   /                                   landing page (install links, region picker)
 *   /manifest.json, /catalog/...        default edition (DEFAULT_REGION, else US)
 *   /r/:CC/manifest.json, /r/:CC/...    region edition, e.g. /r/IN/manifest.json
 *   /r/:CC/collections.json             Golden Collections pack for Nuvio (import by URL)
 *   /r/:CC/c/:preset/...                themed preset manifests
 *   /c/:preset/...                      presets in the default region
 *   /art/...                            generated artwork (tiles, Top 10, folder art)
 *   /presets.json, /health
 *   /configure                          redirects to the landing page (v2 links)
 *
 * Every request runs inside a request context that records its public origin,
 * so catalog responses can point at artwork on the same host.
 */

const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { loadConfig } = require('../src/lib/config-loader');
const { buildAddon } = require('../src/addon');
const { configForPreset, listPresets } = require('../src/presets');
const { landingPage } = require('../src/landing');
const { contextMiddleware, currentOrigin } = require('../src/lib/request-context');
const { normalizeRegion, defaultRegion } = require('../src/lib/region');
const { createArtRouter } = require('../src/art/routes');
const { buildPack, packStats } = require('../src/collections/pack');
const { getTmdbClient } = require('../src/tmdb/shared');

const app = express();
app.disable('x-powered-by');
const baseConfig = loadConfig();

app.use(contextMiddleware);

/**
 * Config for a region edition, or a preset inside it.
 *
 * Full editions: the default region keeps the plain id
 * (com.nuvio.golden.catalogue), so installs from /manifest.json and
 * /r/<default>/manifest.json are the same addon; other regions get a ".in"
 * style suffix.
 *
 * Presets keep their v2 ids: "<id>.<preset>" at /c/<preset>/ and
 * "<id>.<preset>.<cc>" at /r/<CC>/c/<preset>/, for every region, so existing
 * installs keep working.
 *
 * @param {string} region two-letter code
 * @param {string} [preset] preset slug
 * @param {{regionInPath?: boolean}} [opts] true for /r/<CC>/ routes
 */
function editionConfig(region, preset, opts = {}) {
  const cfg = preset ? configForPreset(preset, baseConfig) : baseConfig;
  if (!cfg) return null;
  const isDefault = region === defaultRegion(baseConfig);
  const suffix = preset ? opts.regionInPath : !isDefault;
  return Object.assign({}, cfg, {
    defaults: Object.assign({}, cfg.defaults, { region }),
    addon: Object.assign({}, cfg.addon, {
      id: suffix ? `${cfg.addon.id}.${region.toLowerCase()}` : cfg.addon.id,
      name: preset || isDefault ? cfg.addon.name : `${cfg.addon.name} ${region}`,
    }),
  });
}

function isTimeSensitive(cfg) {
  return cfg.catalogues.some((r) => r.activeWhen || r.dynamicName);
}

// Bounded, least recently used first: any two-letter code is a valid edition,
// so an unbounded map would grow with every code a crawler tries.
const routers = new Map();
const ROUTERS_MAX = 64;

/**
 * SDK router for an edition. Editions with time-aware rows are rebuilt per
 * request (cheap), so rows appear and disappear on time; the rest are cached.
 */
function routerFor(region, preset, opts = {}) {
  const key = `${region}:${preset || ''}:${opts.regionInPath ? 'r' : ''}`;
  const cached = routers.get(key);
  if (cached && !cached.timeSensitive) {
    routers.delete(key);
    routers.set(key, cached);
    return cached.router;
  }
  const cfg = editionConfig(region, preset, opts);
  if (!cfg) return null;
  const router = getRouter(buildAddon(cfg, { featuredOnly: !preset, engine: !preset }));
  routers.delete(key);
  routers.set(key, { router, timeSensitive: isTimeSensitive(cfg) });
  while (routers.size > ROUTERS_MAX) routers.delete(routers.keys().next().value);
  return router;
}

function sendJson(res, body, cacheControl) {
  res.set('access-control-allow-origin', '*');
  res.set('cache-control', cacheControl);
  res.json(body);
}

// ---- Artwork ---------------------------------------------------------------
app.use('/art', createArtRouter());

// ---- Golden Collections pack ------------------------------------------------
// ?focus=gif links GIF focus loops instead of WebP, for TVs on Android 8 or
// older, where Nuvio can only animate GIF. Ids are the same either way, so
// importing one URL after the other switches the pack in place.
function packHandler(regionParam) {
  return (req, res) => {
    const region = normalizeRegion(regionParam || req.params.region);
    if (!region) {
      res.status(400).json({ err: 'region must be a 2-letter country code' });
      return;
    }
    const cfg = editionConfig(region);
    const focusFormat = req.query.focus === 'gif' ? 'gif' : 'webp';
    const pack = buildPack({ region, origin: currentOrigin(), addonId: cfg.addon.id, focusFormat });
    sendJson(res, pack, 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400');
  };
}
app.get('/r/:region/collections.json', packHandler());
app.get('/collections.json', (req, res) => packHandler(defaultRegion(baseConfig))(req, res));

// ---- Region editions and presets --------------------------------------------
function validRegionOr400(req, res) {
  const region = normalizeRegion(req.params.region);
  if (!region) res.status(400).json({ err: 'region must be a 2-letter country code' });
  return region;
}

app.use('/r/:region/c/:slug', (req, res, next) => {
  const region = validRegionOr400(req, res);
  if (!region) return;
  const router = routerFor(region, req.params.slug, { regionInPath: true });
  if (!router) {
    res.status(404).json({ err: 'unknown preset', slug: req.params.slug });
    return;
  }
  router(req, res, next);
});

app.use('/r/:region', (req, res, next) => {
  const region = validRegionOr400(req, res);
  if (!region) return;
  routerFor(region)(req, res, next);
});

app.use('/c/:slug', (req, res, next) => {
  const router = routerFor(defaultRegion(baseConfig), req.params.slug);
  if (!router) {
    res.status(404).json({ err: 'unknown preset', slug: req.params.slug });
    return;
  }
  router(req, res, next);
});

// ---- Pages and status ---------------------------------------------------------
let rendererCheck = null;

/**
 * One tiny render per process: shows whether sharp and the bundled font work
 * on this host. A failure is retried on the next call.
 * @returns {Promise<{ok: boolean, ms?: number, error?: string}>}
 */
function checkRenderer() {
  if (!rendererCheck) {
    rendererCheck = (async () => {
      const started = Date.now();
      try {
        const { renderWordmark } = require('../src/art/render');
        const { getSharp } = require('../src/art/sharp');
        const png = await renderWordmark('OK', { height: 40, maxWidth: 200 });
        // A text failure falls back to a 1x1 transparent image.
        const meta = await getSharp()(png).metadata();
        if (meta.width > 1) return { ok: true, ms: Date.now() - started };
        rendererCheck = null;
        return { ok: false, error: 'text rendering failed' };
      } catch (err) {
        rendererCheck = null;
        return { ok: false, error: err && err.code === 'SHARP_UNAVAILABLE' ? 'sharp unavailable' : 'render failed' };
      }
    })();
  }
  return rendererCheck;
}

/**
 * Does the configured TMDB key actually work? One cheap request; TMDB answers
 * 401 for a wrong key. A working answer stays in the client's cache for an
 * hour, so repeated checks are free.
 * @returns {Promise<{ok: boolean, auth?: string, error?: string}>}
 */
async function checkTmdb(client) {
  if (!client.hasKey()) return { ok: false, error: 'TMDB_API_KEY is not set' };
  try {
    await client.get('/configuration');
    return { ok: true, auth: client.authMode };
  } catch (err) {
    const rejected = err && (err.status === 401 || err.status === 403);
    return { ok: false, auth: client.authMode, error: rejected ? 'TMDB rejected the key' : 'TMDB did not answer' };
  }
}

app.get('/health', async (req, res) => {
  const client = getTmdbClient();
  const region = defaultRegion(baseConfig);
  const [tmdb, renderer] = await Promise.all([checkTmdb(client), checkRenderer()]);
  sendJson(
    res,
    {
      status: 'ok',
      version: baseConfig.addon.version,
      region,
      rows: baseConfig.catalogues.length,
      presets: listPresets(baseConfig).length,
      collections: packStats(region),
      tmdbKeyConfigured: client.hasKey(),
      tmdb,
      renderer,
      publicOrigin: currentOrigin(),
      cache: client.cacheStats(),
      breaker: client.breakerStats(),
    },
    'no-store'
  );
});

app.get('/presets.json', (req, res) => {
  sendJson(res, { presets: listPresets(baseConfig) }, 'public, max-age=3600');
});

// v2 had a separate configure page; everything now lives on the landing page.
app.get('/configure', (req, res) => {
  res.redirect(302, '/#presets');
});

app.get('/', (req, res) => {
  res.set('content-type', 'text/html; charset=utf-8').send(
    landingPage(baseConfig, {
      defaultRegion: defaultRegion(baseConfig),
      origin: currentOrigin(),
      presets: listPresets(baseConfig),
      tmdbKeyConfigured: getTmdbClient().hasKey(),
    })
  );
});

// ---- Default edition at the root -------------------------------------------
app.use((req, res, next) => {
  routerFor(defaultRegion(baseConfig))(req, res, next);
});

module.exports = app;

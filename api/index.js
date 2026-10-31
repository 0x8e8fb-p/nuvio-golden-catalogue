'use strict';

/**
 * Vercel serverless entry point (also mounted by src/index.js for local dev).
 *
 * Routes:
 *   /                         -> redirect to the landing page
 *   /manifest.json, /catalog… -> the default curated catalogue (SDK router)
 *   /c/<preset>/manifest.json… -> a lean preset manifest (see src/presets.js)
 *   /presets.json             -> machine-readable list of available presets
 *
 * Presets exist because a single Stremio manifest is capped at 8KB (~75 rows).
 * Installing several lean preset URLs gives the full catalogue without the cap.
 */

const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const { loadConfig } = require('../src/lib/config-loader');
const { buildAddon } = require('../src/addon');
const { configForPreset, listPresets } = require('../src/presets');
const { landingPage } = require('../src/landing');
const { configurePage } = require('../src/configure');

const app = express();
const baseConfig = loadConfig();

// Cache one router per (region, slug) so we don't rebuild on every request —
// except time-sensitive presets (activeWhen/rotate/window), which must reflect
// the current clock, so we rebuild those per request (manifest build is cheap;
// catalogue data is still cached by the TMDB client).
const presetRouters = new Map();

function isTimeSensitive(cfg) {
  return cfg.catalogues.some((r) => r.activeWhen || r.rotate || r.window);
}

function buildPresetRouter(slug, region) {
  let cfg = configForPreset(slug, baseConfig);
  if (!cfg) return null;
  if (region) {
    cfg = Object.assign({}, cfg, {
      defaults: Object.assign({}, cfg.defaults, { region }),
      addon: Object.assign({}, cfg.addon, {
        id: `${cfg.addon.id}.${region.toLowerCase()}`,
      }),
    });
  }
  return { router: getRouter(buildAddon(cfg, { featuredOnly: false })), timeSensitive: isTimeSensitive(cfg) };
}

function routerFor(slug, region) {
  const key = `${region || ''}:${slug}`;
  if (presetRouters.has(key)) {
    const entry = presetRouters.get(key);
    if (!entry.timeSensitive) return entry.router;
    // Rebuild time-sensitive presets so activation reflects the current time.
    const fresh = buildPresetRouter(slug, region);
    return fresh ? fresh.router : null;
  }
  const built = buildPresetRouter(slug, region);
  if (!built) return null;
  presetRouters.set(key, built);
  return built.router;
}

function validRegion(cc) {
  return typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc);
}

// Region-scoped preset routes: /r/<CC>/c/<slug>/... (e.g. /r/IN/c/streaming/…)
// lets users in any country get accurate watch-provider rows with no config edit.
app.use('/r/:region/c/:slug', (req, res, next) => {
  if (!validRegion(req.params.region)) {
    res.status(400).json({ err: 'region must be a 2-letter country code' });
    return;
  }
  const router = routerFor(req.params.slug, req.params.region.toUpperCase());
  if (!router) {
    res.status(404).json({ err: 'unknown preset', slug: req.params.slug });
    return;
  }
  router(req, res, next);
});

// Preset routes: /c/<slug>/manifest.json, /c/<slug>/catalog/..., etc.
app.use('/c/:slug', (req, res, next) => {
  const router = routerFor(req.params.slug);
  if (!router) {
    res.status(404).json({ err: 'unknown preset', slug: req.params.slug });
    return;
  }
  router(req, res, next);
});

// Health/status endpoint (no secrets): confirms the service is up and whether a
// TMDB key is present, plus row/preset counts.
app.get('/health', (req, res) => {
  const { createTmdbClient } = require('../src/tmdb/client');
  const client = createTmdbClient();
  res.json({
    status: 'ok',
    version: baseConfig.addon.version,
    rows: baseConfig.catalogues.length,
    presets: listPresets(baseConfig).length,
    tmdbKeyConfigured: client.hasKey(),
    cache: client.cacheStats(),
    breaker: client.breakerStats(),
  });
});

// Machine-readable preset index (for the landing page / tooling).
app.get('/presets.json', (req, res) => {
  res.json({ presets: listPresets(baseConfig) });
});

// Interactive configure page: pick region + presets, get install URLs.
app.get('/configure', (req, res) => {
  res.set('content-type', 'text/html; charset=utf-8').send(
    configurePage(baseConfig, listPresets(baseConfig), req)
  );
});

// Human landing page with install links.
app.get('/', (req, res) => {
  res.set('content-type', 'text/html; charset=utf-8').send(
    landingPage(baseConfig, listPresets(baseConfig), req)
  );
});

// Default catalogue (the curated everything-that-fits set) at the root.
// Rebuilt per request so time-aware rows (activeWhen) reflect the current clock.
app.use((req, res, next) => {
  getRouter(buildAddon(baseConfig))(req, res, next);
});

module.exports = app;

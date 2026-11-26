'use strict';
/**
 * The art plan: which image every tile and collection shows, chosen once for
 * the whole pack so that no image appears twice anywhere on the home screen.
 *
 * Each tile gets FOCUS backdrops (its focus loop; the cover is the loop's
 * first frame) and HERO backdrops for its hero still and video, and
 * each collection one backdrop of its own. Every image path is used once, and
 * a title belongs to one tile only, whenever the folders allow it.
 *
 * Allocation runs scarcest tile first: a director with twelve films claims
 * them before the Drama tile, which has thousands to choose from. A tile that
 * runs short of titles falls back to other backdrops of its own titles (from
 * TMDB's image lists), still never an image another tile shows.
 *
 * Plans are generated from the live folders by scripts/art-plan.js into
 * data/art-plan/<REGION>.json. A tile missing from the plan (a new folder)
 * samples its art live and steers clear of every image the plan uses.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLAN_DIR = path.join(__dirname, '..', '..', 'data', 'art-plan');
// Posters are not drawn by the v5 motion art, so they claim no titles.
const SLOTS = { focus: 4, hero: 3, posters: 0 };
// Base of folder art URL versions; a region's plan hash is appended to it.
const FOLDER_ART_BASE = '5';

const cache = new Map();

/** Stable short hash of a plan's content. */
function planHash(plan) {
  const body = JSON.stringify({ tiles: plan.tiles, collections: plan.collections });
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 8);
}

/**
 * The committed plan of a region, or null.
 * @param {string} region
 * @returns {{region: string, hash: string, tiles: object, collections: object, used: Set<string>}|null}
 */
function loadPlan(region) {
  if (cache.has(region)) return cache.get(region);
  let plan = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PLAN_DIR, `${region}.json`), 'utf8'));
    if (raw && raw.tiles && typeof raw.tiles === 'object') {
      const used = new Set();
      for (const t of Object.values(raw.tiles)) for (const p of [...(t.focus || []), ...(t.hero || []), ...(t.posters || [])]) used.add(p);
      for (const p of Object.values(raw.collections || {})) used.add(p);
      plan = { region, hash: planHash(raw), tiles: raw.tiles, collections: raw.collections || {}, used };
    }
  } catch {
    plan = null;
  }
  cache.set(region, plan);
  return plan;
}

/** The tile's planned images ({focus, hero, posters}), or null. */
function tilePlan(region, key) {
  const plan = loadPlan(region);
  return (plan && plan.tiles[key]) || null;
}

/** The collection's planned backdrop path, or null. */
function collectionPlan(region, id) {
  const plan = loadPlan(region);
  return (plan && plan.collections[id]) || null;
}

/** Every image path the region's plan uses (empty without a plan). */
function plannedPaths(region) {
  const plan = loadPlan(region);
  return plan ? plan.used : new Set();
}

/** The `v` of a region's folder art URLs: "5", or "5.<plan hash>" with a plan. */
function folderArtVersion(region) {
  const plan = loadPlan(region);
  return plan ? `${FOLDER_ART_BASE}.${plan.hash}` : FOLDER_ART_BASE;
}

const isPath = (p) => typeof p === 'string' && /^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(p);
const titleKey = (t) => `${t.t}${t.id}`;

/**
 * Allocate images to tiles and collections.
 * @param {Array<{key: string, titles: Array<{t: 'm'|'s', id: number, b?: string, p?: string, v?: number}>,
 *   extra?: Object<string, {b?: string[], p?: string[]}>}>} tiles candidates per tile,
 *   most prominent title first; extra holds more images per title ("m123")
 * @param {Array<{id: string, tiles: string[]}>} collections visible collections and their tile keys
 * @param {{slots?: {focus: number, hero: number, posters: number}}} [opts]
 * @returns {{tiles: object, collections: object, stats: object}}
 */
function allocate(tiles, collections, opts = {}) {
  const slots = opts.slots || SLOTS;
  const usedPath = new Set();
  const usedTitle = new Set();
  const out = {};
  const short = [];
  const pool = (tile) => (tile.titles || []).filter((t) => t && t.id && (isPath(t.b) || isPath(t.p)));
  const order = [...tiles].sort((a, b) => pool(a).length - pool(b).length || a.key.localeCompare(b.key));

  for (const tile of order) {
    const titles = pool(tile);
    const mine = new Set(); // titles this tile shows
    const take = (want, field, extraField) => {
      const got = [];
      // 1. A title nobody shows yet.
      for (const t of titles) {
        if (got.length >= want) break;
        const p = t[field];
        if (!isPath(p) || usedPath.has(p) || usedTitle.has(titleKey(t))) continue;
        got.push(p);
        usedPath.add(p);
        usedTitle.add(titleKey(t));
        mine.add(titleKey(t));
      }
      // 2. Other images of this tile's own titles, then of any of its titles.
      const extras = tile.extra || {};
      const sources = [...titles.filter((t) => mine.has(titleKey(t))), ...titles.filter((t) => !mine.has(titleKey(t)))];
      for (const t of sources) {
        if (got.length >= want) break;
        const more = (extras[titleKey(t)] && extras[titleKey(t)][extraField]) || [];
        for (const p of [t[field], ...more]) {
          if (got.length >= want) break;
          if (!isPath(p) || usedPath.has(p)) continue;
          // A title another tile shows is only used through a different image.
          got.push(p);
          usedPath.add(p);
          mine.add(titleKey(t));
          usedTitle.add(titleKey(t));
        }
      }
      return got;
    };
    const focus = take(slots.focus, 'b', 'b');
    const hero = take(slots.hero, 'b', 'b');
    const posters = take(slots.posters, 'p', 'p');
    out[tile.key] = { focus, hero, posters };
    if (focus.length < slots.focus || hero.length < slots.hero || posters.length < slots.posters) {
      short.push(`${tile.key}:${focus.length}/${hero.length}/${posters.length}`);
    }
  }

  // Collections: the most prominent backdrop left over among their tiles' titles.
  const byKey = new Map(tiles.map((t) => [t.key, t]));
  const backdrops = {};
  for (const c of collections) {
    const lists = c.tiles.map((k) => pool(byKey.get(k) || { titles: [] }));
    let chosen = null;
    for (let i = 0; !chosen && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const t = l[i];
        if (!t || !isPath(t.b) || usedPath.has(t.b) || usedTitle.has(titleKey(t))) continue;
        chosen = t;
        break;
      }
    }
    if (chosen) {
      usedPath.add(chosen.b);
      usedTitle.add(titleKey(chosen));
      backdrops[c.id] = chosen.b;
    }
  }
  return {
    tiles: out,
    collections: backdrops,
    stats: { tiles: tiles.length, images: usedPath.size, titles: usedTitle.size, short },
  };
}

module.exports = {
  SLOTS,
  FOLDER_ART_BASE,
  PLAN_DIR,
  allocate,
  loadPlan,
  tilePlan,
  collectionPlan,
  plannedPaths,
  folderArtVersion,
  planHash,
  _cache: cache,
};

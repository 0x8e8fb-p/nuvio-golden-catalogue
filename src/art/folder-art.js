'use strict';

/**
 * Live artwork for a collection folder: cover, animated focus loop, hero wall
 * and brand logo. The art is built from the titles the folder currently
 * contains, so a folder always shows what is actually inside it, and it
 * changes as the folder's contents change.
 *
 * When something the art needs fails to load (the folder's titles, the brand
 * logo lookup, an image download), the inputs are marked `degraded`, so the
 * routes keep that art out of long-lived caches and try again soon.
 */

const { getTmdbClient } = require('../tmdb/shared');
const { regionFolders } = require('../collections/engine');
const { folderPage } = require('../collections/folder-feed');
const { createMdblistSource } = require('../sources/mdblist');
const { fetchTmdbImage, isImagePath } = require('./fetch-image');
const { entityLogo } = require('./logos');
const { TtlLruCache } = require('../lib/cache');
const { mapWithConcurrency } = require('../tmdb/mappers');
const { tilePlan, plannedPaths, SLOTS } = require('./plan');

const mdblist = createMdblistSource();
const sampleCache = new TtlLruCache({ ttl: 6 * 60 * 60 * 1000, max: 600 });
// A group's art mixes titles from this many of its members.
const GROUP_SAMPLE_MEMBERS = 6;

/** Round-robin merge of item lists, skipping adult titles and repeats. */
function interleave(lists, n) {
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const it = list[i];
      if (!it || it.adult || out.length >= n) continue;
      const id = `${it.title ? 'm' : 't'}${it.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
  }
  return out;
}

/**
 * Up to `n` raw TMDB items from a folder, alternating its movie and show tabs.
 * A group folder ("Indian Studios") mixes the samples of its first members,
 * so its art shows a little of every studio rather than only the first one.
 *
 * `failed` is true when a TMDB key is configured but the titles could not be
 * loaded: a feed threw, or nothing came back. Only a sample that did not fail
 * is cached (per folder, for 6 hours), so an empty sample is never cached.
 * Without a TMDB key there is nothing to load, which is not a failure.
 * @param {string} region
 * @param {object} folder
 * @param {number} [n]
 * @returns {Promise<{items: object[], failed: boolean}>}
 */
async function sampleItems(region, folder, n = 24) {
  const key = `${region}:${folder.key}:${n}`;
  const hit = sampleCache.get(key);
  if (hit) return { items: hit, failed: false };
  const client = getTmdbClient();
  if (!client.hasKey()) return { items: [], failed: false };
  if (folder.members) {
    const parts = await Promise.all(folder.members.slice(0, GROUP_SAMPLE_MEMBERS).map((m) => sampleItems(region, m, n)));
    const out = interleave(parts.map((p) => p.items), n);
    const failed = !out.length || parts.some((p) => p.failed);
    if (!failed) sampleCache.set(key, out);
    return { items: out, failed };
  }
  let failed = false;
  const perType = await Promise.all(
    folder.types.map(async (type) => {
      try {
        const page = await folderPage(client, folder.sources[type], type, 0, n, { mdblist });
        if (page.items) return page.items;
        // List folders give IMDb ids: resolve a few to TMDB records for art.
        const ids = (page.imdbIds || []).slice(0, 12);
        const found = await mapWithConcurrency(ids, 6, async (id) => {
          try {
            const data = await client.get(`/find/${id}`, { external_source: 'imdb_id' });
            return (type === 'series' ? data.tv_results : data.movie_results)[0] || null;
          } catch {
            failed = true;
            return null;
          }
        });
        return found.filter(Boolean);
      } catch {
        failed = true;
        return [];
      }
    })
  );
  const out = interleave(perType, n);
  // The feeds turn most TMDB errors into empty pages, so with a key configured
  // an empty sample means the titles did not load.
  if (!out.length) failed = true;
  if (!failed) sampleCache.set(key, out);
  return { items: out, failed };
}

/** Backdrop paths for the folder, most prominent first. */
function backdropPaths(items, n) {
  return items.map((it) => it.backdrop_path).filter(isImagePath).slice(0, n);
}

function posterPaths(items, n) {
  return items.map((it) => it.poster_path).filter(isImagePath).slice(0, n);
}

/**
 * Brand logo of a folder: the verified path from data/, else a TMDB network or
 * company lookup.
 * @param {object} folder
 * @returns {Promise<{path: string|null, ok: boolean}>} ok is false when the lookup failed
 */
async function folderLogo(folder) {
  const spec = folder.art;
  if (spec.logoPath) return { path: spec.logoPath, ok: true };
  if (!spec.logoKind) return { path: null, ok: true };
  return entityLogo(getTmdbClient(), spec.logoKind, spec.logoId);
}

/**
 * Brand logo file path for a folder (verified path, else TMDB lookup), or null.
 * @param {object} folder
 * @returns {Promise<string|null>}
 */
async function folderLogoPath(folder) {
  return (await folderLogo(folder)).path;
}

/** Resolve a tile by region and key, or null. Sub-folders are rows, not tiles: no art of their own. */
function findFolder(region, key) {
  const folder = regionFolders(region).folders.get(key);
  return folder && !folder.parent ? folder : null;
}

/**
 * The images a tile shows: its planned ones (see plan.js), else a live sample
 * that keeps clear of every image the plan gives to other tiles. Distinct
 * titles fill the slots in order: focus backdrops, hero backdrops, posters.
 * @returns {Promise<{focus: string[], hero: string[], posters: string[], failed: boolean, planned: boolean}>}
 */
async function tileImages(region, folder) {
  const planned = tilePlan(region, folder.key);
  if (planned) return { focus: planned.focus || [], hero: planned.hero || [], posters: planned.posters || [], failed: false, planned: true };
  const sample = await sampleItems(region, folder, 40);
  const avoid = plannedPaths(region);
  const free = sample.items.filter((it) => !avoid.has(it.backdrop_path) && !avoid.has(it.poster_path));
  const withBackdrop = free.filter((it) => isImagePath(it.backdrop_path));
  const focus = withBackdrop.slice(0, SLOTS.focus).map((it) => it.backdrop_path);
  const hero = withBackdrop.slice(SLOTS.focus, SLOTS.focus + SLOTS.hero).map((it) => it.backdrop_path);
  const shown = new Set(withBackdrop.slice(0, SLOTS.focus + SLOTS.hero).map((it) => it.id));
  let posters = free.filter((it) => !shown.has(it.id) && isImagePath(it.poster_path)).map((it) => it.poster_path);
  // A small folder reuses its own titles for posters rather than show none.
  if (posters.length < SLOTS.posters) posters = posters.concat(free.filter((it) => shown.has(it.id) && isImagePath(it.poster_path)).map((it) => it.poster_path));
  if (!hero.length && focus.length > 1) hero.push(focus[focus.length - 1]);
  return { focus, hero, posters: posters.slice(0, SLOTS.posters), failed: sample.failed, planned: false };
}

/**
 * Inputs for each folder art kind, downloaded and ready for the renderer, plus
 * `degraded` (boolean): true when something the art needs failed to load (the
 * folder's titles while a TMDB key is configured, the brand logo lookup, or a
 * download). Remove `degraded` before passing the inputs to a render function.
 * @param {string} region
 * @param {object} folder
 * @param {'cover'|'focus'|'hero'} kind
 * @param {{shape?: string}} [opts] shape actually requested (defaults to the folder's)
 * @returns {Promise<object>} hero: {backdrops, posters, logo}; focus: {logo, backdrops};
 *   cover: {logo, backdrop}; each plus degraded
 */
async function folderArtInputs(region, folder, kind, opts = {}) {
  let degraded = false;
  // A valid path that fails to download leaves the art without that image.
  const download = async (size, path) => {
    const buf = await fetchTmdbImage(size, path);
    if (!buf && isImagePath(path)) degraded = true;
    return buf;
  };
  // A director folder's cover is the director's portrait and needs nothing else.
  if (kind === 'cover' && folder.raw.portrait) {
    const backdrop = await download('w500', folder.raw.portrait);
    return { logo: null, backdrop, degraded };
  }
  const images = await tileImages(region, folder);
  if (images.failed) degraded = true;
  const brand = await folderLogo(folder);
  if (!brand.ok) degraded = true;
  const logo = brand.path ? await download('w500', brand.path) : null;
  if (kind === 'hero') {
    const [backdrops, posters] = await Promise.all([
      Promise.all(images.hero.map((p) => download('w1280', p))),
      Promise.all(images.posters.slice(0, SLOTS.posters).map((p) => download('w342', p))),
    ]);
    return { backdrops: backdrops.filter(Boolean), posters: posters.filter(Boolean), logo, degraded };
  }
  if (kind === 'focus') {
    // A director's loop opens on the portrait (the cover), then the films.
    const paths = folder.raw.portrait ? [folder.raw.portrait, ...images.focus.slice(0, SLOTS.focus - 1)] : images.focus;
    const backdrops = await Promise.all(paths.map((p) => download(p === folder.raw.portrait ? 'w500' : 'w780', p)));
    return { logo, backdrops: backdrops.filter(Boolean), degraded };
  }
  // The cover is the focus loop's first frame: its first backdrop, cropped to the
  // tile shape. Taller crops need the larger size.
  const shape = opts.shape || folder.shape;
  const first = images.focus[0] || images.hero[0];
  let backdrop = null;
  if (first) backdrop = await download(shape === 'landscape' ? 'w780' : 'w1280', first);
  else if (images.posters[0]) backdrop = await download('w500', images.posters[0]);
  return { logo, backdrop, degraded };
}

/**
 * Candidate titles for the art plan: a deep sample of the tile's titles, most
 * prominent first, as compact records, plus more images per title when the
 * tile is small. Public TMDB data only.
 * @returns {Promise<{key: string, titles: object[], extra: object, failed: boolean}>}
 */
async function artCandidates(region, folder) {
  const sample = await sampleItems(region, folder, 80);
  const titles = sample.items.map((it) => ({
    t: it.title !== undefined || it.release_date !== undefined ? 'm' : 's',
    id: it.id,
    b: isImagePath(it.backdrop_path) ? it.backdrop_path : undefined,
    p: isImagePath(it.poster_path) ? it.poster_path : undefined,
    v: it.vote_count || 0,
  }));
  const extra = {};
  let failed = sample.failed;
  if (titles.length < SCARCE_TITLES) {
    const client = getTmdbClient();
    await mapWithConcurrency(titles.slice(0, EXTRA_TITLES), 4, async (t) => {
      try {
        const data = await client.get(`/${t.t === 'm' ? 'movie' : 'tv'}/${t.id}/images`, { include_image_language: 'null,en' });
        const b = (data.backdrops || []).filter((x) => !x.iso_639_1).map((x) => x.file_path).filter(isImagePath);
        const p = (data.posters || []).map((x) => x.file_path).filter(isImagePath);
        extra[`${t.t}${t.id}`] = { b: b.slice(0, 8), p: p.slice(0, 4) };
      } catch {
        failed = true;
      }
    });
  }
  return { key: folder.key, titles, extra, failed };
}
// Tiles with fewer titles than this list extra images of their first titles.
const SCARCE_TITLES = 24;
const EXTRA_TITLES = 10;

module.exports = { findFolder, folderArtInputs, folderLogo, folderLogoPath, sampleItems, tileImages, artCandidates };

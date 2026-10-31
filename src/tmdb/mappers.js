'use strict';

/**
 * Maps TMDB results into Stremio meta-preview objects with tt (IMDB) ids.
 *
 * Why tt ids: emitting IMDB ids lets Cinemeta (and the user's other metadata
 * addons) supply rich detail pages, and lets the user's existing stream addons
 * resolve playback — this addon stays catalogue-only.
 *
 * TMDB list endpoints (trending/popular/discover/search) do NOT include the
 * IMDB id, so we resolve it per item via the detail endpoint's external_ids
 * (append_to_response). Results are cached (ids are stable) and resolved with
 * bounded concurrency. Items without a tt id are dropped from the preview list
 * rather than emitted with an unusable id.
 *
 * Adult safety: any item flagged adult is filtered out here as well (defence in
 * depth on top of include_adult=false and adult-genre exclusion in config).
 */

const { posterUrl, backdropUrl, rpdbPosterUrl } = require('./client');
const { artEnabled, tileUrl, rankUrl, logoUrl } = require('../art/urls');
const { tmdbImageUrl } = require('../art/fetch-image');

// Caches TMDB numeric id -> imdb tt id (or null when none exists).
const imdbCache = new Map();

function keyFor(mediaType, tmdbId) {
  return `${mediaType}:${tmdbId}`;
}

function externalIdsEndpoint(mediaType, tmdbId) {
  // mediaType is 'movie' or 'tv' (TMDB), not the Stremio type.
  return `/${mediaType}/${tmdbId}/external_ids`;
}

/**
 * Resolve the IMDB tt id for a single TMDB item. Cached. Returns null if none.
 */
async function resolveImdbId(client, mediaType, tmdbId) {
  const k = keyFor(mediaType, tmdbId);
  if (imdbCache.has(k)) return imdbCache.get(k);
  try {
    const data = await client.get(externalIdsEndpoint(mediaType, tmdbId));
    const imdb = data && typeof data.imdb_id === 'string' ? data.imdb_id : null;
    const value = imdb && imdb.startsWith('tt') ? imdb : null;
    imdbCache.set(k, value);
    return value;
  } catch {
    // On failure, cache null briefly-ish by not caching, so it can retry later.
    return null;
  }
}

/**
 * Map a raw TMDB list item to a partial preview (without the tt id yet).
 * stremioType: 'movie' | 'series'. mediaType: 'movie' | 'tv'.
 */
function toPartialPreview(item, stremioType, posterShape) {
  const name = item.title || item.name || item.original_title || item.original_name;
  const dateStr = item.release_date || item.first_air_date || '';
  const year = dateStr ? String(dateStr).slice(0, 4) : undefined;

  const preview = {
    type: stremioType,
    name,
  };
  if (posterShape && posterShape !== 'poster') preview.posterShape = posterShape;

  // Landscape rows look best with the backdrop; portrait with the poster.
  if (posterShape === 'landscape') {
    preview.poster = backdropUrl(item.backdrop_path) || posterUrl(item.poster_path);
  } else {
    preview.poster = posterUrl(item.poster_path);
  }
  const bg = backdropUrl(item.backdrop_path);
  if (bg) preview.background = bg;
  if (year) preview.releaseInfo = year;
  if (typeof item.vote_average === 'number' && item.vote_average > 0) {
    preview.imdbRating = item.vote_average.toFixed(1);
  }
  if (item.overview) preview.description = item.overview;

  return { preview, tmdbId: item.id, name };
}

function isAdult(item) {
  return item && item.adult === true;
}

/**
 * Should this row use generated artwork? "tile" and "rank" rows do whenever the
 * public origin is known; "poster" rows (and ART_MODE=posters) keep TMDB posters.
 */
function wantsArt(art) {
  return art !== 'poster' && artEnabled();
}

/** Can this TMDB item be shown in the requested art style? */
function hasArtInputs(item, art) {
  if (!wantsArt(art)) return Boolean(item.poster_path);
  // Title tiles and rank tiles both have a layout for a poster alone, so titles without
  // a TMDB backdrop (common for Indian films on deep pages) stay in the row.
  return Boolean(item.backdrop_path || item.poster_path);
}

/**
 * Point a preview at generated artwork. Nuvio reads `landscapePoster` as a
 * finished 16:9 tile (no logo drawn over it) and `_rawPosterUrl` as the image
 * to show if the generated tile ever fails to load. `background` is only set
 * from a real backdrop, never from the portrait poster.
 */
function applyArt(preview, item, stremioType, art, rank) {
  const backdrop = item.backdrop_path;
  const tile =
    art === 'rank'
      ? rankUrl({ rank, poster: item.poster_path, backdrop })
      : tileUrl({
          type: stremioType,
          tmdbId: item.id,
          backdrop,
          poster: item.poster_path,
          title: preview.name,
          lang: item.original_language,
        });
  preview.posterShape = 'landscape';
  preview.poster = tile;
  preview.landscapePoster = tile;
  preview._rawPosterUrl = tmdbImageUrl('w780', backdrop) || tmdbImageUrl('w500', item.poster_path);
  const bg = tmdbImageUrl('w1280', backdrop);
  if (bg) preview.background = bg;
  preview.logo = logoUrl({ type: stremioType, tmdbId: item.id, lang: item.original_language });
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Map a full TMDB list response to Stremio meta previews with tt ids.
 *
 * @param {object} client   TMDB client
 * @param {Array}  results  TMDB results array
 * @param {object} opts     { stremioType, posterShape, art, rankStart, concurrency }
 *   art: "tile" (default) | "rank" | "poster". rankStart: rank of results[0].
 * @returns {Promise<Array>} meta-preview objects (adult-filtered, tt ids only)
 */
async function toMetaPreviews(client, results, opts) {
  const stremioType = opts.stremioType;
  const mediaType = stremioType === 'series' ? 'tv' : 'movie';
  const posterShape = opts.posterShape || 'poster';
  const concurrency = opts.concurrency || 10;
  const art = opts.art || 'tile';
  const useArt = wantsArt(art);

  const clean = (results || [])
    .filter((it) => it && !isAdult(it))
    .filter((it) => hasArtInputs(it, art));

  const mapped = await mapWithConcurrency(clean, concurrency, async (item) => {
    const { preview, tmdbId } = toPartialPreview(item, stremioType, posterShape);
    const imdb = await resolveImdbId(client, mediaType, tmdbId);
    if (!imdb) return null; // drop items we can't give a usable (tt) id
    preview.id = imdb;
    return { preview, item };
  });

  // Art is applied in the final order, so rank numbers never skip a dropped item.
  return mapped.filter(Boolean).map(({ preview, item }, i) => {
    if (useArt) {
      applyArt(preview, item, stremioType, art, (opts.rankStart || 1) + i);
    } else if (client.rpdbKey && posterShape !== 'landscape') {
      // RPDB ratings-badge posters only make sense on portrait posters.
      const rpdb = rpdbPosterUrl(client.rpdbKey, preview.id);
      if (rpdb) preview.poster = rpdb;
    }
    return preview;
  });
}

/**
 * Build meta previews from an ordered list of tt (IMDB) ids (used by the
 * MDBList source). Each id is resolved to its TMDB record via /find to get
 * artwork and metadata; order is preserved; adult and unresolvable items are
 * dropped. RPDB poster swap applies the same as for TMDB rows.
 */
async function previewsFromImdbIds(client, imdbIds, opts) {
  const stremioType = opts.stremioType;
  const mediaType = stremioType === 'series' ? 'tv' : 'movie';
  const posterShape = opts.posterShape || 'poster';
  const concurrency = opts.concurrency || 10;
  const art = opts.art || 'tile';
  const useArt = wantsArt(art);

  const mapped = await mapWithConcurrency(imdbIds, concurrency, async (imdbId) => {
    let found;
    try {
      const data = await client.get(`/find/${imdbId}`, { external_source: 'imdb_id' });
      const arr = mediaType === 'tv' ? data.tv_results : data.movie_results;
      found = arr && arr[0];
    } catch {
      found = null;
    }
    if (!found || isAdult(found) || !hasArtInputs(found, art)) return null;
    const { preview } = toPartialPreview(found, stremioType, posterShape);
    preview.id = imdbId;
    return { preview, item: found };
  });

  return mapped.filter(Boolean).map(({ preview, item }, i) => {
    if (useArt) {
      applyArt(preview, item, stremioType, art, (opts.rankStart || 1) + i);
    } else if (client.rpdbKey && posterShape !== 'landscape') {
      const rpdb = rpdbPosterUrl(client.rpdbKey, preview.id);
      if (rpdb) preview.poster = rpdb;
    }
    return preview;
  });
}

module.exports = {
  toMetaPreviews,
  toPartialPreview,
  resolveImdbId,
  previewsFromImdbIds,
  mapWithConcurrency,
  isAdult,
  _imdbCache: imdbCache,
};

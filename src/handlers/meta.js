'use strict';

/**
 * Meta handler — full detail pages.
 *
 * The catalog emits tt (IMDB) ids. This handler builds a rich Stremio Meta from
 * TMDB (cast, director, writer, trailers, genres, runtime, and for series the
 * full episode `videos` array), then optionally layers a fanart.tv clearlogo
 * and better background when FANART_API_KEY is set.
 *
 * Enabled whenever a TMDB key is present. Returns null (handler disabled) only
 * when there is no TMDB key, in which case Cinemeta supplies detail pages.
 *
 * HONEST LIMITATION: still images only. The Stremio protocol cannot deliver UI
 * animation or animated artwork; motion is owned by the Nuvio/Stremio client.
 *
 * Fail-safe: any lookup failure falls back to a minimal valid meta (never
 * throws), so Cinemeta can still fill gaps.
 */

const { createTmdbClient } = require('../tmdb/client');
const { createFanartClient } = require('../images/fanart');
const { buildMeta } = require('../tmdb/meta');
const { createAnilistClient } = require('../sources/anilist');

function createMetaHandler(config, deps = {}) {
  const client = deps.client || createTmdbClient({ language: config.defaults.language });
  // Disable only when there's no way to build richer metadata than Cinemeta.
  if (!client.hasKey() && !deps.client) return null;

  const fanart = deps.fanart !== undefined ? deps.fanart : createFanartClient();
  const anilist = deps.anilist !== undefined ? deps.anilist : createAnilistClient();

  function looksLikeAnime(meta) {
    const g = meta.genres || [];
    return g.includes('Animation') || g.includes('Anime');
  }

  async function tvdbIdFrom(external_ids, tmdbId) {
    if (external_ids && external_ids.tvdb_id) return external_ids.tvdb_id;
    try {
      const data = await client.get(`/tv/${tmdbId}/external_ids`);
      return data && data.tvdb_id ? data.tvdb_id : null;
    } catch {
      return null;
    }
  }

  return async function metaHandler(args) {
    const { type, id } = args;
    if (!id || !id.startsWith('tt')) return { meta: null };

    let built;
    try {
      built = await buildMeta(client, id, type);
    } catch {
      built = null;
    }
    if (!built) {
      // Minimal valid meta so the client/Cinemeta can merge the rest.
      return { meta: { id, type, name: id } };
    }

    const { meta, tmdbId, external_ids } = built;

    // Optional AniList enrichment for anime: merge extra genres + a score note.
    if (anilist && looksLikeAnime(meta)) {
      try {
        const extra = await anilist.enrich(meta.name, meta.releaseInfo);
        if (extra.genres) {
          meta.genres = [...new Set([...(meta.genres || []), ...extra.genres])];
        }
        if (extra.anilistRating && !meta.imdbRating) {
          meta.imdbRating = extra.anilistRating;
        }
      } catch {
        // keep the TMDB-based meta
      }
    }

    // Optional fanart.tv enrichment: transparent clearlogo + better background.
    if (fanart) {
      try {
        let art = {};
        if (type === 'series') {
          const tvdbId = await tvdbIdFrom(external_ids, tmdbId);
          art = await fanart.tv(tvdbId);
        } else {
          art = await fanart.movie(id);
        }
        if (art.logo) meta.logo = art.logo;
        if (art.background) meta.background = art.background;
      } catch {
        // keep the TMDB-based meta
      }
    }

    return {
      meta,
      cacheMaxAge: 6 * 3600,
      staleRevalidate: 6 * 3600,
      staleError: 24 * 3600,
    };
  };
}

module.exports = { createMetaHandler };

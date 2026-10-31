'use strict';

/**
 * Optional fanart.tv enrichment.
 *
 * fanart.tv provides high-quality, transparent-PNG clearlogos and extra
 * backgrounds keyed by IMDB/TMDB id (movies) or TheTVDB id (TV). We use it only
 * to improve the `logo` (and optionally `background`) on detail pages.
 *
 * HONEST LIMITATION: these are STILL images. Neither fanart.tv nor the Stremio
 * addon protocol can deliver animated artwork or UI motion — animation is owned
 * by the Nuvio/Stremio client. This module never promises animation.
 *
 * Entirely optional: with no FANART_API_KEY the factory returns null and the
 * addon falls back to TMDB/Cinemeta artwork.
 */

const FANART_BASE = 'https://webservice.fanart.tv/v3';

function createFanartClient(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.FANART_API_KEY;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!apiKey) return null;

  const cache = new Map();

  async function get(pathPart) {
    const url = `${FANART_BASE}${pathPart}?api_key=${encodeURIComponent(apiKey)}`;
    if (cache.has(pathPart)) return cache.get(pathPart);
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        cache.set(pathPart, null);
        return null;
      }
      const data = await res.json();
      cache.set(pathPart, data);
      return data;
    } catch {
      return null;
    }
  }

  // Pick the best available English clearlogo (hd first), else any.
  function pickLogo(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    const en = list.filter((x) => x.lang === 'en');
    const pool = en.length ? en : list;
    return pool[0] && pool[0].url ? pool[0].url : undefined;
  }

  return {
    /**
     * Movie logo by IMDB tt id. Returns { logo?, background? } or {}.
     */
    async movie(imdbId) {
      const data = await get(`/movies/${imdbId}`);
      if (!data) return {};
      const out = {};
      const logo = pickLogo(data.hdmovielogo || data.movielogo);
      if (logo) out.logo = logo;
      const bg = pickLogo(data.moviebackground);
      if (bg) out.background = bg;
      return out;
    },

    /**
     * TV logo by TheTVDB id. Returns { logo?, background? } or {}.
     */
    async tv(tvdbId) {
      if (!tvdbId) return {};
      const data = await get(`/tv/${tvdbId}`);
      if (!data) return {};
      const out = {};
      const logo = pickLogo(data.hdtvlogo || data.clearlogo);
      if (logo) out.logo = logo;
      const bg = pickLogo(data.showbackground);
      if (bg) out.background = bg;
      return out;
    },
  };
}

module.exports = { createFanartClient, FANART_BASE };

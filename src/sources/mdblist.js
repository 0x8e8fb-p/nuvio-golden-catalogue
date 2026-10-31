'use strict';

/**
 * Keyless MDBList public-list source.
 *
 * MDBList aggregates community lists from IMDb, Trakt, Letterboxd and TMDB, and
 * exposes any PUBLIC list as JSON with no API key:
 *   https://mdblist.com/lists/<user>/<slug>/json
 * Each item carries an imdb_id and mediatype, which is exactly what we need:
 * the items already have playable tt ids, so these rows work with the user's
 * existing stream addons. This unlocks genuinely curated rows (IMDb Top 250,
 * award winners, editorial "best of" lists) that cannot be reproduced from
 * TMDB discover filters.
 *
 * We fetch the list (cached), filter by the row's Stremio type, drop adult
 * items, then hand the tt ids to the mapper which enriches artwork/metadata
 * from TMDB. Entirely best-effort: a fetch failure yields an empty row rather
 * than an error on the TV.
 */

const { TtlLruCache } = require('../lib/cache');

const listCache = new TtlLruCache({ ttl: 6 * 60 * 60 * 1000, max: 200 });

function normaliseListUrl(url) {
  // Accept either a full .../json URL or a plain list page URL and coerce to json.
  if (/\/json\/?$/.test(url)) return url;
  return url.replace(/\/$/, '') + '/json';
}

function stremioToMediatype(type) {
  return type === 'series' ? 'show' : 'movie';
}

function createMdblistSource(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function fetchList(url) {
    const key = url;
    const cached = listCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const res = await fetchImpl(normaliseListUrl(url), {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        listCache.set(key, []);
        return [];
      }
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];
      listCache.set(key, items);
      return items;
    } catch {
      return [];
    }
  }

  return {
    /**
     * Return tt ids for a list, filtered to the Stremio type, adult-free, in
     * the list's own order. windowStart/windowEnd slice for pagination.
     */
    async imdbIds(url, type, windowStart = 0, windowEnd = 50) {
      const items = await fetchList(url);
      const wantMedia = stremioToMediatype(type);
      const ids = items
        .filter((it) => it && it.adult !== 1 && it.adult !== true)
        .filter((it) => !it.mediatype || it.mediatype === wantMedia)
        .map((it) => it.imdb_id)
        .filter((id) => typeof id === 'string' && id.startsWith('tt'));
      return ids.slice(windowStart, windowEnd);
    },
  };
}

module.exports = { createMdblistSource, normaliseListUrl, _listCache: listCache };

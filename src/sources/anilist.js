'use strict';

/**
 * Optional AniList enrichment for anime.
 *
 * AniList (GraphQL, no API key) has richer anime data than TMDB: community
 * scores, romaji/english titles and precise genres/tags. We use it only to
 * ENRICH an anime meta page that is already built from TMDB — never as a source
 * of ids. The item keeps its tt (IMDB) id so Cinemeta and stream addons keep
 * working; AniList can only add an averageScore and extra genres.
 *
 * Matching: AniList has no TMDB/IMDB mapping, so we search by title (+year) and
 * take the closest match. This is best-effort; a miss simply adds nothing.
 *
 * Disabled by default (opt-in via ENABLE_ANILIST=1) to avoid an extra network
 * hop on every anime detail open unless the operator wants it.
 */

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';

const SEARCH_QUERY = `
query ($search: String, $seasonYear: Int) {
  Media(search: $search, type: ANIME, seasonYear: $seasonYear, sort: SEARCH_MATCH) {
    id
    averageScore
    genres
    episodes
    duration
    title { romaji english }
  }
}`;

function enabled() {
  return process.env.ENABLE_ANILIST === '1';
}

function createAnilistClient(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!opts.force && !enabled()) return null;

  const cache = new Map();

  async function search(title, year) {
    const key = `${title}:${year || ''}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const res = await fetchImpl(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          variables: { search: title, seasonYear: year ? Number(year) : undefined },
        }),
      });
      if (!res.ok) {
        cache.set(key, null);
        return null;
      }
      const json = await res.json();
      const media = json && json.data && json.data.Media ? json.data.Media : null;
      cache.set(key, media);
      return media;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Returns { averageScore?, genres? } to merge into a meta, or {}.
     */
    async enrich(title, year) {
      const m = await search(title, year);
      if (!m) return {};
      const out = {};
      if (typeof m.averageScore === 'number' && m.averageScore > 0) {
        // AniList score is 0-100; expose as a 0-10 rating string.
        out.anilistRating = (m.averageScore / 10).toFixed(1);
      }
      if (Array.isArray(m.genres) && m.genres.length) out.genres = m.genres;
      return out;
    },
  };
}

module.exports = { createAnilistClient, enabled, ANILIST_ENDPOINT };

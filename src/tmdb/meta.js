'use strict';

/**
 * Builds a full Stremio Meta object from TMDB detail data.
 *
 * The catalog emits tt (IMDB) ids, so the meta handler receives a tt id. We
 * resolve it to a TMDB id via /find, then fetch rich details in a single call
 * with append_to_response (external_ids, credits, videos). For series we also
 * fetch season data to build the Stremio `videos` (episode) array, which is
 * what drives the episode list and the per-episode stream requests.
 *
 * Everything is best-effort: any missing field is simply omitted so the client
 * (and Cinemeta) can fill gaps. Still images only; the protocol has no motion.
 */

const { posterUrl, backdropUrl } = require('./client');
const { artEnabled, logoUrl } = require('../art/urls');

const YT = (key) => ({ source: key, type: 'Trailer' });

function pickTrailers(videosBlock) {
  const results = (videosBlock && videosBlock.results) || [];
  return results
    .filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
    .slice(0, 5)
    .map((v) => YT(v.key));
}

function creditNames(credits, key, limit) {
  const arr = (credits && credits[key]) || [];
  if (key === 'cast') {
    return arr.slice(0, limit).map((c) => c.name);
  }
  return arr
    .filter((c) => c.job === key || c.known_for_department)
    .map((c) => c.name);
}

function crewByJob(credits, job, limit) {
  const arr = (credits && credits.crew) || [];
  return arr
    .filter((c) => c.job === job)
    .slice(0, limit || 5)
    .map((c) => c.name);
}

function runtimeString(minutes) {
  if (!minutes || minutes <= 0) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Resolve a tt (IMDB) id to a TMDB result for the given Stremio type.
 */
async function findByImdb(client, imdbId, type) {
  const data = await client.get(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const arr = type === 'series' ? data.tv_results : data.movie_results;
  return arr && arr[0] ? arr[0] : null;
}

/**
 * Build the `videos` (episode) array for a series by fetching its seasons.
 * Episode ids follow Stremio's convention: `<ttId>:<season>:<episode>`.
 */
async function buildSeriesVideos(client, tmdbId, imdbId, seasons) {
  const realSeasons = (seasons || [])
    .filter((s) => s.season_number > 0) // skip "Specials" (season 0) for the main list
    .map((s) => s.season_number);
  if (!realSeasons.length && seasons && seasons.length) {
    realSeasons.push(...seasons.map((s) => s.season_number));
  }

  const videos = [];
  // TMDB lets us append several seasons in one call (season/1,season/2,...).
  // Chunk to keep URLs sane.
  const CHUNK = 6;
  for (let i = 0; i < realSeasons.length; i += CHUNK) {
    const chunk = realSeasons.slice(i, i + CHUNK);
    const append = chunk.map((n) => `season/${n}`).join(',');
    let data;
    try {
      data = await client.get(`/tv/${tmdbId}`, { append_to_response: append });
    } catch {
      continue;
    }
    for (const n of chunk) {
      const season = data[`season/${n}`];
      if (!season || !Array.isArray(season.episodes)) continue;
      for (const ep of season.episodes) {
        videos.push({
          id: `${imdbId}:${n}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: n,
          episode: ep.episode_number,
          released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
          overview: ep.overview || undefined,
          thumbnail: ep.still_path ? backdropUrl(ep.still_path) : undefined,
        });
      }
    }
  }
  return videos;
}

/**
 * Build a full Meta object for a tt id. Returns null if not resolvable.
 */
async function buildMeta(client, imdbId, type) {
  const found = await findByImdb(client, imdbId, type);
  if (!found) return null;

  const tmdbId = found.id;
  const mediaType = type === 'series' ? 'tv' : 'movie';

  let detail;
  try {
    detail = await client.get(`/${mediaType}/${tmdbId}`, {
      append_to_response: 'external_ids,credits,videos',
    });
  } catch {
    detail = found;
  }

  const name = detail.title || detail.name;
  const date = detail.release_date || detail.first_air_date;
  const genres = (detail.genres || []).map((g) => g.name);

  const meta = {
    id: imdbId,
    type,
    name,
    poster: posterUrl(detail.poster_path),
    background: backdropUrl(detail.backdrop_path),
    description: detail.overview || undefined,
    genres: genres.length ? genres : undefined,
    releaseInfo: date ? String(date).slice(0, 4) : undefined,
    released: date ? `${date}T00:00:00.000Z` : undefined,
    imdbRating:
      typeof detail.vote_average === 'number' && detail.vote_average > 0
        ? detail.vote_average.toFixed(1)
        : undefined,
    cast: creditNames(detail.credits, 'cast', 10),
  };

  // Same transparent title logo as the catalog tile (redirects to TMDB, 404s
  // cleanly when a title has none, and Nuvio then shows the title text).
  if (artEnabled()) {
    meta.logo = logoUrl({ type, tmdbId, lang: detail.original_language });
  }

  const directors = crewByJob(detail.credits, 'Director', 3);
  if (directors.length) meta.director = directors;
  const writers = crewByJob(detail.credits, 'Writer', 3).concat(
    crewByJob(detail.credits, 'Screenplay', 3)
  );
  if (writers.length) meta.writer = [...new Set(writers)];

  const trailers = pickTrailers(detail.videos);
  if (trailers.length) meta.trailers = trailers;

  if (mediaType === 'movie') {
    const rt = runtimeString(detail.runtime);
    if (rt) meta.runtime = rt;
  } else {
    const rt = runtimeString((detail.episode_run_time || [])[0]);
    if (rt) meta.runtime = rt;
    // Series: build the episode list.
    meta.videos = await buildSeriesVideos(client, tmdbId, imdbId, detail.seasons);
    // releaseInfo range for series, e.g. "2011-2019" / "2011-"
    const first = detail.first_air_date ? detail.first_air_date.slice(0, 4) : '';
    const last = detail.last_air_date ? detail.last_air_date.slice(0, 4) : '';
    if (first) {
      meta.releaseInfo =
        detail.status === 'Ended' && last && last !== first
          ? `${first}-${last}`
          : `${first}-`;
    }
  }

  // Clean undefined keys.
  for (const k of Object.keys(meta)) {
    if (meta[k] === undefined) delete meta[k];
  }
  return { meta, tmdbId, external_ids: detail.external_ids || {} };
}

module.exports = { buildMeta, findByImdb, runtimeString };

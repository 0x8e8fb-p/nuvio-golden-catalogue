'use strict';

/**
 * Picks title logos and brand logos from TMDB.
 *
 * Title logos: GET /{movie|tv}/{id}/images with include_image_language. The
 * order of preference is English, then the title's original language (an
 * Indian film's logo in its own script), then language-less logos; within a
 * language, the highest rated. Results are cached per title.
 *
 * Brand logos: GET /network/{id} and /company/{id} (logo_path). Most brand
 * folders carry a verified logo path in data/, so these calls are a fallback.
 *
 * bestLogo() and entityLogo() tell "no logo" apart from "lookup failed", so
 * artwork drawn after a failed lookup is not cached as if it were final. Only
 * answers from TMDB are cached.
 */

const { TtlLruCache } = require('../lib/cache');
const { isImagePath } = require('./fetch-image');

const logoCache = new TtlLruCache({ ttl: 24 * 60 * 60 * 1000, max: 5000 });
const ENTITY_KINDS = new Set(['network', 'company']);

function rankLogo(logo, langs) {
  const lang = logo.iso_639_1 || null;
  const idx = langs.indexOf(lang);
  return [idx < 0 ? langs.length : idx, -(Number(logo.vote_average) || 0), -(Number(logo.width) || 0)];
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// TMDB answers 404 for a record it does not have: that record has no logo. Any
// other error (network, 5xx, rate limit, open circuit) may pass, so it is a failure.
const notFound = (err) => Boolean(err && err.status === 404);

/**
 * Best title logo for a movie or show.
 *
 * ok is false when the lookup failed and may succeed later; that result is not
 * cached. ok is true with a null path when TMDB has no usable logo for the
 * title, and when no lookup can be made (no TMDB key, invalid id).
 * @param {object} client TMDB client
 * @param {'movie'|'tv'} mediaType
 * @param {number} tmdbId
 * @param {string} [originalLanguage] e.g. "te"
 * @returns {Promise<{path: string|null, ok: boolean}>}
 */
async function bestLogo(client, mediaType, tmdbId, originalLanguage) {
  if (!client || !client.hasKey() || !Number.isInteger(tmdbId) || tmdbId <= 0) return { path: null, ok: true };
  const ol = /^[a-z]{2}$/.test(originalLanguage || '') ? originalLanguage : null;
  const key = `${mediaType}:${tmdbId}:${ol || ''}`;
  const hit = logoCache.get(key);
  if (hit !== undefined) return { path: hit, ok: true };
  const langs = ['en', ...(ol && ol !== 'en' ? [ol] : []), null];
  let path = null;
  try {
    const data = await client.get(`/${mediaType}/${tmdbId}/images`, {
      include_image_language: langs.map((l) => l || 'null').join(','),
      language: null,
    });
    const logos = ((data && data.logos) || []).filter((l) => isImagePath(l.file_path));
    logos.sort((a, b) => compareRank(rankLogo(a, langs), rankLogo(b, langs)));
    path = logos.length ? logos[0].file_path.replace(/\.svg$/i, '.png') : null;
  } catch (err) {
    if (!notFound(err)) return { path: null, ok: false };
  }
  logoCache.set(key, path);
  return { path, ok: true };
}

/**
 * Best title logo file path for a movie or show, or null (no logo, or the
 * lookup failed). Use bestLogo() to tell the two apart.
 * @param {object} client TMDB client
 * @param {'movie'|'tv'} mediaType
 * @param {number} tmdbId
 * @param {string} [originalLanguage] e.g. "te"
 * @returns {Promise<string|null>}
 */
async function bestLogoPath(client, mediaType, tmdbId, originalLanguage) {
  return (await bestLogo(client, mediaType, tmdbId, originalLanguage)).path;
}

/**
 * Logo of a TMDB network or company, with the same contract as bestLogo().
 * @param {object} client TMDB client
 * @param {'network'|'company'} kind
 * @param {number} id
 * @returns {Promise<{path: string|null, ok: boolean}>}
 */
async function entityLogo(client, kind, id) {
  if (!client || !client.hasKey() || !ENTITY_KINDS.has(kind) || !Number.isInteger(id) || id <= 0) {
    return { path: null, ok: true };
  }
  const key = `${kind}:${id}`;
  const hit = logoCache.get(key);
  if (hit !== undefined) return { path: hit, ok: true };
  let path = null;
  try {
    const data = await client.get(`/${kind}/${id}`);
    path = data && isImagePath(data.logo_path) ? data.logo_path.replace(/\.svg$/i, '.png') : null;
  } catch (err) {
    if (!notFound(err)) return { path: null, ok: false };
  }
  logoCache.set(key, path);
  return { path, ok: true };
}

/** TMDB network logo path, or null. */
const networkLogoPath = async (client, id) => (await entityLogo(client, 'network', id)).path;
/** TMDB company logo path, or null. */
const companyLogoPath = async (client, id) => (await entityLogo(client, 'company', id)).path;

module.exports = { bestLogo, bestLogoPath, entityLogo, networkLogoPath, companyLogoPath, _logoCache: logoCache };

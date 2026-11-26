'use strict';

/**
 * Builders for every artwork URL the addon hands to Nuvio.
 *
 * Item art (tiles, rank tiles, logos) is signed, because its inputs are open
 * ended. Folder art (collection covers, focus loops, heroes, logos) is not
 * signed: folder keys come from a fixed pack, and imported collections must
 * keep working even if the signing secret changes.
 *
 * Artwork is only produced when the public origin of the request is known
 * (it always is behind HTTP) and ART_MODE is not "posters".
 */

const { currentOrigin } = require('../lib/request-context');
const { buildArtUrl } = require('./sign');
const { isImagePath } = require('./fetch-image');
const { folderArtVersion } = require('./plan');

/** Are generated artwork URLs available for the current request? */
function artEnabled() {
  return process.env.ART_MODE !== 'posters' && Boolean(currentOrigin());
}

const short = (s, n) => (s ? String(s).slice(0, n) : undefined);
const imgPath = (p) => (isImagePath(p) ? p : undefined);

/**
 * Landscape title tile: backdrop + title logo (or wordmark). Without a usable backdrop
 * the poster path goes in `p` instead, for the poster layout; URLs of titles that have
 * a backdrop stay exactly as they were.
 * @param {{type: 'movie'|'series', tmdbId: number, backdrop?: string, poster?: string,
 *   title?: string, lang?: string}} a
 */
function tileUrl(a) {
  const backdrop = imgPath(a.backdrop);
  return buildArtUrl(currentOrigin(), '/art/tile.jpg', {
    t: a.type === 'series' ? 'series' : 'movie',
    id: a.tmdbId,
    b: backdrop,
    p: backdrop ? undefined : imgPath(a.poster),
    n: short(a.title, 80),
    ol: short(a.lang, 2),
  });
}

/**
 * Top 10 tile: outlined numeral + poster over blurred art.
 * @param {{rank: number, poster?: string, backdrop?: string}} a
 */
function rankUrl(a) {
  return buildArtUrl(currentOrigin(), '/art/rank.jpg', {
    r: a.rank,
    p: imgPath(a.poster),
    b: imgPath(a.backdrop),
  });
}

/**
 * Title logo (redirects to TMDB's PNG, 404 when none exists).
 * @param {{type: 'movie'|'series', tmdbId: number, lang?: string}} a
 */
function logoUrl(a) {
  return buildArtUrl(currentOrigin(), '/art/logo.png', {
    t: a.type === 'series' ? 'series' : 'movie',
    id: a.tmdbId,
    ol: short(a.lang, 2),
  });
}

/**
 * Collection folder art. kind: cover | focus | hero | video | logo.
 * @param {string} origin public origin
 * @param {string} region e.g. "IN"
 * @param {string} key folder id
 * @param {'cover'|'focus'|'hero'|'video'|'logo'} kind
 * @param {{shape?: string, format?: 'webp'|'gif'}} [opts] format applies to focus loops:
 *   WebP by default; GIF for TVs on Android 8 or older, which cannot animate WebP
 */
function folderArtUrl(origin, region, key, kind, opts = {}) {
  const focus = opts.format === 'gif' ? 'focus.gif' : 'focus.webp';
  const file = { cover: 'cover.jpg', focus, hero: 'hero.jpg', video: 'hero.mp4', logo: 'logo.png' }[kind];
  const qs = new URLSearchParams({ v: folderArtVersion(region) });
  if (opts.shape && (kind === 'cover' || kind === 'focus')) qs.set('shape', opts.shape);
  return `${origin}/art/folder/${encodeURIComponent(region)}/${encodeURIComponent(key)}/${file}?${qs}`;
}

/**
 * A collection's own backdrop (1920x1080), an image no folder of the pack shows.
 * @param {string} origin public origin
 * @param {string} region e.g. "IN"
 * @param {string} id collection id
 */
function collectionArtUrl(origin, region, id) {
  const qs = new URLSearchParams({ v: folderArtVersion(region) });
  return `${origin}/art/collection/${encodeURIComponent(region)}/${encodeURIComponent(id)}/backdrop.jpg?${qs}`;
}
module.exports = { artEnabled, tileUrl, rankUrl, logoUrl, folderArtUrl, collectionArtUrl };

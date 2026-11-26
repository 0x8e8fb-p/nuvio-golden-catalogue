'use strict';

/**
 * Builds the Nuvio collections pack for a region: the JSON array Nuvio
 * imports from Settings > Content & Discovery > Collections > Import > URL.
 *
 * The pack is a three-level tree:
 *   collection (a home row of tiles, e.g. "Streaming")
 *     > folder (a tile, e.g. "Netflix", with cover, focus loop, hero video)
 *       > rows (named rows on the folder page: "Trending Movies",
 *         "Original Series", "Top Rated Shows", ...)
 * A group folder ("Indian Studios") has one row per member folder, labelled
 * "Movies · Hombale Films": Nuvio names a row after its catalog plus the
 * source's genre, so the member name travels as the genre.
 *
 * The shape follows Nuvio's importer (CollectionsDataStore.kt). Every field
 * is written out, because Nuvio's Gson parser skips Kotlin defaults: a
 * missing showAllTab would become false and a missing tileShape POSTER.
 * Collections use FOLLOW_LAYOUT: a folder opens in the home layout, with a
 * hero and one row per source. showAllTab is off, since an "All" row would
 * repeat the named rows.
 *
 * Folder art: coverImageUrl (static), focusGifUrl (animated loop on focus),
 * heroBackdropUrl (the hero still), heroVideoUrl (a short MP4 in the folder's
 * signature motion, played once by Nuvio TV's Modern home when the tile is
 * focused; it starts and ends on the hero still, so the hand-over is
 * seamless), titleLogoUrl (brand logo or wordmark). backdropImageUrl on a
 * collection is the fallback art for its folders (used by Nuvio mobile).
 *
 * Collection and folder ids are stable across versions, so importing the URL
 * again updates the pack in place instead of duplicating it.
 */

const { regionFolders } = require('./engine');
const { rowCatalogId } = require('./facets');
const { folderArtUrl, collectionArtUrl } = require('../art/urls');
const { videoEnabled } = require('../art/video');

const SHAPE_ENUM = { landscape: 'LANDSCAPE', poster: 'POSTER', square: 'SQUARE' };

/** Nuvio sources for a folder's rows. */
function folderSourcesFor(folder, addonId) {
  return folder.rows.map((row) => {
    const source = { provider: 'addon', addonId, type: row.type, catalogId: rowCatalogId(row.type, row.key, row.facet) };
    if (row.label) source.genre = row.label;
    return source;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.region two-letter region code
 * @param {string} opts.origin public origin of this addon, e.g. https://x.vercel.app
 * @param {string} opts.addonId manifest id of the region edition the pack points at
 * @param {'webp'|'gif'} [opts.focusFormat] focus loop format: WebP (default), or GIF
 *   for TVs on Android 8 or older, where Nuvio cannot animate WebP
 * @param {boolean} [opts.motion] animated focus loops and hero videos (default true);
 *   false gives a still pack for slow devices
 * @param {boolean} [opts.video] hero videos (default: when the encoder is available)
 * @returns {object[]} Nuvio collections array
 */
function buildPack({ region, origin, addonId, focusFormat = 'webp', motion = true, video }) {
  const { collections } = regionFolders(region);
  const withVideo = motion && (video === undefined ? videoEnabled() : Boolean(video));
  return collections.map((collection) => {
    return {
      id: `golden-${collection.id}`,
      title: collection.title,
      // A backdrop of its own, not one of its folders' heroes.
      backdropImageUrl: collectionArtUrl(origin, region, collection.id),
      pinToTop: Boolean(collection.pinToTop),
      focusGlowEnabled: true,
      viewMode: 'FOLLOW_LAYOUT',
      showAllTab: false,
      folders: collection.entries.map((folder) => {
        const shape = folder.shape;
        return {
          id: `golden-${collection.id}-${folder.key}`,
          title: folder.title,
          tileShape: SHAPE_ENUM[shape] || 'LANDSCAPE',
          // The cover already shows the name or the brand logo, large and crisp.
          hideTitle: true,
          coverImageUrl: folderArtUrl(origin, region, folder.key, 'cover', { shape }),
          focusGifUrl: motion ? folderArtUrl(origin, region, folder.key, 'focus', { shape, format: focusFormat }) : null,
          focusGifEnabled: Boolean(motion),
          heroBackdropUrl: folderArtUrl(origin, region, folder.key, 'hero'),
          heroVideoUrl: withVideo ? folderArtUrl(origin, region, folder.key, 'video') : null,
          titleLogoUrl: folderArtUrl(origin, region, folder.key, 'logo'),
          sources: folderSourcesFor(folder, addonId),
        };
      }),
    };
  });
}

/** Summary counts for the landing page and health checks. */
function packStats(region) {
  const { collections } = regionFolders(region);
  const tiles = collections.reduce((n, c) => n + c.entries.length, 0);
  const rows = collections.reduce((n, c) => n + c.entries.reduce((m, f) => m + f.rows.length, 0), 0);
  return { collections: collections.length, folders: tiles, rows };
}

module.exports = { buildPack, packStats };

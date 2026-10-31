'use strict';

/**
 * Builds the Nuvio collections pack for a region: the JSON array Nuvio TV
 * imports from Settings > Content & Discovery > Collections > Import > URL.
 *
 * The shape follows Nuvio's importer (CollectionsDataStore.kt): collections
 * with id, title, pinToTop, focusGlowEnabled, viewMode, showAllTab, folders;
 * folders with id, title, tileShape, hideTitle, coverImageUrl, focusGifUrl,
 * focusGifEnabled, heroBackdropUrl, titleLogoUrl and sources. Every field is
 * written out, because Nuvio's Gson parser skips Kotlin defaults: a missing
 * showAllTab would become false and a missing tileShape POSTER.
 *
 * Each source is an addon catalog of this addon: { provider: "addon",
 * addonId, type, catalogId: "gc-movie,<folder>" }. Nuvio resolves the catalog
 * by the part before the comma, so the tab keeps the declared catalog's
 * pageSize and skip support, and is labelled "Movies" or "Shows". The region
 * comes from the edition the addon was installed from.
 *
 * Covers carry the folder name or brand logo, so the tile text is hidden;
 * titleLogoUrl is a generated transparent logo for every folder, so the home
 * hero still shows what the folder is.
 *
 * Collection and folder ids are stable across versions, so importing the URL
 * again updates the pack in place instead of duplicating it.
 */

const { regionFolders, folderCatalogId } = require('./engine');
const { folderArtUrl } = require('../art/urls');

const SHAPE_ENUM = { landscape: 'LANDSCAPE', poster: 'POSTER', square: 'SQUARE' };

/**
 * @param {object} opts
 * @param {string} opts.region two-letter region code
 * @param {string} opts.origin public origin of this addon, e.g. https://x.vercel.app
 * @param {string} opts.addonId manifest id of the region edition the pack points at
 * @param {'webp'|'gif'} [opts.focusFormat] focus loop format: WebP (default), or GIF
 *   for TVs on Android 8 or older, where Nuvio cannot animate WebP
 * @returns {object[]} Nuvio collections array
 */
function buildPack({ region, origin, addonId, focusFormat = 'webp' }) {
  const { collections } = regionFolders(region);
  return collections.map((collection) => ({
    id: `golden-${collection.id}`,
    title: collection.title,
    pinToTop: Boolean(collection.pinToTop),
    focusGlowEnabled: true,
    viewMode: 'TABBED_GRID',
    showAllTab: true,
    folders: collection.entries.map((folder) => {
      const shape = folder.shape;
      return {
        id: `golden-${collection.id}-${folder.key}`,
        title: folder.title,
        tileShape: SHAPE_ENUM[shape] || 'LANDSCAPE',
        // The cover already shows the name or the brand logo, large and crisp.
        hideTitle: true,
        coverImageUrl: folderArtUrl(origin, region, folder.key, 'cover', { shape }),
        focusGifUrl: folderArtUrl(origin, region, folder.key, 'focus', { shape, format: focusFormat }),
        focusGifEnabled: true,
        heroBackdropUrl: folderArtUrl(origin, region, folder.key, 'hero'),
        titleLogoUrl: folderArtUrl(origin, region, folder.key, 'logo'),
        sources: folder.types.map((type) => ({
          provider: 'addon',
          addonId,
          type,
          catalogId: folderCatalogId(type, folder.key),
        })),
      };
    }),
  }));
}

/** Summary counts for the landing page and health checks. */
function packStats(region) {
  const { collections, folders } = regionFolders(region);
  return { collections: collections.length, folders: folders.size };
}

module.exports = { buildPack, packStats };

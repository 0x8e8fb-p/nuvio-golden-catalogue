'use strict';

/**
 * Shared JSDoc typedefs. Importing this file is unnecessary at runtime; it
 * exists so editors and `node --check`-style tooling can reason about the
 * config and meta shapes without a TypeScript build step.
 *
 * @typedef {'movie'|'series'} StremioType
 * @typedef {'poster'|'landscape'|'square'} PosterShape
 *
 * @typedef {Object} ExtraDef
 * @property {'genre'|'search'|'skip'} name
 * @property {boolean} [isRequired]
 * @property {string[]} [options]
 * @property {{param?: string, lookup?: 'tmdbGenreId'}} [mapTo]
 *
 * @typedef {Object} CatalogueRow
 * @property {string} id            Unique kebab-case id.
 * @property {StremioType} type
 * @property {string} name          Row title shown in Nuvio.
 * @property {number} [order]       Ascending position.
 * @property {boolean} [featured]   In the default manifest (default true).
 * @property {string} [group]       Human grouping; maps to a preset.
 * @property {PosterShape} [posterShape]
 * @property {{endpoint: string, params?: Object.<string, string|number|boolean>}} source
 * @property {ExtraDef[]} [extra]
 *
 * @typedef {Object} Defaults
 * @property {string} language
 * @property {string} region
 * @property {PosterShape} posterShape
 * @property {number} pageSize
 *
 * @typedef {Object} AddonConfig
 * @property {{id:string, version:string, name:string, description:string, logo?:string, background?:string, contactEmail?:string}} addon
 * @property {Defaults} defaults
 * @property {CatalogueRow[]} catalogues
 * @property {Object} genres
 *
 * @typedef {Object} MetaPreview
 * @property {string} id            tt IMDB id.
 * @property {StremioType} type
 * @property {string} name
 * @property {string} poster
 * @property {PosterShape} [posterShape]
 * @property {string} [background]
 * @property {string} [releaseInfo]
 * @property {string} [imdbRating]
 * @property {string} [description]
 */

module.exports = {};

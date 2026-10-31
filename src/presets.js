'use strict';

/**
 * Presets: themed, lean manifests served at distinct URLs.
 *
 *   /r/<CC>/manifest.json            -> the full region edition (recommended)
 *   /r/<CC>/c/<preset>/manifest.json -> only the rows whose group matches
 *
 * Most people want the full edition plus the collections pack. Presets exist
 * for people who prefer to pick themes, or to install a theme on a second
 * profile. Presets are derived from each row's `group`.
 *
 * Version 2 had 19 presets. Their slugs still resolve (LEGACY_ALIASES), each
 * to the closest current preset, under the addon id it had in v2, so an
 * existing install keeps working instead of turning empty.
 */

const { loadConfig } = require('./lib/config-loader');

const PRESET_DEFINITIONS = {
  spotlight: { name: 'Spotlight', groups: ['Spotlight', 'For Right Now'] },
  indian: { name: 'Indian Cinema', groups: ['Indian Cinema'] },
  streaming: { name: 'Streaming', groups: ['Streaming'] },
  genres: { name: 'Genres', groups: ['Genres'] },
  world: { name: 'Anime and World', groups: ['Anime', 'World'] },
  curated: { name: 'Curated', groups: ['Curated', 'Decades'] },
};

/** v2 slug -> current preset with the closest rows. Not listed on the landing page. */
const LEGACY_ALIASES = {
  movies: 'spotlight',
  series: 'spotlight',
  now: 'spotlight',
  discovery: 'spotlight',
  seasonal: 'spotlight',
  networks: 'streaming',
  studios: 'streaming',
  anime: 'world',
  regional: 'indian',
  docs: 'genres',
  kids: 'genres',
  themes: 'genres',
  runtime: 'genres',
  franchises: 'curated',
  lists: 'curated',
  decades: 'curated',
  onthisday: 'curated',
};

function matchesGroups(groupValue, prefixes) {
  if (!groupValue) return false;
  return prefixes.some((p) => groupValue.startsWith(p));
}

/** The current preset a slug stands for (itself, or a v2 alias), or null. */
function resolvePreset(slug) {
  if (Object.prototype.hasOwnProperty.call(PRESET_DEFINITIONS, slug)) return slug;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, slug)) return LEGACY_ALIASES[slug];
  return null;
}

/**
 * Config containing only the rows of one preset, with a namespaced addon id so
 * each preset installs as its own addon. A v2 slug keeps its own id. Null for
 * an unknown preset.
 */
function configForPreset(slug, baseConfig = loadConfig()) {
  const target = resolvePreset(slug);
  if (!target) return null;
  const def = PRESET_DEFINITIONS[target];
  const catalogues = baseConfig.catalogues.filter((row) => matchesGroups(row.group, def.groups));
  if (!catalogues.length) return null;
  return Object.assign({}, baseConfig, {
    catalogues,
    addon: Object.assign({}, baseConfig.addon, {
      id: `${baseConfig.addon.id}.${slug}`,
      name: `${baseConfig.addon.name}: ${def.name}`,
    }),
  });
}

function listPresets(baseConfig = loadConfig()) {
  return Object.entries(PRESET_DEFINITIONS)
    .map(([slug, def]) => ({
      slug,
      name: def.name,
      rows: baseConfig.catalogues.filter((row) => matchesGroups(row.group, def.groups)).length,
    }))
    .filter((p) => p.rows > 0);
}

module.exports = { PRESET_DEFINITIONS, LEGACY_ALIASES, resolvePreset, configForPreset, listPresets };

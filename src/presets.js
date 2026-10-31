'use strict';

/**
 * Presets let the catalogue scale past the Stremio 8KB manifest limit.
 *
 * One addon instance can advertise only ~75 rows in a single manifest. Presets
 * carve the full catalogue into themed, lean manifests served at distinct URLs:
 *
 *   /manifest.json            -> the default curated set (everything that fits)
 *   /c/<preset>/manifest.json -> only the rows whose group matches the preset
 *
 * Install several preset URLs in Nuvio and you collectively get the entire
 * catalogue, each manifest comfortably under 8KB. Presets are derived from the
 * `group` field on each row, so adding a row to a group needs no code changes.
 */

const { loadConfig } = require('./lib/config-loader');

// Maps a preset slug -> the group-name prefixes it includes. A row belongs to a
// preset if its `group` starts with any of the listed prefixes.
const PRESET_DEFINITIONS = {
  movies: { name: 'Movies', groups: ['Movies'] },
  series: { name: 'Series', groups: ['Series'] },
  streaming: { name: 'Streaming Now', groups: ['Streaming'] },
  anime: { name: 'Anime', groups: ['Anime'] },
  docs: { name: 'Documentaries', groups: ['Documentaries'] },
  kids: { name: 'Kids & Family', groups: ['Kids'] },
  decades: { name: 'By Decade', groups: ['By Decade'] },
  regional: { name: 'Regional', groups: ['Regional'] },
  networks: { name: 'Networks', groups: ['Networks'] },
  studios: { name: 'Studios', groups: ['Studios'] },
  franchises: { name: 'Franchises', groups: ['Franchises'] },
  themes: { name: 'Moods & Themes', groups: ['Moods'] },
  seasonal: { name: 'Seasonal', groups: ['Seasonal'] },
  curated: { name: 'Curated', groups: ['Curated'] },
  lists: { name: 'Community Lists', groups: ['Community Lists'] },
  now: { name: 'For Right Now', groups: ['For Right Now'] },
  runtime: { name: 'By Runtime', groups: ['By Runtime'] },
  discovery: { name: 'Discovery', groups: ['Discovery'] },
  onthisday: { name: 'On This Day', groups: ['On This Day'] },
};

function matchesGroups(groupValue, prefixes) {
  if (!groupValue) return false;
  return prefixes.some((p) => groupValue.startsWith(p));
}

/**
 * Return a shallow-cloned config containing only the rows for the given preset
 * slug, with the addon id/name specialised so each preset installs as its own
 * addon in Nuvio. Returns null for an unknown preset.
 */
function configForPreset(slug, baseConfig = loadConfig()) {
  const def = PRESET_DEFINITIONS[slug];
  if (!def) return null;

  const catalogues = baseConfig.catalogues.filter((row) =>
    matchesGroups(row.group, def.groups)
  );
  if (!catalogues.length) return null;

  return Object.assign({}, baseConfig, {
    catalogues,
    addon: Object.assign({}, baseConfig.addon, {
      id: `${baseConfig.addon.id}.${slug}`,
      name: `${baseConfig.addon.name} · ${def.name}`,
    }),
  });
}

function listPresets(baseConfig = loadConfig()) {
  return Object.entries(PRESET_DEFINITIONS)
    .map(([slug, def]) => {
      const count = baseConfig.catalogues.filter((row) =>
        matchesGroups(row.group, def.groups)
      ).length;
      return { slug, name: def.name, rows: count };
    })
    .filter((p) => p.rows > 0);
}

module.exports = { PRESET_DEFINITIONS, configForPreset, listPresets };

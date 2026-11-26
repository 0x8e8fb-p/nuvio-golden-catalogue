'use strict';

/**
 * Landing page: pick a country, then copy two links into Nuvio.
 *
 *   1. The addon (region edition manifest)  -> Settings > Addons > Add Addon
 *   2. The Golden Collections pack          -> Settings > Content & Discovery >
 *                                              Collections > Import > URL
 *
 * Also lists the themed presets (for a second profile) and a Stremio install
 * link. Server-rendered for the default country, so the links show without
 * JavaScript; a small script swaps them when another country is picked.
 * No framework, no external assets.
 */

const { knownRegions, regionName } = require('./lib/region');
const { packStats } = require('./collections/pack');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Install links for a manifest URL: the stremio:// deep link and Stremio Web.
 * @param {string} manifestUrl e.g. https://x.vercel.app/r/IN/manifest.json
 * @returns {{stremio: string, web: string}}
 */
function installLinks(manifestUrl) {
  return {
    stremio: String(manifestUrl).replace(/^https?:\/\//, 'stremio://'),
    web: `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`,
  };
}

/** Every link the page shows for one country. */
function linksFor(origin, region, presets) {
  const base = `${origin}/r/${region}`;
  return {
    manifest: `${base}/manifest.json`,
    pack: `${base}/collections.json`,
    packGif: `${base}/collections.json?focus=gif`,
    packStill: `${base}/collections.json?motion=off`,
    stremio: installLinks(`${base}/manifest.json`).stremio,
    presets: Object.fromEntries(presets.map((p) => [p.slug, `${base}/c/${p.slug}/manifest.json`])),
  };
}

function copyRow(id, value) {
  return `<div class="url"><code id="${id}">${escapeHtml(value)}</code><button type="button" data-copy="${id}">Copy</button></div>`;
}

/**
 * @param {object} config loaded catalogue config
 * @param {{defaultRegion: string, origin: string|null, presets?: Array<{slug: string, name: string, rows: number}>,
 *   tmdbKeyConfigured?: boolean}} opts
 */
function landingPage(config, opts) {
  const origin = opts.origin || '';
  const presets = opts.presets || [];
  const regions = knownRegions();
  const def = regions.includes(opts.defaultRegion) ? opts.defaultRegion : regions[0];
  const stats = Object.fromEntries(regions.map((r) => [r, packStats(r)]));
  const links = Object.fromEntries(regions.map((r) => [r, linksFor(origin, r, presets)]));
  const first = links[def];
  const name = escapeHtml(config.addon.name);
  const homeRows = config.catalogues.filter((r) => r.featured !== false).length;

  const options = regions
    .map((r) => `<option value="${r}"${r === def ? ' selected' : ''}>${escapeHtml(regionName(r))}</option>`)
    .join('');

  const presetRows = presets
    .map(
      (p) => `<div class="preset"><div class="pname">${escapeHtml(p.name)} <span>${p.rows} rows</span></div>${copyRow(
        `preset-${escapeHtml(p.slug)}`,
        first.presets[p.slug]
      )}</div>`
    )
    .join('\n    ');

  const warning = opts.tmdbKeyConfigured === false
    ? `<div class="warn"><b>This deployment has no TMDB key yet, so every row is empty.</b> Add <code>TMDB_API_KEY</code>
    (the API Key or the API Read Access Token from themoviedb.org) in the host's environment variables, then redeploy.</div>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: dark; --bg: #07080b; --card: #101219; --line: #1d2030; --text: #eceef4; --muted: #8b90a3; --accent: #e8e9ee; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  .wrap { max-width: 760px; margin: 0 auto; padding: 56px 20px 64px; }
  .eyebrow { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  h1 { font-size: 34px; line-height: 1.15; margin: 0 0 12px; letter-spacing: -.01em; }
  h3 { font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 40px 0 12px; }
  .lead { color: var(--muted); margin: 0 0 32px; max-width: 60ch; }
  .warn { border: 1px solid #5a4316; background: #1c160a; color: #f1d9a6; border-radius: 12px; padding: 14px 16px; margin: 0 0 24px; font-size: 14px; }
  .warn code { display: inline; padding: 1px 6px; font-size: 12px; }
  .region { display: flex; gap: 12px; align-items: center; margin: 0 0 28px; }
  .region label { color: var(--muted); font-size: 14px; }
  select { background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; font-size: 15px; }
  .step { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; margin: 0 0 14px; }
  .step h2 { font-size: 16px; margin: 0 0 4px; }
  .step p { color: var(--muted); margin: 0 0 14px; font-size: 14px; }
  .url { display: flex; gap: 10px; align-items: stretch; }
  code { flex: 1; display: block; background: #0a0b10; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9ccd8; word-break: break-all; }
  button { background: var(--accent); color: #0a0b10; border: 0; border-radius: 10px; padding: 0 16px; font-weight: 600; font-size: 14px; cursor: pointer; transition: transform 160ms ease-out; white-space: nowrap; }
  button:active { transform: scale(0.97); }
  .path { color: var(--muted); font-size: 13px; margin-top: 10px; }
  .alt { color: var(--muted); font-size: 13px; margin: 16px 0 8px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 28px 0 0; }
  .fact { border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .fact b { display: block; font-size: 20px; }
  .fact span { color: var(--muted); font-size: 13px; }
  .preset { margin: 0 0 12px; }
  .pname { font-size: 14px; margin: 0 0 6px; }
  .pname span { color: var(--muted); font-size: 13px; }
  .note { color: var(--muted); font-size: 14px; }
  a { color: #c9ccd8; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  @media (max-width: 560px) { .facts { grid-template-columns: 1fr; } .url { flex-direction: column; } button { padding: 10px; } }
</style>
</head><body><div class="wrap">
  <p class="eyebrow">For Nuvio and Stremio</p>
  <h1>${name}</h1>
  <p class="lead">Top 10 rows, cinematic title tiles and a collections tree with moving artwork: every folder has
    a focus loop and a hero video. Indian and worldwide movies and shows are blended in every row. Pick your
    country, then add two links to Nuvio.</p>
  ${warning}
  <div class="region">
    <label for="region">Country</label>
    <select id="region">${options}</select>
  </div>

  <div class="step">
    <h2>1. Add the addon</h2>
    <p>Home rows, search and the engine behind the collections.</p>
    ${copyRow('manifest', first.manifest)}
    <div class="path">Nuvio: Settings &rsaquo; Addons &rsaquo; Add Addon, paste the link. Then move ${name} to the top
      of the addon list, so its artwork is the one shown on the home screen.</div>
  </div>

  <div class="step">
    <h2>2. Import Golden Collections</h2>
    <p>Eight sections: streaming services, Indian cinema, genres, moods, franchises, studios and directors, and
      world cinema. Each folder opens into rows, and plays a hero video on the Modern home layout of Nuvio TV.</p>
    ${copyRow('pack', first.pack)}
    <div class="path">Nuvio TV: Settings &rsaquo; Content &amp; Discovery &rsaquo; Collections &rsaquo; Import &rsaquo; URL.
      Import again any time to update; your collections are replaced, not duplicated.</div>
    <p class="alt">TV on Android 8 or older? Nuvio animates WebP only from Android 9, so import this link instead
      to get GIF focus animations. Same collections, so you can switch either way.</p>
    ${copyRow('packGif', first.packGif)}
    <p class="alt">Prefer calm tiles? This link gives the same collections with still artwork and no hero videos.</p>
    ${copyRow('packStill', first.packStill)}
  </div>

  <div class="facts">
    <div class="fact"><b>${homeRows}</b><span>home rows</span></div>
    <div class="fact"><b id="folders">${stats[def] ? stats[def].folders : 0}</b><span>folders, each with a hero video</span></div>
    <div class="fact"><b>0</b><span>API keys needed in Nuvio</span></div>
  </div>

  <h3 id="presets">Themed presets</h3>
  <p class="note">Optional. Smaller addons with one theme each, for a second profile. Most people only need step 1.</p>
    ${presetRows}

  <h3>Stremio</h3>
  <p class="note">The addon works in Stremio too (collections are a Nuvio feature):
    <a id="stremio" href="${escapeHtml(first.stremio)}">install in Stremio</a>.</p>

  <footer>Metadata only; your stream addons handle playback. Data and images from TMDB, used under its terms
    but not endorsed by TMDB. <a href="https://github.com/0x8e8fb-p/nuvio-golden-catalogue">Source</a></footer>
</div>
<script>
  var LINKS = ${JSON.stringify(links).replace(/</g, '\\u003c')};
  var STATS = ${JSON.stringify(stats)};
  function setText(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
  function render() {
    var r = document.getElementById('region').value;
    var l = LINKS[r];
    if (!l) return;
    setText('manifest', l.manifest);
    setText('pack', l.pack);
    setText('packGif', l.packGif);
    setText('packStill', l.packStill);
    Object.keys(l.presets).forEach(function (slug) { setText('preset-' + slug, l.presets[slug]); });
    document.getElementById('stremio').setAttribute('href', l.stremio);
    setText('folders', (STATS[r] || { folders: 0 }).folders);
  }
  document.getElementById('region').addEventListener('change', render);
  Array.prototype.forEach.call(document.querySelectorAll('button[data-copy]'), function (b) {
    b.addEventListener('click', function () {
      var text = document.getElementById(b.getAttribute('data-copy')).textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
      setTimeout(function () { b.textContent = 'Copy'; }, 1400);
    });
  });
</script>
</body></html>`;
}

module.exports = { landingPage, installLinks };

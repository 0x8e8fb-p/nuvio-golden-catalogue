'use strict';

/**
 * Minimal, dependency-free landing page with install links for the default
 * catalogue and every preset. Rendered server-side as a single HTML string.
 *
 * Note on "animations": the page itself uses tasteful CSS, but the catalogue
 * artwork shown inside Nuvio is still images — the addon protocol cannot drive
 * motion in the client (stated plainly here and in the README).
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function originFrom(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function installLinks(manifestUrl) {
  const stremio = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  const web = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
  return { stremio, web };
}

function row(label, manifestUrl, rows) {
  const { stremio, web } = installLinks(manifestUrl);
  const count = rows != null ? ` <span class="count">${rows} rows</span>` : '';
  return `
    <li>
      <div class="r-label">${escapeHtml(label)}${count}</div>
      <div class="r-actions">
        <a class="btn" href="${escapeHtml(stremio)}">Install</a>
        <a class="btn ghost" href="${escapeHtml(web)}" target="_blank" rel="noopener">Stremio Web</a>
        <code>${escapeHtml(manifestUrl)}</code>
      </div>
    </li>`;
}

function landingPage(config, presets, req) {
  const origin = originFrom(req);
  const name = escapeHtml(config.addon.name);
  const desc = escapeHtml(config.addon.description);

  const defaultRow = row('Full Catalogue (curated)', `${origin}/manifest.json`, config.catalogues.length);
  const presetRows = presets
    .map((p) => row(`${p.name}`, `${origin}/c/${p.slug}/manifest.json`, p.rows))
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1016; color: #e8e8ee; padding: 2rem 1rem; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.7rem; margin: 0 0 .25rem; }
  p.lead { color: #a7a7b4; margin: 0 0 1.5rem; }
  .note { background: #1a1b26; border: 1px solid #2a2b3a; border-radius: 10px; padding: .75rem 1rem;
    color: #c7c7d4; font-size: .9rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; color: #8a8a99;
    margin: 1.75rem 0 .5rem; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: .6rem; }
  li { background: #16171f; border: 1px solid #23242f; border-radius: 10px; padding: .75rem .9rem; }
  .r-label { font-weight: 600; margin-bottom: .45rem; }
  .count { color: #7f7f8c; font-weight: 400; font-size: .85em; }
  .r-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .btn { background: #6a5cff; color: #fff; text-decoration: none; padding: .35rem .8rem;
    border-radius: 8px; font-size: .85rem; font-weight: 600; }
  .btn.ghost { background: transparent; border: 1px solid #3a3b4a; color: #c7c7d4; }
  code { font-size: .78rem; color: #6f7080; word-break: break-all; }
  footer { margin-top: 2rem; color: #6f7080; font-size: .82rem; }
  a.link { color: #9a8cff; }
</style>
</head><body><div class="wrap">
  <h1>${name}</h1>
  <p class="lead">${desc}</p>
  <div class="note">
    Paste any <strong>Install</strong> URL into <strong>Nuvio → Settings → Addons → Add Addon</strong>.
    A single Stremio manifest is capped at 8KB (~75 rows), so the catalogue is also split into
    <strong>presets</strong> — install as many as you like to get everything.
    Artwork is shown as still images; the addon cannot drive UI animation (that is owned by the app).
  </div>

  <h2>Recommended</h2>
  <ul>${defaultRow}</ul>

  <p style="margin:1rem 0"><a class="link" href="/configure">Open the configure page</a> to pick a region and build your own install URLs.</p>

  <h2>Presets (mix and match)</h2>
  <ul>${presetRows}</ul>

  <footer>
    Uses the TMDB API but is not endorsed or certified by TMDB.
    <a class="link" href="https://github.com/USERNAME/nuvio-golden-catalogue">Source &amp; docs</a>.
  </footer>
</div></body></html>`;
}

module.exports = { landingPage, installLinks };

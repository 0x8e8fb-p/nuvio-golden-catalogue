'use strict';

/**
 * Server-rendered /configure page.
 *
 * Lets a user pick a region and select presets, then live-builds the exact
 * install URLs to paste into Nuvio (default catalogue, and each chosen preset
 * region-scoped). No build step, no client framework — a single self-contained
 * HTML document with a small vanilla script. Plain styling, no decorative
 * characters.
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

function configurePage(config, presets, req) {
  const origin = originFrom(req);
  const name = escapeHtml(config.addon.name);

  const presetJson = JSON.stringify(
    presets.map((p) => ({ slug: p.slug, name: p.name, rows: p.rows }))
  );

  const checkboxes = presets
    .map(
      (p) => `
      <label class="opt">
        <input type="checkbox" class="preset" value="${escapeHtml(p.slug)}" checked>
        <span>${escapeHtml(p.name)} <em>${p.rows} rows</em></span>
      </label>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configure ${name}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1016; color: #e8e8ee; padding: 2rem 1rem; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p.lead { color: #a7a7b4; margin: 0 0 1.5rem; }
  .field { margin-bottom: 1.25rem; }
  label.row { display: block; font-weight: 600; margin-bottom: .4rem; }
  select, input[type=text] { background: #16171f; color: #e8e8ee; border: 1px solid #2a2b3a;
    border-radius: 8px; padding: .5rem .6rem; font-size: .95rem; min-width: 10rem; }
  .opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: .4rem; }
  .opt { display: flex; align-items: center; gap: .5rem; background: #16171f; border: 1px solid #23242f;
    border-radius: 8px; padding: .5rem .6rem; cursor: pointer; }
  .opt em { color: #7f7f8c; font-style: normal; font-size: .82em; }
  .actions { margin: .5rem 0 1rem; display: flex; gap: .5rem; flex-wrap: wrap; }
  button { background: #2a2b3a; color: #e8e8ee; border: 1px solid #3a3b4a; border-radius: 8px;
    padding: .4rem .8rem; cursor: pointer; font-size: .85rem; }
  h2 { font-size: .9rem; text-transform: uppercase; letter-spacing: .05em; color: #8a8a99; margin: 1.5rem 0 .5rem; }
  ul#out { list-style: none; padding: 0; margin: 0; display: grid; gap: .5rem; }
  ul#out li { background: #16171f; border: 1px solid #23242f; border-radius: 8px; padding: .6rem .7rem; }
  .u-top { display: flex; justify-content: space-between; gap: .5rem; align-items: center; margin-bottom: .35rem; }
  .u-name { font-weight: 600; }
  a.btn { background: #6a5cff; color: #fff; text-decoration: none; padding: .3rem .7rem; border-radius: 7px;
    font-size: .82rem; font-weight: 600; }
  code { font-size: .78rem; color: #8a8a99; word-break: break-all; display: block; }
  .copy { background: transparent; border: 1px solid #3a3b4a; color: #c7c7d4; }
</style>
</head><body><div class="wrap">
  <h1>Configure ${name}</h1>
  <p class="lead">Pick your region and the preset rows you want, then copy the install URLs into
    Nuvio &rarr; Settings &rarr; Addons &rarr; Add Addon. Each Stremio manifest is capped near 8KB,
    so presets are installed as separate lean addons.</p>

  <div class="field">
    <label class="row" for="region">Region (for streaming-availability rows)</label>
    <select id="region">
      <option value="US">United States (US)</option>
      <option value="IN">India (IN)</option>
      <option value="GB">United Kingdom (GB)</option>
      <option value="CA">Canada (CA)</option>
      <option value="AU">Australia (AU)</option>
      <option value="DE">Germany (DE)</option>
      <option value="FR">France (FR)</option>
      <option value="BR">Brazil (BR)</option>
      <option value="JP">Japan (JP)</option>
      <option value="KR">South Korea (KR)</option>
    </select>
  </div>

  <div class="field">
    <label class="row">Presets</label>
    <div class="actions">
      <button type="button" id="all">Select all</button>
      <button type="button" id="none">Clear</button>
    </div>
    <div class="opts">${checkboxes}</div>
  </div>

  <h2>Your install URLs</h2>
  <ul id="out"></ul>

  <script>
    var ORIGIN = ${JSON.stringify(origin)};
    var PRESETS = ${presetJson};

    function stremioLink(u){ return u.replace(/^https?:\\/\\//, 'stremio://'); }

    function render(){
      var region = document.getElementById('region').value;
      var chosen = Array.prototype.slice.call(document.querySelectorAll('.preset:checked')).map(function(c){return c.value;});
      var out = document.getElementById('out');
      out.innerHTML = '';

      function addRow(label, url){
        var li = document.createElement('li');
        var top = document.createElement('div'); top.className='u-top';
        var nm = document.createElement('span'); nm.className='u-name'; nm.textContent=label;
        var a = document.createElement('a'); a.className='btn'; a.href=stremioLink(url); a.textContent='Install';
        top.appendChild(nm); top.appendChild(a);
        var code = document.createElement('code'); code.textContent=url;
        var copy = document.createElement('button'); copy.className='copy'; copy.textContent='Copy URL';
        copy.onclick=function(){ navigator.clipboard && navigator.clipboard.writeText(url); copy.textContent='Copied'; setTimeout(function(){copy.textContent='Copy URL';},1200); };
        li.appendChild(top); li.appendChild(code); li.appendChild(copy);
        out.appendChild(li);
      }

      addRow('Full Catalogue (curated default)', ORIGIN + '/manifest.json');
      chosen.forEach(function(slug){
        var p = PRESETS.filter(function(x){return x.slug===slug;})[0] || {name:slug};
        addRow(p.name + ' preset', ORIGIN + '/r/' + region + '/c/' + slug + '/manifest.json');
      });
    }

    document.getElementById('region').addEventListener('change', render);
    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function(c){ c.addEventListener('change', render); });
    document.getElementById('all').onclick=function(){ Array.prototype.forEach.call(document.querySelectorAll('.preset'), function(c){c.checked=true;}); render(); };
    document.getElementById('none').onclick=function(){ Array.prototype.forEach.call(document.querySelectorAll('.preset'), function(c){c.checked=false;}); render(); };
    render();
  </script>
</div></body></html>`;
}

module.exports = { configurePage };

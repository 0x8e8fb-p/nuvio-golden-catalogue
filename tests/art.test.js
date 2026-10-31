'use strict';

/**
 * Artwork: URL signing, the renderer (offline, synthetic inputs) and the
 * request context that supplies the public origin for art URLs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildArtUrl, verify } = require('../src/art/sign');
const render = require('../src/art/render');
const { originFromRequest, runWithOrigin, currentOrigin } = require('../src/lib/request-context');
const { tileUrl, folderArtUrl } = require('../src/art/urls');

/** A solid-colour test image with a lighter band, as JPEG or PNG. */
function testImage(w, h, { r = 40, g = 90, b = 160, png = false, alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const band = y > h / 3 && y < (2 * h) / 3;
      raw[i] = band ? 220 : r;
      raw[i + 1] = band ? 220 : g;
      raw[i + 2] = band ? 220 : b;
      if (alpha) raw[i + 3] = band ? 255 : 0; // transparent logo with an opaque bar
    }
  }
  const img = sharp(raw, { raw: { width: w, height: h, channels } });
  return png || alpha ? img.png().toBuffer() : img.jpeg().toBuffer();
}

async function info(buf) {
  const m = await sharp(buf, { animated: true }).metadata();
  return { format: m.format, width: m.width, height: m.pageHeight || m.height, pages: m.pages || 1, loop: m.loop };
}

/**
 * A photo-like test image: colour gradients with fine grain, deterministic per seed.
 * Flat colour fields compress to almost nothing as GIF, so size limits need texture.
 */
function grainImage(w, h, seed) {
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const raw = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let p = 0; p < w * h; p++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const grain = ((s >>> 0) % 41) - 20;
    const x = p % w;
    const y = Math.floor(p / w);
    raw[p * 3] = byte(((seed * 37) % 160) + (x * 80) / w + grain);
    raw[p * 3 + 1] = byte(50 + (y * 140) / h + grain);
    raw[p * 3 + 2] = byte(((seed * 91) % 160) + ((x + y) * 80) / (w + h) + grain);
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** Run fn with environment variables set (strings) or removed (undefined), then restore them. */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('signed URLs verify, and any change breaks the signature', () => {
  const url = new URL(buildArtUrl('https://x.example', '/art/tile.jpg', { t: 'movie', id: 603, b: '/abc.jpg', n: 'The Matrix' }));
  const params = Object.fromEntries(url.searchParams);
  assert.equal(verify('/art/tile.jpg', params), true);
  assert.equal(verify('/art/tile.jpg', { ...params, id: '604' }), false);
  assert.equal(verify('/art/rank.jpg', params), false);
  assert.equal(verify('/art/tile.jpg', { ...params, s: undefined }), false);
});

test('art URLs use the request origin, and need one', () => {
  assert.equal(currentOrigin(), null);
  runWithOrigin('https://golden.example', () => {
    const u = tileUrl({ type: 'series', tmdbId: 1399, backdrop: '/x1.jpg', title: 'Game of Thrones', lang: 'en' });
    assert.ok(u.startsWith('https://golden.example/art/tile.jpg?'));
    assert.match(u, /t=series/);
  });
  assert.equal(
    folderArtUrl('https://g.example', 'IN', 'netflix', 'cover', { shape: 'poster' }),
    'https://g.example/art/folder/IN/netflix/cover.jpg?v=1&shape=poster'
  );
});

test('tile URLs carry the poster only when there is no usable backdrop', () => {
  runWithOrigin('https://golden.example', () => {
    const base = { type: 'movie', tmdbId: 603, title: 'The Matrix', lang: 'en' };
    const withBackdrop = tileUrl({ ...base, backdrop: '/backdrop603.jpg' });
    assert.equal(tileUrl({ ...base, backdrop: '/backdrop603.jpg', poster: '/poster603.jpg' }), withBackdrop, 'unchanged');
    assert.equal(new URL(withBackdrop).searchParams.has('p'), false);
    const posterOnly = new URL(tileUrl({ ...base, backdrop: null, poster: '/poster603.jpg' }));
    assert.equal(posterOnly.searchParams.get('p'), '/poster603.jpg');
    assert.equal(posterOnly.searchParams.has('b'), false);
    assert.equal(verify('/art/tile.jpg', Object.fromEntries(posterOnly.searchParams)), true);
  });
});

test('origin trusts forwarded headers only behind a known proxy, and validates host and scheme', () => {
  const noProxy = { PUBLIC_BASE_URL: undefined, VERCEL: undefined, TRUST_PROXY: undefined };
  const proxy = { ...noProxy, TRUST_PROXY: '1' };
  const req = { headers: { 'x-forwarded-host': 'golden.vercel.app', 'x-forwarded-proto': 'https', host: 'internal:3000' }, socket: {} };

  withEnv(proxy, () => assert.equal(originFromRequest(req), 'https://golden.vercel.app'));
  withEnv({ ...noProxy, VERCEL: '1' }, () => assert.equal(originFromRequest(req), 'https://golden.vercel.app'));

  withEnv(noProxy, () => {
    // No trusted proxy: forwarded headers are client input, so the Host header wins.
    assert.equal(originFromRequest(req), 'http://internal:3000');
    assert.equal(originFromRequest({ headers: { host: 'golden.example', 'x-forwarded-proto': 'https' }, socket: {} }), 'http://golden.example');
    assert.equal(originFromRequest({ headers: { host: '127.0.0.1:7000' }, socket: {} }), 'http://127.0.0.1:7000');
    assert.equal(originFromRequest({ headers: { host: '[::1]:7000' }, socket: { encrypted: true } }), 'https://[::1]:7000');
    assert.equal(originFromRequest({ headers: { host: 'evil.com/x"<' }, socket: {} }), null);
  });

  withEnv(proxy, () => {
    // Only http and https are accepted as schemes; anything else falls back to the socket.
    const headers = { 'x-forwarded-host': 'golden.example', 'x-forwarded-proto': 'javascript:alert(1)//' };
    assert.equal(originFromRequest({ headers, socket: {} }), 'http://golden.example');
    assert.equal(originFromRequest({ headers, socket: { encrypted: true } }), 'https://golden.example');
    assert.equal(originFromRequest({ headers: { 'x-forwarded-host': 'evil.com/x"<', host: 'golden.example' }, socket: {} }), null);
  });

  withEnv({ ...proxy, PUBLIC_BASE_URL: 'https://tv.example.org/' }, () => {
    assert.equal(originFromRequest(req), 'https://tv.example.org');
  });
});

test('title tile is a 960x540 JPEG, with or without a logo', async () => {
  const backdrop = await testImage(1280, 720);
  const logo = await testImage(600, 200, { alpha: true });
  for (const input of [{ backdrop, logo }, { backdrop, title: 'Kantara' }, {}]) {
    const out = await info(await render.renderTile(input));
    assert.deepEqual([out.format, out.width, out.height], ['jpeg', 960, 540]);
  }
});

test('a title with only a poster gets the poster layout', async () => {
  const poster = await testImage(500, 750, { r: 200, g: 60, b: 30 });
  const bare = await render.renderTile({ poster });
  const out = await info(bare);
  assert.deepEqual([out.format, out.width, out.height], ['jpeg', 960, 540]);
  assert.ok(!bare.equals(await render.renderTile({})), 'differs from the no-input fallback');

  // A long title fills the whole label box, so it would show up in the gap if the box
  // reached the card.
  const tile = await render.renderTile({ poster, title: 'The Great Indian Kitchen Returns' });
  const { data } = await sharp(tile).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * 960 + x) * 3, (y * 960 + x) * 3 + 3)];
  const [r, g, b] = px(755, 100);
  assert.ok(r > 170 && g < 100 && b < 70, `sharp poster on the right, got ${[r, g, b]}`);
  let brightest = 0;
  for (let y = 300; y < 500; y++) for (let x = 560; x < 596; x++) brightest = Math.max(brightest, ...px(x, y));
  assert.ok(brightest < 140, `label stays left of the poster, brightest gap pixel ${brightest}`);
});

test('rank tile renders for one- and two-digit ranks', async () => {
  const poster = await testImage(500, 750);
  for (const rank of [1, 10]) {
    const out = await info(await render.renderRankTile({ rank, poster }));
    assert.deepEqual([out.format, out.width, out.height], ['jpeg', 960, 540]);
  }
});

test('folder covers match the tile shape exactly', async () => {
  const backdrop = await testImage(780, 439);
  const expected = { landscape: [640, 360], poster: [405, 600], square: [600, 600] };
  for (const [shape, [w, h]] of Object.entries(expected)) {
    const out = await info(await render.renderFolderCover({ shape, backdrop, wordmark: 'Hidden Gems' }));
    assert.deepEqual([out.width, out.height], [w, h], shape);
  }
});

test('focus loop is an animated, looping WebP at the cover aspect', async () => {
  const backdrops = await Promise.all([testImage(780, 439), testImage(780, 439, { r: 150, g: 40, b: 40 })]);
  const out = await info(await render.renderFolderFocus({ backdrops, wordmark: 'Thrillers', format: 'webp', shape: 'square' }));
  assert.equal(out.format, 'webp');
  assert.deepEqual([out.width, out.height], [300, 300]);
  assert.ok(out.pages > 2, `expected crossfade frames, got ${out.pages}`);
  assert.equal(out.loop, 0, 'loops forever');
  const poster = await info(await render.renderFolderFocus({ backdrops, wordmark: 'Thrillers', format: 'webp', shape: 'poster' }));
  assert.deepEqual([poster.width, poster.height], [243, 360]);
  const gif = await info(await render.renderFolderFocus({ backdrops, wordmark: 'Thrillers', format: 'gif' }));
  assert.deepEqual([gif.format, gif.width, gif.height], ['gif', 416, 234]);
});

test('GIF focus loop for 4 pictures stays under 500 KB and still animates', async () => {
  const backdrops = await Promise.all([1, 2, 3, 4].map((k) => grainImage(780, 439, k * 7919)));
  const buf = await render.renderFolderFocus({ backdrops, wordmark: 'Thrillers', format: 'gif' });
  const gif = await info(buf);
  assert.deepEqual([gif.format, gif.width, gif.height], ['gif', 416, 234]);
  assert.ok(buf.length < 500 * 1000, `GIF is ${Math.round(buf.length / 1000)} KB`);
  assert.ok(gif.pages > 2, `expected crossfade frames, got ${gif.pages}`);
  assert.equal(gif.loop, 0, 'loops forever');
  // The WebP loop keeps its 4 eased crossfade frames per picture.
  const webp = await info(await render.renderFolderFocus({ backdrops, wordmark: 'Thrillers', format: 'webp' }));
  assert.equal(webp.pages, 20);
});

test('a single picture gives a still focus image', async () => {
  const out = await info(await render.renderFolderFocus({ backdrops: [await testImage(780, 439)], format: 'webp' }));
  assert.equal(out.pages, 1);
});

test('hero wall is 1920x1080, even with nothing to show', async () => {
  const posters = await Promise.all([testImage(342, 513), testImage(342, 513, { r: 120 })]);
  for (const input of [{ posters }, {}]) {
    const out = await info(await render.renderFolderHero(input));
    assert.deepEqual([out.format, out.width, out.height], ['jpeg', 1920, 1080]);
  }
});

test('broken inputs still produce a valid image', async () => {
  const junk = Buffer.from('definitely not an image');
  const tile = await info(await render.renderTile({ backdrop: junk, logo: junk, title: 'Junk' }));
  assert.deepEqual([tile.width, tile.height], [960, 540]);
  const cover = await info(await render.renderFolderCover({ shape: 'poster', backdrop: junk, logo: junk }));
  assert.deepEqual([cover.width, cover.height], [405, 600]);
});

test('opaque boxes are rejected as logos, transparent ones kept', async () => {
  assert.equal(await render.normalizeLogo(await testImage(400, 200, { png: true })), null);
  const kept = await render.normalizeLogo(await testImage(400, 200, { alpha: true }));
  assert.ok(kept && kept.width > 0 && kept.height > 0);
});

/** Mean RGB of the visible pixels of a PNG. */
async function visibleMean(png) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 128) {
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
      n++;
    }
  }
  return sum.map((s) => Math.round(s / n));
}

test('dark logos turn white; bright brand colours are kept', async () => {
  const navy = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 10, g: 30, b: 90, alpha: 1 } } })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  assert.deepEqual(await visibleMean((await render.normalizeLogo(navy)).png), [255, 255, 255]);
  const red = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 229, g: 9, b: 20, alpha: 1 } } })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const [r, g] = await visibleMean((await render.normalizeLogo(red)).png);
  assert.ok(r > 200 && g < 40, 'Netflix-style red stays red');
});

test('two-tone logos only lift their dark part', async () => {
  // Left 30%: bright gold mark. Right 70%: near-black lettering.
  const w = 300;
  const h = 100;
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const mark = x < w * 0.3;
      raw.set(mark ? [240, 190, 60, 255] : [20, 20, 24, 255], i);
    }
  }
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const out = await render.normalizeLogo(png);
  const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true });
  const px = (x) => [...data.subarray((Math.floor(info.height / 2) * info.width + x) * 4, (Math.floor(info.height / 2) * info.width + x) * 4 + 3)];
  const [mr, mg, mb] = px(Math.floor(info.width * 0.1));
  assert.ok(mr > 220 && mg > 170 && mb < 90, `gold mark kept, got ${[mr, mg, mb]}`);
  assert.deepEqual(px(Math.floor(info.width * 0.8)), [255, 255, 255], 'lettering lifted to white');
});

test('a brand folder without a usable logo still gets a centred name', async () => {
  const backdrop = await testImage(780, 439);
  const brand = await render.renderFolderCover({ shape: 'landscape', backdrop, logo: null, wordmark: 'MX Player', brand: true });
  const plain = await render.renderFolderCover({ shape: 'landscape', backdrop, logo: null, wordmark: 'MX Player' });
  // Brand mode darkens the whole picture; category mode keeps the top bright.
  const top = async (buf) => (await sharp(buf).extract({ left: 0, top: 0, width: 640, height: 60 }).stats()).channels[2].mean;
  assert.ok((await top(brand)) < (await top(plain)) * 0.6);
});

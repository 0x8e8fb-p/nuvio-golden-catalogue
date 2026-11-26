'use strict';

/**
 * Artwork HTTP routes: folder art and the folder title logo, canonical folder
 * URLs, signature checks, logo lookups, and the short cache for images drawn
 * after an input failed to load. Runs without a TMDB key.
 *
 * Downloads from TMDB go through globalThis.fetch. Tests that need TMDB to fail
 * or answer on cue set `upstream`; otherwise requests reach the real network.
 * Requests to the test server always use the real fetch.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');

delete process.env.TMDB_API_KEY;

const { createArtRouter, _RenderCache: RenderCache } = require('../src/art/routes');
const { buildArtUrl } = require('../src/art/sign');
const { bestLogo, bestLogoPath, entityLogo, networkLogoPath } = require('../src/art/logos');
const { sampleItems } = require('../src/art/folder-art');
const { regionFolders } = require('../src/collections/engine');
const render = require('../src/art/render');

const ITEM_CACHE = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800';
const FOLDER_CACHE = 'public, max-age=21600, s-maxage=86400, stale-while-revalidate=604800';
const DEGRADED_CACHE = 'public, max-age=60, s-maxage=300';
const NO_LOGO_CACHE = 'public, max-age=86400, s-maxage=604800';

const realFetch = globalThis.fetch;
let upstream = null; // (url) => Response for requests leaving the process, or null for the real network
let server;
let base;

before(async () => {
  // Installed before any TMDB client exists, since clients keep the fetch they were built with.
  globalThis.fetch = (url, init) => (upstream ? upstream(String(url), init) : realFetch(url, init));
  const app = express();
  app.use('/art', createArtRouter());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  globalThis.fetch = realFetch;
  if (server) {
    server.closeAllConnections();
    server.close();
  }
});

const get = (path) => realFetch(path.startsWith('http') ? path : `${base}${path}`, { redirect: 'manual' });

/** Run fn while requests leaving the process are answered by handler(url). */
async function withUpstream(handler, fn) {
  upstream = handler;
  try {
    return await fn();
  } finally {
    upstream = null;
  }
}

const unavailable = async () => new Response('unavailable', { status: 503 });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const image = (buf, type) => new Response(buf, { status: 200, headers: { 'content-type': type } });

/** A transparent PNG with an opaque white bar: a usable logo. */
function logoPng() {
  return sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function photoJpeg(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toBuffer();
}

async function body(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, meta: await sharp(buf).metadata() };
}

function folder(key) {
  const f = regionFolders('IN').folders.get(key);
  assert.ok(f, `folder ${key} exists in IN`);
  return f;
}

const wordmarkFor = (f) => render.renderWordmark(f.art.wordmark, { height: 180, maxWidth: 1200 });

test('unknown regions and folders are 404', async () => {
  for (const path of [
    '/art/folder/IN/not-a-folder/cover.jpg',
    '/art/folder/IN/not-a-folder/logo.png?x=1',
    '/art/folder/XYZ/netflix/cover.jpg',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    await res.arrayBuffer();
  }
});

test('the Netflix folder logo is a PNG: the brand logo, or the wordmark with a short cache', async () => {
  const res = await get('/art/folder/IN/netflix/logo.png?v=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const { buf, meta } = await body(res);
  assert.equal(meta.format, 'png');
  assert.ok(meta.width > 0 && meta.height > 0);
  // Without network access the brand logo download fails: wordmark, short cache.
  const cache = res.headers.get('cache-control');
  if (cache === DEGRADED_CACHE) assert.ok(buf.equals(await wordmarkFor(folder('netflix'))), 'falls back to the wordmark');
  else assert.equal(cache, FOLDER_CACHE);
});

test('a folder without a brand logo gets its name as a transparent wordmark', async () => {
  const res = await get('/art/folder/IN/action/logo.png?v=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), FOLDER_CACHE);
  const { buf, meta } = await body(res);
  assert.ok(meta.width > 0 && meta.hasAlpha);
  assert.ok(buf.equals(await wordmarkFor(folder('action'))));
});

test('a brand logo that fails to download gives the wordmark, briefly cached and not kept', async () => {
  const brand = [...regionFolders('IN').folders.values()].find((f) => f.key !== 'netflix' && !f.parent && f.art.logoPath);
  assert.ok(brand, 'a brand folder with a verified logo path');
  const wordmark = await wordmarkFor(brand);

  await withUpstream(unavailable, async () => {
    const logo = await get(`/art/folder/IN/${brand.key}/logo.png?v=1`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('cache-control'), DEGRADED_CACHE);
    assert.ok((await body(logo)).buf.equals(wordmark));
    const cover = await get(`/art/folder/IN/${brand.key}/cover.jpg?v=1`);
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('cache-control'), DEGRADED_CACHE);
    await cover.arrayBuffer();
  });

  // Same URLs once TMDB answers: rendered again, with the logo and the long cache.
  const requested = [];
  const png = await logoPng();
  await withUpstream(
    async (url) => {
      requested.push(url);
      return image(png, 'image/png');
    },
    async () => {
      const logo = await get(`/art/folder/IN/${brand.key}/logo.png?v=1`);
      assert.equal(logo.headers.get('cache-control'), FOLDER_CACHE);
      const { buf, meta } = await body(logo);
      assert.equal(meta.format, 'png');
      assert.ok(!buf.equals(wordmark), 'the brand logo, not the wordmark');
      const cover = await get(`/art/folder/IN/${brand.key}/cover.jpg?v=1`);
      assert.equal(cover.headers.get('cache-control'), FOLDER_CACHE);
      await cover.arrayBuffer();
    }
  );
  assert.ok(requested.some((u) => u.endsWith(`/w500${brand.art.logoPath}`)), 'logo downloaded at w500');
});

test('a tile URL with a poster downloads it, and a failed download is not kept', async () => {
  const url = buildArtUrl(base, '/art/tile.jpg', { t: 'movie', id: 603, p: '/tilePosterTest01.jpg', n: 'The Matrix' });
  const requested = [];
  await withUpstream(
    async (u) => {
      requested.push(u);
      return unavailable();
    },
    async () => {
      const res = await get(url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/jpeg');
      assert.equal(res.headers.get('cache-control'), DEGRADED_CACHE);
      await res.arrayBuffer();
    }
  );
  assert.ok(requested.some((u) => u.endsWith('/w500/tilePosterTest01.jpg')), 'poster requested at w500');

  const poster = await photoJpeg(500, 750);
  requested.length = 0;
  await withUpstream(
    async (u) => {
      requested.push(u);
      return image(poster, 'image/jpeg');
    },
    async () => {
      const res = await get(url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), ITEM_CACHE);
      assert.equal((await body(res)).meta.format, 'jpeg');
    }
  );
  assert.ok(requested.some((u) => u.endsWith('/w500/tilePosterTest01.jpg')), 'rendered again, not served from memory');
});

test('folder art with junk query parameters redirects to the canonical URL', async () => {
  const cases = [
    ['/art/folder/IN/netflix/cover.jpg?v=1&x=1', '/art/folder/IN/netflix/cover.jpg?v=1'],
    ['/art/folder/IN/netflix/cover.jpg?shape=bogus', '/art/folder/IN/netflix/cover.jpg'],
    ['/art/folder/IN/netflix/cover.jpg?v=1&shape=bogus', '/art/folder/IN/netflix/cover.jpg?v=1'],
    ['/art/folder/IN/netflix/focus.webp?utm_source=tv&v=1&shape=square', '/art/folder/IN/netflix/focus.webp?v=1&shape=square'],
    ['/art/folder/IN/netflix/focus.gif?shape=poster&shape=square', '/art/folder/IN/netflix/focus.gif?shape=poster'],
    ['/art/folder/IN/netflix/hero.jpg?v=1&shape=poster', '/art/folder/IN/netflix/hero.jpg?v=1'],
    ['/art/folder/IN/netflix/logo.png?v=1&v=2', '/art/folder/IN/netflix/logo.png?v=1'],
    ['/art/folder/IN/netflix/logo.png?x', '/art/folder/IN/netflix/logo.png'],
  ];
  for (const [from, to] of cases) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400', from);
    await res.arrayBuffer();
  }
  // Allowed keys in any order are served as they are.
  const res = await get('/art/folder/IN/action/cover.jpg?shape=poster&v=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  await res.arrayBuffer();
});

test('signed routes answer 403, not 500, to bad and malformed signatures', async () => {
  const forged = [
    's=AAAAAAAAAAAAAAAAAAAAAA',
    `s=${encodeURIComponent('\u00e9' + 'A'.repeat(21))}`, // 22 characters, 23 bytes
    's[toString]=x',
    's=AAAAAAAAAAAAAAAAAAAAAA&s=BBBBBBBBBBBBBBBBBBBBBB',
  ];
  for (const s of forged) {
    for (const path of ['/art/tile.jpg?t=movie&id=603&v=1', '/art/logo.png?t=movie&id=603&v=1']) {
      const res = await get(`${path}&${s}`);
      assert.equal(res.status, 403, `${path}&${s}`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      await res.arrayBuffer();
    }
  }
});

test('the title logo route answers 404 without a TMDB key', async () => {
  const res = await get(buildArtUrl(base, '/art/logo.png', { t: 'movie', id: 603 }));
  assert.equal(res.status, 404);
  assert.ok(['no-store', NO_LOGO_CACHE].includes(res.headers.get('cache-control')));
  await res.arrayBuffer();
});

test('a failed title logo lookup is a 404 nobody caches; a later lookup can succeed', async () => {
  process.env.TMDB_API_KEY = 'test-key-logo';
  try {
    const url = buildArtUrl(base, '/art/logo.png', { t: 'movie', id: 603, ol: 'en' });
    await withUpstream(
      async () => json({ status_message: 'Invalid API key' }, 401),
      async () => {
        const res = await get(url);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        await res.arrayBuffer();
      }
    );
    await withUpstream(
      async () => json({ logos: [{ file_path: '/matrixLogo01.png', iso_639_1: 'en', vote_average: 5 }] }),
      async () => {
        const res = await get(url);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), 'https://image.tmdb.org/t/p/w500/matrixLogo01.png');
      }
    );
    await withUpstream(
      async () => json({ logos: [] }),
      async () => {
        const res = await get(buildArtUrl(base, '/art/logo.png', { t: 'movie', id: 604 }));
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('cache-control'), NO_LOGO_CACHE, 'TMDB has no logo: the long 404');
        await res.arrayBuffer();
      }
    );
  } finally {
    delete process.env.TMDB_API_KEY;
  }
});

test('logo lookups tell a failed lookup apart from a missing logo', async () => {
  const client = (fn) => ({ hasKey: () => true, get: fn });
  const down = client(async () => {
    throw new Error('TMDB 503');
  });
  const gone = client(async () => {
    const err = new Error('TMDB request failed: 404');
    err.status = 404;
    throw err;
  });
  const some = client(async () => ({ logos: [{ file_path: '/logoTest01.png', iso_639_1: 'en' }] }));

  assert.deepEqual(await bestLogo(down, 'movie', 910001), { path: null, ok: false });
  assert.deepEqual(await bestLogo(some, 'movie', 910001), { path: '/logoTest01.png', ok: true }, 'the failure was not cached');
  assert.deepEqual(await bestLogo(down, 'movie', 910001), { path: '/logoTest01.png', ok: true }, 'the answer was cached');
  assert.deepEqual(await bestLogo(client(async () => ({ logos: [] })), 'tv', 910002), { path: null, ok: true });
  assert.deepEqual(await bestLogo(gone, 'tv', 910003), { path: null, ok: true }, 'TMDB does not know the title');
  assert.deepEqual(await bestLogo({ hasKey: () => false, get: down.get }, 'movie', 910004), { path: null, ok: true });
  assert.equal(await bestLogoPath(down, 'movie', 910005), null, 'the path helper still returns null');

  assert.deepEqual(await entityLogo(down, 'network', 910006), { path: null, ok: false });
  const svg = client(async () => ({ logo_path: '/networkLogo01.svg' }));
  assert.deepEqual(await entityLogo(svg, 'network', 910006), { path: '/networkLogo01.png', ok: true });
  assert.equal(await networkLogoPath(down, 910007), null);
});

test('a folder sample that fails to load is reported, not cached, and makes the art short-lived', async () => {
  const kgf = folder('kgf'); // a TMDB collection folder: movies only
  const parts = [
    { id: 1, title: 'K.G.F: Chapter 1', release_date: '2018-12-20', backdrop_path: '/kgfBackdrop01.jpg', poster_path: '/kgfPoster01.jpg' },
  ];
  const backdrop = await photoJpeg(780, 439);
  process.env.TMDB_API_KEY = 'test-key-sample';
  try {
    await withUpstream(
      async () => json({ status_message: 'not found' }, 404),
      async () => {
        assert.deepEqual(await sampleItems('IN', kgf), { items: [], failed: true });
        const res = await get('/art/folder/IN/kgf/cover.jpg?v=1');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), DEGRADED_CACHE);
        await res.arrayBuffer();
      }
    );
    const requested = [];
    await withUpstream(
      async (url) => {
        requested.push(url);
        return url.includes('/collection/') ? json({ id: kgf.raw.collection, parts }) : image(backdrop, 'image/jpeg');
      },
      async () => {
        const sample = await sampleItems('IN', kgf);
        assert.equal(sample.failed, false);
        assert.deepEqual(sample.items.map((m) => m.id), [1], 'the empty sample was not cached');
        const res = await get('/art/folder/IN/kgf/cover.jpg?v=1');
        assert.equal(res.headers.get('cache-control'), FOLDER_CACHE);
        await res.arrayBuffer();
      }
    );
    assert.ok(requested.some((u) => u.endsWith('/w780/kgfBackdrop01.jpg')), 'the cover was rendered again');
  } finally {
    delete process.env.TMDB_API_KEY;
  }
});

test('the render cache is bounded by bytes and entries, least recently used first', () => {
  const cache = new RenderCache({ maxBytes: 100, maxEntries: 3, maxItemBytes: 60, ttlMs: 1000 });
  cache.set('a', Buffer.alloc(40));
  cache.set('b', Buffer.alloc(40));
  assert.ok(cache.get('a')); // a becomes the most recently used
  cache.set('c', Buffer.alloc(40)); // 120 bytes: b goes
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('a') && cache.get('c'));
  assert.equal(cache.bytes, 80);

  cache.set('big', Buffer.alloc(61)); // over the per-item limit: not cached, nothing evicted
  assert.equal(cache.get('big'), undefined);
  assert.equal(cache.bytes, 80);

  cache.set('d', Buffer.alloc(1));
  cache.set('e', Buffer.alloc(1)); // a fourth entry: a, now the least recently used, goes
  assert.equal(cache.size, 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.bytes, 42);

  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    assert.equal(cache.get('e'), undefined, 'expired');
  } finally {
    Date.now = realNow;
  }
  assert.equal(cache.bytes, 41);
});

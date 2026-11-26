'use strict';
/**
 * v4 features: the folder tree (groups whose rows are other folders), facet
 * rows, the motion and video switches of the pack, the 8KB manifest with
 * facet catalogs, the hero video frames and encoder, and byte ranges on
 * hero.mp4.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const { buildPack, packStats } = require('../src/collections/pack');
const { regionFolders } = require('../src/collections/engine');
const { buildManifest } = require('../src/manifest');
const { loadConfig } = require('../src/lib/config-loader');
const render = require('../src/art/render');
const { videoEnabled, encodeHeroVideo } = require('../src/art/video');
const { _sendVideo: sendVideo } = require('../src/art/routes');

const ORIGIN = 'https://golden.example';
const config = loadConfig({ fresh: true });

function packFor(region, opts = {}) {
  return buildPack({ region, origin: ORIGIN, addonId: 'com.nuvio.golden.catalogue.in', ...opts });
}

/** A photo-like poster: gradients with grain, deterministic per seed. */
async function poster(seed) {
  const w = 342;
  const h = 513;
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const i = (y * w + x) * 3;
      buf[i] = ((x / w) * 180 + (seed % 60) + (s % 30)) | 0;
      buf[i + 1] = ((y / h) * 160 + (s % 25)) | 0;
      buf[i + 2] = (((x + y) / (w + h)) * 200 + (s % 20)) | 0;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

test('the pack is a short tree: few sections, groups hold their members as rows', () => {
  const pack = packFor('IN', { video: true });
  assert.ok(pack.length >= 5 && pack.length <= 8, `${pack.length} top-level sections`);
  const folders = regionFolders('IN').folders;
  const groups = [...folders.values()].filter((f) => f.kind === 'group');
  assert.ok(groups.length > 0, 'some folders nest other folders');
  const tiles = new Map(pack.flatMap((c) => c.folders.map((f) => [f.id.slice(c.id.length + 1), f])));
  for (const g of groups) {
    const tile = tiles.get(g.key);
    if (!tile) continue; // a group can be hidden in this region
    const labels = tile.sources.map((s) => s.genre);
    for (const m of g.members) assert.ok(labels.includes(m.title), `${g.key} has a row for ${m.title}`);
    for (const s of tile.sources) assert.ok(s.catalogId.endsWith(`,${g.members.find((m) => m.title === s.genre).key}`));
  }
});

test('plain folders get facet rows, named by their catalog and in a fixed order', () => {
  const pack = packFor('IN', { video: true });
  const m = buildManifest(config, { engine: true });
  const names = new Map(m.catalogs.map((c) => [c.id, c.name]));
  const netflix = pack.flatMap((c) => c.folders).find((f) => f.id.endsWith('-netflix'));
  assert.ok(netflix, 'Netflix tile');
  const rows = netflix.sources.map((s) => names.get(s.catalogId.split(',')[0]));
  assert.ok(rows.includes('Trending Movies') && rows.includes('Original Series'), rows.join(' | '));
  for (const s of netflix.sources) {
    assert.equal(s.genre, undefined, 'facet rows take the catalog name as the row title');
    assert.ok(names.has(s.catalogId.split(',')[0]), `${s.catalogId} declared in the manifest`);
  }
  assert.equal(new Set(netflix.sources.map((s) => s.catalogId)).size, netflix.sources.length, 'no repeated row');
});

test('folders carry a hero video and collections a backdrop', () => {
  const pack = packFor('IN', { video: true });
  for (const c of pack) {
    assert.match(c.backdropImageUrl, /\/hero\.jpg\?v=4$/);
    for (const f of c.folders) {
      assert.match(f.heroVideoUrl, new RegExp(`^${ORIGIN}/art/folder/IN/[a-z0-9-]+/hero\\.mp4\\?v=4$`));
      assert.equal(f.focusGifEnabled, true);
    }
  }
});

test('motion off gives a still pack, video off keeps the focus loops', () => {
  const still = packFor('IN', { motion: false, video: true });
  for (const f of still.flatMap((c) => c.folders)) {
    assert.equal(f.heroVideoUrl, null);
    assert.equal(f.focusGifUrl, null);
    assert.equal(f.focusGifEnabled, false);
    assert.ok(f.coverImageUrl && f.heroBackdropUrl, 'stills stay');
  }
  const noVideo = packFor('IN', { video: false });
  for (const f of noVideo.flatMap((c) => c.folders)) {
    assert.equal(f.heroVideoUrl, null);
    assert.match(f.focusGifUrl, /focus\.webp/);
  }
});

test('pack stats count collections, tiles and rows', () => {
  const s = packStats('IN');
  const pack = packFor('IN', { video: true });
  assert.equal(s.collections, pack.length);
  assert.equal(s.folders, pack.reduce((n, c) => n + c.folders.length, 0));
  assert.equal(s.rows, pack.reduce((n, c) => n + c.folders.reduce((k, f) => k + f.sources.length, 0), 0));
  assert.ok(Buffer.byteLength(JSON.stringify(pack)) < 400 * 1024, 'pack stays small enough to import');
});

test('the edition manifest declares the facet catalogs and stays under 8KB', () => {
  for (const region of ['IN', 'US', 'GB']) {
    const m = buildManifest(Object.assign({}, config, { defaults: Object.assign({}, config.defaults, { region }) }), {
      engine: true,
    });
    const gc = m.catalogs.filter((c) => c.id.startsWith('gc-'));
    assert.ok(gc.length >= 10, `${region}: ${gc.length} engine catalogs`);
    for (const c of gc) {
      const search = c.extra.find((e) => e.name === 'search');
      assert.equal(search && search.isRequired, true, `${c.id} stays off Home, Discover and Search`);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(m)) < 8192, `${region} manifest under the SDK limit`);
  }
});

test('hero video frames: deterministic, start on the still, and move', async () => {
  const posters = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => poster(k * 7919)));
  const a = await render.heroVideoFrames({ posters });
  const b = await render.heroVideoFrames({ posters });
  const [W, H] = render.HERO_VIDEO.size;
  assert.deepEqual([a.width, a.height], [W, H]);
  assert.equal(a.count, render.HERO_VIDEO.fps * render.HERO_VIDEO.seconds);
  const f0 = Buffer.from(a.frame(0));
  assert.equal(f0.length, W * H * 3);
  assert.ok(f0.equals(b.frame(0)), 'same posters, same frames');
  const mid = Buffer.from(a.frame(a.count / 2));
  assert.ok(!mid.equals(f0), 'the wall moves');
  assert.ok(Buffer.from(a.frame(a.count)).equals(f0), 'the loop ends where it starts');
  // Frame 0 is the hero still (before shading): compare at a small size.
  const still = await sharp(await render.renderFolderHero({ posters })).resize(160, 90).greyscale().raw().toBuffer();
  const shaded = await sharp(f0, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: a.shade }])
    .png()
    .toBuffer();
  const first = await sharp(shaded).resize(160, 90).greyscale().raw().toBuffer();
  let corr = 0;
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const ms = mean(still);
  const mf = mean(first);
  let vs = 0;
  let vf = 0;
  for (let i = 0; i < still.length; i++) {
    corr += (still[i] - ms) * (first[i] - mf);
    vs += (still[i] - ms) ** 2;
    vf += (first[i] - mf) ** 2;
  }
  const r = corr / Math.sqrt(vs * vf);
  assert.ok(r > 0.8, `the first frame lays out like the still (r = ${r.toFixed(3)})`);
  assert.equal(await render.heroVideoFrames({ posters: [] }), null, 'nothing to show, no video');
});

test('hero video encodes to a small fast-start MP4', { skip: !videoEnabled() && 'ffmpeg not available' }, async () => {
  const posters = await Promise.all([1, 2, 3, 4].map((k) => poster(k * 104729)));
  const started = Date.now();
  const buf = await encodeHeroVideo(await render.heroVideoFrames({ posters }));
  const ms = Date.now() - started;
  assert.equal(buf.subarray(4, 8).toString('latin1'), 'ftyp');
  const moov = buf.indexOf('moov', 0, 'latin1');
  const mdat = buf.indexOf('mdat', 0, 'latin1');
  assert.ok(moov > 0 && moov < mdat, 'moov before mdat, so playback starts at once');
  assert.ok(buf.length > 50 * 1024 && buf.length < 4 * 1024 * 1024, `${Math.round(buf.length / 1024)} KB`);
  assert.ok(ms < 30000, `encoded in ${ms} ms`);
});

/** Minimal response double for sendVideo. */
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.set = (k, v) => {
    res.headers[k.toLowerCase()] = v;
    return res;
  };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.send = (b) => {
    res.body = b;
  };
  res.end = () => {
    res.body = Buffer.alloc(0);
  };
  return res;
}

test('hero.mp4 answers byte ranges', () => {
  const buf = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const call = (range) => {
    const res = fakeRes();
    sendVideo({ headers: range ? { range } : {} }, res, { buf, degraded: false }, 'public, max-age=60');
    return res;
  };
  const whole = call();
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.body.length, 1000);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['content-type'], 'video/mp4');
  const head = call('bytes=0-99');
  assert.equal(head.statusCode, 206);
  assert.equal(head.headers['content-range'], 'bytes 0-99/1000');
  assert.ok(head.body.equals(buf.subarray(0, 100)));
  assert.equal(head.headers.etag, whole.headers.etag, 'parts carry the ETag of the whole file');
  const open = call('bytes=900-');
  assert.equal(open.headers['content-range'], 'bytes 900-999/1000');
  const tail = call('bytes=-10');
  assert.equal(tail.headers['content-range'], 'bytes 990-999/1000');
  const over = call('bytes=0-5000');
  assert.equal(over.headers['content-range'], 'bytes 0-999/1000');
  assert.equal(call('bytes=1000-').statusCode, 416);
  assert.equal(call('bytes=1000-').headers['content-range'], 'bytes */1000');
  assert.equal(call('bytes=0-1,5-9').statusCode, 200, 'multiple ranges get the whole file');
  assert.equal(call('items=0-1').statusCode, 200);
});

describeRoute();

function describeRoute() {
  const app = require('../api/index');
  let server;
  let base;
  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });
  after(() => server && server.close());

  test('hero.mp4 is off when HERO_VIDEO=off, and the pack drops it', async () => {
    const prev = process.env.HERO_VIDEO;
    process.env.HERO_VIDEO = 'off';
    try {
      const res = await fetch(`${base}/art/folder/IN/netflix/hero.mp4?v=4`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const pack = await (await fetch(`${base}/r/IN/collections.json`)).json();
      assert.equal(pack[0].folders[0].heroVideoUrl, null);
    } finally {
      if (prev === undefined) delete process.env.HERO_VIDEO;
      else process.env.HERO_VIDEO = prev;
    }
  });

  test('hero.mp4 without posters is a short-lived 404, so Nuvio keeps the still', { skip: !videoEnabled() && 'ffmpeg not available' }, async () => {
    // Tests run without a TMDB key: no posters to show.
    const res = await fetch(`${base}/art/folder/IN/netflix/hero.mp4?v=4`);
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get('cache-control'), /s-maxage=86400/);
  });

  test('?motion=off serves a still pack', async () => {
    const pack = await (await fetch(`${base}/r/IN/collections.json?motion=off`)).json();
    for (const f of pack.flatMap((c) => c.folders)) {
      assert.equal(f.focusGifUrl, null);
      assert.equal(f.heroVideoUrl, null);
    }
  });
}

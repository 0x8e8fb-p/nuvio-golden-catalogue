'use strict';
/**
 * v5: sub-folder rows, related-film rows, no title twice down a folder page,
 * the zero-repeat art plan and the signature motion families.
 * No network: fake TMDB clients and synthetic pictures.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { regionFolders } = require('../src/collections/engine');
const { rowCatalogId } = require('../src/collections/facets');
const { relatedFilms } = require('../src/collections/folder-feed');
const { createCatalogHandler } = require('../src/handlers/catalog');
const { loadConfig } = require('../src/lib/config-loader');
const { allocate, SLOTS, folderArtVersion } = require('../src/art/plan');
const motion = require('../src/art/motion');

const IN = regionFolders('IN');

describe('level 1: folders inside folders', () => {
  test('sub-folders are hidden entries with a parent, keyed <parent>--<sub>', () => {
    const subs = [...IN.folders.values()].filter((f) => f.parent);
    assert.ok(subs.length >= 40, `only ${subs.length} sub-folders`);
    for (const s of subs) {
      assert.ok(s.key.startsWith(`${s.parent}--`), s.key);
      assert.ok(IN.folders.has(s.parent), `orphan ${s.key}`);
    }
    const visible = IN.collections.flatMap((c) => c.entries.map((e) => e.key));
    for (const k of visible) assert.ok(!k.includes('--'), `sub-folder ${k} shown as a tile`);
  });
  test('every tile is a full page of rows, no row twice', () => {
    for (const c of IN.collections) {
      for (const e of c.entries) {
        const tile = IN.folders.get(e.key);
        // A ranked list (IMDb Top 250) is one row by design.
        const floor = tile.kind === 'list' ? 1 : ['collection', 'parts', 'person'].includes(tile.kind) ? 6 : 3;
        assert.ok(tile.rows.length >= floor, `${e.key}: ${tile.rows.length} rows`);
        assert.ok(tile.rows.length <= 14, `${e.key}: ${tile.rows.length} rows`);
        const ids = tile.rows.map((r) => rowCatalogId(r.type, r.key, r.facet));
        assert.equal(new Set(ids).size, ids.length, `${e.key} repeats a row`);
      }
    }
  });
});

describe('level 1: related films', () => {
  const film = (id, votes, date = '2001-01-01') => ({ id, title: `F${id}`, vote_count: votes, release_date: date, poster_path: `/p${id}.jpg` });
  test('interleaves the best-known films\' recommendations, without the list\'s own films', async () => {
    const calls = [];
    const client = {
      hasKey: () => true,
      async get(endpoint) {
        calls.push(endpoint);
        if (endpoint === '/collection/77') return { parts: [film(1, 10), film(2, 900), film(3, 50)] };
        const m = endpoint.match(/^\/movie\/(\d+)\/recommendations$/);
        if (m) {
          const id = Number(m[1]);
          return { results: [film(id * 100 + 1, 5), film(2, 5), film(id * 100 + 2, 5), film(id * 100 + 3, 5, '2999-01-01')] };
        }
        return { results: [] };
      },
    };
    const items = await relatedFilms(client, { franchise: 77 }, 'recommendations');
    const ids = items.map((m) => m.id);
    assert.ok(!ids.includes(2), 'own film');
    assert.ok(!ids.includes(203) && !ids.includes(103), 'unreleased');
    // Most-voted seed first, interleaved.
    assert.deepEqual(ids.slice(0, 3), [201, 301, 101]);
    assert.equal(new Set(ids).size, ids.length);
  });
  test('leading faces: the actors the list keeps casting, elsewhere', async () => {
    const asked = [];
    const client = {
      hasKey: () => true,
      async get(endpoint, params) {
        if (endpoint === '/collection/88') return { parts: [film(1, 900), film(2, 800), film(3, 700)] };
        if (endpoint.endsWith('/credits')) {
          const id = Number(endpoint.split('/')[2]);
          return { cast: [{ id: 500, order: 0 }, { id: 600 + id, order: 1 }, { id: 700, order: 9 }] };
        }
        if (endpoint === '/discover/movie') {
          asked.push(params);
          return { results: [film(1, 900), film(40 + params.page, 10), film(50 + params.page, 10)] };
        }
        return { results: [] };
      },
    };
    const items = await relatedFilms(client, { franchise: 88 }, 'cast');
    assert.equal(asked[0].with_cast, '500', 'the regular, not one-offs or extras');
    assert.deepEqual(items.map((m) => m.id), [41, 51, 42, 52]);
  });
  test('same era: the list\'s genre from its own years', async () => {
    const asked = [];
    const g = (id, votes, year, genres) => ({ ...film(id, votes, `${year}-05-01`), genre_ids: genres });
    const client = {
      hasKey: () => true,
      async get(endpoint, params) {
        if (endpoint === '/collection/99') return { parts: [g(1, 900, 1980, [28, 12]), g(2, 800, 1983, [28, 12]), g(3, 700, 1999, [28])] };
        if (endpoint === '/discover/movie') {
          asked.push(params);
          return { results: [film(70 + params.page, 10)] };
        }
        return { results: [] };
      },
    };
    const items = await relatedFilms(client, { franchise: 99 }, 'era');
    assert.equal(asked[0].with_genres, '28,12');
    assert.equal(asked[0]['primary_release_date.gte'], '1978-01-01');
    assert.equal(asked[0]['primary_release_date.lte'], '1991-12-31');
    assert.deepEqual(items.map((m) => m.id), [71, 72]);
  });
  test('an unknown mode is no row', async () => {
    assert.deepEqual(await relatedFilms({ get: async () => ({}) }, { franchise: 1 }, 'nope'), []);
  });
});

describe('level 2: no title twice down a folder page', () => {
  test('rows below leave out what the rows above already show', async () => {
    const results = [];
    for (let i = 1; i <= 20; i++) {
      results.push({ id: i, title: `M${i}`, name: `S${i}`, poster_path: `/p${i}.jpg`, backdrop_path: `/b${i}.jpg`, release_date: '2020-01-01', first_air_date: '2020-01-01', vote_average: 7, vote_count: 500 });
    }
    // Every list returns the same titles: the worst case.
    const client = {
      hasKey: () => true,
      language: 'en-US',
      async get(endpoint, params = {}) {
        const m = endpoint.match(/\/(movie|tv)\/(\d+)\/external_ids/);
        if (m) return { imdb_id: `tt${m[2].padStart(7, '0')}` };
        const page = params.page || 1;
        return { results: results.map((r) => ({ ...r, id: r.id + (page - 1) * 20 })), total_pages: 10, page };
      },
    };
    const config = loadConfig();
    config.defaults.region = 'IN';
    const handler = createCatalogHandler(config, { client });
    const tile = IN.folders.get('netflix');
    const seen = new Set();
    let dupes = 0;
    let shown = 0;
    for (const row of tile.rows.slice(0, 5)) {
      const { metas } = await handler({ type: row.type, id: rowCatalogId(row.type, row.key, row.facet), extra: {} });
      for (const m of metas.slice(0, 10)) {
        shown++;
        if (seen.has(row.type + m.id)) dupes++;
      }
      for (const m of metas.slice(0, 10)) seen.add(row.type + m.id);
    }
    assert.ok(shown > 0);
    assert.equal(dupes, 0, `${dupes} of ${shown} titles repeat a row above`);
  });
});

describe('level 3: zero-repeat art plan', () => {
  const titles = (prefix, n, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ t: 'm', id: from + i, b: `/${prefix}b${from + i}.jpg`, p: `/${prefix}p${from + i}.jpg`, v: 100 - i }));
  test('no image twice, the scarcest tile first, collections get their own', () => {
    // Two tiles share every title; the small one must win them.
    const small = { key: 'director', titles: titles('', 7) };
    const big = { key: 'drama', titles: [...titles('', 7), ...titles('', 40, 8)] };
    const plan = allocate([big, small], [{ id: 'genres', tiles: ['drama', 'director'] }]);
    const all = [];
    for (const t of Object.values(plan.tiles)) all.push(...t.focus, ...t.hero, ...t.posters);
    all.push(...Object.values(plan.collections));
    assert.equal(new Set(all).size, all.length, 'an image is used twice');
    assert.deepEqual(plan.tiles.director.focus, ['/b1.jpg', '/b2.jpg', '/b3.jpg', '/b4.jpg']);
    assert.equal(plan.tiles.director.hero.length, SLOTS.hero);
    assert.ok(!plan.tiles.drama.focus.some((p) => ['/b1.jpg', '/b2.jpg', '/b3.jpg'].includes(p)));
    assert.ok(plan.collections.genres);
    assert.deepEqual(plan.stats.short, []);
  });
  test('a short tile falls back to more images of its titles, and is reported', () => {
    const tile = { key: 'tiny', titles: titles('', 2), extra: { m1: { b: ['/x1.jpg', '/x2.jpg', '/x3.jpg'] } } };
    const plan = allocate([tile], [], { slots: { focus: 4, hero: 3, posters: 0 } });
    const used = [...plan.tiles.tiny.focus, ...plan.tiles.tiny.hero];
    assert.equal(new Set(used).size, used.length);
    assert.equal(used.length, 5);
    assert.deepEqual(plan.stats.short, ['tiny:4/1/0']);
  });
  test('folder art URLs carry the plan version', () => {
    assert.match(folderArtVersion('IN'), /^5(\.[0-9a-f]{8})?$/);
  });
});

describe('level 4: signature motion', () => {
  const pictures = [];
  before(async () => {
    const colours = [[200, 40, 40], [40, 160, 60], [40, 70, 200], [220, 180, 40]];
    for (const [r, g, b] of colours) {
      pictures.push(await sharp({ create: { width: 320, height: 180, channels: 3, background: { r, g, b } } }).jpeg().toBuffer());
    }
  });
  test('every tile has a known family, and the home screen shows many', () => {
    const names = new Set();
    for (const c of IN.collections) {
      for (const e of c.entries) {
        const fam = motion.familyFor({ ...IN.folders.get(e.key), collectionId: c.id });
        assert.ok(motion.FAMILIES[fam.name], `${e.key}: ${fam.name}`);
        assert.ok(Number.isInteger(fam.seed));
        names.add(fam.name);
      }
      assert.ok(motion.FAMILIES[motion.collectionFamily(c.id).name]);
    }
    assert.ok(names.size >= 15, `only ${names.size} families on screen`);
  });
  test('no tile has the same motion as its neighbour', () => {
    for (const c of IN.collections) {
      const row = c.entries.map((e) => motion.familyFor({ ...IN.folders.get(e.key), collectionId: c.id }).name);
      row.forEach((n, i) => assert.ok(i === 0 || row[i - 1] !== n, `${c.id}: ${c.entries[i].key} repeats ${n}`));
    }
    assert.equal(motion.familyFor({ key: 'james-bond', kind: 'collection', collectionId: 'franchises' }).name, 'iris');
  });
  test('focus loops: 4 pictures x 12 frames at 100 ms (WebP), and a GIF', async () => {
    const family = { name: 'iris', seed: 7 };
    const webp = await motion.renderMotionFocus({ backdrops: pictures, family, wordmark: 'Test', format: 'webp' });
    const meta = await sharp(webp, { animated: true }).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.pages, 48);
    assert.ok(meta.delay.every((d) => d === 100));
    const gif = await motion.renderMotionFocus({ backdrops: pictures, family, wordmark: 'Test', format: 'gif' });
    const g = await sharp(gif, { animated: true }).metadata();
    assert.equal(g.format, 'gif');
    assert.ok(g.pages >= 4);
  });
  test('cover, hero still and video frames', async () => {
    const family = { name: 'ghost', seed: 3 };
    const cover = await sharp(await motion.renderMotionCover({ shape: 'poster', backdrop: pictures[0], family, wordmark: 'Test' })).metadata();
    assert.equal(cover.format, 'jpeg');
    const hero = await sharp(await motion.renderMotionHero({ backdrops: pictures.slice(0, 3), family })).metadata();
    assert.deepEqual([hero.width, hero.height], [1920, 1080]);
    const video = await motion.motionVideoFrames({ backdrops: pictures.slice(0, 3), family });
    assert.equal(video.count, 180);
    assert.equal(video.fps, 30);
    const f0 = video.frame(0);
    assert.equal(f0.length, video.width * video.height * 3);
    assert.notEqual(video.frame(1), f0, 'a fresh buffer per frame');
    assert.equal(await motion.motionVideoFrames({ backdrops: [], family }), null);
  });
  test('every family renders a focus frame', async () => {
    for (const name of Object.keys(motion.FAMILIES)) {
      const cover = await motion.renderMotionCover({ shape: 'landscape', backdrop: pictures[1], family: { name, seed: 1 }, wordmark: name });
      assert.equal((await sharp(cover).metadata()).format, 'jpeg', name);
    }
  });
});

describe('routes: collection backdrops and art candidates', () => {
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
  test('a collection backdrop is a JPEG; unknown collections 404', async () => {
    const id = IN.collections[0].id;
    const res = await fetch(`${base}/art/collection/IN/${id}/backdrop.jpg?v=5`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${base}/art/collection/IN/nope/backdrop.jpg?v=5`)).status, 404);
    const extra = await fetch(`${base}/art/collection/IN/${id}/backdrop.jpg?v=5&x=1`, { redirect: 'manual' });
    assert.equal(extra.status, 301);
  });
  test('candidates are JSON for known tiles only', async () => {
    const res = await fetch(`${base}/art/candidates/IN/netflix.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.titles));
    assert.equal((await fetch(`${base}/art/candidates/IN/nope.json`)).status, 404);
  });
});

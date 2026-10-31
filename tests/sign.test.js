'use strict';

/**
 * Signed artwork URLs: malformed signatures, the canonical query the signature
 * covers, round trips through both URL decoders the addon meets (WHATWG URL and
 * Express's req.query), tampering, and the key used by an unconfigured
 * deployment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { buildArtUrl, verify, signature, canonical } = require('../src/art/sign');

const PATH = '/art/tile.jpg';

function paramsOf(url) {
  return Object.fromEntries(new URL(url).searchParams);
}

/** Start an app that reports whether verify() accepts the request it got. */
async function startVerifier() {
  const app = express();
  app.use((req, res) => res.json({ ok: verify(req.path, req.query), query: req.query }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('a 22-character signature with multibyte characters is rejected without throwing', () => {
  const params = paramsOf(buildArtUrl('https://x.example', PATH, { t: 'movie', id: 603 }));
  const forged = ['\u00e9' + 'A'.repeat(21), 'A'.repeat(21) + '\u0915', '\u{10348}'.repeat(11)];
  for (const s of forged) {
    assert.equal(s.length, 22, 'same length as a real signature, more bytes');
    assert.doesNotThrow(() => verify(PATH, { ...params, s }));
    assert.equal(verify(PATH, { ...params, s }), false);
  }
});

test('malformed parameters are rejected without throwing', () => {
  const params = paramsOf(buildArtUrl('https://x.example', PATH, { t: 'movie', id: 603, n: 'The Matrix' }));
  // Shapes Express's query parser produces for repeated and bracketed keys.
  const inputs = [
    null,
    undefined,
    'not an object',
    { ...params, s: undefined },
    { ...params, s: [params.s] },
    { ...params, s: { toString: 'x' } },
    { ...params, n: { toString: 'x' } },
    { ...params, n: ['The', 'Matrix'] },
    { ...params, s: params.s.slice(1) },
    { ...params, s: `${params.s}A` },
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => verify(PATH, input));
    assert.equal(verify(PATH, input), false, JSON.stringify(input));
  }
  assert.equal(verify(PATH, params), true);
});

test('a value containing "&ol=en" does not sign like a separate parameter', () => {
  assert.notEqual(signature(PATH, { n: 'x&ol=en' }), signature(PATH, { n: 'x', ol: 'en' }));
  assert.notEqual(canonical(PATH, { n: 'x&ol=en' }), canonical(PATH, { n: 'x', ol: 'en' }));
  assert.notEqual(signature(PATH, { n: 'a=b' }), signature(PATH, { 'n=a': 'b' }));
  // Sorted keys, form-encoded values, path prefix kept.
  assert.equal(canonical(PATH, { t: 'movie', n: 'Fast & Furious', id: 9799, s: 'ignored' }), `${PATH}?id=9799&n=Fast+%26+Furious&t=movie`);
});

const TITLES = [
  'कल्कि 2898 एडी',
  'పుష్ప',
  'Fast & Furious',
  'x&ol=en',
  'a+b=c',
  'C++ 100% Pure',
  '50%25 literal',
  '  spaced  out  ',
  'Spider-Man: Across the Spider-Verse',
  'Amélie',
  "L'Été meurtrier",
  'What? #1 / [Uncut]',
  'Tab\tand\nnewline',
];

test('signed URLs verify after decoding with URL and with Express', async () => {
  const { server, base } = await startVerifier();
  try {
    for (const n of TITLES) {
      const url = buildArtUrl(base, PATH, { t: 'movie', id: 603, b: '/abc123.jpg', n, ol: 'hi' });
      assert.equal(verify(PATH, paramsOf(url)), true, `URL decoding: ${n}`);
      const body = await (await fetch(url)).json();
      assert.equal(body.ok, true, `Express decoding: ${n}`);
      assert.equal(body.query.n, n, `Express sees the title unchanged: ${n}`);
    }
    // A title cut inside a surrogate pair still verifies (both sides see U+FFFD).
    const cut = buildArtUrl(base, PATH, { t: 'movie', id: 603, n: 'Title \uD835' });
    assert.equal(verify(PATH, paramsOf(cut)), true);
    assert.equal((await (await fetch(cut)).json()).ok, true);
  } finally {
    server.close();
  }
});

test('changing, removing or adding any parameter breaks the signature', () => {
  const params = paramsOf(
    buildArtUrl('https://x.example', PATH, { t: 'series', id: 1399, b: '/abc123.jpg', n: 'Game of Thrones', ol: 'en' })
  );
  assert.equal(verify(PATH, params), true);
  for (const key of Object.keys(params)) {
    if (key === 's') continue;
    assert.equal(verify(PATH, { ...params, [key]: `${params[key]}x` }), false, `changed ${key}`);
    const without = { ...params };
    delete without[key];
    assert.equal(verify(PATH, without), false, `removed ${key}`);
  }
  assert.equal(verify(PATH, { ...params, extra: '1' }), false, 'added a parameter');
  assert.equal(verify('/art/rank.jpg', params), false, 'another path');
  const flipped = (params.s[0] === 'A' ? 'B' : 'A') + params.s.slice(1);
  assert.equal(verify(PATH, { ...params, s: flipped }), false, 'changed signature');
});

test('a Vercel deployment without keys does not sign with the public development key', () => {
  const names = ['ART_SECRET', 'TMDB_API_KEY', 'VERCEL'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const params = { t: 'movie', id: '603', v: '1' };
  const devKey = (p) =>
    crypto.createHmac('sha256', 'golden-art-local-dev').update(canonical(PATH, p)).digest('base64url').slice(0, 22);
  try {
    for (const k of names) delete process.env[k];
    assert.equal(signature(PATH, params), devKey(params), 'local development keeps the fixed key');
    process.env.VERCEL = '1';
    const sig = signature(PATH, params);
    assert.notEqual(sig, devKey(params));
    assert.equal(signature(PATH, params), sig, 'stable within the process');
    assert.equal(verify(PATH, paramsOf(buildArtUrl('https://x.example', PATH, params))), true);
  } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

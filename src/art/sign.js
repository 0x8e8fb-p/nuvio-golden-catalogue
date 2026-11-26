'use strict';

/**
 * Signed artwork URLs.
 *
 * Artwork endpoints render images on demand, which costs CPU. Every art URL the
 * addon hands out carries a short HMAC signature over its path and parameters,
 * so a deployment cannot be used as a free image compositor by strangers. The
 * key comes from ART_SECRET, or is derived from TMDB_API_KEY so it stays stable
 * without any extra setup. URLs survive redeploys as long as the key does.
 */

const crypto = require('node:crypto');

/** Bump to invalidate every cached artwork URL after a design change. */
const ART_VERSION = '4';

// A signature is the first 22 characters of a base64url HMAC.
const SIGNATURE_RE = /^[A-Za-z0-9_-]{22}$/;

let processSecret = null;

function secret() {
  if (process.env.ART_SECRET) return process.env.ART_SECRET;
  if (process.env.TMDB_API_KEY) {
    return crypto.createHash('sha256').update(`golden-art:${process.env.TMDB_API_KEY}`).digest('hex');
  }
  // The local development key below is public. A deployment without either key
  // gets a random key per process instead, so nobody else can sign URLs for it.
  if (process.env.VERCEL) {
    if (!processSecret) processSecret = crypto.randomBytes(32);
    return processSecret;
  }
  return 'golden-art-local-dev';
}

function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (k === 's' || v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * Stable string the signature covers: path plus sorted params (minus s). Keys
 * and values are form-encoded, so a value containing "&" or "=" cannot pass for
 * another parameter.
 * @param {string} pathname e.g. "/art/tile.jpg"
 * @param {object} params query parameters (empty values are dropped)
 * @returns {string}
 */
function canonical(pathname, params) {
  const clean = cleanParams(params);
  const entries = Object.keys(clean)
    .sort()
    .map((k) => [k, clean[k]]);
  return `${pathname}?${new URLSearchParams(entries).toString()}`;
}

/**
 * Signature of a path and its params: 22 base64url characters of an HMAC-SHA256
 * over canonical().
 * @param {string} pathname e.g. "/art/tile.jpg"
 * @param {object} params query parameters (s and empty values are ignored)
 * @returns {string}
 */
function signature(pathname, params) {
  return crypto
    .createHmac('sha256', secret())
    .update(canonical(pathname, params))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Verify the `s` parameter of an incoming art request. Never throws: malformed
 * input is an invalid signature.
 * @param {string} pathname e.g. "/art/tile.jpg"
 * @param {object} params decoded query parameters
 * @returns {boolean}
 */
function verify(pathname, params) {
  if (!params || typeof params !== 'object') return false;
  const given = params.s;
  // Checked first: a 22-character string with a multibyte character is longer
  // than 22 bytes, and timingSafeEqual throws on buffers of different lengths.
  if (typeof given !== 'string' || !SIGNATURE_RE.test(given)) return false;
  // Repeated or bracketed keys parse to arrays and objects. buildArtUrl never
  // produces them, and String() throws on some of them.
  for (const v of Object.values(params)) {
    if (v !== null && typeof v === 'object') return false;
  }
  const expected = signature(pathname, params);
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Build an absolute, signed artwork URL.
 * @param {string} origin e.g. "https://example.vercel.app"
 * @param {string} pathname e.g. "/art/tile.jpg"
 * @param {object} params query parameters (empty values are dropped)
 * @returns {string}
 */
function buildArtUrl(origin, pathname, params) {
  const clean = cleanParams({ ...params, v: ART_VERSION });
  const qs = new URLSearchParams({ ...clean, s: signature(pathname, clean) });
  return `${origin || ''}${pathname}?${qs.toString()}`;
}

module.exports = { ART_VERSION, buildArtUrl, verify, signature, canonical };

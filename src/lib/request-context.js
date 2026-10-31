'use strict';

/**
 * Per-request context (public origin) via AsyncLocalStorage.
 *
 * Catalog responses embed absolute artwork URLs (landscape tiles, rank tiles,
 * folder art) that must point back at the same public host the user installed
 * the addon from. The Stremio SDK router does not pass the HTTP request to
 * handlers, so an Express middleware captures the origin here and handlers
 * read it with currentOrigin().
 *
 * Resolution order: PUBLIC_BASE_URL env (explicit override), then the
 * request. Forwarded headers (X-Forwarded-Host, X-Forwarded-Proto) are only
 * trusted on Vercel, which sets them itself, or when TRUST_PROXY=1 says a
 * proxy in front does the same; elsewhere they are client input and would end
 * up in cached responses. Hosts and schemes are validated either way. Last
 * comes VERCEL_PROJECT_PRODUCTION_URL (Vercel's public production domain).
 * Deployment-specific Vercel URLs are deliberately not used: they sit behind
 * Vercel Authentication and a TV cannot load them.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const HOST_RE = /^(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

function trimSlash(s) {
  return String(s).replace(/\/+$/, '');
}

function envOrigin() {
  if (process.env.PUBLIC_BASE_URL) return trimSlash(process.env.PUBLIC_BASE_URL);
  return null;
}

function trustsProxy() {
  return Boolean(process.env.VERCEL) || process.env.TRUST_PROXY === '1';
}

const first = (v) => String(v || '').split(',')[0].trim();

/**
 * Derive the public origin (scheme + host) of an incoming request.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function originFromRequest(req) {
  const explicit = envOrigin();
  if (explicit) return explicit;
  const headers = (req && req.headers) || {};
  const proxy = trustsProxy();
  const host = first((proxy && headers['x-forwarded-host']) || headers.host);
  if (!host || !HOST_RE.test(host)) return null;
  const encrypted = Boolean(req && req.socket && req.socket.encrypted);
  const forwarded = proxy ? first(headers['x-forwarded-proto']).toLowerCase() : '';
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** Express middleware: runs the rest of the request inside a context. */
function contextMiddleware(req, res, next) {
  storage.run({ origin: originFromRequest(req) }, next);
}

/**
 * The public origin for the current request, or a sensible fallback.
 * @returns {string|null}
 */
function currentOrigin() {
  const store = storage.getStore();
  if (store && store.origin) return store.origin;
  const explicit = envOrigin();
  if (explicit) return explicit;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${trimSlash(process.env.VERCEL_PROJECT_PRODUCTION_URL)}`;
  }
  return null;
}

/** Run fn with an explicit origin (tests, scripts). */
function runWithOrigin(origin, fn) {
  return storage.run({ origin }, fn);
}

module.exports = { contextMiddleware, currentOrigin, originFromRequest, runWithOrigin };

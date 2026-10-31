'use strict';

/**
 * Resolves template placeholders in a config row's static params so rows can be
 * dynamic without code changes:
 *
 *   {{region}}          -> the edition's region (e.g. "IN")
 *   {{providers}}       -> TMDB provider ids of the region's major services
 *   {{provider:netflix}}-> TMDB provider ids of one service in the region
 *   {{now}}             -> today's date, YYYY-MM-DD (UTC)
 *   {{now-90d}}         -> 90 days ago, YYYY-MM-DD
 *   {{now+30d}}         -> 30 days ahead, YYYY-MM-DD
 *   {{year}}            -> current year, e.g. "2026"
 *   {{year-10}}         -> 10 years ago, e.g. "2016"
 *   {{monthStart}}      -> first day of the current month, YYYY-MM-DD
 *   {{yearStart}}       -> Jan 1 of the current year, YYYY-MM-DD
 *
 * A service that does not exist in the region resolves to UNAVAILABLE; rows
 * that need it are left out of that region's manifest (see isRowAvailable).
 * Only string values are templated; numbers/booleans pass through unchanged.
 */

const { providerIds, majorProviderIds, UNAVAILABLE } = require('./region');

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function resolveValue(value, ctx) {
  if (typeof value !== 'string') return value;

  const now = ctx.now;
  const d0 = new Date(now);

  if (value === '{{region}}') return ctx.region;
  if (value === '{{now}}') return fmtDate(d0);
  if (value === '{{year}}') return String(d0.getUTCFullYear());
  if (value === '{{providers}}') return majorProviderIds(ctx.region) || UNAVAILABLE;

  const mp = value.match(/^\{\{provider:([a-z0-9]+)\}\}$/);
  if (mp) return providerIds(mp[1], ctx.region) || UNAVAILABLE;

  if (value === '{{monthStart}}') {
    return fmtDate(new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)));
  }
  if (value === '{{yearStart}}') {
    return fmtDate(new Date(Date.UTC(d0.getUTCFullYear(), 0, 1)));
  }

  // {{now-90d}} / {{now+30d}}
  const md = value.match(/^\{\{now([+-])(\d+)d\}\}$/);
  if (md) {
    const sign = md[1] === '-' ? -1 : 1;
    const days = Number(md[2]);
    return fmtDate(new Date(now + sign * days * 24 * 60 * 60 * 1000));
  }

  // {{year-10}} -> N years ago; also usable inside a date: "{{year-3}}-12-31"
  const my = value.match(/^\{\{year-(\d+)\}\}(.*)$/);
  if (my) {
    return `${d0.getUTCFullYear() - Number(my[1])}${my[2]}`;
  }

  return value;
}

function resolveParams(params = {}, ctx = {}) {
  const region = ctx.region || 'US';
  const now = ctx.now || Date.now();
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = resolveValue(v, { region, now });
  }
  return out;
}

/** True when any resolved param needs a service the region does not have. */
function hasUnavailable(params) {
  return Object.values(params || {}).some((v) => v === UNAVAILABLE);
}

module.exports = { resolveParams, resolveValue, hasUnavailable };

'use strict';

/**
 * Config-driven catalog handler (Task 5 — core).
 *
 * For each request:
 *   1. Resolve the config row by id (+ type match).
 *   2. Merge the row's static source.params with the user's extras:
 *        - genre  -> mapped param (with_genres) via the genre-id lookup
 *        - search -> the TMDB search endpoint's `query` param
 *        - skip   -> TMDB `page` (Stremio page size is 100; TMDB is 20/page)
 *   3. Call TMDB and map results to tt-id meta previews (adult-safe).
 *
 * Pagination: Stremio sends skip in multiples of 100. TMDB pages are 20 items.
 * We translate a skip window into the right TMDB page(s) and slice. When a page
 * runs past TMDB's results we return a short/empty array, which Stremio treats
 * as end-of-catalog.
 *
 * Degrades gracefully: with no TMDB key, returns an empty catalog instead of
 * throwing, so the addon still boots and installs.
 */

const { createTmdbClient } = require('../tmdb/client');
const { toMetaPreviews, previewsFromImdbIds } = require('../tmdb/mappers');
const { resolveParams } = require('../lib/templating');
const { onThisWeekWindow, rotationPage } = require('../lib/schedule');
const { createMdblistSource } = require('../sources/mdblist');

const STREMIO_PAGE = 100; // Stremio's fixed catalogue page size
const TMDB_PAGE = 20; // TMDB's fixed results-per-page

function createCatalogHandler(config, deps = {}) {
  const client =
    deps.client ||
    createTmdbClient({
      language: config.defaults.language,
    });

  const byId = new Map(config.catalogues.map((c) => [c.id, c]));
  const genres = config.genres || {};
  const mdblist = deps.mdblist || createMdblistSource();

  function mapExtras(row, extra = {}) {
    const region = config.defaults.region || 'US';
    // Resolve static params with templating ({{region}}, {{now-90d}}, etc.).
    const params = resolveParams(row.source.params || {}, { region });
    let endpointOverride = null;

    for (const def of row.extra || []) {
      const value = extra[def.name];

      if (def.name === 'genre' && value) {
        const table = genres[row.type] || {};
        const id = table[value];
        const param = (def.mapTo && def.mapTo.param) || 'with_genres';
        if (id !== undefined) params[param] = id;
      }

      if (def.name === 'search' && value) {
        params.query = value;
      }
    }
    return { params, endpointOverride };
  }

  return async function catalogHandler(args) {
    const row = byId.get(args.id);
    if (!row || row.type !== args.type) {
      return { metas: [] };
    }

    if (!client.hasKey()) {
      // No key configured yet — valid empty catalogue.
      return { metas: [] };
    }

    const extra = args.extra || {};

    // A search-required row with no query returns empty (nothing to feed).
    const needsSearch = (row.extra || []).some(
      (e) => e.name === 'search' && e.isRequired
    );
    if (needsSearch && !extra.search) {
      return { metas: [] };
    }

    const skipBase = Number(extra.skip) || 0;
    const pageSizeCfg = config.defaults.pageSize || STREMIO_PAGE;

    // MDBList (or other) curated-list source: fetch tt ids, enrich via TMDB.
    if (row.source.list) {
      const ids = await mdblist.imdbIds(
        row.source.list,
        row.type,
        skipBase,
        skipBase + pageSizeCfg
      );
      const metas = await previewsFromImdbIds(client, ids, {
        stremioType: row.type,
        posterShape: row.posterShape || config.defaults.posterShape,
      });
      return {
        metas,
        cacheMaxAge: 6 * 3600,
        staleRevalidate: 6 * 3600,
        staleError: 24 * 3600,
      };
    }

    const { params } = mapExtras(row, extra);

    // Novel: "on this week in history" window — rewrite the date filters to a
    // past year's same calendar week, rotating daily for freshness.
    if (row.window === 'onThisWeek') {
      const w = onThisWeekWindow(Date.now());
      params['primary_release_date.gte'] = w.params['primary_release_date.gte'];
      params['primary_release_date.lte'] = w.params['primary_release_date.lte'];
    }

    // Novel: deterministic daily rotation — offset the first page by a
    // date-seeded amount so the row is stable within a day but refreshes daily.
    const rotateOffset = row.rotate ? (rotationPage(Date.now()) - 1) * TMDB_PAGE : 0;

    // Pagination: figure out which TMDB pages cover the requested skip window.
    const skip = skipBase + rotateOffset;
    const pageSize = pageSizeCfg;
    const windowStart = skip;
    const windowEnd = skip + pageSize;

    const firstTmdbPage = Math.floor(windowStart / TMDB_PAGE) + 1;
    const lastTmdbPage = Math.ceil(windowEnd / TMDB_PAGE);

    const collected = [];
    let totalPagesKnown = Infinity;

    for (let page = firstTmdbPage; page <= lastTmdbPage; page++) {
      if (page > totalPagesKnown) break;
      let data;
      try {
        data = await client.get(row.source.endpoint, { ...params, page });
      } catch (err) {
        if (err.code === 'NO_TMDB_KEY') return { metas: [] };
        // On a transient error, stop paging with what we have.
        break;
      }
      if (typeof data.total_pages === 'number') totalPagesKnown = data.total_pages;
      const results = data.results || [];
      // Tag the absolute index so we can slice the skip window precisely.
      const base = (page - 1) * TMDB_PAGE;
      results.forEach((r, i) => collected.push({ r, absIndex: base + i }));
      if (results.length < TMDB_PAGE) break; // no more results after this page
    }

    // Slice to the requested window, then map (mapping resolves tt ids).
    const windowItems = collected
      .filter((x) => x.absIndex >= windowStart && x.absIndex < windowEnd)
      .map((x) => x.r);

    const metas = await toMetaPreviews(client, windowItems, {
      stremioType: row.type,
      posterShape: row.posterShape || config.defaults.posterShape,
    });

    return {
      metas,
      // Cache per Stremio's cache headers to spare TMDB and speed up the TV.
      cacheMaxAge: 3600,
      staleRevalidate: 3600,
      staleError: 86400,
    };
  };
}

module.exports = { createCatalogHandler };

# Golden Catalogue — one addon for a tidy Nuvio / Stremio home

[![CI](https://github.com/0x8e8fb-p/nuvio-golden-catalogue/actions/workflows/ci.yml/badge.svg)](https://github.com/0x8e8fb-p/nuvio-golden-catalogue/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A single, well-organised catalogue for [Nuvio](https://github.com/haaihond/Nuvio-Wiki) and any
Stremio-compatible client. Paste **one manifest URL** once and your home screen gains a set of cleanly
named, deliberately ordered rows — trending, popular, new & top-rated, by genre, by streaming service,
by decade, anime, documentaries, kids & family, many regional languages, studios, franchises and
themes — instead of a pile of mismatched catalogues.

Because a single Stremio manifest is capped at 8KB (~75 rows), the full catalogue (80+ rows) is also
split into **presets** — themed, lean manifests you mix and match. Install as many as you like.

Everything is driven by **one config file** (`data/catalogue.config.json`). Edit that one file to
rename, reorder, add or remove rows. No code changes.

> **This addon provides catalogue _metadata_ only** (titles, posters, backgrounds, ratings, grouping).
> It emits IMDB (`tt`) ids, so your existing Nuvio/Stremio metadata and **stream** addons handle detail
> pages and playback exactly as before. It contains **no stream scraper and no piracy resolver**, and it
> excludes 18+/adult content everywhere.

---

## About "animations / GIFs"

A Stremio/Nuvio catalogue addon sends **data** (JSON with image URLs). It **cannot** ship UI animations
or animated artwork — motion is owned by the Nuvio/Stremio app, and the official clients render
posters and backgrounds as **still images**. So this project delivers rich *static* polish instead:

- high-resolution posters and 16:9 backdrops from TMDB,
- optional **ratings badges baked onto posters** via [RPDB](https://ratingposterdb.com) (free-tier keys exist),
- optional transparent **clearlogos** on detail pages via [fanart.tv](https://fanart.tv),
- clean descriptions, release years, and a tight, grouped row order.

If you were promised animated posters elsewhere — that isn't achievable through the addon protocol.

---

## What's inside

- **Time-aware rows** that reshape by the clock and calendar with no per-user data: a "Good
  {morning/evening}" pick, weeknight quick-watches vs weekend epics, late-night and Sunday-morning
  moods, and rows that only appear in their season. The manifest re-evaluates per request.
- **Runtime-budget rows**: Under 90 Minutes, One Sitting, Epics (150m+), via TMDB runtime filters.
- **Deterministic daily rotation**: "Today's Picks", "Hidden Gems" and "A Decade Ago" are seeded by
  the date, so they're stable within a day and refresh each day.
- **On This Week in Film History**: spotlights films from this calendar week in a past year, rotating.
- **Mood clusters**: Mind Benders, Cozy Rainy Day, Pure Adrenaline, built from keyword/genre blends.
- **80+ base catalogue rows** across movies, series, streaming services, decades, genres, anime,
  documentaries, kids, many regional languages, networks, studios, franchises, themes, seasonal,
  curated editorial lists, and keyless community lists (IMDb Top 250 and any public MDBList URL).
- **Presets + region routing** so the catalogue scales past Stremio's 8KB manifest cap.
- **Full detail pages** built from TMDB: cast, director, writer, trailers, genres, runtime, and the
  complete episode list for series — layered with Cinemeta, not dependent on it.
- **Optional enrichment**: RPDB ratings badges on posters, fanart.tv clearlogos, and AniList scores
  and genres for anime (all opt-in, all degrade gracefully).
- **Resilient by design**: a bounded TTL + LRU cache, a circuit breaker, and a 7-day stale-on-error
  store, so a TMDB outage serves last-known-good data instead of an empty row. Metrics on `/health`.
- **Interactive `/configure` page** to pick a region and presets and copy your install URLs.
- **One golden config file**, JSON-Schema-validated, with a CI guard that keeps the default
  manifest under 8KB even at peak time-aware activity.

## Install

If a Golden Catalogue instance is already deployed, open its landing page (the root URL) to see
one-click install buttons for the full catalogue and every preset. Or paste a manifest URL directly
into **Nuvio → Settings → Addons → Add Addon**:

```
https://YOUR-DEPLOYMENT.vercel.app/manifest.json          # curated default (40 rows)
https://YOUR-DEPLOYMENT.vercel.app/c/anime/manifest.json  # a single preset
https://YOUR-DEPLOYMENT.vercel.app/r/IN/c/streaming/manifest.json  # preset, region-scoped
```

One-click (desktop/mobile apps that register the `stremio://` scheme — note GitHub won't make this
clickable, so copy it into your browser's address bar):

```
stremio://YOUR-DEPLOYMENT.vercel.app/manifest.json
```

### Presets — the full catalogue without the 8KB limit

A single Stremio manifest is capped at 8KB (~75 rows). The full catalogue is 80+ rows, so it is also
split into themed **presets** you mix and match. Each is a lean, independent manifest:

`movies`, `series`, `streaming`, `anime`, `docs`, `kids`, `decades`, `regional`, `networks`,
`studios`, `franchises`, `themes`, `seasonal`, `curated`, `lists`, `now`, `runtime`, `discovery`,
`onthisday`.

- Install URL: `…/c/<preset>/manifest.json`
- Region-scoped (for accurate "streaming now" rows in your country):
  `…/r/<CC>/c/<preset>/manifest.json` where `<CC>` is a 2-letter country code (e.g. `IN`, `GB`, `US`).
- `GET …/presets.json` returns the machine-readable preset list; `GET …/health` reports service status.

> **Tip (Nuvio):** metadata addons are processed top-to-bottom. Keep Golden Catalogue high in your
> addon list so its rows load promptly.

---

## Deploy your own (about 5 minutes, free)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/0x8e8fb-p/nuvio-golden-catalogue&env=TMDB_API_KEY&envDescription=Your%20free%20TMDB%20v3%20API%20key)

You host your own copy so the TMDB key stays yours.

1. **Get a free TMDB API key** — sign up at <https://www.themoviedb.org/settings/api> and copy the
   **API Key (v3 auth)**.
2. **Fork this repo** (or click *Use this template*).
3. **Deploy to Vercel:**
   - Go to <https://vercel.com> → **Add New → Project** → import your fork.
   - Framework preset: **Other**. Click **Deploy** (the first build will succeed even before the key is set).
   - In **Project → Settings → Environment Variables**, add:
     - `TMDB_API_KEY` = your key *(required)*
     - `RPDB_API_KEY` = `t0-free-rpdb` *(optional — ratings badges on posters)*
     - `FANART_API_KEY` = your fanart.tv key *(optional — clearlogos on detail pages)*
   - **Redeploy** so the new env vars take effect.
4. Your manifest URL is `https://<project>.vercel.app/manifest.json`. Paste it into Nuvio.

Every push to `main` auto-deploys. CORS is handled by the addon router.

### Alternative host
The code uses the official `stremio-addon-sdk`. `src/index.js` runs a standalone server
(`serveHTTP`) for local/VPS use; `api/index.js` + `vercel.json` adapt it for Vercel via `getRouter`.
Any Node host (Render, a VPS, etc.) can run `npm start` with the env vars set. Cloudflare Workers/Deno
would require rewriting the routes against the `fetch` model (the SDK is Node-based).

---

## Customise — the single golden config

Open [`data/catalogue.config.json`](./data/catalogue.config.json). Each row looks like:

```jsonc
{
  "id": "popular-movies",          // unique, kebab-case
  "type": "movie",                 // movie | series
  "name": "⭐ Popular Movies",      // the row title shown in Nuvio
  "order": 12,                     // ascending — controls row position
  "group": "Movies · Spotlight",  // human grouping only (not sent to Stremio)
  "source": {
    "endpoint": "/discover/movie", // any TMDB v3 path
    "params": { "sort_by": "popularity.desc", "vote_count.gte": 100 }
  },
  "extra": [
    { "name": "genre", "mapTo": { "param": "with_genres", "lookup": "tmdbGenreId" } },
    { "name": "skip" }             // enables pagination
  ]
}
```

- **Reorder** a row: change its `order`.
- **Rename** a row: change its `name` (keep labels plain — the lint step rejects emojis).
- **Add** a row: copy a block, give it a unique `id`, point `source.endpoint`/`params` at the TMDB data you want.
- **Community lists (keyless)**: instead of `source.endpoint`, set `source.list` to any public
  MDBList list JSON URL (`https://mdblist.com/lists/<user>/<slug>/json`). MDBList aggregates IMDb,
  Trakt and Letterboxd lists, and the items already carry IMDb ids, so curated rows like "IMDb Top
  250" play through your stream addons. No API key needed.
- **Default vs preset**: set `"featured": false` to keep a row out of the curated default manifest
  (so it stays under 8KB) while still serving it via its preset. The row's `group` decides which
  preset it belongs to.
- **Region**: set `defaults.region` (or use the `/r/<CC>/…` URL) so `{{region}}` in a row's params
  resolves to your country for watch-provider rows.
- **Dynamic dates**: params support `{{now}}`, `{{now-90d}}`, `{{now+30d}}`, `{{year}}`, `{{year-N}}`,
  `{{monthStart}}`, `{{yearStart}}`.
- **Time-aware rows**: add `activeWhen` (`months`, `weekdays`, `hours`) so a row only appears at
  certain times, and `dynamicName` (tokens `{partOfDay}`, `{year}`) for a title that changes by time.
- **Daily rotation**: set `rotate: true` so the row is date-seeded — stable within a day, fresh daily.
- **On this week**: set `window: "onThisWeek"` to spotlight films from this calendar week in a past year.
- **Genre dropdowns**: add a `genre` extra; options come from [`data/genres.json`](./data/genres.json).
- Validate before you deploy:

```bash
npm run validate:config
```

Invalid edits fail loudly (bad type, duplicate id, missing endpoint, unknown genre…), and CI blocks them.

---

## Develop locally

```bash
cp .env.example .env     # add your TMDB_API_KEY
npm install
npm start                # http://127.0.0.1:7000/manifest.json
npm test                 # unit + smoke tests (no network)
npm run validate:config  # schema + semantic validation
npm run ping:tmdb        # live canary: hits every row once (needs TMDB_API_KEY)
```

---

## Secrets

- Keys live only in your **host env vars** (Vercel) and **GitHub Actions secrets** — never in the repo.
- `.env` is gitignored; `.env.example` documents the variables.
- `npm run lint` includes a secret scan; the nightly workflow's TMDB key is masked and is not exposed
  to pull requests from forks (the ping skips gracefully when the key is absent).

---

## Project layout

```
data/catalogue.config.json   # THE golden config — edit this
data/genres.json             # TMDB genre-id lookup
data/providers.json          # TMDB watch-provider id reference
schema/catalogue.schema.json # JSON Schema the config is validated against
src/manifest.js              # config -> Stremio manifest (featured filter, 8KB-aware)
src/presets.js               # group -> lean preset manifests
src/landing.js               # server-rendered install page
src/lib/templating.js        # {{region}} / {{now-90d}} / {{year}} / {{year-N}} tokens
src/lib/schedule.js          # time-aware activation, daily rotation, on-this-day
src/lib/cache.js             # bounded TTL + LRU cache with metrics
src/lib/circuit-breaker.js   # upstream outage protection
src/handlers/catalog.js      # config row -> TMDB -> meta previews (core)
src/handlers/meta.js         # full detail pages + optional enrichment
src/tmdb/                     # TMDB client (cache, stale-on-error, breaker) + mappers + meta
src/images/fanart.js         # optional clearlogo enrichment
src/sources/anilist.js       # optional anime score/genre enrichment (keyless)
src/sources/mdblist.js       # keyless public-list source (MDBList/Trakt/Letterboxd)
src/configure.js             # interactive /configure page
api/index.js + vercel.json   # Vercel entry (default + presets + /r/<CC> + /configure + /health)
.github/workflows/           # CI + nightly canary
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) to propose rows or changes.

## Credits & terms

This product uses the **TMDB API** but is not endorsed or certified by
[TMDB](https://www.themoviedb.org/). Rating badges by [RPDB](https://ratingposterdb.com); artwork by
[fanart.tv](https://fanart.tv). Licensed under [MIT](./LICENSE).

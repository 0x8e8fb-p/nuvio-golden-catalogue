# Golden Catalogue

[![CI](https://github.com/0x8e8fb-p/nuvio-golden-catalogue/actions/workflows/ci.yml/badge.svg)](https://github.com/0x8e8fb-p/nuvio-golden-catalogue/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Golden Catalogue is a Stremio-protocol catalogue addon built for Nuvio on Android TV. It also works in Stremio. This README covers version 3.0.0.

- Metadata only. The addon lists movies and shows with IMDb (`tt`) ids, and your own stream addons handle playback.
- No adult content. Every TMDB request sets `include_adult=false`, and adult-flagged items are dropped.
- Data comes from TMDB.
- Users need no API key in Nuvio. The only key is the deployer's own free TMDB key, set on the server.

What it adds to Nuvio:

- Home rows: Top 10 rows with rank tiles, trending, streaming, Indian cinema, genre, anime and curated rows, and rows that follow the local clock.
- Golden Collections: 17 collections with about 200 folders, imported into Nuvio TV from one URL.
- Generated artwork: 16:9 title tiles, Top 10 tiles, folder covers and logos, animated focus loops and poster-wall hero backdrops.
- Region editions for any country code, with streaming rows and folders that match what the country offers.
- Indian and worldwide titles blended in general rows and folders.

## Install in Nuvio

You need a deployment first (see [Deploy on Vercel](#deploy-on-vercel)). Below, replace `<domain>` with its production domain and `IN` with your country code.

1. Open the landing page at `https://<domain>/` and pick your country. It shows the links below with Copy buttons. For a country that is not in the list, change the code in the links.
2. Add the addon. In Nuvio, open Settings > Addons > Add Addon and paste `https://<domain>/r/IN/manifest.json`. For the default region, `https://<domain>/manifest.json` also works.
3. Import the collections. In Nuvio TV, open Settings > Content & Discovery > Collections > Import > URL and paste `https://<domain>/r/IN/collections.json`. Use the same country code as the addon, because the pack points at that edition. Collection and folder ids are stable, so importing the URL again later updates the pack in place instead of duplicating it. Optional: on a TV with Android 8 or older, Nuvio cannot animate WebP and shows a still frame, so import `https://<domain>/r/IN/collections.json?focus=gif` instead to get GIF focus loops. Both URLs give the same collections with the same ids, so importing the other URL later switches either way.
4. Move Golden Catalogue to the top of the list in Settings > Addons, so its artwork is used for the home screen hero. A metadata addon above it, for example Cinemeta, can replace the hero background and logo. Nuvio's search suggestions while typing come only from the first addon in this list with a search catalog, so at the top Golden Catalogue supplies them (full search results come from every addon with a search catalog).

In Stremio, install the same manifest URL or use the Stremio link on the landing page. Collections are a Nuvio feature, so Stremio gets the rows and search.

## Region editions

Each country has an edition at `/r/<CC>/manifest.json`, where `<CC>` is any two-letter country code. A full edition carries the featured home rows, search, and the catalogs behind the collection folders.

- US, IN, GB, CA, AU and DE have full streaming-provider tables in [data/providers.json](./data/providers.json). Any other code uses a default table with Netflix, Disney+ and Apple TV.
- `/manifest.json` is the default edition. It uses the `DEFAULT_REGION` env var (US if unset) and keeps the plain addon id `com.nuvio.golden.catalogue`, so it is the same addon as `/r/<DEFAULT_REGION>/manifest.json`. Other regions get ids like `com.nuvio.golden.catalogue.in` and names like "Golden Catalogue IN".
- Rows and folders for services a country lacks are left out. The India edition has no On Disney+ or On HBO Max row and no Hulu folder. The US edition has no On JioHotstar or On aha row.

Time-aware rows follow the region's local clock:

| Region | Time zone |
|---|---|
| US | America/New_York |
| IN | Asia/Kolkata |
| GB | Europe/London |
| CA | America/Toronto |
| AU | Australia/Sydney |
| DE | Europe/Berlin |
| Any other code | UTC |

Nuvio caches installed manifests for up to 6 hours, so hour-based rows appear and disappear at approximate times.

## Home rows

[data/catalogue.config.json](./data/catalogue.config.json) defines 33 rows. 31 are featured and make up the full editions. The other 2, Best of the 90s and On This Week in Film History, have `"featured": false` and appear only in the Curated preset. Each edition then drops the streaming rows its country lacks, so the US and India editions show up to 29 rows.

| Group | Rows |
|---|---|
| Spotlight | Top 10 Movies Today, Top 10 Shows Today, Trending Movies, Trending Shows, New on Streaming, In Theaters |
| For Right Now | Tonight's Pick, Weekend Epics |
| Indian Cinema | Indian Blockbusters, Indian Web Series, South Indian Cinema, Bollywood |
| Streaming | On Netflix, On Prime Video, On JioHotstar, On Disney+, On HBO Max, On aha |
| Genres | Action and Thrillers, Comedy, Crime Dramas, Sci-Fi and Fantasy, Family Night, Horror, Documentaries |
| Anime, World | Anime, Korean Dramas |
| Curated | Critically Acclaimed, Hidden Gems, Binge-Worthy Series, IMDb Top 250 |
| Decades (Curated preset only) | Best of the 90s, On This Week in Film History |

On screen, the two Top 10 rows come first, then Tonight's Pick and Weekend Epics, then the other rows in table order.

- Top 10 Movies Today and Top 10 Shows Today show 10 rank tiles with big outlined numerals.
- Tonight's Pick appears from 17:00 to 23:59 local time and is titled "Good Evening" for that whole window.
- Weekend Epics appears Friday to Sunday and lists films of 140 minutes or longer.
- Hidden Gems, Tonight's Pick and Weekend Epics rotate daily. Each starts at a different point in its list every day. The day is the edition's local day, not the UTC day.
- New on Streaming lists films from the last 90 days on the region's major services. In Theaters uses TMDB's now-playing list for the region.
- IMDb Top 250 comes from a public MDBList list.

## Indian and worldwide blend

General rows and folders interleave a worldwide feed and an Indian feed by weighted round robin.

| Edition | Worldwide to Indian |
|---|---|
| India (IN) | 1 to 1 |
| Every other region | 3 to 1. The Horror row uses 4 to 1 and the Hidden Gems row 2 to 1. |

- Each part of a row's `"mix"` in data/catalogue.config.json sets its weight per region with `"weightBy"`, for example `{ "IN": 1, "_default": 3 }`, or as a fixed `"weight"`. Weights are whole numbers. Each row lists its Indian languages in its own params. Most use Hindi, Telugu, Tamil, Malayalam and Kannada, and show rows match origin country IN. The Top 10 rows blend only in the India edition. Elsewhere they show TMDB's daily trending list.
- Folders get an Indian feed automatically: the same filters, limited to Hindi, Telugu, Tamil, Malayalam, Kannada, Bengali, Marathi, Punjabi and Gujarati, with a lower vote floor. The weights come from `"indiaMix"` in data/providers.json. This applies to genre, keyword, discover and mood folders. A folder in data/collections.json can set its own `"indiaMix": [3, 1]` or turn blending off with `"indiaMix": false`.
- Search in Nuvio keeps TMDB's first 10 results in order, then lists the Indian-language matches among results 11 to 40 ahead of the rest.

## Golden Collections

The pack has 17 collections and about 200 folders per region: 200 in the US, 201 in India, 198 in GB, AU and DE, 197 in CA and 194 for any other country. Get it from `/r/<CC>/collections.json`, or `/collections.json` for the default region. Folders are defined in [data/collections.json](./data/collections.json).

| Collection | Tile shape | Folders | Examples |
|---|---|---|---|
| Spotlight | LANDSCAPE | 5 | Trending Now, Trending in India, New Releases, Coming Soon, Top Rated |
| Streaming | LANDSCAPE | 14, filtered by country | Netflix, Prime Video, JioHotstar, Disney+, HBO Max, Sun NXT |
| Indian Cinema | SQUARE | 11 | Telugu, Hindi, Tamil, Malayalam, Pan-India Blockbusters, Indian Web Series |
| Originals | LANDSCAPE | 11 | Netflix Originals, HBO Originals, JioHotstar Specials, BBC Originals |
| Genres | POSTER | 19 | Action, Comedy, Thriller, Science Fiction, Kids, Reality |
| Indian Studios | LANDSCAPE | 9 | Hombale Films, Mythri Movie Makers, Yash Raj Films, Lyca Productions |
| Franchises | LANDSCAPE | 27 | Harry Potter, Star Wars, James Bond, Mission: Impossible, John Wick |
| Indian Franchises | LANDSCAPE | 14 | Baahubali, K.G.F, Pushpa, Kantara, Drishyam, Golmaal |
| Universes | LANDSCAPE | 7 | Marvel Cinematic Universe, MonsterVerse, Lokesh Cinematic Universe, Cop Universe, YRF Spy Universe, The Conjuring Universe, DC |
| Directors | POSTER | 24 | Christopher Nolan, S. S. Rajamouli, Mani Ratnam, Steven Spielberg, Hayao Miyazaki, Bong Joon Ho |
| Anime | LANDSCAPE | 12 | Popular Anime, Airing This Season, Isekai, Crunchyroll, Studio Ghibli |
| Studios | LANDSCAPE | 10 | Marvel Studios, Pixar, A24, Lucasfilm, Blumhouse |
| Moods | POSTER | 15 | Mind-Bending, Feel-Good, Edge of Your Seat, Heists, Time Travel |
| Curated | LANDSCAPE | 7 | IMDb Top 250, Most Watched This Week, Critically Acclaimed, Highest Grossing |
| World Cinema | SQUARE | 10 | Korean, Japanese, Spanish, French, Turkish |
| Decades | SQUARE | 8 | 2020s, 2010s, 1990s, 1960s, Golden Age |
| By Runtime | LANDSCAPE | 3 | Under 90 Minutes, One Sitting, Epic Length |

- The table follows the India edition's order. Other editions move Indian Cinema, Indian Franchises and Indian Studios further down (`"regionOrder"` in data/collections.json).
- Each folder has Movies and Shows tabs where both exist. Franchise and director folders are movies only, as are several studio, universe and genre folders. Originals folders are shows only.
- Directors folders list only films the person directed.
- Streaming folders follow what the country offers: 8 in the US, 9 in India, 6 in GB, AU and DE, 5 in CA and 3 elsewhere.
- If a user turns on Nuvio's Hide Unreleased Content setting (off by default), the Coming Soon folder can be empty.
- Folders reach the addon through two search-only catalogs, `gc-movie` (named Movies) and `gc-series` (named Shows). Nuvio never shows search-only catalogs on Home or in Discover, so they add no clutter. The same two catalogs serve Nuvio's search.
- Each folder tab is a source `{ provider: "addon", addonId, type, catalogId: "gc-movie,<folder-id>" }`, or `"gc-series,<folder-id>"` for shows, with no genre. Nuvio resolves a source's catalog by the part before the first comma, so the tab uses the declared `gc-movie` or `gc-series` catalog: 40 titles per page, paging with `skip`, and the catalog name, Movies or Shows, as the tab label. The region comes from the edition the addon was installed from.
- Packs imported earlier name the folder in the genre extra instead, for example `genre=IN.netflix`. That form still works.

## Generated artwork

The server renders artwork with sharp and the Bebas Neue font. Complete images carry long cache headers (30 days at the CDN for item art, 1 day plus a week of stale-while-revalidate for folder art), so Vercel's CDN serves repeat requests. An image drawn after an input failed to load (a download or a TMDB lookup) is sent with `Cache-Control: public, max-age=60, s-maxage=300` and is not kept in memory, so it is tried again soon. Catalog pages built after a TMDB failure carry no cache headers.

| Artwork | Size | Content |
|---|---|---|
| Title tile | 960x540 JPEG | Backdrop with the title's logo, or the title set in Bebas Neue when there is no logo. A title without a backdrop gets a poster layout: the poster blurred and darkened as the background, the poster as a rounded card on the right, and the logo or title on the left. This keeps many Indian titles in rows and folders. |
| Top 10 tile | 960x540 JPEG | Poster over a blurred backdrop, with a big outlined rank numeral |
| Folder cover | 640x360 (LANDSCAPE), 405x600 (POSTER), 600x600 (SQUARE) JPEG | Drawn at the shape of the folder's tile, because Nuvio stretches images to the tile. A POSTER tile is 0.675 wide per unit of height. Streaming services, networks and studios show their logo, directors their portrait, and categories their name. Folder tiles hide their text, because the cover already shows the name or logo. |
| Focus loop | 416x234 (LANDSCAPE), 243x360 (POSTER), 300x300 (SQUARE) animated WebP, about 70 to 140 KB | Plays when a folder is focused |
| Hero backdrop | 1920x1080 JPEG | Poster wall built from the folder's titles |
| Folder logo | Transparent PNG, up to 1200x480 | The brand logo, with dark logos turned white and the dark parts of two-tone logos lifted, or the folder name set in Bebas Neue. The pack links it as the folder's `titleLogoUrl`, and Nuvio shows it on the home hero when the folder is focused. |

- Logos: a title tile uses the English logo first, then one in the title's original language, then one without a language. Indian films therefore show their English or original-language logo.
- Focus loops: Nuvio animates WebP on Android 9 and newer. Older TVs show a still frame. A GIF version, about 400 to 550 KB, is served at the same path, with `focus.gif` in place of `focus.webp`. It has one crossfade frame between pictures instead of four, and no dithering.
- GIF edition: `/r/<CC>/collections.json?focus=gif`, or `/collections.json?focus=gif` for the default region, is the same pack with folders that link `focus.gif` instead of `focus.webp`. It is for TVs on Android 8 or older. Importing it replaces the same collections, because the ids do not change, so a user can switch either way by importing the other URL. The landing page shows both links.
- Paths: item art is served from `/art/tile.jpg`, `/art/rank.jpg` and `/art/logo.png`. Folder art is served from `/art/folder/<CC>/<folder-id>/` as `cover.jpg`, `focus.webp`, `focus.gif`, `hero.jpg` and `logo.png`. A folder art URL with unknown query parameters or an invalid shape redirects (301) to the canonical URL.
- Signing: item art URLs carry an HMAC signature keyed with `ART_SECRET`, or with a secret derived from `TMDB_API_KEY`, so the deployment cannot be used as a free image service. A bad signature gets HTTP 403. Folder art URLs are not signed, so imported packs keep working if the secret changes.
- `ART_MODE=posters` turns off generated title tiles, Top 10 tiles and title logos. Rows then use plain TMDB backdrops and posters. Folder art in the pack is still generated.

## Themed presets

Presets are optional, smaller addons with one theme each, for example for a second profile. Install one from `/r/<CC>/c/<preset>/manifest.json`, or `/c/<preset>/manifest.json` for the default region. The landing page lists them with copy links, and [src/presets.js](./src/presets.js) defines them.

| Preset | Name | Row groups | v2 slugs that map to it |
|---|---|---|---|
| `spotlight` | Spotlight | Spotlight, For Right Now | `movies`, `series`, `now`, `discovery`, `seasonal` |
| `indian` | Indian Cinema | Indian Cinema | `regional` |
| `streaming` | Streaming | Streaming | `networks`, `studios` |
| `genres` | Genres | Genres | `docs`, `kids`, `themes`, `runtime` |
| `world` | Anime and World | Anime, World | `anime` |
| `curated` | Curated | Curated, Decades | `franchises`, `lists`, `decades`, `onthisday` |

Presets include rows set to `"featured": false`. They carry rows only, so search and the collection folders still need the full edition. `/configure`, the v2 configure page, now redirects to the landing page.

Each preset installs as its own addon. At `/c/<preset>/` its id is `com.nuvio.golden.catalogue.<preset>`. At `/r/<CC>/c/<preset>/` it is `com.nuvio.golden.catalogue.<preset>.<cc>` for every country, including the default one.

The 17 preset slugs removed after v2 still work, for example `/c/movies/manifest.json`. Each serves the closest current preset (last column above) and keeps the addon id it had in v2, so existing installs keep working. The landing page does not list them.

## Endpoints

| Path | Serves |
|---|---|
| `/` | Landing page: country picker, install links, presets |
| `/manifest.json` | Default edition |
| `/r/<CC>/manifest.json` | Region edition |
| `/r/<CC>/collections.json` | Golden Collections pack for a region |
| `/collections.json` | Golden Collections pack for the default region |
| `/r/<CC>/collections.json?focus=gif` | GIF edition of a region's pack, for TVs on Android 8 or older |
| `/collections.json?focus=gif` | GIF edition of the default region's pack |
| `/r/<CC>/c/<preset>/manifest.json` | Preset in a region |
| `/c/<preset>/manifest.json` | Preset in the default region |
| `/presets.json` | Preset list with slug, name and row count |
| `/health` | Status, version, region, row, preset and folder counts, the public origin, and cache and circuit-breaker stats. `tmdb` reports `ok` from one test request to TMDB, so a wrong key shows up here; it never shows the key. `renderer` reports `ok` and `ms` from one tiny test render per process, which shows whether image rendering works on the host. |
| `/art/...` | Generated artwork |
| `/configure` | Redirect to the landing page |

An invalid country code returns HTTP 400 and an unknown preset returns 404.

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/0x8e8fb-p/nuvio-golden-catalogue&env=TMDB_API_KEY&envDescription=Your%20free%20TMDB%20v3%20API%20key)

1. Get a free TMDB key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api). Either credential on that page works: the "API Key" (32 hex characters) or the longer "API Read Access Token".
2. Import the GitHub repo into Vercel (Add New > Project), or use the Deploy button above. Leave the framework preset as Other. The first deploy works before the key is set.
3. In Project > Settings > Environment Variables, set `TMDB_API_KEY` to that key. Optionally set `DEFAULT_REGION=IN` to make India the default edition.
4. Redeploy from the Deployments tab. Environment variable changes only apply to new deployments.
5. Find the production domain under Project > Settings > Domains, for example `<project>.vercel.app`, and use it in every install link. Deployment-specific URLs, the ones with a hash in them, sit behind Vercel Authentication, and a TV cannot open them.
6. Open `https://<domain>/health` and check that `tmdb.ok` is `true` (TMDB accepted the key) and `renderer.ok` is `true`. When either is `false`, its `error` names the problem.

Without a key the addon still installs, but every row is empty and the landing page shows a warning. Use Node 22 or newer on Vercel (Settings > Build and Deployment > Node.js Version). vercel.json rewrites every path to the Express app in api/index.js, and its `functions` block bundles the assets, data and schema folders with that function (`includeFiles`) and allows it up to 30 seconds per request (`maxDuration`). Any other Node host can run `npm start` with the same environment variables.

## Environment variables

Set these in Vercel under Project > Settings > Environment Variables, or in `.env` for local runs (see [.env.example](./.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `TMDB_API_KEY` | none, required | TMDB "API Key" (32 hex characters) or "API Read Access Token". Without it every row is empty. |
| `DEFAULT_REGION` | `US` | Country used by `/manifest.json`, `/collections.json` and `/c/<preset>/manifest.json` |
| `PUBLIC_BASE_URL` | the request's host | Public origin written into artwork and pack URLs, for example `https://tv.example.org`. Set it for a custom domain or a proxy. |
| `TRUST_PROXY` | unset | `1` trusts `X-Forwarded-Host` and `X-Forwarded-Proto`. Set it when a proxy in front of a self-hosted server sets these headers. On Vercel they are trusted automatically. Without it the `Host` header is used. |
| `ART_SECRET` | derived from `TMDB_API_KEY` | Secret for signing item art URLs. Changing it invalidates item art URLs issued before the change. A Vercel deployment with neither `ART_SECRET` nor `TMDB_API_KEY` signs with a random key per instance. |
| `ART_MODE` | unset | `posters` turns off generated tiles, Top 10 tiles and title logos. Folder art is unaffected. |
| `TMDB_LANGUAGE` | `en-US` | Language of TMDB metadata |
| `RPDB_API_KEY` | unset | Rating-badge posters from RPDB. Applies to portrait posters only, such as search results. |
| `FANART_API_KEY` | unset | fanart.tv clearlogos and backgrounds on detail pages |
| `ENABLE_ANILIST` | unset | `1` adds AniList genres and scores to anime detail pages |
| `PORT` | `7000` | Port of the local server |
| `TMDB_API_BASE` | `https://api.themoviedb.org/3` | TMDB API host, for a mirror or a mock. If api.themoviedb.org is blocked on your network, as on some Indian ISPs, `https://api.tmdb.org/3` works for local runs. |
| `TMDB_IMAGE_BASE` | `https://image.tmdb.org/t/p` | Host the art renderer downloads source images from, for a mirror or a mock |
| `PING_REGIONS` | `IN,US` | Countries checked by `npm run ping:tmdb` |

## Local development

Use Node 20.9 or newer (22 recommended).

```bash
npm install
TMDB_API_KEY=your_key npm start
```

To keep settings in a file instead (`npm start` does not read `.env`):

```bash
cp .env.example .env    # then set TMDB_API_KEY in .env
node --env-file=.env src/index.js
```

Open `http://127.0.0.1:7000/` for the landing page. The default manifest is at `http://127.0.0.1:7000/manifest.json`. To try it on a TV on the same network, install `http://<computer-ip>:7000/r/IN/manifest.json` in Nuvio. Artwork URLs use the host of each request, so they point at the same address.

| Command | What it does |
|---|---|
| `npm start` | Starts the local server (`node src/index.js`). `npm run dev` does the same. |
| `npm test` | Runs the unit and smoke tests with `node --test`. No TMDB key is needed. |
| `npm run lint` | Syntax-checks every JS file, scans for committed secrets, rejects emojis in data, docs and code, and checks README links |
| `npm run validate:config` | Validates data/catalogue.config.json against the schema, checks the 8KB manifest limit for every region edition, and checks data/collections.json: id format, unique ids, tile shapes, a feed for every folder, and a pack that builds for every region |
| `npm run ping:tmdb` | Live canary for each country in `PING_REGIONS`: every row feed, every folder tab, and every logo and portrait path. Skips when `TMDB_API_KEY` is unset. |

CI ([.github/workflows/ci.yml](./.github/workflows/ci.yml)) runs lint, validate:config and the tests with Node 24 on every push and pull request to master and main. A nightly workflow ([.github/workflows/nightly.yml](./.github/workflows/nightly.yml)) runs the live canary at 06:00 UTC with the `TMDB_API_KEY` repository secret.

## Customising

Behaviour is set in three data files. Run `npm run validate:config` after every edit. [CONTRIBUTING.md](./CONTRIBUTING.md) has worked examples.

### Rows: data/catalogue.config.json

Each row is validated against [schema/catalogue.schema.json](./schema/catalogue.schema.json).

| Field | Meaning |
|---|---|
| `id` | Unique kebab-case id. It is also the catalog id in the manifest. |
| `type` | `movie` or `series` |
| `name` | Row title |
| `order` | Position on the home screen, ascending |
| `group` | The preset the row belongs to. Not sent to Nuvio. |
| `source` | Exactly one of: `endpoint` with `params` (a TMDB v3 path), `mix` (a list of feeds, each with `endpoint`, `params`, and a fixed `weight` or a per-region `weightBy`, in whole numbers), or `list` (a public MDBList JSON URL) |
| `art` | `tile` (default), `rank` or `poster` |
| `limit` | Maximum number of items, for example 10 |
| `pageSize` | Items per page, sent to Nuvio as the catalog page size |
| `activeWhen` | `hours` as `[start, end]` local hours, inclusive (`[17, 23]` is 17:00 to 23:59), `weekdays` (0 is Sunday), `months` (1 to 12) |
| `dynamicName` | Title template with `{partOfDay}` and `{year}`, for example `Good {partOfDay}` |
| `rotate` | `true` moves the row's starting point every day |
| `featured` | `false` keeps the row out of the full editions, so it appears only in its preset |
| `window` | `onThisWeek` lists films released this calendar week in a past year |
| `extra` | `[{ "name": "skip" }]` turns on paging |

Template tokens in `params` values:

| Token | Becomes |
|---|---|
| `{{region}}` | The edition's country code |
| `{{providers}}` | TMDB provider ids of the region's major services |
| `{{provider:netflix}}` | TMDB provider ids of one service in the region (any brand key in data/providers.json) |
| `{{now}}` | Today's date, YYYY-MM-DD (UTC) |
| `{{now-90d}}`, `{{now+30d}}` | A date that many days back or ahead |
| `{{year}}` | The current year |
| `{{year-10}}` | That many years back. Text may follow, as in `{{year-4}}-01-01`. |
| `{{monthStart}}`, `{{yearStart}}` | The first day of the current month or year |

Apart from `{{year-N}}`, a token must be the whole value. A row whose provider token has no ids in a region is left out of that region's manifest.

### Collections: data/collections.json

A collection has an `id`, a `title`, a `tileShape` (`POSTER`, `LANDSCAPE` or `SQUARE`) and `folders`. `"regionOrder"` sets the collection order per region. Each folder has an `id`, a `title` and one source field:

| Source field | Feed |
|---|---|
| `provider` | A streaming service key from data/providers.json, filtered by region |
| `network` | A TMDB network id (shows only) |
| `company` | TMDB company ids. Separate several with a pipe to match any of them. |
| `collection` | A TMDB collection id (movies only) |
| `parts` | Several TMDB collections plus single films (movies only) |
| `person` | A TMDB person id. Lists the films the person directed. |
| `language` | An original-language code, for example `te` |
| `list` | A public MDBList JSON URL, or one URL per type |
| `genre` | A TMDB genre id per type |
| `keyword` | TMDB keyword ids. Separate several with a pipe to match any of them. |
| `discover` | Explicit TMDB discover params per type |
| `trending` | TMDB's weekly trending titles |

Optional folder fields: `types` (`["movie"]` or `["series"]`), `params` (extra TMDB params, ignored by `discover` and `trending` folders), `regions` (show only in these countries), `indiaMix` (`[worldwide, indian]` weights, or `false`), `tileShape`, `logo` (a TMDB logo path), `wordmark` (cover text in place of the title) and `portrait` (a TMDB photo path for director folders).

### Regions: data/providers.json

- `regions`: TMDB watch-provider ids per country for each brand key. `_default` is the table for countries not listed.
- `brands`: name, TMDB network id and logo path for each streaming brand.
- `regionNames`: names shown in the landing page's country picker.
- `timeZones`: the clock for each region's time-aware rows.
- `major`: the brands behind `{{providers}}`.
- `indiaMix`: `[worldwide, indian]` folder weights per region.

## Project layout

```text
api/index.js           Express app and every route; the Vercel entry
src/index.js           Local server
src/addon.js           Builds the addon for an edition or preset
src/manifest.js        Config to manifest: featured rows, region filter, search-only catalogs
src/presets.js         Preset definitions
src/landing.js         Landing page
src/handlers/          catalog.js (rows, search, folders), meta.js (detail pages)
src/collections/       engine.js (folders per region), pack.js (Nuvio pack), folder-feed.js (folder pages)
src/art/               render, routes, sign, urls, fetch-image, logos, folder-art, sharp
src/lib/               mix, region, schedule, templating, cache, circuit-breaker, request-context, config-loader
src/tmdb/              TMDB client, mappers, detail pages
src/sources/           mdblist.js, anilist.js
src/images/fanart.js   fanart.tv logos for detail pages
data/                  catalogue.config.json, collections.json, providers.json, genres.json
schema/                catalogue.schema.json
assets/fonts/          Bebas Neue and its licence
scripts/               lint.js, validate-config.js, ping-tmdb.js
tests/                 node --test suites
vercel.json            Sends every path to api/index.js
.github/workflows/     ci.yml, nightly.yml
```

## Credits and licences

- This product uses the TMDB API but is not endorsed or certified by TMDB. Data and images come from [TMDB](https://www.themoviedb.org/).
- Bebas Neue font by Dharma Type, under the SIL Open Font License 1.1 ([assets/fonts/OFL-BebasNeue.txt](./assets/fonts/OFL-BebasNeue.txt)).
- Curated rows and folders use public [MDBList](https://mdblist.com) lists.
- Optional services: rating posters from [RPDB](https://ratingposterdb.com), logos from [fanart.tv](https://fanart.tv) and anime data from [AniList](https://anilist.co).
- Project licence: MIT ([LICENSE](./LICENSE)).

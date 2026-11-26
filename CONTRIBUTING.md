# Contributing

Most changes are data edits: home rows in [data/catalogue.config.json](./data/catalogue.config.json), collection folders in [data/collections.json](./data/collections.json), and streaming-provider ids in [data/providers.json](./data/providers.json). The [README](./README.md#customising) documents every field.

## Setup

Use Node 20.9 or newer (22 recommended).

```bash
npm install
```

## Before you open a pull request

Run these three checks. CI runs the same ones with Node 24 on every push and pull request to master and main.

```bash
npm run validate:config
npm run lint
npm test
```

`npm run lint` must print `Lint OK.` If you have a TMDB key, also run the live canary. It checks IN and US unless you set `PING_REGIONS`:

```bash
TMDB_API_KEY=your_key npm run ping:tmdb
TMDB_API_KEY=your_key PING_REGIONS=GB,DE npm run ping:tmdb
```

## Add a home row

Add an object to `"catalogues"` in data/catalogue.config.json. This example blends worldwide and Indian romance films:

```json
{
  "id": "romance",
  "type": "movie",
  "name": "Romance",
  "order": 47,
  "group": "Genres",
  "source": {
    "mix": [
      { "endpoint": "/discover/movie", "params": { "with_genres": "10749", "sort_by": "popularity.desc", "vote_count.gte": 300 }, "weightBy": { "IN": 1, "_default": 3 } },
      { "endpoint": "/discover/movie", "params": { "with_genres": "10749", "with_original_language": "hi|te|ta|ml|kn", "sort_by": "popularity.desc", "vote_count.gte": 20 }, "weight": 1 }
    ]
  },
  "extra": [{ "name": "skip" }]
}
```

- `id`: unique and kebab-case. It becomes the catalog id in the manifest, so do not rename existing rows.
- `order`: rows are grouped by tens. Spotlight and For Right Now use 1 to 13, Indian Cinema the 20s, Streaming the 30s, Genres the 40s, Anime and World the 50s, Curated the 60s and Decades the 70s.
- `group`: decides which preset includes the row. [src/presets.js](./src/presets.js) maps groups to presets.
- `source`: use `mix` with `weightBy` to blend in an Indian feed, `endpoint` and `params` for a single TMDB feed, or `list` for a public MDBList list. Mix weights, both `weight` and the values in `weightBy`, are whole numbers.
- Streaming rows: use `{{provider:<brand>}}` and `{{region}}` in the params. Regions without that brand leave the row out.
- `"featured": false` keeps a row out of the full editions, so it appears only in its preset.

Then run `npm run validate:config`. It rejects schema errors, duplicate ids and any region edition whose manifest reaches 8KB. With a key, `npm run ping:tmdb` confirms the row returns titles.

## Add a collection folder

Add an object to the `"folders"` array of a collection in data/collections.json. Three existing folders:

```json
[
  { "id": "harry-potter", "title": "Harry Potter", "collection": 1241 },
  { "id": "christopher-nolan", "title": "Christopher Nolan", "person": 525, "portrait": "/xuAIuYSmsUzKlUMBFGVZaWsY3DZ.jpg" },
  { "id": "a24", "title": "A24", "company": "41077" }
]
```

- Give the folder exactly one source field. The README lists them under Customising.
- `id`: lowercase a-z, 0-9 and hyphens, at most 64 characters, unique across the whole file.
- Verify every TMDB id before you add it (see [Verify TMDB ids](#verify-tmdb-ids)).
- Optional fields: `types`, `params`, `regions`, `indiaMix`, `tileShape`, `logo`, `wordmark` and `portrait`.

Then run `npm run validate:config`. It fails when an id has the wrong format or repeats, a tile shape is unknown, or a folder has no feed in any region. With a key, `npm run ping:tmdb` checks that every tab returns titles and every logo and portrait path exists.

### Nest folders in a group

A group is a tile that opens into one row per member folder, which keeps a collection short. Put the members in the hidden `library` collection (or any collection) and list their ids in the group's `"group"` array:

```json
{ "id": "indian-universes", "title": "Indian Universes", "group": ["baahubali", "kgf", "pushpa", "kantara"] }
```

- Members are ordinary folders with their own source field. A member in the `library` collection (`"hidden": true`) has no tile of its own, but keeps its art and rows.
- The group's cover, focus loop and hero mix pictures from its first six members.
- A group has no source field of its own. Keep a group to about 12 members, because each member is a row in the folder.

### Rows inside a plain folder

A plain folder opens into a few rows cut from its feed, chosen by its source field in `PRESETS` in [src/collections/facets.js](./src/collections/facets.js), for example `provider` folders get Trending Movies, Trending Shows, Original Series, New and Top Rated rows. A folder can pick its own with `"rows"`, for example `"rows": ["trend:movie", "top:movie", "classic:movie"]`. Row kinds are `base`, `trend`, `new`, `top`, `gems`, `hits`, `classic`, `soon` and `saga` for movies, and `base`, `trend`, `new`, `top`, `air`, `orig` and `classic` for shows. Each kind is one catalog in the manifest, so adding a kind costs manifest bytes.

To add a collection, add an object with `id`, `title`, `tileShape` and `folders` to `"collections"`, and add its id to both lists in `"regionOrder"`. A collection missing from `"regionOrder"` sorts last. Collection ids follow the folder id rules.

## Add or update a region

Edit data/providers.json:

1. Under `"regions"`, add the two-letter country code and map each brand key to its TMDB watch-provider ids in that country. Pipe-separated ids match any of them, as in `"paramount": "2303|2616"`.
2. Add the country name to `"regionNames"` (the landing page's country picker uses it) and its IANA time zone to `"timeZones"`. Without a time zone, time-aware rows use UTC.
3. Optionally add the country to `"major"` (the brands behind `{{providers}}`) and to `"indiaMix"`. Without an entry the region uses `_default`.
4. A new streaming service also needs a `"brands"` entry with `name`, `network` (its TMDB network id) and `logo` (a transparent TMDB logo path).

List a country's provider ids from the TMDB API (use `/watch/providers/tv` for shows):

```bash
curl -s "https://api.themoviedb.org/3/watch/providers/movie?watch_region=GB&api_key=$TMDB_API_KEY"
```

Each result has a `provider_id` and a `provider_name`. Then run `npm run validate:config`, which checks every listed region, and `PING_REGIONS=GB npm run ping:tmdb` with your key.

## Verify TMDB ids

A wrong id gives an empty folder or the wrong titles, so check each one before adding it. Open its TMDB page and confirm the name. The id is the number in the URL.

| Field | Example page |
|---|---|
| `collection` | `https://www.themoviedb.org/collection/1241` |
| `person` | `https://www.themoviedb.org/person/525` |
| `company` | `https://www.themoviedb.org/company/41077` |
| `network` | `https://www.themoviedb.org/network/213` |
| `keyword` | `https://www.themoviedb.org/keyword/4379` |

Genre ids are listed in [data/genres.json](./data/genres.json). After adding ids, run `npm run ping:tmdb` with a key.

## Rules

- No emojis or decorative symbols in data files, README.md, CONTRIBUTING.md, or code in src, scripts, tests and api. `npm run lint` rejects them. Write menu paths with ">", as in Settings > Addons > Add Addon.
- Keep the manifest under 8KB. `npm run validate:config` checks every region edition with all time-aware rows switched on. The editions are about 4.3KB today, with 11 home rows and 16 folder catalogs.
- Collection and folder ids use lowercase a-z, 0-9 and hyphens. Never rename or reuse an existing id. Each folder row requests a catalog such as `gc-movie-trend,<folder>` or `gc-series,<folder>`, and art lives under `/art/folder/<CC>/<folder>/`, so a renamed folder id breaks packs that users have already imported. Collection and folder ids also appear in pack ids, as `golden-<collection>` and `golden-<collection>-<folder>`.
- Verify every TMDB id before adding it.
- Keep the addon metadata only: no stream scrapers and no debrid or piracy resolvers. Keep IMDb (`tt`) ids, and do not add adult genres or keywords.
- Never commit secrets. `.env` is gitignored. Document a new variable in .env.example and in the README's environment variable table.
- Add a test in tests/ for any engine change.
- Every relative link in README.md must point to a file that exists. `npm run lint` checks this.
- Keep data files formatted: run `npm run format:data` after editing data/*.json. CI runs `node scripts/format-data.js --check`.
- Folder art follows the design rules at the top of [src/art/render.js](./src/art/render.js): Bebas Neue only, black-to-transparent shading only, and no text in hero stills or videos (Nuvio draws the folder logo on top). Every WebP focus frame lasts 100 ms. When the art changes, bump `ART_VERSION` in src/art/sign.js so CDNs and Nuvio fetch the new files.

## Nightly canary

[.github/workflows/nightly.yml](./.github/workflows/nightly.yml) runs every day at 06:00 UTC, and you can also start it from the Actions tab. It runs `npm run validate:config`, then `npm run ping:tmdb` for IN and US with the `TMDB_API_KEY` repository secret. It fails when a row feed or folder tab comes back empty, or when a logo or portrait path is gone from TMDB. That catches TMDB auth problems, renamed endpoints and stale provider, network, keyword or collection ids before users see empty rows. Last, `npm run prewarm` renders the art and hero videos of the first two collections for IN and US on the live deployment (set the `ADDON_URL` repository variable for a fork), so the first person to open Nuvio each day gets them from the CDN. That step never fails the job.

When it fails, the job log lists each failed check. Fix the ids in data/ and confirm with `npm run ping:tmdb` locally.

To add the secret, open the repository's Settings > Secrets and variables > Actions > New repository secret and name it `TMDB_API_KEY`. Without the secret, for example on a fork, the ping skips and exits 0. In public repositories GitHub turns off scheduled workflows after 60 days without activity; turn it back on from the Actions tab.

## Licence

Contributions are released under the project's [MIT licence](./LICENSE).

# Contributing

Thanks for helping make Golden Catalogue better. This project is deliberately small: the interesting
surface is the **golden config**, not the engine.

## Adding or changing a catalogue row

1. Edit [`data/catalogue.config.json`](./data/catalogue.config.json).
2. Give new rows a unique kebab-case `id` and a sensible `order` (group related rows by their tens
   place — Movies 10s, Series 20s, Anime 30s, and so on).
3. Point `source.endpoint` + `source.params` at a real TMDB v3 endpoint. Keep `include_adult` handling
   intact — the client always forces `include_adult=false`; do not add adult genres/keywords.
4. Run the checks:
   ```bash
   npm run validate:config   # schema + semantics (no network)
   npm run ping:tmdb         # live: confirms your row returns results (needs TMDB_API_KEY)
   npm test
   npm run lint
   ```
5. Open a PR. CI runs lint + config validation + tests on every PR.

## Engine changes

- Keep the addon **metadata-only**. No stream scrapers, no debrid/piracy resolvers.
- Preserve `tt` (IMDB) ids so Cinemeta and the user's stream addons keep working.
- Add a unit test for any new mapping/handler behaviour (`tests/`), test-first where practical.

## Ground rules

- Never commit secrets. `.env` is gitignored; use `.env.example` for documentation.
- Don't claim motion/animation the protocol can't deliver (see the README note).
- Be kind in reviews. One topic per PR.

Released under the repo's [MIT](./LICENSE) licence.

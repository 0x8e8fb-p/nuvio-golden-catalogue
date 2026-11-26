# Golden Catalogue v5

v5 adds five layers on top of v4. The home screen now opens into full pages of folders and sub-folders. No title repeats down a folder page, and no image repeats anywhere on the home screen. Every tile has its own motion style instead of the same slow pan, and the pack and art version themselves so Nuvio picks up changes.

| Level | What it does | Where |
|---|---|---|
| 1. Full tree | Folders inside folders: 482 sub-folders behind 133 tiles in India, 1,330 rows in all. Franchise and director tiles get six rows each. | data/lenses.json, data/collections.json `subs`, src/collections/engine.js, facets.js, folder-feed.js |
| 2. No title twice | A row leaves out the titles the rows above it already show on the same folder page. | src/handlers/catalog.js |
| 3. No image twice | One art plan for the whole pack: every focus loop, cover, hero still, hero video and collection backdrop uses its own images. | src/art/plan.js, scripts/art-plan.js, data/art-plan/<CC>.json |
| 4. Signature motion | 21 motion families replace the Ken Burns loop and the poster-wall video. Each tile gets the one that suits it. | src/art/motion.js |
| 5. Ship | Versioned art URLs, new routes, tests, docs and a pushed Nuvio profile. | src/art/urls.js, routes.js, tests/v5.test.js |

## Level 1: folders inside folders

Nuvio has no nested folders: a folder opens into rows, and each row is a catalog. v5 makes those rows a second level of folders. Every folder page is now a full set of rows (up to 14) built from:

- the folder's own preset rows, for example Netflix: Trending Movies, Trending Shows, Original Series, New Movies, New Shows, Top Rated Movies and Top Rated Shows;
- its **sub-folders**: lenses that narrow the folder's own feed. Netflix gets Thrillers, Crime, Sci-Fi, K-Drama, Anime, Documentaries and others. Horror gets Supernatural, Slashers, Found Footage, Folk Horror, Zombies and Horror-Comedy. Telugu gets Action, Family Dramas, Romance and more.

How lenses work:

- Lenses live in [data/lenses.json](../data/lenses.json), together with a default set for each folder kind (provider, network, company, language, genre, keyword, mood).
- A folder can list its own lenses in `subs`, in any of these forms: `"thriller"`, `"thriller:movie"`, `"thriller=Edge-of-Seat Thrillers"`, or an inline `{id, title, movie, series}`.
- A genre lens is ANDed with the folder's own genres, a language lens replaces the folder's language, and a date lens replaces its date window.
- A sub-folder is a hidden folder keyed `<parent>--<sub>` with its own catalog id, for example `gc-movie,netflix--thriller-movie`.
- The row is named `Movies · Thrillers`, because Nuvio appends a source's `genre` to the catalog name.
- Old packs keep working, because sub-folders are only reached through the new pack.

List-backed folders (franchises, universes and directors) cannot be narrowed by discover filters, so they get related-film rows instead. Each of these tiles now has six rows: In Release Order, Top Rated, More Like This (TMDB recommendations), Similar Films, and two new rows.

- **Leading Faces, Elsewhere**: other films of the actors the list keeps casting. For a franchise these are its leads; for a director, their regulars. An actor counts when billed in the top four of the list's six best-known films, and actors who appear more than once win over one-offs.
- **From the Same Era**: the list's own genres (one, or two when the second is common enough), from the years its best-known films came out, best known first.

Related rows interleave results from the list's best-known films. They never repeat the list's own films, and leave out unreleased and adult titles. They are cached only when every lookup succeeded.

## Level 2: no title twice down a folder page

In v4 a popular film could appear in Trending Movies, New Movies, Top Rated Movies and Blockbusters on the same page. In v5, each row walks the same-type rows above it in page order and leaves out their first 30 titles (`DEDUPE_HEAD`), within its own first 120 positions (`DEDUPE_DEPTH`).

- It uses what those rows actually display, which is their head after their own dedupe, so the chain stays consistent.
- Paging stays stable. Below position 120 the row reads its raw stream again.
- Rows of the same list are exempt, and MDBList rows are skipped.

Against a mock TMDB, repeats in the first 20 titles of each row fell from 47 to 1 (Netflix), 112 to 2 (Horror) and 44 to 0 (Trending Now).

## Level 3: no image twice

v4 sampled each folder's art on its own, so popular titles showed up on several tiles, and a collection backdrop reused its first tile's cover. v5 allocates all art at once.

- `scripts/art-plan.js` reads every visible tile's candidates from the deployment (`/art/candidates/<CC>/<folder>.json`: up to 80 titles with their backdrop and poster paths, plus extra textless backdrops for tiles with fewer than 24 titles).
- `allocate()` then serves the **scarcest tile first**. A director with a dozen films claims them before Drama, which has thousands to choose from.
- Each tile gets 4 focus-loop backdrops (the cover is the loop's first picture) and 3 hero backdrops. Each collection gets one leftover backdrop of its own.
- No image path is used twice, and a title belongs to one tile whenever the folders allow it. A tile that runs short falls back to other images of its own titles, never to one another tile shows.
- The plan is written to `data/art-plan/<CC>.json` and committed. Folder art URLs carry `v=5.<plan hash>`, so a new plan means new URLs, and Nuvio and the CDN fetch fresh art.
- A tile missing from the plan (a new folder) samples its art live, and steers clear of every planned image.
- Collection backdrops have their own route, `/art/collection/<CC>/<id>/backdrop.jpg`.

## Level 4: signature motion

v4 played the same slow Ken Burns pan on every tile and the same drifting poster wall behind every hero. v5 has 21 motion families. Each has its own transition, accent, decor and colour grade:

| Family | Look | Examples (India) |
|---|---|---|
| beam | a light beam sweeps across, the next picture is revealed behind it | Trending Now, Best of the Best, Prime Video, Stand-Up |
| signal | RGB-split glitch hand-over with scanlines | Netflix, New Releases, Cyberpunk, The Matrix |
| reel | film-strip pull-down with sprocket holes and gate weave | Trending in India, Telugu, History, Jurassic Park |
| flicker | horror flicker and lightning cut | Horror, Zombies, Slashers, MonsterVerse |
| holo | holographic scan wipe | Science Fiction, Star Wars, The Terminator |
| impact | white flash cut with punchy contrast | Action, Superheroes, Marvel Cinematic Universe, Hindi |
| halftone | dot-screen dissolve | Comedy, Family, Mission: Impossible |
| bokeh | soft-focus lights drifting | Romance, Feel-Good, Toy Story, Kannada |
| blinds | venetian-blind shadows that open | Thriller, Crime, Edge of Your Seat, True Crime |
| rack | rack focus: blur out, blur in | Drama, Documentary, True Stories, Indian Directors |
| sepia | aged print with dust and burn-in | Western, Post-Apocalyptic, The Lord of the Rings, Tamil |
| iris | iris-in from black | Coming Soon, Fantasy, James Bond, Stanley Kubrick |
| eq | equaliser bars build the next picture | Music, Most Watched This Week, Dune, Punjabi |
| mosaic | the next picture arrives tile by tile | Animation, Reality, By Runtime, Indian Web Series |
| warp | ripple warp | Mind-Bending, Harry Potter, Christopher Nolan |
| vhs | tape tracking error and roll | Decades, Time Travel, Back to the Future |
| ghost | double-exposure ghosting | Mystery, Haunted, The Conjuring Universe |
| carousel | push slide like a reel changer | DC, Shrek, ZEE5, Legendary |
| flap | split-flap board flip | IMDb Top 250, Heists, JioHotstar, Marathi |
| ink | ink-wash bleed | Martial Arts, Spider-Man, Hayao Miyazaki, Malayalam |
| slices | diagonal slice reveal | Top Rated, John Wick, Bengali, Anime |

How a tile gets its family:

- A few titles have a signature match: James Bond opens with the gun-barrel iris, The Conjuring with a ghost double exposure, Star Wars with a hologram, The Matrix with a signal glitch.
- Genres and moods take the family that suits them.
- Busy collections (Streaming, Indian Cinema, Franchises, Studios, World) rotate through a palette.
- No tile ever has the same motion as its neighbour in the row.

All 21 families appear on the India home screen. A tile's seed comes from its id, so accents and paths differ even between tiles of the same family.

- **Focus loop** (WebP): 4 pictures × 12 frames at a uniform 100 ms (48 frames), with the signature transition in the last 5 frames of each picture. Uniform frames play correctly on Nuvio iOS too.
- **Focus loop** (GIF): each picture held for 1.5 s, then the transition in two frames.
- **Cover**: frame 0 of the focus loop at the tile's shape, so focusing a tile never jumps.
- **Hero still**: 1920×1080, frame 0 of the hero video.
- **Hero video**: 1280×720 H.264, 6 s at 30 fps, three pictures with the family's transition. The last hand-over lands back on frame 0, so the loop is seamless.

Rendering times in the sandbox:

- Focus WebP: about 0.8 to 1.5 s.
- GIF: about 0.4 s.
- Hero still: about 0.5 s.
- Hero video: about 1.1 to 2.8 s, render plus encode. This is well inside Nuvio TV's 8-second player timeout.

## Level 5: versioning and shipping

- Folder art `v` is `5` without a plan, and `5.<hash>` with one.
- The pack links collection backdrops through the new route.
- `/art/candidates` is public and holds no secrets: it returns TMDB ids and image paths only.
- 16 new tests in `tests/v5.test.js` cover sub-folders, related rows (recommendations, leading faces, same era), row dedupe, plan uniqueness and scarcity order, motion output (frame counts, delays, sizes, every family) and the new routes.

To regenerate the art plan after changing folders:

```bash
node scripts/art-plan.js IN --origin https://<your-deployment>
git add data/art-plan/IN.json && git commit -m "Refresh IN art plan"
```

# Golden Catalogue v4: what changed and why

v4 is a full rework of the collections pack and its artwork, built in 20 rounds of research and work. The two goals were a pack that looks better than anything else for Nuvio, with motion everywhere it helps, and fewer top-level sections, with related folders nested inside tiles instead of side by side.

## At a glance

| | v3 | v4 |
|---|---|---|
| Top-level collections | 17 | 8 |
| Folder tiles (India) | 201 | 133, with 9 group tiles that open into rows of sub-folders |
| Inside a folder | 2 tabs (Movies, Shows) in a tabbed grid | Up to 8 rows (Trending, Original Series, New, Top Rated and more) in Nuvio's Follow Layout |
| Focus loop | WebP, 4 pictures held 1.6 s each with 70 ms crossfades | WebP, continuous Ken Burns camera, 42 frames at exactly 100 ms |
| Hero | Still poster wall | Still poster wall plus a 6 s H.264 hero video of the wall in motion |
| Collection backdrop | none | Hero still of the first folder |
| Still pack | none | `?motion=off` |
| Manifest | 3.3 KB, 30 catalogs | 4.3 KB, 11 home rows plus 16 search-only folder catalogs |

## The 20 rounds

### Research

1. **Baseline and the user's setup.** Measured the live v3 deployment (17 collections, 200 folders, 33 rows) and read the user's current Nuvio profile, the community "Perfect Setup" pack: 8 collections and 83 folders, all in Follow Layout, with emoji titles, focus loops and hero stills but no hero videos or collection backdrops. The user runs Nuvio on an iPhone and a TV and reported that the home catalogue "looks glitched".
2. **Nuvio TV data model.** Read the NuvioTV source. Collections gained `backdropImageUrl`, and folders gained `heroVideoUrl`, which the Modern home plays behind the hero when a folder tile is focused. It plays once, has no sound setting of its own, and falls back to the still on error.
3. **How Nuvio names and loads folder rows.** In `FolderDetailViewModel`, a source's catalog is found by its exact id, then by the part before the first comma, and the row title is the catalog name plus " · genre" when the source has a genre. Follow Layout shows each source as a home-style row; `showAllTab` adds an extra All tab, so v4 turns it off.
4. **Keeping helper catalogs invisible.** A catalog whose `search` extra is required is hidden from Home and Discover, and one that also requires another extra is left out of search. So v4's facet catalogs (`gc-movie-trend` and the like) require both `search` and `genre`: Nuvio can load them as folder rows, but users never see them as loose rows.
5. **Why it looked glitched on iPhone.** Nuvio Mobile on iOS decodes card images with ImageIO and reads frame durations only from GIF headers, so every WebP frame plays at 100 ms. v3's 1.6 s holds therefore flashed past as a 2 s flicker slideshow. The fix is a loop whose frames really are 100 ms each.
6. **Market survey.** Surveyed the main packs (Perfect Setup, Kaptain, Horizon, Izlemeli, Ultra MAX, Watchly, Movie Collections Catalog, Xperience). None ships a working hero video; Kaptain's 175 `heroVideoUrl` fields are empty strings. Users mainly complain about clutter, animated images that freeze iOS, slow MP4 heroes (3 to 4 s to start) and heroes stuck on the last frame (NuvioTV issue 4480).
7. **Delivery constraints.** Vercel functions get about 1 vCPU, a 4.5 MB response limit, CDN caching up to 10 MB with `s-maxage`, and no reliable CDN caching of 206 responses. `ffmpeg-static` 5.3 ships FFmpeg 7.0.2 with libx264, and Vercel bundles it only when `includeFiles` lists it. Media3 plays a progressive H.264 MP4 directly. Nuvio TV's player uses `DefaultHttpDataSource`, with 8 s connect and read timeouts and a 5 s buffer before playback, so a cold hero video must be ready well inside 8 s.

### Structure

8. **The tree.** Folded 17 collections into 8: Spotlight, Streaming, Indian Cinema, Genres, Moods & Themes, Franchises & Universes, Studios & Directors, and World & Anime. Long lists became group tiles (Best of the Best, Decades, By Runtime, Indian Universes, Comedy Franchises, Indian Studios, Indian Directors, Anime, Anime Studios), whose members live in a hidden `library` collection and appear as rows inside the group.
9. **Rows inside folders.** Added `src/collections/facets.js`: row kinds such as trending, new, top rated, hidden gems, blockbusters, classics, coming soon, in release order, airing this week and original series, each a TMDB discover recipe. Every source type has a default row set (a streaming service gets Trending Movies, Trending Shows, Original Series, New and Top Rated), and a folder can choose its own with `"rows"`.
10. **Engine and catalog handler.** The engine builds the folder tree per region in two passes (plain folders, then groups), and the catalog handler serves `gc-<type>-<facet>,<folder>` and `gc-<type>,<member>` rows. v3 (`gc-movie,<folder>`) and v2 (`genre=IN.netflix`) packs keep working.
11. **Manifest budget.** Trimmed the home rows to 11 featured ones and added 14 facet catalogs next to `gc-movie` and `gc-series`: 4.3 KB per edition, well under the SDK's 8 KB limit, checked for every region with all time-aware rows switched on.
12. **The pack.** `src/collections/pack.js` writes Follow Layout collections with no All tab, a collection backdrop, one source per row (group rows carry the member name as genre, so a row reads "Movies · Hombale Films"), and a hero video per folder. `?focus=gif` and the new `?motion=off` give the same ids, so importing another variant later updates in place.

### Artwork and motion

13. **Group artwork.** A group's cover, focus loop and hero mix pictures from its first six members, round-robin, without repeats and without adult titles, so Indian Studios shows Hombale, Mythri and Yash Raj films side by side.
14. **Focus loop rewrite.** The WebP loop is now continuous Ken Burns motion: three backdrops, 14 frames each on its own camera path, plus 4 crossfade frames, all at 100 ms (42 frames, about 120 to 460 KB, about 1 s to render). It looks the same on Android TV, Android and iOS. The GIF loop for Android 8 and older keeps its hold-and-crossfade style.
15. **Hero geometry.** The hero still and the hero video share one tilted poster strip with an extra row of margin, so the first video frame is the still.
16. **Hero video frames.** Each poster column is rotated once with sharp; after that each frame is a set of row copies at integer offsets along the tilt, about 1.6 ms per 1280x720 frame. Alternate columns ease up and down and return, so the video starts and ends on the still. That makes Nuvio's switch from still to video and back invisible, and avoids the stuck-on-last-frame look. A first attempt that rotated every frame in ffmpeg took over 15 s and was dropped.
17. **Encoding.** `src/art/video.js` pipes raw frames into ffmpeg, which overlays the hero shading and encodes H.264 High profile, level 4.0, yuv420p, about 2 Mbps (capped at 2.6 Mbps), a 60-frame GOP, BT.709 tags and `+faststart`, with no audio. A 6 s video is about 1.5 MB and takes about 4 to 5 s cold on one CPU, including the TMDB fetch, inside Nuvio's 8 s timeout. Frame 0 matches the still at about 29 dB PSNR.
18. **The hero.mp4 route.** `/art/folder/<CC>/<folder>/hero.mp4` renders once per instance (with in-flight dedupe), answers byte ranges with 206 and 416 and a strong ETag, and carries the same day-plus-a-week CDN caching as the other folder art. It sends 404 with a short cache when there are no posters yet, and 503 when `HERO_VIDEO=off` or ffmpeg is missing; the pack then leaves `heroVideoUrl` out. `ART_VERSION` moved to 4, so every client fetches the new art.

### Shipping

19. **Checks.** 201 tests. New ones cover the tree, facet rows and their names, the motion and video switches, pack stats, manifest size per region, uniform 100 ms focus frames, hero frame determinism and still match, a real MP4 encode (moov before mdat), byte ranges, and the hero.mp4 route. `validate-config` now checks that every row resolves to a declared catalog and that every pack stays under 400 KB. CI checks data formatting, and the nightly job prewarms the hero videos and focus loops of the first two collections for India and the US.
20. **Docs and release.** README, CONTRIBUTING, the landing page (with the new still-pack link) and this note were updated, and the version moved to 4.0.0. Deploying is a push to master; Vercel bundles the ffmpeg binary through `includeFiles`.

## After updating

- Re-import the collections URL in Nuvio TV (Settings > Content & Discovery > Collections > Import > URL), for example `https://nuvio-golden-catalogue-mocha.vercel.app/r/IN/collections.json`. Ids are stable, so this replaces the v3 collections.
- Hero videos play on the Modern home layout. On phones Nuvio shows the still.
- On an older TV or a slow network, `?focus=gif` or `?motion=off` gives the same collections with lighter art.

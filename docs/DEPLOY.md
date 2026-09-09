# Deploying

Referenced from `src/main.js`, `vite.config.js`, and `public/_headers`. The subject
of this document is really one thing: **the world bakes are generated, not
tracked**, and everything below follows from that.

The site deploys to **Cloudflare Pages** as a static Vite build, git-connected
to `main`. There is no separate bake origin, no bucket, no CORS, and no
environment variable — the bakes are plain same-origin static files under
`/bakes/`, in production exactly as in dev.

Cloudflare was chosen over Vercel for one reason: **egress is free**. Every
first-time visitor downloads a whole world, and on Vercel's free tier that
capped the site at roughly 5,700 visitors a month before the project was
throttled. Pages has no such ceiling.

Vercel is gone as of 2026-09-09 — the project was deleted, the GitHub App
disconnected, and `vercel.json` removed. The repo now describes one host:

| | Cloudflare Pages |
| --- | --- |
| Header config | [`../public/_headers`](../public/_headers) |
| Egress | free |
| Per-file upload cap | 25 MiB |
| Build command | `node tools/bake.mjs --res 1536 && npm run build` |
| Output | `dist` |
| Node | `NODE_VERSION=22` |

**The build command and `NODE_VERSION` live only in the Pages dashboard.**
Nothing in the repo sets them, which is the one thing `vercel.json` used to do
that `_headers` does not — if a fresh Pages project is ever wired up, those two
settings have to be typed in by hand or the deploy ships a bake-less `dist/`.

`--res 1536` is what the game actually loads; 768 and 512 exist for the local
capture tools and only cost build time and deploy size in production.

---

## How the bakes ship

`public/bakes/` is gitignored (44 MB of incompressible, frequently-invalidated
binary once bloated `.git` to 637 MB — see `.gitignore` for the history). So a
fresh checkout, including Cloudflare's build container, has no bakes. The
build command configured on the Pages project creates them:

```
node tools/bake.mjs && npm run build
```

`tools/bake.mjs` generates the `.pab` files plus `manifest.json` into
`public/bakes/` (~25 s of build CPU per resolution), and Vite copies `public/`
into `dist/` verbatim. Its defaults — seed, world size, altitude — are read
from `src/world/WorldConfig.js`, so the build always bakes the world the game
actually loads.

Cloudflare's per-file upload limit is 25 MiB. The 1536 bake is 44.5 MB raw and
**16.3 MB after brotli**, which is the only reason it fits — the headroom is
8.9 MB, not 84 MB as it was on Vercel. The `assetSizeCap` plugin in
[`../vite.config.js`](../vite.config.js) runs `enforce: 'post'`, so it measures
files after compression and fails the build if any crosses 25 MiB, catching an
oversized asset locally rather than at a refused deploy. If it fires, host the
file off the bundle rather than shrinking it.

## Bandwidth, and why it is the thing to watch

Every **first-time** visitor downloads the whole world. Caching does not help
them — an HTTP cache only ever helps the *second* visit, and in a traffic spike
almost everyone is a first visit. Pages does not bill egress, so this is no
longer a bill — but it is still the number that decides how long a first-time
visitor stares at the loading screen, and on a phone connection that is the
whole first impression:

| | per fresh visitor |
| --- | --- |
| 1536 bake, brotli (what ships) | 16.1 MB |
| JS bundle (Pages compresses) | ~1.7 MB |
| `Maple Road Loop.mp3`, only if the player stays ~20 s | 4.9 MB |
| **Typical total** | **~18 MB** (~23 MB if the music enters) |

Before compression and lazy audio this was ~51 MB — so the same first load
used to take nearly three times as long. This is why the compression work was
worth doing even though the free-egress move made the bandwidth itself free.

## Compression

`compressBakesForBuild` in [`../vite.config.js`](../vite.config.js) brotli-
compresses (quality 5) every `.pab` in `dist/` after the bundle:
**44.5 MB → 16.1 MB, 2.76x**. Quality 9 saves a further 0.2 MB for 11 s more
build time per bake, which is not a good trade when build minutes are billed
too.

The compressed bytes **keep the `.pab` filename**, and `_headers` sets
`Content-Encoding: br` on `/bakes/*.pab` so the browser inflates them
transparently. `loadCachedBake` needs no change — `arrayBuffer()` hands it the
original bytes, `PAB1` magic and all.

Two consequences worth knowing:

- **`public/bakes/` stays raw.** Everything in `tools/` reads those files off
  disk with `decodeBake` and would choke on compressed bytes. Only `dist/` is
  rewritten, so dev and every capture harness are untouched.
- **`vite preview` shows the bake failing.** It does not read `_headers`, so
  no `Content-Encoding` is set, the magic check fails and the game live-bakes.
  That is the intended graceful degradation, not a bug — but it means preview
  is not a test of production. Use `tools/pages-sim.mjs` instead:

```bash
npm run build && node tools/pages-sim.mjs
```

That serves `dist/` applying `dist/_headers`' rules on
`http://127.0.0.1:5224`. A correct run logs `[world] loaded cached bake` and
the Network panel shows ~16 MB transferred against ~44 MB decoded.

**Verify once after the first real deploy** that Pages passes the header
through rather than stripping it or double-compressing:

```bash
curl -sI https://YOURSITE/bakes/world-<seed>-1536-<hash>.pab | grep -i 'content-encoding\|content-length'
```

Expect `content-encoding: br` and a length near 16 MB. If the header is absent
you are shipping the full 44.5 MB; if the game live-bakes in production while
the header *is* present, Pages is compressing on top of the brotli and the
plugin should be dropped in favour of letting Pages do it alone. (Note some
`curl` builds lack brotli support, so `--compressed` may fail where a browser
succeeds — trust the headers and the browser, not `curl --compressed`.)

## Caching

The bake filenames are content-addressed — `world-<seed>-<res>-<genhash>.pab`,
where the hash is of `src/world/TerrainGen.js` — so a given URL's bytes never
change. `public/_headers` exploits that:

| Path | Cache-Control | Why |
| --- | --- | --- |
| `/bakes/*.pab` | `public, max-age=31536000, immutable` | A returning player never re-downloads or revalidates the 44 MB bake. A terrain change rotates the filename, so staleness is impossible. |
| `/bakes/manifest.json` | `no-cache` | The manifest is mutable (it lists what exists for the current generator hash) and must be revalidated so a fresh deploy is seen immediately. |

The client side of this is `loadCachedBake` in `src/main.js`: it fetches with
`cache: 'force-cache'`, validates the `PAB1` magic number, and retries once
with `cache: 'reload'` to evict a poisoned entry.

### Seeds the deploy never baked

Only the seed in the build command ships as a file, so the Seed box in settings
and any shared `?seed=` link have nothing to fetch and must bake in a worker —
**72 s measured on production**, against 16 s for the same work in `node`.

That bake is now kept. `main.js` stores the encoded result in the Cache API
(`pab-bakes-v1`) under the same URL the network path would have used, so the
generator hash is part of the key and a `TerrainGen.js` change orphans the
entry instead of serving last week's algorithm. Measured: **9.1 s to bake,
159 ms to reload**. The worker encodes the buffer (`worldWorker.js`) so the
main thread never serialises 44 MB, and the store is not awaited — it settles
during startup.

Entries are gzipped (44.5 MB -> 17.3 MB at 1536) because this is the player's
disk. `pruneBakes` deletes every entry from another generator hash, then trims
to the newest `BAKE_CACHE_KEEP` (3) worlds.

Every failure degrades to the bake that would have happened anyway: no Cache
API, an insecure context, `QuotaExceededError`, a half-written entry. A corrupt
entry is caught by the same `PAB1` check the network path uses and is
overwritten by the fresh bake — verified by planting 16 bytes of garbage under
a live key.

## Deploying a terrain change

The bake cache key is a hash of `src/world/TerrainGen.js` (`sourceHash` in
`tools/bake.mjs`). **Editing that file invalidates every existing bake**, by
design — it is what stops a stale bake silently serving the previous
algorithm.

In production this is self-healing: every Pages build starts clean and bakes
from current source, so the deployed bake always matches the deployed
generator. Just push. Locally you re-bake by hand:

```bash
node tools/bake.mjs --force
```

## Working locally

`public/bakes/` is **not** tracked in git. A fresh clone has no bakes, so:

```bash
npm install
node tools/bake.mjs
npm run dev
```

The bake costs roughly 25 s of CPU per resolution and is a one-time price per
clone, and again whenever you touch `TerrainGen.js`.

Nothing breaks if you skip it — `src/main.js` falls back to
`loadCachedBake() ?? bakeWorld()`, baking in a worker — you just pay the wait on
every page load instead of once at the terminal.

Force a live bake regardless of what is cached with `?nocache=1`.

## Troubleshooting

**Every production load logs `baked live` and sits ~30 s on the loading
screen.**
The deployed `dist/` has no bakes — the build command that generates them did
not run. The command lives only in the Pages project settings (Settings →
Builds & deployments), so check it still starts with `node tools/bake.mjs` and
that the step succeeded in the build log.

**`cached bake unusable, baking live: not a Camping Season bake`, on a
machine that has a perfectly good bake on disk.**
A poisoned HTTP cache entry. A dev server answers a missing path with
`index.html` at status 200, so a bake requested before it existed got HTML
stored under the bake's own URL. `loadCachedBake` defends against this — it
requires the `PAB1` magic number in the first four bytes rather than trusting
`response.ok`, and retries once with `cache: 'reload'` to evict the bad entry.
If you still see it, hard-reload.

**`STALE BAKE: generator is <a>, using <b>`.**
The exact generator hash is missing and it fell back to the newest bake for
that seed and resolution. Locally that means you are mid-edit on
`TerrainGen.js`; run `node tools/bake.mjs --force`. In production it should
never happen, because each deploy bakes from the source it ships.

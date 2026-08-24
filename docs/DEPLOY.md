# Deploying

Referenced from `src/main.js`, `vite.config.js`, and `vercel.json`. The subject
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

The Vercel config is deliberately kept working. [`../vercel.json`](../vercel.json)
and [`../public/_headers`](../public/_headers) carry the same rules in each
host's format; Vercel ignores `_headers` and Cloudflare ignores `vercel.json`,
so either host can serve this repo without a code change.

| | Cloudflare Pages | Vercel |
| --- | --- | --- |
| Header config | `public/_headers` | `vercel.json` |
| Egress | free | 100 GB/mo on the free plan |
| Per-file upload cap | 25 MiB | 100 MB |
| Build command | `node tools/bake.mjs --res 1536 && npm run build` | same |
| Output | `dist` | `dist` |
| Node | `NODE_VERSION=22` | auto |

`--res 1536` is what the game actually loads; 768 and 512 exist for the local
capture tools and only cost build time and deploy size in production.

---

## How the bakes ship

`public/bakes/` is gitignored (44 MB of incompressible, frequently-invalidated
binary once bloated `.git` to 637 MB — see `.gitignore` for the history). So a
fresh checkout, including Vercel's build container, has no bakes. The build
command in [`../vercel.json`](../vercel.json) creates them:

```
node tools/bake.mjs && npm run build
```

`tools/bake.mjs` generates the `.pab` files plus `manifest.json` into
`public/bakes/` (~25 s of build CPU per resolution), and Vite copies `public/`
into `dist/` verbatim. Its defaults — seed, world size, altitude — are read
from `src/world/WorldConfig.js`, so the build always bakes the world the game
actually loads.

Vercel's per-file deployment limit is 100 MB; the 1536 bake is 44 MB. The
`assetSizeCap` plugin in [`../vite.config.js`](../vite.config.js) fails the
build if any file in `dist/` crosses the limit, so an oversized asset is caught
locally rather than by a refused deploy. If it fires, host the file off the
bundle rather than shrinking it.

## Bandwidth, and why it is the thing to watch

Every **first-time** visitor downloads the whole world. Caching does not help
them — an HTTP cache only ever helps the *second* visit, and in a traffic spike
almost everyone is a first visit. Vercel bills edge→client transfer, which is
exactly the part a cache header does not touch. So the per-visitor payload is
the bill:

| | per fresh visitor |
| --- | --- |
| 1536 bake, brotli (what ships) | 16.1 MB |
| JS bundle (Vercel compresses) | ~1.7 MB |
| `Maple Road Loop.mp3`, only if the player stays ~20 s | 4.9 MB |
| **Typical total** | **~18 MB** (~23 MB if the music enters) |

Before compression and lazy audio this was ~51 MB. At Vercel Pro's 1 TB
included transfer that is the difference between roughly 20,000 and 60,000
visitors a month, and overage is billed per GB.

**Set a spend cap.** The optimisations lower the slope; only Vercel's spend
management bounds the worst case. A front-page day at 100k visitors is ~1.8 TB.

## Compression

`compressBakesForBuild` in [`../vite.config.js`](../vite.config.js) brotli-
compresses (quality 5) every `.pab` in `dist/` after the bundle:
**44.5 MB → 16.1 MB, 2.76x**. Quality 9 saves a further 0.2 MB for 11 s more
build time per bake, which is not a good trade when build minutes are billed
too.

The compressed bytes **keep the `.pab` filename**, and `vercel.json` sets
`Content-Encoding: br` on `/bakes/*.pab` so the browser inflates them
transparently. `loadCachedBake` needs no change — `arrayBuffer()` hands it the
original bytes, `PAB1` magic and all.

Two consequences worth knowing:

- **`public/bakes/` stays raw.** Everything in `tools/` reads those files off
  disk with `decodeBake` and would choke on compressed bytes. Only `dist/` is
  rewritten, so dev and every capture harness are untouched.
- **`vite preview` shows the bake failing.** It does not read `vercel.json`, so
  no `Content-Encoding` is set, the magic check fails and the game live-bakes.
  That is the intended graceful degradation, not a bug — but it means preview
  is not a test of production. Use `tools/vercel-sim.mjs` instead:

```bash
npm run build && node tools/vercel-sim.mjs
```

That serves `dist/` applying `vercel.json`'s header rules on
`http://127.0.0.1:5224`. A correct run logs `[world] loaded cached bake` and
the Network panel shows ~16 MB transferred against ~44 MB decoded.

**Verify once after the first real deploy** that Vercel passes the header
through rather than stripping it or double-compressing:

```bash
curl -sI https://YOURSITE/bakes/world-<seed>-1536-<hash>.pab | grep -i 'content-encoding\|content-length'
```

Expect `content-encoding: br` and a length near 16 MB. If the header is absent
you are shipping the full 44.5 MB; if the game live-bakes in production while
the header *is* present, Vercel is compressing on top of the brotli and the
plugin should be dropped in favour of letting Vercel do it alone. (Note some
`curl` builds lack brotli support, so `--compressed` may fail where a browser
succeeds — trust the headers and the browser, not `curl --compressed`.)

## Caching

The bake filenames are content-addressed — `world-<seed>-<res>-<genhash>.pab`,
where the hash is of `src/world/TerrainGen.js` — so a given URL's bytes never
change. `vercel.json` exploits that:

| Path | Cache-Control | Why |
| --- | --- | --- |
| `/bakes/*.pab` | `public, max-age=31536000, immutable` | A returning player never re-downloads or revalidates the 44 MB bake. A terrain change rotates the filename, so staleness is impossible. |
| `/bakes/manifest.json` | `no-cache` | The manifest is mutable (it lists what exists for the current generator hash) and must be revalidated so a fresh deploy is seen immediately. |

The client side of this is `loadCachedBake` in `src/main.js`: it fetches with
`cache: 'force-cache'`, validates the `PAB1` magic number, and retries once
with `cache: 'reload'` to evict a poisoned entry.

Seeds that were never baked (someone loading `?seed=123456`) fall through to a
live worker bake on every load — only the seeds baked at build time exist as
files.

## Deploying a terrain change

The bake cache key is a hash of `src/world/TerrainGen.js` (`sourceHash` in
`tools/bake.mjs`). **Editing that file invalidates every existing bake**, by
design — it is what stops a stale bake silently serving the previous
algorithm.

In production this is self-healing: every Vercel build starts clean and bakes
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
not run. Check that the Vercel project is using `vercel.json`'s `buildCommand`
(a dashboard override wins over the file) and that `node tools/bake.mjs`
succeeded in the build log.

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

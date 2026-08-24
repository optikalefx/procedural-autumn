# Deploying

Referenced from `src/main.js` and `vite.config.js`. The subject of this document
is really one thing: **the world bakes are too big to ship in the bundle**, and
everything below follows from that.

> **Fill in before this is useful to anyone else:** the bucket origin and the
> Pages project name are not in the repo — they live in the Cloudflare dashboard.
> Replace `<BAKE_ORIGIN>` and `<BUCKET>` throughout with the real values.

---

## The constraint

Cloudflare Pages and Workers reject any single static asset over **25 MiB**.

`public/bakes/world-20261018-1536-<hash>.pab` is **44 MB**. It is the bake the
game actually loads, since `WORLD.heightmapRes` is 1536. Vite copies `public/`
into `dist/` verbatim, so an unguarded `npm run build` walks straight into the
limit and the deploy is refused.

So the bakes are hosted on R2 and fetched at runtime from a separate origin.

## What the build does about it

Two plugins in [`../vite.config.js`](../vite.config.js), both `apply: 'build'`
so that dev and the capture harnesses in `tools/` are entirely unaffected:

| Plugin | Job |
| --- | --- |
| `excludeBakesFromBuild` | Deletes every `.pab` from `dist/bakes/` in `closeBundle`. Leaves `manifest.json` (480 bytes) so a local `npm run preview` with no bake origin still works. |
| `assetSizeCap` | Walks `dist/` and fails the build if *any* file exceeds 25 MiB. This is the check that would have caught the 32 MB bake before a deploy did. |

If `assetSizeCap` fires on some new asset, host it off the bundle the same way.
Do not shrink the asset to sneak under the cap.

## Configuration

One environment variable, read at build time by Vite (`import.meta.env`), so it
must be set **in the Pages build environment**, not at runtime:

```
VITE_BAKE_BASE_URL=https://<BAKE_ORIGIN>
```

- **Unset** (the default) → `BAKE_BASE` is `''` and every bake URL is
  same-origin `/bakes/...`. This is exactly what local dev and every headless
  tool sees, which is why they behave identically to a pre-R2 checkout.
- **Set** → an absolute origin, trailing slashes stripped. Cross-origin, which
  means the bucket needs CORS. See below.

## Bucket setup

The bakes are public, immutable, and content-addressed by generator hash, so
they cache forever and need no auth.

**CORS is required.** The fetch in `loadCachedBake` is cross-origin, so
`<BAKE_ORIGIN>` must return `Access-Control-Allow-Origin` for the site's origin.
Without it the game hangs on the loading screen — see Troubleshooting.

```jsonc
// R2 → <BUCKET> → Settings → CORS policy
[
  {
    "AllowedOrigins": ["https://<your-site>"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

## Deploying a terrain change

The bake cache key is a hash of `src/world/TerrainGen.js`
(`sourceHash` in `tools/bake.mjs`). **Editing that file invalidates every
existing bake**, by design — it is what stops a stale bake silently serving the
previous algorithm. So any terrain change means re-baking and re-uploading.

```bash
node tools/bake.mjs --force
```

That writes the new `.pab` files plus `manifest.json` into `public/bakes/`, and
prunes bakes from older generator hashes off local disk.

Then upload the new bakes **and** the regenerated manifest:

```bash
npx wrangler r2 object put <BUCKET>/bakes/manifest.json --file public/bakes/manifest.json
for f in public/bakes/*.pab; do
  npx wrangler r2 object put "<BUCKET>/bakes/$(basename "$f")" --file "$f"
done
```

Upload the bakes **before** deploying the site. A client running new JS against
an old bucket finds no bake for its generator hash, falls back to the newest
bake in the manifest, and logs a `STALE BAKE` warning — or, if the manifest is
also missing it, bakes live and takes a ~25–50 s loading screen.

Old objects in the bucket are not pruned by anything. Delete superseded hashes
by hand; the same accumulation is what made the git repository unusable.

## Working locally

`public/bakes/` is **not** tracked in git (see `.gitignore` for the reasoning).
A fresh clone has no bakes, so:

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

**The game sits on the loading screen forever.**
Almost always the bakes are unreachable. Check the console: `main.js` logs an
explicit hint naming CORS whenever `BAKE_BASE` is set and the fetch throws.
A `TypeError` here is a missing `Access-Control-Allow-Origin`, not a missing
file — a genuinely absent object returns a clean 404 and falls through to a
live bake instead of hanging.

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
`TerrainGen.js`; run `node tools/bake.mjs --force`. In production it means the
bucket was not updated as part of the deploy.

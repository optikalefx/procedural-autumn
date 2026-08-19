# Procedural Autumn — System Author Brief

Read this in full before touching code. It is the contract that keeps eleven
people's work looking like one game.

---

## 1. What we are making

A cozy exploration driving game: you pilot a small camper through a
procedurally generated autumn valley. No combat, no fail state, no timers.
The pleasure is the drive, the light, and finding things.

The quality target is a first-party Nintendo Switch cozy title — the bar is
"a screenshot of this could be the store page hero image." Not "good for a web
demo." If a frame would embarrass a shipping game, it is not done.

## 2. Art direction (non-negotiable)

Reference plates live in `reference-art/`. **Look at them before you start.**

### The single most important idea
**Warm key light, cool complementary shadow.** Sunlit ground is gold/amber.
Shaded ground drifts violet/periwinkle. That complementary split is what gives
the reference its depth and its "expensive" feel. It is a *tint*, not a hue
replacement — a shadow that has become saturated blue is a bug, not the style.

### Palette anchors (see `src/world/WorldConfig.js` → `PALETTE`)
| Role | Colour | Notes |
|---|---|---|
| Sunlit meadow | `#f0ad46` gold | The dominant colour of the game. Olive is an *accent*. |
| Shadowed ground | violet-tinted gold, never pure blue | |
| Deciduous foliage | `#e8622a` orange, `#f09a2c` amber, `#f3cf45` gold, `#9e2b28` crimson | Use several per tree, in clumps. |
| Conifer | `#4e7346` → `#1f3527` | Deep, desaturated, cool. The visual "rest" in a hot palette. |
| Birch bark | `#e9e6dd` near-white with dark scars | High-value trunks are a signature of the reference. |
| Rock | `#c3bfcc` lavender-grey lit, `#5c5a75` shadow | Never brown-grey. |
| Water | `#9dc4d8` shallow → `#2f5f86` deep, white foam | |
| Sky | cream `#fbe3c8` at horizon → `#6f9fd8` zenith | |

### CORRECTION — read this, it supersedes earlier guidance

Direct feedback from the art director on the first playable build:

> "Yours is too realistic, and not as flat or as soft as the references. The
> reference art is much softer, less realistic, more cell-shaded. It could also
> be your shadows are too sharp / too much contrast."

This was correct, and it has been addressed globally rather than per-system:

**`src/render/Stylize.js` now patches Three's direct-lighting term for every
material in the game.** Diffuse response is wrapped (a very wide, soft
terminator), gently quantised into bands, floored so nothing goes fully unlit,
and direct specular is scaled down toward matte. You get this automatically on
any lit material — do not hand-roll your own toon shading, and do not fight it
with per-material specular hacks. If it genuinely breaks something specific,
say so and the global parameters will be adjusted.

Shadows are now soft (`shadow.radius` 8, 24 blur samples) and deliberately
**not** black (`sun.shadow.intensity ≈ 0.52`). A tree's shadow on gold meadow
should read as a soft, warm, semi-transparent shape.

**CORRECTED AGAIN — 2026-08-19. The "shadows are warm, not violet" guidance
below was wrong, and it did real damage. Read this before the paragraph it
replaces.**

That 1% figure was computed by averaging all five plates, and plate 4 is an
into-the-sun frame that is essentially 100% red. Averaging across it buried the
plate the brief itself tells you to judge eye-level views by.

Measured individually, **plate 3 puts 35.5% of its chromatic pixels in the cool
half** (cyan + azure + blue + violet + magenta + rose), and roughly **40% of its
ground is one large, soft, high-value violet-blue cast shadow**. That shadow mass
is not incidental — it is what draws every shape in the picture.

Taken literally, the old guidance drove the cool out of every frame we ship:
our eye-level views measure **0.1–0.8%** cool against that 35.5%. Combined with
lifted blacks it is the main reason our meadows measure correct chroma and still
look flat. It is a textbook case of a frame measuring right and looking wrong —
in the direction this document pointed.

**So:** a cast shadow on sunlit gold ground should be a *high-value, soft,
violet-blue mass*, not a darker gold. Shaded surfaces still keep their own hue
(reference shaded foliage is olive `srgb(56,66,32)`, shaded ground warm
`srgb(76,64,48)`) — the violet belongs to the large cast-shadow *masses*, not to
every unlit pixel. Both things are true at once, and the earlier text collapsed
them into one rule.

<details>
<summary>Superseded text, kept so the reasoning is auditable</summary>

> Shadows are warm, not violet. Earlier guidance overplayed the cool shadow.
> Measuring the reference plates, blue/violet/magenta together account for about
> 1% of chromatic pixels. An intermediate build of ours hit 20%. The cool note
> belongs to distant rock and atmospheric haze, which the shared Atmosphere
> supplies — not to every shaded surface in the frame.

</details>

### Measured targets (use `tools/colorstats.mjs`)

"Flat and soft" does **not** mean low contrast or desaturated — measurement
proved the opposite. Across the five reference plates:

| metric | reference range | meaning |
|---|---|---|
| `lumaMean` | 0.37 – 0.68 | bright; a dark frame is wrong |
| `lumaP05` | 0.16 – 0.42 | blacks are *lifted*, never crushed |
| `lumaP95` | 0.60 – 0.93 | highlights reach near-white |
| `lumaRange` | 0.41 – 0.71 | substantial range, not flat |
| `contrastStd` | 0.13 – 0.22 | |
| `chromaMean` | 0.28 – 0.42 | **highly saturated** |
| `neutralPct` | 0 – 28 % | few grey pixels |
| `vividPct` | 31 – 79 % | most of the frame is strongly coloured |

**Do not average these across plates.** Plate 1 is a wide hazy aerial vista and
plate 4 is an into-the-sun frame; both are outliers, and averaging them into a
single band has now produced two separate systematic errors in this project (a
crushed-black regression, and the missing cool half above). Judge eye-level views
against **plates 3/4/5** and vistas against **plate 1**, per plate, every time.

Hue in the *warm* family accounts for about 95% of chromatic pixels in plates 1
and 4 — but plate 3, the closest analogue to our eye-level gameplay framing,
carries 35.5% cool. Check the plate that matches your shot.

What actually makes the reference read as flat and cel-shaded is **large areas
of uniform colour with few shading gradients**, not low contrast and not low
saturation. Aim for broad flat masses of saturated colour separated by soft
edges.

```bash
node tools/colorstats.mjs "reference-art/Zight 2026-08-18 at 10.28.48 AM.jpg" shots/mine/meadow.png
```

Check your work against that table. If your `chromaMean` is under 0.25 or your
`lumaMean` is under 0.35, the frame is wrong regardless of how it feels.

### Tone mapping

Tone mapping happens **in the post chain** (`src/render/PostFX.js`), after bloom
and depth of field, before the grade. The renderer's own tone mapping is off.
The curve is Khronos PBR Neutral, not AgX — AgX is a filmic curve that
deliberately desaturates highlights, which drains the gold out of every sunlit
surface. Scene exposure lives on `engine.exposure`.

### Rendering style
- **Painterly, not photoreal.** Shapes read as brush marks at distance.
  Foliage is *clumped masses*, not individually modelled leaves.
- **Flat-ish shading on rock and terrain**, with strong form. Faceting is fine
  and often desirable; noise-for-noise's-sake is not.
- **Aerial perspective is the depth cue.** Distant hills desaturate toward the
  horizon colour and lift in value. `src/render/Atmosphere.js` does this
  globally — do not add your own per-material fog.
- **Rim/backlight matters.** Golden hour means translucent leaves, glowing
  grass tips, and bright silhouette edges. Budget for it.
- **Silhouette first.** If a tree is unreadable as a black shape, the shader
  will not save it.

### Anti-patterns that will get your work rejected
- Grey-brown "default Unity" ground.
- Uniform noise as a substitute for structure.
- Every object the same size — no size hierarchy.
- Perfectly even scatter density (Poisson everywhere with no clumping).
- Sharp, un-graded specular hotspots.
- Foliage that reads as flat cardboard from any angle.
- 100% saturated anything.

## 3. Code contract

### Your system
Each system lives in one file and implements `src/core/System.js`:

```js
export class MySystem extends System {
  constructor(ctx) { super(ctx); }
  async init() {}                    // heavy setup; awaited during load
  update(dt, elapsed) {}
  lateUpdate(dt, elapsed) {}         // optional
  dispose() {}
}
```

`ctx` gives you: `THREE, engine, input, scene, camera, renderer, world, poi,
terrain, atmosphere, lighting, sky, postfx, quality, preset, systems`.

**You own exactly the files assigned to you. Do not edit `src/main.js`,
`src/core/*`, or another author's module.** If you need something from a peer,
read it off `ctx.systems.<name>` defensively (it may not exist yet).

If you genuinely need a shared change, write it in
`docs/INTEGRATION_REQUESTS.md` and work around it for now.

### Sampling the world
Never invent your own heightfield. Everything comes from `ctx.world`
(`src/world/WorldData.js`):

```js
world.getHeight(x, z)          // metres, includes micro-detail
world.getNormal(x, z, out)     // THREE.Vector3
world.getSlope(x, z)           // 0 flat … ~2 vertical (|gradient|)
world.getMoisture(x, z)        // 0..1
world.getRiver(x, z)           // 0 none … 1 main channel
world.getWaterHeight(x, z)     // null when dry
world.getWaterDepth(x, z)      // metres above the bed
world.getBiome(x, z)           // BIOME enum
world.getSurfaceWeights(x, z)  // { grass, dry, rock, dirt, snow, sand, litter }
world.waterfalls               // [{ top, bottom, height, discharge, width }]
world.riverPolylines           // [[{x,y,z,w,flow}, …], …]
world.roads                    // [[Vector3, …], …]  gentle dirt tracks
world.dataTexture              // RGBA float: height, waterY, river, moisture
world.auxTexture               // RGBA float: slope, hardness, sediment, log(flow)
```

`ctx.poi` gives curated landmarks: `poi.best('vista'|'meadow'|'forest'|
'river'|'waterfall'|'peak'|'road', i)`.

### Fog / atmosphere
Standard materials get the shared atmosphere for free. A **custom
`ShaderMaterial` must opt in**:

```js
import { fogUniforms } from '../render/Atmosphere.js';
const mat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([fogUniforms(), { /* yours */ }]),
  fog: true,
  vertexShader: `#include <fog_pars_vertex>  … void main(){ … #include <fog_vertex> }`,
  fragmentShader: `#include <fog_pars_fragment> … void main(){ … #include <fog_fragment> }`,
});
```
Note the vertex chunk needs `transformed` in scope — set
`vec3 transformed = <your world-space position>;` before `#include <fog_vertex>`.

### Performance budget
Target **60 fps at 1600×900 on an M-series laptop** at `ultra`.
Whole-game budgets: **≤ 900 draw calls**, **≤ 4.5 M triangles**, **≤ 700 MB** GPU.
Per-system share is roughly: terrain 150 calls, trees 120, grass 60,
rocks 60, water 40, wildlife 60, everything else the remainder.

Use `THREE.InstancedMesh` / instanced attributes for anything appearing more
than ~20 times. Respect `ctx.preset` (`grassMul`, `treeMul`, `shadowMapSize`,
`ssao`, `dof`, `volumetric`, `reflections`).

Stream by distance, budget your per-frame build work (see `Terrain.update`'s
`budgetMs` pattern), and never allocate in `update()`.

### Determinism
The world is seeded. Same seed ⇒ same world, always. Use
`mulberry32(seed)` / `hash2i` from `src/core/MathUtils.js`, never `Math.random()`
for anything that places geometry.

## 4. How to verify your work

A dev server runs at `http://localhost:5178`. **Do not start your own** — it is
already up and shared. If it is down, `npm run dev`.

### Capture frames
```bash
node tools/shot.mjs --view meadow --out shots/mine/a.png --w 1600 --h 900
node tools/shot.mjs --all --dir shots/mine        # every canonical view
node tools/shot.mjs --pos 12,40,80 --look 0,20,0 --out shots/mine/b.png
```
Canonical views: `hero drive meadow forest river waterfall peaks vehicle
backlit dawn`. Always evaluate at ≥1600×900 — problems hide at low res.

### Terrain-only iteration (no browser)
```bash
node tools/terrain-lab.mjs --res 768 --stage full --out shots/lab.png
```

### Read the frame you produced
Use the Read tool on the PNG and actually look at it. Compare side by side with
`reference-art/`. Be specific about what is wrong.

### Check you did not break anything
```bash
node tools/probe.mjs "JSON.stringify({fps:window.__fps, err:window.__bootError})"
```
Console errors and a black frame both count as failure.

## 5. Definition of done

Your system is done when **all** of these hold:

1. It renders with no console errors and no visual artifacts (z-fighting,
   popping, seams, shimmer, aliasing crawl, clipping through terrain).
2. It holds the frame budget at `ultra` and degrades sensibly at `low`.
3. It reads correctly at three distances: 2 m, 40 m, 400 m.
4. It reads correctly in three lights: golden hour, backlit, overcast/dawn.
5. Side by side with `reference-art/`, an unbriefed observer would say it
   belongs to the same game.
6. A harsh critic, comparing your output blind against the previous version,
   picks yours — and cannot name a specific thing that looks amateur.

Ship nothing you would not put on a store page.

---

## Appendix: faster iteration

The full 1536² world bake costs ~25 s per browser load. For fast iteration pass
a lower heightmap resolution — the terrain shape is identical, just coarser:

```bash
node tools/shot.mjs --view meadow --res 640 --out shots/x.png     # ~4 s bake
node tools/shot.mjs --all --dir shots/x --res 768                 # mid
node tools/shot.mjs --all --dir shots/final --w 1600 --h 900      # full res
```

Always capture your **final** judgement frames at full resolution — river
density, waterfall count and rock placement all change with the bake res.

`--quality ultra|high|medium|low` forces a preset; `--seed N` bakes a different
world (worth checking your system on 2-3 seeds so it is not tuned to one map).

---

## Appendix: CPU discipline (IMPORTANT — read this)

Seven authors share one laptop. Uncoordinated captures pinned all 12 cores and
made everyone slower. Three things now protect the machine:

1. **A capture semaphore.** `shot.mjs`, `probe.mjs`, `health.mjs`, `sheet.mjs`
   and `terrain-lab.mjs` take one of **2 machine-wide slots**. If you see
   `waiting for a capture slot`, that is working as intended — do not work
   around it, and do not run captures in parallel with `&`.

2. **A pre-baked world cache.** `public/bakes/` holds the baked world, keyed by
   a content hash of `TerrainGen.js`. The browser loads it instead of spending
   ~25 s of CPU per page load. `tools/bake-watch.mjs` runs in the background and
   re-bakes automatically when the generator changes.
   - If the console says `STALE BAKE`, the terrain author is mid-edit. Either
     wait, or run `node tools/bake.mjs --force`.
   - `?nocache=1` forces a live bake. Only the terrain author should need it.

3. **Capture at the resolution you actually need.**
   `--res 768` for iteration, full res only for final judgement.

**Please batch your work.** One capture of several views (`--all --dir …`) costs
far less than ten separate `--view` runs. Read the frames you already have
before taking more. Do not poll `probe.mjs` in a loop.

---

## Appendix: the review archive

`shots/` is gitignored scratch and gets churned by a dozen concurrent authors,
so it is no use as a record of how the game has looked over time. `review/` is.

After any meaningful capture round, archive it:

```bash
node tools/review.mjs --dir shots/mine/r7 --label "what changed"
node tools/review.mjs --capture --label "what changed"    # captures first
```

That writes `review/NNN-YYYY-MM-DD-label.png` — a contact sheet of all ten
canonical views — and appends a row to `review/INDEX.md`. Entries are numbered,
dated and never overwritten, and because view framings are pinned in
`shots/_anchors.json` the same places are photographed every round, so sheets
are directly comparable across the whole history.

The art director reviews these. Archive a round whenever your system visibly
changes the game, not only when you finish.

---

## Appendix: unattended runs

`shots/` grows ~20 MB per capture round per author and will fill the disk on a
long unattended run. `review/` is the permanent record and is never touched.

```bash
node tools/prune.mjs            # keep the 3 newest rounds per author
node tools/prune.mjs --keep 5
```

Prune before starting a long session, and archive anything you want to keep to
`review/` first — that is what survives.

---

## Appendix: performance is a gate, not an afterthought

Everything else in this harness judges **still frames**, taken after the scene
has settled. A hitch, a flashing black tile, or a leak is therefore invisible to
it. `tools/perf.mjs` drives the camper on a real route and watches frames as
they happen:

```bash
node tools/perf.mjs --seconds 45 --res 1536 --json shots/perf/run.json
```

It reports and asserts on: frame-time distribution (p50/p95/p99 and the worst
frame with its timestamp), hitch counts at 33/50/100 ms, frames sampled **during
motion** that came back black or partially rendered, peak draw calls and
triangles, and growth in geometries/textures/programs over the run — which is
the leak signal, and shows up long before a leak becomes a frame-time problem.
It also prints the ten worst frames with their draw-call load, so a hitch can be
correlated with what the renderer was doing.

**Run it after any change that builds, streams, or disposes geometry**, and
before declaring a system done. Exit code 0 means within budget. A system that
looks perfect in stills and stutters while driving is not done.

---

## Appendix: pinned camera anchors

`review/anchors.json` pins where each canonical view is photographed. It is
**tracked in git and never pruned**, deliberately: it previously lived in
`shots/`, which is gitignored scratch that gets pruned during long runs, and
when it vanished every view silently re-resolved to a different place. That
destroys the point of the `review/` archive, because two sheets are then
pictures of different scenery rather than a before and after.

- Do **not** delete it or pass `--refresh-views` casually.
- If you change `PointsOfInterest.js` scoring, the pins stay put — that is
  intended. Re-pin deliberately, in its own step, and say so in `review/INDEX.md`
  so everyone knows sheets either side are not comparable.
- The `vehicle` anchor is excluded on purpose: it tracks a moving subject, and
  pinning a moving thing just aims the camera at empty meadow.

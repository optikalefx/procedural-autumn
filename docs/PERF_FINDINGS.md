# Where the frame time goes

Measured 2026-08-21 on an M3 Pro, at the pixel count a real display asks for.
**No `src/` code was changed to produce these numbers** — the harness drives
everything from the Playwright side.

## The tools, for whoever measures this next

| | |
|---|---|
| **`tools/ablate.mjs`** | **The instrument this document is built from, and the ground truth for performance work in this project.** Switches ~50 things off one at a time — per-system geometry, per-system `update()`, each post effect, shadows, pixel count, quality tier — and prices each one. Its header is the method: read it before trusting or extending any number here. |
| `tools/gputime.mjs` | Per-pass GPU timing via `EXT_disjoint_timer_query_webgl2`. **Its numbers are wrong on this stack** and its header explains how to tell. Kept so nobody rediscovers that, and because it will work on another backend. |
| `tools/perf.mjs` | Frame-time distribution, hitches, black frames, resource leaks over a real drive. Has a pass/fail budget. Use for regressions, not attribution. |
| `tools/dprtest.mjs` | Frame time at a real display's pixel ratio, with a `--gate`. The reason anyone knew the harness and the player disagreed. |
| `src/ui/PerfOverlay.js` | Always-on in-game readout. F3 toggles, Shift+F3 cycles detail. Shows the *effective* pixel ratio, so you can see adaptive resolution buying fps by drawing fewer pixels. |
| `stats-gl` (dependency) | In `package.json`, imported by nothing. It reads the same broken timer-query extension `gputime.mjs` does — see that file before wiring it up. |
| Spector.js (not installed) | Per-draw-call capture with overdraw. The one thing this harness cannot do; see the open questions at the end. |

Raw output for every run below is in `review/perf/*.json`, and the exact frames
that were measured are `review/perf/{still,motion,drive}-baseline.jpg`.

Quick start:

```bash
node tools/ablate.mjs --mode still --ladder      # where the budget goes
node tools/ablate.mjs --only fx.dof,fx.ssao      # price one change
```

## The configuration that was measured

| | |
|---|---|
| viewport | 1920×1080 CSS at `devicePixelRatio` 2 |
| tier chosen by `pickQuality()` | **`high`** (stepped down from `ultra` for pixel load) |
| drawing buffer | 2592×1458 = **3.78 MP** |
| GPU | Apple M3 Pro (18 core), ANGLE/Metal |
| adaptive resolution | **disabled for the measurement** |

That last line matters. `Engine._adapt` scales the buffer to hold 60 fps and
steps the tier down when it cannot, so any arm left with it on reports the
rescue rather than the cost. Every number below draws exactly the same pixels.

## Headline

| | frame | fps |
|---|---|---|
| parked in a meadow | **35.8 ms** | **27.9** |
| driving | 51 ms median, ranging 34–107 ms | **10–30** |

Parked is stable and reproducible: 90 interleaved baseline blocks ranged
34.5–36.8 ms. Driving is not a single number — it swings by a factor of three
depending on what is in front of the camper.

## It is not the CPU. At all.

```
update    0.75 ms      lateUpdate  0.10 ms      render-submit  31.21 ms
```

Every one of the fourteen systems was switched off individually
(`cpu.<system>`), plus terrain streaming. **Every single one measured within
noise of zero** — grass, ground cover, wildlife, vehicle physics, camp, audio,
HUD, terrain LOD. The 31 ms in "render-submit" is the CPU blocked waiting for
the GPU inside `postfx.render()`.

There is no CPU optimisation available here, because there is no CPU cost to
remove.

## The add-back ladder

Everything off, then handed back one system at a time. Run twice — parked, and
with the camera moving through the world at 14 m/s — and the two agree to a
tenth of a millisecond on every row that matters.

```
arm                          parked      fps    step   |   moving      fps    step
FLOOR (nothing at all)        0.40 ms    2500           |    0.30 ms   3333
+ shadows                     0.60 ms    1667   +0.20   |    0.55 ms   1818   +0.25
+ POST CHAIN                 11.15 ms      90  +10.55   |   11.05 ms     90  +10.50
+ terrain                    16.00 ms    62.5   +4.85   |   15.95 ms   62.7   +4.90
+ grass                      18.15 ms    55.1   +2.15   |   16.95 ms   59.0   +1.00   <- below 60
+ ground cover               19.30 ms    51.8   +1.15   |   18.25 ms   54.8   +1.30
+ everything else            38.7  ms    25.9           |   41.7  ms   24.0
```

**The post chain costs 10.5 ms on a scene containing zero triangles.** Thirty-six
draw calls, nothing in them. That is 63% of the entire 16.7 ms budget for 60 fps,
spent before the world is drawn. It is the largest single item in the frame and
it is fixed cost per pixel — it does not care how simple the scene gets.

Rows past "ground cover" are contaminated: making a system visible again forces
it to re-stream, so the step includes a one-off spike (which is why the row
after often goes negative). Use the leave-one-out table for those.

## Leave-one-out, parked

Each arm is bracketed by its own two baseline measurements, so drift cancels.
`saved` is against the mean of those neighbours.

```
knob                       saved   spread    ms left    fps
fx.flatShade               17.75    ±2.10      17.50     57     <- all fragment shading
px.half                    17.03    ±0.05      19.20     52     <- quarter of the pixels
draw.terrain               13.45    ±0.80      22.35     45
fx.postAll                 10.35    ±0.10      25.25     40     <- whole post chain
px.native                   9.55    ±0.10      26.60     38     <- pixelRatio 1.35 -> 1.0
fx.shadows                  5.80    ±0.00      30.20     33
draw.grass                  4.75    ±0.10      31.25     32
fx.dof                      3.45    ±0.20      31.80     31
fx.ssao                     3.32    ±0.55      32.25     31
fx.shadowMapUpdate          1.72    ±0.15      34.75     29     <- the depth pass alone
draw.clouds                 1.55    ±0.20      33.95     30
draw.groundCover            1.53    ±0.15      34.50     29
draw.vehicle                1.13    ±0.75      34.70     29
fx.bloom                    1.02    ±0.15      34.80     29
fx.shadowRes1k              0.75    ±0.00      35.40     28     <- 3072 -> 1024
fx.smaa                     0.65    ±0.50      34.95     29
draw.water                  0.60    ±0.10      35.15     28
draw.rocks / camp / sky / weather / wildlife / waterfalls   all under 0.5
every cpu.* knob                                            all within noise of 0
draw.trees                 -5.18    ±0.15      41.05     24     <- see below
```

### Trees are worth more than they cost

Hiding the trees makes the frame **5.2 ms slower**. They are cheap to draw and
they occlude the hillside, the grass and the ground cover behind them; remove
them and all of that gets shaded instead. Cutting trees to buy frame rate would
make the game both uglier and slower.

This is the one confound the hide-an-object knobs cannot escape, and it is why
`fx.flatShade` and `px.half` — which change nothing about what is drawn — are
the trustworthy global diagnostics.

## The two things that actually cost the money

### 1. The post chain — 10.5 ms, fixed, per pixel

`fx.postAll` (bypass the composer entirely, `renderer.render` straight to the
default framebuffer) saves 10.35 ms parked, 16–26 ms moving. The ladder puts the
same chain at 10.5 ms with an empty scene, twice.

Priced individually, parked: DOF 3.45, SSAO 3.32, bloom 1.02, SMAA 0.65, grade
0.08 — and roughly 2 ms left over for the composer's HDR targets, the NaN guard
blit and the tone/vignette. They sum to about 10.4, which matches the whole-chain
figure, so nothing is hiding.

Two notes on the tier table in `WorldConfig.js`:

- `POST_TIERS.ultra` and `POST_TIERS.high` are **identical** (`aoSamples: 16`,
  `bloomMip: 12`). The only real difference between the two shipping tiers a
  fast machine will pick is `pixelRatioCap` 1.5 vs 1.35.
- The comment there already says the post chain "was measured at 56-59% of the
  frame". That measurement was taken at `deviceScaleFactor` 1. At the pixel
  count a Retina display actually asks for, it is 29% of a much worse frame —
  i.e. it did not get cheaper, everything else got more expensive alongside it.

### 2. Scene fragment shading — ~18 ms

`fx.flatShade` sets `scene.overrideMaterial` to a flat `MeshBasicMaterial`.
Every draw call still happens, every triangle is still submitted, every
overlapping fragment is still rasterised — **only the shading is gone**, and the
frame drops 17.75 ms of 35.8 (52%).

So half the frame is fragment shaders. What runs in them:

- `MeshStandardMaterial` on essentially everything — terrain, grass, trees,
  rocks, water, the camper.
- The **global `Stylize` patch**, injected into `lights_fragment_begin` /
  `_end` / `common`, so *every* material pays for wrap lighting, banding, the
  golden-hour rim and the shadow-cool term.
- **PCFSoft shadow sampling.** `fx.shadows` saves 5.80 ms, but rendering the
  shadow map (`fx.shadowMapUpdate`) is only 1.72 ms of that, and shrinking the
  map from 3072 to 1024 (`fx.shadowRes1k`) saves 0.75 ms. **The remaining ~4 ms
  is the PCF taps inside every receiving material's fragment shader**, not the
  map. Grass samples it twice — once in `lights_fragment_begin`, and again via
  the explicit `getShadowMask()` in the translucency epilogue in
  `src/shaders/grass_material.js`.
- Terrain's fragment shader alone does 16 texture fetches plus multi-octave
  procedural detail (`src/world/TerrainMaterial.js`).

Grass is *not* the villain the older notes in `Grass.js` suggest — hiding it
saves 4.75 ms parked and 1.9 ms moving. It is expensive per pixel, but it does
not cover enough of the frame to be the headline.

## Resolution is a real lever, and it is already pinned

- Half linear scale (a quarter of the pixels): −17.0 ms → 19.2 ms, 52 fps.
- `pixelRatioCap` 1.35 → 1.0: −9.6 ms → 26.6 ms, 38 fps.

Note that even at 1.0, i.e. `Engine.minEffectivePixelRatio`, the floor the
adaptive scaler refuses to go below, the frame is 26.6 ms. **Adaptive resolution
cannot reach 60 fps here** — it runs out of road at 38 fps and then hands over
to the tier drop.

## Neither can the tier ladder

Measured in one page load by switching `engine.setQuality()` between arms:

| tier | frame (parked) | fps |
|---|---|---|
| `high` (what the player gets) | 36 ms | 28 |
| `medium` | 26.4 ms | 38 |
| `low` | 18.7 ms | 54 |

`low` is 1024 shadows, no SSAO, no DOF, no volumetrics, 30% grass and
`pixelRatioCap` 1.0 — the whole escape hatch, everything the game knows how to
turn off — and it still misses 60. There is no configuration of the existing
presets that hits the target on an M3 Pro at 1080p Retina.

## Driving

Driving is worse and, more importantly, *unstable*: over one sweep the baseline
ranged 33.8 to 106.7 ms. It is not a different bottleneck — the same knobs come
out on top (`fx.flatShade` 36 ms, `fx.postAll` 26 ms, `px.half` 23 ms,
`fx.shadows` 20 ms, `draw.terrain` 14 ms) — it is the same frame with more of
the world visible and more of it changing.

`tools/ablate.mjs --mode motion` exists for this reason: it moves the camera on
a fixed circular path at 14 m/s and phase-resets at the start of every block, so
every arm sees the identical footage while still exercising terrain LOD, grass
tile recycling and ground-cover streaming. Its ladder matches the parked one to
0.1 ms on every clean row, which is the strongest evidence that **motion adds no
new bottleneck** — it just shows you more of the existing one.

## The verdict

> **The biggest performance issue is that the frame is entirely GPU
> fragment-bound, and the post-processing chain is the single largest item in
> it: 10.5 ms per frame at 3.78 MP, 63% of the whole 60 fps budget, before a
> triangle is drawn. The second largest is that every surface in the world is
> shaded with a full `MeshStandardMaterial` plus the global `Stylize` patch plus
> PCF shadow sampling, which costs another ~18 ms.**

Post plus shading is 28 of the 36 ms. Geometry, draw calls, streaming and every
line of JavaScript in the game together account for under 1 ms.

## Caveats

- **Headless Chromium via ANGLE/Metal**, not the browser a player uses.
  Absolute numbers may not transfer; the relative attribution should.
- **GPU timer queries are unusable on this stack.**
  `EXT_disjoint_timer_query_webgl2` reports as available and non-disjoint, and
  then returns four passes summing to **156 ms inside a 36.5 ms frame** — a
  single full-screen blit reads as 21.5 ms. `tools/gputime.mjs` is kept because
  the failure is worth knowing about, but do not trust its numbers, and note
  that `stats-gl` (a dependency of this project that nothing imports) reads the
  same extension.
- **Thermals are real.** After ~90 minutes of continuous measurement the same
  parked baseline drifted from 36 ms to 70 ms. Every number above comes from
  arms bracketed by their own baselines, which cancels it; a run that compares
  an arm against a baseline taken a minute earlier is measuring the clock.
- The POI the camper is parked at depends on `--res`, because the anchor ranking
  reads the heightmap. Compare runs only at the same `--res`.

---

# What I would fix, in order

Everything below is an **estimate**, not a measurement. The ablation numbers say
where the time is; they do not say how much of it a given change recovers. Each
item names how to price it with `tools/ablate.mjs` before building it.

The arithmetic to keep in view: 60 fps is **16.7 ms**. Parked is **36 ms**. So
this needs about **20 ms out of the frame**, not two or three. No single change
below gets there. The first six together might get half of it, and the seventh
is the one that matters.

## The two things NOT to do

**Do not touch any JavaScript.** The entire game's update loop is 0.75 ms of a
36 ms frame. Every system measured at zero. Any time spent making the CPU side
faster is time spent on 2% of the problem.

**Do not cut geometry, draw calls or triangle counts.** `fx.flatShade` keeps all
580 draw calls and all 6.5 M triangles and still drops half the frame, so the
submission and vertex cost is nearly free. Specifically: do not cut trees (they
are worth **−5.2 ms**, they pay for themselves in occlusion), do not shrink the
shadow map (0.75 ms), and do not go after grass first (4.75 ms, and it is the
surface the whole game is about).

## 1. Delete depth of field — 3.5 ms parked, 5–12 ms moving

The largest single post effect, and the one with the least to lose. It is
already dialled down to `bokehScale: 0.60` at `height: 720`; behind a chase
camera on a driving game, almost nobody will notice it is gone. This is one
value in `QUALITY_PRESETS`.

Highest ms-per-unit-of-risk in the whole list. Do it first.

> price it: `--only fx.dof`

## 2. Stop paying for a physical BRDF nothing uses — up to 17.75 ms

**This is the real fix, and it is the one worth the engineering.**

Every material in the game — terrain, grass, ground cover, trees, rocks, water,
the camper — is a `MeshStandardMaterial` with:

- `metalness: 0.0` (all of them)
- `roughness: 0.72`–`0.95`
- and `Stylize` then multiplies direct specular by **`uStyleSpecular = 0.14`**

So every fragment in the frame evaluates the full GGX specular lobe, the
Fresnel term, the multi-scatter energy compensation and the IBL/env path — and
then the result is scaled to 14% and mixed into a deliberately matte,
band-quantised, wrap-lit response that `Stylize` computes separately anyway.
The expensive half of the physical shading model is computed and discarded, on
every one of 3.78 million pixels, several times over because of overdraw.

`fx.flatShade` — which keeps every triangle and every overlapping fragment and
removes only the shading — is **17.75 ms**. That is the hard upper bound on
what any shading change can buy. A minimal material would not recover all of
it (it still has to light the surface), but half of it is 9 ms, which is more
than everything else on this list combined.

Two routes, in increasing order of work and payoff:

- **Re-base on `MeshLambertMaterial`.** It keeps the light loop, the shadow
  plumbing and the same `onBeforeCompile` chunk hooks every material here
  already relies on. The cost is that `Stylize` currently patches
  `RE_Direct_Physical` / `lights_fragment_begin`, so the patch has to move to
  the Lambert/BlinnPhong chunk. That is one file (`src/render/Stylize.js`) plus
  a one-line base-class change in each of the five material factories.
- **Write the material.** Since `Stylize` already *replaces* the direct lighting
  response wholesale, the physical model underneath it is scaffolding. One
  shared `ShaderMaterial` that computes the stylised response directly, with
  the shadow term and nothing else, is the honest end state.

The look risk is lower than it sounds, precisely because `Stylize` exists: the
whole point of that file is that the direct lighting response is already
authored rather than physical. Verify with `tools/shot.mjs` against
`review/` — but the reference plates it is matched to are flat, matte and
nearly cel-shaded, which is exactly what a cheap material produces.

> price the ceiling before you start: `--only fx.flatShade`

## 3. `PCFSoftShadowMap` → `PCFShadowMap` — est. 1.5–2.5 ms

Shadows cost 5.80 ms. Rendering the map is 1.72 ms and the map's size is worth
0.75 ms, so roughly **4 ms is PCF taps inside fragment shaders**. PCFSoft is
~36 texture fetches per receiving fragment against PCF's 9.

The note in `Lighting.js` says softness deliberately does *not* come from
`shadow.radius` — it comes from `shadow.intensity 0.62` and the warm/cool split.
If that is true, PCFSoft's extra blur is not load-bearing and this is close to
free. One line in `Engine.js`.

While you are there: **grass samples the shadow map twice.** Once through
`lights_fragment_begin`, and again through the explicit `getShadowMask()` call
in the translucency epilogue in `src/shaders/grass_material.js`. Cache the first
result. Grass is the highest-overdraw surface in the frame, so it pays that
double cost more often than anything else.

> price it: `--only fx.shadows,fx.shadowMapUpdate` before and after

## 4. Hide the directional light that is switched off — est. 1–2 ms

There are three `DirectionalLight`s in the scene (sun, fill, moon). Three
compiles `NUM_DIR_LIGHTS 3` and loops over all three in every fragment shader
in the game. `Lighting.js` already establishes that the sun and the moon are
never both active — it gates `castShadow` on exactly that — but neither light is
ever set `visible = false`, so both are always in the loop.

Setting `.visible` on the inactive one removes a whole light's BRDF evaluation
from every fragment of every material. The catch is that changing the light
count triggers a full shader recompile, and `Engine.js` already has a scar about
that ("five linkProgram calls costing 62-702 ms"). So do it once, at the day/
night boundary, and warm both variants at boot.

## 5. Delete the NaN guard pass — est. 0.5–1.5 ms

`PostFX.sanity` is a full-screen `ShaderPass` over a 2592×1458 HalfFloat buffer,
running every frame, purely to stop one NaN fragment from poisoning the bloom
mip chain.

The comments in `grass_material.js` show the real fix already happened at the
source (`pow(max(vT, 0.0), ...)`, with the failure traced to a single fragment
at a blade root). If the sources are clamped, the guard is a whole full-screen
read-modify-write of ~45 MB of bandwidth per frame defending against a bug that
no longer exists.

Do not just delete it — `tools/perf.mjs` already counts black frames, so run it
with the guard removed and let it prove the case.

> price it: `--only fx.sanityPass`

## 6. Halve the SSAO denoiser — est. 1–1.5 ms

SSAO is 3.32 ms. The AO itself is already half-res at 16 samples (the note in
`PostFX.js` records the 64 → 16 change, worth p95 −23 ms). What was *not*
revisited is the denoiser: `denoiseIterations: 2` at `denoiseRadius: 12` with
`denoiseSamples: 8`. Two poisson iterations over a half-res buffer is plausibly
as expensive as the AO pass it is cleaning.

With `aoRadius: 1.1` — a contact cue, roughly one blade-height, by its own
comment — one iteration is likely indistinguishable. And if it is not, ask
whether a contact-shading cue that narrow needs a screen-space pass at all when
grass, terrain and ground cover all already fake their own base AO in-material.

> price it: `--only fx.ssao`, with `denoiseIterations` at 2 then 1

## 7. Only then, the pixel count

`pixelRatioCap` 1.35 → 1.0 is **9.6 ms** — bigger than items 1, 3, 4, 5 and 6
combined. I have put it last on purpose.

This project has a firm, well-argued principle that a soft picture reads as a
broken game rather than a fast one, and `Engine.minEffectivePixelRatio = 1.0`
exists to enforce it. Dropping `high`'s cap to 1.0 does not violate that floor —
1.0 *is* the floor — but it does spend the entire remaining margin, and the
adaptive scaler would then have nowhere to go. Right now it has a rung left; use
it as insurance, not as the plan.

Treat this as the number that tells you how much slack you have, not as a fix.

## A budget to hold the result to

Items 1–6 are perhaps 8–11 ms, item 2 is perhaps 9 ms, and they overlap (a
cheaper material makes the shadow taps a smaller share). Somewhere near 16–18 ms
parked is a realistic target, i.e. roughly 60 fps at `high` on this machine.

For that to survive contact with the next feature, the frame needs an explicit
allocation. Suggested:

| | budget |
|---|---|
| post chain, total | **3.0 ms** (from 10.5) |
| scene, total | **12.0 ms** (from 25.3) |
| CPU | 1.0 ms (currently 0.85 — no action needed) |
| slack | 0.7 ms |

`tools/ablate.mjs --ladder` prints exactly these rows, so this is gateable in CI
the same way `tools/perf.mjs` and `tools/dprtest.mjs` already are.

## Two things this investigation did not answer

- **p95 is 74 ms while p50 is 36 ms**, parked, with nothing moving. That is a
  separate problem from the one above — a steady-state 36 ms frame does not
  explain a doubling at the 95th percentile. `tools/perf.mjs` already counts
  hitches; something is spiking on a stationary camera and it is worth finding.
- **Overdraw, quantitatively.** `fx.flatShade` proves the frame is
  fragment-bound but not how many times each pixel is shaded. Spector.js is the
  tool for that, and it is the one thing this harness cannot do. If the answer
  turns out to be "grass and ground cover shade every pixel four times", a
  depth prepass becomes interesting — and if it is closer to 1.5x, it does not.

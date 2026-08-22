# Round 2 — what the critics rejected, and the contract between authors

Three critics ran against `shots/r2/`. **All three returned NOT APPROVED.**
Their full reports are in the scratchpad as `critic-{look,shore,motion}-findings.md`
and you must read the one for your area before touching anything.

Read `docs/WATER_SMOOTH_ROUND.md` for the brief, `docs/WATER_SMOOTH_STATE.md`
for what round 1 landed and why, and `docs/WATER_CRITIC_ROUND.md` for the
instruments — **especially its table of ten instruments that were confidently
wrong**, every one of which produced a clean number a reasonable person would
have acted on.

## File ownership — do not edit a file you do not own

| author | owns |
|---|---|
| **EDGE** | `src/shaders/water_surface.js` |
| **TERRA** | `src/world/TerrainMaterial.js`, `src/world/Terrain.js` |
| **SPEED** | `src/shaders/water_common.js`, `src/world/Water.js`, `src/world/hydroField.js`, `src/world/WorldData.js` |
| **ENGINE** | `src/core/Engine.js` |
| integrator | `tools/`, `docs/`, everything else |

## The one cross-file contract: the damp margin moves to the terrain

This is the fix for the round's most serious defect and it needs two authors to
land it together.

**The defect.** `alpha = max(alpha, wetT * 0.80)` makes the damp margin the
outer boundary of the water layer, so the water's SILHOUETTE is whatever that
band is doing — and the band is rationed by `dist`, `foot` and `aaPix`, all
functions of the camera. Measured with the engine's clock frozen: translating
the camera 5 m swings 6-25% of the waterline's world-space cells by more than
30% of coverage, a third to two thirds of them REVERSING, while a rotation of
the same pixel magnitude produces ~0.

**Two fixes were tried by the integrator and both regressed. Do not repeat
them** — the reasoning is recorded in the source at the `wetT` declaration.
Holding the alpha geometric while withdrawing the colour paints a 0.9 m water
halo; converging the colour on the bank does not composite to nothing, because
lit gold over the bank is not the bank.

**The contract:**

- **EDGE deletes the damp margin from the water shader.** No `wetT`, no
  `alpha = max(alpha, wetT * 0.80)` (it appears twice), no damp colour mix. The
  water's alpha ends at the waterline: `shoreFade` and the foam terms only.
  The tide line and the lace are on the WET side and stay.
- **TERRA draws it instead**, from the same hydro field the water reads, so the
  two cannot disagree. The terrain is opaque, so a margin drawn there has no
  silhouette to move and the whole class of defect goes away.

  Spec, from `docs/WATER_ART_SPEC.md` 3.1/3.5 and the look critic's measurements:
  0.9 m of ground on the dry side, gated on `hydro.g` (signed metres, negative
  outside) and on height via `hydro.r` as `TerrainMaterial` already does;
  **0.85 stops below the bank** (we are currently at 0.43-0.52 — half the
  plate); hue held at the bank's own, chroma at or above 0.217; outer edge
  broken by a noise so it is a ragged tide mark and not a second parallel line.

## What each author owns, ranked by the critics

### EDGE — `water_surface.js`
1. **The waterline is a POLYGON.** The hydro field is 4 m and read with hardware
   bilinear, which is C0. Validated fixture: an analytic circle of radius 8 m,
   true curvature 0.125 rad/m, through this lattice reads p50 0.036 / max 0.336
   — the filter alone flattens 3x and spikes corners 2.7x. The real shoreline is
   90% straight at radius 34 m with corners at radius 1.3 m.
   **Smoothed bilinear was tried and is WRONG for this field** — an SDF is
   locally linear and bilinear is exact on it along the axes, so warping the
   coordinate adds curvature to straight runs (hero 10.8 -> 16.3). Use a
   **bicubic B-spline through four bilinear taps**: it approximates rather than
   interpolates, rounding corners without bending straight runs. Gate on the
   circle fixture.
2. Delete the damp margin (see the contract above).
3. **No bright mass anywhere on the water.** Brightest mass is 0.42 stops BELOW
   the meadow; plate 3 has p98 at +1.20 and its lace peak at +1.72. The lace's
   core never reaches full opacity — the profile is flat-topped and that flat
   top sits at `laceFloor` 0.58. `uFoamGain` is **not** shared (verified:
   `Water.js:305` and `Waterfalls.js:982` construct separate ones) and is not
   the ceiling — `foamCol` is already at Y ~0.58 against a 0.616 target. The
   pack-ice experiment that failed was run BEFORE the coverage field was halved;
   the critic measures coverage now at 50/50, inside the guard, and says do not
   ration it further. Warm the hue: ours `#9b94a1` mauve-grey, plate `#e2c7d3`.
4. **The water does not flow.** 98% of what you see is frozen; measured
   advection is 0.02-0.05 of what the flow field predicts. Cause: the swell's
   offsets are `eA = max(3.4, foot * 1.6)` so the perturbation is divided out as
   the footprint grows, and the near-chop is behind `near = 1 - smoothstep(3, 34, dist)`.
   **Past ~35 m nothing that moves survives.** The baked flow field is clean
   (0.16% of adjacent wet pairs differ by >90 degrees) — it is the shading.
5. **Shelf banding.** `deepT`'s two perturbations are +/-1.7 m and +/-0.95 m in
   absolute metres against a 0..3.2 m window; on a 0.7 m lake they swamp the
   bathymetry 7:1, so the quantiser draws the bar field with the lake floor as a
   rounding error. Measured signature: flat plateau, +0.97 stops over 45 px,
   flat plateau — and that single step is the frame's third value mass. Scale
   both amplitudes by the water actually present.
6. **The sun path is deleted at grazing incidence.** `sharp = exp(-foot * 8.0)`
   is under a thousandth at 20 m and arithmetically zero past 40 m from an eye
   2.2 m up, so the sharp lobe is gone over the whole 50-500 m band where a sun
   path lives, and the broad lobe never receives the energy. Migrate it.

### TERRA — `TerrainMaterial.js`, `Terrain.js`  ✅ LANDED

1. Take the damp margin (see the contract).
2. **The terrain mesh LOD-morphs under the camera and the water no longer
   follows.** Per-cell height drift under a 5 m dolly: p90 0.08 m at
   mouth/river/plunge, 0.35 m at hero, **0.47 m at drive**. Static camera:
   exactly 0. The waterline is now cut from an LOD-independent texture, so the
   bank rises and falls through a fixed water surface as you drive. Round 1
   fixed this class for SHADING; the GEOMETRY still has it.

### SPEED — `water_common.js`, `Water.js`, `hydroField.js`, `WorldData.js`  ✅ LANDED

1. **`wHash22` is still `fract(sin(p) * 43758.5453123)`.** The current fragment
   main holds **31 `wFbm2`** on a near fragment — 496 `sin()` — against round 1's
   baseline count of 27/432. **The noise ALU went UP.** rest-of-fragment is
   74-82% of all water cost.
2. `mouth` is **4.28 ms** against a target of under 3. There is no much-worse
   place: a search over the eight largest chunks x eight bearings tops out at
   56.7% coverage and 4.89 ms.
3. The reflection march's hard loop bound is 16 while `uReflectSteps` is still
   24, so the uniform overstates the work; measured cost is flat above 8 steps.
   `wSunShadow` still runs its 12 steps ungated.
4. If EDGE needs the hydro field at the bake's own 2 m for the reconstruction,
   that is yours to provide — but measure it, it quadruples the memory and only
   halves the polygon's scale.

### ENGINE — `Engine.js`  ✅ LANDED

**The quality fallback is unreachable on EVERY device.** At DPR 1 `rungs`
collapses to `[1]`, both ladder branches fail, and `_adapt` hits `else return`
at line 168 — `_strainSince` is never even set. At DPR 2 the resolution ladder
works, then `i === rungs.length - 1`, both branches fail again, and it returns
at line 168 **before** the strain block at line 176. `_stepQualityDown` can
never fire. Driven with a real 250 ms/frame history, quality stayed `ultra` for
six rounds past the floor. Whole scene is currently p50 24.3 ms against a
16.7 ms budget with no relief available.

## How you are judged

```bash
export AUTUMN_URL=http://localhost:5182     # do NOT start another server
node tools/lint.mjs && node tools/health.mjs                 # shaderFailures MUST be 0
node tools/shot.mjs --views river,mouth,waterfall,plunge,hero --dir shots/<you>-bare \
     --hide Trees,Grass,GroundCover,Weather,Waterfalls --waterdiff --w 1600 --h 900
node tools/wedge.mjs shots/<you>-bare/*.png --zoom shots/wedge/<you>
node tools/waterlab.mjs --tag <you> && node tools/waterlab.mjs --compare base1 <you>
```

Current state, which is what you must not regress:

    frame       fine   stair  crenel  aaPx
    mouth        5.8    2.7   1.029   2.38
    plunge       6.4    2.5   1.022   4.07
    river        8.9    3.9   1.039   3.13
    waterfall    8.9    4.2   1.031   5.67
    hero        10.9    5.3   1.047   4.04

**Never quote a `wedge` number without opening its `--zoom`.** Ten instruments
in this project have now been confidently wrong; the table is in
`docs/WATER_CRITIC_ROUND.md` and it is the most valuable thing the last round
produced. If you build an instrument, feed it an input whose answer you know
before you trust it — two of those ten were caught only that way, and one was a
bug in the test fixture rather than in the tool.

**Never put a backtick inside a GLSL template literal.** It has taken the build
down four times in this round alone. `node tools/lint.mjs` catches it in 1 s.

Do not commit. Do not run `git checkout`/`stash`/`restore`.


## Landed

### ENGINE ✅

`_stepQualityDown` is reachable. The `else return` that sat ahead of the strain
block is gone; strain is now evaluated before any early return.

| | before | after |
|---|---|---|
| DPR 1 | `rungs` collapses to `[1]`, both branches fail, `_strainSince` **never set** | ultra → high (round 2) → medium (round 5) |
| DPR 2 | ladder 1 → 0.85 → 0.72 → 0.667, then quality frozen at ultra for six rounds | ladder identical, then ultra → high |

Two judgements worth keeping:

- **`rungs` was left alone at DPR 1.** Making it meaningful there means rendering
  below native, which `minEffectivePixelRatio = 1.0` exists to forbid — the
  source records a player calling 0.825 effective "very blurry / fuzzy looking,
  even on ultra". At native the tier is correctly the FIRST lever, not the last.
- **`autoQuality` now also requires `!navigator.webdriver`.** Before this round
  captures were immune to tier changes *by accident* — the DPR-1 collapse. Fixing
  the ordering removes the accident, and without a replacement the first slow
  capture would have demoted mid-plate and silently invalidated three authors'
  baselines. Verified live: under this project's Playwright launch,
  `webdriver: true`, `autoQuality: false`, quality `ultra`, `resolutionScale` 1,
  `uReflectSteps` 24.

Hysteresis set from evidence rather than taste: `strainRatio` 1.75 (29 ms, 34 fps
— just above the 32 fps window the feature was written for) over a 10 s hold
against a 6 s cooldown, so **three consecutive** over-budget windows are needed
and one streaming stretch or shader compile cannot demote anything. Silent up to
36 fps sustained; fires at 31 ms; never fires on a bursty 250/250/12 pattern.


### SPEED ✅ — target met

`mouth` **4.28 → 2.50 ms** at the same 52% coverage, against a bar of under 3.
Per-fragment `sin()` **480 → 0**. Fetches unchanged at 35. The searched
adversarial framing (56.6% coverage) is **3.18 ms — still 6% over**, named
rather than hidden.

One change did nearly all of it: `wHash22` stopped being `fract(sin(...))`.

**The method is the part worth keeping.** A hash change re-rolls every noise
value in the frame, so a single before/after of the shape metrics is
unreadable — `mouth` `fine` swings **1.7 points** on the same shader with only a
different magic constant. So the author measured the metric's own field-to-field
spread first: four seeds of the old hash and four of the new, all eight captured
in one page load off one frozen clock. **All 25 comparisons shifted by less than
the spread between seeds of either family.** That is how you establish "no
regression" for a change that touches every pixel.

The hash was also chosen on field statistics rather than op count, and the
instrument that chose it was itself validated against a constant hash, a known
weak hash, and a deliberately broken candidate whose two components were
algebraically identical — which the whole-grid correlation **missed** and a
diagonal-band test caught. The author added that test because they had designed
the broken candidate.

Rejected with numbers, so nobody repeats them: band-limiting the second octave
on `fwidth` is 4.6% **slower**; a cheaper bed texture for the marches buys under
1% (the 28 filtered fetches cost 0.405 ms and the FORMAT is 8% of that); 24 → 8
reflection steps buys 0.08 ms and withdraws every crossing past 117 m.

### TERRA ✅ — and one constant changed by the integrator

The damp margin is drawn by the terrain now, cut on the same hydro field the
water reads, calibrated to **0.90 stops** against the plate's 0.85 (before:
0.21-0.40).

**A finding worth carrying past this round: the filmic toe EXPANDS shadow
contrast.** The instinct is that ambient and aerial perspective add an unscaled
term, so albedo must be darkened harder than the frame target. It is the other
way round — 0.943 albedo stops came back as 1.05-1.22 frame stops. A constant
derived by arithmetic would have shipped 40% too dark.

**`WATERLINE_PIN_RADIUS` 380 → 200 (integrator).** The LOD pin was landed
honestly as untargeted: 92.7% of chunks carry a waterline, so at 96 m
granularity 380 m is in practice "LOD 0 out to 380 m", and it cost **+21.6%
triangles** while the scene was already 45% over its frame budget. Its own ring
budget says a smaller radius is *better*: pinning to 380 removes the near ring
but makes the 380 m ring worse (the step there becomes 0→2 instead of 1→2),
3.02 → 2.36; pinning to 200 gives 2.21. Measured at 200: **+1.2% triangles**
instead of +21.6%, an 18x cost reduction, on a better number.


## Round-2 verdicts

### CRITIC-MOTION — NOT APPROVED, fix-first: the water does not advect

Four of its five findings confirmed fixed, independently reproduced:

| finding | status |
|---|---|
| waterline follows the camera | **fixed at the named cause** — real shader now reads BELOW the instrument's own floor (`mouth` 6.4 vs 14.0, `river` 6.7 vs 11.0) |
| quality ladder unreachable | **fixed** — verified at seven load levels, both DPRs |
| `mouth` 4.28 ms vs a 3 ms target | **2.505 ms**, reproduced to three decimals; adversarial worst case 3.190 |
| `wcrawl` harness inflating everything | **fixed** — `drift` 16-37% of band -> under 1% |

**The critic corrected its own round-1 report**, which is the most valuable
thing in it. It built a camera-independent water alpha — same geometry, depth
state and blending, alpha a fixed +/-0.25 m world ramp with no camera term
anywhere, so it physically cannot move — and its own instrument reports
**bigflip 2.8-15.6%** for it. A fixed-width world ramp is under-filtered at
range and aliases, and binning a moving pixel grid in world space registers that
as coverage swings. So its round-1 magnitudes were overstated and the
`pan ~ 0 / translate = large` signature is partly a property of the measurement.
Its words: *"Without this control I would have reported a false regression this
round."* The round-1 FINDING still stands — it never rested on the number alone —
but the size of it was wrong.

Residuals it names: `threadNear` is the one site materially over the floor
(23.8 vs 9.0), and **73% of this map's waterline texels have span under 2 m**, so
narrow thread is where the remaining instability lives. `hero`'s crawl 2.4 -> 3.3
is explicitly NOT to be acted on: 13 large-amplitude cells in the whole frame,
sub-visible dithering at the half-coverage line.

Flow, its fix-first item: direction is now correct on most patches (angle p50
99deg -> 31deg) but the surface travels at **8% of the speed its own flow field
prescribes** and 95-97% of visible structure is static over a second of play.

### Integrator follow-ups from that verdict

- `tools/shot.mjs` now pins `autoQuality` and `adaptive` and sets
  `resolutionScale = 1`, and prints `quality` and `resScale` on **every** run
  with a loud warning if either is off. The critic found that `autoQuality` is
  gated on `!navigator.webdriver` but `adaptive` is not, so at dpr 2 a slow
  capture silently walked resolution to **0.72** mid-run — measured. At dpr 1 the
  rung collapse hid it, which is the old bug now acting as the protection.
- A FLOW author is on the advection with the critic's own lead: `wFlowPhase`'s
  8 m cycle against a map whose median flow speed is 0 and p90 is 1.47 m/s, so
  most water never completes a cycle and the two-copy cross-fade spends its time
  dissolving rather than travelling.

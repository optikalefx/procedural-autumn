# Critic protocol — the smooth-water round

Read `docs/CRITIC_PROTOCOL.md` first. This adds to it; it does not replace it.
In particular read its table of **instruments that are confidently wrong**, then
read the section below, which adds three more entries to that table from this
round.

## Your standard

A shipping first-party console title. The user's words are the spec:

> great looking water, not jagged, flowing smoothly, good shore lines, over top
> of terrain.

"Better than the baseline" is not a verdict. `SHIP` / `CLOSE` / `REJECT`, per
view, with named defects ranked by how much they hurt the frame.

**You are the gate. Do not be encouraging.** A round that ships with a defect
you softened your language about is a round you failed at, not the author.

## Round 3 — what changed since the second set of NOT APPROVED verdicts

Judge `shots/r9/` (look) and `shots/r9-bare/` + `shots/r9-crawl/` (measurement).

| your finding | what was done |
|---|---|
| **LOOK: the lace is a white pipe** (4.24 st over 8 px, unbroken 350 px) | Rebuilt to the plate's band structure. Peak **0.849 -> 0.616**, the plate's own value; local contrast **4.24 st over 8 px -> 2.83 over 19 px**; the shallow rim, inner pale band and body ramp now exist where they were absent. The ceiling is in units of the foam illuminant, not an absolute, so it tracks the key: at dawn the lace was **+1.53 st over the frame's p99** and is now **+0.13**. |
| **LOOK: damp band overshoots 2x** | **Rejected on an attribution probe.** Band OFF reads 1.72 st, ON 2.50, baseline 2.46, plate 1.19. The band contributes **0.78 st**; the bank's own falloff is 1.72, already above the plate's whole transition. The round made that profile monotone, not darker. Filed to ground shading. |
| **SHORE: terrain and water reconstruct the field differently** | **Fixed.** `TerrainMaterial` now uses the identical 4-tap B-spline. Both carry the same softening constant, because only one of them carrying it would reinstate the defect immediately. |
| **SHORE: the ghost loop on bare cliff** | **Not the water.** Three probes: matched reconstruction, `bandGate = 0`, `river = 0` — the loop is byte-identical in all three. It is terrain shading, matching this project's historical contour-ribbon defect. Filed. |
| **SHORE: the B-spline severs 136 channels** | **Fixed at your measured setting.** k = 0.5: severances 136 -> 72, deletions 135 -> 38, circle fixture still passing. |
| **SHORE: the unantialiased 0.24 st step** | **Localised, three hypotheses eliminated, NOT fixed.** Removing the near-miss branch halves it (0.246 -> 0.106); repairing its range two different ways and making its ramp screen-relative all moved nothing. Written up at the site with the probe table. |
| **MOTION: the water does not advect** | **Fixed at the cause.** The cross-fade had algebraically **zero net travel** — it collapses to a constant, 4.0000 m at all eight steps of a cycle. Flow-angle error p50 **114 -> 12 deg**, uncorrelated tail 55% -> 27%, measured/prescribed speed **0.39 -> 0.83**. |

## Round 2 — what changed since the three NOT APPROVED verdicts

You are re-judging. Read your own round-1 report first (in the scratchpad as
`critic-{look,shore,motion}-findings.md`), then `docs/WATER_ROUND2.md` for what
each author did about it, then judge the current build on its own merits.

Landed since your verdict:

| your finding | what was done |
|---|---|
| The waterline follows the camera (motion #1) | The damp margin was the water's outer boundary and was rationed by camera distance. It has been **removed from the water shader entirely** and is now drawn by `TerrainMaterial`, which is opaque and so has no silhouette to move. Two lesser fixes were tried first and both regressed hard; the record is in `water_surface.js` at the old `wetT` site. |
| The damp band is half as dark as the plate (look #3) | Recalibrated to **0.90 stops** against the plate's 0.85; was 0.21-0.40. |
| The waterline is a polygon (shore #1) | EDGE's item. Judge it. |
| No bright mass on the water (look #1) | EDGE's item. Judge it. |
| The water does not flow (motion #2) | EDGE's item. Judge it. |
| `mouth` costs 4.28 ms against a 3 ms target (motion #7) | **2.50 ms.** `sin()` per fragment 480 -> 0. The adversarial worst case is 3.18 ms, still 6% over. |
| The quality ladder can never fire (motion #3) | Reachable on both DPRs. Fires at 32 fps sustained, silent to 36, needs three consecutive over-budget windows, and is disabled under automation so it cannot demote mid-capture. |
| Terrain LOD-morphs while the water does not follow (motion #6) | Chunks carrying a waterline are pinned to LOD 0 inside **200 m** (+1.2% triangles). The far rings are NOT fixed — that needs the field band-limited in `WorldData.getHeight`, and it is filed. |

**Two of your own measurements have been corrected, and both change a verdict:**

1. **`wcrawl` was inflating every number 2-3x** by differencing a whole moving
   sequence against one frozen reference frame. Every frame now gets its own.
   Re-measured, the pristine baseline reads `mouth` 1.0% / `river` **6.3%** /
   `hero` 2.4%. So `river` **fails the crawl gate on the baseline**: crawl there
   is a pre-existing defect of this project, not something a water round caused.
   The 13.4% in the motion report was the harness.
2. **`wedge`'s `hole%` does not measure occluder silhouettes** — `--hide Rocks`
   moves it by 0.3-1.4 points. It measures **pinholes in the water**, and it is
   therefore a result: baseline `river` 33.6% against 7.5% now. A third of the
   baseline "shoreline" was the perimeter of holes in shattered water.

And `tools/health.mjs` was blind to an entire material — a terrain shader that
failed to link returned `shaderFailures: 0`. It now asks the renderer for every
program with `diagnostics.runnable === false`, and is verified against a
deliberate break.

## The baseline you are comparing against

Two sets, and they are for different things.

**`shots/w0-base/`** — river, mouth, waterfall, backwater, hero, full scene,
captured before this round started. This is the LOOK baseline. Judge colour,
value, lace and slab against it, and A/B against it with `ab.mjs`.

**`shots/w0-bare-ref/`** — the same framings from a pristine worktree at HEAD,
served on port 5184, captured with `--hide Trees,Grass,GroundCover,Weather
--waterdiff`. This is the MEASUREMENT baseline, and it is the one the numbers
below come from. It exists as a separate tree because the authors had already
started editing before it could be taken, and an A/B against a moving baseline
measures nothing.

| frame | fine | stair | crenel | aaPx | lenPx | rejected specks |
|---|---|---|---|---|---|---|
| river | 12.2% | 5.9% | 1.071 | 7.36 | 7763 | 190 |
| mouth | 23.4% | 19.9% | 1.144 | **64.0** | 5951 | 410 |
| waterfall | 13.0% | 8.0% | 1.069 | 11.98 | 8815 | 102 |
| plunge | 12.8% | 8.0% | 1.075 | 9.88 | 9733 | 120 |
| hero | 26.7% | 21.2% | 1.164 | 5.03 | 10344 | 586 |

Read `mouth`'s `aaPx`. **An edge sixty-four pixels wide is not a soft edge, it
is a slab with no edge at all** — which is exactly what the pale grey-mauve band
across that frame's foreground is, arriving as a number.

The `rejected specks` column is the count of connected components dropped for
being under 2% of the largest surviving one. It is not a metric with a target;
it is context, and a large number means the frame's other columns describe only
the fragments that survived.

**This table has been re-measured five times, as five separate defects in the
measurement were found and fixed.** Every earlier version of it was wrong, in
five different directions, and all five are written up in the instrument table
below. The last one is the one to read first: the water frame and the
water-hidden frame used to be captured a few hundred milliseconds apart with the
engine running, so they differed by the water **and by every other animated
thing in the scene** — and the drifting clouds made the whole sky one enormous
connected component which, on `river`, touched the water and merged with it. The
engine's clock is now stopped and both frames are rendered at the same instant
with `dt = 0`, so the difference between them **is** the water, exactly. Sky
components rejected went from 3–9 per frame to **zero on every frame**, and
spurious small components fell 5–20×.

If you find a sixth, fix it, re-measure **both** sides, and add a row — that
table is the most valuable thing this round produces.

**Holes in the water**, `wedge`'s `hole%` column — the share of contour that
encloses dry ground rather than bank. This is speckle, measured in the rendered
frame: baseline `river` **33.6%**, `waterfall` 24.6%, `plunge` 22.4%, `hero`
16.9%, `mouth` 16.9%. The current build reads 3.0-7.8%. Note for anyone reading
the critic reports: the column was introduced on the hypothesis that it measured
occluder silhouettes, and that is not what it finds here — `--hide Rocks` moves
it by 0.3-1.4 points.

**The offline field**, `shots/waterlab/base1/metrics.json`: `fine` 22–53%,
`speck` 155–1237/km², `grad10` 0.12–0.14, `bedTan` 0.04–0.13 m.

Use **`base1`**, not `base`. `base` was captured before BED added the `bedTan`
metric and before the contour chaining changed, so its `lenM` and `fine` are not
comparable with a current run; `base1` is a byte-comparable baseline rebuilt
with the current tool against a stubbed pipeline. `--compare base now` still
runs and prints `-` for a metric a run does not have.

`bedTan` is BED's addition and it is the honest bank-roughness number.
`bedRms` — the metric the round's targets were written against — **cannot reach
its target as defined, and is not the driver**: its 8 m box blur cannot
represent a channel cross-section, so a channel narrower than that box *is* most
of the number. Measured on `talus` at res 512: `bedRms` 0.526 splits into 0.456
outside the river mask and 0.751 inside, against 0.411 for the raw terrain over
the same cells. A pass that took the terrain residual in the shore band from
0.53 m to 0.088 m left `bedRms` exactly where it found it. **Do not gate on
`bedRms`.** `bedTan` samples 3 m out on the dry side and smooths along 8 m of
arc, which measures bank roughness without the cross-section in it.

**Temporal**, `shots/w0-crawl-ref/`, six frames of a static camera:

| frame | flip% | ratio | crawl% | drift |
|---|---|---|---|---|
| mouth | 1.0 | 1.17 | 1.39 | −381 |
| river | **6.3** | 5.57 | 8.47 | −959 |
| hero | 2.4 | 2.23 | 1.63 | −46 |

Re-measured with per-frame pairing after the harness bug below was fixed; the
earlier rows (mouth 3.0, hero 2.3) were inflated 2–3× and are withdrawn. `drift`
is near zero on all three, which is what makes these quotable — the tool's own
header says to read `drift` first and the old sequences never had a clean one.

**Note what `river` says: the baseline itself fails the 1.5% gate at 6.3%.**
Waterline crawl on that framing is a pre-existing defect, not something this
round introduced. The round measures 4.7% there, i.e. a 25% improvement that
still does not clear the bar. A critic should rank it as "not fixed" rather than
"regressed", and the motion critic's 13.4% for it was the inflated harness.

**Trust `flip`.** It counts band pixels that cross the 0.5 coverage mark at
least once — a pixel going from mostly-water to mostly-land and back, which is
what reads as crawl. `crawl` and `ratio` also contain the shoreline foam
animating, which is supposed to happen, so read them as an upper bound. Hiding
the clouds removes one confound (a cloud crossing a lake changes its reflected
colour over the whole body) but not that one. Three percent of the waterline
blinking is a defect no still frame in this project's history could have shown.

## The four instruments

```bash
export AUTUMN_URL=http://localhost:5182     # this worktree's server. Do NOT start another.

# 1. the field, offline, ~2 s for nine hostile terrains
node tools/waterlab.mjs --tag <round>
node tools/waterlab.mjs --compare base <round>

# 2. the waterline in the rendered frame, in pixels, no browser
node tools/shot.mjs --views river,mouth,waterfall,plunge,hero --dir shots/<round>-bare \
     --hide Trees,Grass,GroundCover,Weather,Waterfalls --waterdiff --w 1600 --h 900
node tools/wedge.mjs shots/<round>-bare/river.png shots/<round>-bare/mouth.png \
     shots/<round>-bare/waterfall.png shots/<round>-bare/plunge.png \
     shots/<round>-bare/hero.png --zoom shots/wedge/<round>

# 3. does the waterline HOLD STILL — the half of the brief a still frame cannot show
node tools/shot.mjs --views mouth,hero --dir shots/<round>-crawl \
     --hide Trees,Grass,GroundCover,Weather,Clouds --waterdiff --frames 5 --w 1600 --h 900
node tools/wcrawl.mjs shots/<round>-crawl/mouth.png shots/<round>-crawl/hero.png

# 4. the look, against the art spec
node tools/shot.mjs --views river,mouth,waterfall,plunge,backwater,hero --dir shots/<round> --w 1600 --h 900
node tools/waterstats.mjs shots/<round>/mouth.png
node tools/ab.mjs --a shots/w0-base --b shots/<round> --out shots/ab-<round> --stitch
```

**`plunge` is new this round.** `waterfall` sits at 11 m and 58 m out, and when
the channels moved the vegetation moved with them (moisture is derived from
distance-to-water), so a red maple now stands between that camera and the fall
and the frame is 70% leaves. `plunge` is the same anchor from 34 m up and 96 m
out, looking down into the pool — which is where this round's worst defect
lived, and it should not be at the mercy of one tree. Judge `waterfall` too; it
is what a player standing there sees.

`--hide` is for measurement only. **Never judge the LOOK of a frame captured
with `--hide`** — it is a scene with the vegetation deleted.

## Instruments that are confidently wrong — thirteen more, all from this round

| what it reported | what was actually true |
|---|---|
| `wedge.mjs` on `shots/w0-base/river.png`: waterline `stair` 18.2%, `aaPx` 0.90 — hard aliasing on the shoreline | The `river` framing looks *through* a birch stand. Most of the boundary the colour mask found was canopy and trunk silhouette against water — an alpha-tested edge, correctly hard. Almost none of it was a waterline. This is why `--hide` exists, and why every `wedge` run must be checked against its own `--zoom` image before a number from it is quoted. |
| The same tool on `waterfall.png`, with the vegetation hidden: `fine` 12.3%, "the shoreline is nearly acceptable" | The `--zoom` image showed the contour lying across the **cliff face**. §0's mask rule is `B_srgb − R_srgb >= 0.02`, and pale cool grey rock passes it exactly as water does. There is no threshold that separates them, because they are the same colour. This is why `--waterdiff` exists: capture the pose twice, once with the Water group hidden, and the difference between the two IS the water, at exactly the alpha it was composited with. With the honest mask that frame measures `fine` **51.3%** — four times worse than the number that would have been quoted. |
| `wedge.mjs` on the mid-round `waterfall` capture: mask **0.00%** of frame, 3 344 components rejected, every column zero — "the water is gone" | The frame visibly contains a plunge pool, a river and a lake. Time advances between the water frame and the water-hidden one and the **clouds advect**, so the difference between them contains the whole sky as one enormous component. It touches row 0 and was correctly dropped as sky — but the size floor for every other component was computed as 2% of *the largest component overall*, i.e. 2% of the sky, which every real body of water then failed. The floor now comes from the largest component that survives the sky rejection. A harness that reports nothing when there is something is worse than one that reports a wrong number, because there is no number to disbelieve. |
| `wedge.mjs`: `mouth` `stair` **25%** — "a quarter of that shoreline is a pixel staircase" | `stair` was defined as excess contour-direction mass at the four lattice angles. A distant lake shore seen from a level camera **is** a horizontal line, so the metric was scoring the perspective, not the aliasing — and it scored it worst on the frame with the *best* shoreline in the set. It is now defined as the % of length whose local direction disagrees with its own 4 px-smoothed curve by over 20 degrees: a straight line at any angle scores zero, a staircase scores near one because its segments run at 0 and 90 while the curve they belong to runs at 45. Re-measured, `mouth` went 30.1% → 2.5% across the round, where the old form had reported 14.7% → 25% — the opposite sign. |
| `wedge.mjs`: `aaPx` fell from 5.80 to 0.86 across the round on `mouth` — "we have replaced a soft edge with a hard, one-pixel, aliased one, and screen-space antialiasing is now the highest-value work left" | Every word of that was an artifact. `aaPx` walked the contour normal until the field left a ±0.02 band around the mask **threshold** — a 4% slice of a range running to 1.0, so for a ramp W pixels wide it returned about 0.08·W and could not separate a 1 px edge from a 2 px one at all. Two more attempts failed the same synthetic check (a horizontal edge of known 15–85% width: one returned 1.79/1.50/4.88/1.63 for widths 1/2/4/8; the next counted whole pixels and read W−1 with a floor at 1). The fourth reads the field's gradient at **half** coverage and validates at 1.40/1.95/3.68/7.35 — within 8% above 2 px, floor 1.4. Re-measured, `mouth` went **64.0 → 2.11**: not soft-to-hard, but *slab-to-edge*, landing inside the target band. **The fixture had to be debugged before the tool could be**: its first version put the water on the wrong side of the edge, so the strip clamped dry to keep the body off row 0 became a second hard contour that doubled the length and halved every width reported. |
| `wedge.mjs` on `plunge`: `fine` 16.5%, `stair` 11.3% — "the shoreline at the plunge pool is still badly jagged" | The `--zoom` showed the contour running **down the waterfall curtain**, not along any shoreline. `--waterdiff` hides only the `Water` group, so any other system that ANIMATES shows up in the difference and is counted as water — and the falls' curtain is a field of high-frequency whitewater streaks that advects between the two captures. The shorelines in that frame are clean. `Waterfalls` now goes in the `--hide` list; the falls are a separate system and are judged separately. |
| `wedge.mjs` on `river`: mask **0.38%** of frame, 621 small components rejected, `fine` 17.7% — "there is almost no water in this framing and what there is, is rough" | The frame has a river across the middle of it. `--waterdiff` hid the `Water` group but left the engine running, so the pair was captured a few hundred milliseconds apart and differed by **everything that animates**. The clouds drift, so the whole sky was a difference; it formed a single 210 383 px component, it touched the water, they merged, the merged component touched row 0, and it was correctly rejected as sky — taking the river with it. Hiding the clouds fixes that one confound and not the class. The engine's clock is now **stopped** and both frames are rendered at the same instant with `dt = 0`, so no updater runs and clouds, leaves, ripples and sun are bit-identical. Same framing, re-measured: mask **13.77%**, small components **76**, `fine` **10.2%**, and zero sky components rejected. |
| `waterstats.mjs` item 8 (lace peak luminance) on `river`: **PASS, peak Y 0.62** — "the lace is there and it is at the plate's brightness" | It is a **birch trunk**. The detector takes the brightest 5x5 within 60 px of the waterline at C <= 0.30, and white bark at a waterline satisfies that exactly. Single-pixel profiles at rows 560/600/640/680 peak at x = 1339/1337/1334/1333 — a near-vertical feature spanning 120+ rows at `#d0cab5`, against a shoreline running diagonally. `--box` does not help; the trunk is inside any box that contains the reach. The same item's *disproof* elsewhere was also wrong for a related reason: "raising the lace opacity floor 0.72 -> 0.88 moved peak Y by 0.001" was read through the same 5x5 box, and `mouth`'s lace is 2-6 px wide at >=80% of peak — a 5x5 box over a 2 px line is majority water at any opacity, so that experiment measured the lace's WIDTH, not its opacity. |
| `wcrawl.mjs`: `mouth` flip 1.2%, `river` flip 13.4% — "the waterline blinks on a tenth of the river" | Inflated by the harness. `shot.mjs --waterdiff --frames N` captured frame 0 and its water-hidden twin as an exact frozen pair, then captured `t1..t5` with the engine **running** and differenced all of them against that one frozen twin — so anything that changed between the frozen and running states read as a coverage change over the entire body. Every frame now gets its own twin at its own frozen instant. Re-measured: `mouth` 1.2% -> **0.2%**, `river` 13.4% -> **4.7%** — an inflation of 2.9x on `river`, where the critic who found it estimated 1.6x. `drift` also fell to -328 and 9, i.e. essentially zero, which is what makes the new numbers trustworthy: the tool's own header says to read `drift` first, and the old sequences never had a clean one. `river` at 4.7% is still a real failure of the 1.5% gate. |
| `tools/health.mjs`: `shaderFailures: 0, errors: []` on a tree whose TERRAIN MATERIAL DID NOT COMPILE | Reproduced deliberately by an author: a GLSL redefinition in `TerrainMaterial`'s fragment shader stopped the material linking and this gate saw nothing, while `tools/shot.mjs` caught it. The gate scraped the console for a regex, and `TerrainMaterial` is an `onBeforeCompile` on a `MeshStandardMaterial` whose program is built lazily on the first draw that uses it — so whether that draw had happened by the time the gate read was a race. It now forces a render and then asks the renderer directly: every program with `diagnostics.runnable === false`, with the driver's own log attached. Verified by injecting the same break: `ok: false`, `shaderFailures: 2`, the redefinition and its line number quoted; restored, clean. **A system whose shader does not link renders nothing, silently, and this was the gate that was supposed to catch it.** |
| `wedge.mjs`'s `hole%`, introduced to measure occluder silhouettes contaminating the shoreline | It does not measure occluders here: `--hide Rocks` moves it by 0.3 points on the current build and 1.4 on the baseline. It measures **pinholes in the water** — small dry regions fully enclosed by water. Which makes it a RESULT rather than a contaminant: baseline `river` **33.6%** against the current build's **7.5%**, an independent confirmation in the rendered frame of the 72% speckle reduction the offline field harness measures. A third of the baseline `river` "shoreline" was the perimeter of holes in shattered water. |
| The water lab's first contact sheet: long channels drawn as two lines of shoreline with dry ground between them, in every case | A render artifact. At one pixel per texel a 3 m channel is two pixels wide and its own hairline shoreline covers it completely. `chanWet` — the fraction of channel texels that are actually wet — came back at 97–100%. The channels were full the whole time. Nothing was wrong except the picture. |
| `crenel` 1.05–1.15 across the board, i.e. "the shorelines are nearly smooth" | `crenel` compares a contour to a Gaussian-smoothed copy of itself, and that ratio is insensitive to exactly the failure this round is about: a lobed, scalloped edge whose lobes are several metres across smooths to almost the same length. `fine` (26–60%) and `speck` (190–1560/km²) are the metrics that saw it. Rank your evidence accordingly: **`crenel` is the weakest of the three shape numbers and must never be the only one you cite.** |

## What to look for, specifically, this round

Ranked by how much each hurt the baseline frame:

1. **Scalloped, lobed water over rough ground.** The signature: an edge that
   wanders in and out over a few metres with roughly texel-scale lobes, and
   detached specks of water in the ground beside it. Look at the foot of the
   fall in `waterfall`, and at any tributary. Compare against
   `shots/waterlab/base/talus.png`, which is the same defect from directly
   above, so you can tell it apart from mere sinuosity.
2. **Aliasing and crawl.** `aaPx` under 1.3 means the alpha edge collapses
   inside a pixel, and it *will* crawl in motion however clean the still is.
   Capture the same view twice a second apart and difference them; anything
   that changes along the waterline that is not foam is crawl.
3. **Cell-aligned polygon edges.** Dead-straight segments in a shoreline,
   45°/90° corners, long thin wedges of bank intruding into water. `stair`
   catches these; so does looking.
4. **The pale slab.** A wide, flat, near-neutral band across the foreground
   where the shore should be. `mouth` is where it lives. Water should be the
   darkest and coolest note in the frame; check that it is.
5. **No lace.** The plates have a bright, broken, high-frequency line where
   water meets land. Absence of it is what makes a shoreline read as a cut-out.
6. **Facets and creases on open water.** Straight value steps across a surface
   that should be continuous.
7. **Banding in the reflection.** Dark smudges over open water that move with
   the view rather than with the surface.
8. **Shallows that are too narrow.** Two authors now grade the same bank and
   the steeper of the two wins, which puts a metre of water 1.7 m from the
   shore. Look for water that goes deep abruptly at the bank, for a missing
   translucent margin where the bed should read through, and for shelf and
   sandbar terms that no longer have anywhere to live. This is a KNOWN risk with
   a named dial — see the last section of `docs/WATER_SMOOTH_STATE.md` — and it
   was deliberately left for a critic to call, because it is a question about
   how the frame looks and the numbers do not settle it.

## What a `SHIP` requires

All of:

- `wedge`: `fine` < 8%, `stair` < 4%, `crenel` < 1.03, on every framing,
  measured on a `--hide --waterdiff` capture and checked against its `--zoom`.
- `wedge`'s `aaPx` is a **two-sided** check, not a target to minimise. Below
  1.4 is aliasing and it will crawl. In the tens is a slab with no edge at all.
  Between those, a *wider* edge on distant water is correct prefiltering rather
  than a defect — `mouth` at 2.4 px in the foreground and `plunge` at 4.8 px at
  two hundred metres are both right. Judge it against the framing's distance,
  and only call it out at the extremes.
- `waterlab --compare base1 <round>`: `fine` < 12%, `speck` < 25, `grad10` >
  0.25 on every case, with `area` within ±15% of `base1` and `chanWet` ≥ 97%.
  Judge bank roughness on `bedTan`, not on `bedRms` — see above.
- `wcrawl`: `flip` < 1.5% on `mouth` and `hero`, and `ratio` < 2.5 as a
  secondary. `flip` is the column that means something — see the tool's header.
- `health.mjs`: `shaderFailures: 0`.
- A perf number that is not worse than the baseline, stated with its method.
- And then you look at the frames and they hold up next to `reference-art/`.
  The numbers are necessary. They have never been sufficient.

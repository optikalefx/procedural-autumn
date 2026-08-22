# The smooth-water round — what the integrator landed

## Result, pristine HEAD -> shipped

Measured with `tools/wedge.mjs` on `--hide --waterdiff` captures, i.e. on the
water's own contribution at exactly the alpha it was composited with, with the
engine's clock stopped so the pair differs by the water and nothing else.

| framing | fine | stair | crenel | edge width px |
|---|---|---|---|---|
| mouth | 23.4% -> **5.6%** | 19.9% -> **2.5%** | 1.144 -> **1.026** | **64.0 -> 2.40** |
| plunge | 12.8% -> **6.1%** | 8.0% -> **2.7%** | 1.075 -> **1.023** | 9.88 -> 4.06 |
| river | 12.2% -> **8.1%** | 5.9% -> **3.7%** | 1.071 -> **1.034** | 7.36 -> 3.21 |
| waterfall | 13.0% -> **9.0%** | 8.0% -> **4.0%** | 1.069 -> **1.033** | 11.98 -> 5.59 |
| hero | 26.7% -> **10.8%** | 21.2% -> **5.2%** | 1.164 -> **1.047** | 5.03 -> 4.05 |

Temporal, `tools/wcrawl.mjs`, six frames of a static camera: waterline pixels
that blink across half coverage, `mouth` 3.0% -> **1.1%**, `hero` 2.3% -> 1.7%.

The offline field, over nine hostile synthetic terrains driven through the real
pipeline: `fine` **-41%**, speck **-72%**, bank roughness `bedTan` **-15%**, and
the depth gradient at the waterline 0.13 -> **0.30**, which is what decides how
far the line moves when anything about the bed moves.

An edge sixty-four pixels wide is not a soft edge, it is a slab with no edge at
all. That number, and the fact that it took four implementations and a debugged
test fixture to measure it correctly, is the round in one line.


Authors: **BED** (`TerrainGen.js`), **MESH** (`Water.js`), **PIXEL** (the two
shaders), **integrator** (everything else). This file is the integrator's half.
Read `docs/WATER_SMOOTH_ROUND.md` for the brief and
`docs/WATER_CRITIC_ROUND.md` for how it is judged.

## The finding the round turned on

Four subsystems each computed "where does the water end", from a different
field, at a different resolution, with a different quantisation:

| | what it cut the edge on | how it was quantised |
|---|---|---|
| the water shader | `P.y − texture(uDataTex).r` — a smooth surface minus the **raw 2 m eroded bed** | a level curve of a rough field |
| the terrain shader | the same subtraction, but against the terrain **mesh** height — the baked field **plus up to 0.44 m of micro-detail** the water knows nothing about | the two shorelines are p50 0.44 m apart, p90 2.16 m, p99 7.99 m |
| the perched guard | a `−9999` sentinel in a **linearly filtered** channel | crosses its threshold 1 cm past a texel centre: a binary mask, no antialiasing, biting on 23% of the mask boundary |
| `Water.js`'s `aShore` | an octagonal chamfer of a **4 m binary raster**, interpolated across triangles | level sets are straight segments with a kink every 4 m |

Four curves, four resolutions. The jagged shoreline was not one bug; it was
those four disagreeing, and no amount of tuning inside any one of them could
have fixed it. **Two visible shorelines a metre apart is most of why a bank read
as a stain rather than as an edge.**

## `src/world/hydroField.js` — one field, that everything which draws an edge reads

Derived once from the baked height and water grids. RGBA16F, half the bake's
resolution, CPU-built mip chain, `LinearMipmapLinearFilter`.

| channel | is |
|---|---|
| **R** `depth` | the depth to test against. Within 18 m of the waterline it is `0.60 × sdf`, so its zero set is the smoothed curve by construction; away from the line it is the real bathymetry. |
| **G** `sdf` | signed metres to the waterline, positive inside, exact Euclidean, capped ±48 |
| **B** `wet` | 0..1 coverage — replaces the sentinel, and being a fraction it antialiases |
| **A** `span` | how open the water is here — the mean inside distance over 12 m, in metres. A thread reads under a metre, a lake reads at the cap. |

### Why half resolution, and why half-float

Band-limited by construction: every channel is a low-pass at 6–10 m or a
distance transform. Storing a 6 m-smoothed field at 2 m stores three copies of
every number. 768² RGBA16F is **4.7 MB** against the 37.7 MB an RGBA32F at 1536
would cost, and each fetch covers four times the cache.

Half-float works because the channels are **differences**, not elevations. Depth
spans −48…+60 m, so the step is 0.03 m at the deep end and **0.004 m in the 8 m
band where every shoreline decision is made**. An absolute height would have
stepped 0.25 m at 365 m — three times the micro-detail this field exists to
reconcile.

The mip chain is built here rather than by the driver because `generateMipmap`
on a float texture is not portable, and without one a 2 m field is point-sampled
at every range. That is the narrow jagged zigzag every distant river drew.

### What was tried, and what the measurements actually said

Swept with `tools/hydrosweep.mjs` against the real bake and with a second
harness that drives the field through `waterlab.mjs`'s nine hostile terrains.
`dArea` is the change this field makes to how much water the world has — the
honesty column, because the only way to smooth a level curve of a rough field
is to move the field, and moving it moves the curve.

**Three ideas were tried and two of them were wrong.** The round's opening
hypothesis was the brief's: *smooth the terrain under the water placement.* It
is right about the cause and wrong about the cure, and it took three
measurements to establish that.

| what was tried | what it did | verdict |
|---|---|---|
| **an 8 m low-pass of the bed near the shore** | over the real bake, `fine` 13.2% → **15.1%** and the 10th-percentile depth gradient 0.113 → **0.079** | **worse on both.** A low-pass takes the fizz out of the bed *and* flattens the crossing, and a flatter crossing is a longer, wanderier contour that moves further when anything moves. |
| the same, driven through the nine lab terrains | `braid` 11.01% wet → **7.79%**, `meander` 9.37% → **7.04%** | **it drains narrow water.** Blurring an incised channel with its own banks *raises* its bed: a blurred cut is a shallower cut. A third of every thread in the map, gone, to smooth an edge. |
| **a distance field: `depth = 0.60 × sdf` near the line** | `fine` 15.9% → **6.8%**, `grad10` 0.061 → **0.158**, `dArea` +0.23 | **this is the cure.** Its zero set is the smoothed curve by construction and its gradient is a known 0.60. |

The shipped sweep, reproducible with `node tools/hydrosweep.mjs`:

| variant | dArea | fine | grad10 |
|---|---|---|---|
| off | +0 | 15.9% | 0.061 |
| clean only | +0.23 | 15.2% | 0.063 |
| grade 0.45, band 18 | +0.23 | 7.1% | 0.127 |
| **grade 0.60, band 18 — shipped** | **+0.23** | **6.8%** | **0.158** |
| grade 0.60, band 26 | +0.23 | 7.9% | 0.162 |
| grade 0.80, band 18 | +0.23 | 7.1% | 0.193 |

So the bed conditioning is **gone**. The cure is to smooth the **curve** and
steepen the **crossing** — which is what a distance field does and what a blur
cannot. The grade is a **floor**, not an imposition: a bank already steeper than
1:1.7 keeps its real depth, so a gorge wall is never handed a beach. Away from
the line the real bathymetry is untouched, so a lake still deepens toward the
middle and the shelf terms downstream still have a bed to read.

Three further defects were found by measurement, each of which made the field
silently useless in a different way:

1. **The extension invented water.** Propagating the level 40 m outward and then
   testing `level > bed` re-decides where water *is*: wherever the extension ran
   downhill into a hollow the bake left dry, a pond appeared. **19.58% → 25.56%
   of the map, a third more water than the world has, with every dial off.**
2. **The mask that a distance cap was anchored to was taken *after* the
   extension**, so it was the inflated one it existed to bound, and both the cap
   and the level-smoothing exemption were no-ops.
3. **A morphological close-then-open could not tell a hole from a gap, or a
   crumb from a channel** — because a 3×3 structuring element cannot: both
   distinctions are about shape at a distance. The open is an erosion, and an
   erosion at one texel deletes anything under three texels across, which on a
   2 m grid is every braided thread in the map. The close is a dilation, and in
   a dense braid it does not fill holes, it *bridges*, and the ground between
   the threads floods. Measured: `braid` −58%, `gorge` +48%.

The mask is now the **bake's own**, cleaned by two operations that state the
distinction directly — a pinhole is a dry texel with three or four wet
orthogonal neighbours (a diagonal *gap* has at most two); a crumb is a body
under 40 m² **and** under 12 m in its longer axis, so a 6 m puddle goes and a
4 × 30 m fragment of a braided thread stays, whatever its area. The bake is the
authority on extent; this file is the authority on the edge.

And the smoothing that makes the edge clean is a **symmetric blur of a distance
field**, which moves the curve inward and outward equally and so preserves area,
where a dilation only ever adds. Its radius is **rationed by how wide the body
is**, because an isotropic smoothing at radius R destroys every feature smaller
than R — including the *width* of a channel narrower than R. It does not need to
touch them: narrow water in this map is carved along a centreline `_traceRivers`
has already smoothed twelve times, so those boundaries are smooth by
construction. The jagged edges are all on wide, shallow water.

**The result, over all nine hostile terrains** — the number that says this is a
field and not an overfit:

| | flat | talus | bench | gorge | bowl | delta | braid | step | meander |
|---|---|---|---|---|---|---|---|---|---|
| dArea | +0.07 | +0.10 | +0.08 | +0.19 | +0.04 | +0.05 | +0.06 | +0.05 | +0.06 |

## The other two integrator changes

- **`TerrainMaterial` reads the same field.** Its waterline was
  `max(0, data.g − vWorldPos.y)` — the sentinel channel minus the *mesh* height.
  Both halves wrong in the same direction, and because the micro-detail's 3.8 m
  and 2.0 m octaves alias differently in each terrain LOD band, the
  disagreement *changed at every LOD ring*. It is now the hydro depth, sampled
  the same way the water shader samples it.
- **Micro-detail fades out at the waterline** (`WorldData.microDetail`). Half a
  metre of bump on a bank whose gradient is 1:30 moves the visible waterline
  fifteen metres, and the bumps are 2–8 m across — which is precisely the lobed
  scalloped edge, arriving from the *geometry* after the field had been
  conditioned to remove it. Nothing within 1.5 m of the line, full strength by
  9 m. That band is a twentieth of a percent of the map's area.

## Cost

`buildHydroField` at res 1536: **329 ms** on the machine this was tuned on,
**434 ms** on the reviewer's, with the per-stage ratios identical — so read the
figure as "about a third of a second, machine-dependent" rather than as 329.
Packing the half-float texture and its mip chain adds a further **34.8 ms**
which is not in that number; total `new WorldData(...)` is ~440 ms.

| stage | ms | note |
|---|---|---|
| level extension + blur | 84 | was 138 — a typed ring buffer instead of a JS Array per ring |
| mask, distance field, grading, span | 242 | two exact Felzenszwalb–Huttenlocher transforms are 163 of it. Irreducible, and exact by design: this is the quantity the shoreline is drawn from. |
| downsample | 3 | |

Down from 500 ms. Three things paid for it: a 3×3 dilation **is** separable
(160 → 40 ms); the level flood was allocating a JS Array of boxed indices per
ring, twenty rings deep over a 2.36 M-texel grid (90 ms of pure allocation on a
walk whose real work is a copy); and the distance cap that is now gone was an
exact transform where a leash may be approximate (100 ms).

**Still on the table, not done:** this runs on the main thread inside
`WorldData`'s constructor. The cached-bake path decodes in 61 ms and then blocks
for 329 ms here. Moving it into a worker is a contained change — a
`hydroWorker.js`, `main.js` awaiting it, `WorldData` taking it as an optional
argument — and it would take the added load cost to zero. It is not done
because nothing in the frame depends on it.

## New instruments, all in `tools/`

| tool | measures | why the existing harness could not |
|---|---|---|
| `waterlab.mjs` | the depth field over **nine hostile synthetic terrains**, driven through the real `TerrainGen` pipeline, ~0.2 s per case | every water defect this project ever logged was found by looking at ONE map from a handful of frozen anchors at 25 s a look |
| `wedge.mjs` | waterline shape and **antialiasing in pixels**, on a PNG, no browser | a shoreline can be geometrically perfect in metres and stair-step on screen, because the alpha edge is specified in world metres and collapses inside one pixel at range |
| `wcrawl.mjs` | whether the waterline **holds still** over six frames | "not jagged" and "flowing smoothly" are two requirements and a still frame shows one of them |
| `hydrosweep.mjs` | the hydro field's dials against the real bake, shape **and** water area in one table | the only way to smooth a level curve of a rough field is to move the field |
| `shot.mjs --hide --waterdiff --frames` | captures that make the above possible | see below |

`--waterdiff` is the one worth knowing about. `wedge` used to find the waterline
with §0's colour rule, `B_srgb − R_srgb ≥ 0.02`, and **a colour rule cannot tell
water from pale cool rock**: on `waterfall` it found the cliff face and reported
12.3% of it as a jagged shoreline. There is no threshold that separates them,
because they are the same colour. So the pose is captured twice, once with the
Water group hidden, and the difference between the two **is** the water, at
exactly the alpha it was composited with. With the honest mask that frame
measured 35% — three times worse than the number that would have been quoted.

**Seven** new entries for `docs/CRITIC_PROTOCOL.md`'s table of instruments that
are confidently wrong came out of this round, and they are written up in
`docs/WATER_CRITIC_ROUND.md`. Most were mine. Every one produced a clean number
a reasonable person would have acted on. The three worth knowing about even if
you never touch water again:

1. **A colour rule cannot tell water from pale cool rock.** §0's mask is
   `B_srgb − R_srgb ≥ 0.02`, and on `waterfall` it found the *cliff face* and
   reported 12.3% of it as a jagged shoreline. There is no threshold that
   separates them, because they are the same colour. The fix was to stop
   guessing: capture the pose twice, once with the Water group hidden, and the
   difference between the two **is** the water, at exactly the alpha it was
   composited with.
2. **A metric can measure the scene instead of the defect.** `stair` counted
   contour-direction mass at the lattice angles — and a distant lake shore seen
   from a level camera *is* a horizontal line, so it scored the perspective and
   gave its worst mark to the best shoreline in the set. Redefined as local
   direction disagreeing with its own smoothed curve, the same frame went
   30.1% → 2.5% across the round where the old form had reported 14.7% → 25%:
   **the opposite sign.**
3. **The instrument's own test fixture has to be debugged first.** `aaPx` took
   four implementations. The version that reported "we have replaced a soft edge
   with a hard aliased one, and antialiasing is now the top priority" was
   entirely an artifact, and it nearly redirected the whole remaining effort.
   What settled it was a synthetic edge of known width — and the first version
   of *that* had the water on the wrong side, so a strip clamped dry to keep the
   body off row 0 became a second hard contour that doubled the length and
   halved every width reported. The tool and the fixture were wrong at the same
   time, in ways that partly cancelled.

The general lesson, which this round paid for four times: **a harness that
reports nothing, or reports the opposite, looks exactly like a result.** Three of
the four bugs in my own code were found by measurement rather than by reading,
and three of the seven bugs in the measurements were found only by feeding them
an input whose answer was known in advance. Both halves need that treatment.

## Two things the correctness review left open, both for whoever takes perf

**The terrain shader now takes an extra texture fetch per fragment.**
`TerrainMaterial` samples `uHydroTex` for every ground pixel in the frame, which
is most of them. It is one fetch from a 4.7 MB mipmapped texture against the
several it already does, so it should be small — but it is unmeasured, and
measuring it needs a baseline build and a re-bake, which would have taken the
capture lock away from the other authors mid-round. It is the first thing a perf
pass should cost.

**There are still two signed distance fields, and nothing states how far apart
they are allowed to be.** The round's headline is one field that everything
drawing an edge reads, and that is true of the *waterline*: the water shader,
the terrain shader and the micro-detail fade all read `hydro`. But `Water.js`
also derives its own exact transform at native resolution for the `aShore`
vertex attribute, from the raw bake mask — where `hydro.g` is cut on the
*cleaned* mask and then blurred by a span-rationed radius. Their zero sets
differ by exactly those two operations. That is by design (one places geometry,
the other draws pixels, and the mesh must not shrink inside what the shader
wants to draw), and both are now correctly registered after the review found a
half-texel displacement in each. But the tolerance is nowhere written down, and
a future round that widens the curve smoothing without widening `SURF_DEAD_M`
will discover it the hard way. Someone should measure the p99 divergence and put
a number in `docs/WATER_CONTRACT.md`.

## The probe that settled the last defect, because it generalises

`shots/r1/plunge.png` had a heavy dark rust rim inked around every waterline in
it — the pool, the distant river and the lake alike. Three subsystems could have
drawn it: the terrain's riverbed and damp paint, the water shader's damp margin,
or the alpha ramp compositing dark water over gold bank.

Reading the code narrowed it to none of them convincingly. What settled it, in
two captures and about four minutes:

1. Force `bandGate = 0.0` in `TerrainMaterial` — every water-margin term the
   terrain draws, off — and capture. **The rim survived.** Not the terrain.
2. Restore, force `wetT = 0.0` in `water_surface` — the water's damp margin,
   off — and capture. **The rim vanished** and the shorelines read as clean gold
   against blue.

The lesson is not about the damp band. It is that in a pipeline where four
systems paint the same few metres of ground, **the cheapest way to attribute a
defect is to turn one term off and look**, and it is far cheaper than the
reading that preceded it. The same probe would have found the two half-texel
registration errors in an afternoon instead of needing a correctness review.

The fix, once attributed, was not to delete the band but to state the condition
it was already trying to meet. It is 0.9 m of ground and it is dark: at five
metres that is a margin, at two hundred it is a six-pixel outline drawn round
the water. So it is withdrawn by distance (full to 60 m, gone by 160 m) and by
how wide the water it borders is (`wetReach / span`), because a 0.9 m margin
against a sixty-metre lake is a margin and against a four-metre brook it is a
quarter of the feature.

## One target that is scale-dependent, and should probably be restated

`wedge`'s `fine` is the percentage of waterline whose curvature radius is under
**3 pixels**, and the round's target is under 8%. `mouth` reads 5.6% and
`plunge` 6.1%, both clear. `hero` reads 10.8% and does not.

Looking at `shots/wedge/r2/shots_r2_bare_hero_png.png` at 3x, the `hero`
contour is not jagged: the rivers are smooth continuous ribbons and the curve
tracks them cleanly. What drives the number is that at valley scale most of
those ribbons are **three to six pixels wide**, and the outline of a four-pixel
ribbon has a curvature radius of about two pixels at every bend and at both
ends — because that is what a ribbon four pixels wide *is*. The metric is
measuring the width of the feature, not a defect in its edge.

So `fine < 8%` is a near-field target and it should not be applied unchanged to
a framing whose water is mostly threads. Either the threshold should scale with
the local ribbon width, or the metric should be restricted to contour whose two
sides are more than a few pixels apart. Neither is done here, and a critic
chasing `hero` to 8% would be chasing the projection.

## Before this round ships: the bakes must be refreshed

`public/bakes/` holds `world-20261018-{512,768,1536}-4d6baa83.pab`. The
generator hash is now **8c42a243** — `TerrainGen.js` changed — so the exact file
no longer exists, and `loadCachedBake` falls back to *the newest bake for that
(seed, res)* with a `STALE BAKE` warning.

That fallback exists so a peer mid-edit on `TerrainGen.js` does not lose fast
captures, and for that it is right. For a shipped build it is **the round's
terrain conditioning silently absent while its water code runs against the old
heightfield**, which is exactly the two-generations-in-one-frame failure this
round exists to remove.

Verified not to have affected anything here: every capture in this round
reports `__bakeCached false, __bakeStale false` and logs `baked live in 16213 ms
(gen 8c42a243)` — the `.pab` files in this worktree do not decode, so the
fallback failed through to a live bake and the frames are honest. That is luck,
not design.

**`node tools/bake.mjs --force` before anything else.** It also removes a 16 s
live bake from every single capture, which is most of why this round was slow.

## `gorge` is a stress case, not a target

`shots/waterlab/r2/gorge.png` reads `fine` 40.8% against a target of 12%, and it
is the worst case on every shape metric in the lab. Look at the picture before
acting on the number.

The case is a V-valley with a flattish floor, and the erosion and routing turn
that floor into an anastomosing braid: **26% of the patch is water**, in a maze
of threads with thousands of small islands between them. The threads' own edges
are clean — the outlines in that image are smooth curves. What drives `fine` is
that the outline of a six-metre island has a curvature radius of three metres
all the way round, because that is what a six-metre island *is*. It is the same
scale-dependence as `wedge`'s `fine` on the `hero` framing, in the field rather
than in pixels.

No gorge in the shipped map looks like this, and the terrain author declined to
over-fit to it, correctly. Keep the case: it proves the pipeline does not fall
apart on a drainage pattern nobody designed for, and `chanWet` 98.8% and
`grad10` 0.31 on it are real results. But its absolute `fine` is a property of
the input and it should not be chased.

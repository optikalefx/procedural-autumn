# Water round 5 — the silhouette round

## What the user found, that five instruments did not

> "on some of the rivers, they look great from above, but when you're at eye
> level, they are floating" ... "that same river from above, looks great"

That pair of observations is the diagnosis. Looking straight down, you look
along the lift axis and a vertical offset is invisible. At eye level it is the
whole defect.

**Cause.** `src/shaders/water_surface.js` lifted the drawn sheet in WORLD SPACE
by `min(2.2, 0.03 + range * 0.011)`, and the fragment shader corrected depth for
it. That keeps ALPHA and the (x,z) FOOTPRINT exactly right — which is why every
top-down framing measured clean — while drawing that correct footprint up to two
metres too high. The silhouette shift along the view ray is `lift / tan(i)`:

| framing | eye above surface | range | incidence | lift | silhouette shift |
|---|---|---|---|---|---|
| mouth | 4.6 m | 54 m | 4.9° | 0.62 m | **7.2 m of ground** |
| river | 5.0 m | 53 m | 5.4° | 0.61 m | **6.5 m** |
| threadNear | 3.0 m | 22 m | 7.8° | 0.27 m | **2.0 m** |

It was also a camera-position term deciding where the water appears to end:
`d(lift)/d(range) = 0.011`, so one metre of dolly moved that silhouette by 0.13 m
of ground at `mouth`. That is the same defect class as the old
`alpha = max(alpha, wetT * 0.80)`, moved out of alpha and into geometry.

**Fix.** The lift is now a token `0.03` constant, and depth ties are resolved by
`polygonOffset` on the material in `Water.js` — the only space where resolving
them cannot move a silhouette. The premise the lift was clearing had also
expired: micro-detail is tapered to 0.0004 m RMS at the waterline and the edge is
cut per-pixel from the hydro SDF, so the ill-conditioned geometric intersection
no longer draws the shoreline.

**Measured, bare, six framings, shipped -> fixed:**

| framing | fine | stair | aaPx | mask% |
|---|---|---|---|---|
| river | 9.8 -> 9.4 | 4.8 -> 4.7 | 3.57 -> 3.36 | 12.13 -> 10.92 |
| mouth | 4.6 -> 5.0 | 2.0 -> 2.5 | 2.38 -> **2.09** | 52.51 -> 50.61 |
| waterfall | 8.4 -> 9.8 | 3.7 -> 4.3 | 5.36 -> 5.01 | 12.06 -> 10.91 |
| hero | 10.8 -> 11.0 | 5.6 -> 5.1 | 3.88 -> 3.70 | 3.41 -> 3.29 |
| backwater | — first ever measured — | 12.1 | 6.4 | 6.88 | 42.98 |
| drive | — first ever measured — | 8.4 | 4.8 | 3.05 | 1.00 |

The `mask%` fall everywhere is the overhang going away. `waterfall`'s `fine`
rise is the metric penalising correctness: the zoom shows a boulder the raised
sheet had drowned re-emerging, with the waterline correctly detouring around it.
`hero` recovered 13.7 -> 11.0 when `polygonOffset` was added, which is the
evidence that the offset is doing the depth work the lift used to brute-force.

## Why the instruments missed it — carried forward as a standing rule

**Every water instrument in this tree measures the water's FOOTPRINT. None
measures its SILHOUETTE.** `wedge`'s four columns — `fine`, `stair`, `crenel`,
`aaPx` — are all shape statistics of a contour, and **every one is invariant
under translation**. Move the whole body in x, z or y and not one column moves.
`wcrawl` differences coverage over time from a static camera. `waterlab` is
orthographic from directly above, in node, with no shader. `--waterdiff` DEFINES
water as (frame with) − (frame without), so everything the terrain draws in the
shore band is subtracted out by construction.

Three consequences adopted as rules:

1. **A low, level camera is mandatory in the measurement set.** `backwater`
   (2.2 m eye, dead level) is the harness's lowest eye and was in no measurement
   set at all — it had been declared broken ("a dark hole") before the round
   began, and declaring something out of scope removes it from the sample, which
   is the only place new defects come from. It is in the set now, as is `drive`.
2. **Never conclude by elimination.** The ghost loop was attributed to
   "historical terrain shading" after probing three of the four water-margin
   terms in `TerrainMaterial.js` and generalising. The fourth was the one. A
   critic settled it in one probe by repainting the term red.
3. Judging LOOK on a `--hide` capture is still forbidden for grade and
   vegetation, but `--hide` is the ONLY view in which terrain and water geometry
   can be seen against each other. Silhouette is judged there.

## Also fixed this round

`TerrainMaterial.js` `damp` — the last ungated water-margin term of four, and an
unantialiased `step(0.001, depth)` driving a 0.51-stop albedo multiply. Now
`* bandGate` like its three siblings, with the wet/dry edge ramped over one
pixel of `fwidth`. No waterline regression (`mouth` mask% identical, hole%
2.0 -> 1.8).

## The ghost loop is NOT fixed, and its real cause is now named

Gating `damp` barely touched it: box mean |Δ| 0.80, darkest-line 41.3 -> 39.9.
So `bandGate` is ≈1 there, which means **the field genuinely claims that cliff
is a shore band**. `damp` is a band over 0.02 < depth < 0.50, so a thin closed
loop is the RIM of a wet region whose interior is deeper than 0.5 m — a region
the terrain believes is water and the water mesh never draws.

That is the two-mask disagreement this project already has on record:
`Water.js` seeds its mesh and its `aShore` transform from the QUAD-LEVEL wet
mask; `hydroField.js` seeds its SDF from the BAKE's cleaned wet mask. The
critic measured the consequence directly at `mouth`: terrain-claims-wet minus
water-drawn = 8 072 px in 212 components, largest 1 484 px at [1046,181] — the
loop. Reconciling those two masks is the open item, and it is also the single
largest load-time item (~300 ms of the load is three exact distance transforms
of two different masks).

## Open, ranked

1. **The surface is 95% static over a full flow cycle.** Direction is fixed
   (angle error 114° -> 6° p50 at `river`), but `river` open water differs from
   itself by 2.40 levels after 5 s against a spatial SD of 43.55; two
   decorrelated fields would differ by ≈49. 17/18 patches PINNED. The round moved
   moving÷static 3.1% -> 5.0%.
2. **`cool` spread collapsed at `mouth`** — 2.77 on the baseline to 0.66 now,
   against a spec bar of ≥1.5 and reference plates at 1.59–2.40. The mean is
   right; the variation the spec says IS the surface is gone. A regression, not
   claimed as intentional by any round note.
3. **The ghost loop / two-mask reconciliation**, above.
4. **`backwater` is a dark hole** — 43% of screen, near-featureless dark mass,
   now measured for the first time. `aaPx` 6.88 is honest grazing geometry, not
   aliasing.
5. `wcrawl`'s header is wrong and must be corrected: `flip` is a COLOUR
   difference, so travelling foam scores 16.7% on a provably bit-identical alpha
   edge while a real ±0.6 px wobble scores 3.4%. The true alpha edge measures
   flip 0.00–0.11% — stable to 150–2000× below a sub-pixel wobble. `hero`'s crawl
   item is closed: it is the water animating.
6. `bigflip`'s world binning is mis-registered on water, because
   `scene.overrideMaterial` writes world position from the RAW attribute with no
   swell and no lift, while coverage comes from the displaced plane.

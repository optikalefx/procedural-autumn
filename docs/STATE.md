# Procedural Autumn — state at the performance pivot
_2026-08-19, all feature work paused_

## Why we stopped

The player reports **~4 fps**. Every harness in this project reported 45–50 fps.
That gap is the whole problem, and it is the same class of blind spot as the
black square: **the harness was not measuring what the player runs.**

## The measurement that explains it

`tools/dprtest.mjs`, identical scene, identical window size, driving:

| | drawing buffer | megapixels | p50 | fps |
|---|---|---|---|---|
| deviceScaleFactor 1 (every capture ever taken here) | 1728×1000 | 1.73 | 21.0 ms | **47.6** |
| deviceScaleFactor 2 (a Retina Mac) | 3456×2000 | 6.91 | 60.3 ms | **16.6** |

`QUALITY_PRESETS.ultra` sets `pixelRatioCap: 2.0`, and `Engine` does
`setPixelRatio(min(devicePixelRatio, cap))`. On a Retina display that is **4× the
pixels**. Post-processing was independently measured at **56–59% of frame time**
and is fixed cost per pixel, so it scales directly with this.

16.6 fps is at 1728×1000. A larger window — full screen on a big display —
multiplies it again, which is how 16.6 becomes 4.

## Where the game is otherwise

- **72 modules, ~30k lines.** All parse; app boots clean; all 13 systems enabled.
- **Gates that now exist:** `lint.mjs` (syntax + GLSL reserved words),
  `winding.mjs` (triangle winding vs normals — 3 authors shipped that bug),
  `health.mjs` (now fails on shader link errors — 2 systems once rendered
  nothing while every other check passed), `nanhunt.mjs` (the NaN class that
  blacked out the player's screen).
- **44 archived review rounds** in `review/`, framings pinned in
  `review/anchors.json`.
- **Last critic verdict:** `SHIP 0 · CLOSE 3 · REJECT 7`, with blind A/B picking
  the current build 10/10 over the previous one.

## Feature work paused mid-round (all committed, none lost)

| system | state |
|---|---|
| water | plunge pool + spray rebuild half-landed; distant falls still hard-ended glyphs; the tan stripe beside the fall identified as Terrain's carved channel bed, not water |
| ground cover | scrub form + substrate mid-round; author reported perf hitches eliminated |
| wildlife + vehicle | birds being lit/hazed; camper cast shadow restored, contact shadow now double-darkening and needs retuning |
| look/grade | complete — neutral point corrected, per-hour ground colour fixed |

## Open blockers from critic pass 3, deferred

Rocks value (partly fixed), the cool cast-shadow *shape*, bare 2 m substrate,
massif surface structure, backlit rim on grass/groundcover, gold isolines on
rock, unlit birds, waterfall plunge, shorelines and reflections, camper contact
shadow, conifer value range, birch trunk value.

## The performance plan

1. **Pixel ratio is the single biggest lever** — 4× the pixels for a display
   difference the harness never simulated.
2. **Dynamic resolution scaling**, measuring frame time and holding a target.
   This is what a shipping game does and it makes the game robust to any
   display.
3. **The post chain**, at 56–59% of frame time and fixed cost per pixel: AO
   sample count and resolution, DOF internal resolution, SMAA, bloom mips.
4. **Re-baseline the harness at deviceScaleFactor 2**, so the numbers this
   project quotes are the numbers the player experiences.

---

# State — 2026-08-19, after the usage-limit kill

**All four running authors (water, ground cover, terrain, wildlife) were killed
simultaneously by an account usage limit.** Their transcripts did not survive;
`SendMessage` returns "No transcript found". ~2000 lines of edits across 13
files were stranded uncommitted. Snapshot of that state:
`<scratchpad>/wip-four-authors.patch`.

## The tree is healthy

All gates pass on the stranded work as it stands:

| gate | result |
|---|---|
| `lint` | 74 files parse cleanly |
| `health` | `ok: true`, `shaderFailures: 0` |
| `dprtest --dpr 2 --w 1170 --h 870 --gate` | **PASS** — p50 17.3 ms, p95 38.3, settled 63.7 fps |

That is slightly better than the pre-round baseline (p50 18.7–18.9). The
ground-cover author died believing its mats cost 40% of the frame rate; the
gate says otherwise, and the replacement has been told to verify that figure
against the gate rather than an isolated micro-benchmark.

## Assessment of the stranded work — `review/046-*.png`

**Landed and worth keeping:**
- Ground cover in `meadow` and `drive` is richer, warmer and far more varied;
  the bare-substrate band is largely gone in those framings (blocker #5, mostly).
- The central peak has real faceted planar breaks and a value break between lit
  and shadowed faces, where round 045 had a smooth featureless grey cone
  (blocker #6, mostly).
- The waterfall ribbon is brighter and softer with some mist at the base.

**Regressions and remaining defects:**
- **Corduroy ribbing on the central peak** — regular diagonal stripes at even
  spacing, reading as fabric rather than rock. New in this round; worse than the
  flatness it replaced, because a regular tiling artifact reads as a bug.
- **Horizontal terracing on the distant massif** — blocker #8's "gold isolines"
  now appearing in *grey*. That is the useful clue: the isoline problem is not
  in the colour ramp. Something quantises against absolute world height.
- **`river` is unchanged** — an entire hillside of bare brown ground, most of the
  frame. The most conspicuous defect left in the sheet.
- Lake edges remain hard against the bank (blocker #13).

## Wildlife: measured, and it is not a density problem

`tools/wcensus.mjs` was wrong twice — it teleported (so no animal had time to
react) and counted a frustum hit at 220 m, ~7 px, as a sighting. Fixed, and
`tools/wdrive.mjs` added: it drives in continuous time so ALERT and FLEE happen.

| | within 70 m | median gap | worst | median closest approach |
|---|---|---|---|---|
| roads | 44.4% | 1.6 s | 17 s | 55 m |
| offroad | 17.4% | 12.5 s | 69 s | 77 m |

Neither is "I haven't found any". The gap is **legibility**: a 1.5 m deer at
77 m is ~16 px at the player's viewport, in gold grass, at a wide chase framing.
Filed as W2 in `docs/INTEGRATION_REQUESTS.md`, with an explicit instruction not
to raise `perKm2`.

## Also landed this round

- `Lighting.onQuality()` — `preset.shadowMapSize` now actually applies on a
  runtime tier change (P8). `tierload` reports 4096/3072/2048/1024; it reported
  4096 at every tier before.
- The perf overlay hides itself during captures.
- The dev server now names the cause when a backtick closes a GLSL template
  literal — the eighth occurrence reached the player today.

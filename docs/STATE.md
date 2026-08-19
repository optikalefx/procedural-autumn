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

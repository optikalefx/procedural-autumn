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


## Wildlife: RESOLVED, and the cause was not what W2 assumed

W2 said the gap was legibility rather than density, and that was right as far as
it went — but it was still an art answer to what turned out to be a logic bug.

`ALERT`'s exit conditions were written against `d`, while the override at the
top of `Brain.update` re-arms `ALERT` against `dEff` (= `d` minus about fifteen
metres at driving speed). Every threat distance between those two thresholds
fell out of `ALERT` and was slammed back into it on the same frame, **for as
long as the player stayed near**. That band is 43-77 m of threat distance, or
**62-96 m from the eye** — and the measured median closest approach is 77 m.

So at exactly the distance where the encounter was supposed to happen, the deer
stood frozen with `speed: 0`, head up, indefinitely. A statue is the least
visible thing this game can draw. That is the player's "I haven't found any".

Fixed in `d7471d5`: the freeze is now a beat that resolves into WATCH — moving,
broadside, still wary — instead of re-arming into itself. Alert-band freeze
multiplier cut 1.6x -> 1.05x, because 4.2 s of freeze is 55 m of approach at
13 m/s, i.e. the whole encounter. Freeze pose squared up 43 deg -> 69 deg (a deer
head-on is ~0.5 m wide, across the flank ~1.9 m). Distance silhouette darkened
and flattened (`uSilDark` 0.58 -> 0.44, `uSilFlat` 0.62 -> 0.85).

`wdrive --km 6 --offroad`, before -> after: motion median gap **3.1 s -> 1.9 s**,
p90 32.9 -> 29.0, episodes 39 -> 45. Within-70 m 17.4% -> 16.6%. No `perKm2` and
no `live` cap touched.

**The lesson is the recurring one on this project.** W2's measurement was sound
and its conclusion ("not density") was correct and useful, but I reached for an
art explanation — 16 px is small — for a symptom whose cause was a state machine
comparing two different quantities. The instrument could not see it because
`wdrive` counts animals in frame and cannot see that one of them has not moved
in ninety seconds. Worth remembering that "the measurement rules out X" does not
mean "therefore Y", when Y was the next thing I happened to think of.

## Gate, verified independently at lower ambient load

`dprtest --dpr 2 --w 1170 --h 870 --seconds 26 --gate`: **PASS**, p50 18.6 ms,
p95 40.1, settled 57.5 fps, at load 6.95 with 9 Chromium processes. The wildlife
author's standalone run failed at p95 49.7 under load 11 / 69 processes, and
their back-to-back A/B against `3003973` (baseline FAIL 48.8, theirs PASS 41.3)
correctly identified that as ambient. Confirmed.

## Housekeeping

Four stale snapshot copies of the cover modules had appeared in `src/wildlife/`
(`GroundCover.js`, `cover_forms.js`, `cover_material.js`, `cover_scatter.js`).
Nothing imported them, one was byte-identical to `src/shaders/cover_material.js`,
and the live `src/vegetation/` versions were strictly further along. Moved to the
scratchpad rather than deleted, since their author is still running.

# State — 2026-08-21, the performance ablation round

The performance plan in the 2026-08-19 pivot entry below listed four items.
Three of them shipped (adaptive resolution, the tier fallback, `dprtest.mjs`
re-baselined at `deviceScaleFactor` 2). The fourth — "the post chain, at 56-59%
of frame time" — was never priced, because nothing in the harness could attribute
frame time to a system. **`tools/ablate.mjs` now can, and this round is the
answer.** Full write-up: **[PERF_FINDINGS.md](PERF_FINDINGS.md)**.

No `src/` code changed this round. It is a measurement, not a fix.

## Where the frame actually goes

Parked in a meadow, 1920x1080 CSS at `devicePixelRatio` 2 (3.78 MP, tier `high`),
adaptive resolution frozen: **35.8 ms, 27.9 fps**. Driving: 10-30 fps.

| | ms | share |
|---|---|---|
| post chain (measured on an EMPTY scene, twice) | **10.5** | 63% of the whole 16.7 ms budget for 60 fps |
| scene fragment shading (`scene.overrideMaterial` = flat basic) | **17.8** | 50% of the frame |
| everything else — geometry, draw calls, streaming, all JS | ~7 | |
| **all fourteen systems' `update()` combined** | **0.75** | 2% |

## The three findings that change what to work on

1. **There is no CPU problem.** Every system was switched off individually —
   grass, ground cover, wildlife, vehicle physics, camp, audio, HUD, terrain
   LOD — and every one measured within noise of zero. Optimising JavaScript here
   is optimising 2% of the frame.
2. **Every material is a `MeshStandardMaterial` with `metalness: 0.0`, and
   `Stylize` then scales direct specular by `0.14`.** The full GGX lobe, the
   Fresnel term, the multi-scatter compensation and the IBL path are computed on
   every fragment and then thrown away, into a response `Stylize` computes
   separately. This is the largest recoverable item in the game.
3. **Trees are worth negative 5.2 ms** — hiding them makes the frame *slower*,
   because they occlude the hillside behind them. The instinct to cut geometry
   for frame rate is wrong here in both directions.

Also: **no existing quality preset reaches 60 fps.** `medium` is 38, `low` is 54
— and `low` is already 1024 shadows, no SSAO, no DOF, 30% grass and
`pixelRatioCap` 1.0. The escape hatch does not reach the target.

## What to do next

`PERF_FINDINGS.md` ends with a ranked list, each item priced and each with the
`ablate.mjs --only` command that verifies it. In short: delete depth of field
(3.5 ms, one line), then re-base the materials off `MeshStandardMaterial` (up to
17.8 ms, and the only item big enough to matter), then `PCFSoft` -> `PCF`, then
the small ones. Pixel ratio is 9.6 ms and is deliberately listed last — it
spends the adaptive scaler's remaining margin.

## Two things this round did not answer

- **p95 is 74 ms while p50 is 36 ms, parked, with nothing moving.** A steady
  36 ms frame does not explain a doubling at the 95th percentile. Separate hunt.
- **Overdraw is unquantified.** `fx.flatShade` proves the frame is fragment-bound
  but not how many times each pixel is shaded. Spector.js is the tool, and the
  answer decides whether a depth prepass is interesting or pointless.

## A note on measuring anything here

Do not trust a frame-time comparison that was not taken with paired baselines.
An early version of the harness interleaved arms and alternated direction, and
reported `draw.water` — water HIDDEN, strictly less work — as 20 ms SLOWER than
a baseline taken thirty seconds earlier. After ~90 minutes of continuous
measurement this rig's parked baseline drifted 36 ms -> 70 ms. The method notes
in `tools/ablate.mjs` list six other traps of the same kind, each of which
produced a confidently wrong number before it was fixed. Also: GPU timer queries
(`EXT_disjoint_timer_query_webgl2`, which is what `stats-gl` reads) are broken on
this ANGLE/Metal stack and will happily report 156 ms of GPU work inside a 36 ms
frame — see `tools/gputime.mjs`.

---

# State — 2026-08-21, the camp round

Park, hold the brake, pick a patch of ground near the camper, and a camp
appears on it: a fire at the centre, one tent, chairs facing the flame, a
cooler, a table, a woodpile, sometimes a telescope. The ground under it is
scuffed to bare dirt. `src/camp/`, thirteen modules, plus a `Camp` system in
`main.js` between `vehicle` and `cameraRig`.

## What shipped

| | |
|---|---|
| placement | park brake latched -> reticle on the ground, click to build, `E` to pack up. Point at open ground to make a camp, point at a camp to strike it. |
| sizes | full camp on flat ground; a **compact** camp (tent, fire, one chair) at 3.4 m on slopes a full one will not take |
| how many | up to **four** at once, separated by the sum of their radii plus 3 m. The fifth strikes the furthest. |
| the clearing | a shader fact, not a re-scatter: an array of vec4s the grass and cover read, with an irregular edge shared by the shader, the dirt mesh and the reticle |
| camera | walks to the fire when a camp is made; click the car to come back; any throttle takes it back |
| audio | a fire bed plus crackles in clusters, and a **pop cue per object kind** as each one appears and disappears — nylon, tube, plastic, wood, metal, earth. Both on the `camp` metering tap |

## The numbers that decided things

Every limit in `camp_site.js` came off a sweep, not off taste
(`tools/_scratch/campsmall.mjs`, 774 dry samples; `campdiag.mjs` for the
annulus a player can aim into).

- **Buildable ground.** The first tree rule refused 74% of a dead-flat meadow
  whose median was ONE trunk within five metres. Only the fire's own 2.3 m has
  to be empty now; everything else is handed to the layout as an obstacle and
  walked around. Meadow 25.9% -> 76.9%.
- **Tilt is not bumpiness.** Both tests measured raw peak-to-peak height, which
  on any slope is dominated by the tilt — a smooth 20-degree hillside has 3.4 m
  of relief and nothing uneven about it. `scoreSite` fits a plane and asks the
  two questions separately. The same bug was one level down in
  `footprintRelief`, where it left camps consisting of one tent, alone.
- **Perf.** Pitching a camp froze the game for 986 ms. It is 29 ms and **zero**
  new shader programs now. Three causes: the fire's point light was the first
  in the scene (NUM_POINT_LIGHTS 0 -> 1 relinks every lit material in the
  valley); the camp's own materials compiled on first draw; and 160 ms of
  geometry in one frame. The light lives from boot at zero intensity, the pool
  of four fires and dirt meshes is built under the loading screen, and props
  build one per frame.
- **Headlights.** Two spots at intensity 190 reaching 68 m, and a camp stands
  8-18 m in front of the camper. Latching the park brake dips them to 6%.
  Measured on the telescope: 16.8% of its pixels clipped -> 0.00%, against a
  flame peaking at 0.85.

## Open, and honest about it

1. **The dirt out-values the grass in daylight.** It reads brighter than the
   sunlit meadow around it, which pulls the eye off the fire — the exact
   inversion the brief forbids. It is also the thing that will hurt the
   telescope most once that prop is right: a pale instrument standing on a
   clearing brighter than the meadow has nowhere left to be the light thing.
   Whoever takes it: `shots/camp/scope/r13/reflector-camp.png` has a
   known-neutral object standing on the dirt, and the magenta-mask instrument
   (`tools/_scratch/scopevalue.mjs`) will give you that prop's exact pixels to
   measure the dirt against — a reference rather than an eyeball.
2. **`dprtest --gate` has never run with a camp pitched.** It queued behind six
   authors' captures all round and the figure was never taken.
3. **The fire is small at midday.** It reads at dusk and at night, where it is
   the only light; in daylight it has to win on saturation and motion and does
   not yet.
4. **The smoke reads as a dark dithered mass from directly overhead at dusk**
   (`shots/camp/dusk4/plan.png`).
5. **The fire's crackles are ~25 dB under their own numbers, and nobody has
   ever heard them.** `CampAudio.update` gates the entire layer on
   `camp?.fire`, and `Camp` had no `fire` getter — only each camp *record* had
   one — so `lit` was always 0 and the fire has never made a sound. The getter
   is there now, which is what made the second half measurable: the crackle
   gains in `_crackle` are nominal, not resulting amplitudes. Pink noise
   through a Q 5.5 band loses about 25 dB before it reaches the bus, so forty
   forced crackles at level 0.167 peak at -49.9 dBFS where the numbers imply
   -25. `camp_props.js` corrects exactly these two losses (`bwGain`,
   `_srcNorm`) and the same treatment would suit the crackles — but that is a
   change to a shipped layer's mix, so it is left for whoever owns it.
   Measured by `tools/_scratch/camppop.mjs`, which prints the figure on every
   run. Nothing caught this earlier because `audiotest.mjs` does not read the
   `camp` tap and the Sound Lab had no camp entry to select; both now do.

## The lesson from this round

Five instruments produced clean numbers about the wrong object — see the new
"Instruments that are confidently wrong" section in `docs/CRITIC_PROTOCOL.md`.
The one to remember: a chair-arc census reported a 257-degree spread because it
sorted bearings across the ±pi seam, and 257 degrees is exactly the sort of
figure that gets a working layout solver rewritten.

---

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

# State — 2026-08-22, the eight-issue round

Eight player-reported defects, one worktree agent each, an independent critic
per task, and blind A/B for every visual claim. **Seven landed. Golden hour did
not, and was reverted on its own evidence** — see the last section.

## What landed

| # | Defect | What it actually was |
|---|---|---|
| 1 | wind too loud | **Dynamic range, not level.** At its worst instant the wind bed alone was **+1.3 dB over the entire rest of the mix combined**, parked with the camper idling. Two earlier rounds cut `buses.ambience` and failed because the old share metric divided by a mix containing its own numerator. Gust-to-calm: grass 18.6 → 5.8 dB, conifer 19.9 → 3.9, hush 12.8 → 4.7. The calm floor came **up** (p5 −53.0 → −48.6) while the peak dropped 8.4 dB. |
| 2 | free camera in photo mode | New `free` mode. Entry is bit-identical — `dPos [0,0,0]`, quaternion 9.99e-16 — measured while the chase camera was still drifting 0.0032 m/frame, so the zero is the code holding, not a still world. Middle-drag pans at one world unit per screen unit; no auto-orbit. |
| 3 | click the fire to refocus camp | Done — and it exposed a **pre-existing bug**: `_updateFocus` early-returned when `_focusCamp` was null, so `main` had no click-to-focus path at all and "click the car to come back" failed **34 of 117** pointer positions. Now 0. Photo mode also never set `input.suppressed`; held W dragged the camper **29 m** out of frame. |
| 4 | 05:45 washed out | **Not the light rig.** `Grass.js`/`GroundCover.js` copied `sun.color` but never read `sun.intensity`, and 65% of the translucency pigment is a hardcoded amber `uGlowCol 0xffa235` — so the meadow glowed salmon while the key measured **decisively blue** (`(0.175,0.192,0.265)` at intensity 0.234). An earlier ablation under-read it because it scaled `uSunColor`, which never reaches `uGlowCol`. Blind: **27 for / 6 against / 23 ties** over 56 judgements, all twelve pre-dawn eye-level calls and five of six night calls for the fix. Night improved too. |
| 6 | tree pop-in | The mid LOD binned as `mid[species*5 + (pvar % 2)]` — **three trees in five got a prototype grown from a different seed** at 84 m. Boundary IoU 0.379 → 0.671, crown height Δ 14.3% → 0.3%. Costs +38 draw calls and *fewer* triangles. The 255 m mid→far boundary is still unfaded; design and corrected price (**+20.2%** of mid instances, not the +9.9% first estimated) are in the `rebuildMove` note. |
| 7 | waterfalls | Flow was correct on load, **reversed by 45 s, frozen by 150 s**. Separately, **11 of 28 falls** had `bottom[1]` literally `-9999`, putting plunge points 10 km down and audio emitters at ≈ −6712 m — no spray, mist, churn or sound. The dusk apron wedge was **not** the `climb`/`bench` gate two notes had blamed: forcing the fragment opaque kept the straight edges, so it is the apron **mesh** floating over chute walls and being sliced by the depth test. |
| 8 | harsh, flickering shadows | Two causes. The texel snap **was not snapping** — it rounded world X/Z with `focus.y` raw, and at a 16° sun the light's up axis is near vertical (mean fractional texel 0.203, where 0.25 is unsnapped). And the extent re-fit every frame, walking 414 → 433 m in twelve steps. Crawl under camera motion → **0.00%**, verified live by deliberately breaking `_holdExtent` and watching it climb back to 3.51%. Depth-pass wind is damped, not frozen: `sway 0.5` keeps dapple moving at under half of main's flicker. |

## Golden hour (5) — attempted five times, measured, still not landed

`hemiI` runs **1.16 at h18.3 against noon's 0.90** while the key falls to 60% of
noon. That is backwards and it is why the terminator is weaker at golden hour
than at midday: at `meadow`-18:15, **77.9% of ground sits in cast shadow at 88%
of the lit value**, against 14% at ratio 1.41 at noon. Three earlier rounds all
attacked this by raising `sunI` (one went to 3.90, *above* noon) and all three
lost their blind test; the key arrives near-white at `#d5c7bf`, 1:0.934:0.897,
so raising it lifts and desaturates rather than warms.

Cutting the fill instead (0.98/1.16/1.10 → 0.88/0.84/0.86) was the first untried
knob. Three blind judges across two independently built sets:

| judge | views | fix | baseline | tie |
|---|---|---|---|---|
| A | sunlow, hero | **10** | 0 | 2 |
| B | all four | 4 | 2 | 6 |
| C | meadow, drive, river | 0 | **7** | 11 |

**The split is by framing, not by hour.** Vistas gain a terminator; eye-level
framings lose one. Two judges who never saw each other's frames independently
condemned `drive` at 18:15 in nearly the same words — "dimmer AND flatter, muddy
not moody" and "dim and muddier, the ground flattening into uniform brown."
`drive` is the view the player spends the game inside. Reverted in `43b001c`.

### Round 5 — the knob is not in this file, and here is the sweep that says so

Round 5 was sent to try exactly what the paragraph above proposed: a warmer and
lower `hemiGnd`, a cooler `hemiSky`, the counter-key `fill`, and `fogD`. It
landed nothing, because **every one of those knobs moves the eye-level
terminator the wrong way or not at all**, and the sweep that shows it is
`tools/_scratch/termstat.mjs` (new — it is sepdiag's frozen-instant, ground-
masked method, but it reports the *shadowed fraction* and the class-mean
lit/shade ratio rather than the deepest decile).

`meadow`-18:25, `lit/shade` over ground pixels. Baseline is **1.084**:

| setting | meadow | drive | hero |
|---|---|---|---|
| **as-is** | **1.084** | 1.494 | 1.553 |
| `hemiI` → 0.001 | 0.984 | 1.632 | — |
| `hemiI` → 0.60 | 1.019 | 1.600 | — |
| `hemiI` → 1.45 | 1.034 | 1.447 | — |
| `hemiSky` → dark | 0.995 | 1.638 | — |
| `hemiGnd` → dark | 1.025 | 1.523 | — |
| `hemiGnd` warm + `hemiI` 0.98 | 1.028 | 1.507 | — |
| `hemiSky` warm, same luma | 1.024 | 1.440 | — |
| `hemiSky` warm, +9% luma | 1.024 | 1.353 | — |
| `hemiSky` → neutral | 1.029 | 1.461 | — |
| counter-key `fill` → 0 | 1.086 | 1.504 | 1.621 |
| counter-key `fill` × 2.2 | 1.081 | 1.437 | 1.485 |
| `fogD` → 0.0015 | 1.056 | 1.370 | 1.633 |

**The entire reachable range at `meadow` is 0.98 – 1.086 and the shipping value
is already at the top of it.** Noon is 1.173. No combination of evening
keyframes gets golden hour's eye-level terminator back to midday's, let alone
past it. Note also that raising *and* lowering the fill both lower it — the
hemisphere lights the lit class more than the shaded class at eye level, so
attempt 4's `hemiI` cut was not a taste failure, it was moving a number that
points the other way. `hemiGnd` in particular has almost no authority down
there: darkening it to `0x402c1c` moved `meadow`'s lit ground by 4%, against
19% for the same move on `hemiSky`.

**Where the knob actually is.** Measured at `meadow`-18:25, same instrument,
holding everything else fixed:

| setting | lit/shade | lit ground |
|---|---|---|
| as-is | 1.084 | 0.492 |
| `sun.shadow.intensity` 0.44 → 0.85 | 1.211 | 0.491 |
| grass `uShadowSoft` 0.68 → 0.15 | **1.417** | 0.488 |
| `sunI` +45% | 1.251 | 0.540 |

The grass shader's shadow attenuation alone takes the terminator past noon's
**with the lit ground luminance unchanged to three decimals** — which is the
exact shape of fix this defect has been asking for and the only one measured
that does not pay for contrast in level. `sunI` buys ratio by lifting the whole
frame, which is what blew rounds 1–3 out to pale pink.

This also explains the framing split in the table above. At eye level the frame
is *grass*, and `grass_material.js` lights its body from `uSunColor`,
`uShadowSoft` and its own hardcoded `uSkyCol`/`uSkyFill` — it never reads
`hemiSky` or `hemiGnd` at all. At vista distance the frame is terrain and rock,
which the hemisphere does light, which is why `hero` responds strongly to every
fill move and `meadow` responds to none of them. Vistas gained a terminator in
attempt 4 for a real reason; eye level could not have.

Look at `sunlow`-18:25 and count the conifers standing in the meadow that cast
no visible shadow on the grass. That is the defect, and it is a grass-shader
number.

**For the next attempt:** stop tuning `Lighting.js`. The candidate is grass and
cover `uShadowSoft` at the evening hours, possibly paired with a modest lift in
`sun.shadow.intensity`, and it must be judged on `drive` and `meadow` because
both are already dark and the failure mode is mud. Do NOT pair it with a fill
cut — the sweep above says a fill cut costs eye-level level for nothing.
One caution the sweep also found: at **18:15** specifically, `meadow` is 72.8%
shadowed and `lit/shade` is 0.979 — the shadowed class is *brighter* than the
lit class, and `uShadowSoft` does not help there (0.979 → 0.969) because the lit
class has shrunk to a sliver. 18:15 at that anchor is not a contrast problem,
it is a sun-elevation/occlusion fact; judge the fix at 18:25 and later.
Guards were clean on all three of round 4's judges, so noon and night are still
not the constraint.

## Three instrument traps this round, all of which produced clean wrong numbers

- **`tod.mjs` ignored `AUTUMN_URL`** while every other tool honoured it, so a
  before/after sweep silently sent both arms to a third worktree's server. The
  frames were real and the means agreed to four decimals, which reads exactly
  like a change that does nothing. It nearly caused the working grass fix to be
  discarded. Fixed in `a283cf8`.
- **`git stash` is one stack shared across all worktrees.** Three agents had
  live work stashed at once; a bare `git stash pop` takes the *top* entry, i.e.
  another agent's files. Caught before damage.
- **Vite silently auto-increments off a busy port**, serving a different
  worktree's code to a harness that thinks it is measuring its own. Cost one
  critic four minutes and one agent a whole arm. `--strictPort` everywhere now.

Also unresolved and worth a decision: **`WorldConfig.SEED` is `20262018` while
every bake in `public/bakes/` is `20261018`**, so a default boot misses the cache
and bakes a world live. Every tool this round had to pin `?seed=20261018`.

**No frame-time figure from this round is trustworthy.** Six agents shared one
machine and `ablate.mjs` disqualified itself on its own assertions every time —
baseline drift 5–35 ms, "camper has not come to rest", "still streaming". The
structural indicators (draw calls, triangle counts, program counts) are fine and
are quoted per task; no millisecond claim survived.

---

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

# Camping Season — state at the performance pivot
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

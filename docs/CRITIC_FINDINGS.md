# Critic pass 3 — 2026-08-19

`SHIP 0 · CLOSE 3 (drive, meadow, peaks) · REJECT 7`

Blind A/B round21 vs round39: **10/10 for the newer build, no regressions.**
Every artifact the critic named pre-reveal landed on the old side, which
independently confirms three fixes: the black square, the ground-cover winding
bug, and the gold contour ribbons as such. The visible world edge did not appear
in ~30 frames — fixed.

Improvement is real. The bar is still not met.

## Ranked blockers

1. **rocks — every crag renders near-black warm brown, in isoline chains.**
   Measured `srgb(66,49,43)`, ratio 1:0.746:0.656 — red-led brown at roughly a
   quarter of the *shadow* anchor `#5c5a75` (1:0.98:1.27). The banned brown-grey,
   three stops too dark, receiving no aerial perspective at any distance. Several
   blocks visibly detached with sky beneath. Confirmed by hiding the system.
2. **look+grade — the cool cast-shadow mass still does not exist in pixels.**
   `drive` shadow `srgb(110,71,66)`; `meadow` shadow `srgb(135,78,52)` is
   *warmer* than its own lit grass. Plate 3's shadow is `srgb(25,60,98)`,
   1:2.4:3.9. Cool measures 0.2–0.6% against the plate's 22.3%.
   **A constant-luminance hue mix cannot reach this** — plate 3 attenuates red
   ~6× while lifting blue ~2.4× in absolute terms. `shadowCoolAmt = 0.55` sits
   inside the neutral crossing point the file's own comment identifies.
3. **look+grade — ground colour is right at one hour in four.** Same patch:
   h17.2 `1:0.730:0.336` (matches the `#f0ad46` anchor), h7.4 salmon
   `1:0.606:0.459`, h18.6 brick `1:0.495:0.379`, h12 washed cream.
4. **look+grade / sky — rose/magenta overshoot.** `vehicle` 40.3% of chromatic
   pixels rose+magenta, `dawn` 25.7%, `hero` 17.1%, against plate 1's 0.2%. The
   cool half is arriving as candy pink in the distance instead of blue-violet in
   the cast shadow — the same error, one hue family over.
5. **groundcover + grass + terrain — bare substrate at 2 m**, unfixed from pass 2.
6. **terrain — massif bodies have no structure at any scale** (with rocks hidden,
   a smooth cone whose only incident is heightfield terracing), plus stretched-UV
   smears down the slopes.
7. **trees + grass + groundcover — no rim or translucency in the backlit frame.**
   Also true with trees hidden, so it is not only a trees problem.
8. **terrain — gold isoline caps on rock**, present with rocks hidden.
9. **wildlife + sky — unlit, unfogged specks.** ~25 pure-black bird glyphs at
   200 m with no attenuation while the trees beside them are hazed; leaf
   particles a separate offender, one ~50 px and three stops too dark.
10. **look+grade — the vistas are washed.** `hero` P05 0.359 / range 0.463 vs
    plate 1's 0.161 / 0.705. The black-lift correction overshot.
11. **trees — conifer value is a range, not a species.** `srgb(151,169,87)` in
    `waterfall` (the *lightest* mass in frame) vs `srgb(69,78,43)` in `forest`.
12–14. **water** — no plunge or spray; hard aliased shorelines; no reflections.
15. **groundcover — scrub reads as a black faceted scribble** with no internal
    value range. The winding fix restored directional response; form and value
    did not follow.
19. **perf — reproducible across two runs:** geometry grows +134/+146 over 40 s
    without plateauing, five shader programs compile mid-drive, four frames over
    100 ms (worst 252 ms) in bursts.

Polish: birch trunks at 55–65% of the near-white anchor; uniform grass hue and
blade form; uniform scatter with no size hierarchy; HUD speaks two visual
languages (warm settings sheet vs cold navy dash); audio wildlife bus at -inf
while 25 birds are on screen and rivers 22 dB under the engine.

## Two things that finally landed

**Motion verification works** — `--eval "window.__settle(900)"` advances the sim
before capture. River surface 68.3% changed over 15 s, meadow grass 47.5%. The
protocol's motion check had never had a working path before.

**`drive`'s lit ground hits the meadow anchor** at `1:0.707:0.342` against the
reference's `1:0.68:0.36` — the first time this project has matched it.

## The black square

**`0/10` black frames sampled during motion across two 40 s runs. The NaN class
is gone from the headless harness.** The player still sees the artifact roughly
every 1–6 seconds while driving. Therefore it is *not* reproducible in the
configuration every test here uses — which points at the HUD (hidden in every
capture this project has ever taken, because it hides itself on the same flag
the harness sets) or at something else browser-specific.

## Do not trade these away

The camper asset and its framing; the settings sheet; `drive`'s ground colour;
the water surface animation; the canopy hue variety in `meadow` and `drive`;
draw calls and driving triangle counts now inside budget.

---

# Critic pass 4 — 2026-08-19 (round 048)

`SHIP 0 · CLOSE 4 (#1 rock colour, #4 rose overshoot, #11 conifer value, part of #12) · REJECT the rest · 1 NEW REGRESSION CLASS`

## The headline: round 048 loses its own blind A/B

30 blind single-view pairs, cropped out of the contact sheets, shuffled by
`randomBytes`, judged before the key was read. 048 against 045, 040 and 035,
all ten views each.

| against | 048 wins | older wins | tie |
|---|---|---|---|
| 045 | 1 (meadow) | 5 (peaks, drive, forest, river, waterfall) | 4 |
| 040 | 3 (peaks, backlit, forest) | 7 (hero, drive, meadow, river, waterfall, vehicle, dawn) | 0 |
| 035 | 4 (peaks, meadow, forest, vehicle) | 6 (hero, drive, backlit, river, waterfall, dawn) | 0 |
| **total** | **8** | **18** | **4** |

Pass 3 reported 10/10 for the newer build. This is 8/30 against, and the bias
ran the *other* way: I had already seen the 048 sheet in full before judging, so
recognition favoured 048 and it still lost. Definition-of-done item 6 — "a harsh
critic, comparing blind against the previous version, picks yours" — fails at
three different lookbacks.

Two independent causes, both confirmed by measurement afterwards.

### 20. BLOCKER — the ground lost its shadow structure between 040 and 045, and nobody noticed

The one thing I picked the old build for over and over (`drive`, `vehicle`,
`meadow`, `dawn`) was a large soft cast-shadow mass on the ground. It existed at
035 and 040. It does not exist at 045 or 048.

Ground region only (`drive`, lower 52% of frame), across rounds, against
plate 1's gold meadow:

| | 035 | 040 | 045 | 048 | plate 1 meadow |
|---|---|---|---|---|---|
| `lumaP05` | 0.301 | 0.275 | 0.385 | **0.390** | **0.184** |
| `lumaRange` | 0.368 | 0.390 | 0.318 | **0.314** | **0.541** |
| `contrastStd` | 0.109 | 0.122 | 0.102 | **0.101** | **0.177** |

Between 040 and 045 the meadow's black point lifted 0.115, its range shrank 20%
and its contrast fell 17% — **away from the plate on all three axes at once.**
The reference meadow has 1.9× our contrast and 1.76× our range. Our entire
tonal spread (0.307 at full frame) is smaller than the gap between our black
point and the plate's (0.219).

Why it happened is legible in the hue histograms. At 040, `vehicle` put **37% of
its chromatic pixels in rose** and `drive` 11.7% — that was pass-3 blocker #4,
the rose/magenta overshoot. Someone fixed #4 by taking the rose out: at 048 it
is 3.9% and 0.7%. But the rose *was* the shadow mass. Removing the hue removed
the shape. Cool blue-family (azure+blue+violet) in `drive` went 4.0% (035) →
0.5% (040) → 2.4% (048), against plate 3's 17.1%. So the mass has now been
attempted in blue (035, oversaturated, pulled back at 036), then in rose (040,
overshot, removed at 044/045), and currently does not exist in any hue.

**This is the regression everyone stopped seeing**, and it is the most expensive
finding in this pass: a *structural* feature was deleted in order to fix a
*colour* error. The correct target, measured on plate 3, is a shadow mass at
`srgb(15,58,100)` (1:3.87:6.67) and a softer one at `srgb(59,70,83)`
(1:1.19:1.41) — deep, blue, and covering ~40% of the ground. Plate 1's meadow
shadows are a different animal, warm at `srgb(205,156,57)` (1:0.76:0.28) against
lit `srgb(237,162,91)`. Both are *large* and *shaped*. Ours, measured under the
tree in `drive`, is `srgb(158,120,54)` against lit `srgb(208,168,77)` — 76% of
lit luma, marginally *warmer* than the grass it falls on, and formless. The
frame reads as if the sun were directly overhead through cloud.

Do not fix this by tinting. Fix the area and the shape first, then argue about
hue.

### 21. BLOCKER — `waterfall` went grey between 040 and 045

| | 040 | 045 | 048 | plate 5 (rock-dominated eye-level) |
|---|---|---|---|---|
| `chromaMean` | 0.219 | 0.182 | **0.178** | **0.302** |
| `neutralPct` | 5.0 | 40.4 | **36.6** | **18.2** |
| red (% chromatic) | 48.2 | 8.4 | **8.4** | 47.6 |
| `contrastStd` | 0.153 | 0.145 | **0.136** | 0.142 |

A third of this frame is now grey pixels, at 59% of the reference's saturation,
with 82% of its red-family pixels gone. Plate 5 is the plate this view should be
judged against — same subject, rock and water and gold grass — and it is a
*colourful* picture. `waterfall` is the least autumnal frame in an autumn game.
`forest` (`chromaMean` 0.183) is as bad and always has been, so it is not a
regression there, just a standing failure.

`hero` 0.244 → 0.229 and `dawn` 0.235 → 0.209 over the same rounds, both further
from plate 1's 0.293. **Eight of ten views now measure below the reference
`chromaMean` band of 0.28–0.42, and four (`forest` 0.183, `waterfall` 0.178,
`dawn` 0.209, `hero` 0.229) breach the brief's own hard floor of 0.25.**

## Per-view, against the plates

### hero — vista, judge against plate 1
- **BLOCKER.** No aerial recession. The ridge 500 m out and the ridge 4 km out
  sit at the same value and the same chroma; plate 1 has four clearly separated
  depth steps. Measured: `lumaP05` 0.339 vs plate 1's 0.161, `lumaRange` 0.495
  vs 0.705, `contrastStd` 0.168 vs 0.218, `chromaMean` 0.229 vs 0.293. Pass-3
  blocker #10 said 0.359/0.463 — thirty rounds later it is 0.338/0.495. Not
  closed, and barely moved.
- **HIGH.** The far ranges are airbrushed. Continuous cream-to-tan gradients with
  no plane changes and no strata over the whole upper half. Plate 1's ranges read
  as flat masses separated by soft edges — that is what makes it look painted.
  Ours reads as a shaded relief map.
- **HIGH.** Cream "snow" runs down to meadow height on the left ridge with no
  snowline. It is a lighting response, not a material, and it looks like it.
- **MED.** The lake at 62%/57% is a flat pale-blue quadrilateral with a straight
  hard edge lying on the terrain like a sheet of paper.
- **MED.** Gold isoline caps still present along the ridge at 50%/47% and
  72%/60% — pass-3 blocker #8, not closed.

### peaks — vista
- **BLOCKER.** The rock necklace is back. At 43–63% across, 20–40% down there is
  a chain of ~14 pale angular blocks on the massif face; several have visible sky
  or void beneath their lower edge, none casts a shadow onto the face, and they
  measure warm-tan (1:0.86:0.84) against a cool grey cliff, so they read as
  spilled polystyrene rather than as outcrop. Commit `82cc330` closed the
  necklace on one view; it is open on this one.
- **BLOCKER.** The massif body is a smooth cloth drape — soft folds, zero
  faceting, no strata at any scale. Pass-3 blocker #6, not closed.
- **HIGH.** The gold hillside on the right two-fifths of frame is a completely
  bare smooth slab: no grass, no scrub, no rock, from 250 px to the frame edge.
  Flat violet lozenges are pasted on it at 85%/45% and 88%/70% that read as
  decals, not as shadow or rock.
- **MED.** Foreground foliage is uniform-scale confetti — every canopy blob
  within ±20% of the same size. Plate 1's foreground trees span a 5:1 size range.
- **MED.** vs 045: `chromaMean` 0.272 → 0.257, `vividPct` 42.5 → 37.9, cyan 4.7%
  → 0.1%. The lake lost its saturation. 045's read as water; this reads as slate.

### drive — eye-level, judge against plate 3
The best frame in the game; the canopy hue variety and the gold are right.
- **BLOCKER.** See #20. `contrastStd` 0.118 is below the reference band's floor
  of 0.13 — the flattest frame here except `dawn`.
- **HIGH.** Grass is one hue, one blade shape and one height across 200 m, with
  density as the only variable. Plate 3's near grass carries an olive/gold
  two-tone and a clear blade-size ladder.
- **MED.** The distant ridge at 55–82% across is flat salmon-brown with no snow
  and no value break — brown cardboard.
- **MED.** The blue-violet flower specks are single-pixel at this resolution and
  read as stuck pixels, not flowers. Give them a minimum screen size or fade
  them out.
- **MED.** Birch trunks are thin pale grey-blue and disappear at 40 m. The brief
  calls near-white trunks a signature; plate 3 uses them as the compositional
  spine.

### meadow — eye-level, plate 3
Best-measuring eye-level frame (`lumaP05` 0.184, range 0.598, `contrastStd`
0.175, all in band).
- **BLOCKER.** The near grass is literal flat isoceles triangles — hard-edged,
  uniform size, uniform pale gold, no root-to-tip value gradient. At 2 m this is
  the most amateur thing in any frame. Definition-of-done item 3 fails.
- **HIGH.** The dark-green scrub clumps at 66–86% across are flat cardboard
  cut-outs with no internal value range at all. Pass-3 blocker #15, not closed —
  the winding fix restored directional response and form never followed.
- **MED.** Bare unmodulated brown substrate visible between blades across the
  whole mid-ground. Pass-3 blocker #5, not closed.
- **MED.** Detached white slabs on the cliff at 16–28% across, 5–15% down.
- **MED.** The stump at 3%/62% is a smooth untextured cone.

### backlit — judge against plate 4
- **BLOCKER.** Still no rim light, no translucency, nothing. The big conifer at
  12–27% across is directly between the camera and the sun and its needles are
  opaque flat dark green with no edge glow. Pass-3 blocker #7, not closed. The
  brief says "budget for it"; nothing has been spent.
- **HIGH.** The ground is one salmon value from 2 m to 200 m. Plate 4 also goes
  near-monochrome, but its near rocks sit two to three stops below the haze —
  it has a value ladder inside one hue. We have a hue with no ladder.
- **HIGH.** ~8 pure-black elliptical specks on the ground and in the sky
  (51%/71%, 58%/76%, 6%/81%, 32%/84%, 84%/10%, 90%/9%, 96%/11%) at full black
  against salmon, unlit and unfogged. Pass-3 blocker #9, not closed.
- **MED.** The tan tree at 26–48% across is the worst asset in the game: flat
  beige-brown discs on a stick, reading as a dead mud blob in the brightest part
  of the frame.

### forest
- **BLOCKER.** `chromaMean` 0.183 — 60% of the reference floor, the most
  desaturated frame in the game, and it looks like a different title from
  `drive`. It has measured 0.179–0.183 since round 040; nobody has touched it.
- **BLOCKER.** The grass is identical pale-yellow triangles at uniform size,
  uniform hue and near-uniform spacing over the entire mid-ground. Three of the
  brief's named anti-patterns in one system.
- **HIGH.** Stretched-UV smears clearly visible as vertical streaks on the cliff
  at 47–56% across, 24–46% down. Pass-3 blocker #6, not closed.
- **MED.** The lake's top edge against the far bank is hard and aliased with no
  shore transition. Pass-3 blocker #13, not closed.
- **MED.** Bare brown substrate between blades at 31–55% across.

### river
- **BLOCKER (known, author on it).** The hillside is covered in hundreds of flat
  quadrilateral cards — pale tan parallelograms with sharp corners taking a
  specular-ish hit, up to 80 px wide at 1280. Confirmed exactly as reported:
  cardboard scraps. It occupies the left half of the frame.
- **BLOCKER.** The slope carries a diagonal moiré/banding artifact running
  lower-left to upper-right across 8–47% of frame width. Not the cards — the
  terrain surface itself.
- **HIGH — corrects the working hypothesis.** The grey angular plate at 68%
  across / 38% down is **not clipping geometry.** It is a rock instance behaving
  as `RockScatter._place` intends: `maxDrop = size * 3.0` at line ~1205 clamps
  how far a block may follow its ring minimum, and the comment right above it
  says so — "the downhill half projects — an overhang". On a bank this steep the
  overhang is most of the block, and what projects is a single flat unbroken
  facet with a straight horizontal top edge, no silhouette break, no aerial
  perspective, and no cast shadow onto the bank. It reads as a discarded concrete
  block. The clamp is not wrong in principle; the exposed face has no treatment.
- **MED.** A 1-px dark hairline runs ~200 px up-and-right from that slab across
  lit gold ground — degenerate triangle or shadow acne on a thin edge.
- **MED.** The water is flat navy with one lighter band: no flow lines, no foam,
  no reflection, hard aliased right bank at 82–100% across.
- Note: `river` measures almost exactly like plate 3 (`lumaMean` 0.360 vs 0.372,
  `lumaP95` 0.622 vs 0.604, `contrastStd` 0.138 vs 0.134) and looks nothing like
  it. Textbook measures-right-looks-wrong; do not defend this frame with numbers.

### waterfall
- **BLOCKER.** See #21 — grey, desaturated, 36.6% neutral.
- **BLOCKER.** The "dark vertical band" beside the falls is a **khaki chain of
  overlapping spheres** running the full height of the cliff, immediately right
  of the curtain, measured `srgb(142,128,126)` against cliff `srgb(159,148,159)`.
  It reads as a rope of sausages glued to the rock. It is the single most
  obviously broken object in any frame in this round. It is warm where the rock
  is cool, so it is not the rock material.
- **BLOCKER.** The massif is smooth wax. Two soft melted lobes at 55–70% across,
  12–26% down are pure shading gradient with no geometry behind them. Plate 5's
  rock is faceted with hard plane breaks and that is what makes it read as stone.
- **HIGH.** Depth of field has blurred the entire cliff, the spray and the far
  bank into mush while the conifers stay sharp. That is a photographic effect in
  a game whose art director's one recorded note was "yours is too realistic". It
  is also what is driving the neutral/desaturated measurement.
- **HIGH.** A cloud of ~40 hard-edged orange leaf dots hangs in front of the
  blurred cliff at 18–26% across, fully sharp against a blurred background —
  they read as sensor dust. Wrong depth, no fog, no DoF.
- **MED.** Flat parallelogram rock slabs with straight top edges at 6%/78% and
  31%/44%.
- **CLOSING part of #12:** the plunge now exists — the curtain widens into spray
  and there is a pool. Credit where due; the rest of the frame buries it.

### vehicle — eye-level, plate 5
The camper asset and its framing remain the best thing in the project.
- **BLOCKER.** The camper casts no shadow. The sun is clearly from frame-left
  (lit left flank, shaded rear), the vehicle sits on an open slope at golden
  hour, and there is no directional shadow at all — a faint darkening under the
  chassis and nothing else. A vehicle with no shadow is a sticker. (`VehicleShadow.js`
  is untracked in the tree, so someone is on it; it is not in this build.)
- **HIGH.** Grass is hard-edged pale-yellow spikes standing on flat bare
  red-brown dirt with the dirt fully visible between them. Plate 5's gold is a
  solid mass. Ground `contrastStd` 0.100, `lumaRange` 0.299 — same flatness as
  `drive`.
- **HIGH.** ~25 dark leaf specks across the sky, all the same size, at full
  opacity, unfogged, against a pale sky. #9 again.
- **MED.** The distant ridgeline is the same triangular tooth repeated ~14 times
  across 65% of the frame width. It reads as a noise function, not as mountains.
- **MED.** Gold isolines pour over the rock outcrop lip at 22–42% across like
  icing. #8 again.
- **MED.** The birch at 89–95% across is a bare pole with a canopy floating at the
  top — no branches at all.

### dawn — vista, plate 1
- **BLOCKER.** The flattest, most desaturated frame in the game: `chromaMean`
  0.209, `contrastStd` 0.132, `lumaRange` 0.411, `lumaP05` 0.377, against plate
  1's 0.293 / 0.218 / 0.705 / 0.161. 71% of the chroma, 61% of the contrast, 58%
  of the range, and no dark value anywhere in frame. The nearest massif and the
  range 4 km behind it sit at the same value, so there is no depth ladder at all.
- **HIGH.** Orange patches are splatted across the far ranges with hard irregular
  edges that bear no relation to the form — they read as lichen stains, not as
  lit slopes. Same defect as the isoline caps, at vista scale.
- **MED.** Foreground is same-size conifer confetti at near-even spacing.
- **MED.** The lake at 60%/58% is another flat grey-blue paper lozenge; the
  waterfall at 91%/78% is a 2-px white line.

## Closed

- **#1 — rocks near-black warm brown. CLOSED.** Pass 3 measured `srgb(66,49,43)`,
  1:0.746:0.656. Now: `waterfall` cliff `srgb(159,148,159)` 1:0.93:1.00, `peaks`
  massif `srgb(141,122,121)` 1:0.87:0.86, `hero` massif front `srgb(136,116,117)`
  1:0.85:0.86. Plate 5's rock is `srgb(176,164,161)` 1:0.93:0.91. The banned
  brown-grey is gone and the value is in the right neighbourhood. Residual, not a
  blocker: lit rock sits ~1 stop under the `#c3bfcc` anchor and shadowed rock is
  warm-neutral (1:0.85:0.86) where the `#5c5a75` anchor asks for lavender
  (1:0.98:1.27). The *placement* half of #1 is not closed — see peaks.
- **#4 — rose/magenta overshoot. CLOSED, and read #20 before celebrating.**
  `vehicle` rose+magenta 39.2% (040) → 5.1%; `hero` 17.1% → 5.8%. The number is
  fixed. The fix deleted the shadow mass along with it.
- **#11 — conifer value is a range, not a species. CLOSED.** Pass 3 had
  `srgb(151,169,87)` in `waterfall` against `srgb(69,78,43)` in `forest`. Now:
  `waterfall` `srgb(112,108,68)`, `forest` `srgb(95,123,79)`, `drive`
  `srgb(126,122,92)` — luma 0.42/0.42/0.46, converged. Plate 1's conifer is
  `srgb(122,113,85)` 1:0.93:0.70 and `drive`/`waterfall` match it well. Residual,
  minor: `forest`'s conifers are too green at 1:1.29:0.83 against the plates'
  1:0.93–1.00.
- **#12 — no plunge or spray. HALF CLOSED.** The plunge and pool exist in
  `waterfall`. The curtain above them is still a constant-width ribbon.

## Ranked blockers for this round

1. **#20 — the ground has no cast-shadow structure, and it used to.** Measured,
   reversible, and it is why 048 loses its own blind A/B. Fix area and shape
   before hue.
2. **The waterfall's khaki sphere-chain**, plus #21's grey. One frame contains
   the most broken single object in the game and the least saturated pixels.
3. **`river`'s cardboard-card hillside and its diagonal moiré.** Known, in
   progress; the moiré on the terrain surface underneath it is a second defect
   and may not be on anyone's list.
4. **Near grass is flat triangles on bare dirt** (`meadow`, `forest`, `vehicle`).
   Fails "reads correctly at 2 m" outright, in the three views a player spends
   most of their time inside.
5. **The vistas are flat and desaturated** (`hero`, `dawn`, `peaks`): eight of
   ten views below the `chromaMean` band, four below the brief's hard floor, and
   `lumaP05` 0.34–0.39 against plate 1's 0.161. Pass-3 #10 has moved 0.02 in
   thirty rounds.

Runners-up, unchanged and unclosed: no rim light anywhere (#7); unlit unfogged
black specks in four views (#9); smooth wax massifs and stretched-UV smears (#6);
gold isoline caps on rock (#8); bare substrate at 2 m (#5); scrub as flat
cutouts (#15).

## Method note, so this pass is auditable

Pairs were cut from the archived sheets, magnified 1.55×, labelled A/B with the
side chosen by `randomBytes`, and the key written to a file that was not read
until every call had been made. Contamination declared: I had viewed the 048
sheet whole beforehand, which biases *toward* 048. All colour and tone claims
above are `tools/colorstats.mjs` or `tools/_scratch/crop.mjs` output, never
impression. The `river` slab diagnosis was checked against
`src/rocks/RockScatter.js` before being asserted, and it contradicts the
clipping-geometry hypothesis it was handed.

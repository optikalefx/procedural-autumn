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

---

# Critic pass 5 — 2026-08-19 (correction, extended lookback, and HEAD `d451616`)

`SHIP 0 · CLOSE 3 (meadow, drive, vehicle) · REJECT 7 · 1 pass-4 finding corrected · 1 new standing regression (backlit)`

## 1. Correction to pass 4 — the ground table judged `drive` against a vista plate

Pass 4 measured `drive`'s ground region against **plate 1's gold meadow**
(`lumaP05 0.184 / lumaRange 0.541 / contrastStd 0.177`). `drive` is eye-level
gameplay framing. `docs/DESIGN_BRIEF.md` line 119: *"Judge eye-level views
against plates 3/4/5 and vistas against plate 1, per plate, every time."* That
line exists because this exact substitution produced a crushed-black regression
earlier in this project. The target is withdrawn.

**Pass 4's measurement of our own frames is sound and reproduces.** Same region
(`drive` cell of the archived sheet, lower 52%), independently re-measured:
0.303 / 0.277 / 0.388 / 0.392 for `lumaP05` against its 0.301 / 0.275 / 0.385 /
0.390. Every axis agrees to ±0.003. The error is only in what it was compared
to.

### The corrected table

Ground region = lower 52% of the `drive` cell, measured off the archived sheets
so all rounds go through one downsample. `045` and `048` cross-checked against
the full-resolution `shots/round045|048/drive.png` and agree to ±0.011.
Plate columns are the lower 52% of the plate, full width, except the two named
plate-3 sub-crops. **No column is an average of plates.**

| | 035 | 040 | 045 | 048 | now | p3 meadow+shadow | p3 lit gold only | p4 | p5 | *(p1 meadow — pass 4's target)* |
|---|---|---|---|---|---|---|---|---|---|---|
| `lumaP05` | 0.303 | 0.277 | 0.388 | 0.392 | **0.377** | 0.163 | 0.186 | 0.381 | 0.489 | *0.152* |
| `lumaRange` | 0.366 | 0.388 | 0.316 | 0.311 | **0.312** | 0.378 | 0.372 | 0.232 | 0.408 | *0.577* |
| `contrastStd` | 0.108 | 0.121 | 0.101 | 0.100 | **0.094** | 0.125 | 0.119 | 0.071 | 0.123 | *0.186* |
| `P05/P50` | 0.52 | 0.49 | 0.63 | 0.64 | **0.64** | 0.48 | 0.45 | 0.83 | 0.58 | *0.23* |
| dark area %¹ | 13.9 | 21.0 | 11.2 | 10.9 | **10.8** | 25.5 | 13.4 | 0.3 | 8.3 | *30.5* |
| cool %² | 9.6 | 3.9 | 0.0 | 0.0 | **0.0** | 24.3 | 5.8 | 0.0 | 14.0 | *1.0* |

¹ share of region pixels below 75% of the region's own median luma — an
exposure-invariant proxy for "how much of the ground is in shadow".
² cyan+azure+blue+violet+magenta+rose as a share of chromatic pixels.
"now" = `shots/critic4`, HEAD `d451616`. Plate crops: p3 meadow+shadow
`0.15,0.28,0.60,0.34`; p3 lit gold `0.20,0.42,0.45,0.18`; p1 meadow
`0.35,0.45,0.40,0.40`.

### What survives, what is withdrawn

**Withdrawn:**

- *"The reference meadow has 1.9× our contrast and 1.76× our range."* Against
  the plates the brief actually names: plate 3 is **1.33× / 1.21×**, plate 5 is
  **1.31× / 1.31×**, and plate 4 is **0.76× / 0.74×** — against plate 4 we have
  *more* contrast and *more* range than the reference.
- *"Away from the plate on all three axes at once."* True against plate 3 only.
  Against plate 5 our ground's black point is **less** lifted than the
  reference's (0.377 vs 0.489), and plate 4's is 0.381 — statistically
  indistinguishable from ours.
- The 0.115 black-point "lift" between 040 and 045 is real as a *delta*, but it
  is not a departure from an eye-level reference; two of the three eye-level
  plates sit at or above where we landed.

**Survives, and is stronger evidence than what pass 4 cited:**

1. **Zero cool.** The ground region contains **0.0% cool-family pixels** at 045,
   048 and now, down from 9.6% at 035. Plate 3's equivalent region is 24.3%,
   plate 5's is 14.0%. Only plate 4 — the into-the-sun outlier — is 0.
2. **One hue.** **97.9%** of chromatic ground pixels sit in a single 30° hue
   bucket. Plate 3 spreads over five buckets, plate 5 over four. "Large areas of
   uniform colour" has been taken past its limit into a single-hue field.
3. **The shadow area halved.** Dark-area share went 21.0% (040) → 10.9% (048) →
   10.8% (now). At 040 it sat between plate 5's 8.3% and plate 3's 25.5%; it now
   sits at plate 5's floor. This metric is exposure-invariant and is the
   cleanest support for "the mass is gone".
4. **Exposure-invariant black point.** `P05/P50` was 0.49 at 040 — plate 3 is
   0.45–0.48 — and is 0.64 now, past plate 5's 0.58 and heading for plate 4's
   0.83.

**So: finding #20 stands. Its numbers do not.** The case is *area, hue count and
cool share*, not black point and contrast. Note the pass-4 caution about `river`
cuts both ways here: a region can measure inside a plate's band and still look
wrong, and `drive`'s ground now measures acceptably against plate 5 while
plainly having no large-scale value event in it.

### A measured warm target for the X2 work

`docs/INTEGRATION_REQUESTS.md` X2 asks for the mass back **in a warm hue**. That
hue exists in exactly one plate, so it is measured there and the plate is
declared: plate 1 is a vista, but it is the only reference that contains a warm
cast shadow lying on sunlit gold meadow at all — plates 3 and 5 put their
shadows in the cool half.

| | sRGB | ratio | luma |
|---|---|---|---|
| plate 1, lit gold meadow (`0.50,0.625,0.09,0.045`) | `srgb(244,166,89)` | 1 : 0.68 : 0.36 | 0.694 |
| plate 1, soft cast shadow on it (`0.50,0.735,0.09,0.055`) | `srgb(155,108,47)` | 1 : 0.70 : 0.30 | 0.446 |
| ours, `drive` 048, lit ground | `srgb(201,159,70)` | 1 : 0.79 : 0.35 | 0.633 |
| ours, `drive` 048, under the tree | `srgb(173,119,62)` | 1 : 0.69 : 0.36 | 0.496 |

The reference warm shadow is **64% of lit luma**, holds its red:green ratio
almost exactly (0.68 → 0.70) and drops its **blue** ratio 17%. Ours is **78% of
lit**, drops *green* by 13% and holds blue flat. The player's "soft yellow or
light brown" is a **deeper, marginally more saturated gold**, not a browner or
greyer one, and it is a third of a stop deeper than what we currently render.

## 2. Extended blind A/B — rounds 024, 029 and 033 against HEAD

The instruction was to look for a second X2 hiding further back. **There is not
one, and that is a real result.** Thirty blind pairs, ten views each against
rounds **024**, **029** and **033**:

| against | HEAD wins | older wins |
|---|---|---|
| 024 | 9 | 1 (backlit) |
| 029 | 8 | 2 (vehicle, waterfall) |
| 033 | 7 | 3 (hero, dawn, backlit) |
| **total** | **24** | **6** |

Combined with pass 4 (048 losing 8–18 to 035/040/045), the archive's shape is
now legible: **the build improved monotonically to about round 040 and has been
flat-to-down since.** Rounds 024–033 are decisively worse. Nothing before 034
is worth reviving wholesale.

**The six losses share one axis, and it is the same axis as #20.** Every frame
that beat HEAD did so on *distance separation or ground shadow structure*:

- **`hero` and `dawn` vs 033** — 033's far ranges are lavender/rose and sit
  clearly behind the grey mid massifs and the gold foreground: three separated
  depth zones. HEAD's far ranges are the same warm tan as the mid ranges and
  merge into them. This is pass-3 blocker #10 and pass-4's `hero` blocker, and
  it was *better thirteen rounds ago*.
- **`backlit` vs 024 and vs 033** — see below.
- **`vehicle` vs 029** — 029's ground is a solid gold mass with a treeline
  behind it; HEAD's is bare red-brown dirt with individual blades standing on
  it. HEAD's frame has a better composition and a worse surface.
- **`waterfall` vs 029** — 029 carried orange deciduous crowns and a legible
  near/mid/far stack; HEAD (at 048) was grey wax.

### NEW — `backlit` is a standing regression, not a standing failure

`backlit` is the only view that lost **two of its three** pairs, to rounds 024
and 033. It is also the view `tools/shot.mjs` labels in its own source as *"the
money frame for foliage translucency"*. What the older rounds had that HEAD does
not: 024 had legible orange backlit canopies with birch trunks reading as the
compositional spine; 033 had actual cast-shadow structure across the ground
(over-saturated blue, and still better than nothing) plus a stronger canopy.
HEAD's `backlit` is one salmon value from 2 m to 200 m with a beige blob tree in
the middle of it. Treat this as a second, smaller instance of #20 rather than as
"backlit has always been bad" — it has not always been bad.

### One thing the lookback settles

The cool-shadow experiments at 029/033 were **not** a lost good version. In
`drive`, `meadow`, `vehicle`, `forest` and `river` at those rounds the ground is
a *saturated navy field* — hue replacement, not tint, exactly what the brief
calls "a bug, not the style" — and I picked against it every time without
knowing which side it was. Whoever removed it was right to. The error was
removing the *shape* along with the hue, which is #20. Restoring 033's colour
would be a regression; restoring 040's area would not.

### Method and contamination, declared

Pairs cut from the archived sheets at 1.5×, side chosen by `crypto.randomBytes`,
all thirty shuffled by a crypto Fisher-Yates so pair order carried no round or
view information, key written to a file that was not opened until all thirty
calls were recorded. Contamination:

- I had read pass 4 in full before judging, which enumerates HEAD's defects in
  detail and therefore biases **against** HEAD. HEAD won 24 of 30 anyway.
- I had seen a 160×22 px caption sliver of each sheet (to verify cell order) and
  nothing else of 024, 029, 033 or 048 before judging.
- **Structural leak, and it is inherent to the design pass 4 used too:** with
  three lookbacks × ten views, the HEAD side recurs in every pair, so by the
  fourth or fifth pair the repeated image is identifiable as the common build. I
  noticed this at pair 04. A future pass should interleave old-vs-old decoys.

## 3. `forest` — verdict

**REJECT, and it got worse this round.** `chromaMean` 0.183 (048) → **0.154**
(now), against plate 3's 0.307 and the brief's hard floor of 0.25. `vividPct`
11.1 → **2.9** against plate 3's 31.2. It is the least saturated and least vivid
frame in the game by a wide margin, and it is now also the darkest
(`lumaMean` 0.351).

It is not "desaturated" in the sense the grade can fix. Three physical causes,
measured:

1. **The frame is yellow-green, and yellow-green is where chroma goes to die in
   this palette.** `forest` puts **43.7%** of its chromatic pixels in the
   yellow + yellow-green buckets (048; 30.1% now). Every other view in the game
   runs 0–12%, and the five reference plates run **0–8.1%**. That single number
   is the most out-of-family measurement in the project, and it is view-local,
   not global.

2. **The conifer needles are green-led where every reference conifer is
   red-led.** Measured at 3 m in `forest`: shaded needles `srgb(68,74,53)` =
   **1 : 1.09 : 0.78**, lit needles `srgb(126,145,121)` = **1 : 1.15 : 0.96**.
   Green exceeds red in both. Plate 1's near spruce is `srgb(153,130,109)` =
   1 : 0.85 : 0.71 and plate 3's near conifer is `srgb(137,102,90)` =
   1 : 0.74 : 0.66 — red exceeds green in the references at the same distance.
   Our own `drive` conifers measure `srgb(176,146,97)` = 1 : 0.83 : 0.55, i.e.
   red-led and correct.
   **Hypothesis, offered as a hypothesis and not as a diagnosis:** `forest` is
   the only canonical view with conifers inside 20 m, and the warm haze
   (`fogNear 0xe0b296` at h16) is what reddens them everywhere else. If so, the
   needle albedo is green-led and nine views are hiding it. The discriminating
   test before anyone edits anything: capture `forest` and `drive` with fog
   forced off and compare the same needle patch. Do **not** re-tint the albedo
   on the strength of this paragraph.

3. **There is no autumn in it.** Not one deciduous crown inside roughly 40 m;
   every tree in the near and mid field is conifer, and the only warm mass is
   the grass plus a thin gold strip on the far bank. Nine views carry orange and
   crimson crowns. This one reads as a different game, and no grade change will
   put colour into it that the placement did not put there.

Standing defects, unchanged: bare brown substrate between blades across the
whole centre slope; grass as uniform pale triangles at uniform spacing;
stretched-UV vertical smears on the cliff at 22–32% across, 22–32% down; the
lake's top edge hard and aliased with no shore transition.

**One thing not to do:** `forest`'s `lumaRange` (0.610) and `contrastStd`
(0.193) are already *above* plate 3's 0.408 / 0.134. It does not need more
contrast. The range it has is spent between sky and shadow, not on modelling
the masses in between.

**I withdraw one thing I nearly wrote.** I was going to say the trunks all
render at the same apparent width. Measured at y = 396: runs of 30, 3, 6, 3, 27,
19 and 32 px. There is a 10:1 ladder. The claim was false and the measurement
caught it.

## 4. HEAD `d451616` — what the six live authors have landed

Captured `shots/critic4` at 1280×720, HEAD `d451616`, 79 fps / 392 draw calls /
2.38 M tris.

**Closed or clearly moved:**

- **The khaki sphere-chain beside the waterfall is gone.** Confirmed on the new
  frame. That was the single most broken object in the round.
- **The camper casts a directional shadow.** `vehicle` now has a soft warm
  shadow under and downsun of the chassis, and the conifer beside it casts one
  too. #Blocker closed.
- **The depth-of-field mush is gone from `waterfall`** — cliff, spray and far
  bank are sharp. `neutralPct` 36.6 → **19.0**, against plate 5's 18.2: in band
  for the first time. Red-family pixels 8.6% → 38.1%.
- **`meadow` is the best frame in the game now.** Near grass has a root-to-tip
  value gradient and a height ladder, the gold is a mass rather than spikes on
  dirt, and the crimson maple gives the frame a subject. `chromaMean` 0.274 →
  **0.325**, `vividPct` 38.1 → **53.3**. This is the first eye-level frame that
  would survive a screenshot comparison. (Its ground dark-area still slipped
  22.3 → 20.4, so #20 is untouched here too.)
- **The `peaks` massif has strata.** Real plane breaks and vertical grooves
  where there was a cloth drape. Not closed — see below — but it is the first
  movement on pass-3 #6 in thirty rounds.

**Not landed:** X2. `drive`'s ground region is unchanged: `lumaP05` 0.377,
`contrastStd` 0.094, **0.0% cool**, **97.9% of chromatic pixels in one hue
bucket**. Whatever the look author is doing has not reached a capture yet.

**New and regressed:**

- **`forest` regressed** — see §3. `chromaMean` 0.183 → 0.154, `vividPct`
  11.1 → 2.9, `lumaMean` 0.425 → 0.351.
- **`waterfall` traded grey for dark.** `neutralPct` is fixed but `lumaMean`
  fell 0.612 → 0.450 against plate 5's 0.700 and `chromaMean` fell 0.181 →
  0.169. The massif now occupies ~45% of the frame as one warm-neutral grey at
  a single value; the frame reads overcast rather than golden-hour. Fixing the
  neutral share by darkening is not fixing it.
- **`peaks`: the rock necklace is back and worse.** A chain of ~15 pale tan
  angular blocks strung horizontally across the massif face at **47–62% across,
  20–33% down**, plus a second cluster at 62–68% / 24–30%. Warm tan
  (1 : 0.86 : 0.84 measured last pass) against cool grey cliff, none casting a
  shadow onto the face, several with void beneath the lower edge. Commit
  `82cc330` closed this on one view; it is open on this one, and it is now the
  most obviously broken object in the round.
- **`peaks`: the gold hillside on the right two-fifths is still a bare smooth
  slab** from 72% across to the frame edge — no grass, no scrub, no rock — with
  flat violet-grey lozenges pasted on it at 85–92% / 42–50% and 88–92% / 68–75%
  that read as decals rather than as shadow or outcrop.
- **`vehicle`: the ground is bare red-brown dirt with sparse blades standing on
  it** across the lower-left 40% of frame. Ground `contrastStd` 0.107,
  `lumaRange` 0.331, dark-area 8.7%. The camper finally has a shadow and it is
  standing on the worst surface in the round.
- **`river`: the cards are still cards and the moiré is still there.** Flat tan
  parallelograms with hard straight corners up to ~60 px wide across 0–45% of
  frame width, and fine regular diagonal striations running lower-left to
  upper-right on the terrain surface beneath them at 10–40% across, 20–50% down.
  The untreated grey overhang facet at 63–72% across / 33–42% down is unchanged,
  and the 1-px dark hairline still runs up-right from it.
- **`backlit`: still no rim light, still no translucency.** The conifer at
  8–25% across is directly between the camera and the sun and its needles are
  opaque flat mid-green with no edge glow. The beige blob tree at 15–45% across
  is still the worst asset in the game and still sits in the brightest part of
  the frame. ~6 unlit unfogged black specks remain in the sky.
- **Gold isolines still pour over rock lips** — `vehicle` at 24–42% across,
  22–27% down; `waterfall` at 48–58% across, 40–48% down. Pass-3 #8, five passes
  open.
- **Chroma is going the wrong way overall.** Seven of ten views are below the
  reference `chromaMean` band of 0.28–0.42, and four are below the brief's hard
  floor of 0.25: `forest` 0.154, `waterfall` 0.169, `dawn` 0.209, `hero` 0.230 —
  with `river` (0.250) and `peaks` (0.251) sitting exactly on it. Only `drive`
  (0.367), `backlit` (0.350) and `meadow` (0.325) are in band, and `forest` fell
  further this round.

## Ranked blockers after this pass

1. **#20, unchanged and unlanded — the ground has no large-scale value event.**
   `drive` ground: 0.0% cool, 97.9% one hue, dark-area 10.8%. The target is now
   measured and warm (§1): 64% of lit luma, red:green held, blue down 17%. This
   is still why the build loses to its own history at 035/040/045.
2. **`peaks` — the rock necklace, and the bare right-hand slab beside it.** Two
   named blockers in one frame, both regressions of things closed elsewhere.
3. **`forest` — a tenth of the game measures 0.154 chroma and 2.9% vivid, and it
   got worse this round.** Root cause is hue family and tree placement, not the
   grade. Run the fog-off comparison before touching the needle albedo.
4. **`backlit` — no rim light, no translucency, and it now loses blind A/B to
   rounds 024 and 033.** The one frame the capture harness itself calls the money
   shot for foliage translucency, and nothing has been spent on it in fifteen
   rounds.
5. **Near-field ground surface in `vehicle` and `river` — bare dirt and flat
   cards at 2 m.** `meadow` proved this round that it is solvable; two views
   have not received the fix.

Runners-up, unchanged: gold isoline caps on rock (#8, five passes); stretched-UV
smears (#6); unlit unfogged specks (#9); scrub as flat cardboard cut-outs (#15);
detached white slabs on the `meadow` cliff at 15–28% across, 5–16% down; the
`vehicle` far ridge as one repeated triangular tooth at a single value.

## Method note

Every number above is `tools/colorstats.mjs`, `tools/_scratch/crop.mjs`, or a
rect-restricted re-implementation of `colorstats`' own statistics, run at the
time of writing. Plate crops are quoted as fractional rects so they can be
re-run. `reference-art/` was read only. Two claims I was about to make were
killed by measuring them — the uniform trunk width in `forest`, and pass 4's
contrast multipliers — and one pass-4 claim was reproduced exactly, which is why
the rest of that pass should be trusted.

---

# Critic pass 6 — 2026-08-20 (round 049)

`SHIP 0 · CLOSE 1 (pass-5 forest cause #2, withdrawn on evidence) · REJECT 9 ·
1 NEW BLOCKER, and it is a one-line-class bug sitting on two frames`

## 1. The headline: round 049 loses its blind A/B to 040, 8–2

Twenty-four blind pairs cut from the archived sheets. Ten are 049 vs 040; the
other fourteen are **old-vs-old decoys** (037 vs 042, 045 vs 037) so that the
current build is not the image that recurs in every pair — the structural leak
pass 5 flagged and could not avoid.

| | wins | | losses |
|---|---|---|---|
| **049 vs 040** | **2** (forest, vehicle) | | **8** (hero, peaks, drive, meadow, backlit, river, waterfall, dawn) |
| 042 vs 037 (decoy) | 6 | | 2 |
| 045 vs 037 (decoy) | 3 | | 3 |

Pass 4 had 048 losing to 040 3–7 (048 took peaks, backlit, forest). Round 049
takes `vehicle` from it — the camper shadow and the frame's composition — and
**gives back `peaks` and `backlit`**. Net, against the round the archive calls
the high-water mark, the build is one view worse than it was two passes ago.

Definition-of-done item 6 fails for the third consecutive pass.

**Contamination, declared honestly:**

- I had seen the full 049 sheet and four 049 frames at full resolution
  (`river`, `forest`, `backlit`, and the plates) before judging, and 048's
  `river` too. That biases **toward** recognising and favouring 049. It lost
  8–2 anyway.
- I had read passes 3–5 in full, which enumerate the current build's defects.
  That biases **against** 049.
- Method: cells cropped from the sheets at 1.5×, caption strip excluded, side
  chosen by `crypto.randomBytes`, all 24 shuffled by a crypto Fisher-Yates, key
  written to `key.json` and not opened until all 24 calls were recorded in a
  separate file. Cell order was verified beforehand from 22-px caption slivers
  only — which do carry ~20 px of picture at their right edge, so that much of
  every sheet was seen. Declared.
- **A real leak I did not design out:** round 045's cells carry the perf HUD
  overlay in the top-left corner, which marks that build unmistakably. It
  appears in six pairs, all of them decoys — never in an 049-vs-040 pair — and I
  picked the HUD side three times out of six, so it did not run the result. A
  future pass should crop the top-left 200×70 px out of every cell.
- The decoys did their job: 042 beat 037 6–2 and 045 tied 037 3–3, so the calls
  were not "pick whichever image I have seen before".

## 2. NEW BLOCKER — the cloud shadow is a constant multiply over the whole frame

**This is the finding of the pass and it is on someone's screen right now**
(`src/render/Atmosphere.js` is uncommitted work in progress as I write).

`river` and `vehicle` are the two worst-measuring frames in round 049
(`vividPct` 8.8 and 8.4 against a reference band of 31–79). Both are sitting
under a cloud shadow that covers **the entire visible landscape, including the
distant massifs and the haze**, with no edge and no gradient anywhere in frame.

Measured, same build, same view, `cloudShadowGain` 0.85 → 0:

| | `river` as archived | `river` cloud off | `vehicle` as archived | `vehicle` cloud off |
|---|---|---|---|---|
| `lumaMean` | 0.283 | **0.373** | 0.464 | **0.523** |
| `chromaMean` | 0.212 | **0.264** | 0.232 | **0.273** |
| `vividPct` | 9.5 | **22.1** | 9.3 | **27.8** |
| `coolPct`¹ | 1.06 | **11.0** | 4.3 | — |

¹ cyan+azure+blue+violet+magenta+rose as a share of chromatic pixels.

`hero`, `waterfall` and `forest` are unaffected (deltas ≤0.013), so it is not a
grade change; it is a shadow that happens to be parked on two views.

**It is not a shadow. It is an exposure cut.** Raising the coverage threshold
from `cloudSoftLo/Hi` 0.38/0.62 to **0.62/0.90 changes the frame by 0.000** on
every metric. Only at 0.85/0.99 does any light come back (0.283 → 0.345), and
even then the frame is uniformly lighter with no patch edge anywhere. The
sampled coverage across the whole visible world in this view is therefore
**≥0.90**: the smoothstep is saturated and `m` is a constant. The file's own
comment says the intent was "about a third" of the ground.

Two things not to touch while fixing it:

- **The depth and the tint are correct.** At `cloudShadow 0.42 × gain 0.85` the
  shadow multiplies R and G by 0.654 and B by 0.536 — **65% of lit luma with the
  blue ratio down 18%**. Pass 5's measured target off plate 1 is **64% of lit
  luma with the blue ratio down 17%**. That is a bullseye. The colour half of
  X2 is solved. Only the coverage field is wrong.
- Do not fix it by lowering the gain. A weaker constant is still a constant.

Two suspects, offered as suspects: `cov = max(tap1, tap2)` — the max of two soft
fields raises the *mean* coverage, it does not only enlarge the patches, and the
comment reasons about area as if it did; and `climb` clamps at 4200 for every
ground pixel at this sun elevation, so the whole frame samples one rigidly
shifted copy of the map. I checked and ruled out the obvious one: the coverage
texture is `RepeatWrapping` at 512², so this is **not** a clamp-to-edge
constant.

**Process note, and it matters for the archive.** Round 049's `river` reproduces
at HEAD-plus-working-tree to three decimals (0.283/0.212/1.06 archived against
0.282/0.212/1.13 captured now) and does **not** reproduce against the committed
tree — the per-channel tint that removes the cool family only exists in the
uncommitted diff. The 049 sheet was captured against a dirty working tree and is
not attributable to a commit. Two consecutive captures I took landed on opposite
sides of that edit and differed by 24% mean luma; every other view reproduced to
±0.013. If a round is going to be compared against its history, capture it at a
commit.

## 3. The three views the player asked about

### `river` — REJECT, and the diagnosis is not the hillside

The hillside is not dark bare ground. It is **an ochre hillside under a
full-frame cloud shadow** (§2). With the shadow off, in the same build, with
the same cover on it, the bank is warm ochre, the river reads as blue water and
the frame gains 12.6 points of `vividPct` and 10 points of cool.

It is genuinely darker than 046: `lumaMean` 0.361 → 0.283, `lumaP95` **0.631 →
0.521** — the white point of the frame fell 0.11 — `chromaMean` 0.253 → 0.212,
`vividPct` 17.0 → 9.5, cool 11.7% → 1.1%. The player's eye is right and the
delta is one cause, not a slow slide.

Its `darkAreaPct` is **0.12%**, against 9.1% at 046. That is not "more shadow",
it is the opposite: when everything is shadowed, nothing is darker than the
median. A frame whose dark-area share collapses toward zero while its mean falls
is being multiplied down, not modelled.

Underneath the shadow, three real defects remain, and note that **one of them is
new and was caused by a correct fix**. `8f1f233` made the ground mats conform to
the slope — right, and it was verified with the layer isolated. But mats that
were previously lying flat in world space on a 49° bank were catching light like
horizontal cards; conformed, they take the bank's own away-from-sun normal, and
the frame now shows what was always there: several hundred flat gold
parallelograms with hard straight corners scattered down the slope, plus
popcorn-like scrub clumps. It is not the cards' orientation any more — it is
that a `leafScatter` patch has no interior value and no soft edge, so at 2 m it
reads as litter cut from card. The diagonal striation on the terrain surface
under them (10–40% across, 20–50% down) is unchanged from pass 5.

**I do not accept a numeric defence of this frame and I have not built one.**
Pass 5's warning is still live: `river` measured like plate 3 on every tone
metric while looking nothing like it. The numbers above are used only to
identify *what changed between two rounds of the same frame*, which is what they
are good for.

### `backlit` — still REJECT, and pass 5's absolute claim needs softening

It lost its pair to 040 again, so the standing regression stands.

But "still no rim light, nothing" is no longer strictly true and an author
should be told what is actually there. Magnified, every frond on the big conifer
at 5–27% across now carries a pale sage tip fringe. Measured on that tree:

| | sRGB | luma |
|---|---|---|
| frond tips, anti-sun (left) edge | (116,106,68) | 0.42 |
| crown body | (81,82,45) | 0.31 |
| frond tips, sun (right) edge | (130,116,74) | 0.46 |
| sky immediately beside it | (207,155,127) | 0.64 |

So there is a tip-lightening of **+35 to +48%** over the body — and only **+12%**
of it is sun-dependent. What exists is a per-frond tip gradient that fires the
same on every side of the tree; the directional component is a seventh of it.
The brightest needle in the money frame for foliage translucency reaches **72% of
the sky behind it**, so the tree still has no edge separating it from the sky,
and the crown interior is opaque at the same value as its shaded side — there is
no transmission anywhere.

Also unchanged: the ground is one salmon value with no ladder inside the hue
(plate 4 is the reference and it *does* have one — its near rocks sit well below
its haze); the brown blob tree is still the worst asset in the game and is still
in the brightest part of the frame; ~10 unlit unfogged dark specks in the sky.

### `forest` — REJECT stands, but pass 5's cause #2 is WITHDRAWN, and cause #1 needs re-basing

**The fog-off test pass 5 proposed was run, and it kills pass 5's hypothesis.**
`forest` and `drive` captured in one session, once normally and once with
`density/max/inscatter/desat` forced to 0:

| rect | fog ON | fog OFF |
|---|---|---|
| `forest` near conifer, lit | (64,89,57) 1:1.39:0.89 | **identical** |
| `forest` near conifer, shaded | (50,57,31) 1:1.14:0.62 | **identical** |
| `drive` conifer crown | (78,95,57) 1:1.22:0.73 | **identical** |
| `drive` conifer, mid | (92,105,66) 1:1.14:0.72 | (84,97,58) 1:1.15:0.69 |
| `drive` conifer, far | (100,110,65) 1:1.10:0.65 | (91,104,60) 1:1.14:0.66 |

`drive`'s conifers are **green-led with the fog on**. They were never red-led.
The mechanism: `DEFAULTS.onset = 260` zeroes `fogFactor` inside 260 m, so the
`uFogDesat` re-tint and the haze mix both multiply by zero and every near
conifer in the game is completely unfogged. Pass 5's red-led readings came from
patches that included gold grass or warm sky between the fronds — reproduced:
`drive` rect `0.766,0.444,0.038,0.078` measures 1:0.96:0.49 on the same frame
with the same fog and stays red-led with fog off.

**And the reference is green-led too.** Pass 5 asserted "every reference conifer
is red-led". Measured tight on needles, three patches on plate 3's near conifer:

| | sRGB | ratio |
|---|---|---|
| plate 3 conifer, lit flank | (63,71,40) | **1 : 1.13 : 0.63** |
| plate 3 conifer, crown | (52,61,29) | **1 : 1.17 : 0.56** |
| plate 3 conifer, shaded | (39,56,35) | **1 : 1.44 : 0.90** |

Against our `forest` at 1:1.14:0.62 and `drive` at 1:1.14:0.72. **Our conifer
needle hue matches the plate.** Nobody should re-tint the albedo, and pass 5 was
right to say so before it had the evidence.

Pass 5's third claim — "`forest` regressed this round, 0.183 → 0.154" — also
does not survive. That 0.154 was measured on `shots/critic4`, a separate capture
set. Measured through one pipeline on the archived full-resolution frames:

| | 045 | 046 | 048 | 049 |
|---|---|---|---|---|
| `chromaMean` | 0.183 | 0.184 | 0.184 | **0.189** |
| `vividPct` | 12.0 | 11.9 | 11.9 | **14.3** |
| yellow + y-grn (% chromatic) | 43.0 | 43.7 | 43.7 | **43.0** |

`forest` did not regress. It has been **frozen for five rounds**, which is worse
news than a regression: nothing anyone has done has touched it.

What is left of the diagnosis is cause #1 and cause #3, and they are enough:

- **43% of its chromatic pixels are yellow or yellow-green.** Every other view
  runs 0–12%; the five plates run 0.3–3.4%. It is the most out-of-family
  measurement in the project and it is view-local.
- **There is no autumn in it.** One crimson crown, on the far bank, past the
  lake. Nine views carry orange and crimson canopies inside 40 m; this one is
  conifer and acid-yellow grass. `chromaMean` 0.189 and `vividPct` 14.3 against
  plate 3's 0.307 and 31.2 is a *placement* result, not a grade result, and no
  grade change will put colour in that the scatter did not.

## 4. Ranked blockers for round 049

1. **The cloud shadow is a constant, not a shape** (§2). Two of ten views lose
   ~60% of their vivid pixels and ~90% of their cool to it. The tint and depth
   are already right against plate 1; only the coverage field is wrong. Highest
   value-per-hour item in the project right now.
2. **The rock is grey, and it is the largest mass in the game.** `waterfall`'s
   massif (25–55% across, 10–55% down — about a seventh of the frame) measures
   `srgb(161,153,163)` = 1:0.95:1.01, **`neutralPct` 70.4, `vividPct` 1.6,
   `contrastStd` 0.070, range 0.224**. Plate 5's equivalent rock mass:
   `srgb(206,167,130)` = 1:0.81:0.63, `neutralPct` 11.8, `vividPct` 44.7,
   `contrastStd` 0.093, range 0.267. Ours is *six times* as neutral over a mass
   with three quarters of the reference's internal contrast, and it is smooth —
   soft melted folds and brushed-metal swirls, no plane breaks. This is why
   `waterfall` is the least autumnal frame in an autumn game
   (`chromaMean` 0.181, `neutralPct` 36.8 frame-wide).
   Same subsystem, same frame family: **the necklace is now on two views**, and
   it has become a *hue* mismatch rather than a value one — `hero`'s block chain
   at 55–62% across / 57–66% down measures 1:0.78:0.67 against the cliff it sits
   on at 1:0.82:0.82, at the same luma. `peaks` blocks 1:0.82:0.79 against cliff
   1:0.89:0.89. Match the blue ratio to the host face, or make them cast onto it.
3. **X2 has not moved in `drive`, at all.** Ground region (lower 52%), three
   rounds: `contrastStd` 0.098 → 0.097 → **0.096**; dark-area 10.9 → 10.6 →
   **10.06**; **cool 0.1%**; **97.8% of chromatic ground pixels in one 30° hue
   bucket**. Plate 3's equivalent region: 24.3% cool, spread over eight buckets,
   dark-area 25.6. Note the shape of the error precisely — our ground's
   `chromaMean` is **0.480** against plate 3's 0.308. We are not desaturated
   there. We are mono-hue and over-saturated inside the one hue we have.
4. **The vistas have no aerial recession, and both lost blind.** `hero`: the
   ridge at 400 m and the range at the horizon sit at the same value and the
   same hue; the whole upper half is one continuous airbrushed gradient with no
   plane changes and no strata; cream "snow" runs to meadow height with no
   snowline. `lumaP05` 0.329 / range 0.505 / `contrastStd` 0.171 /
   `chromaMean` 0.228 against plate 1's 0.161 / 0.705 / 0.218 / 0.293. Pass 3
   filed this as #10 at 0.359/0.463. Forty rounds, 0.03.
5. **Bare dirt at 2 m in `vehicle`.** Red-brown substrate fully visible between
   individual pale blade clumps across the lower 50% of frame, in the frame
   whose whole job is to sell the vehicle. `meadow` proved this round that the
   fix exists — its near grass has a root-to-tip gradient, a height ladder and a
   solid gold mass, and it is the best surface in the game. Two views did not
   get it, and `river`'s conforming mats (§3) made its bank worse in the same
   round.

Runners-up, unchanged: gold isolines pouring over the rock lip in `vehicle` at
28–40% across, 28–33% down (pass-3 #8, six passes open); detached pale slabs on
the `meadow` cliff at 10–28% across, 5–20% down, several with void beneath;
~40 hard-edged orange leaf dots hanging fully sharp in front of the `waterfall`
cliff at 10–40% across, reading as sensor dust; unlit unfogged dark specks in
`vehicle`, `backlit` and `peaks`; the `vehicle` far ridge as one repeated
triangular tooth at a single value; the `peaks` right-hand gold slab still bare
from 72% across with flat violet lozenges pasted on it.

## 5. What is genuinely better this round

One line each, then move on. `meadow` is the best frame the project has
produced — near grass with a real value gradient and height ladder, a crimson
maple as subject, `lumaMean` 0.441 → 0.560. `vehicle` won its blind pair against
040, the first time the camper frame has beaten the high-water round. `drive`
now has a legible large-scale shadow band in the mid-ground even though its
ground statistics have not moved. `waterfall`'s depth-of-field mush is still
gone. The `peaks` lake reads as water again.

## 6. Method, and the claims this pass killed

Every number above is `tools/colorstats.mjs`, `tools/_scratch/crop.mjs`, or a
rect-restricted re-implementation of `colorstats`' statistics, run at the time
of writing; plate crops are quoted as fractional rects so they can be re-run.
`reference-art/` was read only. Eye-level views were judged against plates 3/4/5
and vistas against plate 1, per plate; no figure above is an average of plates.

Four claims I was about to make were killed by measuring them, and they are
listed because the killed ones are the evidence that the rest were checked:

1. *"`river`'s bank went dark because the substrate mats now take the slope
   normal."* Plausible, matches the commit, and wrong: the grid diff showed the
   darkening was uniform across the sky, the distant cliff and the near bank
   alike — multiplicative, not material.
2. *"It is a cloud shadow phase accident at capture time."* Killed, then
   revived, then confirmed properly: my first cloud-off test showed **zero**
   difference and I nearly filed cloud shadow as ruled out. It had simply run in
   the lit branch. Two more captures and a threshold sweep settled it.
3. *"The coverage map is clamp-to-edge, so the whole world samples one texel."*
   The obvious member of this project's favourite bug family, and false: the map
   is 512² `RepeatWrapping`.
4. *"`meadow`'s nearest blades are washed pale cream while blades 10 m out are
   saturated gold."* Measured: near (183,136,67) 1:0.74:0.37, mid
   (198,153,75) 1:0.77:0.38. Same hue, marginally darker near. Withdrawn.

And one of pass 5's own findings is withdrawn on evidence rather than opinion —
the conifer hue diagnosis for `forest` (§3), including the reference measurement
it rested on.

---

## Integrator spot-check, 2026-08-20 — three defects a driven capture found that ten still frames did not

Found by driving with `tools/_scratch/motionstrip.mjs` rather than capturing the
ten canonical poses. All three are player-visible and none is in the review set.

**D1. The camera goes underwater with no treatment.** `shots/wedge/f6.png`: the
camper drives into a lake and the frame becomes a flat blue wash — no depth
tint, no surface plane above, no fog change, no indication of what happened. The
HUD still reads 39 km/h. This is not an edge case: the UI author measured **21%
of the world as standing water with a median depth of 4 m**, and the valley
floor is largely marsh, so an ordinary drive finds it. Either the camera should
not submerge, or submerging needs to look deliberate.

**D2. The occlusion fade reads as a halftone screen door.** `shots/wedge/f9.png`:
several crowns left and centre carry an obvious regular dot pattern. Dithered
discard is the right technique — it survives alpha-testing and the existing
render order, and it measured *negative* cost — but at this dot scale it reads
as an artifact rather than as a fade. It also appears to be engaging on trees
that are not between the camera and the camper. Two things to check: the dither
pattern's screen-space frequency (a finer or blue-noise pattern hides far
better than a coarse Bayer), and whether the near-camera sphere is too generous
now that it is doing most of the work.

**D3. A large flat grey wedge occludes half the frame.** `shots/ui/map7/full.png`,
upper right: an enormous unshaded triangle with two straight edges meeting at a
point, covering the sky and the far landscape. It is not in any canonical
capture, so it is positional. **Not yet identified.** A scene scan
(`scratchpad/wedge.mjs`) finds `TerrainApron` segment meshes at world radius
~3353 m as the largest real geometry — the apron's seam skirt drops 40 m at
`r === 0` and the profile subtracts 900 m behind the crest, so a camera high on
a massif near the boundary is the first thing to test. The particle systems
reporting radius 1e6-1e7 are `frustumCulled = false` sentinels and are normal.
Reproduce by driving, not by posing.

---

## Correction to pass 6, blocker #2 — the "plate 5 rock" target was gold grass

**Filed by the integrator, 2026-08-20, from the rocks author's round.**

Pass 6 ranked "rock is grey" as blocker #2: our `waterfall` massif at 70.4%
neutral / 1.6% vivid against **"plate 5's rock at 11.8% neutral / 44.7% vivid"**.

**That target is not rock.** The rocks author measured plate 5 directly with
re-runnable fractional rects:

| rect | srgb | ratio | neutral | vivid |
|---|---|---|---|---|
| boulder, lower right | 186:183:182 | 1:0.981:0.975 | 27.6% | **0.0%** |
| cliff, left edge | 165:157:152 | 1:0.947:0.922 | 75.3% | **0.0%** |
| cliff, top centre | 170:158:153 | 1:0.932:0.902 | 34.5% | **0.1%** |
| *grass beside a boulder* | 219:165:117 | 1:0.755:0.535 | 5.1% | **59.8%** |

Pass 6's figure is the last row. **Plate 5's actual rock is near-neutral grey
with essentially zero vivid pixels, and plate 3's massifs agree at 0%.** Our
1.6% vivid was slightly *more* chromatic than the reference, not less. Grey is
the reference answer. Blocker #2 as written is withdrawn.

The earlier rocks author who measured `1 : 0.93 : 0.91` and declared hue closed
had measured real rock and was right. The contradiction between the two
measurements was never about which *quantity* to use — it was that one of them
sampled the wrong *pixels*.

**This is the second target in three passes produced by sampling the wrong
region.** Pass 4 judged an eye-level view against plate 1, which the brief
forbids at line 119. Pass 5's "conifers are red-led" came from patches that
included gold grass, and died to the fog-off test. Now this. **Before quoting a
reference number, mask the region and state what is in it** — the rocks author's
paint-mask method is the model: it showed the existing `--diff` mask was
counting swaying foliage as "rock" (18.5% of frame, host at 43.7% vivid) where
the true figure is 9.3%.

**A second misattribution in the same blocker, and this one reopens another.**
Painting the rock material showed the rock system owns **9.3%** of the
`waterfall` frame and **none** of the massif rect pass 6 quoted. The grey mass
everyone has been calling "rock" is **`TerrainMaterial`** — pass 3's blocker #6,
still open. That is also why the previous author's hue ladder measured only
marginally: they were pushing on a surface that is not the grey one.

**What was real, and shipped.** Every rock in every plate is **red-led**; ours
had blue above red. `uRockCast` 0.925/0.985/1.165 → 0.95/0.924/0.888 (`90c5256`).
The old value had been fitted at `hero` — the one view where rock sits at 0.34
luma under heavy haze and so contributes least to its own pixel — which put
every eye-level rock 0.25 of blue ratio off. Interleaved A/B: the `waterfall`
crag chain goes 1:0.990:1.124 → 1:0.900:0.875 against a host of 1:0.924:0.893.
The necklace was on `waterfall`, not `hero`, and did not reproduce as a hue
mismatch on `hero` at all.

`hero` regresses slightly and the author flagged it rather than burying it.

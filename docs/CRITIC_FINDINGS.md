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

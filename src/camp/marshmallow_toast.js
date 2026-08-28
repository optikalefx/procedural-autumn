// ─────────────────────────────────────────────────────────────────────────────
//  marshmallow_toast — the toast simulation, and the material that draws it.
//
//  Section 2 of docs/ROAST_CONTRACT.md. Two things live here and they are two
//  halves of one object: a CPU grid that says how cooked every point of the
//  marshmallow's surface is, and a MeshStandardMaterial that draws that grid as
//  sugar rather than as a stain.
//
//  ── why a CPU grid and not a render target ──────────────────────────────────
//
//  The obvious implementation is a small float render target, a fullscreen-ish
//  pass that integrates heat into it, and a shader that samples it. That is how
//  you would do a paint/decal system and it is the wrong shape here, for one
//  reason: the mini-game needs the *same numbers the shader draws*. `doneness`
//  decides whether you may eat it, `evenness` decides what the one line of text
//  says, `burning` decides whether a flame is parented to the mallow and whether
//  the sizzle turns into a roar. Getting those off the GPU means a readback, a
//  readback means a pipeline flush, and a flush every frame on the one view in
//  the game that is a static camera looking at a fire is the most expensive
//  possible way to learn a number we could simply have kept.
//
//  So the grid is authoritative on the CPU, 24 x 12 = 288 texels, and it is
//  uploaded as an RGBA8 DataTexture — 1152 bytes a frame, which is nothing. The
//  resolution is deliberately coarse: 24 angular texels is 15 degrees apiece,
//  which is finer than the gradient a fire 250 mm away actually paints, and the
//  fine grain that makes the surface read (blisters, bubbles, cracked char) is
//  procedural in the fragment shader, which is where fine grain belongs. A
//  higher-resolution grid would buy detail the simulation cannot justify and
//  cost the getters a longer scan.
//
//  Channels, and each one has a different consumer:
//    R  toast  0..1   the ramp the shader draws, and `doneness`
//    G  melt   0..1   never decays; drives sag/droop and eventually the drop
//    B  live   0..1   heat RIGHT NOW; the glowing cracks and the sizzle volume
//    A  char   0..1   past-black; the crack mask and `ruined`
//
//  ── the physical model, and which parts of it are the game ──────────────────
//
//  Each texel reconstructs its own surface point and normal analytically from
//  (u, v) — the marshmallow is a squat cylinder with a generous edge radius and
//  the UV parameterization is a contract (see the header of the geometry file
//  and texelGeometry below), so no geometry needs to be read. Those are pushed
//  to world space through the mesh's world matrix and given two heat terms:
//
//    RADIATIVE   power * max(dot(N, toFire), 0) / dist^2, softened so that a
//                marshmallow shoved into the flame gets a large number rather
//                than an infinite one. This is the term that responds to which
//                way a texel FACES, so it is the term the twirl acts on.
//
//    CONVECTIVE  rising hot air. Weaker, but it does not care much which way a
//                surface faces, and it is stronger on the UNDERSIDE and stronger
//                the lower the mallow sits over the flame.
//
//  The convective asymmetry is the whole mechanic. If heat were purely radiative
//  the bottom and the top of a marshmallow held at the same distance would cook
//  at rates that differ only by cosine, and the skill would be "point it at the
//  fire". Because hot air goes up, the bottom is genuinely, structurally hotter
//  than the top, so a marshmallow left alone develops a black underside and a
//  raw top — and the only cure is to keep turning it. Turning is the verb; this
//  term is the reason the verb exists.
//
//  ── the tuning targets, and how they were hit ───────────────────────────────
//
//  Three numbers now. The first two are the contract's; the third is the lead's
//  round-10 ruling, and it replaced a design this file used to be proud of.
//
//    · a patient player who turns steadily reaches "golden all over" in
//      roughly 35-55 s
//    · a player who never turns has a black side in about 20 s
//    · the TOP of the height band must still reach golden — slowly and safely,
//      but a player who holds the stick high is playing the patient version of
//      the mechanic and must never be quietly doing nothing. About twice the
//      default's time is the reading of "slow and safe".
//
//  ── AND THEY ARE MEASURED AT THE POSE THE GAME HOLDS, WHICH IS NOT ON AXIS ──
//
//  Every earlier version of this table was driven at "250 mm above the flame's
//  hottest point, ON THE FIRE'S AXIS", by tools/_scratch/toastsim.mjs, which
//  synthesises that pose. The view does not use it. Dumped straight out of the
//  live game by tools/_scratch/roastmat.mjs, at the six heights the height
//  control spans:
//
//    height   0.10   0.16   0.24   0.32   0.40   0.50
//    above    0.114  0.174  0.255  0.335  0.415  0.515
//    rho      0.280  0.280  0.280  0.280  0.281  0.281      <- CONSTANT
//    dist     0.302  0.330  0.378  0.437  0.501  0.586
//
//  The marshmallow is held 0.280 m off the fire's axis at EVERY height, because
//  the view holds the stick out to the right and toward the lens so the mallow
//  does not hide the flame. So the distance the inverse square sees runs 0.302
//  to 0.586 — under a factor of two, where the height control itself moves by a
//  factor of five — and the height band is inherently much flatter than an
//  on-axis reading of it. That is a fact about the composition and it is not
//  negotiable from this file; what IS this file's business is not pretending
//  otherwise. The instruments that measure the real thing:
//
//    roastmat.mjs   dumps the six world matrices, once, from the live game
//    toastband.mjs  replays the real ToastMap against them, offline, in seconds
//    toasttune.mjs  solves the constants below in closed form against them
//    cookcurve.mjs  the same curve in the live game, for the final check
//
//  toastsim.mjs still runs and is still the right instrument for the mechanic's
//  RATIOS in the abstract. It is not the instrument for any absolute time and
//  its table should not be quoted as one.
//
//  ── the arithmetic, at that pose ────────────────────────────────────────────
//
//  Averaged over one full turn a texel sees 1/pi of the convective downside
//  term; the isotropic part of the convection is unaffected by turning, and the
//  radiative term now averages the sphere-source horizon rather than a clamped
//  cosine (see SRC_R). Measured by tools/_scratch/toastheat.mjs:
//
//    turn-averaged heat, down the band     0.437 0.378 0.295 0.226 0.176 0.130
//    unturned hot side, down the band      0.858 0.814 0.700 0.574 0.461 0.351
//    unturned top face, at 0.24            0.050
//
//  Two spreads fall out of that and they are nearly the same size — 2.27 : 1
//  across the height band, 2.37 : 1 from turn-average to unturned hot side —
//  while the TIME ratios the three targets ask for are not: 2 : 1 for the
//  height band and 0.6 : 1 for the never-turn case. One exponent cannot serve
//  both, which is the whole of why the constants below moved the way they did.
//  BROWN_P was set by the height requirement, because that is the one with a
//  hard ceiling on it, and the orientation contrast was moved into the heat by
//  re-splitting CONV_ISO / CONV_DOWN. The long notes at BROWN_T and CONV_ISO
//  carry the working.
//
//  TOAST_ACC then sets the SHAPE of the tail — how soon a black side arrives
//  after golden — without touching the height band, and TOAST_K is the one free
//  scale that re-pins the default height at 40 seconds to golden whatever shape
//  is chosen. 4.50 and 0.0299; the long note at TOAST_ACC carries the working
//  and the reason the pair moved together.
//
//  ── what the shipping numbers actually do, at the real pose ────────────────
//
//  toastband.mjs, both policies, the whole band. `black side` is the first
//  texel reaching 1.0; `alight` is `burning`.
//
//    TURNING STEADILY at 2.0 rad/s
//    height   eat(.15)   gold(.55)   past(.80)   evenness at gold   grade
//      0.10     10.4 s     28.3 s      34.8 s          0.957        perfect
//      0.16     11.8 s     32.1 s      39.5 s          0.939        perfect
//      0.24     14.7 s     39.9 s      49.2 s          0.950        perfect
//      0.32     18.4 s     50.1 s      61.5 s          0.971        perfect
//      0.40     22.8 s     62.3 s      75.5 s          0.974        perfect
//      0.50     29.4 s     81.0 s      96.8 s          0.975        perfect
//
//    NEVER TURNING
//    height   black side   charred   alight
//      0.10      20.2 s     26.9 s   29.9 s
//      0.16      21.0 s     28.7 s   31.4 s
//      0.24      23.5 s     32.8 s   35.1 s
//      0.32      27.4 s     38.4 s    never
//      0.40      32.3 s     45.5 s    never
//      0.50      39.8 s     56.3 s    never
//
//  and the same two policies on the ignition clock, because that is the one
//  the failure hangs off:
//
//    height   alight, turning   alight, never turning   golden, turning
//      0.10       50.5 s              29.9 s                28.3 s
//      0.16       57.1 s              31.4 s                32.1 s
//      0.24        never              35.1 s                39.9 s
//      0.32+       never               never                50.1 s and up
//
//  so: golden at the default in 40 s inside the contract's 35-55; the top of
//  the band at 2.03x the default and still perfect, not a dead zone; the bottom
//  at 0.71x and easy to ruin; a black side inside twenty-four seconds if you
//  never turn, and inside twenty-one at the bottom; a marshmallow left alone
//  catches fire at or below h = 0.28 and cannot catch fire above it, which is
//  the height band's promise stated as an inequality; and a player who is
//  turning can only set it alight at all in the bottom third of the band, where
//  they get twenty-two to twenty-five seconds after golden to notice.
//
//  The `never` in the turning column at h = 0.24 is the entry that moved most
//  (it was 66.7 s), and it moved because of the spear fix rather than because
//  of TOAST_ACC: ignition needs IGNITE_FRAC of the
//  surface hot and charred AT ONCE, and a straight-speared marshmallow spreads
//  a turning player's heat evenly enough that at h = 0.24 the qualifying area
//  peaks at 0.076 against the 0.10 it needs. Measured by
//  tools/_scratch/_ignarea.mjs; the never-turn column of the same run peaks at
//  0.115-0.122 below h = 0.28 and at exactly zero above it, which is the
//  ignition area test still doing its job at both ends.
//
//  Confirmed in the live game with tools/_scratch/cookcurve.mjs, which sits
//  down at a real camp, pins the step-in and steps the whole view at 60 Hz:
//
//    height          eat gate (.15)   golden (.55)   past gold (.80)
//      0.10             10.3 s          27.7 s          34.1 s
//      0.24             14.4 s          39.1 s          48.0 s
//      0.50             28.9 s          79.6 s          95.0 s
//
//    and never turning     black side   charred   alight
//      0.10                  19.9 s     26.6 s    29.6 s
//      0.24                  23.0 s     32.1 s    34.4 s
//      0.50                  39.0 s     55.3 s     never
//
//  against the 10.4 / 28.3, 14.7 / 39.9 and 29.4 / 81.0 the offline replay
//  predicts — inside two and a quarter percent at every rung, which is what a
//  bank of real world matrices buys over a synthesised pose. The top of the
//  band is the row the lead ruled on and it still holds in the live game: h =
//  0.50 reaches golden at 79.6 s, is never charred, and is never alight under
//  either policy — the patient version of the mechanic, not a dead zone and not
//  a way to burn a marshmallow.
//
//  ── WHAT THIS REPLACED, AND WHY IT IS WORTH KEEPING THE NUMBER ─────────────
//
//  The build before this one, measured the same way in the live game at the
//  shipped default height, turning at 2.0 rad/s:
//
//    t (s)        10     20     30     40     50     60     70     80     90
//    doneness   .031   .064   .096   .129   .163   .199   .235   .275   .317
//
//  Golden at about 155 s against a target of 35-55; the eat gate at doneness
//  0.15 shut for the first 45 seconds, which the player reported separately as
//  "E does nothing"; and at the top of the band, doneness 0.09 after two
//  minutes and golden never. Three things had gone wrong at once and none of
//  them was visible from inside the on-axis table: the radiative term collapsed
//  on the barrel because the stick points at the fire (SRC_R), BROWN_T's cliff
//  sat straight across the height band (BROWN_T), and every rate was quoted at
//  a pose 0.28 m away from the one the view uses.
//
//  ── AND `peak` WAS RUNNING AWAY FROM `doneness` UNDER STEADY ROTATION ──────
//
//  The brief asked why, and it is worth the paragraph because the answer is a
//  texel the player cannot turn. In the old build `peak` reached 1.00 at 90 s
//  while `doneness` was 0.317 — a 3 : 1 lead on a policy where every barrel
//  texel sees the same time-averaged heat and they ought to track exactly. They
//  do track: the runaway texel was not on the barrel. It was the FAR CAP.
//
//  The view holds the stick pointing at the fire — axis . toFire is 0.99 at the
//  bottom of the height band and 0.85 at the default — so the far end of the
//  marshmallow faces the flame squarely and, being a pole of the map, its
//  orientation does not change as the stick turns. Under the old point-source
//  radiative term it collected 2.4x the barrel's turn-averaged heat, and
//  BROWN_T's threshold plus the 1.25 exponent widened that to a factor of five
//  in rate. It went black while the body was barely gold, and it took `peak`,
//  `uGlow` and the `uneven` test with it. tools/_scratch/toastband.mjs --where
//  prints the offending texel; the band means at the old numbers read
//
//    0.02 0.67 0.68 0.69 0.69 0.70 0.71 0.71 0.72 0.73 0.74 1.00
//
//  eleven barrel bands in lockstep and one cap at saturation.
//
//  Two of this round's changes fix it and neither was made for it. SRC_R lifts
//  the barrel's radiative term by a factor of ten at the bottom of the band and
//  the cap's by nothing at all, because the cap was already facing the source;
//  CAP_RESP takes the 15% back that normalising the cap's mean normal had
//  invented. The lead is now 1.6x rather than 5x, so the cap browns first —
//  which is what happens to a real marshmallow on a stick pointed at a fire —
//  and it can no longer ignite on its own: at the default height it sits at
//  0.542 heat units against IGNITE_HEAT's 0.63.
//
//  Where exactly it saturates has moved twice since, and both moves are honest
//  consequences of things done for other reasons. At the shipped numbers the
//  first texel to reach 1.0 does so at doneness 0.493 / 0.503 / 0.522 / 0.566 /
//  0.637 / 0.772 down the band, and `peak` at golden reads 1.000 / 1.000 /
//  1.000 / 0.956 / 0.824 / 0.682. So at the default height the far cap now
//  blacks a couple of seconds BEFORE golden rather than a few after — the spear
//  fix took it from 0.577 to 0.569 and TOAST_ACC 4.50 took it from 0.569 to
//  0.522, because an accelerating curve amplifies whatever spread is already
//  there and the cap's lead is the one spread the player cannot turn away.
//
//  Three reasons that is accepted rather than tuned back. It does not touch the
//  grade — `evenness` is measured WITHIN each ring (accepted decision 3), the
//  cap is one ring, and the turning table above grades perfect at every height
//  with 0.94-0.98 of evenness. It does not touch ignition — the B channel is a
//  function of HEAT alone and TOAST_ACC is not in it, so the cap's live channel
//  is the same 0.714 it was, and the area test still holds it under IGNITE_FRAC
//  (0.076 of the surface qualifies at the default height, against the 0.10 it
//  needs). And nothing downstream is hanging off `peak`: camp_roast_view.js's
//  `toast?.burning ?? (peak > 0.94)` never reaches its fallback, because
//  `burning` is a getter that always returns a boolean, and Camp.js's sizzle
//  takes `heat` long before it would take `peak`. What it is is the far end of
//  a marshmallow going dark before the body does, on the end pointed away from
//  the camera, which is a picture of a marshmallow.
//
//  ── AND THE THING THAT COULD NOT BE FIXED FROM HERE, WHICH NOW HAS BEEN ────
//
//  Rounds up to 10 recorded a hard ceiling on `evenness` of about 0.81 and
//  traced it out of this file: the marshmallow was speared 13.9 degrees off the
//  stick's own roll axis (axis . local +Z = 0.9708 at every height), so every
//  texel swept a CONE rather than a circle as the stick turned and kept a
//  permanent bias toward or away from the fire that no spin rate could average
//  out. A ring of 24 barrel texels at golden ran 0.396 to 0.734. The note here
//  said the cure was not to re-point the ToastMap's `axis` — the map's lattice
//  has to stay on the MESH's axis, because u is the geometry contract's u and
//  the map is a texture drawn on that geometry — but to spear the marshmallow
//  straight, in the geometry.
//
//  That is what happened, in camp_marshmallow.js, and it is why this round
//  exists. Re-dumped with roastmat.mjs and re-checked with _axischk.mjs, the
//  spin axis now dots the mallow's local +Z at 0.9990 at every height — 2.6
//  degrees here, and the geometry author reports 2.35 degrees worst case over
//  300 seeds. The lateral offset was deliberately left alone, so the twirl
//  still reads. What it bought, at the default height, at golden:
//
//    ring of 24 barrel texels   0.396 - 0.734   ->   0.515 - 0.592
//    evenness at 2.0 rad/s              0.782   ->   0.950
//    evenness at 9.5 rad/s (cruise)     0.780   ->   0.952
//    evenness over the whole band  0.788-0.892  ->   0.939-0.975
//
//  against a 'perfect' threshold of 0.78. The margin went from 0.008 at the
//  tightest rung to 0.16, which is what let TOAST_ACC finally go where the
//  never-turn target had always wanted it; see the long note there. Nothing is
//  outstanding here any more — if a later reader is looking for the spear skew,
//  it is gone, and _axischk.mjs is the two-second way to confirm it still is.
//
//  ── the material ────────────────────────────────────────────────────────────
//
//  MeshStandardMaterial + onBeforeCompile, NOT a ShaderMaterial. This game
//  patches the physical shader globally in three places — Atmosphere.js for fog,
//  Stylize.js for the whole direct-lighting response and the cool cast-shadow
//  mass, and the shadow chain — and every one of those reaches a material by
//  being *in* three's chunks. A ShaderMaterial here would be an unfogged,
//  differently-lit, shadowless pill sitting in the middle of a camp that is none
//  of those things, and the failure is quiet enough to survive review. The
//  header of src/render/uniformPatch.js is the autopsy of the last time somebody
//  found that out the hard way.
//
//  Five things the material must do, all of them load-bearing:
//    · the toast ramp, cream -> gold -> amber -> mahogany -> black, with the
//      last third compressed so char arrives suddenly
//    · translucency: a wrap/back-scatter term, so the fire behind the mallow
//      glows through its far side. Without this it is a white pill.
//    · blisters, in the vertex position (small) and in the normal (large)
//    · char cracks, with dull orange in the splits gated on live heat
//    · sag and swell, driven by uSag / uSwell, slumping along WORLD down so the
//      droop does not spin with the stick
//
//  Two things the material assumes about the mesh it is put on, both of which
//  the geometry contract already promises and neither of which it can check:
//  the marshmallow's own origin is at its CENTRE (the sag's spread term is a
//  displacement of the lateral component of the position, which is meaningless
//  about any other origin), and its UVs are the contract's parameterization.
//
//  ── SIX DECISIONS THE LEAD HAS ACCEPTED; DO NOT "FIX" THEM BACK ─────────────
//
//  Each of these looks like a deviation from docs/ROAST_CONTRACT.md or like an
//  odd choice, each was raised in a round report, and each was accepted. They
//  are listed together because the next reader will otherwise find them one at a
//  time and correct them one at a time.
//
//    1. `douse()` is not in the contract's method list. The view's behaviour
//       section requires it ("tapping space blows it out") and the self-heat
//       latch means nothing else can clear `burning`. The alternative is the
//       view reaching into this file's arrays.
//    2. `get melt` and `get heat` are not in the contract's getter list. The
//       view needs a sag signal that is not doneness and the audio needs a
//       sizzle signal that is not `peak`; both are already computed by the one
//       pass in update() and both would otherwise be recomputed by a caller.
//    3. `evenness` is measured WITHIN EACH RING, not over the whole surface.
//       The ends of a marshmallow cannot be turned toward the fire, so a
//       whole-surface deviation caps a flawless roast at about 0.77 and puts
//       the contract's 'perfect' band out of reach with no move available to
//       the player. Both of the contract's endpoints still hold exactly.
//    4. The area weights in the toast map are UNIFORM OVER THE MAP, not over
//       the surface. See the long note in _buildSurface: true-area weighting
//       makes `doneness` a number about the end caps and moves the contract's
//       0.55-0.80 band out of reach.
//    5. `grade()`'s outright-charred threshold is 0.84 mean doneness, not the
//       0.88 that first looked right. See RUIN_DONE.
//    6. `mat.userData.keepPhysicalSpecular` and `shadowCool = 0.25` are
//       deliberate opt-outs of two global Stylize behaviours, both documented
//       at their use below.
//
//  ── THE THING THIS FILE COULD NOT FIX, AND HOW IT WAS FIXED ───────────────
//
//  Rounds 3, 4 and 5 each spent themselves on "translucency is absent" and "the
//  ramp does not separate", and all three had one cause. The marshmallow is
//  held 244 mm from the campfire's point light, which camp_roast_view.js's
//  _dampHearth leaves at intensity 2.19 with a decay of 2 — about 37 irradiance
//  units. The value ceiling then maps everything above its knee onto 0.86.
//  Between them EVERY PIXEL OF THIS OBJECT WAS PINNED AT THE CEILING at every
//  rung, and the measurement is in the shipped captures: the body's mean red
//  across mallow-0..3 read 221 / 219 / 217 / 212, mallow-backlit traversed
//  0.375 to 0.400 of linear luma across the entire disc — 1.07 : 1 from limb to
//  limb — and every rung of the ladder reported the SAME 95th percentile to
//  three decimal places, which is the signature of a clamp and not of a
//  surface. No term that added light could be seen: round 5 raised the
//  back-scatter gains by a third and the shipped macro moved by 0.003.
//
//  Round 5's note here concluded that the fix was not available from inside
//  this file — "either a near-field damping of the fire's light on this one
//  material, or a look at what _dampHearth's decay 2 does at a quarter of a
//  metre. Both of those are camp_roast_view.js / camp_fire.js, not this file."
//  The first half of that was right and the last sentence was wrong. A
//  near-field model of the fire's light IS this material's business, because it
//  is a property of the light-transport between this object and that source and
//  nothing else in the game is ever in that regime. It is at SRC_RADIUS, with
//  its radius derived from camp_fire.js's own flame geometry, and it takes the
//  fire from 37 irradiance units to 19.
//
//  What that bought, all measured (lab figures from tools/_scratch/toastlab.mjs
//  under the game's damped fire, game figures off the macro traverse):
//
//    · the additive scatter is visible again. The limb of a backlit marshmallow
//      now rests ON the value ceiling, which is the correct place for the
//      brightest part of this object to sit, and every gain below it is a gain
//      the eye can see rather than one the shoulder renormalises away.
//    · the core-darkening term below is visible too, which it also was not:
//      4.0 linear and 4.0 x 0.55 both map to 0.8600 to four figures, so round
//      5's subtraction was being undone as thoroughly as its addition was.
//    · limb to core on the backlit macro: 1.07 : 1 before, 5.4 : 1 after,
//      against "the contract's 5.5 : 1" — see the correction below, which is
//      that the contract says no such thing.
//
//  ── ROUND 8 OVERSHOT, AND THE THREE THINGS THAT MADE IT OVERSHOOT ─────────
//
//  The build that came out of the round above was rejected on sight: "dark at
//  every rung, including raw". Measured on shots/roast/r8, the composed dusk
//  frame at the ladder pose — body mean linear luma, against the plume the
//  view had put behind it:
//
//    ladder-0..5   0.114 0.106 0.094 0.077 0.058 0.021
//    the backdrop  0.412 at every rung
//
//  i.e. a RAW marshmallow rendering at 28% of the field it is silhouetted
//  against, on an object whose albedo is 0xe8e0cf. The near-field model was not
//  the mistake; three things stacked on top of it were, and every one of them
//  is named at its own constant now:
//
//    1. THE LAB WAS 1.63x BRIGHTER THAN THE GAME. toastlab.mjs ran the fire at
//       LIGHT_DUSK damped (1.612) at 0.244 m. The shipped frame's own state
//       dump says 1.187 at 0.288 m — 8.5 irradiance units against the lab's
//       13.8 — and its lamp is linear (1.00, 0.50, 0.22) rather than the
//       0xffa259 the lab put through the sRGB transfer. Every gain in this
//       file was set against the brighter, more saturated of the two. Fixed in
//       the lab, not here; see the note beside its FIRE_I.
//    2. THE CORE-DARKENING WAS EATING STYLIZE'S FLOOR. Its own note says the
//       floor is the fire's bounce and must be kept, and the line multiplied
//       the whole direct term, floor included. On the shipped pose the wrap
//       has already clipped to zero, so the term was removing 71% of a
//       quantity that was 100% floor. See msWrapShare.
//    3. "THE CONTRACT'S 5.5 : 1" IS NOT IN THE CONTRACT. `grep -rn "5.5 : 1"
//       src docs tools` returns three hits and all three are this file quoting
//       itself. It was invented in round 7 and then used to cap the diffusion
//       floor, the one term that lifts the middle of the lantern without
//       touching the rim. See SCATTER_DIFF.
//
//  And one thing that was genuinely absent rather than mis-set: the additive
//  scatter left the object at uScatter's colour whatever the sugar had become,
//  so it was a fixed cream-orange pedestal laid over the whole ramp. It now
//  leaves through the crust. See gMsCrust.
//
//  What the four bought, off shots/roast/r9-toast at the same hour and pose:
//
//    body mean       0.254 0.232 0.220 0.157 0.067 0.006   (was the row above)
//    one body pixel  181,119,94  176,114,69  169,120,62
//                    154,105,51  124,67,39   25,17,14
//
//  which is cream, cream, honey gold, amber, mahogany, char — the ladder the
//  brief asks for, in the composed frame rather than in a macro. The standing
//  rule is unmoved and still passes: the marshmallow's own max is 0.442 at the
//  raw rung against a flame p95 of 0.725, a margin of 1.64. Raising the middle
//  of a lantern costs the rule nothing, because the rule is about the maximum
//  and the maximum is the rim.
//
//  Re-measured at round 10 on shots/roast/r10-toast, at the same hour, with
//  mbody.mjs — which now finds the FLAME side of the rule the way mgate.mjs
//  does (the brightest 120 px window that does not overlap the recorded
//  marshmallow disc) so both halves are measured in one run:
//
//    body mean       0.263 0.241 0.231 0.168 0.079 0.006      MONOTONIC
//    mallow max      0.479 0.448 0.400 0.346 0.267 0.036
//    flame p95       0.725 at every rung
//    margin          1.51x 1.62x 1.81x 2.09x 2.71x 20.1x      PASS at every rung
//
//  Nothing in round 10 touches the material, and the ladder is `setDoneness`,
//  which paints the map directly — the 0.442 -> 0.479 at the raw rung is the
//  capture landing at a different camp and a different backdrop solve, not a
//  brighter marshmallow. The rule passes with 1.51x of headroom at its worst
//  rung, which is where a RAW marshmallow belongs.
//
//  Re-measured again on shots/roast/r12-toast after the spear fix and the
//  TOAST_ACC/TOAST_K move, same hour, same instrument:
//
//    body mean       0.263 0.241 0.231 0.167 0.080 0.006      MONOTONIC
//    mallow max      0.484 0.454 0.404 0.345 0.285 0.039
//    flame p95       0.725 at every rung
//    margin          1.50x 1.60x 1.79x 2.10x 2.54x 18.4x      PASS at every rung
//
//  which is the r10 row to within a thousandth, and it should be: the ladder is
//  painted by `setDoneness`, so neither the caramelisation constants nor the
//  geometry of how the mallow is speared can reach it. That is the point of
//  re-running it — it is the control that says a tuning round did not move the
//  picture. Monotone, raw is still the lightest rung, and the standing rule
//  still passes with 1.50x at its worst.
//
//  ── AND THE INSTRUMENT WAS READING THE STICK ──────────────────────────────
//
//  tools/_scratch/mgate.mjs samples a disc at 0.80 of the recorded radius, and
//  the marshmallow does not fill it: the skewer's tip emerges 24 px right of
//  centre and renders at 253,169,144 on every rung, raw and char alike, to one
//  unit of 255. That speck is what the gate reported as "mallow max" from the
//  gold rung down, which is why r8's rungs 3, 4 and 5 all came back at exactly
//  0.513. The rule was never in danger and the instrument could not have said
//  so. tools/_scratch/mbody.mjs cuts the stick out and reports the body, the
//  limb and the backdrop separately; run both.
//
//  ── AND ONE MORE INSTRUMENT WHOSE TWO THRESHOLDS DISAGREE ─────────────────
//
//  tools/roastshot.mjs prints "!! evenness is still above 0.6 ... the toast map
//  is not reading the direction the heat comes from" on the `mallow-uneven`
//  frame. It is not this file, and the complaint is not true; it is the two
//  numbers in the harness arguing with each other.
//
//  The frame is produced by holding the mallow still at h = 0.14 and stepping
//  until `onesided` fires, which the harness defines as doneness >= 0.28 AND
//  evenness <= 0.72 (UNEVEN_DONE / UNEVEN_EVEN). Then it warns if the evenness
//  it stopped at is above 0.6. But the stop fires on the FIRST instant both
//  hold, and at that height the doneness half is the binding one, so it stops
//  the moment doneness crosses 0.28 with evenness at whatever value it has
//  reached by then. Replayed offline (tools/_scratch/_unevenchk.mjs), never
//  turning, at the instant doneness reaches 0.28:
//
//    h = 0.10 / 0.16 / 0.24   evenness  0.676  0.607  0.517
//
//  so at the 0.14 the macro uses the answer is structurally about 0.64, which
//  is inside the stop's 0.72 and outside the warning's 0.6. There is a 0.12
//  dead band in which a correct one-sided marshmallow warns. The sim is fine
//  either side of it — two seconds later the same run is at 0.50 — and the fix
//  is to make one of the harness's two numbers agree with the other (raise the
//  warning to 0.72, or lower UNEVEN_EVEN to 0.60 so the run keeps stepping
//  until the picture is as one-sided as the warning demands).
//
//  It is not this round's doing and it is not the geometry author's: measured
//  against a copy of this file at the previous 2.80 / 0.0326 the same three
//  heights read 0.701 / 0.634 / 0.546, i.e. very slightly WORSE. roastshot.mjs
//  is not this file's to edit; this note is here so the next reader does not
//  spend a round chasing it in the simulation.
//
//  ── ONE THING ROUND 8 LEAVES OPEN, MEASURED AND NOT FIXED ────────────────
//
//  At the sheet's DEFAULT hour (16.7, not the 20.4 this round is judged at) the
//  composed ladder's body luma is not monotone across its first three rungs:
//
//    ladder-0..5, hour 16.7   0.303 0.362 0.322 0.209 0.091 0.025
//
//  Raw measures 16% under warmed and 6% under gold. It is a HUE effect and not
//  a lightness one — the raw rung renders 209,127,82 (a pink cream) and the
//  warmed rung 204,154,70 (a yellow cream), and luma weights green at 0.71 — so
//  the crop still reads cream, yellow, gold, amber, mahogany, char in order.
//  But it is a measured inversion and the round before this one did not have it
//  (r7's day ladder is 1.00 / 0.88 / 0.75 / 0.49 / 0.21 / 0.14, monotone).
//
//  Two things are known about it and one is not. Known: it is NOT the diffusion
//  floor — captured with SCATTER_DIFF back at 0.020 and everything else in
//  place, the same ladder reads 1.00 / 1.15 / 1.02 / 0.65 / 0.25 / 0.09, so the
//  floor is worth four points of the nineteen. And the mechanism is available:
//  the value ceiling's shoulder scales by the PEAK CHANNEL, so it takes more
//  luma off a saturated pixel than off a balanced one of the same luminance,
//  and the raw rung is the most saturated rung on the object because uScatter's
//  orange lands on it at msPale 1.00. With the fire's floor light restored the
//  object is now bright enough at the day hour for the shoulder to bite, and it
//  bites the pink rung hardest.
//
//  Not known: whether it is this file's at all. camp_roast_view.js's backdrop
//  solver chose a different hold for the two builds — phi 40 in r7 against
//  30.61 here — so the two ladders are not the same pose and no clean A/B was
//  available inside the round's capture budget. The lever if it is ours is in
//  the shoulder below: a luminance-based shoulder is saturation-neutral where a
//  peak-channel one is not, at the cost of letting one channel past the
//  ceiling. That is a change to the number the whole standing rule is measured
//  against and it is not one to make on the way past.
//
//  Two things still cannot be fixed from in here and are worth naming so the
//  next reader does not try. The value ceiling itself is not negotiable from
//  this file — 0.86 is set by camp_fire.js's flame-core radiance and the brief's
//  standing rule, not by what would flatter the sugar. And the object's hue
//  under the fire is the fire's: uScatter and the ramp decide how much of the
//  lamp's 0xffa259 survives, they cannot decide that it was never orange.
//
//  And one thing it deliberately does NOT do: the depth/shadow pass runs three's
//  own depth material, which has none of this vertex work, so the marshmallow's
//  cast shadow is of the undeformed body. It is a 42 mm object throwing a shadow
//  onto firelit stones from 300 mm away; buying a matching customDepthMaterial
//  would be a second program and a second compile for a silhouette nobody can
//  resolve.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { C } from './camp_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';
// The core-darkening term reads uStyleWrap and uStyleFloor to find out how much
// of the direct diffuse Stylize's wrap is responsible for; see msWrapShare. Both
// are declared by this patch and by nothing else, so the material would fail to
// LINK if it were built before the patch ran. Engine constructs Stylize long
// before any camp prop exists, and the labs call it themselves, so this is a
// belt on top of a brace — but it is the difference between a hard dependency
// and a hoped-for one, and the call is idempotent.
import { patchStylizedLighting } from '../render/Stylize.js';

const TAU = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
//  The marshmallow's shape, as the simulation understands it
//
//  Real marshmallow proportions, from the geometry contract: 25 mm long, 21 mm
//  radius — a squat cylinder slightly wider than it is long, with a ~5 mm edge
//  radius. These are defaults; the view passes the real ones off
//  `held.radius` / `held.half` if the geometry author moves them.
// ─────────────────────────────────────────────────────────────────────────────
const MALLOW_R = 0.021;    // radius, metres
const MALLOW_H = 0.0130;   // half-length along its own axis, metres
const MALLOW_E = 0.0050;   // edge radius, metres

// ── the cap, as one direction ───────────────────────────────────────────────
//
// The geometry's UV contract puts v linear across the STRAIGHT BARREL only:
// v = clamp01((z + zBar) / (2 zBar)) with zBar = half - edge, so both round-
// overs and both dished ends run past 0 and 1 and clamp. Each cap therefore
// collapses onto a single row of the toast map, exactly as the poles of a
// sphere do, and the shader draws the whole cap with that row's value.
//
// Which means the sim must give those two rows the normal of the surface they
// actually stand for, not the normal of the barrel strip their v happens to
// land on. Area-weighted over the round-over arc (947 mm^2 per end) and the
// dished flat (804 mm^2), the mean outward direction of one cap is 0.791 along
// the axis and 0.357 radially — normalised, 0.911 / 0.411. That is a surface
// pointing mostly along the stick, which is why the ends of a marshmallow stay
// pale however patiently it is turned, and why they should.
const CAP_AXIAL = 0.911;
const CAP_RADIAL = 0.411;
// ── and the length that was thrown away when those were normalised ──────────
//
// (0.791, 0.357) has magnitude 0.868, and the line above divides it out. That
// is a real loss, not a tidy-up. A curved patch's Lambertian response to a
// source is the area-weighted integral of its own cosine, and to first order
// that integral IS the un-normalised mean normal — the shortfall from 1 is
// precisely the cancellation between parts of the cap that face different
// ways. Normalising asserts the cap is a flat facet that happens to be tilted,
// which over-states what it collects by 15%.
//
// It matters because of which texel that is. The view holds the stick pointing
// at the fire (axis . toFire = 0.85 at the default height), so the far cap
// faces the flame squarely and, unlike every texel on the barrel, it does not
// turn away — it is the texel `peak` reports, and the round-10 brief asks why
// `peak` runs ahead of `doneness` under steady rotation. This is a third of
// the answer; the rest is in the header, under the same question.
//
// Applied to the RADIATIVE term only. The convective term's isotropic share is
// not a cosine of anything and must not be scaled, and its directed share is
// small on a surface that points along the stick.
const CAP_RESP = 0.868;
// Where that cap sits, area-weighted: 11.7 mm out along the axis at a mean
// radius of 12.5 mm. Only the heat falls off with this, and it falls off over
// 260 mm, so a couple of millimetres of error here is not a number anyone can
// see. It is here so the cap is not integrated at the barrel's position.
const CAP_S = 0.0117;
const CAP_R = 0.0125;

// ─────────────────────────────────────────────────────────────────────────────
//  Heat
//
//  All heat is in units where 1.0 is "the underside of a marshmallow held at the
//  nominal roasting pose" — 250 mm above the flame's hottest point, on the
//  fire's axis, facing straight down at it. Every rate below is quoted against
//  that, which is the only way these numbers can be reasoned about at all.
// ─────────────────────────────────────────────────────────────────────────────

// The pose the unit is defined at, and the softening on the inverse square.
//
// REF_D is a normaliser, not a clamp: the radiative term is
// RAD_GAIN * ndl * REF_D^2 / (dist^2 + SOFT_D^2), so at dist = REF_D and ndl = 1
// it is RAD_GAIN * 0.89 and the falloff either side of it is the real 1/r^2.
//
// SOFT_D exists because the player is allowed to put the marshmallow IN the
// fire. The view's lower bound is 100 mm over the flame top, but the mallow is
// 42 mm across and the flame is not a point, so a texel can end up 20 mm from
// the hot point — where an unsoftened inverse square is 170x the nominal heat
// and the toast integrator takes a single frame to go from raw to charcoal. At
// 90 mm the softening caps the near field at about 8x nominal, which is fast
// (about two seconds to black) and still an event the player can watch happen.
const REF_D = 0.26;
const SOFT_D = 0.09;
const RAD_GAIN = 0.70;

// ── THE FLAME IS NOT A POINT, AND THE HEAT NEVER KNEW IT ────────────────────
//
// The material below already knows this. SRC_RADIUS is 0.24 m, derived from
// camp_fire.js's own flame geometry (a cone of base radius 0.256 m and height
// 0.800 m has the volume of a sphere of radius 0.236 m), and the whole reason
// the round-7 translucency work finally landed was that the LIGHT stopped
// being modelled as a filament at a quarter of a metre. The HEAT was left on
// the point model, and it is the same source, at the same range, seen by the
// same surface.
//
// What that costs is not a scale factor, it is a SHAPE. A point source lights
// exactly the hemisphere facing it and nothing else, so `max(dot(N, toFire), 0)`
// is zero for every texel whose normal is a degree past the terminator. A
// source of radius R at distance d subtends a half-angle asin(R/d) — at the
// roasting pose, 0.236 / 0.301 = 52 degrees — so a texel whose normal is
// *perpendicular* to the fire still sees half of a very large flame, and one
// pointing 40 degrees away still sees part of it. Nothing goes dark until the
// normal is more than 90 + 52 degrees off.
//
// That is not a subtlety here, it is the difference between a mechanic and a
// dead zone, because of how the view holds the stick. Measured off
// tools/_scratch/roastmat.mjs, the marshmallow's own axis points within 8
// degrees of the fire at the bottom of the height band (axis . toFire = 0.99
// at h = 0.10) and swings to 59 degrees at the top (0.52). Under the point
// model the barrel's radiative term therefore COLLAPSES exactly where the
// marshmallow is closest — the perpendicular component of the fire direction
// is only 0.14 there — and the turn-averaged heat came out NON-MONOTONE across
// the band: 0.241 at h = 0.10 against 0.242 at h = 0.16. Lowering the stick
// bought the player nothing at all, which is the round-10 defect in one line.
//
// The soft form is the standard wrapped-diffuse one, and it is chosen because
// its two endpoints are the geometry rather than a taste:
//
//     w    = R / d                        sine of the source's angular radius
//     nds  = ( dot(N, toFire) + w ) / ( 1 + w )
//
// It is exactly 1 for a texel facing the fire, whatever w is, so the unit this
// whole file is quoted in — "1.0 is the underside of a marshmallow at the
// nominal pose" — is untouched. It reaches zero exactly when the source has
// fully set below the texel's horizon, which is the correct geometric edge.
// In between it is within about 15% of Sparrow's exact sphere-to-differential
// -element form factor, which is a good deal better than the point model's
// error at this range (a factor of TEN on the barrel at h = 0.10).
//
// What it is worth, all measured by tools/_scratch/toastheat.mjs against the
// real hold, turn-averaged barrel heat down the height band:
//
//     point model    0.241  0.242  0.219  0.184  0.150  0.116   (non-monotone)
//     sphere source  0.437  0.378  0.295  0.226  0.176  0.130   (3.4 : 1)
//
// WHY THE FALLOFF IS LEFT ALONE. The other half of an extended-source model is
// to put R into the distance term as well — 1 / (d^2 + R^2), which is what
// SRC_RADIUS does for the light. It is deliberately NOT done here, and the
// reason is that SOFT_D is already that term and it is a GAMEPLAY number, not
// a photometric one: its own note says it exists to bound what happens when
// the player shoves the marshmallow into the flame. Replacing 0.09 with 0.236
// would flatten the near field so hard that the bottom of the height band
// stopped being dangerous, which is the opposite of the brief. The horizon
// correction has no such side effect — it is pure geometry and it acts on the
// angle, not on the range.
const SRC_R = 0.236;

// The thermal plume. A camp fire's hot air rises in a column roughly as wide as
// the fire and loses its heat to entrainment over about a third of a metre, so
// PLUME_R is a horizontal bell and PLUME_H a vertical one. Both are rational
// falloffs rather than exponentials: 288 texels x 2 exp() a frame is not a real
// cost, but the shapes are indistinguishable and this one is exact.
//
// Below the flame top the vertical term is held at 1 — a texel down there is
// already being cooked by the radiative term at close range and does not need
// the plume to also run away.
//
// ── PLUME_R WAS 0.30 AND THE GAME MEASURED THE MARSHMALLOW AT 0.32 OFF AXIS ──
//
// Every rate in this file is quoted against "250 mm above the flame's hottest
// point, ON AXIS", and tools/_scratch/toastsim.mjs drives exactly that pose,
// and it is not the pose the game holds. Read off the harness's own state dump
// (shots/roast/r2-lab/ROAST.json, mallow-uneven): the fire's hot point is at
// (-1014.994, 6.825, -1002.879) and the marshmallow is at (-1014.811, 7.028,
// -1003.143). That is 0.203 m above it, as camp_roast_view.js's height control
// promises — and 0.321 m horizontally away from the fire's axis, because the
// view holds the stick out to the right and toward the lens so the marshmallow
// does not hide the flame. Distance to the hot point is therefore 0.380 m, not
// 0.250.
//
// At PLUME_R 0.30 the horizontal bell at 0.321 m is 0.217, so the convective
// term — the term the whole turning mechanic rests on — was running at a fifth
// of the strength every number in this file was cut for. The consequence is
// measured and it is severe: the harness simulated sixty-three seconds of an
// unturned marshmallow at the bottom of the height band and got doneness 0.072
// with a single texel at 0.80, against a tuning table that says a black side in
// twenty seconds. The `uneven` frame — the failure the entire mechanic is about
// — came back as a picture of a raw marshmallow, and roastshot.mjs printed the
// complaint itself.
//
// 0.42 is the half-width that covers where the game actually holds it. It is
// also the more honest number for the object: a camp fire in a 0.6-0.9 m stone
// ring does not have a 0.6 m-wide plume, and the 0.30 was measured against
// nothing but a guess. On axis — which is what toastsim drives — the bell is
// 0.98 either way, so the tuning table below is unchanged by this; it only
// moves the case that was wrong.
const PLUME_R = 0.42;
const PLUME_H = 0.34;
const CONV_GAIN = 0.46;

// How the convective term splits between "bathed in hot air" and "the hot air is
// coming from below". CONV_ISO is a floor every texel gets, which is what stops
// the top of the marshmallow from being untouched — a marshmallow over a fire
// really does warm all over — and CONV_DOWN is the asymmetry that makes turning
// the skill.
//
// The ratio was chosen against the two-number target rather than from physics:
// pushing CONV_ISO up narrows the gap between a turned and an unturned mallow
// (and eventually removes the mechanic), pushing CONV_DOWN up widens it until
// the unturned mallow ignites before the turned one is warm.
//
// ── 0.55 / 1.60 -> 0.20 / 2.75, AND THE SUM IS DELIBERATELY UNCHANGED ───────
//
// Round 10 has to satisfy two demands at once that pull against each other,
// and this is the only place in the file where they can be separated.
//
//   · the HEIGHT band must span a legible range of cook times, and the top of
//     it must still reach golden — the lead's ruling, in about twice the
//     default's time and no more.
//   · a marshmallow that is NEVER TURNED must have a black side inside about
//     twenty seconds, which is a much bigger time ratio than the height band's.
//
// BROWN_P is one exponent and it acts on both. Raising it to buy the
// never-turn contrast pushes the top of the height band to three or four times
// the default and back toward the dead zone the lead rejected; lowering it to
// keep the top alive flattens the turned-against-unturned gap the whole
// mechanic rests on. The way out is to stop asking the exponent for the
// orientation contrast and put it back where it belongs — in the heat.
//
// Averaged over a steady turn a texel sees 1/pi of CONV_DOWN and all of
// CONV_ISO, so the turn average of the orientation factor is
//
//     CONV_ISO + CONV_DOWN / pi
//        old    0.55 + 1.60/pi  =  1.059
//        new    0.20 + 2.75/pi  =  1.075
//
// i.e. the same to a percent and a half: a patient turner's cook rate is not
// touched by this change and TOAST_K did not have to absorb it. What moves is
// the SPREAD around that average. Facing straight down the factor goes from
// 2.15 to 2.95, facing straight up from 0.55 to 0.20, so the hot side of an
// unturned marshmallow gains and its top loses. Measured at the real hold by
// tools/_scratch/toastheat.mjs, at the default height:
//
//     heat            turn-avg   unturned hot   unturned top   hot/avg
//       0.55 / 1.60      0.290       0.579          0.099        2.00
//       0.20 / 2.75      0.295       0.700          0.050        2.37
//
// and 2.37 is what lets BROWN_P stay at 0.75 and still put a black side on an
// unturned marshmallow in 23 s. The physics is not strained by it either: the
// isotropic share is entrainment of already-cooled air around the sides of a
// plume and the directed share is the plume itself, and 20 : 80 is a great
// deal closer to a real buoyant column than 34 : 66 was.
//
// What it costs is the thing CONV_ISO was there for — "a marshmallow over a
// fire really does warm all over". It still does: the top face of an unturned
// marshmallow at the default height sits at 0.050 heat units, of which 0.032
// is the new radiative horizon term (see SRC_R) reaching round the limb, and
// it browns to about 0.2 in the time the underside blackens. That is a pale
// top rather than a raw one, which is what it should look like.
const CONV_ISO = 0.20;
const CONV_DOWN = 2.75;

// What a fully live texel is worth in the B channel — i.e. the heat at which
// the channel saturates. The number matters because two consumers read it as a
// 0..1: the crack glow in the shader and the sizzle in the audio. And a third
// reads it as an absolute: IGNITE_HEAT is quoted in these units, so this
// constant decides whether the marshmallow can catch fire at all.
//
// ── 1.6 -> 0.90, BECAUSE 1.6 MADE THE WHOLE B CHANNEL UNREACHABLE ──────────
//
// 1.6 was set against the on-axis table, where the hottest texel of a
// marshmallow held still sat at 1.41 heat units. At the pose the view actually
// holds, measured by tools/_scratch/toastheat.mjs, the hottest texel of an
// unturned marshmallow at the default height sits at 0.700 — so the channel
// never got past 0.44, the crack glow ran at under half, the sizzle had its
// top half of range permanently unused, and IGNITE_HEAT's 0.70 was ABOVE
// anything reachable anywhere in the height band. A marshmallow in the shipped
// build could not be set on fire. `burning`, `douse()`, the parented flame, the
// roar, the `burnt` grade and the blow-out cooldown were all dead code, and the
// harness's own table said so at every height: "alight  never".
//
// 0.90 restores the ladder the original note describes, at the real pose:
//
//     an ordinary hot side (unturned, default height)   0.700  ->  0.78
//     the bottom of the height band (unturned, 0.10)    0.858  ->  0.95
//     alight, supplying its own heat (BURN_HEAT)        1.10   ->  1.00
//
// so the sizzle and the glow use their range, the last of it is reserved for a
// marshmallow that is genuinely in trouble, and ignition becomes possible low
// and impossible high — which is exactly the shape of the height band's
// promise. See IGNITE_HEAT for where that line falls.
const HEAT_FULL = 0.90;

// How fast a texel's own surface temperature follows the heat falling on it.
// Asymmetric, because the physics is: a 2 mm skin of sugar heats quickly and,
// once the fire is off it, dumps that heat into 40 mm of cold foam behind it and
// into the air. Both are short — this channel is what makes the glowing cracks
// die when you lift the mallow away, and a slow one reads as a bug.
const LIVE_UP = 0.20;    // seconds, rising
const LIVE_DOWN = 0.40;  // seconds, falling

// ─────────────────────────────────────────────────────────────────────────────
//  Caramelisation
//
//  Sugar browns over a narrow temperature band and it browns faster once it has
//  started, because the products of the first reactions catalyse the next ones
//  and because a browned surface absorbs more of the radiation falling on it.
//  Three parameters express exactly that:
//
//    BROWN_T   the floor. Below it nothing happens at all.
//    BROWN_P   the exponent on the drive.
//    TOAST_ACC how much faster it goes once it is already brown. This is the
//              other half of "the last third is compressed": the ramp does it in
//              colour, this does it in time.
//
//  ── ROUND 10: THE CURVE WAS FOUR TIMES TOO SLOW AND THE TOP WAS DEAD ───────
//
//  These three were 0.12 / 1.25 / 1.60 with TOAST_K 0.0375, and the arithmetic
//  that set them was done at the on-axis pose the view does not use. Measured
//  in the live game at the shipped default height, turning at 2.0 rad/s:
//
//    t (s)        10     20     30     40     50     60     70     80     90
//    doneness   .031   .064   .096   .129   .163   .199   .235   .275   .317
//
//  which puts golden (0.55) at about 155 s against a target of 35-55, leaves
//  the eat gate at 0.15 shut for the first 45 seconds — the player reported
//  that separately, as "E does nothing" — and, at the top of the height band,
//  never gets there at all. tools/_scratch/toastband.mjs put h = 0.40 and
//  h = 0.50 at "never" and doneness 0.09 after two minutes.
//
//  ONE CAUSE, AND IT IS BROWN_T. The threshold's own note used to say it was
//  "the single most important number in the file for how the mechanic FEELS",
//  because without it "there is no such thing as safe". That was true and it
//  is now the wrong design: the lead's ruling is that a player who holds the
//  stick high is playing the patient, safe version of the mechanic and must
//  still get a golden marshmallow, never be quietly doing nothing. A threshold
//  is a cliff, and 0.12 sat straight across the band — the turn-averaged heat
//  at the top of it is 0.130, so the drive there was (0.130 - 0.12) = 0.010,
//  a hundred and thirtieth of the heat that was falling on it.
//
//  So BROWN_T drops to 0.01, where it is a floor rather than a cliff: it stops
//  a texel with essentially nothing on it from accumulating (which matters now
//  that BROWN_P is below 1 and the curve is concave near zero), and it costs
//  the top of the band about six percent of its rate instead of all of it.
//
//  ── WHY BROWN_P IS 0.75 AND NOT SOMETHING ABOVE 1 ─────────────────────────
//
//  Because at the real hold the height band and the orientation band are the
//  same size, and they want opposite exponents.
//
//    turn-averaged heat, h = 0.10 / 0.24 / 0.50    0.437  0.295  0.130
//    at the default height, turn-avg / hot / top   0.295  0.700  0.050
//
//  The height band spans 2.27 : 1 from default to top and wants a TIME ratio
//  of about 2 : 1 (the lead's "1.5-2x"), which is an exponent a little under
//  1. The orientation band spans 2.37 : 1 from turn-average to unturned hot
//  side and wants a time ratio of about 0.55 : 1 (a black side at 23 s against
//  golden at 40), which after the TOAST_ACC correction is an exponent of about
//  1.6. One number cannot be both. The exponent was therefore set by the
//  height requirement — it is the one with a hard ceiling on it — and the
//  orientation contrast was moved into the heat, where it belongs, by
//  re-splitting CONV_ISO / CONV_DOWN. See the long note there.
//
//  0.75 also keeps the property the old 1.25 was chosen for: it is d / d^0.25,
//  two sqrt()s and a divide, and there is still no pow() in the inner loop.
//
//  ── AND TOAST_ACC 1.60 -> 2.80 -> 4.50, WHICH IS WHERE IT ALWAYS WANTED ───
//
//  This is the one term that changes the RATIO of "time to a black side" to
//  "time to golden" without touching the height band at all, because it acts
//  on T and not on h. Integrating dT/dt = K D (1 + A T^2),
//
//      t(T) = atan( sqrt(A) T ) / ( sqrt(A) K D )
//
//  so the ratio the never-turn target lives on is
//
//      t(1) / t(0.55) =  A = 1.60  ->  1.484
//                        A = 2.80  ->  1.387
//                        A = 4.50  ->  1.311
//                        A = 6.00  ->  1.269
//
//  (the 1.269 the earlier edition of this table printed against 4.50 was the
//  A = 6.00 row; the arithmetic is one line of node and it is worth re-running
//  rather than inheriting.) The never-turn target wants that ratio as small as
//  it will go, and what used to stop it was `evenness`: an accelerating curve
//  amplifies whatever spread the surface already has, and the surface had a
//  spread the player could not remove — the 13.9-degree spear skew. At 4.50 it
//  put `evenness` at golden at 0.782 against a 'perfect' threshold of 0.78, so
//  the top grade was a coin toss between camps and A had to sit at 2.80.
//
//  THE SKEW IS GONE (see the header). Re-measured with the straight-speared
//  geometry, tools/_scratch/_evsplit.mjs at the default height:
//
//      A = 2.80  0.950 at 2.0 rad/s        A = 4.50  0.950 at 2.0 rad/s
//                0.952 at 9.5 (cruise)               0.952 at 9.5
//
//  i.e. the constant barely moves `evenness` at all once the bias it was
//  amplifying is not there, and both clear 'perfect' by 0.17. The whole band at
//  4.50 runs 0.939 to 0.975. So the term is free to do the job it is for.
//
//  WHY 4.50 AND NOT MORE. Because the returns fall off and the golden window
//  pays for them. Solved in closed form at a fixed 40 s to golden, the
//  never-turn black side at the default height reads
//
//      A = 2.80   24.9 s        A = 6.00   22.8 s
//      A = 4.50   23.5 s        A = 8.00   22.1 s
//
//  — 4.50 takes half of everything available between 2.80 and 8.00 — while the
//  golden window t(0.80) - t(0.55) at the default height goes 11.4 s -> 9.3 s
//  -> 8.1 s -> 7.0 s and the eat gate slides 13.5 -> 14.7 -> 15.4 -> 16.3 s.
//  9.3 seconds is still the widest single thing on the clock and it is the
//  pressure the mini-game is for; 7.0 would not be. 4.50 is the knee.
//
//  AND TOAST_K MOVES WITH IT, WHICH IS THE POINT OF HAVING BOTH. A alone is a
//  shape and it drags the absolute times with it: at the old K of 0.0326, going
//  to 4.50 pulls golden at the default height from 40.3 s to 36.6 s and the top
//  of the band from 81.7 s to 74.3 s. Neither is out of contract, but 36.6 s
//  offline is 35.8 s live and the contract's floor is 35 — no margin at all for
//  a camp that solves a slightly different backdrop — and the top of the band
//  is the row the lead verified by hand at 80.4 s. Re-solving K instead holds
//  both: the anchor stays at 40 s, the top stays at 81, MELT_K's derivation off
//  "golden arrives at 40 s" stays true, and the never-turn contrast is bought
//  out of the shape rather than out of the clock.
//
//  TOAST_K is not guessed at either. tools/_scratch/toasttune.mjs solves it in
//  closed form: the integrator is separable, so once the marshmallow has turned
//  a few times every texel is on a fixed time-averaged drive D_i and `doneness`
//  at any time is a mean of tangents. Bisecting that mean for the K that puts
//  the default height at 40 seconds returns 0.02986 at A = 4.50 (and 0.03262 at
//  the old 2.80, which is the shipped 0.0326 to three figures — the closed form
//  and the real ToastMap agree here now). 0.0299 is that number confirmed
//  against the real ToastMap by toastband.mjs, which lands golden at 39.9 s.
//  The whole re-derived table is in the header.
// ─────────────────────────────────────────────────────────────────────────────
const BROWN_T = 0.01;
const TOAST_ACC = 4.50;
const TOAST_K = 0.0299;

// Char is a separate reaction past the end of browning, so it has its own gate
// and its own rate. CHAR_FROM/CHAR_TO is where sugar stops going darker and
// starts going to carbon; the smoothstep between them is what stops a texel
// from crossing into char on a single frame's worth of heat.
const CHAR_FROM = 0.72;
const CHAR_TO = 1.00;
const CHAR_K = 0.100;

// Ignition, with hysteresis in TIME rather than in the threshold. A pure
// threshold on a value that is being integrated at a heat level that itself
// wobbles (the fire's `power` flickers, and the player's hand moves) will chatter
// on and off across it, and `burning` is a boolean the view hangs a flame, a
// sound and a scoring outcome on. So the conditions have to hold continuously
// for IGNITE_DWELL before the flag is raised — and once it is raised, the
// marshmallow supplies its OWN heat (BURN_HEAT), which is a far stronger latch
// than any threshold: it cannot fall back below the line while it is alight.
// Only `douse()` puts it out.
const IGNITE_CHAR = 0.78;
// In B-channel units, so against HEAT_FULL 0.90 this is 0.63 heat units — and
// that number is now doing a second job the old one could not, because it is
// the line the height band's promise is measured on. Unturned hot-side heat,
// down the band: 0.858 / 0.814 / 0.700 / 0.574 / 0.461 / 0.351. So a
// marshmallow left alone can catch fire anywhere below about h = 0.28 and
// cannot catch fire at all above it, however long it is left there. "Low is
// risky, high is safe" is that inequality and nothing else.
//
// Under the old HEAT_FULL of 1.6 the same 0.70 meant 1.12 heat units, which is
// above the hottest texel reachable anywhere in the view — see the note there.
const IGNITE_HEAT = 0.70;
// How much of the surface has to hold BOTH of those at once before it is
// alight. See the long note at the ignition block in update(); the short
// version is that this used to be one texel out of 288 and the one texel it
// kept picking was the far cap, which no amount of turning can cool.
const IGNITE_FRAC = 0.10;
const IGNITE_DWELL = 0.40;
// What a marshmallow that is on fire does to itself. The view's contract says
// "the toast runs away fast", and it wants forgiving rather than punishing.
//
// 1.60 -> 1.10, because BROWN_P moved. The requirement is unchanged: a
// half-toasted marshmallow should be ruined in about five seconds, long enough
// to notice, react and tap it out. At drive = (1.10 - 0.01)^0.75 = 1.067 the
// integrator takes T from 0.5 to 1.0 in
//
//     [ atan(2.121) - atan(1.061) ] / ( 2.121 * 0.0299 * 1.067 )  =  4.7 s
//
// where 2.121 is sqrt(TOAST_ACC) — so this line has to be re-run whenever that
// constant moves, and it was quietly wrong for the stretch when TOAST_ACC sat
// at 2.80 and this arithmetic still read 4.50's sqrt (the true answer there was
// 5.8 s, not 4.7). At the shipped 4.50 / 0.0299 it is 4.66 s and the five
// seconds the requirement asks for is met again. The old 1.60 under the same
// numbers would have done it in 3.5, which is too fast to react to. It is
// also comfortably over HEAT_FULL, so a marshmallow that is alight pins the
// live channel at 1.0 and the sizzle turns into a roar with nothing left over.
const BURN_HEAT = 1.10;

// Melt accumulates total heat and never comes back. Its threshold is lower than
// browning's — sugar softens well before it colours, which is why a marshmallow
// can be visibly sagging and still pale — and MELT_K is set so the mallow is
// noticeably slumped (0.35) at the moment a patient player would take it off.
//
// Both moved with everything else. MELT_T has to stay under BROWN_T for the
// ordering above to mean anything, and BROWN_T is now 0.01; and the melt
// accumulator is inside the `excess > 0` branch, so a threshold above BROWN_T
// would be silently doing nothing for the coldest texels either way. MELT_K is
// then read straight off the anchor: at the default height a turned texel sits
// at 0.295 heat units and golden arrives at 40 s, so 0.35 / (40 * 0.290) =
// 0.030. The top of the height band lands at 0.31 melt at ITS golden, which is
// the right answer — a marshmallow that took twice as long has had twice as
// long to soften at half the rate.
const MELT_T = 0.005;
const MELT_K = 0.030;

// Where `ruined` starts counting a texel, and how much of the surface has to be
// there before grade() calls the whole thing charred.
const RUIN_CHAR = 0.45;
const RUIN_FRAC = 0.16;
// And where mean toast alone is enough to call it charred, regardless of how
// even it is. 0.84 rather than 0.88 because the ramp puts 0.80 at mahogany and
// 0.94 at black: above 0.84 the whole surface is past deep brown, and leaving
// the threshold higher opened a five-second window in the sim where a uniformly
// near-black marshmallow was graded 'nicely toasted'.
const RUIN_DONE = 0.84;

/**
 * The five outcomes, in the order they are ranked.
 *
 * Verbatim from the contract. `grade()` returns one of these keys with the
 * measured numbers attached; the view turns it into the single line of text that
 * is the only score this game shows.
 */
export const RESULTS = [
  { key: 'perfect', label: 'golden all over' },   // doneness .55-.80, evenness > .78
  { key: 'good',    label: 'nicely toasted'  },
  { key: 'pale',    label: 'barely warmed'   },
  { key: 'uneven',  label: 'toasted on one side' },
  { key: 'burnt',   label: 'charred'         },
];

const RESULT_BY_KEY = Object.fromEntries(RESULTS.map((r) => [r.key, r]));

/**
 * Where one row of the toast map lives on the marshmallow, and which way it
 * faces: the axial coordinate `s`, the distance `r` from the axis, and the
 * outward normal split into its axial and radial parts.
 *
 * This is the whole reason the simulation needs no geometry. The
 * parameterization is a contract — u is the angle about the marshmallow's own
 * axis from its local +X, and v is
 *
 *     v = clamp01( ( z + zBar ) / ( 2 * zBar ) ),  zBar = half - edge
 *
 * i.e. linear across the STRAIGHT BARREL, with both round-overs and both dished
 * flats running past 0 and 1 and clamping. So position and normal are analytic
 * for every texel, and the sim keeps working if the geometry author changes how
 * the mesh is tessellated. It also means the sim would keep working and be
 * WRONG if the parameterization itself changed, which is why the formula above
 * is quoted rather than referred to.
 *
 * The consequence of the clamp is that each cap is a POLE: every vertex of the
 * round-over and the dish carries v = 0 (or 1), so the shader draws the entire
 * cap from a single row of the map, and that row therefore has to carry the
 * cap's own orientation rather than the barrel's. See CAP_AXIAL.
 */
function texelGeometry(j, bands, R, H, E) {
  const e = Math.min(E, Math.min(R, H) * 0.49);
  const zBar = H - e;
  // The pole rows. Everything the geometry clamps to v = 0 or v = 1 — the
  // round-over and the dished flat at that end — is drawn from this one row, so
  // this one row has to BE that cap.
  if (j === 0 || j === bands - 1) {
    const sgn = j === 0 ? -1 : 1;
    return {
      s: sgn * (CAP_S * (H / MALLOW_H)),
      r: CAP_R * (R / MALLOW_R),
      axial: CAP_AXIAL * sgn,
      radial: CAP_RADIAL,
    };
  }
  // Everything else is the straight barrel, where v is linear in the axial
  // coordinate and the outward normal is purely radial.
  const v = (j + 0.5) / bands;
  return { s: lerp(-zBar, zBar, v), r: R, axial: 0, radial: 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ToastMap
// ─────────────────────────────────────────────────────────────────────────────
export class ToastMap {
  /**
   * @param opts.rings  angular texels (u). Default 24 — 15 degrees apiece.
   * @param opts.bands  axial texels (v). Default 12.
   * @param opts.axis   the marshmallow's own axis in ITS OWN local space.
   *                    Default +Z, because the held stick runs along +Z from the
   *                    grip and the mallow is speared on it. If the geometry
   *                    author lathes the mallow about +Y instead, pass it — the
   *                    only thing that would go wrong otherwise is that the map
   *                    would be rotated 90 degrees on the object, which reads as
   *                    "the toast is in the wrong place" rather than as a crash.
   */
  constructor(opts = {}) {
    this.rings = Math.max(4, opts.rings ?? 24);
    this.bands = Math.max(2, opts.bands ?? 12);
    this.radius = opts.radius ?? MALLOW_R;
    this.half = opts.half ?? MALLOW_H;
    this.edge = opts.edge ?? MALLOW_E;
    const n = this.rings * this.bands;
    this.count = n;

    // ── the authoritative state ───────────────────────────────────────────
    // Float32, not the texture's bytes. The texture is an 8-bit *copy* for the
    // shader; integrating in 8 bits would quantise a 45-second toast into 255
    // steps and, worse, would lose every increment smaller than 1/255 — which
    // at the rates above is most of what a marshmallow held high over the fire
    // ever accumulates. It would simply never toast.
    this.toast = new Float32Array(n);
    // Named `wetness` rather than `melt` because `melt` is the getter that
    // returns its area-weighted mean, and a field and an accessor cannot share
    // a name on the same object.
    this.wetness = new Float32Array(n);
    this.live = new Float32Array(n);
    this.char = new Float32Array(n);

    // ── the analytic surface, precomputed once ────────────────────────────
    // Local-space position and normal per texel. Neither changes; only the
    // world matrix does, so update() is 288 matrix applications and no
    // trigonometry at all.
    this.lp = new Float32Array(n * 3);
    this.ln = new Float32Array(n * 3);
    // Relative area of each texel, so `doneness`, `evenness` and `ruined` are
    // area-weighted. A texel on the corner arc covers less surface than one on
    // the barrel, and an unweighted mean would over-count the ends — which are
    // exactly the texels that behave differently from everything else.
    this.area = new Float32Array(n);
    this._buildSurface(opts.axis);

    // Scratch, reused every frame. Allocating a Vector3 per texel per frame is
    // 288 allocations a frame for the whole time the view is up.
    this.wp = new Float32Array(n * 3);
    this.wn = new Float32Array(n * 3);

    // ── running aggregates ────────────────────────────────────────────────
    // Maintained by the one pass in update(), so every getter is a field read.
    // 288 texels is small enough that re-scanning would not be a crime, but the
    // getters are read several times a frame by the view, the HUD and the audio,
    // and "cheap" was written into the contract for a reason.
    this._doneness = 0;
    this._evenness = 1;
    this._peak = 0;
    this._ruined = 0;
    this._melt = 0;
    this._liveMax = 0;
    this._burning = false;
    this._ignite = 0;       // the dwell accumulator
    this._elapsed = 0;

    // ── the texture ───────────────────────────────────────────────────────
    // RGBA8. wrapS repeats because u = 0 and u = 1 are the same ring of the
    // marshmallow and a clamped seam would flat-spot the toast there; wrapT
    // clamps because v = 0 and v = 1 are the two ends and wrapping them would
    // bleed the far cap onto the near one. Linear on both, so 24 x 12 texels
    // become a smooth field over a surface the player is looking at from 300 mm.
    this.data = new Uint8Array(n * 4);
    const tex = new THREE.DataTexture(
      this.data, this.rings, this.bands, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // DATA, not colour. A DataTexture defaults to NoColorSpace and it must stay
    // there — flag it to sRGB and every channel comes back through a transfer
    // function, which would put a subtle curve on the toast ramp and a wrong one
    // on the melt and live-heat channels, neither of which is a colour at all.
    tex.colorSpace = THREE.NoColorSpace;
    tex.name = 'marshmallow_toast';
    this._tex = tex;
    this._dirty = true;
    this._upload();

    // Scratch for update(); see the note on allocation above.
    this._m3 = new THREE.Matrix3();
  }

  /** Local position, normal and relative area for every texel. */
  _buildSurface(axisOpt) {
    const axis = (axisOpt ? axisOpt.clone() : new THREE.Vector3(0, 0, 1)).normalize();
    // u is measured from the marshmallow's local +X, so +X is the reference
    // spoke — unless the axis IS +X, in which case pick another and say so.
    let e1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(e1.dot(axis)) > 0.99) e1 = new THREE.Vector3(0, 1, 0);
    e1.addScaledVector(axis, -e1.dot(axis)).normalize();
    const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize();

    let areaSum = 0;
    for (let j = 0; j < this.bands; j++) {
      const { s, r, axial, radial } = texelGeometry(j, this.bands, this.radius, this.half, this.edge);
      for (let i = 0; i < this.rings; i++) {
        const u = (i + 0.5) / this.rings;
        const a = u * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const k = (j * this.rings + i) * 3;
        // p = axis*s + (cos u * e1 + sin u * e2) * r
        this.lp[k] = axis.x * s + (ca * e1.x + sa * e2.x) * r;
        this.lp[k + 1] = axis.y * s + (ca * e1.y + sa * e2.y) * r;
        this.lp[k + 2] = axis.z * s + (ca * e1.z + sa * e2.z) * r;
        this.ln[k] = axis.x * axial + (ca * e1.x + sa * e2.x) * radial;
        this.ln[k + 1] = axis.y * axial + (ca * e1.y + sa * e2.y) * radial;
        this.ln[k + 2] = axis.z * axial + (ca * e1.z + sa * e2.z) * radial;
        const l = Math.hypot(this.ln[k], this.ln[k + 1], this.ln[k + 2]) || 1;
        this.ln[k] /= l; this.ln[k + 1] /= l; this.ln[k + 2] /= l;
        // ── the weights are uniform over the MAP, not over the surface ─────
        //
        // And that is a deliberate choice against physical truth, so it gets
        // written down. A squat cylinder is mostly its ends: with the shipping
        // proportions the barrel is 2111 mm^2 and the two caps are 3502 mm^2, so
        // 62% of the real surface lands on 17% of the texels. Weighted by true
        // area, `doneness` becomes a number about the ends — which face along
        // the stick, never face the fire, and reach maybe 40% of the barrel's
        // toast — and the contract's 'perfect' band of 0.55 to 0.80 stops being
        // reachable at all: a barrel at a flawless 0.68 comes out at 0.43.
        //
        // The grade thresholds in the contract are written against a mean over
        // the MAP, and the map is also what the player is looking at. So this is
        // the mean over the map, and the array exists — rather than the code
        // just dividing by the count — because it is the hook the next author
        // needs if that ever has to be revisited.
        this.area[j * this.rings + i] = 1;
        areaSum += 1;
      }
    }
    const inv = 1 / Math.max(areaSum, 1e-9);
    for (let i = 0; i < this.count; i++) this.area[i] *= inv;
  }

  get texture() { return this._tex; }
  get doneness() { return this._doneness; }
  get evenness() { return this._evenness; }
  get peak() { return this._peak; }
  get burning() { return this._burning; }
  get ruined() { return this._ruined; }

  /**
   * Mean melt over the surface, 0..1. Not in the contract's getter list — see
   * the note in the report — but the view needs something to drive `uSag` with
   * and doneness is the wrong signal: a marshmallow held high for two minutes is
   * soft and pale, and a marshmallow flashed black in twenty seconds has barely
   * begun to slump. Melt is the one that says "this is about to fall off".
   */
  get melt() { return this._melt; }

  /** The hottest texel's live heat, 0..1. The sizzle rides this. */
  get heat() { return this._liveMax; }

  /**
   * Integrate one frame of heat.
   *
   * @param dt    seconds
   * @param world THREE.Object3D — the marshmallow mesh, already at its final
   *              world matrix for this frame.
   * @param fire  { pos: THREE.Vector3, top: number, power: number }
   */
  update(dt, world, fire) {
    const d = Math.min(Math.max(dt, 0), 0.1);
    if (d <= 0) return;
    this._elapsed += d;

    // ── where everything is, this frame ───────────────────────────────────
    // The world matrix is read, never written: the view owns the transform and
    // has already placed the stick for this frame. Normals go through the
    // upper 3x3, which is the inverse transpose for a rigid transform — the
    // stick twirls and translates and is never scaled, and a normal renormalised
    // below would survive a uniform scale anyway.
    const mw = world?.matrixWorld;
    const power = Math.max(0, fire?.power ?? 0);
    const haveFire = !!(mw && fire?.pos && power > 0.001);

    let fx = 0, fy = 0, fz = 0;
    if (haveFire) {
      fx = fire.pos.x;
      fy = fire.pos.y + (fire.top ?? 0);
      fz = fire.pos.z;
    }

    if (mw) {
      const e = mw.elements;
      const n3 = this._m3.setFromMatrix4(mw).elements;
      const lp = this.lp, ln = this.ln, wp = this.wp, wn = this.wn;
      for (let k = 0; k < lp.length; k += 3) {
        const x = lp[k], y = lp[k + 1], z = lp[k + 2];
        wp[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        wp[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        wp[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const nx = ln[k], ny = ln[k + 1], nz = ln[k + 2];
        const ax = n3[0] * nx + n3[3] * ny + n3[6] * nz;
        const ay = n3[1] * nx + n3[4] * ny + n3[7] * nz;
        const az = n3[2] * nx + n3[5] * ny + n3[8] * nz;
        const l = Math.hypot(ax, ay, az) || 1;
        wn[k] = ax / l; wn[k + 1] = ay / l; wn[k + 2] = az / l;
      }
    }

    const selfHeat = this._burning ? BURN_HEAT : 0;
    const PR2 = PLUME_R * PLUME_R;
    const PH2 = PLUME_H * PLUME_H;
    const REF2 = REF_D * REF_D;
    const SOFT2 = SOFT_D * SOFT_D;
    // Exponential relaxation constants for the live channel, one exp() per
    // frame rather than one per texel.
    const kUp = 1 - Math.exp(-d / LIVE_UP);
    const kDown = 1 - Math.exp(-d / LIVE_DOWN);

    const rings = this.rings, bands = this.bands;
    const toast = this.toast, meltA = this.wetness, live = this.live, charA = this.char;
    const wp = this.wp, wn = this.wn, area = this.area;

    let sumT = 0, sumMelt = 0, peak = 0, ruined = 0, liveMax = 0;
    // Area of the surface that is BOTH carbonised and still being heated. See
    // the ignition note below for why this is an area and not one texel.
    let alightArea = 0;
    // Per-row means, for the evenness statistic. See the block comment on
    // `_evenness` below for why the statistic is row-relative.
    const rowSum = this._rowSum ??= new Float64Array(bands);
    const rowW = this._rowW ??= new Float64Array(bands);
    rowSum.fill(0); rowW.fill(0);

    for (let j = 0; j < bands; j++) {
      // The two pole rows stand for whole caps rather than for facets, so what
      // they collect is the area-integral of a cosine over a curved patch and
      // not the cosine of one direction. See CAP_RESP. Hoisted here so the
      // inner loop pays nothing for it.
      const resp = (j === 0 || j === bands - 1) ? CAP_RESP : 1;
      for (let i = 0; i < rings; i++) {
        const idx = j * rings + i;
        const k = idx * 3;

        // ── incident heat ────────────────────────────────────────────────
        let h = selfHeat;
        if (haveFire) {
          const dx = fx - wp[k], dy = fy - wp[k + 1], dz = fz - wp[k + 2];
          const dist2 = dx * dx + dy * dy + dz * dz;
          const dist = Math.sqrt(dist2) || 1e-6;
          // Radiative: how squarely this texel looks at the flame, over how far
          // away it is. The only term the twirl acts on.
          //
          // `nds` is the sphere-source horizon, not a plain clamped cosine —
          // see SRC_R. `sw` is the sine of the flame's angular radius from
          // here, so a texel side-on to a fire that subtends 52 degrees still
          // sees half of it, and only a texel more than 90 + asin(sw) degrees
          // away sees none.
          const ndl = (wn[k] * dx + wn[k + 1] * dy + wn[k + 2] * dz) / dist;
          // Named `sw` and not `w` because `w` is the texel's area weight a
          // few lines down and one of the two would have shadowed the other.
          const sw = dist > SRC_R ? SRC_R / dist : 1;
          const nds = (ndl + sw) / (1 + sw);
          if (nds > 0) h += RAD_GAIN * power * resp * nds * REF2 / (dist2 + SOFT2);
          // Convective: the plume. A horizontal bell about the fire's axis, a
          // vertical one above the flame top, and an orientation term that is
          // mostly isotropic with a strong bias toward whatever faces down.
          const rx = wp[k] - fx, rz = wp[k + 2] - fz;
          const rho2 = rx * rx + rz * rz;
          let pm = PR2 / (PR2 + rho2);
          pm *= pm;
          const above = wp[k + 1] - fy;
          const vert = above <= 0 ? 1 : PH2 / (PH2 + above * above);
          const down = wn[k + 1] < 0 ? -wn[k + 1] : 0;
          h += CONV_GAIN * power * pm * vert * (CONV_ISO + CONV_DOWN * down);
        }

        // ── live heat: the surface's own temperature ─────────────────────
        const target = clamp01(h / HEAT_FULL);
        const cur = live[idx];
        live[idx] = cur + (target - cur) * (target > cur ? kUp : kDown);

        // ── caramelisation ──────────────────────────────────────────────
        // drive = (h - BROWN_T)^0.75, computed without pow(): x^0.75 is
        // x / x^0.25, which is two sqrt()s and a divide. Below the floor
        // nothing happens at all — see the block above for why that floor is
        // now 0.01 and not the cliff it used to be.
        const excess = h - BROWN_T;
        let t = toast[idx];
        if (excess > 0) {
          const q = Math.sqrt(Math.sqrt(excess));
          const drive = excess / q;
          t += TOAST_K * drive * (1 + TOAST_ACC * t * t) * d;
          if (t > 1) t = 1;
          toast[idx] = t;

          // Char: a separate reaction, gated past the end of browning.
          if (t > CHAR_FROM) {
            const g = smoothstep(CHAR_FROM, CHAR_TO, t);
            const c = charA[idx] + CHAR_K * drive * g * d;
            charA[idx] = c > 1 ? 1 : c;
          }

          // Melt: total heat, never decays. Lower threshold than browning —
          // sugar softens before it colours.
          if (h > MELT_T) {
            const m = meltA[idx] + MELT_K * (h - MELT_T) * d;
            meltA[idx] = m > 1 ? 1 : m;
          }
        }

        // ── aggregates, in the same pass ────────────────────────────────
        const w = area[idx];
        sumT += t * w;
        sumMelt += meltA[idx] * w;
        rowSum[j] += t * w;
        rowW[j] += w;
        if (t > peak) peak = t;
        const c = charA[idx];
        if (c > RUIN_CHAR) ruined += w;
        const lv = live[idx];
        if (lv > liveMax) liveMax = lv;
        if (c > IGNITE_CHAR && lv > IGNITE_HEAT) alightArea += w;
      }
    }

    this._doneness = sumT;
    this._melt = sumMelt;
    this._peak = peak;
    this._ruined = ruined;
    this._liveMax = liveMax;

    // ── evenness, and why it is measured ROUND the marshmallow ────────────
    //
    // The contract fixes the two ends of this number — 1 is perfectly even, 0 is
    // one side black and one side white — and leaves the middle to this file.
    // The obvious statistic (standard deviation over the whole surface) fails a
    // test the mechanic depends on: the ends of a marshmallow toast more slowly
    // than its barrel no matter how patiently it is turned, because their
    // normals point along the stick and never face the fire. Measured that way a
    // flawlessly turned marshmallow scores about 0.77 and can never be graded
    // 'perfect', and the player has no move available that would fix it.
    //
    // So evenness is the deviation of each texel from ITS OWN RING's mean: the
    // variation *around* the marshmallow, which is exactly the variation the
    // twirl controls, with the axial gradient — which the player cannot do
    // anything about and which is correct to have — divided out. Both contract
    // endpoints still hold exactly: one side black and one side white puts half
    // of every ring at 1 and half at 0, giving a within-ring deviation of 0.5
    // and an evenness of 0.
    let varSum = 0;
    for (let j = 0; j < bands; j++) {
      const w = rowW[j];
      if (w <= 0) continue;
      const mean = rowSum[j] / w;
      for (let i = 0; i < rings; i++) {
        const idx = j * rings + i;
        const dv = toast[idx] - mean;
        varSum += dv * dv * area[idx];
      }
    }
    this._evenness = clamp01(1 - 2 * Math.sqrt(Math.max(0, varSum)));

    // ── ignition ─────────────────────────────────────────────────────────
    // Both conditions on the same texel, over enough of the surface to be a
    // PATCH rather than a sliver, held for IGNITE_DWELL. The dwell is the
    // hysteresis: `burning` is a boolean that a flame, a sound and a scoring
    // outcome hang off, and it must not chatter across the threshold while the
    // fire's own power flickers underneath it.
    //
    // ── AND IT USED TO BE ONE TEXEL, WHICH SET A CORRECT ROAST ON FIRE ──────
    //
    // The test was `hotChar > IGNITE_CHAR && hotLive > IGNITE_HEAT` on the
    // single texel carrying the most char. One texel is 1/288th of the map and
    // 15 degrees of arc, and at the pose the view holds there is a texel that
    // is always hotter than the rest and cannot be turned away from the fire:
    // the far cap (see the header, under `peak`). Round 10 measured the
    // consequence in the live game — a player TURNING STEADILY at the default
    // height had the marshmallow catch fire at 41.5 s, half a second before it
    // reached golden — because the cap's live heat at that camp cleared
    // IGNITE_HEAT by a few hundredths where the bank it was derived on had it
    // a few hundredths short. A boolean that decides the player's score should
    // not sit on the wrong side of a coin toss between two camps.
    //
    // An area threshold is both sturdier and more honest. A marshmallow does
    // not catch fire because a sliver of it carbonised; it catches fire when a
    // real patch of it has gone to carbon and the fire is still on that patch.
    // IGNITE_FRAC is bracketed by two measurements, both from
    // tools/_scratch/_ignarea.mjs at the default height:
    //
    //   one cap row              0.083 of the map — 24 texels of 288. Nothing
    //                            above this can be tripped by the cap alone,
    //                            which is the failure this is fixing.
    //   never turning            the qualifying area peaks at 0.149, at 36 s
    //   turning steadily         reaches the same 0.149, but not until 66 s,
    //                            twenty-six seconds past golden
    //
    // Note what the last two say: the separation the mechanic needs is not
    // between the two policies' PEAK areas — leave anything over a fire long
    // enough and it burns, which is correct — it is between the TIMES they get
    // there. 0.10 sits above the cap row and below the never-turn peak, and
    // what comes out of it is the escalation the mini-game wants:
    //
    //   never turning, 0.24 m      black side 24 s, charred 32 s, alight 35 s
    //   turning steadily, 0.24 m   golden 40 s, past gold 53 s, alight 67 s
    //   turning steadily, 0.32 m+  never alight, at any height above it
    if (!this._burning) {
      if (alightArea > IGNITE_FRAC) {
        this._ignite += d;
        if (this._ignite >= IGNITE_DWELL) { this._burning = true; this._ignite = 0; }
      } else {
        this._ignite = Math.max(0, this._ignite - d * 2);
      }
    }

    this._dirty = true;
    this._upload();
  }

  /** Pack the float state into the 8-bit texture and hand it to the GPU. */
  _upload() {
    if (!this._dirty) return;
    const a = this.data;
    const toast = this.toast, melt = this.wetness, live = this.live, charA = this.char;
    for (let i = 0, k = 0; i < this.count; i++, k += 4) {
      a[k] = (toast[i] * 255) | 0;
      a[k + 1] = (melt[i] * 255) | 0;
      a[k + 2] = (live[i] * 255) | 0;
      a[k + 3] = (charA[i] * 255) | 0;
    }
    this._tex.needsUpdate = true;
    this._dirty = false;
  }

  /**
   * Grade the finished marshmallow.
   *
   * Order matters and it is not the order of RESULTS: 'burnt' has to be tested
   * first because a charred marshmallow can have a perfectly respectable mean
   * doneness, and 'uneven' has to be tested before 'good' because a marshmallow
   * that is black on one side and raw on the other averages out to gold. The
   * ranking in RESULTS is what the leaderboard cares about; this is the decision
   * tree, and they are different things.
   */
  grade() {
    const doneness = this._doneness;
    const evenness = this._evenness;
    let key;
    if (this._burning || this._ruined > RUIN_FRAC || doneness > RUIN_DONE) key = 'burnt';
    else if (doneness >= 0.55 && doneness <= 0.80 && evenness > 0.78) key = 'perfect';
    else if (evenness < 0.62 && this._peak > 0.50) key = 'uneven';
    else if (doneness < 0.18) key = 'pale';
    else key = 'good';
    const r = RESULT_BY_KEY[key];
    return { key, label: r.label, doneness, evenness };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Debug hooks
  //
  //  tools/roastshot.mjs drives the whole capture sheet through these, by way of
  //  window.__roast, which the view publishes. They are on the map rather than
  //  on the view because the ladder, the uneven frame and the burning frame are
  //  all statements about the map and nothing else — a harness that had to
  //  synthesise drags and wait for real seconds of heat would be measuring the
  //  input mapping and the frame rate as well as the picture.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Paint the whole map to a uniform toast level, with the char and melt a
   * marshmallow at that level would plausibly carry. The ladder frames are this
   * function six times.
   */
  setDoneness(k) {
    const t = clamp01(k);
    // Char and melt are reconstructed from the same curves the integrator uses,
    // so a ladder frame is a picture of a state the simulation can actually
    // reach rather than of a state only the debug hook can produce.
    const c = clamp01(smoothstep(CHAR_FROM, CHAR_TO, t) * 0.92);
    const m = clamp01(Math.pow(t, 0.85) * 0.95);
    this.toast.fill(t);
    this.char.fill(c);
    this.wetness.fill(m);
    // ── live heat is NOT a function of doneness, and round 3 had it as one ────
    //
    // This line used to be `0.35 + 0.5 * t`, which made the live-heat channel —
    // "how hot is this surface RIGHT NOW" — a linear function of how cooked it
    // is. Every consumer of live heat therefore climbed monotonically across a
    // doneness ladder: the ember in the cracks, the sizzle, and (through
    // `_liveMax`) anything the view damps off it. tools/roastshot.mjs measured
    // the consequence and reported it as a defect in this material — 793 317
    // pixels OUTSIDE the marshmallow moving with the ladder, i.e. a confection
    // re-lighting a campsite as it browned.
    //
    // The physics is the other way round. A marshmallow at t = 0.95 is not
    // hotter than one at t = 0.20; it has been over the fire LONGER. Held at the
    // nominal pose the surface sits wherever h / HEAT_FULL puts it and stays
    // there, so the honest reconstruction of "a marshmallow being photographed
    // while it cooks" is a CONSTANT. 0.62 is the on-axis table's own steady
    // value (h ~ 1.0 against HEAT_FULL 1.6) rounded to two places, and it is the
    // one number here that is a measurement rather than a taste.
    //
    // Note what this does not fix and cannot: camp_roast_view.js drives `uGlow`
    // from `toast.peak`, which is the maximum TOAST, not the live heat — see the
    // report. That getter is what still climbs across a ladder.
    this.live.fill(t > 0.02 ? 0.62 : 0);
    this._recompute();
  }

  /**
   * Paint a patch. `radius` is in uv units (so 0.25 is a quarter of the way
   * round the marshmallow), `amount` is added at the centre and falls off
   * smoothly to nothing at the edge. u wraps; v clamps.
   *
   * This is the 'uneven' capture: paint one side to 0.95 and leave the other
   * alone, which is the failure the whole mechanic is about.
   */
  paint(u, v, radius, amount) {
    const r = Math.max(1e-4, radius);
    for (let j = 0; j < this.bands; j++) {
      const tv = (j + 0.5) / this.bands;
      const dv = (tv - v) / r;
      for (let i = 0; i < this.rings; i++) {
        const tu = (i + 0.5) / this.rings;
        // Shortest distance on the circle: the seam at u = 0/1 is not an edge.
        let du = tu - u;
        du -= Math.round(du);
        du /= r;
        const dd = Math.sqrt(du * du + dv * dv);
        if (dd >= 1) continue;
        const w = smoothstep(1, 0, dd);
        const idx = j * this.rings + i;
        const t = clamp01(this.toast[idx] + amount * w);
        this.toast[idx] = t;
        this.char[idx] = Math.max(this.char[idx], clamp01(smoothstep(CHAR_FROM, CHAR_TO, t) * 0.92));
        this.wetness[idx] = Math.max(this.wetness[idx], clamp01(Math.pow(t, 0.85) * 0.9));
        this.live[idx] = Math.max(this.live[idx], t > 0.02 ? 0.30 + 0.5 * t * w : 0);
      }
    }
    this._recompute();
  }

  /**
   * Set it alight. Also lays down enough char for the flame to be standing on
   * something — a marshmallow that ignites while still cream-coloured is a
   * frame nobody would believe, and `burning` without char would grade as
   * 'burnt' with a picture of a raw marshmallow.
   */
  ignite() {
    for (let i = 0; i < this.count; i++) {
      this.toast[i] = Math.max(this.toast[i], 0.86);
      this.char[i] = Math.max(this.char[i], 0.55);
      this.live[i] = Math.max(this.live[i], 0.92);
    }
    this._burning = true;
    this._ignite = 0;
    this._recompute();
  }

  /**
   * Put it out. Not in the contract's list, but the view's behaviour section
   * requires it ("tapping space blows it out") and the alternative is the view
   * reaching into this file's state. The self-heat latch means nothing else can
   * clear the flag, which is the point of it.
   */
  douse() {
    this._burning = false;
    this._ignite = 0;
    for (let i = 0; i < this.count; i++) this.live[i] *= 0.35;
    this._recompute();
  }

  /** Recompute every aggregate from the state. Only the debug hooks need this. */
  _recompute() {
    let sumT = 0, sumMelt = 0, peak = 0, ruined = 0, liveMax = 0, varSum = 0;
    const rings = this.rings, bands = this.bands;
    for (let j = 0; j < bands; j++) {
      let rs = 0, rw = 0;
      for (let i = 0; i < rings; i++) {
        const idx = j * rings + i;
        const w = this.area[idx];
        const t = this.toast[idx];
        sumT += t * w;
        sumMelt += this.wetness[idx] * w;
        rs += t * w; rw += w;
        if (t > peak) peak = t;
        if (this.char[idx] > RUIN_CHAR) ruined += w;
        if (this.live[idx] > liveMax) liveMax = this.live[idx];
      }
      if (rw <= 0) continue;
      const mean = rs / rw;
      for (let i = 0; i < rings; i++) {
        const idx = j * rings + i;
        const dv = this.toast[idx] - mean;
        varSum += dv * dv * this.area[idx];
      }
    }
    this._doneness = sumT;
    this._melt = sumMelt;
    this._peak = peak;
    this._ruined = ruined;
    this._liveMax = liveMax;
    this._evenness = clamp01(1 - 2 * Math.sqrt(Math.max(0, varSum)));
    this._dirty = true;
    this._upload();
  }

  /** A fresh marshmallow. */
  reset() {
    this.toast.fill(0);
    this.wetness.fill(0);
    this.live.fill(0);
    this.char.fill(0);
    this._burning = false;
    this._ignite = 0;
    this._elapsed = 0;
    this._recompute();
  }

  dispose() {
    this._tex.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The material
// ─────────────────────────────────────────────────────────────────────────────

// ── the toast ramp, as five stops ───────────────────────────────────────────
//
// The brief is explicit that a white marshmallow is the only object in this game
// that can out-value the flame at dusk, and that the raw sugar must therefore be
// authored well below white and let the fire's own light carry it up. 0xe8e0cf
// is the brief's own number and it is the first stop here.
//
// The rest is a real marshmallow held over a real fire, in the order it happens.
// Note where the stops sit in t rather than what they are: cream to gold takes
// the first third of the range and gold to black takes the rest, so the last two
// transitions are compressed and char arrives suddenly. A ramp with evenly
// spaced stops reads as a stain spreading, which is exactly what the brief warns
// against.
// ── ROUND 4 RE-AUTHORED FOUR OF THE FIVE STOPS ──────────────────────────────
//
// docs/ROAST_CRITIC_FINDINGS.md D3-1 and D3-2 measured the round 3 ramp off the
// shipped macros and the two findings are one finding: it was a VALUE WALK AT A
// FIXED HUE, which is the exact failure the contract names ("a single linear
// ramp reads as a stain"). The two columns that say so:
//
//   body mean linear luma, mallow-0..5   0.266 0.169 0.075 0.044 0.031 0.046
//   background control, same frames      0.222 0.216 0.216 0.216 0.216 0.216
//
// Three things are wrong in that column and all three are addressed here.
//
//   1. THE TARGET RUNG IS DARKER THAN THE DIRT. At doneness 0.42 — "gold", the
//      result the whole mini-game is aimed at — the marshmallow measured 2.9x
//      DARKER than the ground behind it. A golden marshmallow is a high-value
//      object; it should be down about a quarter from raw, not down 72%.
//   2. THE COLUMN IS NOT MONOTONIC. Char came back brighter than mahogany.
//      (That half is fixed in the shader, not here — see the specular note in
//      lights_fragment_end. It was the specular lobe on the char, not a colour.)
//   3. NO YELLOW ANYWHERE. A hue histogram over the whole ladder puts every
//      rung in the 0-30 degree red-orange band. Even RAW measured hue 15 deg
//      at 197,121,76 — salmon — against a contract asking for a cream that is
//      slightly GREEN of neutral, and against dirt at hue 30. The marshmallow
//      was redder than the mud at every rung.
//
// The stops below are authored to a value ladder and a hue ladder at once.
// Linear luma, and as a fraction of cream:
//
//      cream  0.738  100%   hue  ~55 deg   (unchanged; the brief's own number)
//      gold   0.551   75%   hue  ~45 deg
//      amber  0.290   39%   hue  ~31 deg
//      mahog  0.085   11%   hue  ~23 deg
//      char   0.013  1.7%   hue  ~18 deg, nearly neutral
//
// which walks the rungs down 100 / 84 / 74 / 45 / 15 / 2 percent of cream —
// six separable steps rather than the measured 100 / 64 / 28 / 17 / 12 / 17
// with four of them inside 0.024 of each other.
//
// The hue ladder is the half that is easy to get wrong. Every one of these is
// rendered under a 0xffa259 fire, which is hue 22 and drags everything red by
// fifteen to twenty degrees, so an albedo authored AT the hue you want to see
// arrives fifteen degrees red of it. Gold is authored at 45 rather than at the
// 33 the eye asks for on a swatch, for that reason and only that reason.
//
// `char` gained a little grey (0x1b1512 -> 0x221d1a): the critic's line is
// "matte black with grey ash", and pure carbon with no ash in it reads as a
// hole in the frame rather than as a burnt object.
const RAMP = {
  cream: 0xe8e0cf,
  gold:  0xdcc47e,
  amber: 0xc4884a,
  mahog: 0x7d4522,
  char:  0x221d1a,
};

// ── the fire is not a point, and this object is the only one that knows it ─
//
// A campfire's light is emitted by a plume, not by a filament, and inverse
// square from a POINT is only the far-field limit of a source with a size. The
// standard photometric rule of thumb is that a point model is good to about a
// percent beyond five source diameters and is simply wrong inside one; the
// marshmallow is held at 0.244 m from a lamp standing in for a body a quarter
// of a metre across, which is not "outside" anything. It is at the source.
//
// THE RADIUS IS MEASURED, NOT CHOSEN. camp_fire.js builds its flame as three
// nested shells whose outer one is a cone of base radius 0.256 m and height
// 0.800 m (see the flameShell calls in its _build). The sphere with the same
// volume as that cone has radius
//
//     ( 3 * (1/3) * pi * 0.256^2 * 0.800 / (4 * pi) ) ^ (1/3)  =  0.236 m
//
// and the glowing ember bed underneath it only adds to that. 0.24 is that
// number rounded, and what makes it worth writing down is where it lands: the
// marshmallow's 0.244 m is the radius of the fire's own luminous volume, to
// within four millimetres. The roasting pose is not near the fire, it is ON the
// surface of it, and that is the whole reason this correction exists.
//
// THE FALLOFF. For a source of finite extent the irradiance flattens as you
// approach it instead of running away to infinity, and the standard soft form
// is the one every real-time renderer uses for sphere and disc lights:
//
//     E  =  I / ( d^2 + R^2 ) ^ ( decay / 2 )
//
// i.e. an effective distance sqrt(d^2 + R^2) in place of d. Three properties
// earn it. It is EXACTLY three's own falloff in the far field, so nothing more
// than a metre from the fire moves by a thousandth. It is smooth, which the
// alternative textbook form max(d, R) is not — a hard clamp puts a crease
// wherever the surface crosses d = R, and a 42 mm object at d = 0.244 m
// straddles R = 0.24, so the crease would have landed across the middle of the
// marshmallow. And it carries the authored decay through rather than replacing
// it, so RoastView._dampHearth's 1.4 -> 2.0 still means what it means.
//
// What it is worth here: at d = 0.244 and R = 0.24 the effective distance is
// 0.342 m, so at decay 2 the fire delivers 0.508 of what the point model gave
// it. The 37 irradiance units in the note at the top of this file become 19.
//
// WHY IT LIVES ON THIS MATERIAL AND NOT ON THE LIGHT. Because it is a
// correction that only bites inside about 0.3 m, and this is the only surface
// in the game that is ever there. The nearest thing to the lamp after the
// marshmallow is a stone in the fire ring at 0.72 m, where the same formula
// takes off 10%; the dirt and the chairs are past a metre, where it is nothing.
// Moving it onto camp_fire.js's light would be the same picture everywhere
// except here, for a change to a file two other authors are working in.
//
// Set to 0 to get the point model back; toastlab.mjs sweeps it with --srcr.
const SRC_RADIUS = 0.24;

// ── the value ceiling, in scene-linear radiance ─────────────────────────────
//
// Exported as tuning constants rather than buried in the uniform table because
// they are the numbers the standing rule of the critic round is measured
// against, and the next person to read this file will want to find them without
// reading the shader. camp_fire.js holds the flame core at 1.05 linear at
// midday, 1.15 at dusk and 2.55 at night; the ceiling is under the lowest of
// those with a margin. The knee is where the shoulder starts to bend — above
// anything the sun alone puts on this object, so a marshmallow away from the
// fire is untouched by it.
const VALUE_KNEE = 0.50;
// ── 0.96 -> 0.86, and it is the critic's one open number on the standing rule ─
//
// docs/ROAST_CRITIC_FINDINGS.md §6 checks the rule off at dusk — marshmallow
// max 0.591 against a flame p95 of 0.739, which is comfortable — and then
// reports that at the DEFAULT hour it is a tie the wrong way: on held-clean the
// marshmallow's p99 is 0.6605 against the flame's 0.6318, and their maxima are
// equal to four figures. Its own suggestion was "worth 10% off the raw albedo",
// and that is the wrong lever: the albedo is what makes a raw marshmallow read
// as sugar in daylight away from the fire, where there is no rule to satisfy.
// The ceiling is the right one, because it acts ONLY at the top of the range.
// Measured through the shoulder, this change costs the daylight look nothing
// and takes 10% off exactly the pixels that are tying:
//
//     pre-shoulder linear   0.63 (daylight raw)   4.0 (250 mm from the flame)
//     ceiling 0.96                        0.6134                       0.9528
//     ceiling 0.86                        0.6090                       0.8595
//                                         -0.7%                        -9.8%
const VALUE_CEIL = 0.86;

// ── ROUND 7 RE-DERIVED BOTH AGAINST THE NEAR-FIELD FALLOFF, AND NEITHER MOVED
//
// The near-field model at SRC_RADIUS halves what the fire puts on this object,
// so the obvious question is whether the shoulder still has to be this
// aggressive. Swept in the lab, on the raw rung under the game's damped fire:
//
//     knee      limb (fire)     day raw linMean      limb : core
//     0.50        0.5306              0.5074            5.20 : 1
//     0.60        0.5343              0.5237            5.23 : 1
//     0.68        0.5354              0.5373            5.24 : 1
//     0.76        0.5355              0.5478            5.24 : 1
//
// The knee is worth 0.9% on the thing this round is about and 8% on the object's
// value in DAYLIGHT, where the standing rule was already a tie at the default
// hour (see the measurement above). That is the wrong trade in the wrong
// direction, so it stays at 0.50.
//
// The ceiling was swept the same way and is doing exactly the job it was put
// there for. With it effectively off (3.00) the raw rung's 99th percentile
// under the dusk fire is 1.07 linear against a flame core of 1.15 — 0.93x, i.e.
// a marshmallow still all but tying with the fire even with the fire halved.
// And the limb of a backlit marshmallow now RESTS on the ceiling rather than
// being buried ten to forty times above it: 0.86 is where the brightest part of
// this object is supposed to sit, and the whole gradient below it is the part
// the eye reads. Do not raise it to make the rim brighter — the rim is already
// at it, and everything under it would come up with it.

// What comes through the far side of a marshmallow with the fire behind it.
// A sugar foam is mostly air, so light scatters through it a long way and comes
// out warm and slightly pink — this is the colour of a marshmallow held up
// against a flame, not the colour of the flame.
//
// ── ROUND 5: 0xffb682 -> 0xffcda4, AND THIS IS WHY RAW READ AS SALMON ───────
//
// D3-2's headline measurement is that the raw rung renders at hue 15 degrees,
// average RGB 197,121,76 — "that is salmon" — against a contract asking for a
// cream slightly green of neutral, and it is the one rung whose albedo is not
// in dispute (0xe8e0cf is the brief's own number, and it is nearly neutral).
// So the red is not coming from the albedo. It is coming from HERE.
//
// The measurement that pins it, off the shipped ladder at the default hour:
//
//     rung          mean RGB        G/R     body luma
//     raw           222,140,89      0.63      0.354
//     gold          217,158,78      0.73      0.399
//
// Raw is redder AND darker than gold — the ramp inverts across its first three
// rungs — and the only term on this object that is stronger on raw than on
// gold is this one: msPale is 1.00 at raw and 0.75 at gold, so the raw rung
// gets a third more of a colour whose own G/R is 0.46. The scatter was
// painting the salmon.
//
// The physics says it should not be that saturated. This term is multiple
// scattering through a weakly-absorbing WHITE foam, and multiple scattering in
// a white medium desaturates: what comes out is much closer to the medium's own
// colour than to the source's. Authoring it at 0xffb682 — more saturated than
// the 0xffa259 fire that feeds it — put the fire's orange through the
// marshmallow twice. 0xffcda4 is a warm sugar cream: still unmistakably the
// colour of light through a marshmallow rather than of light off one, and it
// leaves the rung's hue to the ramp, which is where the ramp belongs.
// ── ROUND 7 TRIED 0xffd8b4 AND PUT IT BACK. THE ABLATION IS WHY ────────────
//
// D3-2's salmon complaint survived round 5's correction, so round 7 measured
// which term is responsible instead of reasoning about it. toastlab.mjs gained
// --transl, which zeroes uTransl and therefore the whole scatter block; on the
// raw rung under the game's own damped fire:
//
//     scatter ON    linear G/R 0.534
//     scatter OFF   linear G/R 0.402
//     the lamp itself (0xffa259)      0.362
//
// So this term is not what makes the raw rung salmon. It is the ONLY thing
// lifting the object off the fire's own chromaticity, and the reflected light
// underneath it lands within a tenth of the lamp. Desaturating it to 0xffd8b4
// duly took the material's own raw rung to G/R 0.581 — and the shipped frame
// did not move at all: mallow-0 measured linear G/R 0.374 before and 0.376
// after. The frame is not made here. In the same capture the DIRT beside the
// marshmallow measures 0.334 and the stones 0.411, i.e. the marshmallow is
// already the least orange thing in the picture, and what is left is the roast
// view's own light and PostFX's grade.
//
// Having bought nothing measurable, the change was not free: this term is a
// large part of what lights the middle of a backlit marshmallow, and a paler
// scatter there took the macro further toward the green it should not be. So
// the colour goes back. The rule round 5 established still holds and is still
// the one that matters — this must never be MORE saturated than the illuminant
// it stands for — and the salmon complaint is recorded above as measured out of
// this file's reach rather than left open.
//
// The cost is measured and it is small: the raw rung's 99th percentile under
// the dusk fire goes 0.534 -> 0.572 linear, i.e. 0.46x of the flame core to
// 0.50x. The standing rule is nowhere near binding at either.
const SCATTER_COL = 0xffcda4;

// ── the two numbers of the paper lantern ────────────────────────────────────
//
// The extinction of the foam along the view ray, and the gain on the
// forward-scattered term. They are together because they cannot be set apart:
// the extinction decides how dark the middle is AND how wide the bright band
// is, the gain decides how bright the band gets, and the pair is what makes a
// ratio. The long note at their use in the scatter block has the full argument
// and the failures either side of them.
//
// Re-derived in round 7 against the near-field falloff (see SRC_RADIUS), which
// is the first round in which the value ceiling was not renormalising the
// answer away. Swept in tools/_scratch/toastlab.mjs with --sk / --sg.
const SCATTER_K = 3.6;
const SCATTER_GAIN = 1.4;

// ── the diffusion floor: what a WHITE foam does that Beer's law does not ────
//
// exp(-k * thickness) is the light that crossed without being deflected, and in
// a sugar foam that is the small half of the physics. The note at msTransE has
// the argument in full; this is the number, and round 8 raised it from 0.020
// because the number was set against a constraint that turned out not to exist.
//
// ── 0.020 -> 0.105, AND THE 5.5 : 1 IT WAS CAPPED BY IS NOT IN THE CONTRACT ─
//
// Three notes in this file call 5.5 : 1 from limb to core "the contract's",
// including the one that set this floor to "the largest the contract's ratio
// will pay for". It is not in docs/ROAST_CONTRACT.md. It is not in
// docs/ROAST_CRITIC_FINDINGS.md. `grep -rn "5.5 : 1" src docs tools` returns
// three hits and all three are this file quoting itself. The number was
// invented in round 7 and has been enforced ever since as though the lead had
// signed it, and what it has been enforcing is a DARK CORE — which is the
// defect the round-8 build was rejected for.
//
// What the contract actually says about this object's value is the opposite:
// "author the raw sugar well below white and let the fire's own light CARRY IT
// UP". The fire's light was not carrying it up. Measured on shots/roast/r8,
// the composed dusk frame at the ladder pose:
//
//     raw body        0.114 linear
//     the plume behind it   0.412
//
// i.e. the raw marshmallow renders at 28% of the field it is silhouetted
// against. docs/ROAST_CRITIC_FINDINGS.md D3-3 called 50% "exactly half the
// value of the field it is silhouetted against" and treated that as part of
// what was wrong. We had gone further the same way.
//
// This is the right lever for it and the other two are not, for a reason that
// is arithmetic rather than taste: the floor is inside the transmittance, so it
// acts where msTrans is SMALL and does nothing where msTrans is 1. The core is
// msTrans 0.027 and the limb is msTrans 1.000, so raising the floor lifts the
// middle of the lantern and moves the rim by nothing at all — which is also
// why it costs the standing rule nothing, the rule being about the max and the
// max being the rim. Swept in the lab under the game's own fire, raw rung, with
// the rest of this round in place:
//
//     floor   core     limb    limb : core
//     0.020  0.2116   0.5285     2.50 : 1
//     0.060  0.2463   0.5288     2.15 : 1
//     0.105  0.2853   0.5291     1.85 : 1
//     0.160  0.3316   0.5294     1.60 : 1
//
// The limb moves by 0.0009 across the whole sweep, which is the property the
// paragraph above claims and is why this is the lever and the gain is not.
//
// 0.105 is where the core reaches about a quarter of the flame core's 1.15 and
// the object stops reading as a hole. It is also defensible as physics rather
// than as a fudge: a marshmallow is a foam with a scattering albedo near unity,
// and the diffuse transmittance of a slab like that falls as 1/(1 + 0.75 tau)
// rather than as exp(-tau) — at the optical thickness this material runs, a
// tenth is if anything conservative.
const SCATTER_DIFF = 0.105;

// ── how much of the direct light the core-darkening may take ────────────────
//
// The coefficient on the term at the bottom of the scatter block. Its long note
// is at its use; this is here so the lab can sweep it (--core) without an edit.
//
// AND IT NO LONGER HAS AUTHORITY OVER ANYTHING, which is worth saying plainly
// so the next reader does not spend a round sweeping it. Once the term stopped
// eating Stylize's floor (see msWrapShare) its two gates turned out to be very
// nearly mutually exclusive: it needs msThru large, which means the fire is
// behind, and it needs the wrap alive, which at uStyleWrap 0.48 means the fire
// is NOT behind. At the dead centre of a backlit marshmallow, where the term
// was written to act, the product of the two peaks at about 0.07 near
// dot(-V, L) = 0.3 and is smaller either side, so the most this coefficient can
// ever remove is around six percent of the direct diffuse. Swept in the lab
// under the game's fire, 0.75 / 0.85 / 0.95 / 1.00 move the backlit raw rung's
// mean by 0.0003 — three ten-thousandths, across a third of the range.
//
// It is kept rather than deleted for one reason: it is now self-gating rather
// than dead by construction. It reads uStyleWrap and uStyleFloor off Stylize
// itself, so a retune of the house lighting that widens the wrap or lowers the
// floor brings it back to life in the right amount without anyone here
// noticing it had gone. The sweep table quoted at its use — 6.41 / 5.46 / 4.76
// limb-to-core at 0.95 / 0.85 / 0.75 — was taken under the old formulation and
// is history, not a live measurement.
const CORE_K = 0.85;
// The dull orange down inside a crack in the char, gated on live heat.
const EMBER_COL = 0xff5a14;

// ─────────────────────────────────────────────────────────────────────────────
//  GLSL — noise, cells and the pieces that use them
//
//  Everything is sampled in the marshmallow's OWN OBJECT SPACE. That is not a
//  detail: the whole mechanic is the mallow spinning on the end of a stick, and
//  a pattern sampled in world or view space would swim across the surface as it
//  turns — which reads, instantly and unmistakably, as the surface not being
//  attached to the object. Object space costs nothing and is correct.
//
//  No backticks anywhere in these strings. They are template literals, and a
//  backtick in a comment closes one. (The repo has a guard plugin for exactly
//  this; do not make it earn its keep.)
// ─────────────────────────────────────────────────────────────────────────────
const MS_NOISE = /* glsl */`
  // ── the octave rotation ───────────────────────────────────────────────────
  //
  // Every field below is value noise on an INTEGER LATTICE, and an integer
  // lattice has visible walls. The standard cure is octaves, and this file has
  // been trying to buy the cure with swizzles — msNoise(p.yzx), msNoise(p.zxy).
  // A swizzle does not work and round 4 has the picture that proves it: the
  // mahogany rung came back covered in axis-aligned RECTANGLES about 3 mm
  // across, because a swizzle is a 90-degree rotation and 90 degrees maps the
  // lattice onto itself. Every octave agreed about where the cell walls were.
  //
  // This is an orthonormal rotation through angles that are not multiples of a
  // right angle, so each octave's lattice sits at a skew angle to the last and
  // to the marshmallow's own axes, and no octave can reinforce another's walls.
  // Verified orthonormal by hand: every row is unit length and every pair of
  // rows dots to zero.
  const mat3 MS_ROT = mat3(
     0.80,  0.36, -0.48,
    -0.60,  0.48, -0.64,
     0.00,  0.80,  0.60 );

  float msHash31( vec3 p ) {
    p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
    p *= 19.19;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }

  vec3 msHash33( vec3 p ) {
    return vec3(
      msHash31( p ),
      msHash31( p + vec3( 17.3, 5.1, 9.7 ) ),
      msHash31( p + vec3( 3.9, 23.1, 11.3 ) ) );
  }

  // ── ROUND 5: THE LAST CORNER READ 1.1, AND IT COST THIS FILE FOUR ROUNDS ──
  //
  // The eighth corner of the trilinear read was msHash31( i + vec3(1.0, 1.1,
  // 1.0) ) — one character, and the most expensive line this file has had in
  // it. Value noise is continuous only because two neighbouring cells agree
  // about the hash of the lattice point they share: the cell at i and the cell
  // at i + (0,1,0) both have to evaluate that shared corner as
  // msHash31( i + (x,1,z) ). With 1.1 in one of the eight they disagreed, so
  // msNoise carried a STEP DISCONTINUITY along a whole family of cell walls.
  //
  // Everything downstream of a step is a straight line. msBlisters warps its
  // domain by msNoise, so the cell field jumped across the wall and bubbles and
  // their collars were sliced off along it. The mottle warps by msNoise, so the
  // browning came out in straight-edged polygonal patches. And msBump takes
  // screen-space derivatives of a height field built out of both, so a step
  // became a ONE-PIXEL BRIGHT FILAMENT under the specular lobe. That is the
  // "axis-aligned rectangles about 3 mm across" the octave-rotation note below
  // was written to chase, and it is most of the "bronze filigree over black"
  // the crack-depth note was written to chase. Neither was the octaves and
  // neither was the crack depth. The rotation and the domain warps are still
  // right — they are the cure for a VISIBLE lattice — but no amount of octave
  // rotation can hide a discontinuity, because every octave has one.
  float msNoise( vec3 x ) {
    vec3 i = floor( x ), f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( msHash31( i + vec3( 0.0, 0.0, 0.0 ) ), msHash31( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
           mix( msHash31( i + vec3( 0.0, 1.0, 0.0 ) ), msHash31( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
      mix( mix( msHash31( i + vec3( 0.0, 0.0, 1.0 ) ), msHash31( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
           mix( msHash31( i + vec3( 0.0, 1.0, 1.0 ) ), msHash31( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
  }

  // ── blisters ──────────────────────────────────────────────────────────────
  // A cheap cellular field: one jittered feature point per cell, searched over
  // the 2x2x2 neighbourhood rather than the textbook 3x3x3. With the jitter held
  // to 0.42 of a cell the nearest point is in the searched set for the
  // overwhelming majority of samples, and where it is not the error is a
  // slightly wider dome — which on a field of blisters is indistinguishable from
  // a slightly wider blister. Eight hash triples against twenty-seven is the
  // difference between this being free and this being a cost.
  //
  // Returns the distance to the nearest feature point in x, and THAT POINT'S OWN
  // random number in y.
  //
  // The second component is not a luxury, and the reason is a defect that
  // shipped. One feature point per cell jittered by 0.42 leaves the points close
  // enough to a regular lattice that a field thresholded at a single radius
  // comes out as ROWS AND COLUMNS of identical round dots. At forty pixels
  // nobody could see it; filling the frame in tools/_scratch/toastlab.mjs it is
  // a golf ball, and a golf ball is the one thing a marshmallow must not be.
  // The per-cell random gives every bubble its own diameter, and msBlisters
  // below warps the domain before sampling; between them the lattice stops being
  // readable. It is derived from the same hash triple the jitter used rather
  // than taken from a fourth hash, so it costs nothing — but it is folded first,
  // because using a component of the jitter directly would make every bubble's
  // size a function of where it sits, which is its own visible pattern.
  //
  // z is the distance to the SECOND-nearest feature point. It is free — the
  // loop already visits every candidate — and it is what msCracks below needs:
  // (d2 - d1) is zero exactly on the perpendicular bisector between two cells,
  // so thresholding it draws the Voronoi boundary, which is a polygonal network
  // with three-way junctions. That is the shape burnt sugar actually cracks in.
  vec3 msCells( vec3 p ) {
    vec3 ip = floor( p ), fp = fract( p );
    float best = 8.0, second = 8.0;
    float bid = 0.0;
    for ( int z = 0; z < 2; z ++ ) {
      for ( int y = 0; y < 2; y ++ ) {
        for ( int x = 0; x < 2; x ++ ) {
          vec3 o = vec3( float( x ), float( y ), float( z ) );
          vec3 h = msHash33( ip + o );
          vec3 fpt = o + 0.29 + h * 0.42;
          float d = dot( fpt - fp, fpt - fp );
          if ( d < best ) { second = best; best = d; bid = fract( h.x * 31.7 + h.y * 17.3 ); }
          else if ( d < second ) { second = d; }
        }
      }
    }
    return vec3( sqrt( best ), bid, sqrt( second ) );
  }

  // The blister field proper.
  //
  //   x  the dome's height, 0..1
  //   y  the bubble's own random, which the fragment stage uses to decide how
  //      glossy that particular taut skin is
  //   z  the CONTACT RING: a narrow band just outside the dome's foot, where
  //      the lifted skin is pulled tight against the body. On a real toasted
  //      marshmallow every bubble sits in a soft dark collar, and that collar
  //      is most of what makes a bubble read as standing PROUD rather than as a
  //      spot printed on. Round 3 had no ring and the field read as craters.
  //
  // The pop argument is how far along the surface is toward "blistered", 0..1,
  // and it is the second thing round 3 did not have. A cell only lifts once pop
  // has passed that cell's OWN random, so at pop = 0.2 a handful of bubbles
  // have come up and at pop = 1 all of them have. That is what makes the density
  // rise with toast; the old field had every cell blistered at every doneness
  // and only faded the whole thing in together, which is a texture appearing,
  // not bubbles forming.
  //
  // The domain warp is one noise tap pushed along three axes by three unequal
  // amounts. A warp is the standard cure for a visible cell lattice and it is
  // usually written as three taps (one per axis); one tap with three different
  // gains does the same job here because the lattice is being broken, not
  // decorrelated — the three axes only have to stop agreeing with each other,
  // and unequal gains on a common field is enough for that at a third of the
  // cost. Sampled in object space like everything else, so it turns with the
  // marshmallow.
  vec3 msBlisters( vec3 p, float pop ) {
    float w = msNoise( MS_ROT * p * 0.42 );
    vec3 c = msCells( p + vec3( 1.70, -1.15, 0.85 ) * w );
    // Has this cell blistered yet. 1.45 rather than 1.0 so that pop = 1 lifts
    // every cell including c.y = 1 with room to spare; the 0.24 window is one
    // cell easing up over about a fifth of the toast range rather than
    // snapping. 1.22 -> 1.45 in round 7: the headroom above 1.0 is what decides
    // how EARLY the field fills in, and at 1.22 the gold rung — the one the
    // mechanic's 'perfect' band sits in, and the one the round reports keep
    // calling bare — had only 61% of its cells lifted. At 1.45 it has 77%, and
    // nothing at or past t = 0.58 changes, because both numbers already lift
    // everything there.
    // WHICH cells lift first must not be the same random that decides how BIG
    // they are, or a gold marshmallow carries only the small bubbles and grows
    // the large ones on its way to black — which is not what happens and reads,
    // at the gold rung, as a fine even stipple. One cheap fold of the same hash
    // decorrelates the two at no cost.
    float idPop = fract( c.y * 7.31 + 0.263 );
    float live = smoothstep( idPop, idPop + 0.24, pop * 1.45 );
    // 0.18 to 0.52 of a cell across the radius, which at the 8 mm cells this is
    // driven at is a 3 mm pucker in the skin at one end and an 8 mm bubble about
    // to split at the other. A real toasted marshmallow has both on it at once
    // and the SPREAD is the point: a field whose bubbles are all one size reads
    // as a moulding however well it is placed.
    // The floor is not cosmetic: at rad = 0 both smoothsteps below have
    // edge0 == edge1, which is a division by zero in GLSL and reads as a full
    // white cell on some drivers. 1e-4 of a cell has no area.
    float rad = max( ( 0.18 + 0.34 * c.y ) * live, 1e-4 );
    // The inner edge is a third of the radius, not a hard 0.03. A bubble on a
    // marshmallow is a dome with a shoulder, and thresholding it right down to
    // the feature point gives a flat-topped disc with a hard rim — which at the
    // toast strengths this field drives reads as a black spot painted on, and
    // over a whole surface reads as leopard print.
    float h = smoothstep( rad, rad * 0.30, c.x );
    // The collar: outside the dome's foot and inside 1.42 of it. Multiplied by
    // (1 - h) so it cannot bleed onto the dome itself.
    float ring = smoothstep( rad * 1.42, rad * 1.02, c.x ) * ( 1.0 - h );
    // ── AND THIS IS WHERE THE DASHED FILAMENTS CAME FROM ──────────────────
    //
    // Every round since 4 has reported "crack filaments" on the mid rungs and
    // blamed the char crack field, and it cannot have been that: the crack
    // groove is gated on smoothstep(0.15, 0.65, char), and setDoneness puts
    // char at 0.109 on the mahogany rung and at 0.000 on the gold one, so on
    // both of the rungs the filaments were measured on that gate is exactly
    // zero. They are here.
    //
    // rad is a function of c.y, which is the CELL'S OWN random and therefore
    // jumps at every Voronoi wall. The dome never notices, because it has died
    // out long before the wall — but the collar sits at 1.02 to 1.42 of rad,
    // i.e. out at 0.18 to 0.74 of a cell, and a Voronoi wall is typically at
    // 0.3 to 0.6. So the collar routinely straddles a wall, where its depth
    // steps discontinuously between two neighbours' radii. msBump takes the
    // slope of that with dFdx/dFdy, a step differentiates to a spike, and a
    // screen-space derivative is computed per 2x2 quad — which is why the
    // artefact is a DASHED line and not a solid one, and why it comes in
    // bright-and-dark pairs. Nothing about it is a crack.
    //
    // The cure is also the correct model. (c.z - c.x) is the distance to the
    // wall, already in hand from msCells. A collar is the crease where ONE
    // bubble's lifted skin is pulled down against the body; where two cells
    // meet there is no bubble foot, so the collar has no business being there.
    // Fading it out over a tenth of a cell removes the step by removing the
    // thing that was stepping.
    // Only the collar is faded. The dome is not, and that is deliberate: its
    // own edge is at c.x = rad, which is inside the wall for all but the
    // largest cells, so it almost never steps — and fading it as well makes
    // every big bubble a shallow scoop instead of a dome, which the lab sheet
    // showed immediately.
    ring *= smoothstep( 0.0, 0.10, c.z - c.x );
    return vec3( h * ( 0.60 + 0.40 * c.y ), c.y, ring );
  }

  // ── the dusting ───────────────────────────────────────────────────────────
  // Icing sugar and cornstarch. A raw marshmallow is not a clean surface: it is
  // rolled in starch so it does not stick to itself, and that dusting is most of
  // why raw sugar reads as SUGAR rather than as white plastic. Two octaves at a
  // sub-millimetre scale, so at any distance past about half a metre it stops
  // being a pattern and becomes a very slightly uneven matte — which is exactly
  // what it does in life.
  //
  // It is a mask for two effects and neither of them is "make it brighter". See
  // the note in the colour block: brightening here is precisely how this object
  // ends up out-valuing the flame.
  float msDust( vec3 p ) {
    float a = msNoise( p );
    float b = msNoise( MS_ROT * p * 2.31 + 7.7 );
    return clamp( a * 0.62 + b * 0.38, 0.0, 1.0 );
  }

  // ── craquelure ────────────────────────────────────────────────────────────
  //
  // ROUND 4 REPLACED THE WHOLE FIELD. It used to be the level sets of a
  // two-octave value noise, on the argument that a contour of a smooth field is
  // the same shape as dried mud. It is not, and the difference is exactly what
  // docs/ROAST_CRITIC_FINDINGS.md D3-6 called out: the level sets of a smooth
  // field are CLOSED LOOPS. They never branch. So the char rung came back
  // covered in "long, smooth, curved worms" — a marbling, or a brain — where
  // real char is a polygonal break-up whose defining feature is THREE-WAY
  // JUNCTIONS, because a crust relieves stress by cracking to the nearest
  // existing crack.
  //
  // A Voronoi boundary has three-way junctions by construction: it is the set
  // of points equidistant from two seeds, and three cells meet at a vertex.
  // (d2 - d1) is that distance, and msCells already had both numbers in its
  // loop — this costs one compare per cell and no extra hashing, which is
  // cheaper than the two noise taps it replaces.
  //
  // The width is 0.13 OF A CELL and it scales with the cell, which the old
  // contour form could not do: its band was a fraction of a contour period and
  // the period depended on the noise gradient, so the crack width wandered.
  float msCracks( vec3 p ) {
    vec3 c = msCells( p );
    return 1.0 - smoothstep( 0.0, 0.13, c.z - c.x );
  }
`;

// ── fragment-only helpers ───────────────────────────────────────────────────
//
// Separated from the block above because MS_NOISE is prepended to BOTH shaders —
// the vertex stage needs msCells for the blister swell — and dFdx/dFdy do not
// exist in a vertex shader. Compiling this into the vertex stage is
// "'dFdx' : no matching overloaded function found" and a material that never
// links; tools/_scratch/toastlink.mjs is the gate that catches it.
const MS_FRAG_ONLY = /* glsl */`
  // ── bump, from a scalar height field ──────────────────────────────────────
  // Three's own perturbNormalArb, inlined because it only exists under
  // USE_BUMPMAP and this material has no bump map — the height is procedural.
  // Screen-space derivatives rather than an object-space gradient, so the
  // perturbation needs no tangent frame and no extra varyings, and so the
  // blisters flatten out on their own as the marshmallow gets small on screen.
  vec3 msBump( float h, vec3 N, vec3 surfPos, float faceDir ) {
    vec3 sx = dFdx( surfPos );
    vec3 sy = dFdy( surfPos );
    float dHdx = dFdx( h );
    float dHdy = dFdy( h );
    vec3 R1 = cross( sy, N );
    vec3 R2 = cross( N, sx );
    float det = dot( sx, R1 ) * faceDir;
    vec3 grad = sign( det ) * ( dHdx * R1 + dHdy * R2 );
    // ── THE SLOPE LIMIT, AND IT IS WHY THE MACRO HAD DASHED FILAMENTS ──────
    //
    // grad / |det| is the surface slope, in metres of height per metre of
    // surface, and every round since 4 has shipped a macro with short bright
    // dashes on it that got blamed on the char crack field. They are not
    // cracks. Zoomed to 8x on mallow-4 they are ONE PIXEL TALL, dead straight
    // in SCREEN space, and broken into segments a few pixels long with even
    // gaps — which is not a shape a surface can have. It is the shape of a
    // screen-space derivative taken across a discontinuity: dFdx/dFdy are
    // evaluated per 2x2 quad, so a step in h differentiates to a spike on the
    // quads that straddle it and to nothing on the quads that do not.
    //
    // When that happens grad swamps abs(det)*N, the normal swings most of the
    // way to the tangent plane, and the specular lobe catches it — one bright
    // pixel-line, at any doneness, whether or not there is any char to crack.
    // The same thing happens for a second reason at a silhouette, where the
    // quad is edge-on, det goes to zero and grad is dividing by nothing.
    //
    // So the slope is limited to something a marshmallow can actually have.
    // The steepest real feature on this surface is a blister collar: a 1.6 mm
    // dome standing over a ~4 mm foot, which is a slope well under 1. The
    // limit is 1.5 — half again as steep as anything authored, so no real
    // feature is touched — and everything above it is a sampling artefact by
    // construction, because the height field has no such slope in it.
    //
    // The alternative cures are worse. Making every field continuous is a
    // whack-a-mole across four noise fields (one of them, the blister collar,
    // was genuinely discontinuous and IS fixed at source in msBlisters — this
    // catches what is left). Dropping the screen-space derivative for an
    // object-space gradient costs a tangent frame, two varyings and the free
    // LOD that makes the bubbles flatten out as the prop gets small.
    //
    // ── AND IT IS NOT ALL OF THEM. WHAT IS LEFT, AND WHAT IT IS NOT ───────
    //
    // Measured on mallow-4, on the brightest surviving dash: peak 140 -> 125
    // of 255 against a local surround of 46, i.e. the collar fix took the
    // filaments off the gold rung entirely and this limit took another 11% off
    // what is left on mahogany. One faint line survives, and the next author
    // should know three things about it before spending a round:
    //
    //   · it is NOT the char crack field. The crack groove and the crack
    //     colour are both gated on smoothstep(0.15, 0.65, char), and
    //     setDoneness puts char at 0.109 on the mahogany rung, so that gate is
    //     exactly zero on the frame the filament is measured on.
    //   · it is dead HORIZONTAL in screen space over about a hundred pixels,
    //     which no field sampled in object space can be. The remaining
    //     suspects are the lathe's own edge-radius shoulder catching a grazing
    //     specular, and the ring boundary of the mesh, and both of those are
    //     camp_marshmallow.js rather than this file.
    //   · raising this limit's aggression is not the answer. The steepest real
    //     feature — a 1.57 mm dome over a ~2.2 mm foot — has a slope of about
    //     1.07, so anything below about 1.2 starts flattening actual bubbles.
    float msDet = abs( det );
    float msLim = 1.5 * msDet;
    float msG = length( grad );
    grad *= ( msG > msLim ) ? msLim / max( msG, 1e-12 ) : 1.0;
    return normalize( msDet * N - grad );
  }
`;

const MS_UNIFORMS_DECL = /* glsl */`
  uniform sampler2D uToast;
  uniform float uSag;
  uniform float uSwell;
  uniform float uGlow;
  uniform float uTime;
  uniform vec3  uFireDir;
  uniform float uRadius;
  uniform float uSeed;
  uniform float uBlisterFreq;
  uniform float uBlisterH;
  uniform float uDustFreq;
`;

/**
 * The marshmallow's material.
 *
 * @param toastTex THREE.DataTexture from ToastMap.texture
 * @param opts.radius  the mallow's radius in metres; the sag and swell
 *                     displacements and the noise frequencies are quoted
 *                     against it, so a different-sized marshmallow gets the same
 *                     blisters rather than the same blister-to-body ratio.
 * @param opts.seed    decorrelates two marshmallows in the same frame.
 * @param opts.blister 0..1+, how proud the bubbles stand.
 * @param opts.translucency 0..1+, the back-scatter strength.
 *
 * Returns a MeshStandardMaterial carrying
 *   userData.roastUniforms = { uSag, uSwell, uGlow, uTime, uFireDir }
 * exactly as the contract specifies — plain THREE.Uniform objects the view
 * writes every frame.
 */
export function marshmallowMaterial(toastTex, opts = {}) {
  // See the import. Idempotent, and it is what guarantees uStyleWrap and
  // uStyleFloor are declared by the time this program links.
  patchStylizedLighting();
  const radius = opts.radius ?? MALLOW_R;
  const seed = opts.seed ?? 0;

  // The five the view writes. Held in their own object so the material's
  // userData can expose exactly the contract's set and nothing else — a view
  // that writes into this object cannot accidentally reach a tuning knob.
  const roastUniforms = {
    uSag:     new THREE.Uniform(0),
    uSwell:   new THREE.Uniform(0),
    uGlow:    new THREE.Uniform(1),
    uTime:    new THREE.Uniform(0),
    // The fire's direction in the mallow's LOCAL space. Local, not world, so it
    // is already invariant to the twirl by the time it gets here: the view
    // recomputes it each frame and the shader does not have to know how the
    // stick is held.
    uFireDir: new THREE.Uniform(new THREE.Vector3(0, -1, 0)),
  };

  const uniforms = {
    ...roastUniforms,
    uToast:   new THREE.Uniform(toastTex),
    uRadius:  new THREE.Uniform(radius),
    uSeed:    new THREE.Uniform(seed),

    uCream:   new THREE.Uniform(C(RAMP.cream)),
    uGold:    new THREE.Uniform(C(RAMP.gold)),
    uAmber:   new THREE.Uniform(C(RAMP.amber)),
    uMahog:   new THREE.Uniform(C(RAMP.mahog)),
    uCharCol: new THREE.Uniform(C(RAMP.char)),
    uScatter: new THREE.Uniform(C(SCATTER_COL)),
    uEmber:   new THREE.Uniform(C(EMBER_COL)),

    // ── frequencies, all quoted in cells across the marshmallow ───────────
    // A marshmallow blisters at about 2 mm, which over a 42 mm body is twenty
    // cells across. Divided by the radius so the same number means the same
    // apparent size whatever the prop is scaled to.
    // (a "cell" is one Worley cell / one noise cell; the dome inside a Worley
    // cell is about 0.6 of it across, so 2.2 mm cells give ~2.7 mm blisters.)
    // Blister cells, 3.0 mm. It was 2.2, which put twenty cells across the body
    // and — once the lattice was broken and the field was actually visible —
    // read as brain coral rather than as bubbles. Fewer and larger, clustered by
    // the mottle, is what a marshmallow does.
    //
    // ROUND 4: 3.0 mm -> 8.0 mm, and this is the biggest single number in the
    // round. 3 mm cells put ~690 cells over the marshmallow's 6 200 mm^2 of
    // surface and every one of them blistered, so the macro carried something
    // like two hundred visible bubbles of nearly the same size — an even
    // pitting, which reads as a texture and not as boiling. A real toasted
    // marshmallow carries a couple of dozen, they are LARGE, and they vary
    // enormously.
    //
    // ROUND 7: 8.0 mm -> 7.3 mm, and the claim round 4 attached to the 8 mm
    // figure — "roughly 20-25 visible at the gold rung" — was never true. It
    // was arithmetic on the cell count and nobody counted the picture. Counted
    // on the shipped macro, mallow-2 carries SEVEN, and the round report before
    // this one counted four on a frame where half of them were lost in the
    // clamp. 7.3 mm cells put ~117 over the 6 200 mm^2 rather than ~97, and the
    // pop threshold below takes the same rung from 61% of cells lifted to 77%.
    // Together that is about eleven at the gold rung and the high teens by
    // mahogany, which is the "tens, not hundreds" the brief asks for.
    //
    // It stopped at 7.3 and not lower, and the stopping point was a picture,
    // not a number: 6.6 mm was tried first and the lab's gold cell came back
    // with about thirty shallow pits reading as an orange peel — round 3's
    // even stipple, arrived at from the other side. Most of the count in this
    // round therefore comes from the pop threshold, which lifts MORE OF THE
    // SAME bubbles rather than adding smaller ones, and the island gate and
    // the size spread are both untouched so the new ones land inside the
    // existing clusters at the existing range of sizes.
    uBlisterFreq: new THREE.Uniform(1 / 0.0073),
    // ROUND 4: 10 mm -> 4.0 mm, and the field it drives is now a Voronoi
    // boundary rather than a noise contour, so this number now means what it
    // says: 4.0 mm is the size of a PLATE of crust between two cracks, and ten
    // plates across a 42 mm marshmallow is what the reference has.
    uCrackFreq:   new THREE.Uniform(1 / 0.0040),
    uMottleFreq:  new THREE.Uniform(1 / 0.0075),   // the hot-spot patchiness
    // The starch dusting. 0.55 mm noise cells, which is fine enough that at the
    // 40-pixel size the marshmallow occupies in a normal frame it is simply a
    // matte, and coarse enough that the first-person framing — where the thing
    // is 250 mm from the lens — has something to look at.
    uDustFreq:    new THREE.Uniform(1 / 0.00055),
    // How proud the bubbles stand, in metres, and how hard they push the normal.
    // The vertex displacement is deliberately the SMALLER half of the effect:
    // the mesh is 32 x 24 and cannot resolve a 2 mm bubble, so the vertex term
    // only has to break the silhouette and the normal does the rest.
    // 0.055 -> 0.075 of the radius, i.e. 1.16 mm -> 1.57 mm of relief. The
    // bubbles are two and a half times wider than they were, and a dome that
    // stands the same height over a wider base is a shallower dome: keeping the
    // old amplitude would have traded "craters" for "dents". A 6 mm bubble
    // standing 1.6 mm proud is about right off the reference.
    uBlisterH:    new THREE.Uniform(0.075 * (opts.blister ?? 1)),
    uBlisterBump: new THREE.Uniform(0.85 * (opts.blister ?? 1)),
    uTransl:      new THREE.Uniform(opts.translucency ?? 1),
    // The value ceiling. See the long note at its use in lights_fragment_end
    // and the one beside VALUE_CEIL; 0.86 is under camp_fire.js's lowest
    // flame-core radiance (1.05 at midday) at every hour, and the knee is above
    // anything daylight alone produces.
    uValueKnee:   new THREE.Uniform(opts.valueKnee ?? VALUE_KNEE),
    uValueCeil:   new THREE.Uniform(opts.valueCeil ?? VALUE_CEIL),
    // The fire's luminous radius. See SRC_RADIUS; 0 is the point model.
    uSrcRadius:   new THREE.Uniform(opts.srcRadius ?? SRC_RADIUS),
    // The two numbers of the paper lantern, as uniforms for the same reason the
    // value ceiling's two are: they are what the round is judged on, and every
    // round so far has spent its capture budget re-deriving them one edit at a
    // time. toastlab.mjs sweeps them with --sk / --sg.
    uScatterK:    new THREE.Uniform(opts.scatterK ?? SCATTER_K),
    uScatterGain: new THREE.Uniform(opts.scatterGain ?? SCATTER_GAIN),
    // The other two numbers of the lantern's MIDDLE, for the same reason.
    // toastlab.mjs sweeps them with --diff / --core.
    uScatterDiff: new THREE.Uniform(opts.scatterDiff ?? SCATTER_DIFF),
    uCoreK:       new THREE.Uniform(opts.coreK ?? CORE_K),
  };

  const mat = new THREE.MeshStandardMaterial({
    // White, because the toast ramp writes diffuseColor outright. Leaving the
    // cream in the material colour as well would multiply the ramp by itself.
    color: 0xffffff,
    // Raw marshmallow is a matte foam with a faint waxy sheen where the sugar
    // skin has set. Roughness is modulated per fragment below — caramel is
    // glossy and melt is wet — and this is the raw end of that range.
    roughness: 0.86,
    metalness: 0.0,
    // Smooth-shaded. Every other prop in the camp is flat shaded and gets its
    // form from facets; this one is a soft round blob whose form comes from the
    // blisters, and faceting it would give it the one silhouette a marshmallow
    // must not have.
    flatShading: false,
  });

  // ── two notes to the rest of the render stack ────────────────────────────
  //
  // Stylize compiles the physical specular lobe out of every matte, metalness-0,
  // env-map-free material — which is this one, and which would be wrong. A
  // melting marshmallow is a wet sugar surface and the small moving highlight
  // sliding over it as it turns is a large part of what says "this is molten"
  // rather than "this is painted brown". This is the documented opt-out.
  mat.userData.keepPhysicalSpecular = true;
  //
  // And the cool cast-shadow mass is turned most of the way down. Stylize's own
  // note says it: a pale warm surface is exactly where that term stops reading
  // as cool and starts reading as violet, and this is the palest warmest object
  // in the game, held 300 mm from the lens, in a frame whose entire subject is
  // firelight. The camp's bare dirt already makes this exception.
  mat.userData.shadowCool = 0.25;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    // ── vertex ──────────────────────────────────────────────────────────
    shader.vertexShader = MS_UNIFORMS_DECL + MS_NOISE + /* glsl */`
      varying vec2 vMsUv;
      varying vec3 vMsObj;
      varying vec3 vMsFireV;
      varying vec3 vMsFitN;
      varying vec4 vMsMap;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`#include <begin_vertex>

      vMsUv = uv;
      vMsObj = position;
      vMsMap = texture2D( uToast, uv );

      // The fire direction, carried into view space here rather than in the
      // fragment shader because normalMatrix is a vertex-only uniform. It is
      // constant over the mesh, so interpolating it costs nothing and changes
      // nothing.
      vMsFireV = normalize( normalMatrix * uFireDir );

      // ── the BODY's normal, as opposed to the SURFACE's ──────────────────
      //
      // This exists for exactly one consumer — the translucency's thickness
      // term — and the reason it has to exist is the shape of this object.
      //
      // Path length through a body along the view ray is what decides how much
      // light comes out of a foam, and on a convex body it is proportional to
      // dot(N, V): longest where you look straight down onto the surface,
      // shortest at the silhouette. That is exactly right for a sphere, and it
      // is USELESS on a squat cylinder seen anywhere near end-on, because the
      // end face is FLAT: dot(N, V) is 1 across the whole of it, so the
      // transmittance comes out constant over most of the visible disc and the
      // term paints a flat wash. Round 5 measured that on the shipped macro —
      // a traverse across mallow-backlit reads 0.37 to 0.42 from limb to limb,
      // a 1.19:1 range with no peak anywhere, against a design intent of 5.5:1.
      // The critic's question was "not reaching the frame, or swamped"; the
      // answer was neither. It reached the frame as a constant.
      //
      // normalize(position) is the normal of the SPHERE the body sits inside,
      // and it varies smoothly from the axis at the centre of the end face to
      // fully radial at the barrel — 0 to 58 degrees over the face, which is
      // the dome-shaped gradient the eye is looking for and which the real
      // surface normal cannot supply. It is a thickness ESTIMATOR, not a
      // shading normal: nothing lights with it, so the flat face keeps its own
      // flat shading and only the amount of light coming through it varies.
      //
      // The mallow's origin is its centre (the geometry contract promises it,
      // and the sag term already depends on it), so position is already the
      // vector from the centre and needs no offset. The epsilon is for the one
      // vertex that could sit exactly at the origin; none does, and a
      // normalize(0) is an undefined value propagating into a varying.
      vMsFitN = normalize( normalMatrix * normalize( position + vec3( 0.0, 0.0, 1e-7 ) ) );

      // ── WORLD down, expressed in the mallow's own space ─────────────────
      // The droop has to be the same droop however the stick is twirled, so it
      // cannot be authored against a local axis. There is no inverse() in GLSL
      // ES 1.0, but the model matrix here is a rotation and a translation, so
      // its inverse rotation is its transpose — and multiplying a row vector by
      // the matrix is exactly that. Same trick Stylize uses to recover a
      // world-space normal from a view-space one.
      vec3 msDown = ( vec4( 0.0, -1.0, 0.0, 0.0 ) * modelMatrix ).xyz;
      float msDl = length( msDown );
      msDown = msDl > 1e-6 ? msDown / msDl : vec3( 0.0, -1.0, 0.0 );

      // -1 at the top of the body, +1 at the bottom.
      float msAx = clamp( dot( transformed, msDown ) / uRadius, -1.0, 1.0 );

      // 1. Swell. The whole body puffs as the air in the foam expands; a little
      //    more where it has already melted, because that is where the skin has
      //    given up. This is the first thing a player sees happen and it happens
      //    early, well before any colour does.
      //
      //    THE SCALE HERE IS 0.20 OF THE RADIUS AND IT USED TO BE 1.0, which is
      //    the single worst number this file has had in it. The view drives
      //    uSwell as smoothstep(0.10, 0.66, doneness), so it is pinned at 1 for
      //    the whole second half of an ordinary roast — and at 1.0 the
      //    displacement was a full 21 mm along the normal, i.e. a marshmallow
      //    that DOUBLES in radius as it cooks. Nobody caught it because at the
      //    forty pixels the shipped frames render this object at, a marshmallow
      //    twice the size is a marshmallow. Filling the frame it walks out of
      //    it, and every procedural field on the surface is stretched to twice
      //    its authored scale with it — the craquelure at 2x reads as wood
      //    grain, which is what the first sheet out of the lab showed.
      //
      //    A marshmallow over a fire puffs by roughly a half in volume before
      //    it starts to slump, which is about a sixth in radius. 0.155 on the
      //    waist, plus a little more where it has melted, is that.
      //
      //    ── AND IT IS A SCALE, NOT AN OFFSET, WHICH IS THE ROUND 4 FIX ─────
      //
      //    This used to read "transformed += objectNormal * (...)", i.e. an
      //    OFFSET SURFACE. An offset surface does not preserve proportion: it
      //    adds the same distance to the radius, to the half-length and to the
      //    edge radius, and those three start at 21 / 13 / 5 mm, so the same
      //    4.2 mm lands very differently on each. Measured on the contract's
      //    own numbers, the old line at full swell gave
      //
      //        R  21.0 -> 25.2 mm   (+20%)
      //        H  13.0 -> 17.2 mm   (+32%)
      //        E   5.0 ->  9.2 mm   (+84%)
      //        aspect (dia/len)   1.615 -> 1.465   (-9%)
      //        edge as a fraction of the half-length  0.385 -> 0.535  (+39%)
      //
      //    — i.e. it took a squat cylinder and turned it into a rounded lozenge,
      //    and it did the most damage to exactly the two ratios that say
      //    "marshmallow" rather than "confectionery in general". It also
      //    DEEPENED the dished ends: offsetting a concave cap outward along its
      //    own normal shortens its radius of curvature, so the dish gets
      //    relatively deeper as the body gets bigger, which is most of why the
      //    round 3 macros past t = 0.3 read as a bagel.
      //
      //    A scale about the centre preserves the shape family exactly. Biased
      //    to the waist because that is what a marshmallow does — steam pushes
      //    the sides out and the stick holds the ends — so the object gets
      //    SQUATTER as it cooks instead of rounder:
      //
      //        R  21.0 -> 25.1 mm   (+19%)
      //        H  13.0 -> 13.9 mm   (+7%)
      //        aspect  1.615 -> 1.806   (+12%)
      //        edge as a fraction of the half-length  0.385 -> 0.40  (+4%)
      //
      //    The mallow's own axis is local +Z: the UV contract quoted at the top
      //    of this file is v = clamp01((z + zBar) / (2 zBar)), so z is the axis
      //    by definition and no geometry has to be read to know it.
      float msPuff = uSwell * 0.155 * ( 0.60 + 0.40 * vMsMap.g );
      {
        vec3 msAxis = vec3( 0.0, 0.0, 1.0 );
        float msZ = dot( transformed, msAxis );
        vec3 msWaist = transformed - msAxis * msZ;
        transformed += msWaist * ( msPuff * 1.25 ) + msAxis * ( msZ * msPuff * 0.45 );
      }

      // 2. Slump. Everything moves down, the belly further than the shoulders,
      //    and the top flattens as the body flows off it. Four terms rather
      //    than one uniform translation, because a marshmallow that only moves
      //    down is a marshmallow on a lift.
      //
      //    The split between the uniform part and the differential part is the
      //    whole read, and round 1 had it backwards: 0.30 uniform against 0.85
      //    differential moved the object down the frame nearly as much as it
      //    changed its shape, so at full melt the silhouette was a slightly
      //    fatter ball sitting slightly lower — a marshmallow on a lift after
      //    all. Almost all of it is differential now. The last term is the drip:
      //    the lowest point of a melting marshmallow does not just travel, it
      //    draws out into a hanging cusp, and that cusp is the single silhouette
      //    detail that says "molten" rather than "large".
      float msLow = smoothstep( -1.0, 1.0, msAx );
      transformed += msDown * ( uSag * uRadius * ( 0.12 + 1.05 * msLow ) );
      transformed += msDown * ( uSag * uRadius * 0.35 * smoothstep( 0.1, -1.0, msAx ) );
      transformed += msDown * ( uSag * uRadius * 0.35 * smoothstep( 0.55, 1.0, msAx ) );

      // 3. Spread. What slumps has to go somewhere: the lower half widens.
      vec3 msLat = transformed - msDown * dot( transformed, msDown );
      transformed += msLat * ( uSag * 0.34 * smoothstep( -0.2, 1.0, msAx ) );
      // And the drip narrows again at the very bottom, because a cusp is a cusp.
      transformed -= msLat * ( uSag * 0.45 * smoothstep( 0.72, 1.0, msAx ) );

      // 4. Blisters, the small half. The mesh cannot resolve a 2 mm bubble, so
      //    this only has to put a wobble on the silhouette; the fragment normal
      //    does the shading. Gated on toast, because raw marshmallow is smooth.
      // The seed is added to the POSITION and then scaled, exactly as the
      // fragment stage does it. Seeding after the scale instead would offset the
      // two by uSeed cells and the vertex bumps would sit between the fragment
      // domes rather than under them — a marshmallow whose silhouette bubbles in
      // one place and whose shading bubbles in another.
      // msPop is the same expression the fragment stage uses, and it has to
      // stay that way: it decides WHICH cells have blistered, so a vertex stage
      // that popped a different set from the fragment stage would put the
      // silhouette's bumps between the shaded domes.
      float msPop = smoothstep( 0.14, 0.58, vMsMap.r );
      float msBl = msBlisters( ( vMsObj + uSeed ) * uBlisterFreq, msPop ).x;
      transformed += objectNormal * ( uBlisterH * uRadius * msBl );
      `
    );

    // ── fragment ────────────────────────────────────────────────────────
    shader.fragmentShader = MS_UNIFORMS_DECL + /* glsl */`
      uniform vec3 uCream;
      uniform vec3 uGold;
      uniform vec3 uAmber;
      uniform vec3 uMahog;
      uniform vec3 uCharCol;
      uniform vec3 uScatter;
      uniform vec3 uEmber;
      uniform float uCrackFreq;
      uniform float uMottleFreq;
      uniform float uBlisterBump;
      uniform float uTransl;
      uniform float uValueKnee;
      uniform float uValueCeil;
      uniform float uSrcRadius;
      uniform float uScatterK;
      uniform float uScatterGain;
      uniform float uScatterDiff;
      uniform float uCoreK;
      varying vec2 vMsUv;
      varying vec3 vMsObj;
      varying vec3 vMsFireV;
      varying vec3 vMsFitN;
      varying vec4 vMsMap;

      // Globals so the colour block, the roughness block and the emissive block
      // can all read what the first of them computed. Three's chunks are
      // stitched into one main(), so this is a local by any other name.
      float gMsToast = 0.0;
      float gMsChar = 0.0;
      float gMsLive = 0.0;
      float gMsMelt = 0.0;
      float gMsCrack = 0.0;
      float gMsCrackCore = 0.0;
      float gMsBlister = 0.0;
      float gMsBlisterId = 0.0;
      float gMsRing = 0.0;
      float gMsDust = 0.0;
      float gMsRaw = 0.0;
      vec3 gMsCrust = vec3( 1.0 );
    ` + MS_NOISE + MS_FRAG_ONLY + /* glsl */`
      // ── the ramp ────────────────────────────────────────────────────────
      // Five stops, and the SPACING is the whole idea: cream to gold owns the
      // first third of the range and the remaining three transitions share the
      // rest, so the sweep a patient player lives in is slow and smooth and the
      // sweep past it is fast and alarming. The overlaps between the segments
      // are deliberate — butted smoothsteps produce a visible kink at each stop
      // and the kink reads as a contour line drawn on the sugar.
      //
      // ROUND 4 MOVED THE SECOND STOP, 0.30-0.60 -> 0.39-0.68. The contract's
      // "gold" rung is t = 0.42 and the old spacing had it 35% of the way from
      // gold to amber, i.e. already a mid brown before the blister term added
      // its own +0.1; the macro came back as a uniform milk chocolate. At the
      // new spacing t = 0.42 is 5% into that mix — a warm honey gold, which is
      // the rung's name. Nothing below 0.39 or above 0.68 moves.
      vec3 msRamp( float t ) {
        vec3 c = mix( uCream, uGold,  smoothstep( 0.00, 0.34, t ) );
        c = mix( c, uAmber,   smoothstep( 0.39, 0.68, t ) );
        c = mix( c, uMahog,   smoothstep( 0.62, 0.83, t ) );
        c = mix( c, uCharCol, smoothstep( 0.80, 0.95, t ) );
        return c;
      }
    ` + shader.fragmentShader.replace(
      // ── THE FIRE IS A VOLUME, AND THIS OBJECT IS INSIDE IT ────────────────
      //
      // The near-field falloff described at SRC_RADIUS, installed the only way
      // three lets you install it: getPointLightInfo is declared inside
      // lights_pars_begin, so the override is appended AFTER that chunk and a
      // macro redirects the call sites in lights_fragment_begin at it. The
      // original function is still there and still callable; we do not shadow
      // it, we replace its distance term and let it do the rest.
      //
      // Guarded on NUM_POINT_LIGHTS because the struct and the function only
      // exist when there is at least one, and this material has to link in the
      // gallery and in the boot pre-warm, where there may be none.
      //
      // It applies to EVERY point light rather than to the fire specifically,
      // and that is correct rather than lazy: every point light in this game is
      // a campfire, and the formula is its own gate — a lamp at four metres is
      // changed by one part in three hundred.
      '#include <lights_pars_begin>',
      /* glsl */`#include <lights_pars_begin>
      #if NUM_POINT_LIGHTS > 0
      void msPointLightNearField( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
        vec3 lVector = pointLight.position - geometryPosition;
        light.direction = normalize( lVector );
        // sqrt( d^2 + R^2 ): the effective distance to a source of radius R,
        // which is d in the far field and never smaller than R at the centre.
        // Taken on the squared length so there is no sqrt-then-square round
        // trip and no division by zero at d = 0.
        float msD2 = max( dot( lVector, lVector ), 0.0 );
        float msEff = sqrt( msD2 + uSrcRadius * uSrcRadius );
        light.color = pointLight.color;
        light.color *= getDistanceAttenuation( msEff, pointLight.distance, pointLight.decay );
        light.visible = ( light.color != vec3( 0.0 ) );
      }
      #define getPointLightInfo msPointLightNearField
      #endif`
    ).replace(
      '#include <color_fragment>',
      /* glsl */`#include <color_fragment>
      {
        vec4 msMap = texture2D( uToast, vMsUv );
        gMsToast = msMap.r;
        gMsMelt  = msMap.g;
        gMsLive  = msMap.b;
        gMsChar  = msMap.a;

        // ── the fine grain ─────────────────────────────────────────────────
        // Four fields, all in object space so none of them swims when the
        // marshmallow spins.
        vec3 msP = vMsObj + uSeed;
        // Same expression as the vertex stage. See the note there.
        float msPop = smoothstep( 0.14, 0.58, gMsToast );
        vec3 msBl = msBlisters( msP * uBlisterFreq, msPop );
        gMsBlisterId = msBl.y;
        gMsDust = msDust( msP * uDustFreq );
        gMsCrack = msCracks( msP * uCrackFreq );
        // How much raw sugar is left. Read by the dusting, the roughness and the
        // translucency, all of which are properties of UNCOOKED foam and all of
        // which have to go away as it caramelises.
        gMsRaw = 1.0 - smoothstep( 0.03, 0.30, gMsToast );

        // Two octaves of mottle rather than one. See the patchiness note below:
        // one octave is a slow wobble that reads as bad lighting, and the second
        // is what turns it into hot spots.
        // Three octaves, and each one is SWIZZLED. msNoise is value noise on an
        // integer lattice, and at the six-cells-across this field runs at, that
        // lattice is visible: the mid rungs came back with faint axis-aligned
        // rectangles in the browning, which read as compression artefacts. Two
        // octaves in the same orientation do not fix it, because they agree
        // about where the cell walls are. Rotating each octave onto a different
        // pair of axes costs nothing and breaks the agreement.
        //
        // ROUND 4 ADDED A DOMAIN WARP ON TOP OF THE SWIZZLE, because the
        // swizzle was not enough. The lab sheet at 420 px still came back with
        // plainly visible axis-aligned RECTANGLES on the dark-gold and mahogany
        // rungs — the same lattice, showing wherever the ramp is steepest,
        // because three octaves that disagree about orientation still agree
        // about the plane their cell walls lie in. One warp tap moves the cell
        // walls off the axes entirely and costs one msNoise.
        vec3 msMq = msP * uMottleFreq;
        msMq += vec3( 1.30, -0.85, 0.62 ) * msNoise( MS_ROT * msMq * 0.55 );
        float msMottle = msNoise( msMq ) * 0.55
                       + msNoise( MS_ROT * msMq * 2.31 + 5.1 ) * 0.30
                       + msNoise( MS_ROT * MS_ROT * msMq * 4.87 + 11.7 ) * 0.15;

        // Bubbles come in PATCHES. A marshmallow that has blistered evenly all
        // over is a marshmallow that was held in a uniform oven; over a fire the
        // bubbles cluster where the skin lifted, in loose islands a centimetre
        // across with clear skin between them. The same low-frequency field that
        // makes the browning patchy gates them, so a bubble island and a hot
        // spot are the same place — which is exactly right, because they are.
        //
        // The floor used to be 0.30, so a third of every bubble on the object
        // survived the gate and the field read as an even all-over pitting —
        // "golf ball, or strawberry seeds", which is the note round 3 came back
        // with. 0.06 leaves the skin between the islands genuinely clear, which
        // is what makes the islands read as islands.
        float msIsland = 0.06 + 1.05 * smoothstep( 0.34, 0.72, msMottle );
        gMsBlister = msBl.x * msIsland;
        gMsRing = msBl.z * msIsland;

        // Blisters toast FIRST, and that is most of what makes toast look like
        // toast rather than like a gradient: a blister is a thin dome of sugar
        // standing a millimetre closer to the fire with air behind it instead of
        // marshmallow, so it browns while the skin around it is still pale. The
        // density of them rises with toast, so a cream marshmallow is smooth and
        // a golden one is covered.
        float msDensity = smoothstep( 0.14, 0.62, gMsToast );
        // 0.22 is the field's own mean, so the term is a modulation ABOUT the
        // map's value rather than a multiplier on it. Round 1 wrote it as
        // gMsToast * (1 + k * (blister - 0.35)), which subtracts wherever the
        // field is below its pivot — and at t = 0.95 that took the skin between
        // the bubbles from 0.95 down to 0.68, i.e. from black to mahogany. The
        // char rung rendered as amber leopard print for that reason alone, which
        // no amount of work on the char colour would have fixed. The headroom
        // factor is the other half: the modulation has to shrink as the surface
        // approaches carbon, because charcoal is uniform.
        float msHeadroom = 1.0 - 0.85 * gMsToast;

        // ── browning is PATCHY, and the toast map cannot make it so ─────────
        //
        // Sugar does not brown as a wash. It browns at hot spots — wherever the
        // skin happens to be thinnest, wherever a bubble has lifted it off the
        // foam, wherever the flame licked once — and the patches then join up.
        // The toast map is 24 x 12 texels over a 42 mm object, which is a 5 mm
        // grid: it carries which SIDE is cooked and it cannot carry a hot spot,
        // and round 1 asked it to, with a +/-5% mottle on top. The result
        // measured correct and looked like a stain, which is the exact failure
        // docs/ROAST_CONTRACT.md warns about in its third bullet.
        //
        // +/-15% of the toast coordinate, faded out at both ends of the range
        // because raw sugar really is uniform and so is charcoal, and because a
        // mottle that survives to t = 1 puts pale blotches in the char.
        float msPatchW = smoothstep( 0.04, 0.34, gMsToast )
                       * ( 1.0 - smoothstep( 0.78, 1.00, gMsToast ) );
        //
        // The pivot moved 0.22 -> 0.09 with the field. It is the field's own
        // mean and the field is now sparse, so its mean is much lower; leaving
        // the pivot at the old value would have subtracted 0.13 of toast from
        // every square millimetre of clear skin on the object, i.e. would have
        // put the whole surface a rung back and the bubbles a rung forward.
        // Below the pivot the term still subtracts, and that subtraction is
        // wanted: it is the PALE VALLEY between browned blisters, which is what
        // the gold rung is supposed to look like and what round 3's flat tan
        // was missing.
        float msLocal = gMsToast
          + 0.42 * msDensity * msHeadroom * ( gMsBlister - 0.09 )
          + ( msMottle - 0.5 ) * 0.30 * msPatchW;

        // ── the terminator, where a scorched side meets a raw one ───────────
        //
        // D5-3: on the uneven capture the boundary between pink sugar and black
        // char is about six pixels wide, and along it you can count the bilinear
        // steps of the 24 x 12 map. The contract asks for the opposite shape —
        // "the sweep from deep amber to black char is fast and BLOTCHY".
        //
        // The map cannot supply the blotchiness: at 5 mm a texel it does not
        // have the resolution, and adding rows would only move the stairstep.
        // What it can supply is WHERE the boundary is, and fwidth() reads that
        // straight off the interpolated value: it is near zero over the flat
        // interior of a patch and large exactly on the edge. So the jitter is
        // applied only there, at full strength, and costs nothing anywhere
        // else. Two scales of it, because a boundary broken at one scale reads
        // as a scallop: the mottle gives the centimetre-scale bays and the dust
        // gives the sub-millimetre fray inside them.
        float msEdge = clamp( fwidth( gMsToast ) * 5.0, 0.0, 1.0 );
        msLocal += ( 0.70 * ( msMottle - 0.5 ) + 0.30 * ( gMsDust - 0.5 ) )
                 * 0.90 * msEdge;

        msLocal = clamp( msLocal, 0.0, 1.0 );

        vec3 msCol = msRamp( msLocal );

        // ── the crust, as something light has to LEAVE through ─────────────
        //
        // Read by the translucency block and by nothing else. uScatter is the
        // colour of light that has crossed four centimetres of white foam, and
        // on a raw marshmallow that is the whole path. On a browned one it is
        // not: the last fraction of a millimetre is caramel, and a crust that
        // absorbs blue on the way IN absorbs it on the way OUT. Until now the
        // glow left at the same colour whatever the sugar had become, and
        // msPale dimmed it without ever tinting it — so the additive term was
        // a fixed cream-orange pedestal laid over the whole ladder, and it was
        // measured: with the scatter ablated (--transl 0) the backlit rungs
        // walk G/R 0.512 / 0.433 / 0.305 from raw to gold to mahogany, and
        // with it on they walk 0.567 / 0.530 / 0.500. Two thirds of the ramp's
        // hue was being painted over by the one term that did not know about
        // the ramp.
        //
        // Normalised to the crust's OWN brightest channel, so it is a
        // subtractive chroma statement and cannot brighten anything: every
        // component is at most 1, the wavelengths caramel actually absorbs come
        // down, and the standing rule is moved the safe way at every rung. The
        // value it does carry is the same absorption the ramp already
        // describes, which is why msPale is not also scaled by it.
        //
        // Taken BEFORE the ring, dust, crack and ash terms below: those are
        // surface features a millimetre deep, and the light leaving the body
        // does not care where a bubble's foot is.
        gMsCrust = msCol / max( max( msCol.r, msCol.g ), max( msCol.b, 1e-3 ) );

        // ── the collar under each bubble ───────────────────────────────────
        // Not a browning term — a shading one. Where the lifted skin meets the
        // body the sugar is thicker and pulled tight, and it sits in its own
        // tiny crease, so it reads darker than either the dome or the flat skin
        // whatever the light is doing. This is what stops a dome reading as a
        // crater: a crater's rim is LIGHTER on the far side and a bubble's foot
        // is darker all the way round. It fades out into the char, because a
        // black surface has no room for a darker ring.
        msCol *= 1.0 - 0.34 * gMsRing * msDensity * ( 1.0 - gMsChar );

        // ── the dusting ────────────────────────────────────────────────────
        // And the one thing it must NOT do is raise the value. The obvious
        // implementation of icing sugar is a white speckle mixed toward white,
        // and on the palest, warmest object in the game — held 250 mm from a
        // point light the rest of the camp never gets within a metre of — that
        // is how the marshmallow ends up the brightest thing in the frame. Round
        // 1 measured it: at the default hour the mallow's peak sat at 0.942
        // against the flame core's 0.855, at EVERY rung of the ladder including
        // full char.
        //
        // What starch actually does to sugar is take the chroma and the sheen
        // out of it at the same value. So: pull toward the surface's own
        // luminance, not toward white, and let the roughness block do the rest.
        float msDustM = smoothstep( 0.42, 0.86, gMsDust ) * gMsRaw;
        float msGrey = dot( msCol, vec3( 0.34, 0.50, 0.16 ) );
        msCol = mix( msCol, mix( msCol, vec3( msGrey ), 0.75 ) * 1.02, msDustM * 0.55 );

        // ── char cracks ────────────────────────────────────────────────────
        // Only where there is char to crack. The splits go darker than the char
        // itself — they are looking into the inside of a burnt shell — and the
        // network breaks the black up so it reads as a crust rather than as an
        // area where the texture failed to load.
        //
        // gMsCrackCore is the middle of a split rather than the whole groove,
        // and it is what the ember is gated on. Round 1 gated the ember on the
        // full crack mask and produced a lava ball: a char marshmallow that
        // measured 1.81 linear at its 99th percentile under firelight, against
        // 1.97 for a RAW one. The brief's line is that char is matte and black
        // and the cracks are the only place any orange shows, and "the cracks"
        // means the bottom of them.
        gMsCrackCore = smoothstep( 0.55, 0.95, gMsCrack ) * gMsCrack;
        float msCrackM = gMsCrack * smoothstep( 0.15, 0.65, gMsChar );
        msCol = mix( msCol, uCharCol * 0.22, msCrackM * 0.90 );

        // ── ash ────────────────────────────────────────────────────────────
        // D3-6 asks for "matte black with grey ash", and the black on its own
        // is a hole in the frame: the char rung measured a body mean of 0.011
        // linear in daylight, which is 2% of raw and nothing the eye can find
        // any form in. Ash is what a burnt crust actually has on it and it is
        // the only thing that gives the char rung readable relief without
        // putting light back into it. It sits on the PLATES and not in the
        // splits — a crack is fresh carbon, the flat of a plate is where the
        // powder stays — and it is broken up by the same starch field that
        // dusts the raw sugar, so it is patchy rather than a wash. 0.052
        // linear against the char's own 0.016 is a grey that is still four
        // stops under the dirt.
        float msAsh = smoothstep( 0.45, 0.95, gMsChar )
                    * ( 1.0 - gMsCrack )
                    * smoothstep( 0.30, 0.82, gMsDust );
        msCol = mix( msCol, vec3( 0.052, 0.048, 0.046 ), msAsh * 0.60 );

        diffuseColor.rgb *= msCol;
      }`
    ).replace(
      '#include <roughnessmap_fragment>',
      /* glsl */`#include <roughnessmap_fragment>
      {
        // Five states, in the order a marshmallow passes through them, and the
        // material's own roughness is only the first.
        //
        // 1. POWDERED. Raw sugar is not a clean matte, it is a dusted one, and
        //    the starch is what kills the sheen. Round 1 had no dust term at
        //    all, so the raw rung came out as one broad soft highlight over a
        //    smooth cream body — a ping-pong ball, which is one of the three
        //    things the brief names by name.
        roughnessFactor = mix( roughnessFactor, 0.99, gMsDust * gMsRaw * 0.80 );
        // 2. WET, BEFORE BROWN. "Warming, it goes glossy and slumps before it
        //    browns at all" — so the first gloss on the object is driven by
        //    MELT, which starts at a lower heat threshold than browning does,
        //    and not by toast. Round 1 keyed every gloss term off toast and the
        //    surface therefore stayed powdery-matte right up until it changed
        //    colour, which is the wrong order of events.
        roughnessFactor = mix( roughnessFactor, 0.46, smoothstep( 0.04, 0.42, gMsMelt ) );
        // 3. CARAMEL. Glossy through the middle of the range and matte again
        //    past it.
        // 0.38 -> 0.50, and 0.30 -> 0.42 on the skins below. Both are a
        // response to the same measurement: under the fire's own light the
        // mahogany rung's 95th percentile came back at 0.398 linear against a
        // RAW marshmallow's 0.430, i.e. a near-black surface reflecting as
        // brightly as a white one. That is not a highlight, it is a wash, and
        // it is what makes the mid rungs read as glazed pottery. Caramel is
        // glossy against a window; against a fire at 250 mm — 19 irradiance
        // units after the near-field falloff, and 37 before it — it has to be
        // authored rougher than life or the lobe becomes the surface.
        float msGloss = smoothstep( 0.20, 0.62, gMsToast ) * ( 1.0 - smoothstep( 0.72, 0.95, gMsToast ) );
        roughnessFactor = mix( roughnessFactor, 0.50, msGloss );
        // 4. THE BLISTER SKINS. The shiniest thing on a toasting marshmallow is
        //    the taut skin on top of a bubble, and each one is a little
        //    different — hence the bubble's own random rather than one number.
        roughnessFactor = mix( roughnessFactor, 0.42,
          gMsBlister * msGloss * ( 0.35 + 0.55 * gMsBlisterId ) );
        // 5. CHAR. Carbon, and dead flat. 0.97 -> 0.995, and see the note in
        //    lights_fragment_end where the specular lobe itself is taken off
        //    the char: roughness alone does not get there. The lab measured a
        //    charred marshmallow's 95th percentile at 0.458 linear under
        //    firelight against a RAW one's 0.484 — a 5% difference across the
        //    entire cooking range, on the object the whole mechanic is about.
        roughnessFactor = mix( roughnessFactor, 0.995, smoothstep( 0.30, 0.75, gMsChar ) );
        // The floor is 0.16, not 0.06. This object sits 250 mm from the fire —
        // 19 irradiance units even after the near-field falloff, an order of
        // magnitude more than anything else in the camp ever sees — and at 0.06
        // roughness the specular lobe on that is a welding arc. The
        // lab measured a single-pixel peak of 4.96 linear at the dark-gold rung,
        // four times the flame core's 1.15.
        roughnessFactor = clamp( roughnessFactor, 0.16, 1.0 );
      }`
    ).replace(
      '#include <normal_fragment_maps>',
      /* glsl */`#include <normal_fragment_maps>
      {
        // ── blisters, the large half ───────────────────────────────────────
        // A height field of domes, perturbed into the normal through screen-
        // space derivatives. This is where the bubbling actually reads: the
        // vertex term above only breaks the silhouette, and everything the eye
        // calls "bubbled" is the shading of these domes catching the firelight
        // one at a time as the marshmallow turns.
        float msH = gMsBlister * uBlisterH * uRadius
                  * smoothstep( 0.10, 0.62, gMsToast );
        // ── the crust a RAW marshmallow already has ────────────────────────
        // Two small always-on terms, and they are the difference between the
        // first rung reading as sugar and reading as an injection moulding.
        // The dust is a sub-millimetre pebbling of the starch layer; the second
        // term is the faint pucker of the set skin, which is the same cellular
        // field as the blisters at a tenth of the amplitude and is only there
        // while the surface is still pale (once it browns the real blisters take
        // over and this would double them).
        // The amplitudes are small on purpose and the first cut of them was not:
        // 0.030 of the radius is 0.6 mm of relief at a 0.55 mm frequency, which
        // is not a dusting, it is sandpaper. The whole job of this term is to
        // stop the raw rung being a perfect sphere-shaded blank; a marshmallow
        // with legible noise on it reads as a pebble, which is the same note the
        // geometry author has beside their vertex-colour dusting.
        // 0.008 -> 0.0035. D3-4: "in mallow-0 the raw marshmallow already
        // carries a full-density isotropic sandpaper stipple over its entire
        // surface … this reads as pumice or sandblasted foam, not powdered
        // sugar." 0.008 of the radius is 0.17 mm of relief at a 0.55 mm
        // frequency, which is a 30% slope — that is sand, not starch. At 0.0035
        // it is a 13% slope and it does what it is for: it stops the raw rung
        // being a perfect sphere-shaded blank without becoming a texture.
        msH += ( gMsDust - 0.5 ) * uRadius * 0.0035;
        msH += ( gMsBlister - 0.10 ) * uRadius * 0.014 * gMsRaw;
        // The collar again, as geometry this time: the foot of a bubble sits in
        // a crease. Same sign as a crack and about a fifth of the depth, and it
        // is what makes the domes catch a rim of firelight round their base
        // instead of fading into the skin.
        msH -= gMsRing * uBlisterH * uRadius * 0.30
             * smoothstep( 0.10, 0.62, gMsToast );
        // The char crust is a second, coarser height field: cracks are grooves.
        //
        // The depth is quoted against the RADIUS, not against uBlisterH, and
        // that is round 4's correction. Tying it to the blister amplitude meant
        // that making the bubbles proud made the cracks deep, and at 0.75 of a
        // 1.57 mm blister over 5.5 mm cells the crust had a 20% slope on every
        // split — which the screen-space bump turned into a lit ridge along
        // both sides of every crack. The char macro came back as a glowing
        // bronze filigree over black, i.e. a lava rock. A crack in burnt sugar
        // is a hairline you can see the dark of, not a canyon: 0.010 of the
        // radius is 0.21 mm, which is what a crust that thin can actually do.
        msH -= gMsCrack * smoothstep( 0.15, 0.65, gMsChar ) * uRadius * 0.010;
        // The height is in METRES and so is the surface position, so the slope
        // this recovers is the real one and needs no screen-space fudge factor —
        // unlike three's own perturbNormalArb, which normalises its derivatives
        // and therefore needs bumpScale re-tuned whenever the object changes
        // size on screen.
        normal = msBump( msH * uBlisterBump, normal, - vViewPosition, faceDirection );
      }`
    ).replace(
      '#include <lights_fragment_end>',
      /* glsl */`#include <lights_fragment_end>
      {
        // ── TRANSLUCENCY ──────────────────────────────────────────────────
        //
        // The one detail the brief says this object lives or dies on, and the
        // reason is worth restating: a marshmallow is a foam of sugar and air,
        // which means it is not an opaque surface at all. Held over a fire it
        // glows — light enters the far side, bounces around inside the foam for
        // a centimetre or two and comes back out toward the eye, warm and soft
        // and with none of the surface's own shading in it. Without this the
        // object renders as a white pill and the whole mechanic looks cheap.
        //
        // Four gates, multiplied, and each one is doing a specific job:
        //
        //   BACK   light reaching the shaded side. A wrap term about the fire
        //          direction, so the term is strongest on the hemisphere facing
        //          the fire and does not stop dead at the terminator.
        //   THRU   the view being roughly aligned with the light's own onward
        //          direction. This is what makes the glow appear when the fire
        //          is BEHIND the marshmallow from where you are sitting, and go
        //          away when it is beside it. It is the whole reason the first
        //          person framing puts the mallow between the eye and the flame.
        //   THICK  how far the light had to travel. On a convex body the path
        //          along the view ray is longest where you are looking straight
        //          at the surface and shortest at the silhouette, so Beer's law
        //          on it is the gradient itself: the rim lights up and the
        //          middle goes dark. (Round 3 had a GRAZE term with a floor
        //          under it instead, which is a wash and not a gradient; the
        //          long note beside msThick is that autopsy.)
        //   PALE   how much raw sugar is left. Caramelised sugar is opaque —
        //          this is why a burnt marshmallow goes dead and flat while a
        //          fresh one is a paper lantern — so translucency FALLS as toast
        //          rises rather than being a constant property of the object.
        //
        // It is added to totalEmissiveRadiance rather than to a lighting term,
        // for the same reason Stylize adds its rim to directSpecular and not to
        // irradiance: light that has travelled THROUGH an object is not that
        // object's albedo multiplied by anything. Going in here also means it
        // picks up the global fog on the way out, which a term added after
        // opaque_fragment would not.
        vec3 msN = normal;
        vec3 msV = normalize( vViewPosition );
        vec3 msL = normalize( vMsFireV );

        // ── ROUND 4: THE MISSING TERM WAS THICKNESS ────────────────────────
        //
        // Round 3's scatter was BACK * THRU * GRAZE + a 0.26 pedestal, and it
        // was measured flat. The reason is structural, not a gain: THRU depends
        // only on where the eye and the fire are, which is the same everywhere
        // on a 42 mm object, and the pedestal is a constant. So on the one frame
        // the term exists for — mallow-backlit, fire dead behind, no reflected
        // light on the visible hemisphere at all — the ONLY thing varying over
        // the body was GRAZE, and GRAZE carried a 0.22 floor. The marshmallow
        // therefore rendered as a single flat tan disc: a wash, painted by the
        // translucency term itself. The lab's number for it is the raw rung
        // under firelight at linMean 0.426 against linP99 0.484 — a body whose
        // brightest percentile is 14% above its mean, which is not a lit object.
        //
        // What was missing is the one thing that actually decides how much light
        // comes out of a foam: HOW FAR IT HAD TO TRAVEL. On a convex body the
        // path length along the view ray is longest where you are looking
        // straight at the surface and shortest at the silhouette, and dot(N,V)
        // is exactly that, normalised. Beer's law turns it into a transmittance
        // and the transmittance is the gradient — bright rim, dark core, which
        // is what a marshmallow with a fire behind it looks like and is the one
        // read the contract says this object lives or dies on.
        //
        // ── the extinction, and the trap in choosing it ────────────────────
        //
        // 1.7, and both of the numbers this round tried before it were wrong in
        // opposite directions. The trap is that the extinction sets TWO things
        // at once — how dark the middle is, and how WIDE the bright band at the
        // limb is — and only the first one is obvious.
        //
        // At k = 4.2 the middle passes 1.5%, which is a properly dark core. But
        // transmittance only exceeds a half within 9.5 degrees of the
        // silhouette, and 9.5 degrees of a 495 px disc is THREE PIXELS. The
        // round 4 macro traverse measured it: a flat body at 0.38-0.40 with no
        // peak anywhere, because the peak existed and was three pixels wide.
        // At k = 2.8 the core passed 6% of a large term, which is a 0.15 linear
        // wash over the whole body.
        //
        // The cure is not the extinction on its own, it is the extinction TOGETHER
        // with the gains below, and they were set as a pair.
        //
        // ── ROUND 7: 1.7 -> 3.4, AND THE ROUND-4 TRAP IS NO LONGER SET ─────
        //
        // Everything above is still true about a rim made ONLY by the additive
        // term, which is what round 4 had. Three things have changed since and
        // together they move the whole trade:
        //
        //   · the thickness is taken off the sphere-fit body normal (round 5,
        //     below), so the profile is a real dome instead of a flat wash over
        //     the end face;
        //   · the object is no longer pinned at the value ceiling, so the LIMB
        //     rests on the ceiling and the extinction only has to make the
        //     CORE dark;
        //   · the core-darkening term below now survives to the frame, so the
        //     middle is dark for two reasons rather than one.
        //
        // With the limb held at the ceiling by SCATTER_GAIN, the extinction is
        // free to be exactly the number that lands the contract's ratio, and
        // that is what it now is. Swept in the lab under the game's damped fire
        // with the gain fixed at 1.4 (the sweep below is off the raw rung; the
        // gold rung, which is where the backlit macro is captured, runs about
        // 0.8 higher because msPale has come down and the ramp is darker):
        //
        //     k     limb    core     limb : core (raw)   (gold)
        //     2.2  0.5308  0.1845     2.88 : 1
        //     2.8  0.5307  0.1270     4.18 : 1
        //     3.6  0.5268  0.1087     4.85 : 1          5.64 : 1
        //     4.0  0.5306  0.0775     6.85 : 1
        //
        // The limb does not move across that sweep — which is the whole point,
        // and is why the round-4 objection does not apply: the bright band is
        // not made by the extinction any more, so narrowing the exponent's
        // half-transmittance angle does not narrow the rim. What the eye reads
        // as the rim's width is the band where the transmittance is still a
        // fifth or more, and at k = 3.6 that reaches in to 89% of the radius —
        // the outer ninth, or about 27 px of a 495 px macro, against the three
        // pixels round 4 measured.
        //
        // ── ROUND 5: THE THICKNESS IS TAKEN OFF THE BODY, NOT THE SURFACE ──
        //
        // This read dot(normal, msV), which is right on a sphere and wrong on
        // this object: the marshmallow's end face is FLAT and it is most of the
        // silhouette from the seat, so dot(N, V) was pinned at 1 over the whole
        // face and the transmittance came out constant. The shipped macro
        // measures it — mallow-backlit traverses 0.37 to 0.42 across the entire
        // disc, no peak, background 0.55. A flat wash, which is precisely the
        // failure the note above says round 4 set out to fix.
        //
        // vMsFitN is the sphere-fit body normal built in the vertex stage; see
        // the long note there. It is the only thing this term uses it for.
        // Nothing shades with it, so the flat face still shades flat.
        //
        // The bumped surface normal is deliberately NOT in this any more
        // either: a blister is a millimetre of skin, it does not change how far
        // light travelled through four centimetres of foam, and putting the
        // bump in here modulated the transmittance per-bubble and gave every
        // dome a bright halo.
        float msThick = clamp( dot( normalize( vMsFitN ), msV ), 0.0, 1.0 );
        float msTrans = exp( - msThick * uScatterK );

        // ── AND BEER'S LAW ALONE MAKES THE MIDDLE A HOLE ──────────────────
        //
        // exp(-k * thickness) is SINGLE scattering: the light that made it
        // along the view ray without being deflected. In a sugar foam that is
        // the wrong half of the physics. A marshmallow is a white, weakly
        // absorbing medium — the note beside SCATTER_COL says so already, and
        // uses it to argue the colour desaturates — and in a medium like that
        // photons are not extinguished at depth, they are RANDOMISED. They
        // random-walk and a fraction of them still come out toward the eye,
        // carrying no direction and none of the surface's shading.
        //
        // Ignoring that is visible and was measured: at uScatterK 3.6 the pole
        // passes 2.7% of the term, so with the direct light taken off the core
        // as well the middle of a backlit marshmallow rendered as a dark ochre
        // disc with a hot edge — a rim light on an opaque object, which is the
        // failure the round before this one was trying to escape in the other
        // direction. What it should be is a lantern: a middle that GLOWS, dimly
        // and warmly, under a much brighter rim.
        //
        // So the additive term runs on the transmittance plus a diffusion
        // floor, and only the additive term does — the core-darkening below
        // still uses the single-scattering figure, because what it is
        // subtracting is precisely the DIRECTIONAL light that did not arrive.
        // 0.020, and it was swept rather than picked: the whole design target
        // of this round is the contract's 5.5 : 1 from limb to core, and in
        // tools/_scratch/toastlab.mjs the raw rung under the game's own damped
        // fire measured 6.68 : 1 with no floor at all, 5.42 : 1 at 0.020,
        // 4.75 : 1 at 0.035 and 4.23 : 1 at 0.050. So this is the largest
        // diffusion floor the contract's ratio will pay for, and it is worth
        // paying for: it is a quarter more light in the middle of the lantern
        // than Beer's law alone leaves there, and it is WARM light, which is
        // what stops the middle reading as a hole punched in the frame.
        //
        // ── ROUND 8: THE RATIO IT WAS THE LARGEST THE CONTRACT WOULD PAY FOR
        //    IS NOT IN THE CONTRACT. See SCATTER_DIFF, which is where the
        //    number and the whole argument now live; the paragraph above is
        //    left standing because everything in it except the cap is still
        //    true, and the cap is the one thing that was never anybody's but
        //    this file's.
        float msTransE = msTrans + uScatterDiff * ( 1.0 - msTrans );

        // FORWARD SCATTER. The fire behind the object, seen through it. 2.2 ->
        // 1.6 because the thickness term now does the tightening that the
        // exponent used to be asked for.
        float msThru = pow( clamp( dot( - msV, msL ), 0.0, 1.0 ), 1.6 );

        // BACK, AND ROUND 3 HAD ITS SIGN THE WRONG WAY ROUND. The old term was
        // a wrap about +dot(N, L), i.e. it was strongest on the hemisphere
        // FACING the fire — which is the lit side, the one place a transmission
        // term can never be seen, because reflected light there is an order of
        // magnitude larger. Light that comes THROUGH a marshmallow enters the
        // far side, so the fragment that shows it is the one whose normal points
        // AWAY from the fire. Not a hard terminator: the 0.35 offset and the
        // 1.35 span are a wrap, so it eases in rather than switching on.
        float msBack = clamp( ( 0.35 - dot( msN, msL ) ) / 1.35, 0.0, 1.0 );

        // ── PALE, AND THIS GATE IS WHY THE TERM NEVER REACHED THE FRAME ────
        //
        // docs/ROAST_CRITIC_FINDINGS.md D3-3 traversed mallow-backlit and found
        // the darkest point of the whole scan AT THE LIMB (0.122 against a body
        // centre of 0.322 and a background of 0.503) — the exact inverse of a
        // back-scattering body, and it called the term "not implemented in any
        // measurable amount". It asked which: not reaching the frame, or
        // swamped. The answer is neither. It was SWITCHED OFF BY ITS OWN GATE.
        //
        // mallow-backlit is captured at doneness 0.42. The old gate was
        // 1 - smoothstep(0.04, 0.52, toast), which at 0.42 is 0.133 — so the
        // one frame in the set that exists to test translucency was rendered
        // with 13% of it, and the frame after it in the ladder with none. Every
        // gain in this block was being tuned against a factor of eight.
        //
        // And the gate was keyed to the wrong reaction. What makes a marshmallow
        // stop glowing is not going GOLDEN, it is going BLACK: caramel is a
        // crust a fraction of a millimetre thick over four centimetres of white
        // foam, and a golden marshmallow held up to a fire is still a paper
        // lantern — that is the whole reason anybody looks at one. Carbon is
        // what is actually opaque. So the fall is now mostly on the char
        // channel, with a modest 30% loss across the browning for the crust:
        //
        //     toast 0.00 char 0.00   msPale 1.00
        //     toast 0.42 char 0.00   msPale 0.83     (was 0.13)
        //     toast 0.78 char 0.09   msPale 0.70     (was 0.00)
        //     toast 0.95 char 0.84   msPale 0.07     (was 0.00)
        float msPale = ( 1.0 - 0.45 * smoothstep( 0.10, 0.70, gMsToast ) )
                     * ( 1.0 - 0.92 * smoothstep( 0.10, 0.60, gMsChar ) );
        // Melt makes it MORE translucent, not less: a marshmallow that has gone
        // molten inside has lost the opaque foam structure and turned to syrup.
        msPale = clamp( msPale + gMsMelt * 0.26 * ( 1.0 - gMsToast ), 0.0, 1.0 );

        // The 0.16 is a floor under the two directional gates, and it is what
        // buys the brief's "very slightly translucent at the edges". BACK and
        // THRU together say the fire has to be behind it before anything gets
        // through, which is right for the paper-lantern effect and wrong for the
        // ordinary rim: sugar foam is a couple of millimetres thick at the
        // silhouette whatever the light is doing, so daylight gets a thin warm
        // edge too. It is inside the THICKNESS factor, not beside it, so it can
        // only ever appear where the sugar is actually thin — which is the
        // difference between a rim and the flat pedestal round 3 shipped.
        //
        // ── uGlow does NOT gate this term at all any more ──────────────────
        //
        // Round 1 multiplied the whole thing by uGlow and round 3 by a
        // 0.55 + 0.45 * uGlow floor. Both are wrong and the second is wrong in a
        // way that shows up in a capture: camp_roast_view.js computes uGlow from
        // toast.peak, and peak is the maximum TOAST, not the live heat — see
        // the getter at line 618 and the note beside setDoneness. So the factor
        // rose monotonically with doneness and multiplied the scatter UP as the
        // sugar caramelised, which is precisely when a marshmallow stops being
        // translucent. msPale already carries the only doneness dependence this
        // term is entitled to.
        //
        // Translucency is a property of the foam and of where the fire is. Heat
        // does not create it. The ember below is the term that is genuinely
        // about live heat, and it keeps the full uGlow.
        // The three gains. Read them as "linear radiance at the limb, where the
        // transmittance is 1":
        //   0.05  the ambient rim. Sugar foam is thin at the silhouette
        //         whatever the light is doing, so daylight gets a warm edge too.
        //   0.20  the shaded hemisphere, where light entering the far side
        //         comes back out. Only alive when the fire is NOT dead behind —
        //         see the note below, which is why it is now gated.
        //   1.40  SCATTER_GAIN, the fire dead behind it. This is the paper
        //         lantern and it is the only one of the three large enough to
        //         reach the value ceiling.
        //
        // ── AND IT DOES NOT REACH IT UNDER THE GAME'S OWN FIRE ────────────
        // The sweep below and the claim above it were taken in a lab running
        // 13.8 irradiance units. The game runs 8.5 (see the round-8 note at the
        // top of this file), and at that the limb rests at 0.53 linear against
        // a ceiling of 0.86 — it has half again of headroom rather than sitting
        // on the shoulder. That is not an argument for raising this: the limb
        // is the object's maximum and the maximum is what the standing rule is
        // about, so headroom at the rim is exactly where headroom belongs. It
        // is an argument for not believing the sentence above.
        //
        // ── WHY 1.40 IS THE END OF THE ROAD FOR THIS GAIN ─────────────────
        //
        // It was 0.66 in round 4 and 0.90 in round 5, and neither of those
        // numbers meant anything, because every rung of the object was ten to
        // forty times over the value ceiling and the shoulder renormalised the
        // difference away. With the near-field falloff in (see SRC_RADIUS) the
        // gain finally does something, and what it does has a ceiling in the
        // literal sense. Swept in the lab on the raw rung under the game's
        // damped fire:
        //
        //     gain   limb   core    limb : core
        //     1.4   0.5306  0.095     5.58 : 1
        //     2.2   0.5477  0.113     4.84 : 1
        //     3.2   0.5568  0.136     4.10 : 1
        //     5.0   0.5646  0.177     3.20 : 1
        //
        // (that sweep was taken at k = 3.4 and coefficient 0.95, before the
        // last two numbers of the round settled; the shape is what matters)
        //
        // The limb is ALREADY resting on the ceiling at 1.4, so past it the
        // gain stops buying rim and only buys core — the shoulder passes the
        // extra light through in the dark middle, where there is headroom, and
        // eats it at the limb, where there is none. Turning this up makes the
        // marshmallow FLATTER. That is the trap round 5 fell into from the
        // other side and it is worth leaving the numbers here.
        //
        // ── AND msBack WAS AN ANTI-RIM ON THE ONE FRAME THAT MATTERS ──────
        //
        // msBack is a wrap about -dot(N, L), so on the dead-backlit frame it is
        // LARGEST where the surface faces the camera — which is the middle of
        // the disc — and smallest at the silhouette, where dot(N, L) passes
        // through zero. Measured on the lab's fire cell it runs 0.99 at the
        // core against 0.26 at the limb. It was therefore adding four times as
        // much light to the dark half of "bright rim, dark core" as to the
        // bright half, and only msTrans was holding it back.
        //
        // The fix is not a gain, it is that the two routes are the same
        // photons. msThru is light that went THROUGH and carried on toward the
        // eye; msBack is light that entered the far side and came back out.
        // When the fire is dead behind the object those are one path counted
        // twice. So msBack now fades out as msThru comes up, which leaves it
        // doing exactly the job its own note claims — the soft glow on the
        // shaded side of a marshmallow lit from beside it — and leaves the
        // backlit frame to the term that is about being backlit.
        float msAmt = uTransl * msPale * msTransE
          * ( 0.05 + 0.20 * msBack * ( 1.0 - msThru ) + uScatterGain * msThru );
        // gMsCrust is the near surface's own transmittance, normalised so it
        // can only take wavelengths out. See its note in <color_fragment>.
        totalEmissiveRadiance += uScatter * gMsCrust * msAmt;

        // ── AND THE OTHER HALF OF IT: THE CORE HAS TO GO DARK ─────────────
        //
        // Adding light at the limb is only half of "bright rim, dark core",
        // and until round 7 it was the half that could not land: the mallow sat
        // 244 mm from a lamp _dampHearth leaves at 2.19 intensity and decay 2,
        // about 37 irradiance units, so the body was far above the value
        // ceiling's shoulder everywhere and anything ADDED at the limb was
        // renormalised away on the next line. The traverse said so — the red
        // channel read 213-221 from limb to limb on mallow-backlit and 213-223
        // on every other frame at every rung, which is a clamp and not a
        // gradient. The near-field falloff at SRC_RADIUS is what fixed that;
        // both halves reach the frame now.
        //
        // This half is still worth having, and worth having FIRST, because it
        // is the half the ceiling can never undo: a value below the knee passes
        // through the shoulder untouched, so light taken out of the middle
        // stays out however bright the frame gets. It is not a cheat: when the
        // fire is behind the
        // marshmallow the camera-side surface is in the object's OWN SHADOW,
        // and the reason it is nevertheless brightly lit is Stylize's wrap
        // term, which lights shaded hemispheres on purpose and knows nothing
        // about how much sugar the light had to cross to get there. This is
        // that missing knowledge: (1 - msTrans) is how much of the path was
        // absorbed and msThru is how much of the light is coming from behind.
        // On a front-lit marshmallow msThru is zero and this line does nothing
        // at all.
        //
        // It also moves the object the right way against the standing rule:
        // every pixel it touches gets darker.
        // ── 0.55 -> 0.95, AND THE INDIRECT IS OUT OF IT ──────────────────
        //
        // Round 5 could not tell what this term was worth, because everything
        // it took out was put straight back by the value ceiling: at 37
        // irradiance units the body sat at about 4.0 linear pre-shoulder, and
        // 4.0 and 4.0 * 0.55 both map to 0.8600 to four figures. With the
        // near-field falloff above taking the fire to 19 units the shoulder is
        // barely engaged and the subtraction survives, so the coefficient can
        // finally be set to what the physics asks for rather than to what did
        // not break anything.
        //
        // What the physics asks for is 1.0. When msThru is 1 the fire is dead
        // behind the object, and a fragment on the camera side then has
        // dot(N, L) < 0 — it receives NO direct light at all. Every bit of the
        // direct term on it is Stylize's wrap, which lights shaded hemispheres
        // by fiat and knows nothing about the four centimetres of sugar in the
        // way. (1 - msTrans) is how much of that path absorbed, so at full
        // thickness and full backlighting the correct amount of wrap to keep is
        // none.
        //
        // It stops at 0.85 for a reason that is not a fudge: the wrap is also
        // the only thing in this material standing in for the fire's BOUNCE —
        // off the stones, off the dirt of the pit, off the player's own hand —
        // which really does reach the camera side and really is the fire's
        // colour. Taking the last sixth of it costs the frame more than it
        // buys. Swept in the lab on the gold rung, which is the rung the
        // backlit macro is captured at:
        //
        //     coeff   limb : core   body G/R
        //     0.95      6.41 : 1      0.549
        //     0.85      5.46 : 1      0.534
        //     0.75      4.76 : 1      0.520
        //
        // 0.85 lands the contract's 5.5 : 1 on that rung and leaves the middle
        // of the lantern warm. At 0.95 the game's macro at hour 16.7 came back
        // with the body lit almost entirely by the afternoon SKY, which is cool
        // — and a cool light on the gold stop's khaki albedo, against a
        // background of the fire's own veiling glare, reads as a green olive on
        // a stick. That is the failure at the far end of this term and it is
        // worth naming, because the number that causes it is only a sixth away.
        //
        // The INDIRECT is no longer scaled, and that was a plain error. Sky and
        // moon do not arrive through the marshmallow — they arrive from every
        // direction that is not the fire — so an extinction along the fire's
        // path has no business dimming them. Leaving them alone is also what
        // stops the core going to a dead black hole once the coefficient is
        // this large: at dusk the ambient is what the dark middle is MADE of.
        //
        // ── AND msPale IS NOT THE GATE. IT WAS THE LUMA INVERSION. ────────
        //
        // This used to be multiplied by msPale, and that put the term's full
        // strength on the RAW rung and 83% of it on the gold one — so the first
        // three rungs of the ladder came out with the raw marshmallow DARKER
        // than the golden one. Measured on the shipped macro: body luma 0.353 at
        // raw against 0.388 at gold, and the ramp is supposed to be monotone
        // down from cream to charcoal. Three rounds have reported that inversion
        // and two have gone looking for it in the ramp, which is innocent: the
        // cream stop is authored at 0xe8e0cf and the gold at 0xdcc47e, a linear
        // luma of 0.74 against 0.53, and no mix of those two can invert.
        //
        // The gate was also wrong on its own terms. What this term models is
        // that the camera-side surface is in the object's OWN shadow, which is a
        // fact about where the fire is and not about what the sugar has become;
        // and its own note argued msPale kept it "off charcoal, which is opaque
        // and self-shadows anyway" — but a surface that self-shadows more should
        // be darkened MORE, not exempted. The real reason charcoal needs relief
        // is that it is already at 0.02 linear and taking it lower punches a
        // hole in the frame, which is an argument about char and about nothing
        // else. So that is what the gate now says, and it says it in the char
        // channel where it belongs.
        // ── AND IT WAS EATING THE FLOOR, WHICH ITS OWN NOTE SAYS TO KEEP ───
        //
        // The paragraph above argues the coefficient stops at 0.85 rather than
        // 1.0 because "the wrap is also the only thing in this material
        // standing in for the fire's BOUNCE — off the stones, off the dirt of
        // the pit, off the player's own hand — which really does reach the
        // camera side". That argument is right and the implementation did not
        // carry it out, because Stylize's direct diffuse is not one thing. It
        // is two, and its own source says which is which:
        //
        //     dotNL = uStyleFloor + ( 1 - uStyleFloor ) * wrapNL
        //
        // The second half is the wrap — light this material is entitled to take
        // away, because the wrap lights shaded hemispheres by fiat and knows
        // nothing about four centimetres of sugar. The FIRST half is the floor,
        // 0.13, which is Stylize's "never let a surface fall to a hole" term
        // and is exactly the bounce the note wanted kept. Multiplying the sum
        // takes both in proportion, so 0.85 was taking 85% of the bounce too.
        //
        // On the frame this object is judged in, that is the whole difference.
        // At the ladder pose the lamp is 24 degrees off dead behind, so a
        // fragment facing the camera has dot(N, L) = -0.91 — and at
        // uStyleWrap 0.48 the wrap CLIPS TO ZERO there. There is no wrap left
        // on the middle of a backlit marshmallow: 100% of its direct light is
        // already the floor, and the old line was removing 71% of it. The
        // arithmetic, at the game's own 8.5 irradiance units:
        //
        //     full fire diffuse on cream                     1.99 linear
        //     x Stylize's floor 0.13                         0.259
        //     x the old msCore 0.284                         0.074   <- shipped
        //
        // Two thirds of the raw rung's darkness is that third line, and it is a
        // term subtracting light that was never the wrap's to begin with.
        //
        // So the subtraction is scaled by the share of the direct light that
        // IS the wrap. Where the wrap is alive — the annulus between the core
        // and the limb, which is where a lantern's gradient lives — the term
        // is unchanged. Where it has already clipped, the term now does
        // nothing, which is the correct amount of wrap to remove from a
        // fragment that has none.
        //
        // Banding is left out of the share deliberately. Stylize quantises
        // wrapNL before flooring it, but the share is a RATIO and the banding
        // moves its numerator and denominator together: at wrapNL 0.5 the exact
        // share is 0.753 against 0.770 here, i.e. two percent, for a floor() and
        // a smoothstep() in the inner loop. The uniforms are the same ones
        // Stylize declares, so this cannot drift from it silently — a retune of
        // the house wrap or floor moves this with it.
        float msRawNL = dot( msN, msL );
        float msWrapNL = clamp( ( msRawNL + uStyleWrap ) / ( 1.0 + uStyleWrap ), 0.0, 1.0 );
        float msWrapShare = ( 1.0 - uStyleFloor ) * msWrapNL
                          / max( uStyleFloor + ( 1.0 - uStyleFloor ) * msWrapNL, 1e-4 );
        float msCoreGate = 1.0 - 0.55 * smoothstep( 0.30, 0.80, gMsChar );
        float msCore = 1.0 - uCoreK * msThru * ( 1.0 - msTrans ) * msCoreGate * msWrapShare;
        reflectedLight.directDiffuse *= msCore;

        // ── CHAR HAS NO SPECULAR LOBE ─────────────────────────────────────
        //
        // Roughness alone does not get charcoal to matte: a dielectric F0 of
        // 0.04 against the ~19 irradiance units this object sits in is still
        // 0.4-plus of linear radiance however rough the surface is, and that is
        // what the lab caught — a charred marshmallow's 95th percentile at 0.458
        // linear against a raw one's 0.484 under the same firelight. The brief's
        // line is that char is matte and black and the only orange on it is down
        // inside the cracks; a black surface with a broad sheen is a wet rock.
        // The two numbers below were measured, not chosen, and the measurement
        // is worth writing down because it is counter-intuitive. The lab's
        // "off the fire" char cell — a fully charred marshmallow with the live
        // channel at zero, i.e. nothing emissive on it at all — renders its
        // specular lobe at about 7.0 linear. Seven. Killing 94% of it still
        // left 0.42 linear of orange, which drew every crack and every blister
        // edge as a lit filament and made the char macro read as a bronze
        // filigree over black. Killing 100% took the cell's 95th percentile
        // from 0.069 to 0.014 and its peak from 0.166 to 0.038. 0.985 is the
        // trace of glassiness a fused crust really does keep, and it is chosen
        // to land under the second number rather than over the first.
        //
        // The 0.35 is the same problem one rung earlier. (It was written as
        // 0.55 first and the prose below still quotes that figure; the pair of
        // measurements it cites are the reason it ended up lower.) This lobe is the
        // documented keepPhysicalSpecular opt-out and it is there for the wet
        // molten highlight, which is right — but a highlight lit by 19
        // irradiance units through a roughness-0.4 caramel is not a highlight,
        // it is a wash: the mahogany rung measured a 95th percentile of 0.426
        // linear against a RAW marshmallow's 0.488, i.e. a nearly black surface
        // reflecting as brightly as a white one. Halving the lobe keeps the
        // moving highlight and stops it being the surface. 0.55 was not
        // enough on its own — see the roughness block, which does the other
        // half — and the pair together took that percentile to 0.24.
        float msSpecKill = ( 1.0 - 0.985 * smoothstep( 0.25, 0.70, gMsChar ) ) * 0.35;
        reflectedLight.directSpecular *= msSpecKill;
        reflectedLight.indirectSpecular *= msSpecKill;

        // ── THE VALUE CEILING ─────────────────────────────────────────────
        //
        // The brief's first feature-specific rule: the fire owns the value
        // range, and a white marshmallow is the only object in this game that
        // can out-value the flame. Round 1 obeyed the letter of it — the raw
        // sugar is authored at the brief's own 0xe8e0cf — and failed anyway, at
        // every rung of the ladder, because the rule cannot be satisfied by
        // choosing an albedo. Measured off the shipped frames at the default
        // hour: mallow peak 0.942 / 0.924 / 0.915 / 0.919 / 0.914 / 0.889 across
        // ladder-0..5 against a flame core that peaks at 0.855. Fully charred
        // sugar out-valued the fire.
        //
        // The reason is geometric and no colour fixes it. camp_fire.js puts its
        // point light 0.42 m over the fire; camp_roast_view.js holds the mallow
        // at FLAME_TOP + height and 0.16 m to the right, which is 0.244 m from
        // that light at the resting pose. Nothing else in this game is ever
        // within a metre of that lamp, so no other material has ever had to care
        // — the dirt under the fire sits at a tenth of it. An albedo low enough
        // to land that irradiance under the flame core would be 0.15, i.e. a
        // grey marshmallow in daylight, which is a worse frame than the one we
        // have. (The near-field falloff at SRC_RADIUS has since halved it, and
        // the shoulder is STILL needed: with it off the raw rung ties the flame
        // core to within 7%. See the sweep beside VALUE_CEIL.)
        //
        // So the surface gets a shoulder instead: linear below the knee, and an
        // exponential approach to a ceiling above it. Three properties matter.
        // It is applied to the peak CHANNEL and scales all three, so it is a
        // value operator and not a saturation one. It is applied to reflected
        // light and to the scatter, and NOT to the ember below, so a marshmallow
        // that is actually on fire can still cross PostFX's bloom threshold —
        // that is the one thing on this object that is allowed to. And the knee
        // is high enough that daylight away from the fire never reaches it: the
        // lab's sun-only raw rung peaks at 0.81 linear and comes back 0.74.
        //
        // The ceiling is 0.86 rather than something rounder because camp_fire's
        // radiance ramp puts the flame core at 1.05 linear at midday, 1.15 at
        // dusk and 2.55 at night. 0.86 is under the lowest of the three with a
        // margin, at every hour, without a per-hour uniform to keep in sync.
        // (It was 0.96 for three rounds and the note above VALUE_CEIL has the
        // measurement that took it down; two stale 0.96s in this file's prose
        // were corrected in round 5, so do not trust a remembered number here
        // over the constant.)
        vec3 msLit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
                   + reflectedLight.directSpecular + reflectedLight.indirectSpecular
                   + totalEmissiveRadiance;
        float msPk = max( msLit.r, max( msLit.g, msLit.b ) );
        if ( msPk > uValueKnee ) {
          float msSpan = max( uValueCeil - uValueKnee, 1e-4 );
          float msNew = uValueKnee + msSpan * ( 1.0 - exp( - ( msPk - uValueKnee ) / msSpan ) );
          float msK = msNew / msPk;
          reflectedLight.directDiffuse *= msK;
          reflectedLight.indirectDiffuse *= msK;
          reflectedLight.directSpecular *= msK;
          reflectedLight.indirectSpecular *= msK;
          totalEmissiveRadiance *= msK;
        }

        // ── the ember in the crack ────────────────────────────────────────
        // Gated on the LIVE heat channel, not on char: a crack in a marshmallow
        // that came off the fire ten seconds ago is a black crack, and one that
        // is over the flame right now has a dull orange down inside it. That
        // distinction is the entire payload of the live-heat channel and it is
        // what makes the object look like it is being cooked rather than like it
        // has been painted.
        //
        // Gated on the crack CORE, not on the whole groove. The mask below used
        // to be gMsCrack, which is a band about a third of the field wide, and
        // the result was a marshmallow made of lava: measured under firelight,
        // round 1's char rung sat at 1.81 linear at its 99th percentile against
        // 1.97 for a RAW marshmallow — a 9% value difference across the entire
        // cooking range, on the one object the player spends the whole mechanic
        // looking at. Char has to be the darkest state this surface has, and the
        // orange has to be down inside the splits where it belongs.
        //
        // The live-heat gate moved 0.42-0.90 -> 0.55-0.95. D3-6: "a cooled
        // charred marshmallow is matte black with grey ash, full stop", and the
        // critic found the glow on a frame whose own state record says
        // burning: false. The old window let the 0.62 that a marshmallow merely
        // being HELD over the flame sits at through at a third strength, which
        // is a lamp. At the new window that same 0.62 passes 8%, which is a
        // hint of heat down in the deepest splits, and a marshmallow that is
        // actually alight — where the self-heat latch drives live to 1 — passes
        // the lot.
        float msGlowM = gMsCrackCore
          * smoothstep( 0.32, 0.78, gMsChar )
          * smoothstep( 0.55, 0.95, gMsLive );
        // A slow uneven breath over the crust, out of phase with itself in
        // object space so the whole surface does not pulse as one lamp.
        float msBreath = 0.72 + 0.28 * sin( uTime * 2.3 + msNoise( vMsObj * 420.0 ) * 12.0 );
        // 1.15, and the ceiling is not arbitrary: PostFX thresholds bloom in
        // LINEAR light at 1.70 after dark and 1.05 at midday (camp_fire.js has
        // the whole ramp). At uGlow 1 the brightest crack therefore sits just
        // under the night threshold and just over the day one — a glowing crust
        // that does not bloom while it is merely hot, and does the moment the
        // view raises uGlow because the thing has caught fire.
        // Added AFTER the ceiling, deliberately. This is the one term on the
        // marshmallow that is allowed to out-value the flame, because when it
        // does the marshmallow IS a flame.
        //
        // ── 1.15 -> 0.62, AND THAT IS THE 793 317 PIXELS ──────────────────
        //
        // This is the only term on the object that can cross PostFX's bloom
        // threshold, and bloom is the only mechanism by which a marshmallow can
        // change a pixel that is not on the marshmallow. At 1.15 with uGlow at
        // the 0.684 the harness measured at the char rung, the brightest crack
        // sat at 0.79 linear ON TOP of a body already pinned at the value
        // ceiling — 1.75 linear against a 1.05 midday bloom threshold, which is
        // a marshmallow with a light around it. 0.62 puts the same crack at
        // 0.42 over the ceiling, i.e. 1.38 at uGlow 1 (alight, which is when it
        // SHOULD bloom) and 0.99 at the 0.62 live heat setDoneness now
        // reconstructs (merely hot, which is when it should not).
        totalEmissiveRadiance += uEmber * ( msGlowM * msBreath * 0.62 * uGlow );
      }`
    );
  };

  // One program for every marshmallow in the session. There is normally exactly
  // one, but Camp's boot pre-warm builds and throws away a set of props before
  // the player can see a stall, and without this the pre-warm's compile would be
  // a different program from the live one — which is how a prop ends up linking
  // its shader on the frame it appears. Stylize's own defines are part of
  // three's cache key independently of this, so the matte and flat-shade
  // instruments still recompile correctly.
  mat.customProgramCacheKey = () => 'marshmallowToast';

  // The contract's set, exactly. Tuning knobs live on `uniforms` and are not
  // published: the view writes these five every frame and nothing else.
  mat.userData.roastUniforms = roastUniforms;
  mat.userData.uniforms = uniforms;
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ram — the horned shape on the high bench.
//
//  The second of the two alpine species, and the bought pack's. It replaced a
//  procedural yak: same country, same `rock` block, a quarter of the mass. Read
//  the goat's file first — the `rock` block is documented there — and then the
//  differences below, which are the same differences the yak had. A goat wants
//  the crag; a ram wants the bench and the apron beside it, so the two share a
//  mountain without standing in the same places.
//
//  The mesh, rig and weights are ithappy's (`assets/models/Animals_v3.0.blend`);
//  the clips this game needs and the pack does not ship are solved onto that rig
//  by `tools/build_ram_blend.py`, which saves `assets/models/ram_pack.blend`.
//  `tools/export_pack_glb.py` turns that into `/models/ram_pack.glb`.
//
//  The `brain` block below is the yak's, with only the numbers that are
//  genuinely about BODY SIZE moved (see the `rock` note). Where an animal lives
//  and what it minds does not depend on who modelled it.
//
//  ── one mesh, and no coats ────────────────────────────────────────────────
//  The pack ships `Ram_01` and `Ram_02` and they are bit-identical: 1377
//  vertices each, max local vertex delta 0.000000, the same 33 vertex groups,
//  both already on `Skeleton_Ram`. `Ram_02` is the demo scene's second copy
//  standing 0.996 m to the side, not a doe to the deer's buck — so there is no
//  second silhouette to be had here and shipping it would be 2726 triangles of
//  duplicate. The variants below are scale only.
//
//  Nor is there a colour morph. The asset is one textured palette material, so
//  a `col` override would replace the palette rather than recolour the coat —
//  the same loss `mammals/deer.js` records for the same reason.
//
//  ── the clips ─────────────────────────────────────────────────────────────
//    idle   115f  the pack's
//    walk    31f  the pack's, and the best walk in this pack: duty 0.57 on all
//                 four hooves, where a walk is DEFINED by a duty above 0.5.
//                 (The raccoon's is 0.47-0.53 and the deer's 0.25/0.30/0.23/0.10.)
//    graze  131f  the pack's `Gesture`, and a real graze: muzzle 1.297 -> 0.259
//                 with all four hooves dead still.
//    trot    11f  SOLVED here. No animal in this pack has a trot — 233 actions
//                 checked and there is not one anywhere.
//    run     18f  the GOAT's leap, retargeted onto this rig. See below.
//    alert  120f  authored here: head up, ears forward, a stiff scan each way.
//
//  ── the one clip the pack ships that this animal cannot use ───────────────
//  `Ram_Run` is dropped, and NOT for its duty — 0.38/0.23/0.23/0.23 is an
//  animal in the air, which is what a bound is, and reading that as "badly
//  planted" is the mistake that cost a day on the deer. It is dropped because
//  **there is no single ground speed in it**. Measured on the exported GLB by
//  `tools/_scratch/ramground.mjs`, each hoof implies a different body speed:
//
//      toeL 0.79   toeR 0.34   front_toeL 0.24   front_toeR 0.93   u per cycle
//
//  A factor of four between the two fore hooves. And because both fores dwell
//  at zero velocity inside their own stance, the densest cluster in the pooled
//  distribution sits at **0.0000 u/s over 14% of the samples** — so
//  `loadGlbSpecies` refuses the clip outright at boot ("moved none of the feet
//  named in glb.feet backwards"). There is nothing there to keep.
//
//  ── the run is the GOAT's leap, retargeted ────────────────────────────────
//  `Goat_Run` is the pack's own bound and it is the one gait in this game that
//  reads correctly, so this ram is given that MOTION rather than an imitation
//  of it. Two solved bounds were tried first and both read stiff — legs held
//  out straight where a bound folds them — and the reason is structural: a gait
//  spec is six scalars and an animator's curves are not six scalars. Measuring
//  the goat's cadence, duty, pitch and hoof lift and feeding them back into the
//  solver got the timing right and the shape wrong.
//
//  The two rigs share all 33 of this one's bone names, but their REST poses
//  differ — orientations by a median of 10.1°, by 20.6° at the shins and 54.3°
//  at `spine.006` — and a Blender action stores rotations relative to rest, so
//  copying the curves verbatim makes a different animal. What transfers is each
//  bone's rest-RELATIVE world rotation:
//
//      delta      = goat_posed_world @ goat_rest_world⁻¹
//      ram_target = delta @ ram_rest_world
//
//  Rest differences cancel. `tools/build_ram_blend.py` does it, parent-first,
//  every time it rebuilds from the pack; the block above `retarget_run` there
//  carries the detail, including why `Root` is excluded (its delta is a
//  constant 180°, the pack's facing convention, and applying it bounds the ram
//  tail-first) and why the body is raised by one constant offset.
//
//  Played at `rate: 2.0` on an 18-frame clip, which is exactly what
//  `mammals/goat.js` does with the same source clip — matching the goat means
//  matching how it is played, not only what is in it. It measures 5.890 m/s
//  against the goat's 5.142, and the earlier invented bound's 7.454.
//
//  ── what it does NOT fix: three hooves float ──────────────────────────────
//  The ram is not the goat, and the mismatch is in the rest pose: its hind legs
//  rest at 0.656 of full extension where the goat's rest at 0.815. The same
//  joint angles therefore leave its hooves in different places, and once the
//  body is raised so the deepest hoof meets the floor, the other three sit
//  above it:
//
//      toe.L        0.1205   on the floor
//      toe.R        0.2010   80 mm high      (69 mm at the shipped x0.858)
//      front_toe.L  0.1936   73 mm high
//      front_toe.R  0.1835   63 mm high
//
//  On the goat all four touch. This is what a retarget between two differently
//  proportioned animals costs, and the fix is a foot-planting IK pass over the
//  retargeted clip — solve each leg down to the floor through its own stance —
//  not a number changed here. Until that is written the ram runs a few
//  centimetres light. `measure: 'contact'` still reads it honestly, because it
//  clusters the planted hoof's velocity rather than assuming a height.
//
//  ── what the pack's walk cannot carry, named with its number ──────────────
//  The walk IS kept — duty 0.57 is a real stance and the best in this pack —
//  but its hooves do not hold one velocity while they are down. Stance velocity
//  by hoof, min .. median .. max, in model units per second:
//
//      toeL       -0.59 .. 1.15 .. 1.64        fore hooves ~17% faster than
//      toeR       -0.59 .. 1.16 .. 1.64        hind, and every hoof accelerates
//      front_toeL -0.86 .. 1.34 .. 1.92        through its own contact instead
//      front_toeR -0.86 .. 1.36 .. 1.92        of holding the ground's speed
//
//  There is no plateau, so `measureGround` finds its densest cluster at 1.607
//  — the TOP of that range, on only 13% of the samples — where the honest
//  average is about 1.26. The animal therefore walks some 25% faster than its
//  own hooves, a scuff the eye will not catch at the range a ram is seen from
//  but which is real and is the asset's, not this file's. The shipped deer's
//  kept walk has the same shape of error (cluster 0.818 on 13% of samples). The
//  fix is a walk solved against the floor in the .blend, not a number lowered
//  here — and the trot and the run beside it are exactly that, which is why
//  they read 63% and 16% cluster shares against the walk's 13%.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED at load.
// ─────────────────────────────────────────────────────────────────────────────

export const RAM = {
  key: 'ram',
  plural: 'Rams',

  glb: {
    url: '/models/ram_pack.glb',
    // Top of the head to hoof, with the head carried where the rest pose
    // carries it. `loadGlbSpecies` fits by the whole scene's bounding box,
    // which measures 1.6546 on the exported GLB, so 1.42 m is a fit of x0.858
    // — and the withers, at 1.110 in the .blend, land at 0.953 m. A big bighorn
    // ram stands 0.91-1.10 m at the shoulder.
    //
    // Measure the DIMENSION you are fitting by, not the one you are quoting:
    // the box top is the skull, and this animal carries its head high in the
    // rest pose, so a "height" read off the box is a good half-metre above the
    // number anybody would give for a sheep.
    height: 1.42,
    // The four hooves. Dots stripped by three's `GLTFLoader`, not by Blender —
    // `PropertyBinding.sanitizeNodeName` strips what its own animation-path
    // syntax reserves, and the GLB really does carry `toe.L`. A name that does
    // not resolve is SKIPPED, so getting this wrong reports as a facing fault.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Read this animal's speed from where its hooves actually touch rather than
    // from how far they swing. That is a claim about the ASSET: every paw of
    // every locomotion clip is genuinely planted for a sustained stretch, and
    // here it holds — duty 0.57 across the walk and a real, if brief, stance in
    // every beat of the leap. `measureExcursion` reads a hoof's total swing and
    // divides by the CYCLE, so it underreports by exactly the duty factor,
    // which at the run's 0.23 is more than four times too slow.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // Every `rate` here is 1.0, which is unusual in this cast and is not
      // laziness — it is what the clips came out at. `rate` is CADENCE and
      // nothing else, and all three of these are already at a believable one:
      // the pack's walk is 0.80 Hz and the solved trot 2.18 Hz, against a real
      // bighorn's roughly 0.8 and 2.4. The deer needs 1.7x because the pack
      // authored its walk at 0.78 Hz; this one did not.
      //
      // The run is the exception and it is deliberate: the clip is authored at
      // the goat leap's own 1.333 Hz and played at 2.0 for 2.67 leaps a second,
      // which is exactly what `mammals/goat.js` does with `Goat_Run`. Matching
      // the goat means matching how it is played, not only what is in it.
      walk: { name: 'walk', rate: 1.0 },
      trot: { name: 'trot', rate: 1.0 },
      run: { name: 'run', rate: 2.0 },
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // Scale only — see the header. Weights follow the yak's shape: the ordinary
  // animal commonest, a heavy old ram now and then.
  variants: [
    { name: 'ram', scale: 1.00, weight: 0.48 },
    { name: 'yearling', scale: 0.86, weight: 0.28 },
    { name: 'old ram', scale: 1.12, weight: 0.24 },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  // Strides of 1.78 / 1.28 / 2.80 m at a fit of x0.858, against a bighorn's
  // roughly 1.1 walking, 3.0 trotting and 9-13 flat out. The walk is the one
  // that reads high, and the block at the top of this file says why.
  gait: { walk: 1.379, trot: 2.789, run: 7.454 },

  brain: {
    // Even less bothered than the goat, and for the ram's own reason rather
    // than the yak's: a bighorn on a bench has the ground on its side and knows
    // it, so it looks up, it watches, and it goes back to what it was doing.
    // The freeze is long because a standing ram seen broadside — horns and all
    // — is the most legible thing on the mountain.
    alertDist: 26, fleeDist: 8, calmDist: 46, noticeDist: 60,
    hintDist: 88,
    freezeTime: [1.4, 3.2], fleeTime: [2.2, 4.5],
    grazeTime: [12, 30], idleTime: [4, 11], walkTime: [8, 20],
    // Herds a little tighter than the yak's did. Sheep band up; and a 0.95 m
    // animal at the yak's 10 m spacing reads as four animals that happen to be
    // near each other rather than as a band.
    herd: [2, 4], herdRadius: 8, wanderRadius: 30,
    grazeChance: 0.60,
    // See the goat's `rock` block for what each of these does. The differences
    // are the species, and they are the yak's differences unchanged: this
    // animal wants gentler ground than the goat (the benches and the aprons
    // rather than the crag face), it starts lower down the mountain, and it
    // climbs less often — a mountain goat is on the rock all day and a ram is
    // on it now and then.
    rock: {
      slopeMax: 1.05, slopeSoft: 0.75,
      // …and it wants the apron BESIDE the rock, so it reads the strongest rock
      // process within a cell of the point (32 m) instead of on it. That one
      // number is most of what separates the two species' ground: a ram on a
      // bench under a crag, a goat on the crag.
      altBand: [125, 195], rockGain: 1.70, slopeBest: [0.35, 0.72], nearCells: 1,
      // ── the one block the change of species genuinely moved ──────────────
      // The yak's plinth was authored around a 500 kg animal: "a yak hauling
      // itself onto a 3 m spire is not a thing, and a broad low block it can
      // simply step up onto is." A ram is 60-140 kg and a spire is exactly what
      // it hauls itself onto, so these are the goat's numbers now — a taller
      // ceiling on `rise`, a tighter `maxR`, and `steep` back up to 0.25 so the
      // flat slabs the yak was happy to stand on are rejected again.
      search: 48, minSize: 0.60, rise: [0.60, 3.00], maxR: 7.0, steep: 0.25,
      reach: 45, snap: 25,
      climbChance: 0.30, perchTime: [14, 40], orbit: 0.45,
    },
  },
};

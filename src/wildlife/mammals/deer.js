// ─────────────────────────────────────────────────────────────────────────────
//  deer — the animal the rest of the cast is measured against.
//
//  Now the bought pack's, with the locomotion solved on top. The mesh, rig and
//  weights are ithappy's (`assets/models/Animals_v3.0.blend`); the clips this
//  game needs and the pack does not ship correctly are solved onto that rig by
//  `tools/build_deer_blend.py`, which saves `assets/models/deer_pack.blend`.
//  `tools/export_pack_glb.py` turns that into `/models/deer_pack.glb`.
//
//  The `brain` block below is byte-for-byte the one the procedural deer used
//  and the hand-authored deer kept. Where an animal lives and what it minds
//  does not depend on who modelled it.
//
//  ── three meshes on one skeleton, which is what makes the variants real ───
//  The pack ships buck, doe and fawn as separate models. Measured, their three
//  armatures are IDENTICAL — same 33 bone names, every bone head in the same
//  place to four decimals — so the build re-parents all three onto one rig and
//  `hide` picks between them. Three genuinely different silhouettes, where the
//  hand-authored deer had one mesh and dropped its antlers, and where the free
//  pack gave one welded buck at four sizes.
//
//  What is lost against the hand-authored deer is the COAT: that asset was
//  built in regions with a material per region, so a morph was a recolour.
//  This is one textured palette material, so the variants carry no colour of
//  their own. A stag is a different mesh, not a darker doe.
//
//  ── the clips ─────────────────────────────────────────────────────────────
//    idle   331f  the pack's
//    graze  392f  the pack's `Gesture`, and a real graze — muzzle 1.430 -> 0.385
//    run     25f  the pack's; see `run` below
//    walk    18f  SOLVED here. The pack's own walk was dropped, and that is a
//                 measurement rather than a preference: duty per hoof
//                 0.25/0.30/0.23/0.10 where a walk is DEFINED by a duty over
//                 0.5, with the fore hooves travelling 0.52 over a cycle while
//                 the hind travel 0.63. No single ground speed exists in it.
//    trot    11f  SOLVED here — diagonal pairs, each hoof authored as a path
//                 over the ground and the leg solved to reach it.
//    alert  120f  authored here — head up, tail up, stiff left-then-right scan.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED at load.
// ─────────────────────────────────────────────────────────────────────────────

export const DEER = {
  key: 'deer',
  plural: 'Deer',

  glb: {
    url: '/models/deer_pack.glb',
    // Antler tip to hoof. `loadGlbSpecies` scales by the whole scene's bounding
    // box and the buck's rack is the tallest thing in it, so this is the BUCK's
    // full height and not the doe's.
    //
    // 1.579 is the number the hand-authored deer used, and it lands this animal
    // in exactly the same place: the pack buck's box is 1.892 with its withers
    // at 1.087, so the fit of 0.835 puts the withers at 0.907 against the
    // authored doe's measured 0.906. A drop-in replacement in the frame.
    height: 1.579,
    // The four hooves. Dots stripped by three's `GLTFLoader`, not by Blender —
    // `PropertyBinding.sanitizeNodeName` strips what its own animation-path
    // syntax reserves, and the GLB really does carry `toe.L`.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Read this animal's speed from where its hooves actually touch rather than
    // from how far they swing. That is a claim about the ASSET, and it is only
    // true because ALL THREE locomotion clips are solved here — nothing is
    // inherited from the pack, and each is validated to a planted hoof within
    // 0.001 mm of its authored path.
    //
    // It is also the difference between a deer and an amble. `measureExcursion`
    // reads a hoof's total swing and divides by the CYCLE, but a planted hoof
    // covers that ground during its STANCE — so excursion underreports by
    // exactly the duty factor. At a bound's duty of 0.20 that is five times too
    // slow, which is why the same clips read 0.62/1.11/1.70 on the excursion
    // path and 1.09/2.71/7.40 on this one.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // Solved. 18 frames is a 1.33 Hz cadence, inside the 1.0-1.8 Hz a walking
      // quadruped runs at. The sweep is a FINDING — the largest the legs carry
      // without clamping — and 6 cm of crouch is most of what buys it: at 2 cm
      // the solver returned 0.530 against a geometric maximum of 0.790.
      walk: { name: 'walk', rate: 1.0 },
      // Solved. 11 frames, 2.18 Hz, diagonal pairs.
      trot: { name: 'trot', rate: 1.0 },
      // A BOUND, not a gallop, because that is what a frightened white-tail
      // does: both hinds drive together, the body sails, both fores catch.
      // The pack's own run clip is dropped.
      //
      // DUTY is what makes it fast, and it is worth being clear that this is
      // not a trick. At 0.20 a hoof is down a fifth of the cycle, so the sweep
      // the leg can reach is spent five times faster than at a walk's duty and
      // the animal covers five times the ground per cycle. That is what a bound
      // IS. The legs never ask for more reach than they have — the solver
      // refuses a sweep that would clamp one.
      run: { name: 'run', rate: 1.0 },
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // Two meshes, one skeleton, `hide` picking between them. Weights follow the
  // hand-authored deer's: does commonest, a buck now and then.
  //
  // No fawn, and that is a measurement. The pack ships `Deer_Cub_01` and its
  // bones carry the same 33 NAMES, but its rest geometry does not match — max
  // bone-head delta 0.683, and 0.467 of the adult's total bone length. It is a
  // half-size rig, so a fawn mesh moved onto this skeleton is stretched to
  // adult proportions. Sharing a skeleton needs matching rest GEOMETRY; names
  // alone nearly let a stretched fawn into the valley. A fawn wants its own
  // build and its own GLB.
  variants: [
    { name: 'doe', scale: 1.00, weight: 0.50, hide: ['Deer_01'] },
    { name: 'yearling', scale: 0.87, weight: 0.24, hide: ['Deer_01'] },
    { name: 'buck', scale: 1.06, weight: 0.26, hide: ['Deer_Female_01'] },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  gait: { walk: 1.089, trot: 2.728, run: 7.716 },

  brain: {
    // The freeze is the whole sighting: a deer notices you a long way off,
    // stands and stares for a beat or two, and only then leaves.
    // `noticeDist` is the outer band, and it is a legibility number rather
    // than an ethology one. Measured off-road, the median closest approach a
    // player ever makes to a deer is 77 m; the encounter therefore has to be
    // readable well outside `alertDist`, and a frozen animal is not. From
    // 108 m in (which at 13 m/s means the deer reacts around 123 m of real
    // distance) it is up, broadside and moving. Deliberately short of the
    // 172 m spawn radius: a valley where every deer is already standing to
    // attention when it streams in has no grazing in it, and the head-down
    // pose is half the gift.
    // How far the stand point is walked toward the open side of an edge
    // site. Enough to clear the canopy and put meadow behind the animal
    // instead of shadow; not enough to strand a deer alone in the middle of
    // open ground, which reads as a spawner and throws away the edge
    // habitat the site was chosen for.
    standoff: 6.5,
    alertDist: 62, fleeDist: 28, calmDist: 95, noticeDist: 108,
    // ── the paw print on the compass ────────────────────────────────────
    // The outermost band, and the only one the player sees rather than the
    // animal. HUD.nearestHint pins a paw on the compass strip when an animal
    // is inside its own `hintDist`, which is set one step outside
    // `noticeDist` so the hint always arrives while the animal is still calm
    // and unaware — a hint that fires after the deer has already stood up is
    // reporting a thing you can see for yourself.
    //
    // Inside the 172 m spawn ring by a wide margin, which it has to be:
    // outside it there is no deer to pin. That is the real ceiling on this
    // number for every species, and it is why the squirrel's is so short.
    hintDist: 130,
    freezeTime: [1.0, 2.6], fleeTime: [3.5, 7.0],
    grazeTime: [6, 20], idleTime: [2.5, 7], walkTime: [4, 12],
    herd: [1, 4], herdRadius: 9, wanderRadius: 34,
    grazeChance: 0.55,
  },
};

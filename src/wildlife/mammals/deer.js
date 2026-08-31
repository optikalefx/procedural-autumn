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
    // NOT `measure: 'contact'`. It is a claim about the asset, and only two of
    // these four clips are solved here — the pack's own run has no sustained
    // stance to find, so there is no plateau and the answer would be an
    // artefact rather than merely imprecise. Excursion is wrong in the familiar
    // way for all of them instead.
    clips: {
      stand: { name: 'idle' },
      // Solved. 18 frames is a 1.33 Hz cadence, inside the 1.0-1.8 Hz a walking
      // quadruped runs at. The sweep is a FINDING — the largest the legs carry
      // without clamping — and 6 cm of crouch is most of what buys it: at 2 cm
      // the solver returned 0.530 against a geometric maximum of 0.790.
      walk: { name: 'walk', rate: 1.0 },
      // Solved. 11 frames, 2.18 Hz.
      trot: { name: 'trot', rate: 1.0 },
      // The pack's, and the one clip left unsolved on purpose. A bound gets
      // most of its ground from a ballistic flight phase, and the solver models
      // ground as a planted sweep — solving it would make it slower, not
      // faster. Rate raised to put the cadence where a fleeing deer's is.
      run: { name: 'run', rate: 1.9 },
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // Three meshes, one skeleton, `hide` picking between them. Weights follow the
  // hand-authored deer's: does commonest, a buck now and then, fawns with them.
  variants: [
    { name: 'doe', scale: 1.00, weight: 0.44, hide: ['Deer_01', 'Deer_Cub_01'] },
    { name: 'yearling', scale: 0.88, weight: 0.20, hide: ['Deer_01', 'Deer_Cub_01'] },
    { name: 'buck', scale: 1.06, weight: 0.22, hide: ['Deer_Female_01', 'Deer_Cub_01'] },
    { name: 'fawn', scale: 1.00, weight: 0.14, hide: ['Deer_01', 'Deer_Female_01'] },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  gait: { walk: 0.841, trot: 1.520, run: 1.850 },

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

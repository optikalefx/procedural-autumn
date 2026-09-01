// ─────────────────────────────────────────────────────────────────────────────
//  bear — the animal that makes the valley feel unsafe.
//
//  The bought pack's model with its locomotion solved on top. Mesh, rig and
//  weights are ithappy's (`assets/models/Animals_v3.0.blend`); the gaits and
//  the phased graze are solved onto that rig by `tools/build_bear_blend.py`,
//  which saves `assets/models/bear_pack.blend`, and `tools/export_pack_glb.py`
//  turns that into `/models/bear_pack.glb`.
//
//  The `brain` block below is byte-for-byte the hand-authored bear's. Where an
//  animal lives and what it minds does not depend on who modelled it.
//
//  ── two coats, and the pack handed them over ──────────────────────────────
//  `Bear_01` and `Bear_02` are both already parented to `Skeleton_Bear`, so
//  `hide` picks between them with no rig surgery — the deer needed re-parenting
//  for the same effect and the raccoon has no second mesh at all.
//
//  `Bear_Cub_01` is excluded: a different skeleton entirely, 32 bones against
//  40, names that do not match, 0.423 of the total length. A cub needs its own
//  build, exactly as the fawn does.
//
//  ── the clips ─────────────────────────────────────────────────────────────
//    idle    301f  the pack's
//    alert   115f  the pack's `Gesture`, and a better alert than anything that
//                  could be solved: the bear REARS, muzzle 0.516 -> 2.203 with
//                  its fore paws lifting to 0.613. Standing up to look is what
//                  a bear's alarm IS.
//    walk     16f  SOLVED. The pack's own walk was the best-planted clip in the
//                  whole pack — duty 0.61/0.61/0.64/0.61 — and was dropped
//                  anyway, because `measure: 'contact'` is a claim about EVERY
//                  moving clip and one inherited gait forfeits it for all three.
//    trot     11f  SOLVED, diagonal pairs.
//    run       9f  SOLVED as a bound. Duty 0.26 is what makes it fast.
//    graze  36/96/36  SOLVED, and PHASED — see `grazeIn` below.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED at load.
// ─────────────────────────────────────────────────────────────────────────────

export const BEAR = {
  key: 'bear',
  plural: 'Bears',

  glb: {
    url: '/models/bear_pack.glb',
    // Unchanged from the hand-authored bear, and deliberately: the valley's
    // bears stay the size of animal they have always been. The pack model's box
    // is 1.563, so the fit is 0.755 and every solved speed is multiplied by it —
    // which is why the gaits below are cadenced against the SHIPPED number
    // rather than the model's own units.
    height: 1.18,
    // The four paws. Dots stripped by three's `GLTFLoader`, not by Blender.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Earned: all three locomotion clips are solved here, each validated to a
    // planted paw within 0.001 mm of its authored path, so the claim that every
    // moving clip is genuinely planted actually holds.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // 16 frames is 1.50 Hz — a bear's heavy roll sits mid-band. Sweep 0.559,
      // duty 0.64.
      walk: { name: 'walk', rate: 1.0 },
      // 11 frames, 2.18 Hz. Sweep 0.648, duty 0.48.
      trot: { name: 'trot', rate: 1.0 },
      // The pack's own bounding lope, KEPT. Its duty of 0.42/0.36/0.33/0.08
      // is an animal in the air rather than a badly planted walk — the same
      // misreading that saw the deer's leap thrown away and rebuilt worse.
      // It covers 3.25 m of ground per cycle, measured by contact.
      //
      // 1.5x is cadence: 19 frames at 24 fps is 1.26 lopes a second, and this
      // lifts it to 1.9 for 6.15 m/s against a real black bear's 6.2.
      run: { name: 'run', rate: 1.5 },
      // The graze is authored in three phases, and declaring `grazeIn` and
      // `grazeOut` is what tells `GlbRig` to sequence them instead of
      // crossfading straight to the loop — the Brain holds a graze for a
      // variable 10-26 s, and a single long clip would raise the head every
      // time it repeated. They meet exactly: measured, all five joins are
      // within 0.001 mm and `graze_out` ends on the rest pose, which the
      // sequencer parks on as its idle carrier.
      graze: { name: 'graze' },
      grazeIn: { name: 'graze_in' },
      grazeOut: { name: 'graze_out' },
      alert: { name: 'alert' },
    },
  },

  // Two meshes on one skeleton. The pack's own second bear is a darker coat, so
  // this is a real morph rather than a recolour of one — which is as well,
  // because a textured palette material has no per-region colour to push.
  variants: [
    { name: 'black', scale: 1.00, weight: 0.52, hide: ['Bear_02'] },
    { name: 'cinnamon', scale: 0.96, weight: 0.30, hide: ['Bear_01'] },
    { name: 'big boar', scale: 1.12, weight: 0.18, hide: ['Bear_02'] },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`.
  gait: { walk: 0.940, trot: 2.096, run: 6.148 },

  brain: {
    // A bear mostly does not care that you exist. It looks up when you get
    // close, and only leaves if you get closer than that.
    // A bear does not spook, but it does stop and look, and a bear that has
    // stopped and turned side-on is the most legible animal in the game.
    // A bear is big enough to read anyway, and it patrols a river line where
    // the far bank is already the backdrop, so it needs less of a nudge.
    standoff: 4.0,
    alertDist: 24, fleeDist: 11, calmDist: 44, noticeDist: 66,
    // A bear lets you get far closer than a deer before it minds, so its
    // hint band is shorter in absolute metres while sitting the same one
    // step outside `noticeDist`. See the deer's note.
    hintDist: 79,
    freezeTime: [1.4, 3.0], fleeTime: [2.5, 5.0],
    grazeTime: [10, 26], idleTime: [3, 9], walkTime: [10, 30],
    herd: [1, 1], herdRadius: 0, wanderRadius: 60,
    grazeChance: 0.5, patrol: true,
  },
};

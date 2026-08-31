// ─────────────────────────────────────────────────────────────────────────────
//  raccoon — the nocturnal one, identified by markings not by shape.
//
//  This was a blueprint: profile arrays that `quadruped.js` lofted into a
//  skeleton, with the gait solved against the ground every frame. It is now a
//  bought model and six clips played by three's `AnimationMixer`
//  (`../glb_rig.js`) — the pack's own mesh, rig and weights, with the two clips
//  this game needs and the pack does not ship SOLVED onto that rig by
//  `tools/build_raccoon_blend.py`.
//
//  So this file carries no blueprint and no coat geometry any more. What it
//  does carry is everything true about the ANIMAL rather than about how it is
//  drawn, and none of that changed when the model did: the `brain` block below
//  is byte-for-byte the one the procedural raccoon used.
//
//  ── what the pack gave and what was built on top ──────────────────────────
//    idle    289f   the pack's
//    walk     19f   the pack's — duty 0.53/0.47/0.47/0.53, a genuine walk
//    run      15f   the pack's
//    graze   110f   the pack's `Gesture`, remapped and not compromised: it
//                   rears onto the haunches and works the front paws, which is
//                   exactly what `grazeChance: 0.70` is asking to see
//    trot      9f   SOLVED here — diagonal pairs, each paw authored as a path
//                   over the ground and the leg solved to reach it
//    alert    96f   SOLVED here — low, stiff, head up and turning
//
//  ── what was given up, and it is real ─────────────────────────────────────
//  The procedural raccoon had four lofted coat variants driven through the
//  hide shader (`coat`/`pale`/`dark`/`spot` per morph). The pack is one mesh
//  with one textured material, so the variants below are size only. The mask
//  and the ringed tail are in the texture rather than in the geometry, which
//  is why they no longer vary — a real loss, traded for a model that reads as
//  a raccoon at 8 m instead of a lofted approximation of one.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are MEASURED off the clips
//  at load and written back onto this record.
// ─────────────────────────────────────────────────────────────────────────────

export const RACCOON = {
  key: 'raccoon',
  plural: 'Raccoons',

  glb: {
    url: '/models/raccoon_pack.glb',
    // Nose to tail-tip is 0.857 units and the model stands 0.383 tall, authored
    // at one unit to the metre. `loadGlbSpecies` scales by the whole bounding
    // box, so this is the HEIGHT of that box — a raccoon's back at about
    // 0.38 m, which is right for the animal.
    height: 0.383,
    // The four contact bones. Dots stripped, and by three's `GLTFLoader` rather
    // than by Blender: the GLB really does carry `toe.L`, and
    // `PropertyBinding.sanitizeNodeName` renames it on the way in.
    //
    // Note the fore and hind names are NOT symmetrical. This rig's fore leg has
    // no `foot` bone at all — it runs shoulder/thigh/shin/toe where the hind
    // runs shoulder/thigh/shin/foot/toe — so the fore contact is the toe and
    // the hind contact is the toe one link further down.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Read this animal's speed from where its paws touch rather than from how
    // far they swing. A claim about the ASSET, and true because ALL THREE
    // locomotion clips are solved here — each validated to a planted paw within
    // 0.001 mm of its authored path.
    //
    // The pack's own walk was good (duty 0.47-0.53, a genuine walk, unlike the
    // deer's) and was still dropped: contact is a claim about EVERY moving
    // clip, so one inherited gait would force the whole species back onto
    // excursion — which divides a paw's swing by the CYCLE when the paw covers
    // that ground during its STANCE, and so underreports by the duty factor.
    measure: 'contact',
    clips: {
      stand: { name: 'idle' },
      // All three solved. The sweep is a FINDING — the largest one no leg has
      // to clamp for — and crouch is what buys it: measured on the two IK links
      // alone this fore leg stands at 0.94 of its own reach, so at standing
      // height there is nothing left to swing with.
      walk: { name: 'walk', rate: 1.0 },
      trot: { name: 'trot', rate: 1.0 },
      // A bounding lope, which is how a raccoon actually flees. DUTY is what
      // makes it fast, not a raised rate: at 0.22 the paw is down a fifth of
      // the cycle, so the same reach is spent three times faster than at a
      // walk's duty. Sweeps of 0.251 / 0.299 / 0.324 give 0.72 / 1.77 / 5.05.
      run: { name: 'run', rate: 1.0 },
      // The pack's `Gesture`. Not phased — there is no authored entry and exit,
      // so `GlbRig` takes the plain damped crossfade, which is right for a clip
      // that starts and ends on its own feet.
      graze: { name: 'graze' },
      alert: { name: 'alert' },
    },
  },

  // Size only. See the header: one mesh, one textured material, so there is no
  // per-region colour to push and the mask is painted rather than lofted.
  variants: [
    { name: 'grey', scale: 1.00, weight: 0.56 },
    { name: 'brown', scale: 0.95, weight: 0.27 },
    { name: 'silver', scale: 1.04, weight: 0.17 },
  ],

  // Measured off the clips at load by `loadGlbSpecies` and written back here;
  // these are what the current asset reports, kept so a regression shows in a
  // diff. Editing them changes nothing.
  gait: { walk: 0.383, trot: 0.657, run: 1.283 },

  brain: {
    // Bolder than the rabbit and far bolder than the squirrel: a raccoon
    // notices you, stops, and looks at you for a beat before it decides to
    // leave. That stare is the sighting, and it is the reason the freeze is
    // nearly the deer's despite the animal being a fifth of the size.
    standoff: 0,
    alertDist: 34, fleeDist: 15, calmDist: 52,
    // No `noticeDist`: at 0.4 m and at night the wary-watch beat outside
    // 34 m would be animation nobody can resolve.
    // Inside the 92 m spawn ring with room, and short for the squirrel's
    // reason — but not as short, because a raccoon at night is a thing the
    // player will actually turn the camper around for.
    hintDist: 62,
    freezeTime: [0.8, 2.2], fleeTime: [2.0, 4.2],
    grazeTime: [5, 15], idleTime: [1.5, 5], walkTime: [3, 9],
    // A family party rather than a herd or a solitary animal.
    herd: [1, 3], herdRadius: 5, wanderRadius: 16,
    // Nose down almost all the time — foraging IS the raccoon pose.
    grazeChance: 0.70,
  },
};

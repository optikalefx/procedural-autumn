// ─────────────────────────────────────────────────────────────────────────────
//  bear — the big one, now hand-authored.
//
//  This was a blueprint: profile arrays that `quadruped.js` lofted into a
//  skeleton, with the gait solved against the ground every frame. It is now a
//  mesh and eight clips modelled and animated by hand in Blender
//  (`assets/models/bear.blend`, built by `tools/build_bear_reference.py`),
//  exported to one GLB and played back by three's `AnimationMixer`
//  (`../glb_rig.js`). The fox went first; this is the second animal on that
//  track.
//
//  So this file carries no blueprint and no coat geometry any more. What it
//  does carry is everything that is true about the ANIMAL rather than about
//  how it is drawn — where it lives, what it minds, how far off it notices
//  you — and none of that changed when the model did. The `brain` block below
//  is byte-for-byte the one the procedural bear used.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are not authored here —
//  they are MEASURED off the clips at load and written back onto this record,
//  because how far a bear travels has to be whatever its legs actually do.
// ─────────────────────────────────────────────────────────────────────────────

export const BEAR = {
  key: 'bear',
  plural: 'Bears',

  // ── the asset ──────────────────────────────────────────────────────────────
  // The presence of this block is what puts the species on the hand-authored
  // track; `Wildlife` picks its backend off it and branches nowhere else.
  glb: {
    url: '/models/bear_reference.glb',
    // Hump to paw, in metres — on a bear the shoulder hump is the highest
    // point, not the ears. Chosen to stand exactly where the animal it
    // replaced stood: the procedural blueprint's barrel topped out at
    // max(y + ry) = 1.185 m at the hump, so the valley's bears are the same
    // size of animal they were before the model changed.
    height: 1.18,
    // The bones `measureStride` samples to find how much ground a cycle
    // covers. Blender's exporter strips the dots, so `hind_foot.L` is
    // `hind_footL` here.
    feet: ['fore_footL', 'fore_footR', 'hind_footL', 'hind_footR'],
    clips: {
      // `rate` is a playback speed and NOT an edit: every pose the bear
      // strikes is a pose that is in the .blend. A clip with no `rate` is a
      // pose clip — it covers no ground, so it is neither measured nor
      // rate-driven.
      //
      stand: { name: 'idle' },
      // Authored at one stride per 48 frames, which at 24 fps is 0.50 Hz; a
      // walking quadruped runs 1.0-1.8 Hz and a bear's heavy rolling walk sits
      // at the bottom of that. 2x puts it at exactly 1.0 Hz. This is a
      // judgement about cadence and nothing else — raise it and the bear
      // covers ground faster in exact proportion.
      walk: { name: 'Walk', rate: 2.0 },
      // One diagonal-pair stride over 16 frames — 1.5 Hz as authored, already
      // a real trotting cadence. 1.3x lifts it to 1.95 Hz, which is what keeps
      // the trot clear of the walk on the speed ladder below; much more and
      // the artist's timing is the thing being undone.
      trot: { name: 'Trot', rate: 1.3 },
      // Three paired-foot gallop strides in one two-second clip, so the
      // sampled paw reach is ONE of them and ground speed over the full
      // duration has to count all three or the bear travels at a third of what
      // its legs are doing.
      run: { name: 'run', rate: 1.25, strides: 3 },
      // The graze is authored in three phases, and declaring `grazeIn` and
      // `grazeOut` is what tells `GlbRig` to sequence them instead of
      // crossfading straight to the loop. The .blend is explicit about this:
      // each clip carries a `next_action` naming the one after it, because the
      // brain holds a graze for a variable number of seconds and a single long
      // clip would raise the head every time it repeated.
      //
      // They are pose clips, not cycles — they cover no ground, so they are
      // neither measured nor rate-driven — and they meet the loop exactly:
      // `graze_in`'s last frame IS `graze`'s first, and `graze_out` starts on
      // that same pose and ends on the exact idle rest.
      graze: { name: 'graze' },
      grazeIn: { name: 'graze_in' },
      grazeOut: { name: 'graze_out' },
      alert: { name: 'alert' },
    },
  },

  // ── the coats ──────────────────────────────────────────────────────────────
  // The asset ships untextured — every material is a flat baseColorFactor — so
  // a morph is a recolour of the same mesh rather than a second export.
  //
  // Colours are LINEAR triples, keyed by Blender material name, because that is
  // the space glTF stores `baseColorFactor` in and the space `GLTFLoader` hands
  // three. Writing them as sRGB hex here would silently shift every morph.
  //
  // ── why these are no longer the light browns the blueprint wore ───────────
  // The procedural bear's coat was deliberately authored far lighter than a
  // black bear, because the hide shader floors a shaded surface at
  // `uStyleFloor` of the key and a genuinely black hide came out as a hole
  // with nothing left to multiply. That was a fix for a shader this track does
  // not use: the GLB wears the materials Blender authored, lit as ordinary
  // surfaces, so the coat can be the black-brown a black bear actually is.
  //
  // The trade the hand-authored track makes in return is real and known: it
  // gets no `uSilNear/uSilFar` silhouette collapse, so past ~70 m a bear reads
  // brighter and more detailed than the procedural cast around it. Judge it in
  // `glblook.mjs`'s `range_*` frames.
  //
  // `boar` names no colours at all, and that is deliberate: the commonest coat
  // wears the material exactly as Blender authored it, uncloned, which is the
  // whole promise of this track and one less program to compile.
  variants: [
    { name: 'boar', scale: 1.08, weight: 0.45 },
    // A shade browner and a touch lighter than the boar — the same animal, not
    // a different species.
    { name: 'sow', scale: 0.96, weight: 0.40,
      col: {
        'Bear black-brown coat': [0.026, 0.023, 0.021],
        'Bear warm muzzle': [0.060, 0.045, 0.035],
        'Bear charcoal': [0.010, 0.008, 0.006],
      } },
    // The cinnamon morph, which is a real and locally common colour phase of
    // the American black bear rather than a stylisation — a warm mid-brown
    // that reads as a different animal at a glance and is the same one.
    { name: 'cinnamon', scale: 1.00, weight: 0.15,
      col: {
        'Bear black-brown coat': [0.105, 0.050, 0.026],
        'Bear warm muzzle': [0.165, 0.100, 0.055],
        'Bear charcoal': [0.030, 0.018, 0.010],
      } },
  ],

  // ── the gait ───────────────────────────────────────────────────────────────
  // **Written at load, not authored.** `loadGlbSpecies` measures how much
  // ground one cycle of each clip covers and puts the answer here, so the Brain
  // steers at speeds the clips can actually carry and the paws never slide.
  // The numbers below are what the current asset measures, recorded so a
  // regression is visible in a diff — they are overwritten every boot, and
  // editing them changes nothing.
  //
  // They are also the standing finding for this animal. A black bear walks at
  // about 1.05 m/s, trots at 2.6 and gallops at 6.2 — which is exactly what the
  // procedural bear was authored to do, because there the stride was a number
  // in a file. Here it is whatever the .blend contains, and the .blend contains
  // strides of 30.6 cm per 2.00 s walk cycle, 25.8 cm per 0.67 s trot and
  // 52.4 cm x3 per 2.00 s gallop. At honest cadences that is a bear moving at
  // roughly a third of a real walk and a seventh of a real gallop.
  //
  // Every one of those is a stride to WIDEN IN BLENDER, and explicitly not a
  // rate to raise here: at 3.2x the walk clip would be a bear sprinting its
  // legs to amble, and the rate clamp in `glb_rig.js` would be carrying the
  // difference. See CLAUDE.md.
  gait: { walk: 0.306, trot: 0.503, run: 0.983 },

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

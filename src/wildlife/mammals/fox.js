// ─────────────────────────────────────────────────────────────────────────────
//  fox — the brush and the ears, and not much else at range.
//
//  The first hand-authored animal in the valley. Every other mammal here is a
//  blueprint — profile arrays that `quadruped.js` lofts into a skeleton, with
//  the gait solved against the ground every frame. This one is a mesh modelled
//  by hand in Blender, exported to one GLB and played back by three's
//  `AnimationMixer` (`../glb_rig.js`).
//
//  The MESH is ours and the CLIPS are not, which makes this animal the only
//  one in the cast with two sources. Five of its six clips are the bought
//  pack's own fox animations, retargeted onto our skeleton by
//  `tools/retarget_fox_from_pack.py` — that script reads the tracked
//  `assets/models/fox_reference.blend` (mesh, rig, weights, and the artist's
//  original clips) plus the pack, and writes the derived `fox_packanim.blend`
//  the shipped GLB is exported from. `alert` is still the artist's own.
//
//  Nothing about the model changed in that swap. It is worth saying plainly
//  because the filename does not: `fox_packanim.glb` is OUR fox wearing the
//  pack's motion, not a pack animal.
//
//  So this file carries no blueprint and no coat geometry. What it does carry
//  is everything that is true about the ANIMAL rather than about how it is
//  drawn — where it lives, what it is frightened of, how far off it notices
//  you — because none of that changed when the model did, and none of it
//  belongs in a .blend.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are not authored here —
//  they are MEASURED off the clips at load and written back onto this record,
//  because how far a fox travels has to be whatever its legs actually do.
// ─────────────────────────────────────────────────────────────────────────────

export const FOX = {
  key: 'fox',
  plural: 'Foxes',

  // ── the asset ──────────────────────────────────────────────────────────────
  // The presence of this block is what puts the species on the hand-authored
  // track; `Wildlife` picks its backend off it and branches nowhere else.
  glb: {
    url: '/models/fox_packanim.glb',
    // Ear-tip to paw, in metres. Chosen to stand beside the rest of the cast
    // rather than against a tape measure: the procedural fox carried its head
    // at y=0.496 with the ears above that, so a hair over 0.6 puts this one
    // shoulder to shoulder with the animal it replaced.
    height: 0.62,
    // The bones `measureStride` samples to find how much ground a cycle covers.
    // Blender's exporter strips the dots, so `hind_foot.L` is `hind_footL` here.
    feet: ['fore_footL', 'fore_footR', 'hind_footL', 'hind_footR'],
    // No `measure: 'contact'` here, and that is a finding rather than an
    // oversight. Run `tools/_scratch/_glbground.mjs` over this asset and Walk
    // and Trot report their densest velocity cluster at +3.44 u/s on a 9% share
    // — forwards, and on a twentieth of the frames — which is the arithmetic
    // failing to find a stance rather than a stance that runs backwards. The
    // paws themselves are planted and travel the right way; that IS checked, by
    // the signed stance test the retarget script prints. This species keeps the
    // excursion measurement, which reads all six clips without complaint.
    //
    // The cause is the rig, and it is the standing finding for this animal.
    // Its hind limb is 1.305 of bone spanning a 1.305 drop from hip to paw and
    // its fore limb 1.201 spanning 1.201 — both legs are straight columns at
    // rest, at 1.000 and 0.992 of their own reach against the bear's 0.971 —
    // where a canid holds about 28% of its hind limb folded in the hock. There
    // is no slack for a gait to spend, so a stance cannot hold still while the
    // body travels over it, and nothing downstream of the .blend can add any:
    // stifle IK clamps on the first frame, and the pastern trick that puts the
    // paws on the ground is a plant, not a leg that bends. The fix is to bend
    // the stifle and hock in the REST pose and re-bind. See CLAUDE.md.
    clips: {
      // `rate` is a playback speed and NOT an edit: every pose the fox strikes
      // is a pose that is in the .blend. A clip with no `rate` is a pose clip —
      // it covers no ground, so it is neither measured nor rate-driven.
      stand: { name: 'Stand' },
      // 1x, and that is the point of the number. The pack animator keyed this
      // cycle at 0.833 s — 1.2 Hz, squarely inside the 1.0-1.8 Hz a walking
      // quadruped runs at — so there is no cadence left to fix. Our own Walk
      // needed 2.2x because it was keyed slow; this one does not.
      walk: { name: 'Walk', rate: 1.0 },
      // The trot is the WALK CLIP AGAIN, exported as its own action and played
      // at 1.4x — 1.7 Hz and 56 cm/s. The pack has no trot and no animal in it
      // does, and the hand-authored Trot this replaced covered 16.6 cm against
      // the retargeted Walk's 33.5, so the fox trotted slower than it walked
      // and the ladder in `glb_rig` inverted.
      //
      // The honest cost: these are a walk's footfalls (lateral, duty 0.55) run
      // fast, not a trot's diagonal pairs. At the 12-40 px this animal is
      // usually seen at that is invisible; in a photo it is a fast walk. A real
      // trot is a clip to author, and `add-new-animation-to-glb` is the recipe.
      trot: { name: 'Trot', rate: 1.4 },
      // ONE stride per cycle, where our old run packed three into two seconds —
      // so no `strides` count, and leaving the old 3 here would have divided
      // the measured ground by three and made the fox gallop at a crawl.
      // 1.3x takes the authored 1.33 strides/s to 1.73, which spaces the ladder
      // (0.40 / 0.56 / 0.84) and is still short of a real fox.
      run: { name: 'run', rate: 1.3 },
      graze: { name: 'graze' },
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
  // `red` names no colours at all, and that is deliberate: the base coat wears
  // the material exactly as Blender authored it, which is the whole promise of
  // this track. The other two are the same coat pushed by the ratios the
  // procedural fox's morphs used, so the cross fox stays as much darker than a
  // red fox as it always was.
  variants: [
    { name: 'red', scale: 1.00, weight: 0.62 },
    // A cross fox — the dark morph, smoky over the shoulders.
    { name: 'cross', scale: 1.04, weight: 0.22,
      col: {
        'Fox russet': [0.213, 0.060, 0.022],
        'Fox white belly': [0.682, 0.659, 0.615],
        'Fox white tail tip': [0.707, 0.643, 0.492],
        'Fox charcoal': [0.018, 0.014, 0.011],
      } },
    { name: 'pale', scale: 0.96, weight: 0.16,
      col: {
        'Fox russet': [0.621, 0.157, 0.037],
        'Fox white belly': [0.902, 0.914, 0.921],
        'Fox white tail tip': [0.934, 0.892, 0.736],
        'Fox charcoal': [0.040, 0.028, 0.017],
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
  // These are what the current asset measures. A red fox walks at about
  // 0.85 m/s and gallops at 10, so this animal is still slow — but it is no
  // longer the outlier it was. The pack's clips cover Walk 33.5 cm per 0.83 s
  // cycle and run 48.3 cm per 0.75 s, against the hand-authored 7.6 cm per
  // 2.00 s and 25.1 cm x3 they replaced: a 4.8x on the walk and a 2.2x on the
  // gallop, all of it stride and cadence the artist keyed rather than anything
  // raised here.
  //
  // What is left is a stride to widen in the .blend and NOT a number to raise
  // in this file — faking it in code puts the paws back to skating over the
  // ground, which is the one thing measuring the clips buys. See CLAUDE.md.
  gait: { walk: 0.402, trot: 0.563, run: 0.837 },

  brain: {
    // Between the deer's beats and the rabbit's: a fox notices you early,
    // gives you the flat stare — that stop-and-look is the whole sighting —
    // and then flows away at a trot rather than bolting. Short freezes and
    // long watch band; the animal should be moving for most of the encounter.
    standoff: 4.5,
    alertDist: 50, fleeDist: 22, calmDist: 76, noticeDist: 86,
    // One step outside `noticeDist`, and comfortably inside the 140 m spawn
    // ring. See the deer's note.
    hintDist: 103,
    freezeTime: [0.7, 1.8], fleeTime: [3.0, 6.0],
    grazeTime: [5, 14], idleTime: [2, 6], walkTime: [4, 10],
    // Solitary, almost always. A pair is a treat.
    herd: [1, 2], herdRadius: 6, wanderRadius: 30,
    grazeChance: 0.5,
  },
};

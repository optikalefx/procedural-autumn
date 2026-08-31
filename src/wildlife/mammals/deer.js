// ─────────────────────────────────────────────────────────────────────────────
//  deer — the animal the rest of the cast is measured against, now
//  hand-authored.
//
//  This was a blueprint: profile arrays that `quadruped.js` lofted into a
//  skeleton, with the gait solved against the ground every frame. It is now a
//  mesh and eight clips modelled and animated in Blender
//  (`assets/models/new_deer.blend`, built by `tools/build_new_deer.py`),
//  exported to one GLB and played back by three's `AnimationMixer`
//  (`../glb_rig.js`). The fox went first, then the bear; this is the third
//  animal on that track.
//
//  So this file carries no blueprint and no coat geometry any more. What it
//  does carry is everything true about the ANIMAL rather than about how it is
//  drawn — where it lives, what it minds, how far off it notices you — and
//  none of that changed when the model did. The `brain` block below is
//  byte-for-byte the one the procedural deer used.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only. The gait speeds below are not authored here —
//  they are MEASURED off the clips at load and written back onto this record,
//  because how far a deer travels has to be whatever its legs actually do.
//
//  ── the size changed, deliberately ────────────────────────────────────────
//  The procedural deer stood 1.821 m to the ear tips before variant scale, so
//  a doe rendered at 1.71 m — elk proportions, and taller than the bear beside
//  it at 1.18 m, which is backwards for a white-tail. The hand-authored model
//  is built at TRUE SCALE, one Blender unit to the metre, and measures 0.906 m
//  at the withers. Every deer in the valley is therefore about a fifth smaller
//  than it was, and correct against the rest of the cast for the first time.
// ─────────────────────────────────────────────────────────────────────────────

export const DEER = {
  key: 'deer',
  // How the logbook names the species ("Deer seen"). Carried here rather
  // than in the UI so a new species arrives in the logbook the moment it
  // exists — the one thing a table walk cannot derive is an English plural.
  plural: 'Deer',

  // ── the asset ──────────────────────────────────────────────────────────────
  // The presence of this block is what puts the species on the hand-authored
  // track; `Wildlife` picks its backend off it and branches nowhere else.
  glb: {
    url: '/models/new_deer.glb',
    // The whole model's height in metres, antler tips to hoof — NOT the ear
    // tip, and not the withers. `loadGlbSpecies` scales by the scene's entire
    // bounding box, and the stag's rack is the tallest thing in it, so quoting
    // the doe's 1.360 here would shrink every animal by the height of a rack
    // she is not wearing. The build prints this number as `DOE_HEIGHT full=`.
    //
    // The model is authored at one unit per metre, so this makes the fit
    // exactly 1.0 and the doe stands at her measured 0.906 m withers.
    height: 1.579,
    // The points that touch the ground, which `measureGround` samples to read
    // how fast the ground moves under the animal. These are the four
    // zero-weight toe bones, whose ORIGINS sit exactly on the hooves — a deer
    // is unguligrade, so the hoof is genuinely stationary through a stance
    // while the fetlock above it rolls forward over the contact point.
    // Blender's exporter strips the dots, so `fore_toe.L` is `fore_toeL`.
    feet: ['fore_toeL', 'fore_toeR', 'hind_toeL', 'hind_toeR'],
    // Read this animal's speed from where its hooves actually touch rather
    // than from how far they swing. That is a claim about the ASSET: all three
    // locomotion clips are solved against the ground by `animal_kit`'s gait
    // solver, and the measured stance duty comes back within 0.02 of what each
    // clip was authored at. The fox has no such claim to make.
    measure: 'contact',
    clips: {
      // `rate` is a playback speed and NEVER an edit: every pose the deer
      // strikes is a pose that is in the .blend. A clip with no `rate` is a
      // pose clip — it covers no ground, so it is neither measured nor
      // rate-driven.
      stand: { name: 'idle' },
      // One lateral-sequence stride per 36 frames — 0.67 Hz as authored, which
      // 2.0x lifts to 1.33 Hz. A walking quadruped runs 1.0-1.8 Hz.
      walk: { name: 'walk', rate: 2.0 },
      // One diagonal-pair stride per 18 frames, 1.33 Hz, doubled to 2.67 Hz —
      // a real trotting cadence for a deer.
      trot: { name: 'trot', rate: 2.0 },
      // A BOUND, not a gallop, because that is what a frightened white-tail
      // does: both hinds drive together, the body sails, both fores catch.
      // The loader measures the leap at 5.08 m of ground, so 2.35x — 2.35
      // bounds a second — puts her at 11.9 m/s, which is 43 km/h and a real
      // fleeing deer. The speed is bought with the length of the leap, not by
      // winding the playback up.
      //
      // This clip is also why `measureGround` now gates on contact. A bound is
      // on the ground 12% of the time, and its long flight holds a steadier
      // velocity than its brief stance does — so the swing formed the bigger
      // velocity cluster, the answer came back negative, and the loader
      // rejected the asset. See the note there.
      run: { name: 'run', rate: 2.35 },
      // The graze is authored in three phases, and declaring `grazeIn` and
      // `grazeOut` is what tells `GlbRig` to sequence them instead of
      // crossfading straight to the loop — the Brain holds a graze for a
      // variable number of seconds, and a single long clip would raise the
      // head every time it repeated. They meet exactly: `graze_in`'s last
      // frame IS `graze`'s first, and `graze_out` ends on the exact idle rest.
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
  // Colours are LINEAR triples keyed by Blender material name, because that is
  // the space glTF stores `baseColorFactor` in and the space `GLTFLoader`
  // hands three. Writing them as sRGB hex here would silently shift every one.
  //
  // `hide` is what makes the stag possible without a second asset: the rack is
  // one object carrying its own material, so the three antlerless coats drop
  // it and the whole cast still shares one mesh, one skeleton and one set of
  // clips. The doe names no colours at all — the commonest coat wears the
  // material exactly as Blender authored it, uncloned, which is the whole
  // promise of this track and one less shader to compile.
  variants: [
    { name: 'doe', scale: 1.0, weight: 0.46, hide: ['Doe antlers'] },
    { name: 'yearling', scale: 0.85, weight: 0.26, hide: ['Doe antlers'],
      col: {
        'Doe coat': [0.5271, 0.2542, 0.1119],
        'Doe white': [0.9216, 0.8963, 0.8550],
        'Doe dark': [0.0252, 0.0203, 0.0176],
      } },
    // The one coat that wears the rack. Bigger and darker than a doe, which is
    // what a mature buck is.
    { name: 'stag', scale: 1.12, weight: 0.20,
      col: {
        'Doe coat': [0.2705, 0.1144, 0.0395],
        'Doe white': [0.8469, 0.7991, 0.7305],
        'Doe dark': [0.0152, 0.0123, 0.0103],
        'Doe horn': [0.3515, 0.2623, 0.1384],
      } },
    { name: 'dark doe', scale: 1.03, weight: 0.08, hide: ['Doe antlers'],
      col: {
        'Doe coat': [0.2542, 0.1070, 0.0409],
        'Doe white': [0.8070, 0.7605, 0.6867],
        'Doe dark': [0.0144, 0.0116, 0.0097],
      } },
  ],

  // Measured off the clips at load and written back here by `loadGlbSpecies`;
  // these are the values it last produced, kept so the record reads honestly
  // before the asset has been fetched.
  gait: { walk: 1.150, trot: 3.481, run: 11.934 },

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

// ─────────────────────────────────────────────────────────────────────────────
//  dog — the camp dog. Deliberately NOT one of the wild species.
//
//  This was a blueprint: profile arrays that `quadruped.js` lofted into a
//  skeleton, with the gait solved against the ground every frame and three REST
//  POSES authored as per-bone rotations in `camp_dog.js` and blended over the
//  solver's output. It is now the bought pack's dog and seven clips played by
//  three's `AnimationMixer` (`../glb_rig.js`), built by
//  `tools/build_dog_blend.py`.
//
//  ── what the pack gave and what was built on top ──────────────────────────
//    idle    290f   the pack's, and it is not a statue: the head comes down to
//                   0.334 and back up to 0.689 over the cycle, so a standing
//                   camp dog looks around and sniffs without any help
//    walk     31f   the pack's
//    run      18f   the pack's — never played, see `gait` below
//    gesture 222f   the pack's, and NOT wired up: head to 0.853 with a forepaw
//                   lifted to 0.224, which is a dog greeting somebody. It is
//                   neither a graze nor an alert, and `camp_dog.js` has no
//                   state that would play it. Carried in the GLB so the next
//                   person has it; costed and accepted.
//    sit      50f   RETARGETED from the pack's own `Cat_Sit` — the only sit in
//                   all 233 of its actions, and a real one
//    lie      96f   AUTHORED, out of the sit: a sphinx-lie is a sit with the
//                   front end let down
//    curl     96f   AUTHORED, out of the lie: the comma
//
//  ── what changed for the player, and what did not ─────────────────────────
//  The three rest poses were the whole reason `camp_dog.js` had a poser at all,
//  and they are clips now: authored in Blender, where they can be looked at,
//  instead of as ~40 signed bone rotations that could only be judged by running
//  the game. Each is a loopable hold with the animal breathing on it, so a dog
//  asleep by the fire for 26-75 s is not a still frame.
//
//  What was given up is the coat: the procedural dog lofted `coat`/`pale`/`dark`
//  per morph through the hide shader, and the pack's dog is one textured
//  material read six ways. So the three variants below are three of the pack's
//  own painted dogs picked by `hide`, not three washes of one. A real loss of
//  range, traded for a dog that reads as a dog at three metres.
//
//  The rule that governs the asset is in CLAUDE.md and it is absolute: a GLB's
//  animations are read-only.
// ─────────────────────────────────────────────────────────────────────────────
import { loadGlbSpecies } from '../glb_rig.js';

// The six painted dogs the pack ships. All six ride `Skeleton_Dog` already and
// all six are in the GLB; a variant wears one and hides the other five, the way
// the deer's does/fawn share one skeleton. Named by what they look like rather
// than by their index, because `Dog_04` tells nobody it is the white one.
const COATS = ['Dog_01', 'Dog_02', 'Dog_03', 'Dog_04', 'Dog_05', 'Dog_06'];
const wear = (name) => COATS.filter((m) => m !== name);

export const DOG_SPECIES = {
  key: 'dog',

  glb: {
    url: '/models/dog_pack.glb',
    // The model's whole bounding box, ear tips to paws, is 0.8374 units with
    // the withers at 0.505 of it — so this number puts the withers at 0.50 m,
    // which is the medium mongrel the reference photographs are of and the same
    // height the blueprint this replaces was drawn to.
    height: 0.83,
    // The four contact bones. Dots stripped by three's `GLTFLoader` on the way
    // in — the GLB really does carry `toe.L`.
    feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
    // Excursion, NOT contact, and deliberately: `measure: 'contact'` is a claim
    // that every moving clip has a genuinely planted paw, which is only earnable
    // by solving all of them. Both of this dog's are the pack's own, kept
    // because they are the artist's work and because a camp dog that tops out
    // at 0.78 m/s is never going to show the difference.
    clips: {
      stand: { name: 'idle' },
      // Cadence, not stride — the ground per cycle is the artist's. As
      // authored this walk covers 39.3 cm in 1.29 s, which is 0.304 m/s and far
      // too slow for the 0.78 m/s potter `camp_dog.js` drives; 2.5x puts the
      // cadence at 1.9 Hz and the speed at 0.76, so the dog plays its walk at
      // very nearly 1x while it is actually walking.
      walk: { name: 'walk', rate: 2.5 },
      // Never played, and the rate says so: this clip covers 50.5 cm in 0.75 s,
      // which is 0.67 m/s — slower than the walk once the walk is cadenced, and
      // nothing a running dog resembles. 3.0x is the most the rate clamp will
      // carry and it still only reaches 2.02 m/s. The camp dog's fastest state
      // is a 0.78 m/s potter so the ladder never leaves its bottom rung, and
      // this is here because a rung the ladder can SEE is better than a NaN
      // where its top should be. Anyone who wants a dog that actually runs
      // needs a better clip than the pack ships.
      run: { name: 'run', rate: 3.0 },
      // The three rest poses. No `rate`: a pose clip covers no ground, and
      // `loadGlbSpecies` skips measuring anything that does not declare one.
      sit: { name: 'sit' },
      lie: { name: 'lie' },
      curl: { name: 'curl' },
    },
    // The clip slots `GlbRig` should treat as REST POSES: mutually exclusive
    // holds that take over the whole standing budget. See `GlbRig.update`.
    rest: ['sit', 'lie', 'curl'],
  },

  // Three of the pack's six painted dogs. Weights are the old blueprint's, kept
  // so a given camp keeps the dog it had.
  variants: [
    { name: 'brown', scale: 1.00, weight: 0.60, hide: wear('Dog_03') },
    { name: 'cream', scale: 0.96, weight: 0.22, hide: wear('Dog_04') },
    { name: 'black', scale: 1.04, weight: 0.18, hide: wear('Dog_06') },
  ],

  // Measured off the clips at load by `loadGlbSpecies` and written back here;
  // these are what the current asset reports, kept so a regression shows in a
  // diff. Editing them changes nothing.
  //
  // There is no `trot`, and that is a statement about the animal rather than an
  // omission: nothing in the pack has one, and a camp dog does not need one —
  // it potters at 0.78 m/s and never flees anything. `GlbRig`'s ladder hands
  // walk straight to run when a species declares no trot.
  gait: { walk: 0.760, run: 2.019 },
};

/**
 * The camp dog's prototypes — one per coat, sharing one mesh and one skeleton.
 *
 * Awaited rather than built, which is the whole difference from the blueprint
 * this replaces: there is a file to fetch. `camp_dog.warmDog` does the awaiting
 * under the camp pre-warm so no camp pays for it mid-pitch.
 *
 * The camp dog is NOT in `SPECIES`, and that is load-bearing rather than
 * tidiness. `Wildlife` iterates `Object.keys(SPECIES)` to build prototypes, to
 * size its mesh pool and to scatter home sites across the valley — so a dog in
 * that table would be a wild animal living on the forest edge, and would also
 * read `CFG.dog` and find nothing. The dog belongs to a camp; `src/camp/
 * camp_dog.js` owns when one exists.
 */
export function loadCampDog() {
  return loadGlbSpecies('dog', DOG_SPECIES);
}

// ─────────────────────────────────────────────────────────────────────────────
//  animal_species — the table, and the family's front door.
//
//  Every mammal in the game is the same quadruped: a lofted barrel on a spine,
//  a neck, a head with a muzzle and ears, four three-segment legs and a tail.
//  What separates a deer from a bear is entirely in the numbers — where the
//  back line sits, how deep the barrel is, how long the legs are, where the
//  head is carried relative to the withers.
//
//  ...with one exception, which this file exists to make invisible to everyone
//  above it. The fox is HAND-AUTHORED: a mesh and six clips built in Blender and
//  played back by three's AnimationMixer (`glb_rig.js`), rather than a blueprint
//  lofted and solved. A species declares which track it is on by carrying a
//  `glb` block or a `blueprint`, and nothing outside this file and `Wildlife`'s
//  two build steps ever asks again — placement, streaming, the logbook, the
//  photo detector and the compass paw all walk one cast.
//
//  That is deliberate. Plate 3 shows the bar: the bear is legible as a bear
//  from a hundred metres away as a flat black shape, because its proportions
//  are right — low head, high shoulder hump, short heavy legs, long body. Get
//  the profile right and the shading barely matters. Get it wrong and no amount
//  of shading saves it. So the profile arrays are the actual art, and they live
//  one per animal in `mammals/`:
//
//    mammals/<species>.js   one animal, whole: blueprint (or the `glb` block
//                           that replaces it), coat variants, gait ladder,
//                           brain numbers. Self-contained — a species is added
//                           or deleted by adding or deleting a file and a line
//                           of this table.
//    mammals/quadruped.js   the shared builder every blueprint is fed to, and
//                           nothing species-specific.
//    mammals/hide.js        the material the whole cast wears.
//
//  This file exists so the rest of the app has one import for the family (the
//  same shape as `vehicle/vehicle_models.js`), and so `Wildlife` can walk the
//  cast without knowing what is in it.
// ─────────────────────────────────────────────────────────────────────────────
import { buildVariants } from './mammals/quadruped.js';
import { loadGlbSpecies } from './glb_rig.js';
import { DEER } from './mammals/deer.js';
import { BEAR } from './mammals/bear.js';
import { RABBIT } from './mammals/rabbit.js';
import { FOX } from './mammals/fox.js';
import { SQUIRREL } from './mammals/squirrel.js';
import { RACCOON } from './mammals/raccoon.js';
import { GOAT } from './mammals/goat.js';
import { RAM } from './mammals/ram.js';
import { MOOSE } from './mammals/moose.js';

export { createHideMaterial, setHideSilScale, SIL_FOV_REF }
  from './mammals/hide.js';
export { GlbRig } from './glb_rig.js';
// The camp dog is NOT in `SPECIES` — see the note over DOG_SPECIES. It is
// re-exported here anyway so anything that wants it has the same one door as
// everyone else. `loadCampDog` rather than a builder: the dog is a fetched GLB
// on the hand-authored track now, not a lofted blueprint.
export { DOG_SPECIES, loadCampDog } from './mammals/dog.js';

// ── the cast ─────────────────────────────────────────────────────────────────
//
// Hides are warm, desaturated and dark. Against a #f0ad46 meadow every animal
// has to survive being reduced to a silhouette, and a hide that is merely a
// slightly different orange from the grass disappears — see each file.
//
// `Wildlife` iterates these keys to build prototypes, to size its mesh pool
// and to scatter home sites, so the order here is the order the valley is
// stocked in.
export const SPECIES = {
  deer: DEER,
  bear: BEAR,
  rabbit: RABBIT,
  fox: FOX,
  squirrel: SQUIRREL,
  raccoon: RACCOON,
  // The alpine pair, and last on purpose. Species are placed in this order out
  // of one capped site table (see `Wildlife._placeSites`), and a saturated cap
  // silently deletes whatever placed after it — so a new species goes at the
  // end, where a density mistake truncates itself first. (The river bears are
  // placed after the whole loop and are still the last thing in the table, so
  // that is the one row a runaway up here would take with it; the census's
  // `sites` count against the cap is the check.)
  goat: GOAT,
  ram: RAM,
  // Last of all, and it is the one species the cap cannot hurt: there are
  // exactly three moose on the map and `_mooseSites` puts them down BEFORE this
  // loop runs, off the river polylines rather than off the suitability field.
  // Its `CFG.perKm2` is 0, so the grid pass below skips it entirely.
  moose: MOOSE,
};

/** Is this species hand-authored in Blender rather than lofted from a blueprint? */
export function isGlb(key) { return !!SPECIES[key].glb; }

/**
 * Build the prototypes for one species. Called once at load; each variant gets
 * a near and a mid geometry sharing one skeleton description.
 *
 * Procedural only — a hand-authored species has to be fetched over the network
 * and so cannot be built synchronously. `Wildlife.init` awaits `loadSpecies`
 * for those; this throws rather than returning something half-shaped, because a
 * species that silently built no geometry is a fox-shaped hole nobody notices
 * until the valley is empty.
 */
export function buildSpecies(key, seed) {
  if (isGlb(key)) throw new Error(`[species] ${key} is hand-authored; await loadSpecies`);
  return buildVariants(SPECIES[key], key, seed);
}

/**
 * Build the prototypes for one hand-authored species, and measure it.
 *
 * Also writes the measured gait speeds back onto the species record — see
 * `loadGlbSpecies`. That is why this is awaited before anything reads
 * `SPECIES[key].gait`.
 */
export function loadSpecies(key) {
  return loadGlbSpecies(key, SPECIES[key]);
}

/** Weighted deterministic variant pick. */
export function pickVariant(key, r) {
  const vs = SPECIES[key].variants;
  let acc = 0;
  for (let i = 0; i < vs.length; i++) { acc += vs[i].weight; if (r < acc) return i; }
  return vs.length - 1;
}

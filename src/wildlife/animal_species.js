// ─────────────────────────────────────────────────────────────────────────────
//  animal_species — the table, and the family's front door.
//
//  Every mammal in the game is the same quadruped: a lofted barrel on a spine,
//  a neck, a head with a muzzle and ears, four three-segment legs and a tail.
//  What separates a deer from a bear is entirely in the numbers — where the
//  back line sits, how deep the barrel is, how long the legs are, where the
//  head is carried relative to the withers.
//
//  That is deliberate. Plate 3 shows the bar: the bear is legible as a bear
//  from a hundred metres away as a flat black shape, because its proportions
//  are right — low head, high shoulder hump, short heavy legs, long body. Get
//  the profile right and the shading barely matters. Get it wrong and no amount
//  of shading saves it. So the profile arrays are the actual art, and they live
//  one per animal in `mammals/`:
//
//    mammals/<species>.js   one animal, whole: blueprint, coat variants, gait
//                           ladder, brain numbers. Self-contained — a species
//                           is added or deleted by adding or deleting a file
//                           and a line of this table.
//    mammals/quadruped.js   the shared builder every blueprint is fed to, and
//                           nothing species-specific.
//    mammals/hide.js        the material the whole cast wears.
//
//  This file exists so the rest of the app has one import for the family (the
//  same shape as `vehicle/vehicle_models.js`), and so `Wildlife` can walk the
//  cast without knowing what is in it.
// ─────────────────────────────────────────────────────────────────────────────
import { buildVariants } from './mammals/quadruped.js';
import { DEER } from './mammals/deer.js';
import { BEAR } from './mammals/bear.js';
import { RABBIT } from './mammals/rabbit.js';
import { FOX } from './mammals/fox.js';
import { SQUIRREL } from './mammals/squirrel.js';
import { RACCOON } from './mammals/raccoon.js';

export { createHideMaterial, setHideSilScale, SIL_FOV_REF }
  from './mammals/hide.js';
// The camp dog is NOT in `SPECIES` — see the note over DOG_SPECIES. It is
// re-exported here anyway so `camp_dog.js` has the same one door as everyone
// else.
export { DOG_SPECIES, buildCampDog } from './mammals/dog.js';

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
};

/**
 * Build the prototypes for one species. Called once at load; each variant gets
 * a near and a mid geometry sharing one skeleton description.
 */
export function buildSpecies(key, seed) {
  return buildVariants(SPECIES[key], key, seed);
}

/** Weighted deterministic variant pick. */
export function pickVariant(key, r) {
  const vs = SPECIES[key].variants;
  let acc = 0;
  for (let i = 0; i < vs.length; i++) { acc += vs[i].weight; if (r < acc) return i; }
  return vs.length - 1;
}

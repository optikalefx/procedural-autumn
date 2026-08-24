// ─────────────────────────────────────────────────────────────────────────────
//  vehicle_models — the cars you can be driving, and how one gets chosen.
//
//  ADDING A CAR IS ONE ENTRY IN `CARS`.  Author `src/vehicle/<Name>Model.js`
//  against `model_kit.js` (start from RoamerModel.js — it is the smaller of the
//  two), export a builder returning `{ root, antenna, steeringWheel }`, and
//  push a row here.  Nothing else in the game needs to know: Vehicle picks off
//  this table, the contact shadow sizes itself from the row's `dims`, and the
//  gallery lists whatever it finds here.
//
//  The one hard rule is the chassis.  Every car rolls on CHASSIS (model_kit.js)
//  — the same wheelbase, track and wheel radius that VehiclePhysics, the camera
//  boom and the suspension tune are built around.  A car with a different
//  wheelbase is a physics change and has to be argued for as one.
//
//  Which car you get:
//
//   · `?car=<id>` pins it.  Every capture tool passes this, because a harness
//     that silently measured a different vehicle each run would be exactly the
//     class of confidently-wrong number AGENTS.md is about.
//   · otherwise it is random per page load, which is what the player wants:
//     you turn up at the trailhead in whatever you turned up in.
// ─────────────────────────────────────────────────────────────────────────────
import { buildMaterials } from './model_kit.js';
import { DIM as CAMPER_DIM, buildCamper } from './CamperModel.js';
import { DIM as ROAMER_DIM, buildRoamer, buildRoamerMaterials } from './RoamerModel.js';
import {
  DIM as ADVENTURER_DIM, TYRE as ADVENTURER_TYRE,
  buildAdventurer, buildAdventurerMaterials,
} from './AdventurerModel.js';

export const CARS = [
  {
    id: 'camper',
    label: 'Camper',
    sub: 'loaded overland rig',
    dims: CAMPER_DIM,
    seed: 91,
    materials: (env) => buildMaterials(env, 0xc4551f),
    build: (materials, seed) => buildCamper(materials, seed),
  },
  {
    id: 'roamer',
    label: 'Roamer',
    sub: 'two-tone heritage 4x4',
    dims: ROAMER_DIM,
    seed: 3,
    materials: (env) => buildRoamerMaterials(env),
    build: (materials, seed) => buildRoamer(materials, seed),
  },
  {
    id: 'adventurer',
    label: 'Adventurer',
    sub: 'yellow two-door, doors off',
    dims: ADVENTURER_DIM,
    seed: 12,
    // `wheel` is the only per-car override the shared wheel takes. It cannot
    // change the rolling radius — see buildWheel's header — so it is width and
    // tread depth, which is what separates a mud terrain from an all terrain at
    // the same diameter.
    wheel: ADVENTURER_TYRE,
    materials: (env) => buildAdventurerMaterials(env),
    build: (materials, seed) => buildAdventurer(materials, seed),
  },
];

export const DEFAULT_CAR = 'camper';

/** A car by id, or null. Ids are the `?car=` values and are part of the API. */
export function carById(id) {
  return CARS.find((c) => c.id === id) ?? null;
}

/**
 * Which car this page load is driving.
 *
 * `?car=<id>` wins. An id that does not exist is a typo in a tool invocation
 * or a URL, and silently driving something else is how a capture ends up
 * measuring the wrong vehicle — so it says so and falls back to the default
 * rather than to a random one.
 */
export function pickCar(search = (typeof location !== 'undefined' ? location.search : ''), rnd = Math.random) {
  const want = new URLSearchParams(search).get('car');
  if (want) {
    const found = carById(want);
    if (found) return found;
    console.warn(`[vehicle] no car with id "${want}" — known: ${CARS.map((c) => c.id).join(', ')}`);
    return carById(DEFAULT_CAR) ?? CARS[0];
  }
  return CARS[Math.min(CARS.length - 1, Math.floor(rnd() * CARS.length))];
}

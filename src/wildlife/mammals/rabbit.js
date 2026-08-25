// ─────────────────────────────────────────────────────────────────────────────
//  rabbit — the small one you meet on the verge.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX } from '../animal_rig.js';

// Rabbit. Read at 15 m or not at all, so the ears and the white scut do all
// the identifying work. Permanently crouched, with hind legs folded flat.
const BLUEPRINT = () => ({
  key: 'rabbit',
  pelvis: [0, 0.175, -0.095],
  spine: [[0, 0.180, -0.025]],
  chest: [0, 0.165, 0.055],
  // Two bones, even though a rabbit has barely any neck at all — see the note
  // on the bear. Without the second one nothing on the head ever moves.
  neck: [[0, 0.180, 0.086], [0, 0.190, 0.108]],
  head: [0, 0.198, 0.132],
  barrel: [
    { z: -0.185, y: 0.150, rx: 0.048, ry: 0.052, mix: MIX.pale },
    { z: -0.135, y: 0.170, rx: 0.075, ry: 0.082, key: 1 },
    { z: -0.055, y: 0.176, rx: 0.082, ry: 0.090 },
    { z: 0.020, y: 0.168, rx: 0.076, ry: 0.082, key: 1 },
    { z: 0.078, y: 0.160, rx: 0.060, ry: 0.064 },
  ],
  belly: [
    { z: -0.10, y: 0.100, rx: 0.048, ry: 0.020 },
    { z: 0.01, y: 0.096, rx: 0.052, ry: 0.022 },
  ],
  // A rabbit has no visible neck at all. The head has to sit straight on the
  // shoulders or the crouch reads as a bird.
  neckProfile: [
    { rx: 0.066, ry: 0.068 },
    { rx: 0.060, ry: 0.062 },
    { rx: 0.054, ry: 0.055 },
  ],
  headProfile: [
    { dy: 0.000, dz: -0.048, rx: 0.046, ry: 0.048 },
    { dy: 0.003, dz: 0.004, rx: 0.052, ry: 0.053 },
    { dy: -0.012, dz: 0.042, rx: 0.037, ry: 0.036 },
    { dy: -0.026, dz: 0.072, rx: 0.026, ry: 0.024, mix: MIX.dark },
  ],
  // Ears are the whole identity at fifteen metres, so they are generous.
  // Spread into a clear V — from most angles two overlapping vertical ears
  // read as one, and the V is the whole silhouette cue at fifteen metres.
  ear: { at: [0.036, 0.034, -0.014], dir: [0.28, 0.950, -0.13], len: 0.195, w: 0.044, h: 0.028 },
  tail: [[0, 0.163, -0.190], [0, 0.166, -0.214]],
  tailR: [0.036, 0.033], tailFlat: 1, tailMix: MIX.pale,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.050, 0.170, -0.100], knee: [0, -0.048, 0.070], hock: [0, -0.062, -0.098], foot: [0, -0.060, 0.058],
    rTop: 0.044, rMid: 0.026, rLow: 0.017, rFoot: 0.014, flat: 0.80,
    hoofH: 0.016, hoofR: 0.019, hoofLong: 2.6, hoofFwd: 0.030, sockTop: 0.25,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.040, 0.150, 0.060], knee: [0, -0.052, -0.014], hock: [0, -0.040, 0.020], foot: [0, -0.058, 0.004],
    rTop: 0.026, rMid: 0.018, rLow: 0.013, rFoot: 0.011, flat: 0.85,
    hoofH: 0.014, hoofR: 0.015, hoofLong: 1.8, hoofFwd: 0.012, sockTop: 0.25,
  },
});

export const RABBIT = {
  key: 'rabbit',
  plural: 'Rabbits',
  variants: [
    // Hare-scaled rather than rabbit-scaled, and a good deal darker than a
    // real one: at 0.2 m in 0.6 m grass, a grass-coloured animal is invisible
    // rather than shy. The whole point of the species is the moment it bolts.
    { name: 'brown', scale: 1.18, weight: 0.55,
      col: { coat: 0x5b452e, pale: 0xd9cdb4, dark: 0x2c2015, horn: 0x8a7a60 } },
    { name: 'grey', scale: 1.09, weight: 0.30,
      col: { coat: 0x4f463a, pale: 0xd4cbb9, dark: 0x272018, horn: 0x8a7a60 } },
    { name: 'sandy', scale: 1.25, weight: 0.15,
      col: { coat: 0x6b5133, pale: 0xe0d4b8, dark: 0x322415, horn: 0x8a7a60 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    walk: 0.9, trot: 2.0, run: 7.0,
    strideBase: 0.48, strideGain: 2.5, dutyWalk: 0.55, dutyTrot: 0.45, dutyRun: 0.22,
    bobAmp: 0.014, pitchAmp: 0.05, liftScale: 1.5,
    grazeAng: 1.05, grazeRake: 1.15,
  },
  brain: {
    // A rabbit barely freezes at all — it is gone before you have registered
    // that it was there, which is the opposite beat to the deer's.
    // No `noticeDist`: a 0.25 m animal at 50 m is under three pixels, so the
    // wary-watch beat would cost animation and buy the player nothing. A
    // rabbit's whole legibility is the bolt, and that happens at 26 m.
    // No stand-off: at 0.25 m a rabbit is under three pixels at any range
    // where this would matter, and cover is the whole point of a rabbit.
    standoff: 0,
    alertDist: 36, fleeDist: 26, calmDist: 45,
    // No `noticeDist` to step outside of (see the note above it), so this is
    // set off `alertDist` instead — far enough that the paw beats the bolt,
    // near enough to stay inside the 96 m spawn ring.
    hintDist: 54,
    freezeTime: [0.15, 0.65], fleeTime: [1.6, 3.4],
    grazeTime: [4, 12], idleTime: [1.5, 5], walkTime: [1.5, 5],
    herd: [1, 2], herdRadius: 4, wanderRadius: 14,
    grazeChance: 0.6,
  },
};

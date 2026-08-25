// ─────────────────────────────────────────────────────────────────────────────
//  squirrel — the smallest mammal in the cast.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';

// Squirrel. The smallest mammal in the cast, read at 10–20 m or not at all —
// closer even than the rabbit, so the silhouette budget all goes to the one
// shape nothing else in the valley has: the brush, nearly body length and
// thicker than the chest, carried ARCHED UP over the back with the tip curling
// forward. The tail chain is authored climbing, not hanging — every other
// species' tail leaves the rump and falls, and that difference IS the animal.
// The body under it is a small hunched crouch, highest over the haunch, with
// the head carried low and forward; upright ears and a stubby muzzle stop it
// reading as a rat.
const BLUEPRINT = () => ({
  key: 'squirrel',
  pelvis: [0, 0.118, -0.062],
  spine: [[0, 0.128, -0.012]],
  chest: [0, 0.120, 0.040],
  // Two bones, even though a squirrel's neck is nothing — see the note on the
  // bear. Fewer and the head never moves at all.
  neck: [[0, 0.130, 0.060], [0, 0.140, 0.074]],
  head: [0, 0.150, 0.090],
  barrel: [
    { z: -0.120, y: 0.098, rx: 0.030, ry: 0.034 },
    // The haunch is the mass of the animal — a squirrel is mostly hindquarters
    // and the topline peaks over them, not at the shoulder.
    { z: -0.086, y: 0.114, rx: 0.048, ry: 0.054, key: 1 },
    { z: -0.034, y: 0.118, rx: 0.050, ry: 0.055 },
    { z: 0.016, y: 0.112, rx: 0.044, ry: 0.048, key: 1 },
    { z: 0.056, y: 0.106, rx: 0.034, ry: 0.038 },
  ],
  belly: [
    { z: -0.058, y: 0.072, rx: 0.028, ry: 0.013 },
    { z: 0.008, y: 0.068, rx: 0.030, ry: 0.014 },
  ],
  // The root is as deep as the barrel's front station on purpose — the
  // step-at-the-withers trap the fox's neck notes, and this neck folds down
  // every time the animal noses the litter.
  neckProfile: [
    { rx: 0.040, ry: 0.044 },
    { rx: 0.035, ry: 0.038 },
    { rx: 0.031, ry: 0.033 },
  ],
  // A round little cranium and a short blunt muzzle. Stretching the muzzle is
  // the one edit that would turn this into a rat, so it stays stubby.
  headProfile: [
    { dy: 0.000, dz: -0.032, rx: 0.028, ry: 0.030 },
    { dy: 0.003, dz: 0.002, rx: 0.032, ry: 0.033 },
    { dy: -0.006, dz: 0.026, rx: 0.023, ry: 0.023 },
    { dy: -0.014, dz: 0.046, rx: 0.014, ry: 0.013, mix: MIX.dark },
  ],
  // Upright and set high — with the tail, the second cue. Small enough that
  // they never read from range, but at three metres in the gallery a squirrel
  // without ear tufts is a prairie dog.
  ear: { at: [0.020, 0.026, -0.006], dir: [0.22, 0.95, -0.10], len: 0.052, w: 0.020, h: 0.013 },
  // The brush. It leaves the rump LOW — a squirrel's tail drops before it
  // turns — then climbs past the topline and curls forward over the back, the
  // tip ending above the body's own height. `tailR` GROWS toward the tip:
  // every other tail in the game tapers, and a brush that tapers is a whip.
  // The alert channel adds its little lift on top (see _poseTail), which on
  // this authored arch reads as the alarm flick a real one does.
  tail: [[0, 0.096, -0.118], [0, 0.140, -0.162], [0, 0.205, -0.155], [0, 0.252, -0.108]],
  tailR: [0.020, 0.034], tailFlat: 1,
  // Frosted, not white-tipped: the grey's brush is coat-dark with pale guard
  // hairs at the edge, so the ramp runs late and only most of the way to pale.
  tailMix: MIX.coat, tailTipMix: mixLerp(MIX.coat, MIX.pale, 0.65), tailMixBias: 1.6,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.034, 0.114, -0.066], knee: [0, -0.034, 0.048], hock: [0, -0.042, -0.064], foot: [0, -0.040, 0.040],
    rTop: 0.030, rMid: 0.016, rLow: 0.011, rFoot: 0.009, flat: 0.82,
    // The long plantigrade hind foot, same trick as the rabbit's.
    hoofH: 0.012, hoofR: 0.013, hoofLong: 2.4, hoofFwd: 0.020, sockTop: 0.3,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.026, 0.102, 0.044], knee: [0, -0.038, -0.012], hock: [0, -0.032, 0.016], foot: [0, -0.036, 0.002],
    rTop: 0.017, rMid: 0.012, rLow: 0.009, rFoot: 0.008, flat: 0.85,
    hoofH: 0.010, hoofR: 0.011, hoofLong: 1.9, hoofFwd: 0.010, sockTop: 0.3,
  },
});

export const SQUIRREL = {
  key: 'squirrel',
  plural: 'Squirrels',
  variants: [
    // Scaled up a touch past life, same reasoning as the rabbit: a
    // 0.17 m animal in forest litter is invisible rather than shy, and the
    // whole species exists for the ten-metre glimpse. The grey carries the
    // frosted brush; a warm red for the conifer stands; and a melanistic
    // dark one — kept well above the near-black floor the bear's palette
    // note warns about, so its flank still shades.
    { name: 'grey', scale: 1.12, weight: 0.52,
      col: { coat: 0x5a5044, pale: 0xd6cbb6, dark: 0x2a211a, horn: 0x8a7a60 } },
    { name: 'red', scale: 1.02, weight: 0.30,
      col: { coat: 0x7c492b, pale: 0xdfd0b8, dark: 0x342013, horn: 0x8a5a2e } },
    { name: 'dark', scale: 1.08, weight: 0.18,
      col: { coat: 0x40342a, pale: 0xa89a82, dark: 0x1e1710, horn: 0x7d5430 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    // Everything is the hop — see LADDER. The thresholds are low because the
    // animal is tiny: 1.6 m/s on this frame is already flat out for a
    // forage-hop, and 5.5 is the bolt for cover.
    walk: 0.7, trot: 1.6, run: 5.5,
    strideBase: 0.32, strideGain: 2.8, dutyWalk: 0.55, dutyTrot: 0.45, dutyRun: 0.22,
    bobAmp: 0.010, pitchAmp: 0.05, liftScale: 1.5,
    // Nose to the litter, not grazing — and shallow, because this neck is
    // even shorter and steeper than the fox's: the same fold-at-the-root
    // hump lives past ~1.1 here.
    grazeAng: 0.95, grazeRake: 1.05,
  },
  brain: {
    // The rabbit's beat, compressed: barely any freeze, a short bolt, gone.
    // No noticeDist and no standoff, for the rabbit's reasons doubled — at
    // 0.19 m this animal does not exist past thirty metres, and cover is
    // the whole point of it.
    standoff: 0,
    alertDist: 26, fleeDist: 18, calmDist: 34,
    // The shortest band in the game, and it is the 72 m spawn ring that
    // decides it rather than the squirrel's nerves: a squirrel further out
    // than this does not exist to be hinted at. Off `alertDist`, as the
    // rabbit's is.
    hintDist: 39,
    freezeTime: [0.1, 0.45], fleeTime: [1.0, 2.4],
    grazeTime: [3, 9], idleTime: [1, 4], walkTime: [1, 4],
    herd: [1, 2], herdRadius: 3, wanderRadius: 10,
    grazeChance: 0.65,
  },
};

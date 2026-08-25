// ─────────────────────────────────────────────────────────────────────────────
//  fox — the brush and the ears, and not much else at range.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';

// Fox. Sized between the rabbit and the dog and read at 30–60 m, where the
// whole animal is a dozen pixels — so the silhouette budget goes to the two
// things nothing else in the valley has: the brush and the ears. The tail is
// nearly the length of the body and almost as thick as the chest, carried
// streaming straight out behind, with a white tip; the ears are tall dark
// triangles on a small sharp head. Everything else — slim legs in black
// stockings, a pointed muzzle, a low light frame — is what stops it reading
// as a small dog at the ranges where the brush is hidden by grass.
const BLUEPRINT = () => ({
  key: 'fox',
  pelvis: [0, 0.345, -0.140],
  spine: [[0, 0.355, -0.045], [0, 0.358, 0.055]],
  chest: [0, 0.360, 0.145],
  // Carried well up when the animal is standing — a fox holds its head above
  // the topline the way the dog does, and for the same legibility reason: a
  // level neck turns the whole animal into one horizontal mass with a nose.
  neck: [[0, 0.408, 0.184], [0, 0.462, 0.222]],
  head: [0, 0.496, 0.252],
  rumpTip: false,
  barrel: [
    // The croup slopes to the tail root; the brush has to flow out of the
    // body rather than being pinned to a squared-off backside.
    { z: -0.205, y: 0.330, rx: 0.048, ry: 0.052 },
    { z: -0.162, y: 0.345, rx: 0.078, ry: 0.082, key: 1 },
    // A tuck-up, shallower than the dog's — under the winter coat a fox's
    // waist is a suggestion, not a whippet's cinch.
    { z: -0.068, y: 0.356, rx: 0.068, ry: 0.080, key: 1 },
    { z: 0.015, y: 0.352, rx: 0.074, ry: 0.098 },
    // The chest is deep for the animal's size but never broad; a fox is a
    // narrow animal from the front at every station.
    { z: 0.095, y: 0.346, rx: 0.076, ry: 0.112, key: 1 },
    { z: 0.165, y: 0.354, rx: 0.070, ry: 0.098 },
    { z: 0.215, y: 0.360, rx: 0.050, ry: 0.072, key: 1 },
  ],
  // White from the throat back along the belly — a fox's underside is genuinely
  // white, and the flash of it as one turns is a real identifier.
  belly: [
    { z: -0.110, y: 0.284, rx: 0.044, ry: 0.020 },
    { z: 0.000, y: 0.270, rx: 0.050, ry: 0.023 },
    { z: 0.115, y: 0.262, rx: 0.048, ry: 0.022 },
  ],
  // Thick with ruff where it leaves the shoulder, and it stays fuller than the
  // skull warrants all the way up — the winter ruff is most of a fox's neck.
  // The root station is deliberately as deep as the shoulder behind it. At
  // 0.078 it sat 2 cm inside the barrel's withers station, which stood proud
  // as a discrete hump the moment the mousing pose folded the neck down and
  // exposed the seam — the same step-at-the-withers trap the dog's neck notes.
  neckProfile: [
    { rx: 0.076, ry: 0.094 },
    { rx: 0.060, ry: 0.070 },
    { rx: 0.047, ry: 0.052 },
    { rx: 0.038, ry: 0.040 },
  ],
  // A small cranium and a muzzle that runs straight out to a point — the exact
  // taper the dog's blueprint refuses. `muzzleTip` stays true: the sharp nose
  // IS the fox, the way the blunt box is the dog.
  headProfile: [
    { dy: -0.004, dz: -0.044, rx: 0.036, ry: 0.044 },
    { dy: 0.006, dz: -0.008, rx: 0.044, ry: 0.052 },
    { dy: -0.008, dz: 0.028, rx: 0.032, ry: 0.040 },
    { dy: -0.024, dz: 0.064, rx: 0.022, ry: 0.026, mix: mixLerp(MIX.coat, MIX.pale, 0.45) },
    { dy: -0.036, dz: 0.096, rx: 0.013, ry: 0.015, mix: MIX.dark },
  ],
  // Tall triangles, nearly upright, dark down the whole back — on a red coat
  // the black ears are the second cue after the brush, and like the dog's they
  // are authored base-to-tip rather than with the default pale/dark split.
  ear: {
    at: [0.030, 0.034, -0.004], dir: [0.30, 0.93, 0.10],
    len: 0.115, w: 0.042, h: 0.024,
    mixBase: mixLerp(MIX.coat, MIX.dark, 0.40), mixTip: MIX.dark,
  },
  // The brush. Nearly body length and thick along its whole run — `tailR`
  // barely tapers, because a brush is a cylinder of fur, not a whip — carried
  // low and streaming, with the white tip on the end. At forty metres in long
  // grass this tail is frequently the only part of the animal that reads, and
  // it reads as "fox" all by itself.
  tail: [[0, 0.315, -0.245], [0, 0.268, -0.345], [0, 0.246, -0.445], [0, 0.252, -0.530]],
  tailR: [0.040, 0.033], tailFlat: 1,
  tailMix: MIX.coat, tailTipMix: MIX.pale, tailMixBias: 2.4,
  // Slim legs on a light frame, in black stockings — `sockTop` runs the dark
  // far higher than any other species, because on a fox the lower leg is not
  // "darker": it is black to well above the hock.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.048, 0.340, -0.145], knee: [0, -0.125, 0.048], hock: [0, -0.100, -0.066], foot: [0, -0.112, 0.022],
    rTop: 0.058, rMid: 0.027, rLow: 0.017, rFoot: 0.014, flat: 0.85,
    hoofH: 0.015, hoofR: 0.018, hoofLong: 1.7, hoofFwd: 0.010, sockTop: 0.75,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.044, 0.356, 0.135], knee: [0, -0.132, -0.030], hock: [0, -0.108, 0.034], foot: [0, -0.114, 0.0],
    rTop: 0.046, rMid: 0.025, rLow: 0.016, rFoot: 0.014, flat: 0.86,
    hoofH: 0.015, hoofR: 0.017, hoofLong: 1.6, hoofFwd: 0.009, sockTop: 0.75,
  },
});

export const FOX = {
  key: 'fox',
  plural: 'Foxes',
  variants: [
    // A real red fox is nearly the same orange as the #f0ad46 meadow, which
    // is exactly the disappearing act the palette note above warns about —
    // so every coat here is pulled down into russet, well below the grass in
    // value, and the identity is carried by the near-white pale (the bib,
    // the belly, the tail tip) against the near-black dark (the stockings,
    // the ear backs). The contrast IS the fox; the orange is just the wash.
    { name: 'red', scale: 1.00, weight: 0.62,
      col: { coat: 0x8f4d2a, pale: 0xe2d6c0, dark: 0x231710, horn: 0x8a5a2e } },
    // A cross fox — the dark morph, smoky over the shoulders.
    { name: 'cross', scale: 1.04, weight: 0.22,
      col: { coat: 0x64402c, pale: 0xcdbfa6, dark: 0x1d130d, horn: 0x7d5430 } },
    { name: 'pale', scale: 0.96, weight: 0.16,
      col: { coat: 0xa4653a, pale: 0xe8ddc7, dark: 0x2c1d13, horn: 0x8a5a2e } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    // A fox lives at the trot — the low straight-backed drift along a field
    // edge is the characteristic movement, so the trot band is wide and the
    // walk band narrow. Top gear is a real gallop, not a bound.
    walk: 0.85, trot: 3.0, run: 8.5,
    strideBase: 0.55, strideGain: 2.6, dutyWalk: 0.62, dutyTrot: 0.48, dutyRun: 0.28,
    bobAmp: 0.016, pitchAmp: 0.048, liftScale: 1.15,
    // The mousing pose: nose down in the grass — a fox is listening to the
    // ground, not cropping it. Shallower than a grazer's numbers, though,
    // and that is a geometry constraint as much as a behaviour one: this
    // neck is short and steep, and at 1.30 the fold at the neck root broke
    // the topline into a hump. At 1.12 the nose still reads as "down" from
    // every range that matters and the shoulder line stays whole.
    grazeAng: 1.12, grazeRake: 1.25,
  },
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

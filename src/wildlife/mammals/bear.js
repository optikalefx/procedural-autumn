// ─────────────────────────────────────────────────────────────────────────────
//  bear — the big one.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';

// Bear. Everything deer is not: the head hangs below the shoulder, the hump is
// the highest point, the barrel is nearly round and enormous, the legs are
// short columns and the feet are plantigrade plates. Plate 3 exactly.
const BLUEPRINT = () => ({
  key: 'bear',
  // A bear is a long low mass carried on short columns, with the head slung
  // below and in front of the shoulder hump. The first pass stood it too tall
  // and tucked the head into the shoulder, which read as a boar.
  pelvis: [0, 0.74, -0.52],
  spine: [[0, 0.78, -0.20], [0, 0.82, 0.12]],
  chest: [0, 0.86, 0.40],
  // Two neck bones, not one. The animator solves the neck as a two-link chain
  // and silently disables the whole head — graze, look, alert, the lot — when a
  // species has fewer, which is why the bear and the rabbit shipped with skulls
  // welded to their shoulders.
  neck: [[0, 0.875, 0.60], [0, 0.825, 0.78]],
  head: [0, 0.735, 0.95],
  barrel: [
    { z: -0.80, y: 0.68, rx: 0.196, ry: 0.196 },
    { z: -0.66, y: 0.72, rx: 0.245, ry: 0.242, key: 1 },
    { z: -0.42, y: 0.74, rx: 0.272, ry: 0.268 },
    { z: -0.12, y: 0.76, rx: 0.288, ry: 0.290, key: 1 },
    { z: 0.14, y: 0.80, rx: 0.290, ry: 0.315 },
    { z: 0.34, y: 0.84, rx: 0.278, ry: 0.345, key: 1 },   // the hump
    { z: 0.52, y: 0.82, rx: 0.230, ry: 0.262 },
    { z: 0.64, y: 0.78, rx: 0.168, ry: 0.182, key: 1 },
  ],
  belly: null,
  // Waisted at the throat so the skull is a separate mass from the hump.
  neckProfile: [
    { rx: 0.212, ry: 0.230 },
    { rx: 0.184, ry: 0.192 },
    { rx: 0.148, ry: 0.148 },
    { rx: 0.118, ry: 0.114 },
  ],
  headProfile: [
    { dy: 0.014, dz: -0.096, rx: 0.100, ry: 0.104 },
    { dy: 0.006, dz: 0.014, rx: 0.122, ry: 0.118 },
    { dy: -0.020, dz: 0.090, rx: 0.083, ry: 0.078, mix: mixLerp(MIX.coat, MIX.pale, 0.40) },
    { dy: -0.036, dz: 0.170, rx: 0.062, ry: 0.058, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.046, dz: 0.210, rx: 0.050, ry: 0.044, mix: MIX.dark },
  ],
  // A bear's ears are its second silhouette cue after the hump: round, set wide
  // and well back on a low skull. Read as a black shape they are the difference
  // between a bear and a boar.
  ear: { at: [0.100, 0.104, -0.078], dir: [0.42, 0.86, -0.28], len: 0.108, w: 0.074, h: 0.052 },
  tail: [[0, 0.74, -0.86], [0, 0.70, -0.92]],
  tailR: [0.045, 0.018], tailFlat: 1,
  // ── why the joints zigzag this hard ────────────────────────────────────────
  // A bear's leg is short and its body is heavy, so the first pass authored the
  // segments almost straight: hip to hock spanned 0.63 of a possible 0.67, and
  // the standing bear was up on locked stilts with 6% of travel in the whole
  // chain. The gait then asks each foot to sweep half a stride either side of
  // neutral — 0.3 m — which needs 0.70 of reach the leg does not have, so the
  // IK clamped for most of every cycle: both bones went dead straight, stopped
  // moving relative to each other, and the foreleg raked back under the barrel
  // until it was inside the body's own silhouette. That is the "front legs
  // disappear" report, and it is a reach problem, not a rendering one.
  //
  // The fix is to put the bend back where a bear actually carries it: the elbow
  // set well behind the shoulder, the stifle carried forward and the hock
  // dropped back behind it. Same hip, same paw, same standing height — the
  // chain is simply longer than the straight line it has to span, which is what
  // gives the solver room to work. Standing now sits at ~82% of reach, and the
  // extremes of a walk at ~91%, so the joints bend all cycle instead of locking.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.205, 0.72, -0.50], knee: [0, -0.27, 0.20], hock: [0, -0.23, -0.26], foot: [0, -0.22, 0.10],
    rTop: 0.190, rMid: 0.132, rLow: 0.096, rFoot: 0.074, flat: 0.88, k: 0.85,
    hoofH: 0.070, hoofR: 0.082, hoofLong: 1.9, hoofFwd: 0.055, sockTop: 0.30,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.225, 0.86, 0.28], knee: [0, -0.32, -0.20], hock: [0, -0.31, 0.23], foot: [0, -0.23, 0.06],
    rTop: 0.186, rMid: 0.136, rLow: 0.102, rFoot: 0.082, flat: 0.90, k: 0.85,
    hoofH: 0.070, hoofR: 0.088, hoofLong: 1.7, hoofFwd: 0.048, sockTop: 0.30,
  },
});

export const BEAR = {
  key: 'bear',
  plural: 'Bears',
  // ── why these are so much lighter than a black bear ──────────────────────
  // The first pass authored the near colour at the value the *distant*
  // silhouette wants: 0x2c1d16, which is 0.024 in linear. The stylised
  // lighting floors a shaded surface at `uStyleFloor` of the key, so the
  // shaded flank of that hide came out at 0.003 — a hole. Every lever above
  // it (form shading 0.68..1.0, the sun banding, the rim) is a *multiplier*,
  // and there is nothing to multiply. So a bear four metres away was the
  // same featureless black blob as a bear a hundred and forty metres away,
  // and the plate's whole point — that the shape carries the animal — was
  // being paid for twice.
  //
  // It only ever had to be paid once. `uSilNear/uSilFar` already collapse
  // the four regions into `dark` and pull the whole animal down in value
  // with distance; that is what makes the far silhouette. Freeing the near
  // colour to be an actual hide costs the distance read nothing (at range
  // the coat is 15% of a tone that is 85% `dark`), and it is the difference
  // between a bear you can see the hump, the elbow and the muzzle band on
  // and a bear-shaped hole in the meadow.
  variants: [
    { name: 'boar', scale: 1.08, weight: 0.45,
      col: { coat: 0x875f4a, pale: 0xc7a07d, dark: 0x3b2a20, horn: 0xa89a86 } },
    { name: 'sow', scale: 0.96, weight: 0.40,
      col: { coat: 0x956a54, pale: 0xd0b190, dark: 0x422e24, horn: 0xa89a86 } },
    { name: 'cinnamon', scale: 1.00, weight: 0.15,
      col: { coat: 0xa66e47, pale: 0xdcb98a, dark: 0x573828, horn: 0xa89a86 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    walk: 1.05, trot: 2.6, run: 6.2,
    // `strideBase` was the deer's 1.05 on a leg two-thirds the length, which
    // is the other half of the reach problem above: a bear covers ground with
    // cadence and bulk, not with a long swing. Shorter steps keep each foot
    // inside what the chain can actually reach, and they read as a bear.
    strideBase: 0.92, strideGain: 1.8, dutyWalk: 0.68, dutyTrot: 0.56, dutyRun: 0.38,
    bobAmp: 0.035, pitchAmp: 0.030, liftScale: 0.72,
    // A bear's nose is already low; it barely has to reach to crop.
    grazeAng: 1.30, grazeRake: 1.45,
  },
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

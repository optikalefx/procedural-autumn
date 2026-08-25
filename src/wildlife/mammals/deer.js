// ─────────────────────────────────────────────────────────────────────────────
//  deer — the animal the rest of the cast is measured against.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';

// Deer. Long thin legs, a shallow laterally-compressed barrel, a level back
// line and a head carried high on a near-vertical neck. The white rump patch
// and pale belly are the only bright values on the animal, and they are what
// make a deer read as a deer at 60 m rather than as a generic brown quadruped.
const BLUEPRINT = () => ({
  key: 'deer',
  pelvis: [0, 1.02, -0.42],
  spine: [[0, 1.05, -0.16], [0, 1.06, 0.10]],
  chest: [0, 1.07, 0.34],
  // The neck is long, and that length is load-bearing: the muzzle has to reach
  // the grass. The first pass spanned 0.33 m between the withers and the poll,
  // so a "grazing" deer could only lower its head a third of the way and stood
  // with its chin folded into its own chest, reading as decapitated.
  neck: [[0, 1.21, 0.44], [0, 1.47, 0.58]],
  head: [0, 1.61, 0.65],
  rumpTip: false,
  barrel: [
    // Rounded off, not tipped. Collapsing this ring to a point and painting it
    // pale hung a bright cone off the back of every deer.
    { z: -0.62, y: 1.00, rx: 0.118, ry: 0.140 },
    { z: -0.55, y: 1.02, rx: 0.170, ry: 0.190, key: 1 },
    // The haunch and the shoulder are the two places a deer is widest. Without
    // them the barrel is a tube on four sticks, which is what the first pass
    // read as — an alpaca rather than a deer.
    { z: -0.42, y: 1.03, rx: 0.196, ry: 0.208, key: 1 },
    { z: -0.16, y: 1.03, rx: 0.178, ry: 0.214 },
    { z: 0.08, y: 1.035, rx: 0.176, ry: 0.222, key: 1 },
    { z: 0.28, y: 1.045, rx: 0.186, ry: 0.216 },
    { z: 0.44, y: 1.03, rx: 0.138, ry: 0.172, key: 1 },
  ],
  belly: [
    { z: -0.30, y: 0.885, rx: 0.105, ry: 0.045 },
    { z: -0.02, y: 0.870, rx: 0.118, ry: 0.050 },
    { z: 0.26, y: 0.885, rx: 0.108, ry: 0.045 },
  ],
  // The whitetail scut patch, low and small.
  rump: [
    { z: -0.48, y: 0.955, rx: 0.088, ry: 0.062 },
    { z: -0.60, y: 0.985, rx: 0.072, ry: 0.052 },
  ],
  // A deer's neck is a wedge, thick where it leaves the chest and only
  // slightly narrower at the skull. Tapering it to a stalk is what turned the
  // first pass into a camelid — but so does making it a column, which is what
  // the over-thick version read as at three metres.
  neckProfile: [
    { rx: 0.126, ry: 0.158 },
    { rx: 0.104, ry: 0.126 },
    { rx: 0.082, ry: 0.096 },
    { rx: 0.070, ry: 0.080 },
  ],
  // The skull has to be a mass of its own — narrower than the neck it sits on
  // and the animal reads as a llama however good the body is.
  headProfile: [
    { dy: -0.008, dz: -0.098, rx: 0.074, ry: 0.080 },
    { dy: 0.002, dz: -0.016, rx: 0.090, ry: 0.100 },
    { dy: -0.010, dz: 0.070, rx: 0.062, ry: 0.066 },
    { dy: -0.034, dz: 0.152, rx: 0.046, ry: 0.047, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.052, dz: 0.198, rx: 0.038, ry: 0.036, mix: MIX.dark },
  ],
  // A wafer-thin ear vanishes from every angle except dead side-on, which is
  // the one angle the player is least often at. Cupped, so it survives being
  // eight pixels of silhouette on top of the skull.
  ear: { at: [0.070, 0.054, -0.030], dir: [0.60, 0.75, -0.28], len: 0.185, w: 0.062, h: 0.040 },
  // The white scut is a deer's signature at any distance, so it is a broad flat
  // paddle rather than a thin rope — it has to catch light when it lifts.
  // Hangs, rather than sticking out behind. A level tail on a calm animal reads
  // as a spike welded to the rump; the whole point of the scut is that it is
  // *down* until the animal is frightened, and then suddenly up.
  // Long enough that raising it clears the rump. At 0.21 m the flag stood up
  // and stayed hidden behind the animal's own backside, which is worse than
  // not flagging at all — the motion is there and the signal is not.
  tail: [[0, 1.00, -0.66], [0, 0.88, -0.72], [0, 0.72, -0.78]],
  // Broad enough to read as a flag at a hundred metres. A thin rope of a tail
  // flashes nothing, and the flash is the only signal a fleeing deer gives.
  tailR: [0.052, 0.082], tailFlat: 0.38,
  tailMix: mixLerp(MIX.coat, MIX.pale, 0.28), tailTipMix: MIX.pale,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.148, 0.98, -0.42], knee: [0, -0.36, 0.12], hock: [0, -0.26, -0.16], foot: [0, -0.36, 0.04],
    rTop: 0.140, rMid: 0.062, rLow: 0.036, rFoot: 0.026, flat: 0.82,
    hoofH: 0.055, hoofR: 0.036, hoofLong: 1.35, hoofFwd: 0.008, sockTop: 0.5,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.138, 1.06, 0.30], knee: [0, -0.36, -0.10], hock: [0, -0.28, 0.10], foot: [0, -0.42, 0.0],
    rTop: 0.120, rMid: 0.055, rLow: 0.033, rFoot: 0.025, flat: 0.82,
    hoofH: 0.055, hoofR: 0.034, hoofLong: 1.35, hoofFwd: 0.008, sockTop: 0.5,
  },
});

// Antlers only exist on the stag variant, so they are carried by the variant
// rather than living in the base blueprint — `buildVariants` grafts whatever
// rack a variant names onto its copy of the blueprint, and no other species
// names one.
//
// Heavier than life. A real beam is 4 cm across at the burr, which at the size
// a stag occupies on screen is a scratch; the rack has to survive being eight
// pixels of silhouette, so it is thickened and shortened until it reads as a
// mass rather than as a pair of twigs.
const STAG_ANTLER = {
  base: [0.052, 0.058, -0.038],
  out: 0.46, up: 0.82, back: -0.32,
  len: 0.40, r0: 0.028, r1: 0.012, tineEvery: 2,
};

export const DEER = {
  key: 'deer',
  // How the logbook names the species ("Deer seen"). Carried here rather
  // than in the UI so a new species arrives in the logbook the moment it
  // exists — the one thing a table walk cannot derive is an English plural.
  plural: 'Deer',
  variants: [
    { name: 'doe', scale: 0.94, antler: false, weight: 0.46,
      col: { coat: 0x734e34, pale: 0xb5a184, dark: 0x3c2820, horn: 0x9c8763 } },
    { name: 'yearling', scale: 0.80, antler: false, weight: 0.26,
      col: { coat: 0x845c3b, pale: 0xbdaa88, dark: 0x422d1f, horn: 0x9c8763 } },
    { name: 'stag', scale: 1.10, antler: STAG_ANTLER, weight: 0.20,
      col: { coat: 0x5b3c22, pale: 0xa39077, dark: 0x30201a, horn: 0xa08c68 } },
    { name: 'dark doe', scale: 0.97, antler: false, weight: 0.08,
      col: { coat: 0x543a29, pale: 0xa39077, dark: 0x2d1f18, horn: 0x9c8763 } },
  ],
  blueprint: BLUEPRINT,
  // Behaviour numbers live with the species so a tweak is one edit.
  gait: {
    walk: 1.25, trot: 3.4, run: 10.5,
    strideBase: 1.05, strideGain: 2.7, dutyWalk: 0.63, dutyTrot: 0.50, dutyRun: 0.30,
    bobAmp: 0.038, pitchAmp: 0.055, liftScale: 1.0,
    grazeAng: 1.20, grazeRake: 1.25,
  },
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

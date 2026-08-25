// ─────────────────────────────────────────────────────────────────────────────
//  dog — the camp dog. Deliberately NOT one of the wild species.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';
import { buildVariants } from './quadruped.js';

// Dog. The camp dog, drawn from reference-art/dog: a lean medium mongrel with
// a deep chest, a hard tuck-up behind the ribs, long clean legs, a sickle tail
// and — the thing that actually identifies it — enormous upright triangular
// ears with dark backs.
//
// It is the closest animal in the game to the camera, which changes what the
// numbers are for. A deer is tuned for a silhouette at 77 m; this one is tuned
// for three metres across a fire, so the muzzle, the stop, the tuck-up and the
// collar all have to survive being looked at directly.
const BLUEPRINT = () => ({
  key: 'dog',
  // ── the one measurement that matters ──────────────────────────────────────
  //
  // Body length (point of shoulder to point of buttock) over withers height is
  // 0.88 on the reference dog, measured off `standing.png`. The first cut of
  // this blueprint came out at 1.08 — a fifth too long — and the effect was
  // not "a slightly long dog", it was a deer: chest depth and ground clearance
  // were already right, so the extra length had nowhere to go but the topline,
  // and a long level back on tall legs is a cervid whatever the head says.
  // Every z below is that correction; the heights are untouched.
  pelvis: [0, 0.415, -0.165],
  spine: [[0, 0.425, -0.052], [0, 0.428, 0.070]],
  chest: [0, 0.432, 0.175],
  // Carried at about 40° off horizontal, the way a standing dog holds it. Long
  // enough that the head can reach the ground to sniff without the throat
  // folding into the chest — the same trap the deer's neck was written around.
  // Steep. A dog carries its head clearly ABOVE the topline, and the first cut
  // of this rose at 40° which put the skull level with the withers — the whole
  // animal then read as one long horizontal mass with a nose on the front,
  // which is a weasel, not a dog. At 54° the head sits up where it belongs and
  // the body stops looking twice as long as it is.
  // Short. This dog's neck is a thick wedge that flows out of the shoulder over
  // a very small distance — the second reference photo (in the creek) shows it
  // clearly, and the previous 0.26 m span read as a lurcher's.
  neck: [[0, 0.492, 0.218], [0, 0.560, 0.266]],
  head: [0, 0.605, 0.298],
  rumpTip: false,
  barrel: [
    // The croup falls away to the tail root rather than ending square. Without
    // the slope the back is a plank from the shoulder to the backside.
    { z: -0.252, y: 0.393, rx: 0.058, ry: 0.064 },
    // The haunch. A dog's widest point behind the ribs, and what stops the
    // back half reading as a tube.
    { z: -0.204, y: 0.412, rx: 0.101, ry: 0.104, key: 1 },
    // The tuck-up: waisted, and shallower than anything either side of it.
    // This one station is most of what separates a dog from a small deer.
    { z: -0.087, y: 0.428, rx: 0.084, ry: 0.098, key: 1 },
    { z: 0.017, y: 0.420, rx: 0.094, ry: 0.127 },
    // The brisket, deepest just behind the elbow and laterally compressed —
    // a dog's chest is an oval standing on its end, not a barrel.
    { z: 0.113, y: 0.412, rx: 0.099, ry: 0.146, key: 1 },
    { z: 0.204, y: 0.424, rx: 0.096, ry: 0.134 },
    { z: 0.270, y: 0.432, rx: 0.066, ry: 0.096, key: 1 },
  ],
  // Cream from the brisket back along the belly, which is where the reference
  // dog's tan stops.
  belly: [
    { z: -0.139, y: 0.330, rx: 0.056, ry: 0.026 },
    { z: 0.00, y: 0.312, rx: 0.066, ry: 0.030 },
    { z: 0.139, y: 0.296, rx: 0.064, ry: 0.030 },
  ],
  // Thick where it leaves the chest — a dog's neck flows out of the shoulder
  // rather than being socketed into it, and a narrow first station left a
  // visible step at the withers.
  neckProfile: [
    { rx: 0.086, ry: 0.100 },
    { rx: 0.070, ry: 0.080 },
    { rx: 0.056, ry: 0.060 },
    { rx: 0.047, ry: 0.049 },
  ],
  // The skull: a broad cranium, a real stop, and a muzzle that stays square
  // rather than tapering to a deer's point. Bigger than the first cut all
  // round — a dog's head is a large fraction of it, and a small one on this
  // neck read as a whippet.
  // DEEP, not wide. A dog's head in profile is a tall wedge — a deep skull over
  // a deep muzzle with real jaw under it — and the first cut had the right plan
  // view and half the height, which read as a squashed weasel. Every `ry` here
  // is about 25% up on its `rx`; widening instead would have made it a toad.
  headProfile: [
    { dy: -0.006, dz: -0.056, rx: 0.048, ry: 0.061 },
    { dy: 0.008, dz: -0.014, rx: 0.058, ry: 0.071 },
    // The stop — a distinct narrowing where the skull gives way to the muzzle.
    { dy: -0.010, dz: 0.030, rx: 0.040, ry: 0.055 },
    // Blunt. A dog's muzzle is a squared-off box, and tapering it those last
    // two centimetres is the whole difference between this and a fox.
    { dy: -0.030, dz: 0.072, rx: 0.033, ry: 0.041, mix: mixLerp(MIX.coat, MIX.pale, 0.72) },
    { dy: -0.042, dz: 0.106, rx: 0.029, ry: 0.033, mix: mixLerp(MIX.coat, MIX.pale, 0.80) },
  ],
  // The nose is its own bulb rather than the muzzle tapering to a point — see
  // the note in buildQuadruped. Dark brown eyes set just behind the stop.
  muzzleTip: false,
  // Taller with the rest of the head, and carrying the pink patch on the dog's
  // own LEFT — the fifth colour, see `uSpot`. It is a real marking on the real
  // dog, and the one thing on this model that is a portrait rather than a breed.
  nose: { at: [-0.048, 0.117], r: 0.021, flat: 0.95, spot: { side: -1, size: 0.34, feather: 0.22 } },
  // Sat ON the skull, not in it. The first placement put the centre at 0.72 of
  // the cranium's own ellipse, so the entire ball was interior and the dog had
  // no eyes at all — the loft is only a few millimetres across and there is no
  // margin for being approximately right.
  eye: { at: [0.043, 0.016, 0.019], r: 0.0128, ry: 0.0106, shade: 0.58 },
  // Big, upright, set wide and carried a little FORWARD, with dark backs.
  // Authored base-to-tip rather than with the default pale/dark split: on this
  // dog the whole ear is dark against a pale skull, and that contrast IS the
  // animal. The first cut leaned them back at -0.14 z and they read as fins off
  // the back of the neck.
  ear: {
    at: [0.034, 0.040, -0.008], dir: [0.28, 0.94, 0.17],
    len: 0.126, w: 0.049, h: 0.028,
    mixBase: mixLerp(MIX.coat, MIX.dark, 0.35), mixTip: MIX.dark,
  },
  collar: { t: 0.60, grow: 1.13, len: 0.030 },
  // A sickle: thick at the root, tapering, hanging down off a sloped croup and
  // hooking up at the tip. Long — the first cut was a 0.29 m stub that read as
  // a docked tail, and the hook is the whole shape.
  tail: [[0, 0.383, -0.257], [0, 0.316, -0.330], [0, 0.274, -0.404], [0, 0.290, -0.470]],
  tailR: [0.026, 0.010], tailFlat: 1,
  tailMix: MIX.coat, tailTipMix: mixLerp(MIX.coat, MIX.pale, 0.55),
  // A dog's hind leg is heavily angulated — a big thigh, the stifle carried
  // well forward and the hock well back — and that Z shape is most of what
  // reads as "dog" from behind. `rTop` is deliberately more than twice `rMid`:
  // the thigh is a mass, the second link is a shin.
  // Thicker than the first cut all the way down, which had the leg radii
  // carried over from the deer's and made a dog on knitting needles. A dog
  // carries real muscle to the hock and a real pastern below it; the taper
  // still runs top to bottom, it just starts and ends heavier.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.062, 0.410, -0.170], knee: [0, -0.148, 0.058], hock: [0, -0.120, -0.080], foot: [0, -0.136, 0.026],
    rTop: 0.094, rMid: 0.042, rLow: 0.027, rFoot: 0.022, flat: 0.86,
    hoofH: 0.021, hoofR: 0.027, hoofLong: 1.8, hoofFwd: 0.016, sockTop: 0.34,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.058, 0.430, 0.165], knee: [0, -0.158, -0.038], hock: [0, -0.130, 0.040], foot: [0, -0.138, 0.0],
    rTop: 0.078, rMid: 0.040, rLow: 0.026, rFoot: 0.022, flat: 0.88,
    hoofH: 0.021, hoofR: 0.026, hoofLong: 1.7, hoofFwd: 0.014, sockTop: 0.34,
  },
});

// The camp dog is NOT in `SPECIES`, and that is load-bearing rather than
// tidiness. `Wildlife` iterates `Object.keys(SPECIES)` to build prototypes, to
// size its mesh pool and to scatter home sites across the valley — so a dog in
// that table would be a wild animal living on the forest edge, and would also
// read `CFG.dog` and find nothing. The dog belongs to a camp; `src/camp/
// camp_dog.js` owns when one exists.
export const DOG_SPECIES = {
  key: 'dog',
  variants: [
    // The reference dog, and the common one.
    { name: 'tan', scale: 1.00, weight: 0.60,
      col: { coat: 0xa9754a, pale: 0xd7c7ae, dark: 0x2e2018, horn: 0x8a5a2e } },
    // Two litter-mates, so a second camp is not the same dog again. Same build,
    // different wash — a paler cream one and a darker red one.
    { name: 'cream', scale: 0.96, weight: 0.22,
      col: { coat: 0xbe9463, pale: 0xded2bc, dark: 0x33261b, horn: 0x7d5430 } },
    { name: 'red', scale: 1.04, weight: 0.18,
      col: { coat: 0x8e5730, pale: 0xc4b096, dark: 0x261a12, horn: 0x6f4526 } },
  ],
  blueprint: BLUEPRINT,
  // A dog at camp trots and mills; it is never fleeing anything. `run` is here
  // because the gait ladder needs a third rung, not because it is ever used.
  gait: {
    walk: 0.95, trot: 2.6, run: 6.5,
    strideBase: 0.62, strideGain: 2.4, dutyWalk: 0.62, dutyTrot: 0.50, dutyRun: 0.32,
    bobAmp: 0.020, pitchAmp: 0.038, liftScale: 1.05,
    grazeAng: 1.32, grazeRake: 1.40,
  },
};

/** The camp dog's prototypes — same builder, kept out of the wild table. */
export function buildCampDog(seed) {
  return buildVariants(DOG_SPECIES, 'dog', seed);
}

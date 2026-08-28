// ─────────────────────────────────────────────────────────────────────────────
//  yak — the black mass on the high bench.
//
//  Everything one animal is: the blueprint (the profile arrays that are the
//  actual art), the coat variants, the gait ladder and the brain numbers.
//  `quadruped.js` turns the blueprint into geometry; nothing in here knows
//  how that is done, and nothing in there knows about this animal.
//
//  The second of the two alpine species. Same country as the goat and the same
//  `rock` block in `brain`, but a different half of it: a goat wants the crag
//  and a yak wants the bench beside it, so the two share a mountain without
//  standing in the same places. Read the goat's file first — the `rock` block
//  is documented there.
// ─────────────────────────────────────────────────────────────────────────────
import { MIX, mixLerp } from '../animal_rig.js';
import { clamp01 } from '../../core/MathUtils.js';

// The pale brow. A yak's face is black except for a bar of near-white across
// the forehead and around the muzzle, and that bar is the only high value on
// the animal — at range it is what tells you which end is the head. `mix` is
// resolved per RING and cannot say "the top of the skull only", so this is the
// raccoon's mask machinery run the other way up: `sa` is the +Y component of
// the ring angle, so the weight is 1 on the crown and 0 by the time the ring
// has come round to the cheek. `uSpot` is the fifth colour and nothing else on
// this animal uses it.
const BROW = (a, ca, sa) => clamp01((sa - 0.42) / 0.30);

// Yak. Measured off a reference mesh (a Himalayan yak scan) rather than
// guessed, because two passes of guessing produced a pig: the numbers below are
// that mesh sliced at 3-unit intervals and rescaled so its withers land on this
// blueprint's 1.49. What the measuring changed, in order of how much it
// mattered:
//
//   · **The head is enormous and it hangs.** Poll at 1.24 — a hand below the
//     top of the hump — and the muzzle at 0.75, so the face is a near-vertical
//     plane half a metre tall. Both earlier passes built a horizontal tube half
//     that size and stuck it on the front, which is what a snout is.
//   · **The neck does not slope.** It runs forward almost level off the hump
//     and the head drops off the END of it. Sloping the neck down and then
//     pointing the head forward — the obvious reading of "low head" — gives a
//     boar's line, not a yak's.
//   · **The body is longer and the legs are further apart.** Hooves at z 0.30
//     and -0.96 against the 0.40 / -0.60 of the guessed version; the barrel
//     runs to -1.48 rather than -0.90. A yak is not a round animal.
//
// What survived unchanged is the coat: the measured hem sits at 0.27-0.32 the
// whole length of the flank, which is what the first pass had already authored.
const BLUEPRINT = () => ({
  key: 'yak',
  // ── the coat, as geometry ──────────────────────────────────────────────────
  //
  // The barrel above is BULK: a low hem and a big dark mass. That reads as a
  // heavy animal and it does not read as a hairy one, which on this species is
  // most of the point. `coat` is what makes it hairy — a radius ripple on every
  // body ring (see `tube`) that breaks the surface into locks and turns the
  // bottom silhouette edge into a row of points instead of a moulded line. It
  // costs no draw call and no extra ring; it moves vertices already there.
  //
  // The numbers went through three readings and the last two are the lesson.
  //
  // `n` alone grooves the RING, which on a flank draws lines head-to-tail:
  // corduroy running the wrong way, a moulded surface with stripes on it.
  // Adding `nz` — 34 radians per metre of body, a lock every 18 cm ALONG the
  // animal — gives the direction hair actually falls. But at equal strength
  // the two cross at right angles over the whole flank and the yak came out
  // QUILTED, which is worse than either: a regular lattice reads as fabric.
  //
  // So the axial term carries most of the amplitude, the ring term is left as
  // a small break-up, and `twist` leans the axial grooves a radian and a half
  // round the ring so they never line up into clean bands. Irregular is the
  // whole trick; a coat has no period.
  //
  // `bias: 0.30` keeps it off the spine, because hair hangs; a rippled back is
  // corrugated iron.
  //
  // `radialMul` pays for the ring term — eight grooves want about three ring
  // vertices each against the cast's twenty in total (see its note in
  // `quadruped.js`). The only animal in the game that asks, for ~1 200
  // triangles.
  radialMul: 1.4,
  coat: { n: 8, amp: 0.020, nz: 34, ampZ: 0.050, twist: 1.5, bias: 0.30 },
  pelvis: [0, 0.98, -0.98],
  spine: [[0, 1.00, -0.50], [0, 1.03, -0.02]],
  chest: [0, 1.10, 0.42],
  // Forward and LEVEL. See the header — this is the bone chain that stops the
  // animal reading as a boar, and it climbs slightly rather than dropping.
  neck: [[0, 1.16, 0.55], [0, 1.21, 0.66]],
  // The poll, where the skull actually pivots. Everything in `headProfile`
  // hangs off it and downward.
  head: [0, 1.24, 0.75],
  rumpTip: false,
  // ── the skirt ──────────────────────────────────────────────────────────────
  //
  // A yak is mostly hair, and the hair is not a texture — it is the shape. The
  // coat hangs off the flanks in a curtain that stops a hand's breadth off the
  // ground, so the underside of the silhouette is a long low straight line with
  // four short columns showing under it, and the animal reads as a black slab
  // on legs.
  //
  // Each station is really a pair of numbers — where the BACK is and where the
  // HAIR ENDS — and `y`/`ry` are their midpoint and half-difference, because
  // that is what the loft wants. Measured off the reference mesh and written
  // out here so the two lines are readable:
  //
  //     z      back    hem            z      back    hem
  //    0.66    1.31    0.69         -0.44    1.28    0.28
  //    0.54    1.45    0.61         -0.66    1.29    0.33   the waist
  //    0.42    1.49    0.57         -0.86    1.31    0.27   the haunch
  //    0.28    1.49    0.31          -1.06    1.29    0.29
  //    0.10    1.46    0.28          -1.24    1.27    0.27
  //   -0.06    1.39    0.27          -1.38    1.12    0.32
  //   -0.24    1.32    0.28          -1.48    0.83    0.43
  //
  // Read the right-hand column on its own: from the brisket to the tail the hem
  // barely moves, and it sits about a hand off the ground. That flat low line
  // under a back that peaks at the shoulder is the whole animal — everything a
  // cow's silhouette does between its front and back legs, a yak's coat fills
  // in.
  //
  // The width column has a story too: 0.38 through the barrel, pinched to 0.29
  // at z -0.66 and back out to 0.39 over the haunch. That waist in front of the
  // hindquarters is the only place a yak is not a slab, and losing it is what
  // makes a heavy animal read as inflated.
  //
  // `k` is the superellipse exponent on the cross-section, and at 0.82 these
  // rings are square-shouldered rather than oval: the flank of a curtain of
  // hair is a flat slab, not the side of a barrel. Not lower than that, and the
  // reason is flat shading — `k` squares the WHOLE ring, top included, and at
  // 0.70 the back became a flat plate whose facets tilt with every change in
  // `ry`. The flank is worth some squareness; the spine is not.
  barrel: [
    { z: 0.66, y: 1.000, rx: 0.245, ry: 0.310, shag: 0.00, key: 1 },
    { z: 0.54, y: 1.030, rx: 0.292, ry: 0.420, k: 0.90, shag: 0.55 },
    { z: 0.42, y: 1.030, rx: 0.315, ry: 0.460, k: 0.86, shag: 0.90, key: 1 },
    { z: 0.28, y: 0.900, rx: 0.358, ry: 0.590, k: 0.84, key: 1 },   // the hump
    { z: 0.10, y: 0.870, rx: 0.381, ry: 0.590, k: 0.82 },
    { z: -0.06, y: 0.830, rx: 0.378, ry: 0.560, k: 0.82, key: 1 },
    { z: -0.24, y: 0.800, rx: 0.350, ry: 0.520, k: 0.82 },
    { z: -0.44, y: 0.780, rx: 0.322, ry: 0.500, k: 0.82, key: 1 },
    { z: -0.66, y: 0.810, rx: 0.294, ry: 0.480, k: 0.84 },          // the waist
    { z: -0.86, y: 0.790, rx: 0.386, ry: 0.520, k: 0.84, key: 1 },  // the haunch
    { z: -1.06, y: 0.790, rx: 0.380, ry: 0.500, k: 0.86 },
    { z: -1.24, y: 0.770, rx: 0.330, ry: 0.500, k: 0.90, key: 1 },
    { z: -1.38, y: 0.720, rx: 0.240, ry: 0.400, shag: 0.55 },
    { z: -1.48, y: 0.630, rx: 0.150, ry: 0.200, shag: 0.00, key: 1 },
  ],
  // No belly panel. That tube is a pale inset one (see `quadruped.js`) and a
  // lamp slung under a black animal is exactly wrong here — the underside of a
  // yak is the darkest part of it. The barrel above already IS the belly line.
  belly: null,
  // The neck is a WEDGE, not a tube: 0.9 deep where it leaves the hump and half
  // that where it meets the skull, and `dy` carries every ring well below the
  // bone chain so the mane and the brisket hair hang under it. Measured back:
  // 1.48 down to 1.29, hem 0.58 up to 0.71.
  // `shag` runs the coat ripple down the mane and switches it off at the poll:
  // a yak's neck is the hairiest part of it and its face is not hairy at all,
  // and a rippled skull reads as a walnut.
  neckProfile: [
    { rx: 0.310, ry: 0.450, dy: -0.170, shag: 1.00 },
    { rx: 0.295, ry: 0.400, dy: -0.145, shag: 1.00 },
    { rx: 0.255, ry: 0.310, dy: -0.170, shag: 0.70 },
    { rx: 0.220, ry: 0.245, dy: -0.130, shag: 0.15 },
  ],
  // ── the face ───────────────────────────────────────────────────────────────
  //
  // Half a metre of head hanging almost straight down off the poll. `dy` falls
  // 0.05 → -0.47 while `dz` runs 0.27 forward, which is a rake of 58° below
  // horizontal — measured, and steeper than either guess. That angle plus the
  // sheer size is the identification: from the side a yak's head is a tall dark
  // wedge under the horns, and from the front it is a flat plate of forehead
  // with a long muzzle dropped off the bottom of it.
  //
  // Widths do NOT run down in a straight taper, and that is the other half of
  // the difference between a face and a snout. There is a broad plate of
  // forehead between the horns, a pinch at the eyes, a muzzle that holds its
  // width, and a nose that ends WIDER than the bridge above it. `muzzleTip` is
  // off so the last ring is a flat pad rather than a point: a bovid's nose is a
  // slab of wet skin.
  muzzleTip: false,
  headProfile: [
    { dy: -0.051, dz: 0.032, rx: 0.235, ry: 0.245, spot: BROW },
    { dy: -0.135, dz: 0.086, rx: 0.210, ry: 0.240, spot: BROW },
    { dy: -0.220, dz: 0.140, rx: 0.177, ry: 0.233 },
    { dy: -0.304, dz: 0.193, rx: 0.143, ry: 0.196 },
    { dy: -0.380, dz: 0.242, rx: 0.125, ry: 0.148 },
    { dy: -0.4225, dz: 0.2685, rx: 0.119, ry: 0.124,
      mix: mixLerp(MIX.coat, MIX.pale, 0.45) },
    { dy: -0.4732, dz: 0.3007, rx: 0.088, ry: 0.082, mix: MIX.dark },
  ],
  // Tiny, and low and back on the skull under the horn boss — a yak's ears are
  // almost nothing next to the horns, and at 0.11 m they read as two triangular
  // flags standing off the back of the head.
  ear: { at: [0.180, -0.180, -0.050], dir: [0.85, 0.15, -0.30], len: 0.095, w: 0.050, h: 0.034 },
  // A horse's tail on a cow, and long: the reference hangs it from the top of
  // the rump at 1.26 down to 0.27, which is the hem. `tailR` GROWS toward the
  // tip — the squirrel's plume trick — because a tail that tapers reads as a
  // rope.
  tail: [[0, 1.140, -1.270], [0, 0.820, -1.370], [0, 0.500, -1.410]],
  tailR: [0.048, 0.092], tailFlat: 0.90,
  tailMix: MIX.coat, tailTipMix: MIX.dark, tailMixBias: 1.6,
  // Hooves at z 0.30 and -0.96 off the reference, which is a quarter of a body
  // longer in the wheelbase than the guessed version and most of why this now
  // reads as a big animal rather than a fat one. Zigzagged for the reason the
  // bear's header sets out: standing hip→hock sits at 78% (hind) and 82%
  // (fore) of what the chain can reach, so the joints bend all cycle instead of
  // locking straight.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.235, 1.00, -0.98], knee: [0, -0.32, 0.20], hock: [0, -0.26, -0.26], foot: [0, -0.42, 0.10],
    rTop: 0.205, rMid: 0.104, rLow: 0.070, rFoot: 0.052, flat: 0.88, k: 0.88,
    hoofH: 0.062, hoofR: 0.070, hoofLong: 1.35, hoofFwd: 0.012, sockTop: 0.35,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.255, 1.20, 0.25], knee: [0, -0.38, -0.22], hock: [0, -0.30, 0.26], foot: [0, -0.52, 0.04],
    rTop: 0.200, rMid: 0.100, rLow: 0.068, rFoot: 0.050, flat: 0.88, k: 0.88,
    hoofH: 0.062, hoofR: 0.068, hoofLong: 1.35, hoofFwd: 0.012, sockTop: 0.35,
  },
});

// Horns on both sexes, so this is blueprint-wide rather than variant data.
//
// The shape is the whole identification and it is a two-part move: the beam
// leaves the skull almost HORIZONTALLY, out and a little forward, and then
// turns up and slightly back, the tips finishing near vertical and canted in
// toward each other. `curl` is what says the second half — the default rack
// bends down over its length, which on a sideways start gives a buffalo's
// droop rather than a yak's lyre. See ANTLER_CURL in `quadruped.js`.
const YAK_HORN = {
  // Measured off the reference: the boss sits at 0.21 out from the midline and
  // level with the poll, and the tip finishes 0.50 out and 0.33 higher, having
  // gone almost straight sideways for the first third. Base is relative to the
  // head bone, which IS the poll.
  base: [0.213, -0.116, -0.021],
  // Out, and very slightly down and back to start with.
  out: 0.95, up: -0.02, back: -0.06,
  // …then the turn, which is the whole shape. Without an authorable curl the
  // beam only ever bends DOWN over its length (see ANTLER_CURL in
  // `quadruped.js`) and a sideways start gives a buffalo's droop instead of a
  // yak's lyre. `out` negative brings the tips back in toward each other.
  curl: { up: 1.55, fwd: -0.05, out: -0.55 },
  // Thick at the boss and long — a metre from tip to tip on a bull. At the size
  // this animal occupies on screen a scale-accurate horn is a scratch, and the
  // pair of them is most of what says "yak" rather than "big dark cow" at
  // eighty metres.
  len: 0.48, r0: 0.048, r1: 0.010, tineEvery: 99,
};

export const YAK = {
  key: 'yak',
  plural: 'Yaks',
  // Dark, but not at silhouette value — the bear's palette note is the full
  // argument and it applies twice as hard here, because this is a bigger animal
  // that the player can walk right up to. `uSilNear/uSilFar` already collapse
  // the whole thing toward `dark` with range; authoring the near coat down
  // there as well would buy the same silhouette twice and cost every bit of
  // form on a yak four metres away.
  variants: [
    { name: 'cow', scale: 0.96, antler: YAK_HORN, weight: 0.42,
      col: { coat: 0x584338, pale: 0x9c8a72, dark: 0x241c18, horn: 0xa8977a, spot: 0xded5bf } },
    { name: 'bull', scale: 1.14, antler: YAK_HORN, weight: 0.28,
      col: { coat: 0x4d3b32, pale: 0x8d7c66, dark: 0x1f1915, horn: 0xb3a184, spot: 0xe4dcc8 } },
    { name: 'calf', scale: 0.66, antler: YAK_HORN, weight: 0.18,
      col: { coat: 0x66503f, pale: 0xa8967c, dark: 0x2b2119, horn: 0x9d8d72, spot: 0xd6ccb6 } },
    // The dun one. Rarer, and the only yak the eye picks out of a group at
    // distance — a herd of four identical black shapes reads as one shape.
    { name: 'dun', scale: 1.02, antler: YAK_HORN, weight: 0.12,
      col: { coat: 0x7a5f47, pale: 0xbfa98a, dark: 0x352a20, horn: 0xb5a488, spot: 0xe0d7c1 } },
  ],
  blueprint: BLUEPRINT,
  gait: {
    walk: 0.95, trot: 2.3, run: 5.6,
    strideBase: 1.08, strideGain: 1.6, dutyWalk: 0.72, dutyTrot: 0.60, dutyRun: 0.40,
    bobAmp: 0.030, pitchAmp: 0.028, liftScale: 0.65,
    // More reach than the first pass asked for, and the measured head is why:
    // the poll now sits at 1.24 instead of 0.98, so the same fold leaves the
    // muzzle a quarter of a metre higher than it used to.
    grazeAng: 1.40, grazeRake: 1.55,
  },
  brain: {
    // Even less bothered than the goat, for the bear's reason rather than the
    // goat's: nothing up here hunts a 500 kg animal, so it looks up, it chews,
    // and it goes back to what it was doing. The freeze is long because a
    // standing yak seen broadside is the most legible thing on the mountain.
    alertDist: 26, fleeDist: 8, calmDist: 46, noticeDist: 60,
    hintDist: 88,
    freezeTime: [1.4, 3.2], fleeTime: [2.2, 4.5],
    grazeTime: [12, 30], idleTime: [4, 11], walkTime: [8, 20],
    herd: [2, 4], herdRadius: 10, wanderRadius: 30,
    grazeChance: 0.60,
    // See the goat's `rock` block for what each of these does. The differences
    // are the species: a yak is heavier, so it wants gentler ground (the
    // benches and the aprons rather than the crag face), it starts lower down
    // the mountain, and it climbs less often and picks flatter rocks when it
    // does — a yak on a boulder is a yak on a plinth, not a yak on a spire.
    rock: {
      slopeMax: 1.05, slopeSoft: 0.75,
      // …and a yak wants the apron BESIDE the rock, so it reads the strongest
      // rock process within a cell of the point (32 m) instead of on it. That
      // one number is most of what separates the two species' ground: a yak on
      // a bench under a crag, a goat on the crag.
      altBand: [125, 195], rockGain: 1.70, slopeBest: [0.35, 0.72], nearCells: 1,
      // Bigger animal, so a bigger plinth and a shallower one: a yak hauling
      // itself onto a 3 m spire is not a thing, and a broad low block it can
      // simply step up onto is. See the goat's file for what each of these
      // rejects and why.
      search: 48, minSize: 0.60, rise: [0.65, 2.60], maxR: 7.5, steep: 0.20,
      reach: 45, snap: 25,
      climbChance: 0.30, perchTime: [14, 40], orbit: 0.45,
    },
  },
};

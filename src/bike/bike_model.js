// ─────────────────────────────────────────────────────────────────────────────
//  bike_model — a procedural bicycle, in two builds and four colourways.
//
//  ── what has to read, and at what distance ─────────────────────────────────
//
//  A bicycle is the thinnest object this game draws. At fifteen metres — the
//  distance a bike is parked at the edge of a camp and looked at — the whole
//  thing is two circles, a triangle and a line, and every decision below is
//  about keeping those four shapes alive:
//
//   1. **The wheels are circles, not polygons.** 28 segments round the tyre and
//      a rim built as a torus rather than a faceted ring. This is the one place
//      the camp kit's always-facet `Parts` would have shipped a visible defect,
//      and it is why `BikeParts` exists.
//   2. **The frame is a closed diamond with a hole in it.** You can see the
//      grass through the main triangle and through the rear one. The moment
//      those fill in, the object is a scooter. Tube diameters are therefore
//      held at real sizes (a 35 mm down tube, a 22 mm seat stay) even though
//      fatter tubes would survive distance better — a fat diamond is a moped.
//   3. **One bright line down every tube.** See `bike_materials`: the frame is
//      the glossiest dielectric in the game and the rims and spokes are proper
//      metals with a sky probe behind them. Without a highlight a 30 mm tube at
//      fifteen metres is a grey smudge.
//   4. **The bars are as wide as the bike is long is wrong.** A 760 mm bar on a
//      1.10 m wheelbase reads correctly from behind (which is the riding view)
//      and reads as a shopping trolley in plan. It is 700 mm here, and the
//      grips are dark so the silhouette tapers into them.
//
//  ── the two builds, and why they are both mountain bikes ───────────────────
//
//  There is not a metre of pavement in this valley. The roads the camper drives
//  are dirt tracks through a forest and everything either side of them is
//  meadow, scree and root — so a drop-bar tourer is not a variant of this
//  object, it is a different game's object, and a player who found one parked
//  at a camp would rightly read it as a mistake (user direction, 2026-09-01).
//  Every build is therefore a mountain bike: flat or riser bar, knobbly tyres,
//  a slack front end, disc brakes.
//
//  `trail`  — a modern hardtail. Suspension fork more often than not, a wide
//             760 mm riser bar, 2.2-2.35" tyres. The bike somebody rides for
//             the sake of riding.
//  `packer` — the same mountain bike set up to carry things: a rigid fork, a
//             swept-back alt bar (still a flat bar — see above), the fattest
//             tyres in the set, and a rear rack with a dry bag on it. The bike
//             somebody rode here from somewhere.
//
//  The suspension fork is doing most of the work of telling them apart, and
//  that is on purpose: it is the one difference that survives being a hundred
//  pixels tall, because it changes the SILHOUETTE of the front end rather than
//  its colour.
//
//  They are one builder with branches rather than two files, unlike the tents
//  and the boats, because the difference is a fork, a bar and a tyre width. The
//  moment a third build wants a different FRAME that judgement flips.
//
//  ── the moving parts ───────────────────────────────────────────────────────
//
//  Four things move, and each is a Group with the geometry authored in bike
//  space beneath it so the model file never does trigonometry twice:
//
//    userData.wheels.front / .rear   spin about local X
//    userData.steer                  rotation.y — but see `steerMount`: the
//                                    steering axis is the head tube's, tilted
//                                    68° off horizontal, so the group is nested
//                                    inside a mount that tilts into that frame
//                                    and a body that tilts straight back out.
//                                    Rotating the fork about vertical instead
//                                    is the classic tell — the wheel leans the
//                                    wrong way on any real steering angle.
//    userData.cranks                 rotation.x
//    userData.stand                  rotation.x — the kickstand, folded up the
//                                    moment somebody gets on. A kickstand still
//                                    down at 8 m/s is the most visible thing
//                                    this model could get wrong. About X and
//                                    not Z: a side stand swings BACKWARD along
//                                    the chainstay, and a Z hinge can only move
//                                    it in the frontal plane — which sweeps the
//                                    leg through the rear wheel and leaves it
//                                    pointing at the ground on the other side.
//
//  Convention: +Z forward, +Y up, origin ON THE GROUND midway between the two
//  contact patches — the exported-model convention, not the procedural one, and
//  deliberately so: the physics puts this object on terrain by its wheels.
//  +X is the rider's left, so the drivetrain is on −X.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  BikeParts, at, rbox, tube, span, sweptArc,
  tintOf, tintFrom, mixRGB, mulRGB,
} from './bike_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ── the geometry table ───────────────────────────────────────────────────────
//
// Every number is a real bicycle's, in metres — a 29er trail hardtail in a
// medium frame — and the two that MATTER are the ones a bicycle's proportions
// are quoted in, because everything else is derived from them:
//
//   chainstay 435 mm   BB to rear axle. This is the number the first pass got
//                      badly wrong (276 mm), and it wrecks the whole object:
//                      the cranks end up beside the rear tyre, the saddle ends
//                      up over the rear axle, and the bike reads as a folding
//                      shopper with its back wheel tucked under the rider.
//   front centre 765   BB to front axle. With the chainstay that gives a
//                      1200 mm wheelbase, which is a modern 29er's.
//
// Everything below is placed off `BB` and the two axles, so correcting a
// proportion means correcting it here and nowhere else.
const WHEEL_R = 0.348;      // 622 mm rim + a 2.2" tyre
const RIM_R   = 0.302;      // outer edge of the rim wall
const HUB_R   = 0.026;
const CHAINSTAY = 0.435;
const REAR_Z  = -0.600;
const FRONT_Z =  0.600;
const BB      = V(0, 0.298, REAR_Z + CHAINSTAY);   // bottom bracket
const HEAD_TILT = 0.384;                  // rad off vertical — a 68° head angle
const HEAD_LEN = 0.135;
// How high the head tube's lower cup sits, and it is the fork's number rather
// than the frame's: a 29er suspension fork is about 470 mm axle-to-crown, so a
// crown 30 cm above a 348 mm wheel — which is what the first pass drew — is a
// child's fork with a mountain bike hanging off it. 765 mm puts axle-to-crown
// at 424 mm, which reads right and keeps the bars at the 925 mm a 1.70 m rider
// wants without a comedy stack of spacers.
const HEAD_Y = 0.765;
// …and its z, placed so a straight fork down the steering axis lands exactly on
// the front axle. Derived rather than typed: a hand-typed z here is a fork that
// misses its own dropouts the moment the head angle or the wheel size moves.
const HEAD_LO = V(0, HEAD_Y,
  FRONT_Z - Math.sin(HEAD_TILT) * ((HEAD_Y - WHEEL_R) / Math.cos(HEAD_TILT)));
// The steering axis, pointing up. Used to place the head tube, the steerer and
// the fork; the steer group is built around it in `steerRig`.
const AXIS = V(0, Math.cos(HEAD_TILT), -Math.sin(HEAD_TILT));
const HEAD_HI = HEAD_LO.clone().addScaledVector(AXIS, HEAD_LEN);
const SEAT_TILT = 0.279;                  // rad off vertical — a 74° seat angle
const SEAT_AXIS = V(0, Math.cos(SEAT_TILT), -Math.sin(SEAT_TILT));
const SEAT_TOP = BB.clone().addScaledVector(SEAT_AXIS, 0.462);
const CRANK = 0.175;

export const BIKE_DIM = {
  length: (FRONT_Z - REAR_Z) + WHEEL_R * 2,   // tyre edge to tyre edge
  width: 0.70,         // across the bars — the widest thing on the object
  wheelbase: FRONT_Z - REAR_Z,
  wheelR: WHEEL_R,
  seatY: 1.00,         // where the rider's hips are; the ride camera reads it
  barY: 0.925,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Colourways
//
//  Four, and the split is deliberate: two saturated (which is what a bike in a
//  photograph is FOR — it is the one man-made object in a frame of grass and
//  granite) and two muted, so a camp does not always shout. `frame` is the main
//  paint, `fade` the colour the paint runs to at the far end of the down tube —
//  every real bike has a fade, a decal band or a contrasting head tube, and a
//  single flat hue is the loudest "untextured" tell an object this glossy has.
// ─────────────────────────────────────────────────────────────────────────────
export const BIKE_COLORWAYS = [
  {
    name: 'Signal orange',
    frame: 0xd4571b, fade: 0xa8380f, head: 0x1d1f22, decal: 0xe8e2d2,
    rim: 0x2b2d30, hub: 0xb7bcc0, saddle: 0x1c1d20, grip: 0x232529,
    tyre: 0x1a1a1c, wall: 0x2c2a28, rack: 0x2a2c2f, bag: 0x4a5a4c,
  },
  {
    name: 'Cobalt',
    frame: 0x2a5c9a, fade: 0x16395f, head: 0xe4e0d4, decal: 0xe8e2d2,
    rim: 0xb2b7bb, hub: 0x2b2d30, saddle: 0x3b2a22, grip: 0x4a3428,
    tyre: 0x1a1a1c, wall: 0x6a5a44, rack: 0xb2b7bb, bag: 0x8a5a2c,
  },
  {
    name: 'Sage',
    frame: 0x7d8a6a, fade: 0x5c6650, head: 0x2a2c2e, decal: 0x2a2c2e,
    rim: 0x2b2d30, hub: 0xb7bcc0, saddle: 0x2a2320, grip: 0x2a2320,
    tyre: 0x1a1a1c, wall: 0x2c2a28, rack: 0x2a2c2f, bag: 0x8d5f3a,
  },
  {
    name: 'Raw silver',
    frame: 0xa9adb0, fade: 0x8a8e92, head: 0xb8352c, decal: 0xb8352c,
    rim: 0xb2b7bb, hub: 0x2b2d30, saddle: 0x1c1d20, grip: 0x1c1d20,
    tyre: 0x1a1a1c, wall: 0x2c2a28, rack: 0xb2b7bb, bag: 0x3a4550,
  },
];

const HEX_PLASTIC = 0x2a2a2e;
const HEX_CORD = 0xd8cfae;

/**
 * Build a bicycle.
 *
 * @param rnd   a seeded rng — the same one the camp layout used, so a bike
 *              parked at a given camp is the same bike every time it is built.
 * @param opts  { colorway, style: 'trail'|'packer', rack, bottle, susp, wear }
 */
export function buildBike(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'bike';
  const cw = BIKE_COLORWAYS[(opts.colorway ?? 0) % BIKE_COLORWAYS.length];
  const style = opts.style ?? (rnd() < 0.62 ? 'trail' : 'packer');
  const packer = style === 'packer';

  // ── the character draw, all up front ──────────────────────────────────────
  const wear = opts.wear ?? rnd();
  // Nothing here goes below 2.1". A 38 mm tyre is a road tyre and this valley
  // has no road; the range runs from a fast trail tyre to a loaded-tourer 2.6".
  const tyreW = packer ? 0.058 + rnd() * 0.010 : 0.050 + rnd() * 0.010;
  const hasRack = opts.rack ?? (packer ? rnd() < 0.90 : rnd() < 0.20);
  // A suspension fork is the strongest silhouette difference in the set, so it
  // is drawn deliberately rather than left to a shared coin: usually on a trail
  // bike, rarely on a loaded one (a rack and a suspension fork fight, and
  // people who tour on a hardtail mostly run it rigid).
  const susp = opts.susp ?? (packer ? rnd() < 0.22 : rnd() < 0.72);
  const hasBag = hasRack && rnd() < 0.62;
  const hasBottle = opts.bottle ?? (rnd() < 0.7);
  const hasBell = rnd() < 0.35;
  // A parked bike never has its cranks level or its bars dead ahead. These are
  // the two cheapest lines in the file and they do more for "somebody left this
  // here" than any amount of geometry.
  const crankPhase = rnd() * Math.PI * 2;
  const parkSteer = (rnd() - 0.5) * 0.5;

  const paintC = tintOf(cw.frame);
  const fadeC = tintOf(cw.fade);
  const headC = tintOf(cw.head);
  const decalC = tintOf(cw.decal);
  const rimC = tintOf(cw.rim);
  const hubC = tintOf(cw.hub);
  const tyreC = tintOf(cw.tyre);
  const wallC = tintOf(cw.wall);
  const gripC = tintOf(cw.grip);
  const saddleC = tintOf(cw.saddle);
  const rackC = tintOf(cw.rack);
  const boltC = tintOf(0xc6cacd);

  // Paint, graded along the bike. Warm at the front (where the head badge and
  // the decal band are), fading toward the rear triangle — plus dirt: the
  // lowest 90 mm of everything on a bike that lives outside is dust, and the
  // BACK of a bike is where the rear wheel throws it.
  const paintAt = (x, y, z) => {
    let c = mixRGB(fadeC, paintC, smoothstep(-0.45, 0.30, z));
    // the graphic band across the down tube
    const band = smoothstep(0.055, 0.030, Math.abs((z - 0.02) - (y - 0.50) * 0.62));
    c = mixRGB(c, decalC, band * 0.55 * (y > 0.34 && y < 0.72 ? 1 : 0));
    // dust up the back, heaviest low and behind the rear tyre's throw line
    const grime = clamp01(smoothstep(0.30, 0.05, y) * 0.7 + smoothstep(-0.05, -0.42, z) * 0.5);
    c = mixRGB(c, [0.34, 0.29, 0.22], grime * (0.14 + wear * 0.22));
    return c;
  };

  const P = new BikeParts('bike');

  // ── frame: the main triangle ──────────────────────────────────────────────
  //
  // Every member is a `tube` sized from the distance it actually spans, placed
  // by `span`. Diameters are the real ones — see note 2 in the header.
  const member = (a, b, r, key = 'paint', tint = paintAt, seg = 7) =>
    P.add(tube(r, a.distanceTo(b), seg), key, span(a, b), tint);

  const SEAT_LO = BB.clone().addScaledVector(SEAT_AXIS, 0.030);
  const TT_BACK = BB.clone().addScaledVector(SEAT_AXIS, 0.432);     // top tube, seat end
  const TT_FRONT = HEAD_HI.clone().addScaledVector(AXIS, -0.020);
  const DT_FRONT = HEAD_LO.clone().addScaledVector(AXIS, 0.028);

  member(SEAT_LO, SEAT_TOP, 0.0165);              // seat tube — 33 mm
  member(BB, DT_FRONT, 0.0180);                   // down tube — 36 mm, the mass
  member(TT_BACK, TT_FRONT, 0.0145);              // top tube, sloping
  // Head tube: a fat short barrel, and it takes the contrast colour on every
  // colourway. It is 135 mm of the object and it is the bit the eye lands on.
  P.add(tube(0.0230, HEAD_LEN + 0.02, 9), 'paint',
    span(HEAD_LO.clone().addScaledVector(AXIS, -0.01),
         HEAD_HI.clone().addScaledVector(AXIS, 0.01)), headC);
  // headset cups
  for (const p of [HEAD_LO, HEAD_HI]) {
    P.add(tube(0.0250, 0.016, 9), 'polish',
      span(p.clone().addScaledVector(AXIS, -0.008), p.clone().addScaledVector(AXIS, 0.008)),
      boltC, { facet: true });
  }

  // ── frame: the rear triangle ──────────────────────────────────────────────
  // Chain stays and seat stays, both sides. The dropouts are flat plates and
  // they are what makes the rear end read as a mechanism rather than as two
  // sticks meeting a circle.
  const SS_TOP = BB.clone().addScaledVector(SEAT_AXIS, 0.408);
  for (const s of [-1, 1]) {
    const drop = V(s * 0.062, WHEEL_R, REAR_Z);
    // the chain stay bows outward around the tyre before it reaches the BB
    P.add(sweptArc((t) => {
      const p = new THREE.Vector3().lerpVectors(BB.clone().add(V(s * 0.036, 0.004, 0)), drop, t);
      p.x += s * 0.020 * Math.sin(t * Math.PI);
      return p;
    }, 8, 0.0115, 6), 'paint', null, paintAt);
    member(SS_TOP.clone().add(V(s * 0.020, 0, 0)), drop.clone().add(V(0, -0.004, 0)), 0.0090);
    P.add(rbox(0.010, 0.072, 0.052, 0.006, 1), 'polish',
      at(s * 0.062, WHEEL_R + 0.004, REAR_Z + 0.006), boltC, { facet: true });
  }
  // bottom bracket shell
  P.add(tube(0.0210, 0.072, 9), 'polish', at(BB.x, BB.y, BB.z, 0, 0, Math.PI / 2),
    boltC, { facet: true });
  // seat clamp
  P.add(tube(0.0185, 0.018, 9), 'polish',
    span(SEAT_TOP.clone().addScaledVector(SEAT_AXIS, -0.009),
         SEAT_TOP.clone().addScaledVector(SEAT_AXIS, 0.009)), boltC, { facet: true });

  // ── seatpost and saddle ───────────────────────────────────────────────────
  const POST_TOP = SEAT_TOP.clone().addScaledVector(SEAT_AXIS, 0.243);
  member(SEAT_TOP.clone().addScaledVector(SEAT_AXIS, -0.02), POST_TOP, 0.0140, 'polish',
    mulRGB(tintOf(0x9aa0a4), 1), 8);
  buildSaddle(P, POST_TOP, saddleC, packer);

  // ── the drivetrain ────────────────────────────────────────────────────────
  // On −X, the rider's right, because that is where it is. The chainring is a
  // disc with a rim, not a cylinder: a solid disc at this size is a coin and
  // reads as one.
  const crankGrp = new THREE.Group();
  crankGrp.name = 'bike_cranks';
  crankGrp.position.copy(BB);
  {
    const K = new BikeParts('bike_cranks');
    for (const s of [-1, 1]) {
      const sgn = s < 0 ? 1 : -1;             // the two arms are 180° apart
      // arm: a flat blade from the axle out to the pedal eye. `rbox` is built
      // with its length on Z and rotated onto the crank's own radius; the arm
      // therefore sweeps with the group, which is the whole point of the group.
      K.add(rbox(0.020, 0.036, CRANK, 0.008, 1), 'polish',
        at(s * 0.040, sgn * CRANK * 0.5, 0, Math.PI / 2, 0, 0), boltC, { facet: true });
      // pedal: an axle out of the crank eye and a platform on it. It turns with
      // the crank rather than hanging level, which is what a pedal with a foot
      // on it does anyway and what an unloaded one does at any speed worth
      // drawing.
      K.add(tube(0.0085, 0.056, 6), 'chrome',
        at(s * 0.070, sgn * CRANK, 0, 0, 0, Math.PI / 2), boltC, { facet: true });
      K.add(rbox(0.092, 0.015, 0.094, 0.004, 1), 'plastic',
        at(s * 0.098, sgn * CRANK, 0), tintFrom(HEX_PLASTIC, 0x35373b), { facet: true });
    }
    // chainring: a ring — teeth read as a tone step at this size — plus a
    // four-arm spider, which is what stops it being a coin.
    K.add(new THREE.TorusGeometry(0.088, 0.0055, 4, 26), 'chrome',
      at(-0.058, 0, 0, 0, Math.PI / 2, 0), mulRGB(boltC, 0.92));
    K.add(tube(0.030, 0.008, 8), 'polish', at(-0.058, 0, 0, 0, 0, Math.PI / 2),
      boltC, { facet: true });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      // The ring lies in the YZ plane, so a radial member is rotated about X.
      // About Z — the obvious guess — puts every arm flat across the chainring.
      K.add(rbox(0.008, 0.062, 0.016, 0.003, 1), 'polish',
        at(-0.058, Math.sin(a) * 0.045, Math.cos(a) * 0.045, Math.PI / 2 - a, 0, 0),
        mulRGB(boltC, 0.88), { facet: true });
    }
    K.flush(crankGrp);
  }
  crankGrp.rotation.x = crankPhase;
  g.add(crankGrp);

  // chain — the top run to the cassette and the slack bottom run. Drawn on the
  // frame rather than on the cranks: it does not go round with them, and a
  // chain that orbits the bottom bracket is a memorable bug.
  {
    const rTop = V(-0.058, WHEEL_R + 0.048, REAR_Z);
    const rBot = V(-0.058, WHEEL_R - 0.048, REAR_Z);
    const chainC = mulRGB(tintOf(0x8e9295), 0.9);
    P.add(sweptArc((t) => new THREE.Vector3().lerpVectors(V(-0.058, BB.y + 0.088, BB.z), rTop, t),
      6, 0.0055, 4), 'chrome', null, chainC);
    P.add(sweptArc((t) => {
      const p = new THREE.Vector3().lerpVectors(V(-0.058, BB.y - 0.088, BB.z), rBot, t);
      p.y -= 0.012 * Math.sin(t * Math.PI);
      return p;
    }, 8, 0.0055, 4), 'chrome', null, chainC);
    // cassette
    P.add(tube(0.048, 0.032, 10), 'chrome', at(-0.052, WHEEL_R, REAR_Z, 0, 0, Math.PI / 2),
      mulRGB(boltC, 0.95), { facet: true });
    // rear derailleur cage — a small dark hook, but it is the object that says
    // this bike has gears
    P.add(rbox(0.012, 0.062, 0.030, 0.005, 1), 'plastic',
      at(-0.058, WHEEL_R - 0.072, REAR_Z + 0.012, 0.35, 0, 0),
      tintFrom(HEX_PLASTIC, 0x303236), { facet: true });
  }

  // ── the kickstand ─────────────────────────────────────────────────────────
  // Its own group, hinged at the chain stay on the LEFT (+X), so `Bike` can
  // fold it the instant somebody gets on. Down is rotation.z = 0.
  const standGrp = new THREE.Group();
  standGrp.name = 'bike_stand';
  standGrp.position.set(0.052, 0.268, REAR_Z + 0.24);
  {
    const S = new BikeParts('bike_stand');
    // ── the leg's length is an answer, not a taste ─────────────────────────
    //
    // `Bike` parks the bike by rolling it STAND_LEAN (0.22 rad) onto this leg,
    // so the tip has to reach the ground IN THAT POSE, not upright. Rolling a
    // point by −0.22 about +Z sends (x, y) to (0.976x + 0.218y, −0.218x +
    // 0.976y), so the tip is on the ground when y = 0.2233·x in the bike's own
    // frame. The first pass just guessed a length and buried the foot 4 cm
    // under the terrain.
    //
    // It follows that an UPRIGHT bike — which is what the gallery draws, and
    // what a ridden one is — holds this leg a few centimetres clear of the
    // ground. That is correct and not a defect: a kickstand only touches when
    // the bike is leaning on it, and the ride folds it up anyway.
    const TIPX = 0.167;
    const foot = V(TIPX - 0.052, 0.2233 * TIPX - 0.268, -0.048);
    S.add(tube(0.0085, foot.length(), 6), 'polish',
      span(V(0, 0, 0), foot), tintOf(0x8e9295), { facet: true });
    S.add(rbox(0.026, 0.014, 0.030, 0.005, 1), 'rubber',
      at(foot.x, foot.y, foot.z), tintFrom(0x1b1b1e, 0x232326), { facet: true });
    S.add(rbox(0.030, 0.028, 0.024, 0.006, 1), 'plastic', at(0, 0, 0),
      tintFrom(HEX_PLASTIC, 0x2e3034), { facet: true });
    S.flush(standGrp);
  }
  g.add(standGrp);

  // ── bottle cage ───────────────────────────────────────────────────────────
  if (hasBottle) {
    const mid = BB.clone().addScaledVector(SEAT_AXIS, 0.235).add(V(0.032, 0, 0));
    const up = SEAT_AXIS;
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const c = mid.clone().addScaledVector(up, -0.055 + t * 0.115);
      // A torus's hole runs down +Z, and the bottle runs up the seat tube, so
      // the ring is rotated onto that axis: −π/2 about X takes +Z to +Y, and
      // the extra −SEAT_TILT lays it back with the tube.
      P.add(new THREE.TorusGeometry(0.034, 0.0032, 4, 12, Math.PI * 1.25), 'chrome',
        at(c.x, c.y, c.z, -Math.PI / 2 - SEAT_TILT, 0, 0), tintOf(0x9aa0a4));
    }
    const bTop = mid.clone().addScaledVector(up, 0.098);
    const bBot = mid.clone().addScaledVector(up, -0.062);
    P.add(tube(0.031, bTop.distanceTo(bBot), 10), 'plastic', span(bBot, bTop),
      tintFrom(HEX_PLASTIC, 0x7d8b93));
    P.add(tube(0.014, 0.030, 8), 'plastic',
      span(bTop, bTop.clone().addScaledVector(up, 0.030)),
      tintFrom(HEX_PLASTIC, 0x25272a), { facet: true });
  }

  // ── the rear rack, and what is strapped to it ─────────────────────────────
  if (hasRack) buildRack(P, cw, rackC, hasBag, rnd, REAR_Z, WHEEL_R, SS_TOP);

  P.flush(g);

  // ── wheels ────────────────────────────────────────────────────────────────
  const rearWheel = buildWheel(rnd, {
    tyreW, tyreC, wallC, rimC, hubC, boltC, knobs: true, disc: 'left',
  });
  rearWheel.position.set(0, WHEEL_R, REAR_Z);
  g.add(rearWheel);

  const frontWheel = buildWheel(rnd, {
    tyreW, tyreC, wallC, rimC, hubC, boltC, knobs: true, disc: 'left',
  });
  frontWheel.position.set(0, WHEEL_R, FRONT_Z);

  // ── the steering assembly ─────────────────────────────────────────────────
  const { mount, spin, body } = steerRig(HEAD_LO, HEAD_TILT);
  let lampMount = null;
  {
    const F = new BikeParts('bike_fork');
    if (susp) buildSuspFork(F, paintAt, boltC);
    else buildRigidFork(F, paintAt, boltC);

    // steerer, up through the head tube
    F.add(tube(0.0145, 0.20, 8), 'polish',
      span(HEAD_LO.clone().addScaledVector(AXIS, -0.02),
           HEAD_LO.clone().addScaledVector(AXIS, 0.18)), tintOf(0x9aa0a4), { facet: true });

    // stem: up the steerer, then forward to the bar clamp. Short on a trail
    // bike (a long stem is the road-bike tell), a touch longer on the packer.
    const stemBack = HEAD_HI.clone().addScaledVector(AXIS, 0.032);
    const barC = V(0, BIKE_DIM.barY, HEAD_HI.z + (packer ? 0.086 : 0.070));
    // The stem is a box spanning steerer to bar clamp. `span` orients a
    // +Y primitive, so the box is built with its LENGTH on Y — building it on Z
    // and rotating afterwards is how a stem ends up across the bars.
    F.add(rbox(0.036, stemBack.distanceTo(barC) + 0.030, 0.034, 0.010, 1), 'polish',
      span(stemBack, barC), boltC, { facet: true });
    F.add(tube(0.0180, 0.046, 8), 'polish', at(barC.x, barC.y, barC.z, Math.PI / 2, 0, 0),
      boltC, { facet: true });

    const barHalf = packer ? buildSweptBar(F, barC, gripC, boltC)
                           : buildRiserBar(F, barC, gripC, boltC);

    // brake levers, inboard of the grips and angled down the way they are set
    // up on a bike that gets ridden down things.
    for (const s of [-1, 1]) {
      F.add(rbox(0.014, 0.020, 0.076, 0.006, 1), 'polish',
        at(s * (barHalf - 0.100), barC.y + 0.006, barC.z - 0.030, 0.5, 0, 0),
        boltC, { facet: true });
    }
    if (hasBell) {
      F.add(new THREE.SphereGeometry(0.020, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), 'chrome',
        at(0.075, barC.y + 0.020, barC.z), tintOf(0xb9a06a));
    }
    // The headlamp, and the mount the beam is hung on.
    lampMount = buildLamp(F, body, barC);
    F.flush(body);
  }
  body.add(frontWheel);
  spin.rotation.y = parkSteer;
  g.add(mount);

  // ── what the rest of the game reads off this object ───────────────────────
  g.userData.dim = { ...BIKE_DIM };
  g.userData.wheels = { front: frontWheel, rear: rearWheel };
  g.userData.steer = spin;
  g.userData.cranks = crankGrp;
  g.userData.stand = standGrp;
  // Where `Bike` hangs its SpotLight. Inside the steer body, so the beam swings
  // with the bars — which is the entire point of putting a light on a bicycle
  // rather than on its frame.
  g.userData.lampMount = lampMount;
  g.userData.colorway = cw.name;
  g.userData.style = style;
  // What `Camp`'s ground lift measures against, and what the layout reserves.
  // A bike is long and narrow; this is the half-width the clearing has to give
  // it, not the half-length.
  g.userData.footprint = 0.34;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The steering rig.
//
//  A bicycle steers about the head tube's axis, which is tilted `tilt` radians
//  off vertical. Rotating the fork about world +Y instead is the classic tell —
//  at any real steering angle the front wheel leans the wrong way and the
//  contact patch slides sideways out of the fork.
//
//  Three nested groups do it without a line of trigonometry in the model:
//
//    mount   at the head tube, tilted INTO the steering frame
//    spin    rotation.y — the steering angle, now about the right axis
//    body    tilted straight back OUT, and positioned so the pair cancels
//
//  so geometry added to `body` is authored in ordinary bike space. The
//  cancellation is the only fiddly part: with mount = T(P)·Rx(−a), body must be
//  T(Rx(a)·(−P))·Rx(a) for the product to be the identity at zero steer.
// ─────────────────────────────────────────────────────────────────────────────
function steerRig(pivot, tilt) {
  const mount = new THREE.Group();
  mount.name = 'bike_steer_mount';
  mount.position.copy(pivot);
  mount.rotation.x = -tilt;

  const spin = new THREE.Group();
  spin.name = 'bike_steer';
  mount.add(spin);

  const body = new THREE.Group();
  body.name = 'bike_steer_body';
  body.rotation.x = tilt;
  body.position.copy(pivot).negate().applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  spin.add(body);

  return { mount, spin, body };
}

// ─────────────────────────────────────────────────────────────────────────────
//  A wheel: tyre, rim, spokes, hub, rotor. Local origin at the hub, axle on X.
//
//  Spoke count is 14 and not 32. A real 32-spoke wheel at fifteen metres is a
//  grey haze that crawls when it turns; 14 tapered spokes read as *spokes*,
//  which is what the eye is looking for, and they still blur into a disc at
//  speed because that is what motion blur in the eye does rather than something
//  the model has to fake.
// ─────────────────────────────────────────────────────────────────────────────
function buildWheel(rnd, o) {
  const grp = new THREE.Group();
  grp.name = 'bike_wheel';
  const W = new BikeParts('bike_wheel');
  const half = o.tyreW * 0.5;
  const R = RIM_R + half;                     // tyre centreline

  // Tyre. Smooth normals (BikeParts keeps what the torus computed) so the
  // casing rolls its highlight round instead of showing 28 flats.
  W.add(new THREE.TorusGeometry(R - half * 0.5, half, 8, 28), 'tread',
    at(0, 0, 0, 0, Math.PI / 2, 0),
    (x, y, z) => {
      // The sidewall is a shade browner than the tread — dust lives there, and
      // a uniformly black donut is the other half of "this is a rubber band".
      // The band is deliberately narrow: at 0.45 it caught the shoulders too
      // and the whole casing read tan from three-quarters on, which turns a
      // knobbly 29er into a balloon tyre.
      const side = clamp01(Math.abs(x) / Math.max(half, 1e-3));
      return mixRGB(o.tyreC, o.wallC, smoothstep(0.66, 0.98, side) * 0.72);
    });
  // Knobs: a ring of small blocks round the shoulder. Only on the trail build,
  // and only 20 of them — enough to break the silhouette, few enough to stay a
  // texture rather than a gear.
  if (o.knobs) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const s = i % 2 ? 1 : -1;
      // The wheel's plane is YZ (the axle is on X), so "point this block
      // outward along the radius" is a rotation about X, not about Z.
      W.add(rbox(0.014, 0.022, 0.016, 0.003, 1), 'tread',
        at(s * half * 0.62, Math.sin(a) * (R + 0.004), Math.cos(a) * (R + 0.004),
           Math.PI / 2 - a, 0, 0), mulRGB(o.tyreC, 1.12), { facet: true });
    }
  }

  // Rim: a box section, drawn as a torus so the highlight runs round it.
  W.add(new THREE.TorusGeometry(RIM_R - 0.011, 0.012, 5, 28), 'polish',
    at(0, 0, 0, 0, Math.PI / 2, 0), o.rimC);

  // Hub and flanges.
  W.add(tube(HUB_R, 0.098, 9), 'polish', at(0, 0, 0, 0, 0, Math.PI / 2), o.hubC, { facet: true });
  for (const s of [-1, 1]) {
    W.add(tube(0.040, 0.010, 10), 'polish', at(s * 0.030, 0, 0, 0, 0, Math.PI / 2),
      o.hubC, { facet: true });
  }
  W.add(tube(0.0060, 0.132, 6), 'chrome', at(0, 0, 0, 0, 0, Math.PI / 2), o.boltC, { facet: true });

  // Spokes, alternating flanges so the wheel reads as dished.
  const spokeC = mulRGB(tintOf(0xb9bec2), 0.95);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.11;
    const s = i % 2 ? 1 : -1;
    const from = V(s * 0.030, Math.sin(a) * 0.038, Math.cos(a) * 0.038);
    // a touch of tangential lace, so they are not a perfect starburst
    const b = a + s * 0.16;
    const to = V(0, Math.sin(b) * (RIM_R - 0.016), Math.cos(b) * (RIM_R - 0.016));
    W.add(tube(0.0022, from.distanceTo(to), 4), 'chrome', span(from, to), spokeC, { facet: true });
  }

  // Disc rotor, on the left. It is 160 mm of bright metal and it is most of
  // what tells a modern bike from a 1970s one at any distance.
  {
    const s = o.disc === 'right' ? -1 : 1;
    W.add(new THREE.TorusGeometry(0.072, 0.0035, 4, 20), 'chrome',
      at(s * 0.048, 0, 0, 0, Math.PI / 2, 0), mulRGB(o.boltC, 0.92));
    W.add(new THREE.TorusGeometry(0.052, 0.0030, 4, 16), 'chrome',
      at(s * 0.048, 0, 0, 0, Math.PI / 2, 0), mulRGB(o.boltC, 0.88));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      W.add(rbox(0.004, 0.026, 0.008, 0.001, 1), 'chrome',
        at(s * 0.048, Math.sin(a) * 0.062, Math.cos(a) * 0.062, Math.PI / 2 - a, 0, 0),
        mulRGB(o.boltC, 0.9), { facet: true });
    }
  }
  void rnd;
  W.flush(grp);
  return grp;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Saddle: a nose, a wide tail and rails. Small, and it is one of the three
//  points the eye uses to read a bicycle's posture (the other two are the bars
//  and the bottom bracket), so its HEIGHT matters more than its shape.
// ─────────────────────────────────────────────────────────────────────────────
function buildSaddle(P, top, saddleC, packer) {
  const y = top.y + 0.028;
  const z = top.z - 0.006;
  const L = packer ? 0.262 : 0.248;
  const HW = 0.072;                                  // half the sit-bone width
  // The shell as a lofted ribbon rather than a constant-radius tube: a saddle
  // is a NOSE and a TAIL, and a 60 mm sausage — which is what the first pass
  // was — reads as a rolled towel on a seatpost. `sweptArc` cannot taper, so
  // this is four boxes down the length, which is cheap and gives the profile
  // the silhouette needs.
  const SEG = [
    // [t along the saddle, half-width, thickness]
    [0.00, 0.020, 0.026],
    [0.28, 0.040, 0.030],
    [0.58, 0.064, 0.034],
    [0.84, HW,    0.036],
    [1.00, HW * 0.92, 0.030],
  ];
  for (let i = 0; i < SEG.length - 1; i++) {
    const [t0, w0, h0] = SEG[i];
    const [t1, w1, h1] = SEG[i + 1];
    const zc = z + L * (0.62 - (t0 + t1) * 0.5);
    // A saddle rises toward the tail; the nose drops away.
    const rise = 0.016 * Math.pow((t0 + t1) * 0.5, 1.6);
    P.add(rbox((w0 + w1), (h0 + h1) * 0.5, L * (t1 - t0) + 0.004,
      Math.min(w0, h0) * 0.9, 1), 'tread',
      at(0, y + rise, zc), mulRGB(saddleC, 0.96 + 0.16 * ((t0 + t1) * 0.5)));
  }
  // Rails: two thin tubes running FORE AND AFT under the shell.
  //
  // `tube` is built on +Y, so a placement that only tweaks the tilt leaves them
  // standing straight up — which is what shipped, and the user's screenshot of
  // it is unambiguous: two chrome spikes through the top of the saddle, "these
  // bolts cannot be going through the seat. OUCH." The π/2 about X is what lays
  // them down; the 0.08 on top of it is the nose-down rake a real rail has.
  for (const s of [-1, 1]) {
    P.add(tube(0.0040, 0.150, 5), 'chrome',
      at(s * 0.026, y - 0.028, z - 0.030, Math.PI / 2 + 0.08, 0, 0),
      tintOf(0xa8adb1), { facet: true });
  }
  // the seatpost clamp, gripping the rails from below
  P.add(rbox(0.046, 0.026, 0.042, 0.008, 1), 'polish',
    at(0, y - 0.042, z - 0.030), tintOf(0x8e9295), { facet: true });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bars. Two builds; both authored around the clamp point `c`.
// ─────────────────────────────────────────────────────────────────────────────
function buildRiserBar(F, c, gripC, boltC) {
  const HALF = 0.350;                              // a 700 mm bar
  // A riser bar: 20 mm of rise, 8° of back sweep, so the ends come toward the
  // rider. Swept rather than a straight cylinder — a straight bar is the single
  // most obvious way this reads as a toy.
  F.add(sweptArc((t) => {
    const u = (t - 0.5) * 2;                       // −1 … 1
    const a = Math.abs(u);
    return V(u * HALF,
      c.y + 0.020 * smoothstep(0.18, 0.62, a),
      c.z - 0.048 * smoothstep(0.30, 1.0, a));
  }, 20, 0.0125, 7), 'polish', null, boltC);
  for (const s of [-1, 1]) {
    F.add(tube(0.0155, 0.115, 8), 'rubber',
      at(s * (HALF - 0.058), c.y + 0.020, c.z - 0.048, 0, 0, Math.PI / 2), gripC, { facet: true });
    F.add(tube(0.0170, 0.012, 8), 'plastic',
      at(s * (HALF - 0.002), c.y + 0.020, c.z - 0.048, 0, 0, Math.PI / 2),
      tintFrom(HEX_PLASTIC, 0x1e2023), { facet: true });
  }
  return HALF;
}

/**
 * The packer's bar: a swept-back "alt" bar. Still a FLAT bar — this valley has
 * no pavement and nothing in the set gets drops — but it is narrower and it
 * pulls the grips a long way back toward the rider, which is both what a loaded
 * hardtail is set up with and a silhouette you can tell from a riser bar at a
 * hundred pixels: the ends curve, they do not just rise.
 */
function buildSweptBar(F, c, gripC, boltC) {
  const HALF = 0.300;                              // a 600 mm bar
  const SWEEP = 0.135;                             // how far back the ends come
  const ends = (u) => {
    const a = Math.abs(u);
    return V(u * HALF,
      c.y + 0.012 * smoothstep(0.30, 0.85, a),
      c.z - SWEEP * Math.pow(smoothstep(0.20, 1.0, a), 1.4));
  };
  F.add(sweptArc((t) => ends((t - 0.5) * 2), 22, 0.0125, 7), 'polish', null, boltC);
  for (const s of [-1, 1]) {
    // The grip sits along the swept end, so it is placed by SPANNING two points
    // on the curve rather than by guessing an Euler triple for it.
    const a = ends(s * 0.97), b = ends(s * 0.62);
    F.add(tube(0.0155, a.distanceTo(b), 8), 'rubber', span(a, b), gripC, { facet: true });
    F.add(tube(0.0170, 0.012, 8), 'plastic',
      span(a, ends(s * 1.0)), tintFrom(HEX_PLASTIC, 0x1e2023), { facet: true });
  }
  return HALF;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Forks. Both are mountain-bike forks; the difference is the whole point of
//  having two builds — see the header.
// ─────────────────────────────────────────────────────────────────────────────

/** A rigid fork: two painted blades with the rake bowed into them. */
function buildRigidFork(F, paintAt, boltC) {
  for (const s of [-1, 1]) {
    const crown = V(s * 0.030, HEAD_LO.y - 0.020, HEAD_LO.z + 0.008);
    const drop = V(s * 0.052, WHEEL_R, FRONT_Z);
    // The rake — the bow that carries the axle forward of the steering axis —
    // is the reason a bicycle tracks straight, and it is visible in silhouette.
    F.add(sweptArc((t) => {
      const p = new THREE.Vector3().lerpVectors(crown, drop, t);
      p.z += 0.022 * Math.sin(t * Math.PI) + 0.014 * t * t;
      return p;
    }, 8, 0.0135, 6), 'paint', null, paintAt);
    F.add(rbox(0.010, 0.062, 0.046, 0.006, 1), 'polish',
      at(s * 0.052, WHEEL_R + 0.002, FRONT_Z + 0.010), boltC, { facet: true });
  }
  F.add(rbox(0.086, 0.030, 0.052, 0.010, 1), 'paint',
    at(0, HEAD_LO.y - 0.022, HEAD_LO.z + 0.010, -HEAD_TILT, 0, 0), paintAt);
}

/**
 * A suspension fork: bright stanchions telescoping into fat dark lowers, tied
 * by an arch behind the tyre.
 *
 * The two-diameter, two-VALUE construction is the whole read. A suspension fork
 * drawn as one tapered tube is just a thick rigid fork; what the eye recognises
 * is a thin mirror-finish tube disappearing into a chunky matte one, and the
 * step between them sitting about a third of the way down.
 */
function buildSuspFork(F, paintAt, boltC) {
  const STEP = 0.44;                        // where the lowers swallow the stanchion
  const crownY = HEAD_LO.y - 0.024;
  for (const s of [-1, 1]) {
    const crown = V(s * 0.042, crownY, HEAD_LO.z + 0.006);
    const drop = V(s * 0.060, WHEEL_R, FRONT_Z - 0.010);
    const on = (t) => {
      const p = new THREE.Vector3().lerpVectors(crown, drop, t);
      p.z += 0.016 * t * t;                 // a little rake, straight legs
      return p;
    };
    // stanchion: chrome, thin, and it must stay thin
    F.add(tube(0.0165, on(0).distanceTo(on(STEP)), 8), 'chrome',
      span(on(0), on(STEP)), tintOf(0xc8ccd0), { facet: true });
    // lower: fat, matte, and painted to match the frame at only half strength —
    // a fork lower is anodised black on most bikes and full frame colour reads
    // as a cartoon
    F.add(tube(0.0250, on(STEP - 0.02).distanceTo(on(1)), 9), 'plastic',
      span(on(STEP - 0.02), on(1)),
      (x, y, z) => mixRGB(tintFrom(HEX_PLASTIC, 0x24262a), paintAt(x, y, z), 0.35));
    F.add(rbox(0.014, 0.066, 0.050, 0.006, 1), 'polish',
      at(drop.x, drop.y + 0.002, drop.z + 0.012), boltC, { facet: true });
  }
  // the brace arch, behind the tyre
  F.add(sweptArc((t) => {
    const u = (t - 0.5) * 2;
    return V(u * 0.062,
      lerp(WHEEL_R + 0.215, WHEEL_R + 0.190, Math.abs(u)),
      FRONT_Z - 0.052 + 0.020 * (1 - Math.abs(u)));
  }, 10, 0.0150, 6), 'plastic', null, tintFrom(HEX_PLASTIC, 0x25272b));
  // crown
  F.add(rbox(0.112, 0.036, 0.056, 0.012, 1), 'plastic',
    at(0, crownY - 0.004, HEAD_LO.z + 0.008, -HEAD_TILT, 0, 0),
    tintFrom(HEX_PLASTIC, 0x25272b), { facet: true });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The handlebar lamp.
//
//  Every bike in this valley carries one, and it is not a variant: the player
//  can be a long way from the camper when the sun goes down, and a bicycle you
//  cannot ride home in the dark is a trap rather than a feature.
//
//  Three things make a 46 mm object read as a LAMP at any distance, and none of
//  them is detail:
//
//   1. **A bright ring around a dark eye.** The bezel is `chrome` and the lens
//      sits recessed behind it, so even unlit and eight metres away the object
//      is a bright circle with something in the middle — which is the shape the
//      eye files under "lamp" and never under "bottle" or "bell".
//   2. **It is ABOVE the bar, on a bracket.** Slung under the bar it disappears
//      into the bar's own silhouette; on top of it, it breaks the skyline of
//      the cockpit and is visible from behind, which is the riding view.
//   3. **The lens is a material that can be turned on.** See `bike_materials`:
//      `lens` is the one thing in the kit with an `emissive`, and `Bike._lamp`
//      ramps it with the sun.
//
//  Returns the Group the SpotLight is parented to. It sits at the lens with no
//  rotation of its own, so it inherits bike space — +Z forward — and the light
//  and its target can be placed in plain metres by the system that owns them.
// ─────────────────────────────────────────────────────────────────────────────
function buildLamp(F, body, barC) {
  // On the bar's centreline and lifted clear of the stem clamp, which is an
  // 18 mm tube sitting exactly where the bracket wants to be.
  const y = barC.y + 0.052;
  const z = barC.z + 0.040;
  const R = 0.0225;                    // 45 mm lamp — a real bar light

  // Bracket: a strap round the bar and a short post up to the lamp.
  F.add(new THREE.TorusGeometry(0.0165, 0.0045, 4, 12), 'plastic',
    at(0, barC.y, barC.z, 0, Math.PI / 2, 0), tintFrom(HEX_PLASTIC, 0x1e2023));
  F.add(rbox(0.016, 0.050, 0.020, 0.004, 1), 'plastic',
    at(0, barC.y + 0.024, barC.z + 0.014, -0.5, 0, 0),
    tintFrom(HEX_PLASTIC, 0x25272b), { facet: true });

  // Body: a short barrel along +Z, with a ribbed heatsink read at the back.
  F.add(tube(R, 0.056, 12), 'plastic', at(0, y, z, Math.PI / 2, 0, 0),
    tintFrom(HEX_PLASTIC, 0x2c2e33));
  for (const dz of [-0.020, -0.008]) {
    F.add(new THREE.TorusGeometry(R * 1.06, 0.0028, 4, 12), 'plastic',
      at(0, y, z + dz), tintFrom(HEX_PLASTIC, 0x1c1e21));
  }

  // Bezel: the bright ring, and the single most important part of the object.
  F.add(new THREE.TorusGeometry(R * 0.98, 0.0040, 4, 16), 'chrome',
    at(0, y, z + 0.028), tintOf(0xcfd4d8));

  // Lens: recessed a few millimetres behind the bezel so the ring reads as a
  // ring rather than as the edge of a disc.
  F.add(tube(R * 0.86, 0.007, 14), 'lens', at(0, y, z + 0.0245, Math.PI / 2, 0, 0),
    tintOf(0xf6efdc));

  // Where the beam hangs. No rotation — it inherits bike space.
  const mnt = new THREE.Group();
  mnt.name = 'bike_lamp';
  mnt.position.set(0, y, z + 0.030);
  body.add(mnt);
  return mnt;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rear rack, and the dry bag or pannier on it. This is the variant that says
//  "somebody rode here from somewhere", and on the packer it is nearly always on.
// ─────────────────────────────────────────────────────────────────────────────
function buildRack(P, cw, rackC, hasBag, rnd, rearZ, wheelR, ssTop) {
  // ── the deck goes OVER the wheel, and this is the number that got it wrong ──
  //
  // First pass wrote `wheelR + 0.108`, which is 0.456 — the AXLE height plus a
  // hand's width, i.e. dead centre of a 0.70 m wheel. The rack and the dry bag
  // on it were drawn threaded through the spokes (user, with a screenshot,
  // 2026-09-01). `wheelR` is the RADIUS; clearing a wheel takes the DIAMETER.
  //
  // 55 mm of clearance over the tyre's crown is what a real rack leaves, and on
  // a 29er that puts the deck at 0.75 m — high, and correctly so: it is why a
  // loaded hardtail looks top-heavy.
  const topY = wheelR * 2 + 0.055;
  const z0 = rearZ - 0.130, z1 = rearZ + 0.170;
  const mid = (z0 + z1) * 0.5;
  // Where the upper stays meet the seat stays: near the top of them, just under
  // the seat clamp, which is where the eyelets are.
  const drop = (s) => V(s * 0.062, wheelR, rearZ);
  for (const s of [-1, 1]) {
    const strut = (a, b) => P.add(tube(0.0052, a.distanceTo(b), 5), 'polish',
      span(a, b), rackC, { facet: true });
    // the deck rail
    P.add(tube(0.0058, z1 - z0, 5), 'polish',
      at(s * 0.062, topY, mid, Math.PI / 2, 0, 0), rackC, { facet: true });
    // Down the back to the dropout, and forward to the seat stay. Both are
    // sized from the distance they are about to be placed across; a hardcoded
    // length is a member that floats or overshoots the moment the frame moves.
    strut(V(s * 0.062, topY, z0 + 0.03), drop(s).clone().add(V(s * 0.006, 0.006, 0)));
    strut(V(s * 0.062, topY, z1 - 0.01),
      drop(s).clone().lerp(ssTop.clone().add(V(s * 0.020, 0, 0)), 0.80));
  }
  for (const z of [z0 + 0.03, mid, z1 - 0.03]) {
    P.add(tube(0.0050, 0.124, 5), 'polish', at(0, topY, z, 0, 0, Math.PI / 2), rackC, { facet: true });
  }
  if (!hasBag) return;
  // A dry bag, strapped down. A rounded cylinder lying fore-and-aft, because
  // that is the shape that survives being 40 px wide.
  const bagC = tintOf(cw.bag);
  const bl = 0.30 + rnd() * 0.06;
  const bagY = topY + 0.078;
  P.add(tube(0.074, bl, 12), 'fabric', at(0, bagY, mid + 0.01, Math.PI / 2, 0, 0),
    (x, y) => mulRGB(bagC, 0.88 + 0.26 * clamp01((y - topY) / 0.16)));
  for (const s of [-1, 1]) {
    P.add(new THREE.TorusGeometry(0.076, 0.006, 4, 14), 'cord',
      at(0, bagY, mid + 0.01 + s * bl * 0.28, 0, Math.PI / 2, 0),
      tintFrom(HEX_CORD, 0x3a3d42));
  }
}

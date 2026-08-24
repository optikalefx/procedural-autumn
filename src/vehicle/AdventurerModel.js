// ─────────────────────────────────────────────────────────────────────────────
//  AdventurerModel — "The Adventurer": a yellow two-door trail rig, doors off.
//
//  Reference is a lifted 2-door Wrangler Rubicon on mud terrains: safety-yellow
//  tub, black flares and steel bumpers, a hoop rack and winch on the nose, the
//  spare hung on the tailgate — and NO DOORS AND NO ROOF. There is no badge, no
//  lettering and no decal anywhere on it, deliberately.
//
//  THE DOORS ARE THE WHOLE MODEL PROBLEM.  Every other car here is a closed
//  box: you see a painted flank with holes in it and a dark interior behind the
//  glass, and the interior can be four boxes because nobody can really look at
//  it. Take the doors off and the player looks *straight through the middle of
//  the vehicle* from any side angle — at the seats, the cage, the transmission
//  tunnel, and out the far side. So this one is built inside-out compared to
//  the camper:
//
//   · the tub profile DIPS to `sill` between the cowl and the rear quarter, so
//     the extrusion is a bathtub rather than a box and the cabin floor is the
//     top of it;
//   · there is no bodywork at all above the belt line. No greenhouse wall, no
//     hardtop, no side glass: the windscreen frame and the sport bar are the
//     entire upper structure, standing in open air;
//   · the sport bar is therefore load-bearing *visually*. With the top off it is
//     the whole roofline, so it is built as a real cage — hoop, forward rails,
//     rear down-tubes and braces, body-colour with black padding — rather than
//     as a detail glimpsed through a window;
//   · the interior is furnished, because it is scenery now rather than a dark
//     void: floor, tunnel, buckets, rear bench, dash, and eight ducks, all of
//     it lit by the actual sky.
//
//  The ducks are not a joke at the model's expense. It is a Jeep thing.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, smoothstep, clamp01 } from '../core/MathUtils.js';
import {
  CHASSIS, C, Parts, at, rbox, tube, rod,
  archPoints, extrudeAcross, buildWheel, buildMaterials,
} from './model_kit.js';

// ── dimensions (metres, local space: +X right, +Y up, +Z forward) ────────────
//
// The stance. Three numbers do it, and only one of them is free:
//
//   `wheelR`   the tyre's VISUAL radius, 1.12 m across against the 0.88 m every
//              other car rolls on. Physics still raycasts at CHASSIS.wheelR, so
//              Vehicle lifts the whole rig by the 0.12 m difference — body and
//              hubs together — and the bottom of the big tyre lands back on the
//              contact patch with the body sitting a lift-kit higher over it.
//              buildWheel's header has the full argument and what it costs.
//   `wheelOut` visual track widening. The suspension keeps VEHICLE.trackWidth;
//              the drawn wheel steps 80 mm further out, so the tyre stands
//              proud of the flare the way it does in the reference photos.
//   `floor`    the sill, 0.16 m above the camper's, which is the body lift on
//              top of the tyre lift.
export const DIM = {
  ...CHASSIS,
  wheelR: 0.56,       // VISUAL — overrides CHASSIS.wheelR; see above
  wheelOut: 0.08,     // VISUAL — physics track is unchanged
  halfWidth: 0.94,
  front: 2.20,
  rear: -2.20,
  floor: -0.14,       // rocker / sill line — 0.16 m above the camper's
  roof: 1.30,         // top of the windscreen frame and the sport bar — no roof panel
  waist: 0.64,        // belt line: hood height, and the top of the tub sides
  sill: 0.32,         // top of the tub through the cabin = the door opening's floor
  archR: 0.62,
  lampX: 0.56,        // headlight centre — Vehicle aims its spot lights here
  lampY: 0.50,
};

// The tyre: 1.12 m across, half a metre wide, and blocked deep enough that the
// lugs read individually from the chase cam. `band` is off because the raised
// sidewall ring is where a real tyre carries its lettering, and this car does
// not wear any.
export const TYRE = {
  radius: DIM.wheelR, width: 0.25, deepTread: 0.06, band: false,
  // Black wheel, body-colour spokes and beadlock ring. A black rim inside a
  // black tyre is one dark blob with a chrome dot in it — the accent is what
  // gives the wheel a face, and it has to be the paint or it is a third colour.
  rimKey: 'rimDark', spokeKey: 'paint', accentKey: 'paint',
};

const BODY_YELLOW = 0xf2c211;
const TOP_BLACK = 0x24252b;

// No WINDOWS table. With the top off there is exactly one piece of glass on
// this car — the windscreen — and it is not an aperture cut in a panel, so
// there is nothing here for the other models' window machinery to describe.

// Where the cabin opening starts and stops. Everything between these is air
// from `sill` all the way to the roof rail.
const DOOR_Z0 = 0.94, DOOR_Z1 = -0.62;

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
export function buildAdventurerMaterials(env) {
  const mats = buildMaterials(env, { body: BODY_YELLOW, cream: TOP_BLACK });

  mats.plastic = new THREE.MeshStandardMaterial({
    color: C(0x2a2b30), roughness: 0.88, metalness: 0.05,
    envMap: env, envMapIntensity: 0.35, vertexColors: true,
  });

  // The ducks. A rubber duck is the one thing in this valley that is *shiny and
  // soft at once*, and it has to read at 60 mm across, so it gets a real
  // clearcoat rather than the standard material everything else in here uses —
  // without the specular pop they are eight yellow pebbles on the dash.
  mats.duck = new THREE.MeshPhysicalMaterial({
    color: C(0xffd616), roughness: 0.34, metalness: 0.0,
    clearcoat: 0.85, clearcoatRoughness: 0.20,
    envMap: env, envMapIntensity: 0.55, vertexColors: true,
  });
  mats.beak = new THREE.MeshStandardMaterial({
    color: C(0xef7d16), roughness: 0.45, metalness: 0.0,
    envMap: env, envMapIntensity: 0.4, vertexColors: true,
  });
  return mats;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Side profile
// ─────────────────────────────────────────────────────────────────────────────
//
// One extrusion, and it is a tub in the literal sense: the top edge runs along
// the belt line at the cowl, drops to the sill for the length of the door
// opening, and climbs back to the belt line for the rear quarter. Extruded
// across the full width that gives a floor you can stand seats on and a body
// side you can look over, which is what a doorless Jeep is.
function tubShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));

  P(D.rear, D.floor + 0.10);
  P(D.rear + 0.10, D.floor);
  P(-2.15, D.floor);
  archPoints(pts, -D.wheelZ, D.archR, D.floor, 0.52);
  P(-0.90, D.floor);
  P(0.90, D.floor);
  archPoints(pts, D.wheelZ, D.archR, D.floor, 0.52);
  P(2.15, D.floor);
  P(2.16, D.floor + 0.04);
  P(D.front, 0.20);                  // bottom of the grille
  P(D.front, D.waist);               // top of the grille — the face is vertical
  P(2.12, D.waist + 0.03);
  P(1.12, D.waist + 0.04);           // flat bonnet
  P(1.02, D.waist);                  // cowl
  P(DOOR_Z0, D.sill);                // ── down into the cabin ──
  P(DOOR_Z1, D.sill);
  P(-0.70, D.waist);                 // ── up onto the rear quarter ──
  P(D.rear, D.waist);
  return new THREE.Shape(pts);
}

// ─────────────────────────────────────────────────────────────────────────────
//  A rubber duck
// ─────────────────────────────────────────────────────────────────────────────
//
// Eight of these live on the dash top against the windscreen. Each is six
// primitives and they are 60 mm long, so the whole flotilla is cheaper than one
// wheel — but they are the first thing anybody notices about this car, which is
// the correct ratio of cost to payoff.
//
// The beak cone is pre-rotated in its own geometry rather than through `at`'s
// euler: three composes XYZ as qx·qy·qz, so an X tilt applied through `at`
// happens AFTER the yaw and the beak ends up pointing at the sky when the duck
// is turned. Baking the tilt into the geometry leaves `ry` free to mean yaw.
function addDuck(P, x, y, z, yaw, s = 1) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  // body: a squashed sphere, longer than it is wide
  P.add(new THREE.SphereGeometry(0.030 * s, 10, 8), 'duck',
    at(x, y + 0.026 * s, z, 0, yaw, 0, 1.0, 0.92, 1.35));
  // tail flip
  P.add(rbox(0.020 * s, 0.026 * s, 0.030 * s, 0.008 * s), 'duck',
    at(x - dx * 0.044 * s, y + 0.046 * s, z - dz * 0.044 * s, 0.55, yaw, 0));
  // head, forward and up
  const hx = x + dx * 0.020 * s, hz = z + dz * 0.020 * s, hy = y + 0.062 * s;
  P.add(new THREE.SphereGeometry(0.019 * s, 10, 8), 'duck', at(hx, hy, hz, 0, yaw, 0));
  // beak
  const beak = new THREE.ConeGeometry(0.009 * s, 0.022 * s, 6);
  beak.rotateX(Math.PI / 2);
  P.add(beak, 'beak', at(hx + dx * 0.018 * s, hy - 0.003 * s, hz + dz * 0.018 * s, 0, yaw, 0));
  // eyes
  for (const e of [-1, 1]) {
    P.add(new THREE.SphereGeometry(0.0042 * s, 6, 5), 'trim',
      at(hx + dx * 0.012 * s + e * dz * 0.010 * s, hy + 0.007 * s,
        hz + dz * 0.012 * s - e * dx * 0.010 * s), [0.25, 0.25, 0.28]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The Adventurer
// ─────────────────────────────────────────────────────────────────────────────
export function buildAdventurer(materials, seed = 12) {
  const D = DIM;
  const rnd = mulberry32(seed);
  const root = new THREE.Group();
  root.name = 'adventurer';
  const P = new Parts();

  // Trail grime. Heavier than the Roamer's and hung higher up the flanks: this
  // one is built to be driven through the thing the others drive around.
  const grime = (x, y, z) => {
    const low = smoothstep(0.44, -0.16, y);
    const splash = 0.5 + 0.5 * Math.sin(z * 5.3 + x * 3.5) * Math.cos(z * 2.1 - y * 6.4);
    const arch = clamp01(1.25 - Math.min(
      Math.hypot(z - D.wheelZ, y - D.wheelY),
      Math.hypot(z + D.wheelZ, y - D.wheelY)) * 1.05);
    const k = clamp01(low * (0.34 + 0.46 * splash) + arch * 0.50);
    const d = 1 - k * 0.36;
    return [d * (1 - k * 0.05), d * (1 - k * 0.02), d * (1 + k * 0.30)];
  };

  // ── the tub ──────────────────────────────────────────────────────────────
  P.add(extrudeAcross(tubShape(), D.halfWidth * 2 - 0.05, 0.035), 'paint', null, grime);

  // ── the cabin ────────────────────────────────────────────────────────────
  // Everything here is visible through the door opening from both sides, so it
  // is built to be looked at rather than glimpsed.
  const S = D.sill;
  P.add(rbox(1.72, 0.03, 1.62, 0.01), 'interior', at(0, S + 0.015, 0.16));      // floor pan
  P.add(rbox(0.34, 0.16, 1.50, 0.04), 'interior', at(0, S + 0.09, 0.16));       // trans tunnel
  // inner trim against the cowl and the rear bulkhead, so no yellow shows inside
  P.add(rbox(1.70, 0.30, 0.05, 0.02), 'interior', at(0, D.waist - 0.14, DOOR_Z0 - 0.03));
  P.add(rbox(1.70, 0.34, 0.05, 0.02), 'interior', at(0, D.waist - 0.10, DOOR_Z1 + 0.03));
  for (const s of [-1, 1]) {                                                     // inner door sills
    P.add(rbox(0.05, 0.10, DOOR_Z0 - DOOR_Z1, 0.018), 'plastic',
      at(s * (D.halfWidth - 0.075), S + 0.03, (DOOR_Z0 + DOOR_Z1) / 2), [1, 1, 1]);
  }
  // front buckets
  for (const s of [-1, 1]) {
    P.add(rbox(0.46, 0.14, 0.48, 0.05), 'interior', at(s * 0.40, S + 0.13, 0.28));
    P.add(rbox(0.46, 0.62, 0.13, 0.05), 'interior', at(s * 0.40, S + 0.48, 0.03, -0.14));
    P.add(rbox(0.22, 0.12, 0.10, 0.04), 'interior', at(s * 0.40, S + 0.83, -0.02, -0.14));  // headrest
  }
  // rear bench
  P.add(rbox(1.40, 0.13, 0.42, 0.05), 'interior', at(0, S + 0.125, -0.34));
  P.add(rbox(1.40, 0.52, 0.13, 0.05), 'interior', at(0, S + 0.42, -0.55, -0.10));
  // dash + centre stack, under the windscreen
  P.add(rbox(1.66, 0.26, 0.26, 0.05), 'interior', at(0, D.waist - 0.09, 0.86));
  P.add(rbox(0.34, 0.20, 0.10, 0.03), 'trim', at(0, D.waist - 0.14, 0.76), [0.5, 0.5, 0.56]);
  // grab handle on the passenger side — the one thing every doorless photo has
  P.add(rod(0.018, 0.30), 'plastic', at(-0.56, D.waist + 0.06, 0.80, 0, 0, Math.PI / 2), [1, 1, 1]);

  // ── the sport bar ────────────────────────────────────────────────────────
  // With the top off this IS the roofline, so it is a whole cage rather than a
  // hoop: the main hoop behind the front seats, two rails forward to the
  // windscreen header, rear down-tubes onto the belt line and one tie between
  // them. Body colour with black padding on the pieces a head can reach, which
  // is how the real thing is finished and — more to the point here — is what
  // stops a yellow car growing a black skeleton.
  //
  // There is no diagonal across the hoop. The reference car has none, and the
  // one that was here crossed the cabin at an angle that belonged to nothing —
  // on a car you can see straight through, a brace that ties two things
  // together has to visibly touch both of them or it is just a stray bar.
  const cageX = D.halfWidth - 0.13, cageTop = D.roof - 0.03;
  const hoopZ = -0.60, headZ = DOOR_Z0 - 0.04;
  const legLen = cageTop - D.waist + 0.10;
  const padded = (geo, m) => { P.add(geo, 'plastic', m, [1, 1, 1]); };

  // The rear down-tube, as a line rather than a placement. Everything that has
  // to meet it — the tube itself and the tie bar between the pair — is derived
  // from these four numbers, so the tie cannot drift off the tube it ties.
  // dzTop is hoopZ EXACTLY. At hoopZ - 0.08 the down-tube's top cap stopped
  // 80 mm behind the hoop against a combined radius of 78 — a two-millimetre
  // miss, which on two rounded capsule ends is a visible gap you cannot
  // unsee. Landing it on the corner makes the joint a joint.
  const dTop = cageTop, dBot = D.waist + 0.02;
  const dzTop = hoopZ, dzBot = -1.60;
  const onDown = (z) => dBot + ((z - dzBot) / (dzTop - dzBot)) * (dTop - dBot);

  for (const s of [-1, 1]) {
    // hoop legs, standing on the belt line
    P.add(rod(0.042, legLen), 'paint', at(s * cageX, cageTop - legLen / 2, hoopZ), grime);
    padded(rod(0.052, 0.52), at(s * cageX, cageTop - 0.30, hoopZ));
    // forward rails to the windscreen header
    P.add(rod(0.038, headZ - hoopZ), 'paint',
      at(s * cageX, cageTop, (headZ + hoopZ) / 2, Math.PI / 2), grime);
    padded(rod(0.048, 0.68), at(s * cageX, cageTop, (headZ + hoopZ) / 2 + 0.10, Math.PI / 2));
    // Rear down-tubes, landing ON the belt line over the arch rather than in
    // mid-air: a cage leg that stops short of the body reads as a modelling
    // error from every angle, and this one is fully exposed now.
    P.add(rod(0.036, Math.hypot(dTop - dBot, dzTop - dzBot)), 'paint',
      at(s * cageX, (dTop + dBot) / 2, (dzTop + dzBot) / 2,
        Math.atan2(dzTop - dzBot, dTop - dBot)), grime);
  }
  // cross tubes: main hoop, then the windscreen header
  P.add(rod(0.042, cageX * 2), 'paint', at(0, cageTop, hoopZ, 0, 0, Math.PI / 2), grime);
  padded(rod(0.050, cageX * 1.5), at(0, cageTop, hoopZ, 0, 0, Math.PI / 2));
  P.add(rod(0.038, cageX * 2), 'paint', at(0, cageTop, headZ, 0, 0, Math.PI / 2), grime);
  padded(rod(0.046, cageX * 1.6), at(0, cageTop, headZ, 0, 0, Math.PI / 2));

  // The rear tie between the two down-tubes. Its height is READ OFF the tube
  // line rather than guessed: the guessed one sat 40 mm high and a hundred
  // behind, so it floated over the back deck attached to nothing, which is the
  // one piece of this cage anybody ever notices is wrong.
  const tieZ = -1.20;
  P.add(rod(0.034, cageX * 2), 'paint', at(0, onDown(tieZ), tieZ, 0, 0, Math.PI / 2), grime);

  // grab handles hanging off the forward rails — every doorless photo has them
  for (const s of [-1, 1]) {
    P.add(new THREE.TorusGeometry(0.055, 0.014, 6, 14), 'plastic',
      at(s * (cageX - 0.05), cageTop - 0.06, 0.30, 0, 0, Math.PI / 2), [1, 1, 1]);
  }

  // ── the ducks ────────────────────────────────────────────────────────────
  // Four of them, in a row along the dash top against the glass, each turned a
  // few degrees off its neighbour so the line reads as a collection somebody
  // added to rather than a moulding. Seeded, so a given car always has the same
  // four in the same places.
  {
    const n = 4, y = D.waist + 0.035, z = 0.945;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = -0.68 + t * 1.36;
      addDuck(P, x, y - Math.abs(x) * 0.012, z - Math.abs(x) * 0.02,
        (rnd() - 0.5) * 0.9, 0.92 + rnd() * 0.22);
    }
  }

  // ── wheel-well shells ────────────────────────────────────────────────────
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const wellR = D.archR - 0.04;
    const shellG = new THREE.CylinderGeometry(wellR, wellR, 0.52, 16, 1, true, 0, Math.PI);
    shellG.rotateZ(Math.PI / 2);
    shellG.rotateX(-Math.PI / 2);
    P.add(shellG, 'plastic', at(sx * (D.wheelX - 0.02), D.floor, sz * D.wheelZ), [0.85, 0.85, 0.9]);
    P.add(new THREE.CircleGeometry(wellR, 14), 'plastic',
      at(sx * (D.wheelX - 0.25), D.floor + 0.10, sz * D.wheelZ, 0,
        sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0), [0.85, 0.85, 0.9]);
  }

  // ── underbody: this one is meant to be seen from below ───────────────────
  P.add(rbox(1.30, 0.10, 4.10, 0.03), 'trim', at(0, D.floor - 0.05, -0.02), [0.6, 0.6, 0.66]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.14, 0.18, 3.96, 0.03), 'trim', at(s * 0.42, D.floor - 0.16, 0), [0.5, 0.5, 0.56]);
  }
  for (const sz of [-1, 1]) {
    P.add(tube(0.062, 1.76, 8), 'trim', at(0, D.wheelY, sz * D.wheelZ, 0, 0, Math.PI / 2), [0.55, 0.55, 0.6]);
    P.add(new THREE.SphereGeometry(0.175, 12, 9), 'trim', at(0.17, D.wheelY, sz * D.wheelZ), [0.5, 0.5, 0.56]);
    // coil-overs, canted in — the visible half of the lift
    for (const sx of [-1, 1]) {
      P.add(new THREE.CylinderGeometry(0.05, 0.05, 0.50, 10), 'steel',
        at(sx * 0.60, D.wheelY + 0.34, sz * (D.wheelZ - 0.08), 0, 0, sx * 0.14), [0.85, 0.85, 0.9]);
      // The spring, in the one saturated accent this car is allowed besides its
      // paint. A visible coil is most of what says "this is lifted on purpose".
      for (let k = 0; k < 5; k++) {
        P.add(new THREE.TorusGeometry(0.082, 0.014, 6, 14), 'crimson',
          at(sx * 0.60 - sx * 0.014 * (k - 2), D.wheelY + 0.22 + k * 0.058,
            sz * (D.wheelZ - 0.08), Math.PI / 2, 0, sx * 0.14));
      }
    }
    // track bar / control arms
    P.add(rod(0.035, 1.20), 'trim',
      at(0.10, D.wheelY + 0.16, sz * (D.wheelZ - 0.34), 0, sz * 0.42, 0), [0.5, 0.5, 0.56]);
  }

  // ── flares: big, black, squared-off ──────────────────────────────────────
  const flare = (cz) => {
    const n = 14, R = D.archR + 0.06, H = 0.60;
    // Wide enough to sit over the widened track, and still narrower than the
    // tyre — the reference rig's rubber stands proud of the flare, which is the
    // single loudest thing about how it is stanced.
    const pt = (k) => {
      const a = Math.PI - (k / n) * Math.PI;
      return [cz + R * Math.cos(a), D.floor + H * Math.pow(Math.sin(a), 0.58)];
    };
    for (let k = 0; k < n; k++) {
      const [z0, y0] = pt(k), [z1, y1] = pt(k + 1);
      const len = Math.hypot(z1 - z0, y1 - y0);
      const ang = Math.atan2(y1 - y0, z1 - z0);
      for (const sx of [-1, 1]) {
        P.add(rbox(0.32, 0.11, len + 0.03, 0.034, 1), 'plastic',
          at(sx * (D.halfWidth + 0.045), (y0 + y1) / 2, (z0 + z1) / 2, -ang, 0, 0), [1, 1, 1]);
      }
    }
  };
  flare(D.wheelZ);
  flare(-D.wheelZ);

  // ── rock sliders under the opening ───────────────────────────────────────
  for (const s of [-1, 1]) {
    P.add(rod(0.055, 2.02), 'plastic',
      at(s * (D.halfWidth + 0.05), D.floor - 0.06, 0.06, Math.PI / 2, 0, 0), [1, 1, 1]);
    for (const dz of [0.86, 0.06, -0.76]) {
      P.add(rod(0.032, 0.28), 'plastic',
        at(s * (D.halfWidth - 0.02), D.floor - 0.02, dz, 0, 0, s * 0.95), [1, 1, 1]);
    }
  }

  // ── bonnet ───────────────────────────────────────────────────────────────
  P.add(rbox(1.74, 0.055, 1.00, 0.024, 2), 'paint', at(0, D.waist + 0.065, 1.62, -0.006), grime);
  for (const s of [-1, 1]) {                                  // hood catches
    P.add(rbox(0.075, 0.05, 0.14, 0.018), 'plastic', at(s * 0.78, D.waist + 0.08, 1.20), [1, 1, 1]);
    P.add(rbox(0.05, 0.09, 0.05, 0.014), 'plastic', at(s * 0.78, D.waist + 0.055, 1.12), [0.9, 0.9, 0.95]);
  }
  // cowl vents
  for (const s of [-1, 1]) {
    P.add(rbox(0.30, 0.02, 0.10, 0.008), 'trim', at(s * 0.34, D.waist + 0.095, 1.30), [0.45, 0.45, 0.5]);
  }

  // ── the face: seven slots and two round lamps ────────────────────────────
  // The tub's bevel puts the painted front face ~35 mm proud of D.front, so
  // everything here is measured from FZ, which already clears it. (The Roamer
  // learned this the hard way — its whole grille panel was swallowed.)
  const FZ = D.front + 0.042;
  const GY0 = 0.28, GY1 = 0.60;
  // black backing the slots are cut out of
  P.add(rbox(0.90, GY1 - GY0 + 0.02, 0.05, 0.012), 'trim',
    at(0, (GY0 + GY1) / 2, FZ - 0.012), [0.32, 0.32, 0.38]);
  // Seven vertical slots, drawn as the EIGHT ribs between and beside them — the
  // openings are the black backing showing through, because geometry here
  // cannot be subtracted.
  for (let i = 0; i <= 7; i++) {
    const x = -0.45 + (i / 7) * 0.90;
    P.add(rbox(0.043, GY1 - GY0 + 0.02, 0.045, 0.010), 'paint',
      at(x, (GY0 + GY1) / 2, FZ - 0.004), grime);
  }
  P.add(rbox(0.98, 0.05, 0.055, 0.016), 'paint', at(0, GY1 + 0.02, FZ - 0.004), grime);
  P.add(rbox(0.98, 0.05, 0.055, 0.016), 'paint', at(0, GY0 - 0.02, FZ - 0.004), grime);

  for (const s of [-1, 1]) {
    // round headlight in a body-colour surround, the way a Wrangler wears them
    P.add(new THREE.CylinderGeometry(0.165, 0.175, 0.07, 20), 'paint',
      at(s * D.lampX, D.lampY, FZ - 0.03, Math.PI / 2), grime);
    P.add(new THREE.TorusGeometry(0.148, 0.020, 8, 22), 'trim',
      at(s * D.lampX, D.lampY, FZ + 0.008), [0.4, 0.4, 0.46]);
    P.add(new THREE.SphereGeometry(0.136, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'lensHead',
      at(s * D.lampX, D.lampY, FZ + 0.006, Math.PI / 2, 0, 0, 1, 0.40, 1));
    // round turn signal outboard of the grille, in the wing
    P.add(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 14), 'lensAmber',
      at(s * 0.80, 0.42, FZ - 0.02, Math.PI / 2));
  }

  // ── front bumper, hoop rack and winch ────────────────────────────────────
  const BY = 0.10;
  P.add(rbox(1.94, 0.24, 0.30, 0.05, 2), 'plastic', at(0, BY, FZ - 0.10), [1, 1, 1]);
  P.add(rbox(1.86, 0.10, 0.26, 0.035, 1), 'plastic', at(0, BY - 0.16, FZ - 0.12), [0.86, 0.86, 0.9]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.18, 0.26, 0.20, 0.04, 1), 'plastic', at(s * 0.94, BY + 0.02, FZ - 0.16), [0.92, 0.92, 0.96]);
    P.add(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 14), 'lensHead',   // fog lamps
      at(s * 0.62, BY - 0.02, FZ + 0.055, Math.PI / 2), [0.85, 0.85, 0.88]);
    P.add(new THREE.TorusGeometry(0.055, 0.016, 6, 14), 'steel',            // recovery shackles
      at(s * 0.36, BY - 0.05, FZ + 0.055, 0, Math.PI / 2, 0), [0.9, 0.9, 0.95]);
  }

  // Winch: drum, motor, control box, fairlead, a turn of cable and the hook
  // stowed on a bumper shackle. It sits ON TOP of the bumper and forward of the
  // grille — buried behind the bumper it was a dark smudge, and a winch you
  // cannot see is a winch the model did not need to build.
  const WY = BY + 0.28, WZ = FZ + 0.02;
  P.add(new THREE.CylinderGeometry(0.125, 0.125, 0.46, 16), 'trim',
    at(0, WY, WZ, 0, 0, Math.PI / 2), [0.48, 0.48, 0.54]);
  for (const s of [-1, 1]) {                              // drum end flanges
    P.add(new THREE.CylinderGeometry(0.145, 0.145, 0.035, 16), 'steel',
      at(s * 0.24, WY, WZ, 0, 0, Math.PI / 2), [0.7, 0.7, 0.76]);
  }
  P.add(new THREE.CylinderGeometry(0.105, 0.105, 0.30, 14), 'steel',
    at(-0.42, WY, WZ, 0, 0, Math.PI / 2), [0.78, 0.78, 0.84]);   // motor
  P.add(rbox(0.24, 0.24, 0.22, 0.03), 'trim', at(0.40, WY + 0.02, WZ), [0.42, 0.42, 0.48]);  // control box
  P.add(rbox(0.44, 0.06, 0.16, 0.02), 'steel', at(0, WY - 0.20, WZ + 0.02), [0.72, 0.72, 0.78]);  // cradle
  P.add(rbox(0.32, 0.14, 0.05, 0.016), 'steel', at(0, BY + 0.08, FZ + 0.10), [0.75, 0.75, 0.8]);  // fairlead
  P.add(rod(0.011, 0.34), 'chrome', at(0, BY + 0.02, FZ + 0.12, 0.75), [1, 1, 1]);               // cable
  P.add(new THREE.TorusGeometry(0.04, 0.012, 6, 12), 'chrome', at(0.10, BY - 0.10, FZ + 0.13, 0.2));

  // The rack: a stinger hoop over the winch, and the light bar it carries.
  const hoopX = 0.66, hoopTop = D.waist + 0.30;
  for (const s of [-1, 1]) {
    P.add(rod(0.036, hoopTop - BY - 0.10), 'plastic',
      at(s * hoopX, (BY + 0.06 + hoopTop) / 2, FZ + 0.03, -0.16), [1, 1, 1]);
    P.add(rod(0.030, 0.52), 'plastic',
      at(s * (hoopX + 0.10), BY + 0.30, FZ - 0.12, 0, 0.95), [1, 1, 1]);        // outriggers
    P.add(rod(0.028, 0.34), 'plastic',
      at(s * hoopX, hoopTop - 0.34, FZ - 0.14, -0.9), [1, 1, 1]);               // back stays
  }
  P.add(rod(0.036, hoopX * 2), 'plastic', at(0, hoopTop, FZ - 0.02, 0, 0, Math.PI / 2), [1, 1, 1]);
  P.add(rod(0.030, hoopX * 2), 'plastic', at(0, BY + 0.42, FZ + 0.01, 0, 0, Math.PI / 2), [1, 1, 1]);
  // light bar on the hoop
  P.add(rbox(1.06, 0.10, 0.09, 0.022), 'trim', at(0, hoopTop + 0.09, FZ - 0.03), [0.42, 0.42, 0.48]);
  for (let i = 0; i < 9; i++) {
    P.add(new THREE.CylinderGeometry(0.036, 0.036, 0.035, 12), 'lensHead',
      at(-0.42 + i * 0.105, hoopTop + 0.09, FZ + 0.015, Math.PI / 2), [0.95, 0.95, 0.98]);
  }

  // ── A-pillars + windscreen frame ─────────────────────────────────────────
  // Upright, because a Wrangler's is, and because it is the only thing holding
  // the roof up on this side of the cabin now that the door has gone.
  const wsRake = Math.atan2(1.02 - 0.86, D.roof - D.waist);
  const wsMidY = (D.waist + D.roof) / 2, wsMidZ = (1.02 + 0.86) / 2;
  const wsLen = Math.hypot(D.roof - D.waist, 1.02 - 0.86);
  // Body colour, because on the reference car it is: with the top off, a black
  // windscreen frame reads as a hole punched in the silhouette rather than as
  // the front hoop of the cage it actually is.
  for (const s of [-1, 1]) {
    P.add(rbox(0.075, wsLen, 0.085, 0.024, 2), 'paint',
      at(s * (D.halfWidth - 0.045), wsMidY, wsMidZ, -wsRake), grime);
  }
  P.add(rbox(1.80, 0.09, 0.10, 0.026), 'paint', at(0, D.roof - 0.02, 0.875, -wsRake), grime);
  P.add(rbox(1.80, 0.07, 0.09, 0.022), 'paint', at(0, D.waist + 0.045, 1.005, -wsRake), grime);
  // A black gasket AROUND the glass, not behind it: the first pass put a solid
  // plate on the far side of a transparent pane, which is simply an opaque
  // windscreen. Four thin strips, so you can still see the ducks through it.
  for (const e of [-1, 1]) {
    P.add(rbox(0.05, wsLen - 0.06, 0.04, 0.010), 'plastic',
      at(e * 0.845, wsMidY, wsMidZ, -wsRake), [1, 1, 1]);
    P.add(rbox(1.70, 0.045, 0.04, 0.010), 'plastic',
      at(0, wsMidY + e * (wsLen - 0.07) / 2, wsMidZ - e * 0.005, -wsRake), [1, 1, 1]);
  }
  P.add(rbox(1.66, wsLen - 0.10, 0.03, 0.01, 1), 'glass', at(0, wsMidY, wsMidZ - 0.005, -wsRake));
  for (const s of [-1, 1]) {                                        // wipers
    P.add(rbox(0.02, 0.015, 0.50, 0.006), 'trim',
      at(s * 0.34, D.waist + 0.10, 0.975, -wsRake, s * 0.35), [0.4, 0.4, 0.45]);
  }

  // ── mirrors on the windscreen frame (there is no door to hang them on) ───
  for (const s of [-1, 1]) {
    P.add(rbox(0.07, 0.14, 0.09, 0.022), 'plastic',
      at(s * (D.halfWidth - 0.03), D.waist + 0.24, 0.985, -wsRake), [1, 1, 1]);
    P.add(rod(0.020, 0.24), 'plastic',
      at(s * (D.halfWidth + 0.09), D.waist + 0.26, 0.95, 0, 0, s * 1.15), [1, 1, 1]);
    P.add(rbox(0.06, 0.20, 0.19, 0.03, 2), 'plastic',
      at(s * (D.halfWidth + 0.22), D.waist + 0.28, 0.93, 0, 0.1 * s), [1, 1, 1]);
    P.add(new THREE.PlaneGeometry(0.16, 0.15), 'chrome',
      at(s * (D.halfWidth + 0.252), D.waist + 0.28, 0.93, 0, s * (Math.PI / 2 + 0.1)), [0.42, 0.45, 0.50]);
  }

  // ── rear: tailgate, spare carrier, lamps, bumper ─────────────────────────
  P.add(rbox(1.70, 0.62, 0.05, 0.026, 2), 'paint', at(0, 0.24, D.rear - 0.02), grime);
  for (const s of [-1, 1]) {
    P.add(rbox(0.16, 0.30, 0.05, 0.022), 'lensTail', at(s * 0.74, 0.42, D.rear - 0.035));
    P.add(rbox(0.15, 0.09, 0.04, 0.016), 'lensAmber', at(s * 0.74, 0.20, D.rear - 0.035));
  }
  // the swing-out carrier the spare bolts to
  P.add(rbox(0.16, 0.80, 0.10, 0.03), 'plastic', at(0.64, 0.48, D.rear - 0.09), [1, 1, 1]);
  P.add(rbox(0.68, 0.16, 0.10, 0.03), 'plastic', at(0.32, 0.60, D.rear - 0.09), [1, 1, 1]);
  P.add(new THREE.CylinderGeometry(0.10, 0.10, 0.10, 14), 'steel',
    at(0.06, 0.60, D.rear - 0.13, Math.PI / 2), [0.8, 0.8, 0.85]);
  // +Z is forward, so a rear bumper at `rear + 0.05` is INSIDE the tub. The
  // first pass put it there and the only thing visible across the back of the
  // car was the bottom edge of the yellow rear panel, which read as a painted
  // bumper. It hangs off the back now, like the front one does off the front.
  // It also sits BELOW the spare rather than behind it. At bumper height the
  // 1.12 m spare and the two rear tyres between them hid every pixel of it, and
  // what read as the bumper across the back of the car was actually the tub's
  // own bottom chamfer catching the sun — a yellow bumper, in other words.
  P.add(rbox(1.98, 0.24, 0.32, 0.05, 2), 'plastic', at(0, -0.04, D.rear - 0.16), [1, 1, 1]);
  P.add(rbox(1.86, 0.20, 0.14, 0.04, 1), 'plastic', at(0, 0.14, D.rear - 0.10), [0.9, 0.9, 0.94]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.18, 0.26, 0.24, 0.04, 1), 'plastic', at(s * 0.92, -0.02, D.rear - 0.13), [0.92, 0.92, 0.96]);
    P.add(new THREE.TorusGeometry(0.05, 0.015, 6, 14), 'steel',
      at(s * 0.44, -0.08, D.rear - 0.30, 0, Math.PI / 2, 0), [0.9, 0.9, 0.95]);
  }
  P.add(rbox(0.14, 0.10, 0.24, 0.02), 'steel', at(0, -0.15, D.rear - 0.32), [0.7, 0.7, 0.75]);
  P.add(new THREE.SphereGeometry(0.05, 10, 8), 'chrome', at(0, -0.06, D.rear - 0.42));

  // ── exhaust + fuel filler ────────────────────────────────────────────────
  P.add(tube(0.045, 2.1, 8), 'trim', at(0.34, D.floor - 0.17, 0.20, Math.PI / 2), [0.65, 0.65, 0.7]);
  P.add(new THREE.CylinderGeometry(0.085, 0.085, 0.46, 12), 'trim',
    at(0.34, D.floor - 0.17, -1.06, Math.PI / 2), [0.6, 0.6, 0.66]);
  P.add(new THREE.CylinderGeometry(0.06, 0.05, 0.16, 12), 'chrome',
    at(0.44, D.floor - 0.08, D.rear + 0.04, Math.PI / 2 - 0.30));
  P.add(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 14), 'plastic',
    at(-(D.halfWidth + 0.006), 0.34, -1.62, 0, 0, Math.PI / 2), [1, 1, 1]);

  P.flush(root, materials);

  // ── moving sub-parts (kept out of the merge) ─────────────────────────────
  const spare = buildWheel(materials, { ...TYRE, spare: true });
  spare.rotation.set(0, Math.PI / 2, 0);
  spare.position.set(0.06, 0.60, D.rear - 0.36);
  spare.traverse((o) => { o.castShadow = true; });
  root.add(spare);

  const antenna = new THREE.Group();
  {
    const a = new Parts();
    a.add(new THREE.CylinderGeometry(0.006, 0.013, 1.20, 6), 'trim', at(0, 0.60, 0), [0.5, 0.5, 0.55]);
    a.add(new THREE.SphereGeometry(0.016, 8, 6), 'crimson', at(0, 1.20, 0));
    a.flush(antenna, materials, { receive: false });
  }
  antenna.position.set(-(D.halfWidth - 0.12), D.waist + 0.05, 1.16);
  antenna.rotation.x = 0.08;
  root.add(antenna);

  const steeringWheel = new THREE.Group();
  {
    const s = new Parts();
    s.add(new THREE.TorusGeometry(0.165, 0.024, 8, 22), 'rubber', null, [1.1, 1.1, 1.1]);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      s.add(rbox(0.030, 0.16, 0.012, 0.006), 'trim',
        at(Math.cos(a) * 0.082, Math.sin(a) * 0.082, 0, 0, 0, a - Math.PI / 2), [0.7, 0.7, 0.75]);
    }
    s.add(new THREE.CylinderGeometry(0.048, 0.048, 0.03, 12), 'trim', at(0, 0, 0, Math.PI / 2), [0.7, 0.7, 0.75]);
    s.flush(steeringWheel, materials, { receive: false });
  }
  steeringWheel.position.set(0.40, D.waist + 0.02, 0.66);
  steeringWheel.rotation.x = -0.34;
  root.add(steeringWheel);

  return { root, antenna, steeringWheel, spare };
}

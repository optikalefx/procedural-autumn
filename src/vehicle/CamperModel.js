// ─────────────────────────────────────────────────────────────────────────────
//  CamperModel — the camper, built entirely in code.
//
//  Shape language: a boxy 70s troop-carrier wagon (FJ40 LWB) kitted for a long
//  trip.  Everything is chamfered: a hard 90° corner catches no light and reads
//  as programmer art, whereas a 25 mm bevel gives every edge a bright terminator
//  line, which is most of what makes a shaded box look "made".
//
//  Construction is: author one *side profile* (a THREE.Shape with wheel-arch
//  notches and window apertures) and extrude it across the full body width.  One
//  extrusion therefore produces the tub, the greenhouse, the roof line, the
//  wheel arches and the window openings, all mutually consistent — far better
//  than stacking twenty boxes and hoping the silhouette works out.
//
//  Everything static is merged per-material so the whole camper is ~15 draw
//  calls despite having a few hundred parts.
//
//  The merge accumulator, the geometry sugar, the wheel, the palette and the
//  reflection probe all live in `model_kit.js` now — they were never camper
//  facts, and the second car needed them.  What is left here is this car.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, smoothstep, clamp01 } from '../core/MathUtils.js';
import {
  CHASSIS, Parts, at, rbox, tube, rod,
  archPoints, roundRect, extrudeAcross, buildWheel,
} from './model_kit.js';

// ── dimensions (metres, local space: +X right, +Y up, +Z forward) ────────────
export const DIM = {
  ...CHASSIS,         // wheelZ / wheelX / wheelY / wheelR — the shared chassis
  halfWidth: 0.95,
  front: 2.34,
  rear: -2.32,
  floor: -0.30,       // rocker / sill line
  roof: 1.16,         // top of the steel shell (the cream cap sits above)
  waist: 0.48,        // bottom of the glass
  lampX: 0.60,        // headlight centre — Vehicle aims its spot lights here
  lampY: 0.205,
  archR: 0.545,
};

// Greenhouse wall thickness, and how deep the glass sits inside its aperture.
// The reveal is what makes a window read as a hole in a panel rather than a
// sticker on one, so it is generous by real-car standards.
const WALL_T = 0.11;
const GLASS_T = 0.03;
const GLASS_INSET = 0.05;


// The body is TWO extrusions, not one.  A single side-profile extrusion makes
// the windscreen a painted wall with a pane stuck on it — you cannot cut a hole
// across the extrusion axis.  So: a full-width *tub* from the sill to the waist,
// and a thin *greenhouse* wall per side carrying the pillars and side glass.
// The roof cap closes the top and the windscreen is simply the gap between the
// two A-pillars, which is what it is on a real hardtop.
function tubShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));

  P(D.rear + 0.06, D.floor + 0.02);
  P(D.rear + 0.16, D.floor);
  P(-2.06, D.floor);
  archPoints(pts, -D.wheelZ, D.archR, D.floor, 0.50);
  P(-0.94, D.floor);
  P(0.94, D.floor);
  archPoints(pts, D.wheelZ, D.archR, D.floor, 0.50);
  P(2.06, D.floor);
  P(2.24, D.floor + 0.01);
  P(D.front, -0.06);                 // front valance
  P(D.front, 0.26);
  P(2.28, 0.42);                     // bonnet leading edge
  P(2.22, 0.44);
  P(0.99, 0.46);                     // cowl
  P(0.93, D.waist);
  P(D.rear, D.waist);
  P(D.rear, -0.04);
  return new THREE.Shape(pts);
}

function houseShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));
  P(0.99, D.waist - 0.08);
  P(0.83, D.roof);                   // A-pillar rake
  P(-2.20, D.roof);
  P(D.rear, D.roof - 0.16);
  P(D.rear, D.waist - 0.08);
  const shape = new THREE.Shape(pts);
  for (const [z0, z1] of WINDOWS) shape.holes.push(roundRect(z0, z1, 0.58, 1.04, 0.10));
  return shape;
}

/** Side-light apertures, shared by the wall, the glazing and the rubbers. */
export const WINDOWS = [[0.54, -0.22], [-0.46, -1.20], [-1.44, -1.98]];

// ─────────────────────────────────────────────────────────────────────────────
//  The camper
// ─────────────────────────────────────────────────────────────────────────────
export function buildCamper(materials, seed = 7) {
  const D = DIM;
  const rnd = mulberry32(seed);
  const root = new THREE.Group();
  root.name = 'camper';
  const P = new Parts();

  // Road grime: darkens and desaturates toward the sill, with a soft splash
  // pattern so it does not read as a uniform gradient.
  const grime = (x, y, z) => {
    const low = smoothstep(0.34, -0.32, y);
    const splash = 0.5 + 0.5 * Math.sin(z * 5.1 + x * 3.3) * Math.cos(z * 2.2 - y * 6.1);
    const arch = clamp01(1.2 - Math.min(
      Math.hypot(z - D.wheelZ, y - D.wheelY),
      Math.hypot(z + D.wheelZ, y - D.wheelY)) * 1.1);
    // The arch term does double duty: mud thrown up the flanks, and knocking
    // back the inner arch faces, which the global lighting floor otherwise
    // leaves glowing bright orange inside a wheel well that should read dark.
    const k = clamp01(low * (0.38 + 0.5 * splash) + arch * 0.55);
    const d = 1 - k * 0.42;
    return [d * (1 - k * 0.10), d * (1 + k * 0.13), d * (1 + k * 0.42)];
  };

  // ── tub (full width) + greenhouse walls (thin, one per side) ─────────────
  // `extrudeAcross` already centres its output on the body axis — an extra
  // translate here put the entire painted shell a full half-width off centre,
  // which is what the front view was really showing: no wing on one side, a
  // double-width bonnet on the other, and greenhouse walls nudged sideways to
  // chase the symptom.
  P.add(extrudeAcross(tubShape(), D.halfWidth * 2 - 0.06, 0.035), 'paint', null, grime);

  for (const s of [-1, 1]) {
    const wall = extrudeAcross(houseShape(), WALL_T, 0.028);
    wall.translate(s * (D.halfWidth - 0.005 - WALL_T * 0.5), 0, 0);
    P.add(wall, 'paint', null, grime);
  }

  // rear wall of the greenhouse, with the back window cut out of it
  {
    const w = D.halfWidth * 2 - 0.02, y0 = D.waist - 0.08, y1 = D.roof;
    const outer = new THREE.Shape();
    outer.moveTo(-w / 2, y0); outer.lineTo(w / 2, y0);
    outer.lineTo(w / 2, y1 - 0.05); outer.lineTo(w / 2 - 0.06, y1);
    outer.lineTo(-w / 2 + 0.06, y1); outer.lineTo(-w / 2, y1 - 0.05);
    const hole = new THREE.Path();
    const hw = 0.74, hy0 = 0.56, hy1 = 1.02, r = 0.08;
    hole.moveTo(-hw + r, hy0); hole.lineTo(hw - r, hy0);
    hole.quadraticCurveTo(hw, hy0, hw, hy0 + r); hole.lineTo(hw, hy1 - r);
    hole.quadraticCurveTo(hw, hy1, hw - r, hy1); hole.lineTo(-hw + r, hy1);
    hole.quadraticCurveTo(-hw, hy1, -hw, hy1 - r); hole.lineTo(-hw, hy0 + r);
    hole.quadraticCurveTo(-hw, hy0, -hw + r, hy0);
    outer.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(outer, {
      depth: 0.09, bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.022,
      bevelSegments: 2, curveSegments: 4, steps: 1,
    });
    g.translate(0, 0, D.rear - 0.02);
    P.add(g, 'paint', null, grime);
  }

  // interior: a dark box you see *into* through the screen, plus a cabin floor
  P.add(rbox(1.74, 0.86, 2.44, 0.05), 'interior', at(0, 0.72, -0.98));
  P.add(rbox(1.80, 0.03, 3.30, 0.01), 'interior', at(0, D.waist + 0.015, -0.70));
  // seats
  for (const s of [-1, 1]) {
    P.add(rbox(0.44, 0.30, 0.46, 0.06), 'interior', at(s * 0.42, 0.46, 0.28));
    P.add(rbox(0.44, 0.56, 0.12, 0.05), 'interior', at(s * 0.42, 0.74, 0.02, -0.12));
  }
  // dashboard + steering column shroud
  P.add(rbox(1.66, 0.22, 0.30, 0.05), 'interior', at(0, 0.56, 0.74, 0.18));

  // wheel-well shells so you cannot see through the arches
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const wellR = D.archR - 0.03;
    const shellG = new THREE.CylinderGeometry(wellR, wellR, 0.40, 16, 1, true, 0, Math.PI);
    shellG.rotateZ(Math.PI / 2);
    shellG.rotateX(-Math.PI / 2);
    P.add(shellG, 'flare', at(sx * (D.wheelX - 0.03), D.floor, sz * D.wheelZ), [0.55, 0.55, 0.6]);
    P.add(new THREE.CircleGeometry(wellR, 14, 0, Math.PI), 'flare',
      at(sx * (D.wheelX - 0.23), D.floor, sz * D.wheelZ, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0),
      [0.55, 0.55, 0.6]);
  }

  // underbody floor pan + chassis rails
  P.add(rbox(1.42, 0.10, 4.30, 0.03), 'trim', at(0, D.floor - 0.04, -0.02), [0.6, 0.6, 0.66]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.14, 0.16, 4.10, 0.03), 'trim', at(s * 0.44, D.floor - 0.14, 0), [0.5, 0.5, 0.56]);
  }
  // axles + diff pumpkins (visible under the arches, sells the ladder frame)
  for (const sz of [-1, 1]) {
    P.add(tube(0.055, 1.78, 8), 'trim', at(0, D.wheelY, sz * D.wheelZ, 0, 0, Math.PI / 2), [0.55, 0.55, 0.6]);
    P.add(new THREE.SphereGeometry(0.16, 12, 9), 'trim', at(0.16, D.wheelY, sz * D.wheelZ), [0.5, 0.5, 0.56]);
    P.add(tube(0.05, 0.9, 8), 'trim', at(0.16, D.wheelY + 0.06, sz * (D.wheelZ - 0.45), 0.28), [0.5, 0.5, 0.56]);
  }
  // leaf springs
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    P.add(rbox(0.09, 0.05, 1.05, 0.02), 'trim',
      at(sx * 0.62, D.wheelY + 0.10, sz * D.wheelZ), [0.45, 0.45, 0.5]);
  }

  // ── cream hardtop roof ───────────────────────────────────────────────────
  P.add(rbox(D.halfWidth * 2 + 0.03, 0.15, 3.10, 0.055, 2), 'cream', at(0, D.roof + 0.045, -0.72));
  // rain gutters
  for (const s of [-1, 1]) {
    P.add(rbox(0.05, 0.05, 3.06, 0.018), 'cream', at(s * (D.halfWidth + 0.01), D.roof - 0.005, -0.72));
  }

  // ── wheel-arch flares ────────────────────────────────────────────────────
  // Black plastic flares are half of what makes a 4x4 read as a 4x4 in
  // silhouette, and they hide the seam where the arch meets the tyre.
  const flare = (cz) => {
    const n = 13, R = D.archR + 0.05, H = 0.55;
    const pt = (k) => {
      const a = Math.PI - (k / n) * Math.PI;
      return [cz + R * Math.cos(a), D.floor + H * Math.pow(Math.sin(a), 0.62)];
    };
    for (let k = 0; k < n; k++) {
      const [z0, y0] = pt(k), [z1, y1] = pt(k + 1);
      const len = Math.hypot(z1 - z0, y1 - y0);
      const ang = Math.atan2(y1 - y0, z1 - z0);
      for (const sx of [-1, 1]) {
        P.add(rbox(0.16, 0.075, len + 0.03, 0.028, 1), 'flare',
          at(sx * (D.halfWidth - 0.03), (y0 + y1) / 2, (z0 + z1) / 2, -ang, 0, 0), [1, 1, 1]);
      }
    }
  };
  flare(D.wheelZ);
  flare(-D.wheelZ);

  // ── doors: proud skins leave a real panel gap all round ──────────────────
  const doorSkin = (z0, z1, y0, y1) => {
    const w = 0.038, cz = (z0 + z1) / 2, cy = (y0 + y1) / 2;
    for (const s of [-1, 1]) {
      P.add(rbox(w, y1 - y0, Math.abs(z1 - z0), 0.022, 2),
        'paint', at(s * (D.halfWidth - 0.045), cy, cz), grime);
    }
  };
  doorSkin(0.52, -0.24, -0.24, 0.44);
  doorSkin(-0.48, -1.22, -0.24, 0.44);

  // door handles + hinges
  for (const s of [-1, 1]) {
    for (const dz of [0.14, -0.90]) {
      P.add(rbox(0.045, 0.045, 0.20, 0.018), 'chrome', at(s * (D.halfWidth - 0.005), 0.30, dz));
      P.add(rbox(0.03, 0.05, 0.055, 0.012), 'chrome', at(s * (D.halfWidth - 0.01), 0.30, dz + 0.13));
    }
    for (const dz of [0.54, -0.40]) for (const dy of [0.36, -0.16]) {
      P.add(rbox(0.028, 0.05, 0.09, 0.012), 'trim', at(s * (D.halfWidth - 0.012), dy, dz), [0.6, 0.6, 0.65]);
    }
  }

  // ── bonnet: separate panel with a shut line, plus latches and a vent ──────
  P.add(rbox(1.78, 0.055, 1.22, 0.026, 2), 'paint', at(0, 0.452, 1.60, -0.012), grime);
  for (const s of [-1, 1]) {
    P.add(rbox(0.06, 0.03, 0.09, 0.012), 'chrome', at(s * 0.72, 0.48, 2.20));   // latches
  }
  P.add(rbox(0.62, 0.02, 0.14, 0.008), 'trim', at(0, 0.482, 1.16), [0.6, 0.6, 0.65]);  // cowl vent

  // ── grille + front face ──────────────────────────────────────────────────
  P.add(rbox(1.64, 0.30, 0.06, 0.02), 'trim', at(0, 0.20, D.front - 0.02), [0.55, 0.55, 0.62]);
  for (let i = 0; i < 11; i++) {
    P.add(rbox(0.035, 0.26, 0.05, 0.01), 'chrome', at(-0.66 + i * 0.132, 0.20, D.front + 0.005));
  }
  P.add(rbox(1.72, 0.05, 0.05, 0.018), 'chrome', at(0, 0.36, D.front));   // grille surround
  P.add(rbox(1.72, 0.05, 0.05, 0.018), 'chrome', at(0, 0.035, D.front));

  // headlights: chrome bucket + emissive lens, inboard of the wings
  for (const s of [-1, 1]) {
    P.add(new THREE.CylinderGeometry(0.135, 0.15, 0.10, 18), 'chrome',
      at(s * 0.60, 0.205, D.front - 0.02, Math.PI / 2));
    // A shallow dome. A full hemisphere at this radius caught the sky square-on
    // and blew out to a white ball in every daylight frame.
    P.add(new THREE.SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'lensHead',
      at(s * 0.60, 0.205, D.front + 0.012, Math.PI / 2, 0, 0, 1, 0.42, 1));
    // indicator + side marker
    P.add(rbox(0.13, 0.075, 0.05, 0.018), 'lensAmber', at(s * 0.80, 0.36, D.front - 0.005));
  }

  // ── bumpers, bull bar, winch ─────────────────────────────────────────────
  P.add(rbox(1.94, 0.16, 0.20, 0.045, 2), 'steel', at(0, -0.14, D.front - 0.02), [0.85, 0.85, 0.9]);
  P.add(rbox(1.90, 0.17, 0.22, 0.05, 2), 'steel', at(0, -0.14, D.rear + 0.02), [0.85, 0.85, 0.9]);
  // tow hitch
  P.add(rbox(0.14, 0.10, 0.26, 0.02), 'steel', at(0, -0.22, D.rear - 0.14), [0.7, 0.7, 0.75]);
  P.add(new THREE.SphereGeometry(0.05, 10, 8), 'chrome', at(0, -0.13, D.rear - 0.24));

  // bull bar: two uprights, a wrap-around hoop and a top rail
  const barR = 0.042;
  for (const s of [-1, 1]) {
    P.add(rod(barR, 0.62), 'steel', at(s * 0.70, 0.06, D.front + 0.20));
    P.add(rod(barR, 0.30), 'steel', at(s * 0.70, 0.34, D.front + 0.12, 1.0));
    P.add(rod(barR, 0.44), 'steel', at(s * 0.86, 0.10, D.front + 0.05, 0, 0.9));
  }
  P.add(rod(barR, 1.44), 'steel', at(0, 0.37, D.front + 0.20, 0, 0, Math.PI / 2));
  P.add(rod(barR, 1.44), 'steel', at(0, -0.06, D.front + 0.22, 0, 0, Math.PI / 2));
  for (let i = -1; i <= 1; i++) {
    P.add(rod(0.028, 0.42), 'steel', at(i * 0.40, 0.16, D.front + 0.21));
  }
  // winch: drum, fairlead, a turn of cable
  P.add(new THREE.CylinderGeometry(0.10, 0.10, 0.40, 14), 'trim',
    at(0, 0.12, D.front + 0.02, 0, 0, Math.PI / 2), [0.5, 0.5, 0.56]);
  P.add(new THREE.CylinderGeometry(0.115, 0.115, 0.26, 16), 'steel',
    at(0, 0.12, D.front + 0.02, 0, 0, Math.PI / 2), [0.75, 0.75, 0.8]);
  P.add(rbox(0.30, 0.13, 0.06, 0.02), 'steel', at(0, 0.12, D.front + 0.20), [0.7, 0.7, 0.76]);
  P.add(new THREE.TorusGeometry(0.035, 0.012, 6, 12), 'chrome', at(0, 0.12, D.front + 0.25, Math.PI / 2));

  // ── rear: tailgate, lights, spare fuel, ladder ───────────────────────────
  P.add(rbox(1.72, 0.62, 0.05, 0.028, 2), 'paint', at(0, 0.06, D.rear - 0.015), grime);
  P.add(rbox(0.24, 0.05, 0.05, 0.018), 'chrome', at(0.44, 0.24, D.rear - 0.05));
  for (const s of [-1, 1]) {
    P.add(rbox(0.16, 0.26, 0.05, 0.022), 'lensTail', at(s * 0.72, 0.10, D.rear - 0.03));
    P.add(rbox(0.14, 0.08, 0.04, 0.016), 'lensAmber', at(s * 0.72, -0.09, D.rear - 0.03));
  }
  // number plate + a lamp
  P.add(rbox(0.42, 0.15, 0.02, 0.01), 'cream', at(-0.36, -0.05, D.rear - 0.04), [0.95, 0.95, 0.95]);

  // rear ladder on the left
  const ladX = -0.66;
  for (const s of [-1, 1]) {
    P.add(rod(0.022, 1.44), 'steel', at(ladX + s * 0.14, 0.42, D.rear - 0.10, -0.06), [0.8, 0.8, 0.85]);
  }
  for (let i = 0; i < 6; i++) {
    P.add(rod(0.017, 0.30), 'steel',
      at(ladX, -0.18 + i * 0.24, D.rear - 0.115 - i * 0.008, 0, 0, Math.PI / 2), [0.8, 0.8, 0.85]);
  }

  // ── snorkel up the right A-pillar ────────────────────────────────────────
  const snX = D.halfWidth - 0.015;
  P.add(tube(0.07, 0.40, 10), 'trim', at(snX, 0.28, 1.44), [0.85, 0.85, 0.9]);
  P.add(new THREE.TorusGeometry(0.115, 0.07, 8, 14, Math.PI / 2), 'trim',
    at(snX, 0.49, 1.325, Math.PI / 2, 0, 0), [0.85, 0.85, 0.9]);
  P.add(tube(0.07, 0.62, 10), 'trim', at(snX, 0.80, 1.19, -0.055), [0.85, 0.85, 0.9]);
  P.add(rbox(0.15, 0.24, 0.18, 0.035, 2), 'trim', at(snX, 1.22, 1.16, -0.055), [0.9, 0.9, 0.95]);
  P.add(rbox(0.155, 0.10, 0.03, 0.014), 'trim', at(snX, 1.22, 1.245, -0.055), [0.5, 0.5, 0.55]);
  for (const y of [0.66, 0.98]) {
    P.add(new THREE.TorusGeometry(0.08, 0.014, 6, 12), 'chrome', at(snX, y, 1.245 - (y - 0.66) * 0.055, 1.515));
  }

  // ── side steps / rock sliders ────────────────────────────────────────────
  for (const s of [-1, 1]) {
    P.add(rod(0.048, 2.10), 'steel',
      at(s * (D.halfWidth + 0.02), D.floor - 0.10, -0.05, Math.PI / 2, 0, 0), [0.72, 0.72, 0.78]);
    for (const dz of [0.72, -0.05, -0.82]) {
      P.add(rod(0.03, 0.24), 'steel',
        at(s * (D.halfWidth - 0.04), D.floor - 0.04, dz, 0, 0, s * 0.9), [0.72, 0.72, 0.78]);
    }
  }

  // ── mud flaps ────────────────────────────────────────────────────────────
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const z = sz > 0 ? D.wheelZ - 0.70 : -(D.wheelZ + 0.70);
    P.add(rbox(0.32, 0.32, 0.02, 0.012), 'rubber',
      at(sx * (D.wheelX - 0.02), D.floor - 0.12, z, 0.14), [1, 1, 1]);
  }

  // ── exhaust ──────────────────────────────────────────────────────────────
  P.add(tube(0.045, 2.2, 8), 'trim', at(0.36, D.floor - 0.16, 0.20, Math.PI / 2), [0.65, 0.65, 0.7]);
  P.add(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 12), 'trim',
    at(0.36, D.floor - 0.16, -1.10, Math.PI / 2), [0.6, 0.6, 0.66]);
  P.add(tube(0.045, 0.9, 8), 'trim', at(0.42, D.floor - 0.14, -1.75, Math.PI / 2 - 0.12, 0.06), [0.65, 0.65, 0.7]);
  P.add(new THREE.CylinderGeometry(0.062, 0.05, 0.16, 12), 'chrome',
    at(0.46, D.floor - 0.06, D.rear + 0.02, Math.PI / 2 - 0.30));

  // ── fuel filler ──────────────────────────────────────────────────────────
  P.add(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 14), 'chrome',
    at(-(D.halfWidth + 0.005), 0.18, -1.62, 0, 0, Math.PI / 2));

  // ── glass ────────────────────────────────────────────────────────────────
  // Real slabs set into real apertures. Each pane is slightly larger than its
  // hole so the edges bury themselves in the panel, and sits GLASS_INSET behind
  // the outer skin so the reveal catches a shadow.
  const wallOuter = D.halfWidth - 0.005;
  const glassX = wallOuter - GLASS_INSET - GLASS_T * 0.5;
  for (const s of [-1, 1]) {
    for (const [z0, z1] of WINDOWS) {
      P.add(rbox(GLASS_T, 0.52, Math.abs(z1 - z0) + 0.05, 0.008, 1), 'glass',
        at(s * glassX, 0.81, (z0 + z1) / 2));
    }
  }

  // Windscreen: raked to match the A-pillar exactly, and narrow enough to sit
  // *between* the pillars. The previous full-width pane covered them, which is
  // precisely why the front of the camper read as one painted slab.
  const wsRake = Math.atan2(0.99 - 0.83, D.roof - (D.waist - 0.08));
  P.add(rbox(1.68, 0.70, GLASS_T, 0.01, 1), 'glass', at(0, 0.79, 0.862, -wsRake));

  // Rear window, set into the tailgate wall the same way.
  P.add(rbox(1.52, 0.50, GLASS_T, 0.01, 1), 'glass', at(0, 0.79, D.rear + 0.025));

  // ── window surrounds ─────────────────────────────────────────────────────
  // A bright frame all the way round each aperture. Without the verticals the
  // apertures had only a top and bottom rail and read as decals; these also
  // give the flat flank something to catch the light on.
  for (const s of [-1, 1]) {
    const x = s * (wallOuter + 0.006);
    for (const [z0, z1] of WINDOWS) {
      const w = Math.abs(z1 - z0), cz = (z0 + z1) / 2;
      for (const y of [0.567, 1.053]) {
        P.add(rbox(0.022, 0.030, w + 0.052, 0.008), 'chrome', at(x, y, cz), [0.95, 0.95, 1.0]);
      }
      for (const e of [-1, 1]) {
        P.add(rbox(0.022, 0.516, 0.030, 0.008), 'chrome',
          at(x, 0.810, cz + e * (w / 2 + 0.011)), [0.95, 0.95, 1.0]);
      }
    }
  }
  // rear window surround
  for (const e of [-1, 1]) {
    P.add(rbox(0.030, 0.50, 0.022, 0.008), 'chrome', at(e * 0.755, 0.79, D.rear - 0.028), [0.95, 0.95, 1.0]);
    P.add(rbox(1.54, 0.030, 0.022, 0.008), 'chrome', at(0, 0.79 + e * 0.252, D.rear - 0.028), [0.95, 0.95, 1.0]);
  }

  // windscreen frame + wipers. The cowl rail caps the bottom edge of the glass
  // and the header rail caps the top, so neither edge floats.
  P.add(rbox(1.80, 0.075, 0.07, 0.022), 'paint', at(0, 0.452, 0.952, -wsRake), grime);
  P.add(rbox(1.80, 0.075, 0.09, 0.022), 'paint', at(0, 1.128, 0.806, -wsRake), grime);
  for (const s of [-1, 1]) {
    P.add(rbox(0.02, 0.015, 0.52, 0.006), 'trim',
      at(s * 0.34, 0.50, 0.905, -wsRake, s * 0.35), [0.4, 0.4, 0.45]);
  }

  // ── wing mirrors ─────────────────────────────────────────────────────────
  for (const s of [-1, 1]) {
    P.add(rod(0.02, 0.30), 'steel', at(s * (D.halfWidth + 0.11), 0.70, 0.72, 0, 0, s * 1.05), [0.7, 0.7, 0.75]);
    P.add(rbox(0.055, 0.22, 0.17, 0.03, 2), 'trim', at(s * (D.halfWidth + 0.24), 0.72, 0.70, 0, 0.1 * s));
    P.add(new THREE.PlaneGeometry(0.16, 0.14), 'chrome',
      at(s * (D.halfWidth + 0.268), 0.72, 0.70, 0, s * (Math.PI / 2 + 0.1)), [0.42, 0.45, 0.50]);
  }

  // ── roof rack + load ─────────────────────────────────────────────────────
  const rackY = D.roof + 0.14;
  const rackZ0 = 0.64, rackZ1 = -2.22, rackLen = rackZ0 - rackZ1;
  const rackHalf = D.halfWidth - 0.02;
  // perimeter rails
  for (const s of [-1, 1]) {
    P.add(rod(0.028, rackLen), 'rack',
      at(s * rackHalf, rackY + 0.16, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.9, 0.9, 0.95]);
    P.add(rod(0.026, rackLen), 'rack',
      at(s * rackHalf, rackY, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.9, 0.9, 0.95]);
  }
  for (const z of [rackZ0, rackZ1]) {
    P.add(rod(0.028, rackHalf * 2), 'rack', at(0, rackY + 0.16, z, 0, 0, Math.PI / 2), [0.9, 0.9, 0.95]);
    P.add(rod(0.026, rackHalf * 2), 'rack', at(0, rackY, z, 0, 0, Math.PI / 2), [0.9, 0.9, 0.95]);
  }
  // uprights + floor slats
  for (let i = 0; i <= 6; i++) {
    const z = rackZ0 - (i / 6) * rackLen;
    for (const s of [-1, 1]) P.add(rod(0.02, 0.18), 'rack', at(s * rackHalf, rackY + 0.08, z), [0.9, 0.9, 0.95]);
    P.add(rod(0.017, rackHalf * 2), 'rack', at(0, rackY - 0.01, z, 0, 0, Math.PI / 2), [0.85, 0.85, 0.9]);
  }
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * (rackHalf * 0.62);
    P.add(rod(0.016, rackLen), 'rack', at(x, rackY - 0.02, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.85, 0.85, 0.9]);
  }
  // rack feet
  for (const z of [0.48, -0.66, -2.06]) for (const s of [-1, 1]) {
    P.add(rbox(0.07, 0.14, 0.09, 0.02), 'trim', at(s * rackHalf, D.roof + 0.07, z), [0.6, 0.6, 0.65]);
  }

  const jitter = () => (rnd() - 0.5);
  const load = rackY + 0.02;

  // spare wheel, laid flat at the back of the rack
  const spare = buildWheel(materials, { spare: true });
  spare.rotation.set(0, 0, Math.PI / 2);
  spare.position.set(-0.02, load + 0.20, -1.86);
  spare.traverse((o) => { o.castShadow = true; });
  root.add(spare);

  // jerry cans
  for (let i = 0; i < 2; i++) {
    const z = 0.30 - i * 0.30, x = 0.52;
    P.add(rbox(0.26, 0.44, 0.20, 0.035, 2), 'olive', at(x, load + 0.22, z, 0, jitter() * 0.05, 0));
    P.add(rbox(0.05, 0.05, 0.16, 0.012), 'olive', at(x, load + 0.455, z));  // handle bar
    P.add(rbox(0.16, 0.02, 0.14, 0.008), 'trim', at(x + 0.135, load + 0.22, z, 0, 0, Math.PI / 2), [0.6, 0.6, 0.66]);
  }

  // blue water drum
  P.add(new THREE.CylinderGeometry(0.20, 0.20, 0.56, 18), 'drum',
    at(-0.48, load + 0.28, 0.16, 0, 0, Math.PI / 2 + jitter() * 0.04));
  for (const d of [-0.16, 0.16]) {
    P.add(new THREE.TorusGeometry(0.205, 0.018, 6, 18), 'drum',
      at(-0.48 + d * 0.0, load + 0.28, 0.16 + d, Math.PI / 2, 0, 0));
  }
  P.add(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 12), 'trim',
    at(-0.48, load + 0.48, 0.16), [0.6, 0.6, 0.66]);

  // rolled tarps / bedrolls
  const rolls = [
    { x: 0.34, z: -0.60, r: 0.135, len: 1.02, mat: 'canvas' },
    { x: 0.05, z: -0.62, r: 0.115, len: 0.92, mat: 'crimson' },
    { x: -0.26, z: -0.58, r: 0.125, len: 0.98, mat: 'olive' },
  ];
  for (const r of rolls) {
    P.add(new THREE.CylinderGeometry(r.r, r.r, r.len, 14), r.mat,
      at(r.x, load + r.r + 0.02, r.z, Math.PI / 2 + jitter() * 0.03, 0, 0));
    for (const e of [-1, 1]) {
      P.add(new THREE.CircleGeometry(r.r * 0.92, 12), r.mat,
        at(r.x, load + r.r + 0.02, r.z + e * r.len * 0.5, 0, e > 0 ? 0 : Math.PI, 0), [0.8, 0.8, 0.85]);
    }
    // strap
    P.add(new THREE.TorusGeometry(r.r + 0.012, 0.012, 5, 16), 'trim',
      at(r.x, load + r.r + 0.02, r.z + r.len * 0.26, 0, Math.PI / 2, 0), [0.5, 0.5, 0.56]);
  }

  // rooftop storage box
  P.add(rbox(0.80, 0.30, 0.62, 0.055, 2), 'olive', at(-0.02, load + 0.17, -1.16), [0.85, 0.85, 0.9]);
  P.add(rbox(0.82, 0.05, 0.64, 0.022), 'trim', at(-0.02, load + 0.335, -1.16), [0.95, 0.95, 1.0]);
  for (const dz of [-0.36, 0.34]) {                       // ratchet straps over the lid
    P.add(rbox(0.84, 0.07, 0.05, 0.015), 'canvas', at(-0.02, load + 0.30, -1.16 + dz), [0.8, 0.78, 0.72]);
  }
  for (const s of [-1, 1]) {
    P.add(rbox(0.06, 0.06, 0.05, 0.015), 'chrome', at(s * 0.28, load + 0.30, -0.86));
  }

  // coil of rope
  P.add(new THREE.TorusGeometry(0.15, 0.045, 8, 20), 'canvas',
    at(0.44, load + 0.05, -1.60, Math.PI / 2, 0, 0), [0.9, 0.85, 0.7]);
  P.add(new THREE.TorusGeometry(0.13, 0.04, 8, 20), 'canvas',
    at(0.44, load + 0.11, -1.62, Math.PI / 2, 0.3, 0), [0.95, 0.9, 0.75]);

  // traction boards strapped to the rack side
  for (let i = 0; i < 2; i++) {
    P.add(rbox(0.035, 0.28, 1.10, 0.02), 'orange',
      at(-(rackHalf + 0.05) - i * 0.045, rackY + 0.10, -0.90, 0, 0, 0.03));
  }

  // ── awning roll along the left roof edge ─────────────────────────────────
  const awY = D.roof + 0.24, awX = -(D.halfWidth + 0.115);
  P.add(new THREE.CylinderGeometry(0.095, 0.095, 2.26, 14), 'olive',
    at(awX, awY, -0.72, Math.PI / 2), [1.05, 1.05, 1.05]);
  for (const e of [-1, 1]) {
    P.add(new THREE.CylinderGeometry(0.105, 0.105, 0.08, 12), 'trim',
      at(awX, awY, -0.72 + e * 1.14, Math.PI / 2), [0.6, 0.6, 0.66]);
  }
  for (const dz of [0.20, -1.64]) {
    P.add(new THREE.TorusGeometry(0.105, 0.012, 5, 14), 'trim', at(awX, awY, dz, 0, Math.PI / 2, 0), [0.5, 0.5, 0.55]);
    P.add(rbox(0.14, 0.05, 0.05, 0.015), 'steel', at(-(D.halfWidth + 0.05), awY, dz), [0.8, 0.8, 0.85]);
  }

  // ── roof-mounted light bar ───────────────────────────────────────────────
  P.add(rbox(0.86, 0.075, 0.09, 0.025), 'trim', at(0, rackY + 0.26, rackZ0 - 0.02), [0.5, 0.5, 0.56]);
  for (let i = 0; i < 4; i++) {
    P.add(new THREE.CylinderGeometry(0.058, 0.058, 0.045, 14), 'lensHead',
      at(-0.30 + i * 0.20, rackY + 0.26, rackZ0 + 0.03, Math.PI / 2));
  }

  P.flush(root, materials);

  // ── moving sub-parts (kept out of the merge) ─────────────────────────────
  const antenna = new THREE.Group();
  {
    const a = new Parts();
    a.add(new THREE.CylinderGeometry(0.006, 0.013, 1.15, 6), 'trim', at(0, 0.575, 0), [0.5, 0.5, 0.55]);
    a.add(new THREE.SphereGeometry(0.017, 8, 6), 'crimson', at(0, 1.15, 0));   // pennant ball
    a.flush(antenna, materials, { receive: false });
  }
  antenna.position.set(D.halfWidth - 0.06, 0.34, 1.06);
  root.add(antenna);

  const steeringWheel = new THREE.Group();
  {
    const s = new Parts();
    const ring = new THREE.TorusGeometry(0.17, 0.022, 8, 22);
    s.add(ring, 'rubber', null, [1.1, 1.1, 1.1]);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      s.add(rbox(0.028, 0.16, 0.012, 0.006), 'trim',
        at(Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0, 0, 0, a - Math.PI / 2), [0.7, 0.7, 0.75]);
    }
    s.add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), 'trim', at(0, 0, 0, Math.PI / 2), [0.7, 0.7, 0.75]);
    s.flush(steeringWheel, materials, { receive: false });
  }
  steeringWheel.position.set(0.42, 0.60, 0.62);
  steeringWheel.rotation.x = -0.42;
  root.add(steeringWheel);

  return { root, antenna, steeringWheel, spare };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RoamerModel — the second car: a two-tone retro 4x4 wagon.
//
//  Reference is the modern heritage-trim 4-door: robin's-egg blue body, white
//  hardtop and grille panel, black flares and bumpers, white steel wheels.
//  Where the camper is a loaded overland rig, this one is deliberately CLEAN —
//  no rack, no jerry cans, no snorkel.  Two cars that differ only in paint are
//  one car; the silhouette has to carry the difference from 40 m away, so the
//  Roamer's is a bare roof line and a fat spare on the tailgate.
//
//  Built the same way as the camper and out of the same parts bin
//  (`model_kit.js`): a tub extrusion from sill to waist, a thin greenhouse wall
//  per side carrying the pillars and window apertures, a roof cap on top, and
//  everything merged per material.  Read CamperModel.js first if you are
//  wondering why it is two extrusions and not one.
//
//  THE BADGE IS NOT A WORD.  The grille carries four red marks that read as
//  lettering at a glance and spell nothing — see BADGE_GLYPHS.  That is a
//  requirement, not an oversight: this is a real-looking vehicle in a shipping
//  game and it does not get to wear a manufacturer's name.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, smoothstep, clamp01 } from '../core/MathUtils.js';
import {
  CHASSIS, C, Parts, at, rbox, tube, rod,
  archPoints, roundRect, extrudeAcross, buildWheel, buildMaterials,
} from './model_kit.js';

// ── dimensions (metres, local space: +X right, +Y up, +Z forward) ────────────
// Body extents only. The wheels come from CHASSIS and are not negotiable — see
// the note there. The Roamer is a hair taller and squarer than the camper,
// which is most of what separates them in silhouette.
export const DIM = {
  ...CHASSIS,
  halfWidth: 0.96,
  front: 2.36,
  rear: -2.34,
  floor: -0.28,       // rocker / sill line
  roof: 1.22,         // top of the painted shell (the white cap sits above)
  waist: 0.54,        // bottom of the glass
  lampX: 0.72,        // headlight centre — Vehicle aims its spot lights here
  lampY: 0.29,
  archR: 0.60,        // wider arches than the camper: the flares are the look
};

const WALL_T = 0.11;
const GLASS_T = 0.03;
const GLASS_INSET = 0.05;

// ── the two-tone ─────────────────────────────────────────────────────────────
// Body blue and cap white. These go through `buildMaterials` so the Roamer's
// paint answers to the same clearcoat and env-probe tuning as the camper's —
// the reason that matters is written out over `paint` in model_kit.js.
const BODY_BLUE = 0x9cc7d8;
const CAP_WHITE = 0xeef0ec;

/** Side-light apertures: front door, rear door, rear quarter. A 4-door. */
export const WINDOWS = [[0.62, -0.10], [-0.20, -1.02], [-1.16, -1.86]];
const WIN_Y0 = 0.66, WIN_Y1 = 1.10;

// Where the white quarter panel starts. Everything aft of this, above the
// waist, is cap white — it wraps the rear quarter window and the D-pillar,
// which is what makes the two-tone read as a *hardtop* rather than a stripe.
const QUARTER_Z = -1.10;

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
export function buildRoamerMaterials(env) {
  const mats = buildMaterials(env, { body: BODY_BLUE, cream: CAP_WHITE });

  // Near-black textured plastic: flares, bumpers, window frames, steps. The
  // camper's `flare` grey is a 70s painted-steel grey and reads soft; a modern
  // 4x4's cladding is darker and flatter than anything already in the palette.
  mats.plastic = new THREE.MeshStandardMaterial({
    color: C(0x2b2c31), roughness: 0.88, metalness: 0.05,
    envMap: env, envMapIntensity: 0.35, vertexColors: true,
  });

  // Badge red. It sits in the shade of a recessed grille all day, and Stylize
  // floors unlit surfaces rather than crushing them, so a plain red went to mud
  // at any distance. The small emissive term is what keeps the marks legible
  // from the chase cam — it is a readability fix, not a glow.
  mats.badge = new THREE.MeshStandardMaterial({
    color: C(0xc32319), emissive: C(0xa8140c), emissiveIntensity: 0.22,
    roughness: 0.52, metalness: 0.0, envMap: env, envMapIntensity: 0.3,
    vertexColors: true,
  });
  return mats;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Side profiles
// ─────────────────────────────────────────────────────────────────────────────
//
// The front face is a tall vertical slab, unlike the camper's raked valance:
// the whole design of this car is that white panel between the headlights, and
// a slab is what it needs to sit on. The bonnet behind it is nearly flat.
function tubShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));

  P(D.rear + 0.06, D.floor + 0.02);
  P(D.rear + 0.16, D.floor);
  P(-2.10, D.floor);
  archPoints(pts, -D.wheelZ, D.archR, D.floor, 0.54);
  P(-0.88, D.floor);
  P(0.88, D.floor);
  archPoints(pts, D.wheelZ, D.archR, D.floor, 0.54);
  P(2.10, D.floor);
  P(2.30, D.floor + 0.02);
  P(D.front, 0.08);                  // bottom of the front slab
  P(D.front, 0.50);                  // fender crest / top of the grille panel
  P(2.30, 0.525);
  P(1.06, 0.535);                    // bonnet: essentially flat
  P(1.00, D.waist);
  P(D.rear, D.waist);
  P(D.rear, -0.04);
  return new THREE.Shape(pts);
}

function houseShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));
  P(1.00, D.waist - 0.06);
  P(0.88, D.roof);                   // A-pillar: upright, this is a windowbox
  P(-2.24, D.roof);
  P(D.rear, D.roof - 0.10);
  P(D.rear, D.waist - 0.06);
  const shape = new THREE.Shape(pts);
  for (const [z0, z1] of WINDOWS) shape.holes.push(roundRect(z0, z1, WIN_Y0, WIN_Y1, 0.09));
  return shape;
}

/** The white quarter panel: the aft slice of the greenhouse wall, in cap white. */
function quarterShape() {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));
  P(QUARTER_Z, D.waist - 0.02);
  P(QUARTER_Z, D.roof);
  P(-2.24, D.roof);
  P(D.rear + 0.01, D.roof - 0.10);
  P(D.rear + 0.01, D.waist - 0.02);
  const shape = new THREE.Shape(pts);
  const [z0, z1] = WINDOWS[2];
  shape.holes.push(roundRect(z0, z1, WIN_Y0, WIN_Y1, 0.09));
  return shape;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The badge
// ─────────────────────────────────────────────────────────────────────────────
//
// Four marks, each a list of strokes in a unit glyph box (x and y in 0..1),
// laid across the middle of the grille in red. Every one of them is broken,
// unjoined or mirrored out of being a letter on purpose — an upright with an
// arm at the top and the middle is an F, so none of these has both. At two
// metres they read as a badge; at any distance they read as red. Neither
// reading is a word, which is the entire point.
const BADGE_GLYPHS = [
  // upright, and an arm that floats clear of it
  [[0.20, 0.00, 0.20, 1.00], [0.48, 0.60, 0.96, 0.60]],
  // two uprights of unequal height, never joined
  [[0.16, 0.00, 0.16, 1.00], [0.68, 0.20, 0.68, 0.84]],
  // a bracket with its spine broken out of the middle
  [[0.10, 0.00, 0.88, 0.00], [0.10, 1.00, 0.88, 1.00],
   [0.82, 0.00, 0.82, 0.32], [0.82, 0.68, 0.82, 1.00]],
  // the first mark, mirrored and dropped — a rune, not a glyph
  [[0.80, 0.00, 0.80, 1.00], [0.06, 0.30, 0.52, 0.30]],
];

// ─────────────────────────────────────────────────────────────────────────────
//  The Roamer
// ─────────────────────────────────────────────────────────────────────────────
export function buildRoamer(materials, seed = 3) {
  const D = DIM;
  const rnd = mulberry32(seed);
  const root = new THREE.Group();
  root.name = 'roamer';
  const P = new Parts();

  // Road grime, at about two thirds of the camper's strength. This car is the
  // one that gets washed; it still cannot drive a river crossing and come out
  // showroom clean, and a body with no value break at the sill floats.
  const grime = (x, y, z) => {
    const low = smoothstep(0.30, -0.30, y);
    const splash = 0.5 + 0.5 * Math.sin(z * 4.7 + x * 3.1) * Math.cos(z * 2.4 - y * 5.7);
    const arch = clamp01(1.15 - Math.min(
      Math.hypot(z - D.wheelZ, y - D.wheelY),
      Math.hypot(z + D.wheelZ, y - D.wheelY)) * 1.1);
    const k = clamp01(low * (0.26 + 0.34 * splash) + arch * 0.40);
    const d = 1 - k * 0.30;
    return [d * (1 - k * 0.06), d * (1 + k * 0.08), d * (1 + k * 0.26)];
  };

  // ── tub + greenhouse walls ───────────────────────────────────────────────
  P.add(extrudeAcross(tubShape(), D.halfWidth * 2 - 0.06, 0.035), 'paint', null, grime);

  for (const s of [-1, 1]) {
    const wall = extrudeAcross(houseShape(), WALL_T, 0.028);
    wall.translate(s * (D.halfWidth - 0.005 - WALL_T * 0.5), 0, 0);
    P.add(wall, 'paint', null, grime);

    // the white quarter, proud of the wall it covers
    const q = extrudeAcross(quarterShape(), 0.03, 0.012);
    q.translate(s * (D.halfWidth + 0.008), 0, 0);
    P.add(q, 'cream', null, [1, 1, 1]);
  }

  // rear wall of the greenhouse, with the back window cut out of it
  {
    const w = D.halfWidth * 2 - 0.02, y0 = D.waist - 0.06, y1 = D.roof;
    const outer = new THREE.Shape();
    outer.moveTo(-w / 2, y0); outer.lineTo(w / 2, y0);
    outer.lineTo(w / 2, y1 - 0.04); outer.lineTo(w / 2 - 0.05, y1);
    outer.lineTo(-w / 2 + 0.05, y1); outer.lineTo(-w / 2, y1 - 0.04);
    const hole = new THREE.Path();
    const hw = 0.76, hy0 = 0.68, hy1 = 1.08, r = 0.07;
    hole.moveTo(-hw + r, hy0); hole.lineTo(hw - r, hy0);
    hole.quadraticCurveTo(hw, hy0, hw, hy0 + r); hole.lineTo(hw, hy1 - r);
    hole.quadraticCurveTo(hw, hy1, hw - r, hy1); hole.lineTo(-hw + r, hy1);
    hole.quadraticCurveTo(-hw, hy1, -hw, hy1 - r); hole.lineTo(-hw, hy0 + r);
    hole.quadraticCurveTo(-hw, hy0, -hw + r, hy0);
    outer.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(outer, {
      depth: 0.09, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02,
      bevelSegments: 2, curveSegments: 4, steps: 1,
    });
    g.translate(0, 0, D.rear - 0.02);
    // The tailgate surround is inside the white quarter's wrap, so it is white.
    P.add(g, 'cream', null, [1, 1, 1]);
  }

  // ── interior ─────────────────────────────────────────────────────────────
  P.add(rbox(1.76, 0.90, 2.60, 0.05), 'interior', at(0, 0.76, -0.92));
  P.add(rbox(1.82, 0.03, 3.40, 0.01), 'interior', at(0, D.waist + 0.015, -0.66));
  for (const s of [-1, 1]) {                       // front buckets
    P.add(rbox(0.44, 0.28, 0.46, 0.06), 'interior', at(s * 0.42, 0.50, 0.30));
    P.add(rbox(0.44, 0.58, 0.12, 0.05), 'interior', at(s * 0.42, 0.80, 0.04, -0.13));
  }
  P.add(rbox(1.52, 0.26, 0.44, 0.06), 'interior', at(0, 0.50, -0.56));   // rear bench
  P.add(rbox(1.52, 0.56, 0.12, 0.05), 'interior', at(0, 0.80, -0.82, -0.10));
  P.add(rbox(1.68, 0.22, 0.30, 0.05), 'interior', at(0, 0.62, 0.78, 0.16));  // dash

  // wheel-well shells so you cannot see through the arches
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const wellR = D.archR - 0.05;
    const shellG = new THREE.CylinderGeometry(wellR, wellR, 0.42, 16, 1, true, 0, Math.PI);
    shellG.rotateZ(Math.PI / 2);
    shellG.rotateX(-Math.PI / 2);
    P.add(shellG, 'plastic', at(sx * (D.wheelX - 0.03), D.floor, sz * D.wheelZ), [0.9, 0.9, 0.95]);
    P.add(new THREE.CircleGeometry(wellR, 14), 'plastic',
      at(sx * (D.wheelX - 0.24), D.floor + 0.10, sz * D.wheelZ, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0),
      [0.9, 0.9, 0.95]);
  }

  // underbody + axles, same ladder frame as the camper rides on
  P.add(rbox(1.44, 0.10, 4.30, 0.03), 'trim', at(0, D.floor - 0.04, -0.02), [0.6, 0.6, 0.66]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.14, 0.16, 4.10, 0.03), 'trim', at(s * 0.44, D.floor - 0.14, 0), [0.5, 0.5, 0.56]);
  }
  for (const sz of [-1, 1]) {
    P.add(tube(0.055, 1.78, 8), 'trim', at(0, D.wheelY, sz * D.wheelZ, 0, 0, Math.PI / 2), [0.55, 0.55, 0.6]);
    P.add(new THREE.SphereGeometry(0.16, 12, 9), 'trim', at(0.16, D.wheelY, sz * D.wheelZ), [0.5, 0.5, 0.56]);
  }
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    P.add(rbox(0.09, 0.05, 1.00, 0.02), 'trim',
      at(sx * 0.62, D.wheelY + 0.10, sz * D.wheelZ), [0.45, 0.45, 0.5]);
  }

  // ── white hardtop ────────────────────────────────────────────────────────
  P.add(rbox(D.halfWidth * 2 + 0.04, 0.15, 3.22, 0.05, 2), 'cream', at(0, D.roof + 0.05, -0.68));
  // Panel seams. The reference roof is a bolt-off modular top and the seams are
  // the only thing that stops a white slab this large reading as a blank lid.
  for (const z of [0.44, -0.62]) {
    P.add(rbox(D.halfWidth * 2 + 0.05, 0.03, 0.03, 0.008), 'cream',
      at(0, D.roof + 0.126, z), [0.72, 0.72, 0.74]);
  }
  for (const s of [-1, 1]) {                       // rain gutters
    P.add(rbox(0.05, 0.05, 3.18, 0.018), 'cream', at(s * (D.halfWidth + 0.02), D.roof - 0.005, -0.68));
  }

  // ── wheel-arch flares ────────────────────────────────────────────────────
  const flare = (cz) => {
    const n = 14, R = D.archR + 0.05, H = 0.58;
    const pt = (k) => {
      const a = Math.PI - (k / n) * Math.PI;
      return [cz + R * Math.cos(a), D.floor + H * Math.pow(Math.sin(a), 0.62)];
    };
    for (let k = 0; k < n; k++) {
      const [z0, y0] = pt(k), [z1, y1] = pt(k + 1);
      const len = Math.hypot(z1 - z0, y1 - y0);
      const ang = Math.atan2(y1 - y0, z1 - z0);
      for (const sx of [-1, 1]) {
        P.add(rbox(0.19, 0.085, len + 0.03, 0.03, 1), 'plastic',
          at(sx * (D.halfWidth - 0.04), (y0 + y1) / 2, (z0 + z1) / 2, -ang, 0, 0), [1, 1, 1]);
      }
    }
  };
  flare(D.wheelZ);
  flare(-D.wheelZ);

  // ── doors ────────────────────────────────────────────────────────────────
  const doorSkin = (z0, z1) => {
    const w = 0.038, cz = (z0 + z1) / 2;
    for (const s of [-1, 1]) {
      P.add(rbox(w, 0.72, Math.abs(z1 - z0), 0.022, 2),
        'paint', at(s * (D.halfWidth - 0.045), 0.13, cz), grime);
    }
  };
  doorSkin(0.66, -0.14);
  doorSkin(-0.18, -1.08);

  // The heritage stripe: a white line along the top of the doors, running from
  // the front wing back into the white quarter so the two-tone joins up. At the
  // first width (26 × 45 mm, set flush with the wall) it was a hairline nobody
  // could see from the chase cam — on a flank this flat the stripe is one of
  // only two value breaks there are, so it is worth the extra centimetre.
  for (const s of [-1, 1]) {
    P.add(rbox(0.03, 0.075, 3.24, 0.012), 'cream',
      at(s * (D.halfWidth + 0.008), D.waist - 0.05, 0.55), [1, 1, 1]);
  }

  // handles + hinges, black rather than the camper's chrome
  for (const s of [-1, 1]) {
    for (const dz of [0.24, -0.72]) {
      P.add(rbox(0.045, 0.05, 0.19, 0.018), 'plastic', at(s * (D.halfWidth - 0.002), 0.32, dz), [1.1, 1.1, 1.15]);
    }
    for (const dz of [0.66, -0.20]) for (const dy of [0.40, -0.10]) {
      P.add(rbox(0.028, 0.05, 0.08, 0.012), 'plastic', at(s * (D.halfWidth - 0.012), dy, dz), [1, 1, 1]);
    }
  }

  // ── bonnet ───────────────────────────────────────────────────────────────
  P.add(rbox(1.80, 0.055, 1.26, 0.026, 2), 'paint', at(0, 0.532, 1.64, -0.004), grime);
  // Leading lip: the step where the bonnet meets the grille panel, which is the
  // shadow line that gives the flat top a front edge.
  P.add(rbox(1.82, 0.07, 0.07, 0.022), 'paint', at(0, 0.515, 2.28), grime);
  // Trail sights — the two black nubs on the wing crests you aim the corners of
  // the car with. Tiny, and the most recognisable thing on the bonnet.
  for (const s of [-1, 1]) {
    P.add(rbox(0.07, 0.06, 0.16, 0.022), 'plastic', at(s * 0.74, 0.575, 2.06), [1, 1, 1]);
  }
  P.add(rbox(0.66, 0.02, 0.13, 0.008), 'trim', at(0, 0.552, 1.14), [0.6, 0.6, 0.65]);  // cowl vent

  // ── the front: white panel, black grille, red marks ──────────────────────
  // `extrudeAcross` bevels the tub, so the painted front face actually stands
  // ~35 mm proud of D.front. The first pass built the white panel flush to
  // D.front and the body swallowed it whole: the grille ribs showed and the
  // panel they were supposed to sit in did not. Everything on the front face is
  // therefore measured from FZ, which already clears the bevel.
  const FZ = D.front + 0.045;
  // white panel, wing to wing — on the reference car the entire front face is
  // white and the blue starts at the bonnet shut line
  P.add(rbox(1.88, 0.42, 0.10, 0.028, 2), 'cream', at(0, 0.29, FZ - 0.03), [1, 1, 1]);

  // black grille recess between the headlights
  const GW = 1.12, GY = 0.29;
  P.add(rbox(GW, 0.36, 0.05, 0.014), 'plastic', at(0, GY, FZ + 0.012), [0.72, 0.72, 0.78]);
  // White ribs laid over it: two rows of slots above and below a middle band.
  // Drawing the ribs rather than the slots is the trick — geometry cannot be
  // subtracted here (CamperModel's wheel slots learned this the expensive way),
  // so the openings are the black backing showing through.
  for (const y of [GY + 0.175, GY + 0.088, GY - 0.088, GY - 0.175]) {
    P.add(rbox(GW + 0.02, 0.022, 0.055, 0.008), 'cream', at(0, y, FZ + 0.022), [1, 1, 1]);
  }
  for (let i = 0; i <= 7; i++) {
    const x = -GW / 2 + (i / 7) * GW;
    for (const y of [GY + 0.131, GY - 0.131]) {
      P.add(rbox(0.018, 0.09, 0.05, 0.006), 'cream', at(x, y, FZ + 0.020), [1, 1, 1]);
    }
  }

  // the marks. See BADGE_GLYPHS: four of them, and not one is a letter.
  {
    const GW_G = 0.062, GH_G = 0.078, STROKE = 0.015;
    for (let i = 0; i < BADGE_GLYPHS.length; i++) {
      const ox = (i - (BADGE_GLYPHS.length - 1) / 2) * 0.105;
      for (const [x0, y0, x1, y1] of BADGE_GLYPHS[i]) {
        const ax = (x0 - 0.5) * GW_G, ay = (y0 - 0.5) * GH_G;
        const bx = (x1 - 0.5) * GW_G, by = (y1 - 0.5) * GH_G;
        const len = Math.hypot(bx - ax, by - ay);
        const ang = Math.atan2(by - ay, bx - ax);
        P.add(rbox(len + STROKE, STROKE, 0.02, 0.005), 'badge',
          at(ox + (ax + bx) / 2, GY + (ay + by) / 2, FZ + 0.032, 0, 0, ang), [1, 1, 1]);
      }
    }
  }

  // round headlights, set into the outboard ends of the white panel
  for (const s of [-1, 1]) {
    P.add(new THREE.TorusGeometry(0.145, 0.022, 8, 22), 'chrome', at(s * 0.72, GY, FZ + 0.028));
    P.add(new THREE.CylinderGeometry(0.14, 0.15, 0.06, 20), 'trim',
      at(s * 0.72, GY, FZ + 0.005, Math.PI / 2), [0.5, 0.5, 0.56]);
    // Shallow dome, for the reason written over the camper's: a full hemisphere
    // catches the sky square-on and blows out to a white ball by mid-morning.
    P.add(new THREE.SphereGeometry(0.132, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'lensHead',
      at(s * 0.72, GY, FZ + 0.026, Math.PI / 2, 0, 0, 1, 0.40, 1));
    // amber corner marker, tucked against the wing
    P.add(rbox(0.075, 0.10, 0.05, 0.016), 'lensAmber', at(s * 0.90, GY + 0.02, FZ - 0.005));
  }

  // ── front bumper: black plastic, square recesses, fog lamps ──────────────
  P.add(rbox(1.98, 0.26, 0.30, 0.055, 2), 'plastic', at(0, -0.02, FZ - 0.10), [1, 1, 1]);
  // Shallow valance. The first one hung 140 mm below the bumper and, with the
  // tyres either side of it, the whole nose below the grille went to one black
  // skirt — the bumper stopped being a shape and became a hole.
  P.add(rbox(1.84, 0.09, 0.24, 0.035, 1), 'plastic', at(0, -0.175, FZ - 0.12), [0.86, 0.86, 0.9]);
  for (const s of [-1, 1]) {
    // the recess, then the lamp sitting inside it
    P.add(rbox(0.22, 0.15, 0.06, 0.02), 'trim', at(s * 0.70, -0.02, FZ + 0.035), [0.42, 0.42, 0.48]);
    P.add(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 14), 'lensHead',
      at(s * 0.70, -0.02, FZ + 0.058, Math.PI / 2), [0.85, 0.85, 0.88]);
  }
  // number plate on the bumper face
  P.add(rbox(0.44, 0.16, 0.02, 0.01), 'cream', at(0, 0.02, FZ + 0.058), [0.95, 0.95, 0.95]);

  // ── rear ─────────────────────────────────────────────────────────────────
  // tailgate skin
  P.add(rbox(1.76, 0.70, 0.05, 0.028, 2), 'paint', at(0, 0.12, D.rear - 0.015), grime);
  for (const s of [-1, 1]) {
    // vertical tail lamps, outboard and high — the rear signature
    P.add(rbox(0.14, 0.34, 0.05, 0.022), 'lensTail', at(s * 0.78, 0.30, D.rear - 0.035));
    P.add(rbox(0.13, 0.09, 0.04, 0.016), 'lensAmber', at(s * 0.78, 0.06, D.rear - 0.035));
  }
  // spare-wheel carrier: a black arm off the hinge side, and a hub to bolt to
  P.add(rbox(0.16, 0.62, 0.10, 0.03), 'plastic', at(0.62, 0.22, D.rear - 0.10), [1, 1, 1]);
  P.add(rbox(0.62, 0.16, 0.10, 0.03), 'plastic', at(0.34, 0.30, D.rear - 0.10), [1, 1, 1]);
  P.add(new THREE.CylinderGeometry(0.09, 0.09, 0.10, 14), 'steel',
    at(0.10, 0.30, D.rear - 0.14, Math.PI / 2), [0.8, 0.8, 0.85]);
  // rear bumper + step
  P.add(rbox(1.96, 0.25, 0.28, 0.055, 2), 'plastic', at(0, -0.02, D.rear + 0.04), [1, 1, 1]);
  P.add(rbox(0.52, 0.05, 0.20, 0.02), 'trim', at(0, 0.10, D.rear - 0.08), [0.55, 0.55, 0.6]);
  P.add(rbox(0.14, 0.10, 0.24, 0.02), 'steel', at(0, -0.14, D.rear - 0.16), [0.7, 0.7, 0.75]);
  P.add(new THREE.SphereGeometry(0.05, 10, 8), 'chrome', at(0, -0.05, D.rear - 0.26));
  // plate + lamp
  P.add(rbox(0.42, 0.15, 0.02, 0.01), 'cream', at(-0.42, -0.02, D.rear - 0.20), [0.95, 0.95, 0.95]);

  // ── side steps ───────────────────────────────────────────────────────────
  // Flat pressed boards, not the camper's tubular sliders: this car is not
  // pretending it has been down a rock garden.
  for (const s of [-1, 1]) {
    P.add(rbox(0.22, 0.06, 2.02, 0.022, 1), 'plastic',
      at(s * (D.halfWidth + 0.03), D.floor - 0.11, -0.05), [1, 1, 1]);
    for (const dz of [0.74, -0.05, -0.84]) {
      P.add(rbox(0.16, 0.10, 0.09, 0.02), 'plastic',
        at(s * (D.halfWidth - 0.06), D.floor - 0.06, dz), [0.85, 0.85, 0.9]);
    }
  }

  // ── mud flaps + exhaust ──────────────────────────────────────────────────
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const z = sz > 0 ? D.wheelZ - 0.74 : -(D.wheelZ + 0.74);
    P.add(rbox(0.30, 0.30, 0.02, 0.012), 'rubber',
      at(sx * (D.wheelX - 0.02), D.floor - 0.13, z, 0.14), [1, 1, 1]);
  }
  P.add(tube(0.045, 2.2, 8), 'trim', at(0.36, D.floor - 0.16, 0.20, Math.PI / 2), [0.65, 0.65, 0.7]);
  P.add(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 12), 'trim',
    at(0.36, D.floor - 0.16, -1.10, Math.PI / 2), [0.6, 0.6, 0.66]);
  P.add(new THREE.CylinderGeometry(0.062, 0.05, 0.16, 12), 'chrome',
    at(0.46, D.floor - 0.06, D.rear + 0.02, Math.PI / 2 - 0.30));

  // ── fuel filler ──────────────────────────────────────────────────────────
  P.add(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 14), 'plastic',
    at(-(D.halfWidth + 0.006), 0.20, -1.66, 0, 0, Math.PI / 2), [1, 1, 1]);

  // ── glass ────────────────────────────────────────────────────────────────
  const wallOuter = D.halfWidth - 0.005;
  const glassX = wallOuter - GLASS_INSET - GLASS_T * 0.5;
  const winMidY = (WIN_Y0 + WIN_Y1) / 2;
  for (const s of [-1, 1]) {
    for (const [z0, z1] of WINDOWS) {
      P.add(rbox(GLASS_T, (WIN_Y1 - WIN_Y0) + 0.06, Math.abs(z1 - z0) + 0.05, 0.008, 1), 'glass',
        at(s * glassX, winMidY, (z0 + z1) / 2));
    }
  }
  // Windscreen, raked to match the A-pillar exactly and sitting between them.
  const wsRake = Math.atan2(1.00 - 0.88, D.roof - (D.waist - 0.06));
  P.add(rbox(1.70, 0.72, GLASS_T, 0.01, 1), 'glass', at(0, 0.87, 0.905, -wsRake));
  // Rear window.
  P.add(rbox(1.54, 0.44, GLASS_T, 0.01, 1), 'glass', at(0, 0.88, D.rear + 0.025));

  // ── window surrounds, in black ───────────────────────────────────────────
  for (const s of [-1, 1]) {
    const x = s * (wallOuter + 0.008);
    for (const [z0, z1] of WINDOWS) {
      const w = Math.abs(z1 - z0), cz = (z0 + z1) / 2;
      for (const y of [WIN_Y0 - 0.015, WIN_Y1 + 0.015]) {
        P.add(rbox(0.024, 0.032, w + 0.056, 0.008), 'plastic', at(x, y, cz), [1, 1, 1]);
      }
      for (const e of [-1, 1]) {
        P.add(rbox(0.024, (WIN_Y1 - WIN_Y0) + 0.048, 0.032, 0.008), 'plastic',
          at(x, winMidY, cz + e * (w / 2 + 0.012)), [1, 1, 1]);
      }
    }
  }
  for (const e of [-1, 1]) {
    P.add(rbox(0.032, 0.44, 0.024, 0.008), 'plastic', at(e * 0.775, 0.88, D.rear - 0.03), [1, 1, 1]);
    P.add(rbox(1.58, 0.032, 0.024, 0.008), 'plastic', at(0, 0.88 + e * 0.225, D.rear - 0.03), [1, 1, 1]);
  }

  // windscreen frame + wipers
  P.add(rbox(1.84, 0.075, 0.07, 0.022), 'plastic', at(0, 0.505, 0.995, -wsRake), [1, 1, 1]);
  P.add(rbox(1.84, 0.08, 0.09, 0.022), 'plastic', at(0, 1.215, 0.862, -wsRake), [1, 1, 1]);
  for (const s of [-1, 1]) {
    P.add(rbox(0.02, 0.015, 0.54, 0.006), 'trim',
      at(s * 0.34, 0.555, 0.945, -wsRake, s * 0.35), [0.4, 0.4, 0.45]);
  }

  // ── wing mirrors: black, boxy, on the door ───────────────────────────────
  for (const s of [-1, 1]) {
    P.add(rbox(0.06, 0.09, 0.10, 0.02), 'plastic', at(s * (D.halfWidth + 0.03), 0.66, 0.80), [1, 1, 1]);
    P.add(rod(0.022, 0.22), 'plastic', at(s * (D.halfWidth + 0.13), 0.70, 0.78, 0, 0, s * 1.1), [1, 1, 1]);
    P.add(rbox(0.06, 0.20, 0.20, 0.03, 2), 'plastic', at(s * (D.halfWidth + 0.25), 0.72, 0.76, 0, 0.1 * s), [1, 1, 1]);
    P.add(new THREE.PlaneGeometry(0.17, 0.15), 'chrome',
      at(s * (D.halfWidth + 0.282), 0.72, 0.76, 0, s * (Math.PI / 2 + 0.1)), [0.42, 0.45, 0.50]);
  }

  P.flush(root, materials);

  // ── moving sub-parts (kept out of the merge) ─────────────────────────────
  // The spare lives on the tailgate, standing up: `buildWheel` puts the axle on
  // X, so a quarter turn about Y stands it on its edge facing aft.
  const spare = buildWheel(materials, { spare: true });
  spare.rotation.set(0, Math.PI / 2, 0);
  spare.position.set(0.10, 0.30, D.rear - 0.30);
  spare.traverse((o) => { o.castShadow = true; });
  root.add(spare);

  const antenna = new THREE.Group();
  {
    const a = new Parts();
    a.add(new THREE.CylinderGeometry(0.005, 0.011, 1.30, 6), 'trim', at(0, 0.65, 0), [0.5, 0.5, 0.55]);
    a.add(new THREE.SphereGeometry(0.015, 8, 6), 'trim', at(0, 1.30, 0), [0.5, 0.5, 0.55]);
    a.flush(antenna, materials, { receive: false });
  }
  // On the wing crest, where the reference car wears it, and canted back.
  antenna.position.set(D.halfWidth - 0.14, 0.55, 1.92);
  antenna.rotation.x = 0.06;
  root.add(antenna);

  const steeringWheel = new THREE.Group();
  {
    const s = new Parts();
    s.add(new THREE.TorusGeometry(0.17, 0.022, 8, 22), 'rubber', null, [1.1, 1.1, 1.1]);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      s.add(rbox(0.028, 0.16, 0.012, 0.006), 'trim',
        at(Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0, 0, 0, a - Math.PI / 2), [0.7, 0.7, 0.75]);
    }
    s.add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), 'trim', at(0, 0, 0, Math.PI / 2), [0.7, 0.7, 0.75]);
    s.flush(steeringWheel, materials, { receive: false });
  }
  steeringWheel.position.set(0.42, 0.66, 0.66);
  steeringWheel.rotation.x = -0.40;
  root.add(steeringWheel);

  // `rnd` is threaded through so a future variant (a different two-tone, a
  // roof-tray option) has a seed to work from without changing the signature.
  void rnd;

  return { root, antenna, steeringWheel, spare };
}

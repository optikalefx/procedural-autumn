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
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mulberry32, smoothstep, clamp01 } from '../core/MathUtils.js';

// ── dimensions (metres, local space: +X right, +Y up, +Z forward) ────────────
export const DIM = {
  halfWidth: 0.95,
  front: 2.34,
  rear: -2.32,
  floor: -0.30,       // rocker / sill line
  roof: 1.16,         // top of the steel shell (the cream cap sits above)
  waist: 0.48,        // bottom of the glass
  wheelZ: 1.525,      // ± wheelbase / 2
  wheelX: 0.93,
  wheelY: -0.42,      // hub height at rest
  wheelR: 0.44,
  archR: 0.63,
};

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ─────────────────────────────────────────────────────────────────────────────
//  Part accumulator: collects transformed geometry per material key and merges.
// ─────────────────────────────────────────────────────────────────────────────
class Parts {
  constructor() { this.bins = new Map(); }

  /**
   * @param geo    source geometry (consumed — do not reuse afterwards)
   * @param key    material key
   * @param m      THREE.Matrix4 placement (optional)
   * @param tint   [r,g,b] or fn(x,y,z)->[r,g,b] baked into the colour attribute
   */
  add(geo, key, m = null, tint = null) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (m) g.applyMatrix4(m);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    // Every bin shares an identical attribute set so mergeGeometries is happy.
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const p = g.attributes.position.array;
    if (typeof tint === 'function') {
      for (let i = 0; i < n; i++) {
        const c = tint(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
    } else {
      const c = tint || [1, 1, 1];
      for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  /** Merge each bin into one mesh and parent it. */
  flush(parent, materials, { cast = true, receive = true } = {}) {
    const made = [];
    for (const [key, list] of this.bins) {
      const mat = materials[key];
      if (!mat) { console.warn('[vehicle] no material', key); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn('[vehicle] merge failed', key); continue; }
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.name = 'camper_' + key;
      parent.add(mesh);
      made.push(mesh);
    }
    this.bins.clear();
    return made;
  }
}

// ── small geometry helpers ───────────────────────────────────────────────────
const M = () => new THREE.Matrix4();
const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  M().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );

const rbox = (w, h, d, r = 0.02, seg = 1) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, Math.min(h, d)) * 0.49));

const tube = (r, len, seg = 10) => {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  return g;
};

/** A capsule-ish tube with rounded caps — used for the bull bar and rack rails. */
const rod = (r, len, seg = 10) => new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 2, seg);

// ─────────────────────────────────────────────────────────────────────────────
//  Side profile.  Traversed clockwise starting at the rear sill.
// ─────────────────────────────────────────────────────────────────────────────
function archPoints(out, cz, R, yBase, H, n = 12) {
  for (let k = 0; k <= n; k++) {
    const a = Math.PI - (k / n) * Math.PI;
    // sin^0.62 flattens the crown, giving the squared-off arch of a utility 4x4
    out.push(new THREE.Vector2(cz + R * Math.cos(a), yBase + H * Math.pow(Math.sin(a), 0.62)));
  }
}

function bodyShape({ windows = true } = {}) {
  const D = DIM;
  const pts = [];
  const P = (z, y) => pts.push(new THREE.Vector2(z, y));

  P(D.rear + 0.06, D.floor + 0.02);
  P(D.rear + 0.16, D.floor);
  P(-2.14, D.floor);
  archPoints(pts, -D.wheelZ, D.archR, D.floor, 0.50);
  P(-0.88, D.floor);
  P(0.88, D.floor);
  archPoints(pts, D.wheelZ, D.archR, D.floor, 0.50);
  P(2.14, D.floor);
  P(2.24, D.floor + 0.01);
  P(D.front, -0.06);                 // front valance
  P(D.front, 0.26);
  P(2.28, 0.42);                     // bonnet leading edge
  P(2.22, 0.44);
  P(0.96, 0.46);                     // cowl
  P(0.80, 1.08);                     // windscreen rake
  P(0.76, D.roof);
  P(-2.20, D.roof);
  P(D.rear, D.roof - 0.16);          // rear roof radius
  P(D.rear, -0.04);

  const shape = new THREE.Shape(pts);

  if (windows) {
    // Three side lights: front door, rear door, quarter panel.
    shape.holes.push(roundRect(0.58, -0.26, 0.58, 1.04, 0.10));
    shape.holes.push(roundRect(-0.42, -1.26, 0.58, 1.04, 0.10));
    shape.holes.push(roundRect(-1.42, -2.04, 0.58, 1.04, 0.10));
  }
  return shape;
}

function roundRect(z0, z1, y0, y1, r) {
  const a = Math.min(z0, z1), b = Math.max(z0, z1);
  const p = new THREE.Path();
  p.moveTo(a + r, y0);
  p.lineTo(b - r, y0);
  p.quadraticCurveTo(b, y0, b, y0 + r);
  p.lineTo(b, y1 - r);
  p.quadraticCurveTo(b, y1, b - r, y1);
  p.lineTo(a + r, y1);
  p.quadraticCurveTo(a, y1, a, y1 - r);
  p.lineTo(a, y0 + r);
  p.quadraticCurveTo(a, y0, a + r, y0);
  return p;
}

/** Extrude a Z-Y profile across the X axis. */
function extrudeAcross(shape, width, bevel = 0.03) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 5,
    steps: 1,
  });
  // shape-x -> world z, extrusion -> world -x; recentre on the body axis
  g.rotateY(-Math.PI / 2);
  g.translate(width * 0.5, 0, 0);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Wheel
// ─────────────────────────────────────────────────────────────────────────────
export function buildWheel(materials, { spare = false } = {}) {
  const R = DIM.wheelR;
  const halfW = 0.185;
  const parts = new Parts();

  // ── tyre carcass: revolved cross-section, axle along X ────────────────────
  const prof = [
    [0.285, -halfW * 0.92], [0.315, -halfW], [0.352, -halfW * 1.03],
    [0.400, -halfW * 0.96], [0.428, -halfW * 0.80], [R, -halfW * 0.55],
    [R + 0.004, 0], [R, halfW * 0.55], [0.428, halfW * 0.80],
    [0.400, halfW * 0.96], [0.352, halfW * 1.03], [0.315, halfW],
    [0.285, halfW * 0.92],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const carcass = new THREE.LatheGeometry(prof, 30);
  carcass.rotateZ(Math.PI / 2);            // Y axis -> X axis
  parts.add(carcass, 'rubber', null, [1, 1, 1]);

  // ── tread: chunky alternating blocks, plus shoulder lugs that read from the
  //    side (which is the angle you actually see them from in a chase cam) ───
  const N = 20;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const odd = i & 1;
    const ca = Math.cos(a), sa = Math.sin(a);
    // centre block, canted slightly for a directional tread
    const cr = R - 0.005;
    parts.add(
      rbox(0.15, 0.030, 0.11, 0.012),
      'rubber',
      at(0, ca * cr, sa * cr, -a + Math.PI / 2, 0, odd ? 0.16 : -0.16),
      [0.94, 0.94, 0.96],
    );
    // shoulder lugs
    for (const s of [-1, 1]) {
      const sr = R - 0.02;
      parts.add(
        rbox(0.115, 0.036, 0.085, 0.014),
        'rubber',
        at(s * (halfW * 0.72), ca * sr, sa * sr, -a + Math.PI / 2, 0, 0),
        [0.9, 0.9, 0.93],
      );
      // sidewall knob — catches rim light, sells the off-road tyre in profile
      parts.add(
        rbox(0.035, 0.030, 0.055, 0.012),
        'rubber',
        at(s * (halfW * 1.02), ca * (R - 0.075), sa * (R - 0.075), -a + Math.PI / 2, 0, 0),
        [0.86, 0.86, 0.9],
      );
    }
  }
  // whitewall-ish raised lettering band (a thin ring, slightly lighter)
  const band = new THREE.TorusGeometry(0.365, 0.008, 5, 40);
  band.rotateY(Math.PI / 2);
  parts.add(band, 'rubber', at(-halfW * 0.99, 0, 0), [1.25, 1.25, 1.3]);

  // ── rim: white 5-slot steel wheel ─────────────────────────────────────────
  const barrel = new THREE.LatheGeometry([
    new THREE.Vector2(0.20, -0.16), new THREE.Vector2(0.288, -0.155),
    new THREE.Vector2(0.295, -0.10), new THREE.Vector2(0.278, 0.02),
    new THREE.Vector2(0.288, 0.10), new THREE.Vector2(0.295, 0.155),
    new THREE.Vector2(0.20, 0.16),
  ], 26);
  barrel.rotateZ(Math.PI / 2);
  parts.add(barrel, 'rim', null, [1, 1, 1]);

  const face = new THREE.CylinderGeometry(0.272, 0.272, 0.03, 26);
  face.rotateZ(Math.PI / 2);
  parts.add(face, 'rim', at(halfW * 0.62, 0, 0));

  // slots
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.31;
    parts.add(
      new THREE.CylinderGeometry(0.052, 0.052, 0.07, 12),
      'rimDark',
      at(halfW * 0.62, Math.cos(a) * 0.165, Math.sin(a) * 0.165, 0, 0, Math.PI / 2),
    );
  }
  // hub + lug nuts
  parts.add(new THREE.CylinderGeometry(0.085, 0.09, 0.05, 16), 'chrome',
    at(halfW * 0.72, 0, 0, 0, 0, Math.PI / 2));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.add(new THREE.CylinderGeometry(0.017, 0.017, 0.03, 6), 'chrome',
      at(halfW * 0.68, Math.cos(a) * 0.062, Math.sin(a) * 0.062, 0, 0, Math.PI / 2));
  }
  // brake disc peeking behind the rim
  if (!spare) {
    parts.add(new THREE.CylinderGeometry(0.21, 0.21, 0.022, 18), 'trim',
      at(-0.02, 0, 0, 0, 0, Math.PI / 2));
  }

  const g = new THREE.Group();
  parts.flush(g, materials);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
export function buildMaterials(env, bodyColor = 0xc4551f) {
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, envMap: env, ...o });

  const paint = new THREE.MeshPhysicalMaterial({
    color: C(bodyColor),
    roughness: 0.44, metalness: 0.16,
    clearcoat: 0.62, clearcoatRoughness: 0.30,
    envMap: env, envMapIntensity: 0.85,
    vertexColors: true,
  });
  const cream = new THREE.MeshPhysicalMaterial({
    color: C(0xe6ddc9), roughness: 0.5, metalness: 0.1,
    clearcoat: 0.5, clearcoatRoughness: 0.34,
    envMap: env, envMapIntensity: 0.8, vertexColors: true,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: C(0x14252c), roughness: 0.075, metalness: 0.0,
    transparent: true, opacity: 0.52,
    clearcoat: 1.0, clearcoatRoughness: 0.05,
    envMap: env, envMapIntensity: 1.5,
    side: THREE.DoubleSide, depthWrite: false, vertexColors: true,
  });

  return {
    paint, cream, glass,
    trim:    std({ color: C(0x2b2b30), roughness: 0.62, metalness: 0.14, envMapIntensity: 0.5 }),
    rubber:  std({ color: C(0x17171a), roughness: 0.90, metalness: 0.02, envMapIntensity: 0.25 }),
    steel:   std({ color: C(0x8d939c), roughness: 0.36, metalness: 0.88, envMapIntensity: 1.0 }),
    chrome:  std({ color: C(0xc9ccd2), roughness: 0.14, metalness: 1.0, envMapIntensity: 1.2 }),
    rim:     std({ color: C(0xdedac9), roughness: 0.40, metalness: 0.45, envMapIntensity: 0.8 }),
    rimDark: std({ color: C(0x1d1d20), roughness: 0.8, metalness: 0.1, envMapIntensity: 0.3 }),
    interior:std({ color: C(0x1c1a20), roughness: 0.92, metalness: 0.0, envMapIntensity: 0.15 }),
    canvas:  std({ color: C(0xcfc19c), roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 }),
    olive:   std({ color: C(0x53603a), roughness: 0.72, metalness: 0.15, envMapIntensity: 0.4 }),
    drum:    std({ color: C(0x3d7fae), roughness: 0.52, metalness: 0.05, envMapIntensity: 0.6 }),
    crimson: std({ color: C(0x8e2f28), roughness: 0.7, metalness: 0.05, envMapIntensity: 0.4 }),
    wood:    std({ color: C(0x8a6640), roughness: 0.85, metalness: 0.0, envMapIntensity: 0.3 }),
    lensHead: new THREE.MeshStandardMaterial({
      color: C(0xfff4dd), emissive: C(0xffe6b4), emissiveIntensity: 0.35,
      roughness: 0.12, metalness: 0.0, vertexColors: true, envMap: env, envMapIntensity: 1.2,
    }),
    lensTail: new THREE.MeshStandardMaterial({
      color: C(0x8e1512), emissive: C(0xff2a18), emissiveIntensity: 0.55,
      roughness: 0.2, metalness: 0.0, vertexColors: true, envMap: env,
    }),
    lensAmber: new THREE.MeshStandardMaterial({
      color: C(0xc06a10), emissive: C(0xff9d20), emissiveIntensity: 0.3,
      roughness: 0.24, metalness: 0.0, vertexColors: true, envMap: env,
    }),
  };
}

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
    const k = clamp01(low * (0.38 + 0.5 * splash) + arch * 0.30);
    const d = 1 - k * 0.30;
    return [d * (1 - k * 0.10), d * (1 + k * 0.13), d * (1 + k * 0.42)];
  };

  // ── shell ────────────────────────────────────────────────────────────────
  const shell = extrudeAcross(bodyShape({ windows: true }), D.halfWidth * 2 - 0.06, 0.035);
  shell.translate(-(D.halfWidth - 0.03), 0, 0);
  P.add(shell, 'paint', null, grime);

  // interior box seen through the glass
  P.add(rbox(1.72, 0.78, 2.72, 0.05), 'interior', at(0, 0.66, -0.66));
  // seats
  for (const s of [-1, 1]) {
    P.add(rbox(0.44, 0.30, 0.46, 0.06), 'interior', at(s * 0.42, 0.42, 0.28));
    P.add(rbox(0.44, 0.52, 0.12, 0.05), 'interior', at(s * 0.42, 0.66, 0.02, -0.12));
  }
  // dashboard + steering column shroud
  P.add(rbox(1.66, 0.22, 0.30, 0.05), 'interior', at(0, 0.50, 0.72, 0.18));

  // wheel-well shells so you cannot see through the arches
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const wellR = D.archR - 0.03;
    const shellG = new THREE.CylinderGeometry(wellR, wellR, 0.40, 16, 1, true, 0, Math.PI);
    shellG.rotateZ(Math.PI / 2);
    shellG.rotateX(-Math.PI / 2);
    P.add(shellG, 'trim', at(sx * (D.wheelX - 0.03), D.floor, sz * D.wheelZ), [0.7, 0.7, 0.75]);
    P.add(new THREE.CircleGeometry(wellR, 14, 0, Math.PI), 'trim',
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
  P.add(rbox(D.halfWidth * 2 + 0.02, 0.15, 3.06, 0.055, 2), 'cream', at(0, D.roof + 0.045, -0.79));
  // rain gutters
  for (const s of [-1, 1]) {
    P.add(rbox(0.05, 0.05, 3.02, 0.018), 'cream', at(s * (D.halfWidth + 0.005), D.roof - 0.005, -0.79));
  }
  // windscreen header cap
  P.add(rbox(D.halfWidth * 2 + 0.02, 0.12, 0.20, 0.045, 2), 'cream', at(0, D.roof + 0.03, 0.66));

  // ── doors: proud skins leave a real panel gap all round ──────────────────
  const doorSkin = (z0, z1, y0, y1) => {
    const w = 0.038, cz = (z0 + z1) / 2, cy = (y0 + y1) / 2;
    for (const s of [-1, 1]) {
      P.add(rbox(w, y1 - y0, Math.abs(z1 - z0), 0.022, 2),
        'paint', at(s * (D.halfWidth - 0.045), cy, cz), grime);
    }
  };
  doorSkin(0.60, -0.32, -0.24, 0.40);
  doorSkin(-0.44, -1.34, -0.24, 0.40);

  // door handles + hinges
  for (const s of [-1, 1]) {
    for (const dz of [0.14, -0.90]) {
      P.add(rbox(0.045, 0.045, 0.20, 0.018), 'chrome', at(s * (D.halfWidth - 0.005), 0.28, dz));
      P.add(rbox(0.03, 0.05, 0.055, 0.012), 'chrome', at(s * (D.halfWidth - 0.01), 0.28, dz + 0.13));
    }
    for (const dz of [0.56, -0.40]) for (const dy of [0.34, -0.16]) {
      P.add(rbox(0.028, 0.05, 0.09, 0.012), 'trim', at(s * (D.halfWidth - 0.012), dy, dz), [0.6, 0.6, 0.65]);
    }
  }

  // ── bonnet: separate panel with a shut line, plus latches and a vent ──────
  P.add(rbox(1.78, 0.055, 1.30, 0.026, 2), 'paint', at(0, 0.412, 1.66, -0.012), grime);
  for (const s of [-1, 1]) {
    P.add(rbox(0.06, 0.03, 0.09, 0.012), 'chrome', at(s * 0.74, 0.44, 2.28));   // latches
  }
  P.add(rbox(0.62, 0.02, 0.14, 0.008), 'trim', at(0, 0.442, 1.20), [0.6, 0.6, 0.65]);  // cowl vent

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
    P.add(new THREE.SphereGeometry(0.118, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 'lensHead',
      at(s * 0.60, 0.205, D.front + 0.028, Math.PI / 2));
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
  const snX = D.halfWidth - 0.02;
  P.add(tube(0.055, 0.44, 10), 'trim', at(snX, 0.28, 1.42, 0, 0, 0), [0.75, 0.75, 0.8]);
  P.add(new THREE.TorusGeometry(0.10, 0.055, 8, 12, Math.PI / 2), 'trim',
    at(snX, 0.50, 1.32, Math.PI / 2, 0, 0), [0.75, 0.75, 0.8]);
  P.add(tube(0.055, 0.86, 10), 'trim', at(snX, 0.86, 1.22, -0.10), [0.75, 0.75, 0.8]);
  P.add(rbox(0.13, 0.24, 0.16, 0.03, 2), 'trim', at(snX, 1.34, 1.16, -0.10), [0.8, 0.8, 0.85]);
  P.add(rbox(0.135, 0.10, 0.03, 0.012), 'trim', at(snX, 1.34, 1.245, -0.10), [0.45, 0.45, 0.5]);
  for (const y of [0.62, 1.00]) {
    P.add(new THREE.TorusGeometry(0.062, 0.012, 6, 12), 'chrome', at(snX, y, 1.26 - (y - 0.62) * 0.10, 1.47));
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
    P.add(rbox(0.30, 0.30, 0.02, 0.012), 'rubber',
      at(sx * (D.wheelX - 0.02), D.floor - 0.10, sz * (D.wheelZ + 0.66) * 1.0, sz > 0 ? -0.16 : 0.16),
      [1, 1, 1]);
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
  const glassPane = (z0, z1, y0, y1, x) => {
    const g = new THREE.PlaneGeometry(Math.abs(z1 - z0), y1 - y0);
    g.rotateY(Math.PI / 2);
    P.add(g, 'glass', at(x, (y0 + y1) / 2, (z0 + z1) / 2));
  };
  for (const s of [-1, 1]) {
    const x = s * (D.halfWidth - 0.055);
    glassPane(0.62, -0.30, 0.52, 0.90, x);
    glassPane(-0.42, -1.32, 0.52, 0.90, x);
    glassPane(-1.44, -2.12, 0.52, 0.90, x);
  }
  // windscreen (raked) and rear window
  const ws = new THREE.PlaneGeometry(1.68, 0.60);
  P.add(ws, 'glass', at(0, 0.70, 0.885, -0.28));
  const rw = new THREE.PlaneGeometry(1.44, 0.46);
  P.add(rw, 'glass', at(0, 0.62, D.rear + 0.03));

  // window rubbers / frames around the side lights
  for (const s of [-1, 1]) {
    const x = s * (D.halfWidth - 0.035);
    for (const [z0, z1] of [[0.62, -0.30], [-0.42, -1.32], [-1.44, -2.12]]) {
      const w = Math.abs(z1 - z0), cz = (z0 + z1) / 2;
      P.add(rbox(0.02, 0.025, w, 0.008), 'trim', at(x, 0.52, cz), [0.5, 0.5, 0.55]);
      P.add(rbox(0.02, 0.025, w, 0.008), 'trim', at(x, 0.90, cz), [0.5, 0.5, 0.55]);
    }
  }
  // windscreen frame + wipers
  P.add(rbox(1.74, 0.06, 0.05, 0.02), 'paint', at(0, 0.415, 0.96, -0.28), grime);
  for (const s of [-1, 1]) {
    P.add(rbox(0.02, 0.015, 0.52, 0.006), 'trim', at(s * 0.34, 0.46, 0.86, -0.28, s * 0.35), [0.4, 0.4, 0.45]);
  }

  // ── wing mirrors ─────────────────────────────────────────────────────────
  for (const s of [-1, 1]) {
    P.add(rod(0.02, 0.30), 'steel', at(s * (D.halfWidth + 0.11), 0.60, 0.70, 0, 0, s * 1.05), [0.7, 0.7, 0.75]);
    P.add(rbox(0.055, 0.20, 0.16, 0.03, 2), 'trim', at(s * (D.halfWidth + 0.24), 0.62, 0.68, 0, 0.1 * s));
    P.add(new THREE.PlaneGeometry(0.15, 0.13), 'chrome',
      at(s * (D.halfWidth + 0.268), 0.62, 0.68, 0, s * (Math.PI / 2 + 0.1)));
  }

  // ── roof rack + load ─────────────────────────────────────────────────────
  const rackY = D.roof + 0.14;
  const rackZ0 = 0.60, rackZ1 = -2.32, rackLen = rackZ0 - rackZ1;
  const rackHalf = D.halfWidth - 0.02;
  // perimeter rails
  for (const s of [-1, 1]) {
    P.add(rod(0.028, rackLen), 'steel',
      at(s * rackHalf, rackY + 0.16, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.9, 0.9, 0.95]);
    P.add(rod(0.026, rackLen), 'steel',
      at(s * rackHalf, rackY, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.9, 0.9, 0.95]);
  }
  for (const z of [rackZ0, rackZ1]) {
    P.add(rod(0.028, rackHalf * 2), 'steel', at(0, rackY + 0.16, z, 0, 0, Math.PI / 2), [0.9, 0.9, 0.95]);
    P.add(rod(0.026, rackHalf * 2), 'steel', at(0, rackY, z, 0, 0, Math.PI / 2), [0.9, 0.9, 0.95]);
  }
  // uprights + floor slats
  for (let i = 0; i <= 6; i++) {
    const z = rackZ0 - (i / 6) * rackLen;
    for (const s of [-1, 1]) P.add(rod(0.02, 0.18), 'steel', at(s * rackHalf, rackY + 0.08, z), [0.9, 0.9, 0.95]);
    P.add(rod(0.017, rackHalf * 2), 'steel', at(0, rackY - 0.01, z, 0, 0, Math.PI / 2), [0.85, 0.85, 0.9]);
  }
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * (rackHalf * 0.62);
    P.add(rod(0.016, rackLen), 'steel', at(x, rackY - 0.02, (rackZ0 + rackZ1) / 2, Math.PI / 2), [0.85, 0.85, 0.9]);
  }
  // rack feet
  for (const z of [0.44, -0.70, -2.14]) for (const s of [-1, 1]) {
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
  P.add(rbox(0.80, 0.30, 0.62, 0.055, 2), 'trim', at(-0.02, load + 0.17, -1.16), [0.8, 0.8, 0.88]);
  P.add(rbox(0.82, 0.04, 0.64, 0.02), 'cream', at(-0.02, load + 0.33, -1.16), [0.9, 0.9, 0.9]);
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
    P.add(rbox(0.035, 0.28, 1.10, 0.02), 'lensAmber',
      at(-(rackHalf + 0.05) - i * 0.045, rackY + 0.10, -0.90, 0, 0, 0.03));
  }

  // ── awning roll along the left roof edge ─────────────────────────────────
  P.add(new THREE.CylinderGeometry(0.105, 0.105, 2.30, 14), 'canvas',
    at(-(D.halfWidth + 0.14), D.roof + 0.20, -0.70, Math.PI / 2), [0.95, 0.92, 0.85]);
  for (const e of [-1, 1]) {
    P.add(new THREE.CylinderGeometry(0.115, 0.115, 0.07, 12), 'trim',
      at(-(D.halfWidth + 0.14), D.roof + 0.20, -0.70 + e * 1.16, Math.PI / 2), [0.6, 0.6, 0.66]);
  }
  for (const dz of [0.28, -1.66]) {
    P.add(rbox(0.16, 0.05, 0.05, 0.015), 'steel',
      at(-(D.halfWidth + 0.07), D.roof + 0.20, dz), [0.8, 0.8, 0.85]);
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

/** A tiny gradient environment so chrome and glass have something to reflect. */
export function buildEnvMap(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      varying vec3 vP;
      void main(){
        float h = normalize(vP).y;
        // cream horizon -> blue zenith above, warm gold bounce below
        vec3 sky = mix(vec3(1.00,0.90,0.78), vec3(0.36,0.55,0.85), smoothstep(0.0,0.85,h));
        vec3 gnd = mix(vec3(0.95,0.70,0.34), vec3(0.42,0.30,0.20), smoothstep(0.0,-0.7,h));
        vec3 c = h > 0.0 ? sky : gnd;
        // a soft sun blob so highlights have a shape to catch
        float s = smoothstep(0.86, 1.0, dot(normalize(vP), normalize(vec3(0.55,0.42,-0.72))));
        c += s * vec3(2.4,2.0,1.5);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const rt = pmrem.fromScene(scene, 0.02);
  geo.dispose(); mat.dispose(); pmrem.dispose();
  return rt.texture;
}

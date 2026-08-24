// ─────────────────────────────────────────────────────────────────────────────
//  model_kit — the parts bin every vehicle in the game is built out of.
//
//  This file was the top third of CamperModel.js.  It moved when the second
//  car arrived, because all of it was general: the merge accumulator, the
//  geometry sugar, the wheel, the material palette and the reflection probe are
//  the *house style* for a vehicle here, not facts about the camper.  A new car
//  is therefore one file that imports this and authors a silhouette — see
//  RoamerModel.js for the shape of that, and vehicle_models.js for the table
//  that puts it on the road.
//
//  What a car file owns:  its DIM (body extents), its side profile, its paint,
//  and `build<Name>(materials, seed) -> { root, antenna, steeringWheel }`.
//  What it must NOT own:  the wheel positions.  CHASSIS below is the contract
//  with VehiclePhysics — every car rolls on the same wheelbase and track,
//  because the suspension, the camera boom and the contact shadow are all
//  tuned against those numbers.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ── the chassis every car shares ─────────────────────────────────────────────
// These mirror VEHICLE.wheelBase / trackWidth / wheelRadius in WorldConfig.js.
// A car that wants a different wheelbase is a physics change, not a model
// change, so it does not get to make one here.
export const CHASSIS = {
  wheelZ: 1.525,      // ± wheelBase / 2
  wheelX: 0.93,       // ± trackWidth / 2
  wheelY: -0.42,      // hub height at rest
  wheelR: 0.44,
};

export const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Give every vertex a normal a shader can normalize().
 *
 * THIS IS THE BLACK-SQUARE FIX. The camper is built by merging a few hundred
 * primitives, and some of them meet at an edge or a corner that collapses —
 * RoundedBoxGeometry with a radius clamped against a thin dimension is the main
 * producer. Those triangles have zero area, so their cross product is zero, and
 * computeVertexNormals() leaves the result as a *zero-length* normal rather than
 * failing: three's normalizeNormals() divides by `length() || 1`, which quietly
 * turns 0/0 into (0,0,0) on the CPU instead of NaN. Nothing complains.
 *
 * The GPU is not so forgiving. three's fragment prelude does
 * `normalize( vNormal )`, and normalize(vec3(0.0)) is 0.0/0.0 — NaN. Every
 * lighting term for that fragment is then NaN, it lands in the HDR buffer, and
 * the bloom mip chain averages it outward into the ~800 px black square the
 * player has been seeing (see PostFX MIN_BLOOM_MIP for the amplification).
 *
 * Zero-area triangles cannot cover a sample point in exact arithmetic, which is
 * why this is intermittent rather than constant: the vertices are degenerate in
 * the float64 the CPU computed them in, but the GPU re-derives clip-space
 * positions in float32 through a model matrix that changes every frame while
 * driving, and the rounding occasionally gives the triangle a sliver of area.
 * Measured on a 150 s drive: 36 frames carried a non-finite HDR pixel, all of
 * them from the camper, and repairing these normals in the same frame took it
 * to zero every time (tools/_scratch/normpair.mjs).
 *
 * The replacement direction is arbitrary on purpose. These triangles are
 * invisible; the only thing that matters is that the value is finite, so this
 * cannot change how any pixel that was already correct is shaded.
 */
function sanitizeNormals(g) {
  const n = g.getAttribute('normal');
  if (!n) return 0;
  const a = n.array;
  let fixed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
        x * x + y * y + z * z > 0) continue;
    a[i] = 0; a[i + 1] = 1; a[i + 2] = 0;
    fixed++;
  }
  if (fixed) n.needsUpdate = true;
  return fixed;
}
// ─────────────────────────────────────────────────────────────────────────────
//  Part accumulator: collects transformed geometry per material key and merges.
// ─────────────────────────────────────────────────────────────────────────────
export class Parts {
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
    sanitizeNormals(g);
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
export const M = () => new THREE.Matrix4();
export const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  M().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );

export const rbox = (w, h, d, r = 0.02, seg = 1) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, Math.min(h, d)) * 0.49));

export const tube = (r, len, seg = 10) => {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  return g;
};

/** A capsule-ish tube with rounded caps — used for the bull bar and rack rails. */
export const rod = (r, len, seg = 10) => new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 2, seg);
// ── profile helpers ──────────────────────────────────────────────────────────
export function archPoints(out, cz, R, yBase, H, n = 12) {
  for (let k = 0; k <= n; k++) {
    const a = Math.PI - (k / n) * Math.PI;
    // sin^0.62 flattens the crown, giving the squared-off arch of a utility 4x4
    out.push(new THREE.Vector2(cz + R * Math.cos(a), yBase + H * Math.pow(Math.sin(a), 0.62)));
  }
}
export function roundRect(z0, z1, y0, y1, r) {
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
export function extrudeAcross(shape, width, bevel = 0.03) {
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
/**
 * One wheel, axle along X.
 *
 * `radius` IS A VISUAL RADIUS AND IT COSTS SOMETHING. VehiclePhysics raycasts
 * the suspension and puts the hub exactly CHASSIS.wheelR above the contact
 * point, so a tyre drawn larger than that would drive with its lugs buried.
 * A car on bigger rubber therefore also declares `DIM.wheelR`, and Vehicle
 * lifts the whole rig by the difference — body and hubs together — which puts
 * the bottom of the bigger tyre back on the contact patch and raises the body
 * over it by exactly the amount a real lift would. See `_syncTransform`.
 *
 * The consequence to know about: the visual body then sits that much above the
 * physics chassis. Nothing simulates against the model, so the only thing this
 * can do is let the body clear a rock its collider would have clipped, at the
 * scale of the lift. `_groundSettle`'s clearance maths is unaffected — it
 * measures `w.pos.y - VEHICLE.wheelRadius`, and lift cancels out of that.
 *
 *   `width`      half-width. A fatter carcass reads as a bigger tyre from every
 *                angle the chase cam actually uses.
 *   `deepTread`  metres the *carcass* is pulled in under the tread blocks. The
 *                blocks still stand out to the crown, so this is depth of tread
 *                rather than size of tyre — exactly what separates a mud
 *                terrain from an all terrain of the same diameter.
 *
 * All of them default to the numbers the camper and the Roamer were authored
 * against, and the profile below reproduces their original literals exactly at
 * those defaults (0.400 = CR - 0.040, 0.428 = CR - 0.012).
 */
export function buildWheel(materials, {
  spare = false, width = 0.185, deepTread = 0, band = true,
  radius = CHASSIS.wheelR, rimKey = 'rim', spokeKey = 'trim', accentKey = null,
} = {}) {
  const R = radius;
  const halfW = width;
  // Two scale factors, and every literal below is written against them, so a
  // bigger tyre is a bigger *wheel* rather than the same hubcap adrift in more
  // rubber — which is exactly what the first fat-tyre pass looked like.
  const rs = R / 0.44;                    // radial scale
  const ws = halfW / 0.185;               // axial scale
  const CR = R - deepTread;               // carcass crown, under the tread
  const parts = new Parts();

  // ── tyre carcass: revolved cross-section, axle along X ────────────────────
  const prof = [
    [0.285 * rs, -halfW * 0.92], [0.315 * rs, -halfW], [0.352 * rs, -halfW * 1.03],
    [CR - 0.040 * rs, -halfW * 0.96], [CR - 0.012 * rs, -halfW * 0.80], [CR, -halfW * 0.55],
    [CR + 0.004 * rs, 0], [CR, halfW * 0.55], [CR - 0.012 * rs, halfW * 0.80],
    [CR - 0.040 * rs, halfW * 0.96], [0.352 * rs, halfW * 1.03], [0.315 * rs, halfW],
    [0.285 * rs, halfW * 0.92],
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
    // Centre block, canted slightly for a directional tread. It grows *inward*
    // as the tread deepens so its outer face stays put at the rolling radius.
    const cr = R - 0.005 * rs - deepTread * 0.5;
    parts.add(
      rbox(0.15 * ws, 0.030 * rs + deepTread, 0.11 * rs, 0.012),
      'rubber',
      at(0, ca * cr, sa * cr, -a + Math.PI / 2, 0, odd ? 0.16 : -0.16),
      [0.94, 0.94, 0.96],
    );
    // shoulder lugs
    for (const s of [-1, 1]) {
      const sr = R - 0.02 * rs - deepTread * 0.5;
      parts.add(
        rbox(0.115 * ws, 0.036 * rs + deepTread, 0.085 * rs, 0.014),
        'rubber',
        at(s * (halfW * 0.72), ca * sr, sa * sr, -a + Math.PI / 2, 0, 0),
        [0.9, 0.9, 0.93],
      );
      // sidewall knob — catches rim light, sells the off-road tyre in profile
      const kr = CR - 0.035 * rs;
      parts.add(
        rbox(0.035 * ws, 0.030 * rs + deepTread * 0.5, 0.055 * rs, 0.012),
        'rubber',
        at(s * (halfW * 1.02), ca * kr, sa * kr, -a + Math.PI / 2, 0, 0),
        [0.86, 0.86, 0.9],
      );
    }
  }
  // raised sidewall band (a thin ring, slightly lighter)
  if (band) {
    const ring = new THREE.TorusGeometry(0.365 * rs, 0.008 * rs, 5, 40);
    ring.rotateY(Math.PI / 2);
    parts.add(ring, 'rubber', at(-halfW * 0.99, 0, 0), [1.25, 1.25, 1.3]);
  }

  // ── rim: 5-slot steel wheel ───────────────────────────────────────────────
  const barrel = new THREE.LatheGeometry([
    new THREE.Vector2(0.20 * rs, -0.16 * ws), new THREE.Vector2(0.288 * rs, -0.155 * ws),
    new THREE.Vector2(0.295 * rs, -0.10 * ws), new THREE.Vector2(0.278 * rs, 0.02 * ws),
    new THREE.Vector2(0.288 * rs, 0.10 * ws), new THREE.Vector2(0.295 * rs, 0.155 * ws),
    new THREE.Vector2(0.20 * rs, 0.16 * ws),
  ], 26);
  barrel.rotateZ(Math.PI / 2);
  parts.add(barrel, rimKey, null, [1, 1, 1]);

  // Dished face: a solid outer lip, five deep windows, a raised centre. The
  // first version used tiny holes and read as a plain white disc at any range.
  // Dish depth is held CONSTANT rather than proportional. A half-width
  // fraction meant that widening the tyre also pushed the face deeper into it,
  // and at the Adventurer's 0.5 m section the whole wheel disappeared down a
  // hole with only the hub showing.
  const dish = Math.min(0.089, halfW * 0.52);
  const faceX = halfW - dish;
  const face = new THREE.CylinderGeometry(0.278 * rs, 0.278 * rs, 0.028 * ws, 26);
  face.rotateZ(Math.PI / 2);
  parts.add(face, rimKey, at(faceX, 0, 0));
  const lip = new THREE.TorusGeometry(0.272 * rs, 0.026 * rs, 8, 26);
  lip.rotateY(Math.PI / 2);
  parts.add(lip, rimKey, at(faceX + 0.015 * ws, 0, 0), [1.1, 1.1, 1.1]);

  // Optional beadlock ring: the outer band in a second colour, with its bolts.
  // Two-tone wheels are half of what makes a lifted truck look built, and the
  // ring is the cheapest possible way to say it.
  //
  // ITS RADIUS IS NOT COSMETIC. Everything you can see of a wheel is seen down
  // the hole in the tyre bead, whose radius is the carcass profile's smallest,
  // 0.285 * rs. The first ring sat at 0.288 * rs — four millimetres outside
  // that — and was completely hidden behind the sidewall on a car whose whole
  // wheel design was supposed to be the yellow ring.
  if (accentKey) {
    const ring = new THREE.TorusGeometry(0.258 * rs, 0.022 * rs, 8, 30);
    ring.rotateY(Math.PI / 2);
    parts.add(ring, accentKey, at(halfW * 0.60, 0, 0), [1, 1, 1]);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.13;
      parts.add(new THREE.CylinderGeometry(0.012 * rs, 0.012 * rs, 0.024 * ws, 6), 'trim',
        at(halfW * 0.66, Math.cos(a) * 0.258 * rs, Math.sin(a) * 0.258 * rs, 0, 0, Math.PI / 2),
        [0.5, 0.5, 0.55]);
    }
  }

  // Ventilation slots, not round holes. Five dark circles ringing a pale hub
  // read as a face at any distance — the wheels looked like skulls in profile.
  // Radial slots read as a pressed steel wheel and stay quiet.
  // The face is a solid disc and geometry cannot be subtracted, so a slot sunk
  // behind it is simply invisible — that attempt left a blank cream dinner
  // plate. These sit a few millimetres *proud* instead and read as slots
  // because of their shape and value, not their depth.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.31;
    // Long axis along Y, rotated about the axle (X) to point radially outward.
    parts.add(rbox(0.02 * ws, 0.150 * rs, 0.058 * rs, 0.026, 1), spokeKey,
      at(faceX + 0.008 * ws, Math.cos(a) * 0.168 * rs, Math.sin(a) * 0.168 * rs, a, 0, 0),
      [1.3, 1.3, 1.36]);
  }
  // hub + lug nuts
  parts.add(new THREE.CylinderGeometry(0.085 * rs, 0.09 * rs, 0.05 * ws, 16), 'chrome',
    at(faceX + 0.037 * ws, 0, 0, 0, 0, Math.PI / 2));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.add(new THREE.CylinderGeometry(0.017 * rs, 0.017 * rs, 0.03 * ws, 6), 'chrome',
      at(faceX + 0.030 * ws, Math.cos(a) * 0.062 * rs, Math.sin(a) * 0.062 * rs, 0, 0, Math.PI / 2));
  }
  // brake disc peeking behind the rim
  if (!spare) {
    parts.add(new THREE.CylinderGeometry(0.21 * rs, 0.21 * rs, 0.022 * ws, 18), 'trim',
      at(-0.02, 0, 0, 0, 0, Math.PI / 2), [0.55, 0.55, 0.6]);
  }

  const g = new THREE.Group();
  parts.flush(g, materials);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
//
// One palette for every car. A model may add its own keys on top of what comes
// back — the Roamer's near-black plastic and its badge red are its own — but
// the shared ones stay shared, because two cars in the same valley disagreeing
// about what glass or chrome looks like is a continuity error, not variety.
//
// `body` and `cream` are the two-tone: the paint that carries the silhouette
// and the contrasting cap. Everything else is fixed.
export function buildMaterials(env, opts = {}) {
  // Back-compat: the camper called this as buildMaterials(env, 0xc4551f).
  const o = typeof opts === 'number' ? { body: opts } : opts;
  const bodyColor = o.body ?? 0xc4551f;
  const creamColor = o.cream ?? 0xe6ddc9;
  const std = (x) => new THREE.MeshStandardMaterial({ vertexColors: true, envMap: env, ...x });

  // Stylize.js flattens *direct* specular but leaves image-based lighting
  // alone, so a hot env probe is now the loudest thing on a horizontal panel:
  // at 0.85 the bonnet reflected so much sky it went pale pink and lost the
  // body colour entirely. Keep a sheen, lose the wash — the brief wants broad
  // flat masses of saturated colour, and paint is the biggest mass we own.
  const paint = new THREE.MeshPhysicalMaterial({
    color: C(bodyColor),
    roughness: 0.52, metalness: 0.06,
    clearcoat: 0.34, clearcoatRoughness: 0.34,
    envMap: env, envMapIntensity: 0.32,
    vertexColors: true,
  });
  const cream = new THREE.MeshPhysicalMaterial({
    color: C(creamColor), roughness: 0.55, metalness: 0.06,
    clearcoat: 0.28, clearcoatRoughness: 0.36,
    envMap: env, envMapIntensity: 0.28, vertexColors: true,
  });
  // Glass has to carry a *reflection*, not just a tint: unlit dark glass reads
  // as a hole cut in the silhouette. But the first pass over-corrected — high
  // metalness plus a hot env probe made every pane a pale blue-grey slab
  // *lighter* than the paint, which is the single loudest tell of a fake
  // window. Glass is now clearly darker than the body, with the reflection as
  // a sheen on top rather than the whole of it. Front-facing only: these are
  // solid slabs now, so the back faces would just double the tint.
  const glass = new THREE.MeshPhysicalMaterial({
    color: C(0x33454a), roughness: 0.07, metalness: 0.12,
    transparent: true, opacity: 0.74,
    clearcoat: 1.0, clearcoatRoughness: 0.04,
    envMap: env, envMapIntensity: 1.0,
    side: THREE.FrontSide, depthWrite: false, vertexColors: true,
  });

  return {
    paint, cream, glass,
    trim:    std({ color: C(0x3c3c44), roughness: 0.62, metalness: 0.14, envMapIntensity: 0.6 }),
    rubber:  std({ color: C(0x33333a), roughness: 0.86, metalness: 0.04, envMapIntensity: 0.55 }),
    flare:   std({ color: C(0x4a4a53), roughness: 0.74, metalness: 0.06, envMapIntensity: 0.5 }),
    orange:  std({ color: C(0xd2731c), roughness: 0.62, metalness: 0.05, envMapIntensity: 0.5 }),
    steel:   std({ color: C(0x8a8a86), roughness: 0.48, metalness: 0.50, envMapIntensity: 0.6 }),
    rack:    std({ color: C(0x33363c), roughness: 0.48, metalness: 0.55, envMapIntensity: 0.55 }),
    chrome:  std({ color: C(0xc9ccd2), roughness: 0.14, metalness: 1.0, envMapIntensity: 1.2 }),
    rim:     std({ color: C(0xdedac9), roughness: 0.40, metalness: 0.45, envMapIntensity: 0.8 }),
    rimDark: std({ color: C(0x1d1d20), roughness: 0.8, metalness: 0.1, envMapIntensity: 0.3 }),
    interior:std({ color: C(0x1c1a20), roughness: 0.92, metalness: 0.0, envMapIntensity: 0.15 }),
    canvas:  std({ color: C(0xbfa87e), roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 }),
    olive:   std({ color: C(0x53603a), roughness: 0.72, metalness: 0.15, envMapIntensity: 0.4 }),
    drum:    std({ color: C(0x3d7fae), roughness: 0.52, metalness: 0.05, envMapIntensity: 0.6 }),
    crimson: std({ color: C(0x8e2f28), roughness: 0.7, metalness: 0.05, envMapIntensity: 0.4 }),
    wood:    std({ color: C(0x8a6640), roughness: 0.85, metalness: 0.0, envMapIntensity: 0.3 }),
    lensHead: new THREE.MeshStandardMaterial({
      color: C(0xfff4dd), emissive: C(0xffe6b4), emissiveIntensity: 0.35,
      roughness: 0.26, metalness: 0.0, vertexColors: true, envMap: env, envMapIntensity: 0.45,
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

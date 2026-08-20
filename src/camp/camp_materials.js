// ─────────────────────────────────────────────────────────────────────────────
//  camp_materials — the shared kit every camp prop is built out of.
//
//  Four props are being authored in parallel by four people. If each of them
//  invents its own black tube material, the camp ends up with four subtly
//  different blacks under the same sun and the set reads as a bag of assets
//  rather than as somebody's gear. So: one palette, one set of materials, one
//  set of geometry helpers, and per-prop colour comes in through the vertex
//  colour attribute rather than through a new material.
//
//  The `Parts` bin here is the camper's, lifted almost unchanged — it is the
//  pattern that keeps a few-hundred-primitive prop down to a handful of draw
//  calls, and it is also where `sanitizeNormals` gets applied to everything,
//  which is not optional (see below).
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp01, smoothstep } from '../core/MathUtils.js';

export const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Repair zero-length and non-finite normals.
 *
 * THIS IS THE BLACK-SQUARE FIX, and the camp props are built exactly the way
 * the camper is — a few hundred merged primitives, several of them rounded
 * boxes whose corner radius is clamped against a thin dimension — so they
 * produce exactly the same degenerate triangles.
 *
 * `computeVertexNormals()` leaves a zero-area triangle's normal at length zero
 * rather than failing. On the GPU three's prelude does `normalize(vNormal)`,
 * and normalize(vec3(0.0)) is NaN; the NaN lands in the HDR buffer and the
 * bloom mip chain averages it outward into a large black square. The full
 * autopsy is in `src/vehicle/CamperModel.js`. `node tools/nanhunt.mjs` is the
 * gate that catches a regression here.
 */
export function sanitizeNormals(g) {
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
//  Materials
//
//  Roughness values are not decoration. The stylised lighting in Stylize.js
//  quantises diffuse into bands and adds a specular term on top; a prop with
//  everything at roughness 0.9 lands entirely inside one band and reads as a
//  paper cut-out. The set below deliberately spans 0.14 (the aluminium frame
//  that should throw one bright line down its length) to 0.98 (fabric, which
//  must never glint).
// ─────────────────────────────────────────────────────────────────────────────

let _mats = null;

/**
 * The shared material set. Created once, reused by every prop, and picked up
 * automatically by `Atmosphere.harvest()` / `Stylize.harvest()` on the next
 * 16-frame tick after the meshes enter the scene.
 *
 * Every material has `vertexColors: true`, which is how a prop gets its own
 * colourway: author the geometry, tint it through the `Parts.add()` colour
 * callback, and it shares the material with everything else made of the same
 * stuff.
 */
export function campMaterials() {
  if (_mats) return _mats;

  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });

  _mats = {
    // Thin black powder-coated tube: chair frames, tent pole ferrules, stakes.
    // Slightly metallic and not very rough, because the one thing that keeps a
    // 14 mm tube legible at 30 m is the specular line running down it.
    tube:     std({ color: C(0x232329), roughness: 0.38, metalness: 0.55, envMapIntensity: 0.75 }),
    // Bright mill-finish aluminium: the table's X-frame.
    alu:      std({ color: C(0xb9bdc2), roughness: 0.22, metalness: 0.88, envMapIntensity: 1.05 }),
    // Anodised black aluminium: table slats.
    anod:     std({ color: C(0x2b2c30), roughness: 0.34, metalness: 0.62, envMapIntensity: 0.7 }),
    // Injection-moulded plastic: joint collars, feet, latches, buckles.
    plastic:  std({ color: C(0x2a2a2e), roughness: 0.56, metalness: 0.02, envMapIntensity: 0.35 }),
    // Rotomoulded HDPE — the cooler body. Matte with a slight sheen off the
    // rounded walls, which is the whole look of a Tundra.
    hdpe:     std({ color: C(0x8f3a3c), roughness: 0.62, metalness: 0.0,  envMapIntensity: 0.42 }),
    // Coated ripstop nylon: chair slings, tent fly. No metalness at all, and
    // high roughness, so it never picks up a hot spot — fabric reads by its
    // silhouette and its folds, not by its highlight.
    fabric:   std({ color: C(0xffffff), roughness: 0.94, metalness: 0.0, envMapIntensity: 0.22 }),
    // Fly fabric seen from inside the door, and mesh panels: same stuff, drawn
    // double-sided and darker.
    fabricIn: std({ color: C(0xffffff), roughness: 0.97, metalness: 0.0, envMapIntensity: 0.10,
                    side: THREE.DoubleSide }),
    // Insect mesh and mesh chair backs: a dark screen you can *almost* see
    // through. Cheaper and far more stable than real alpha — a transparent
    // mesh panel at 20 m is pure aliasing crawl.
    mesh:     std({ color: C(0x14161a), roughness: 0.92, metalness: 0.0, envMapIntensity: 0.14,
                    side: THREE.DoubleSide }),
    // Webbing, guy line, cord.
    cord:     std({ color: C(0xd8cfae), roughness: 0.9,  metalness: 0.0, envMapIntensity: 0.2 }),
    // Bare timber: firewood, log seats.
    wood:     std({ color: C(0x8a6a46), roughness: 0.9,  metalness: 0.0, envMapIntensity: 0.25 }),
    // Charred wood in the fire.
    char:     std({ color: C(0x241d1c), roughness: 0.95, metalness: 0.0, envMapIntensity: 0.1 }),
    // River cobble for the fire ring.
    stone:    std({ color: C(0x7d7871), roughness: 0.86, metalness: 0.02, envMapIntensity: 0.3 }),
    // Rubber: chair feet, cooler latches, tent guy-line tensioners.
    rubber:   std({ color: C(0x1b1b1e), roughness: 0.88, metalness: 0.02, envMapIntensity: 0.25 }),
    // Stainless: cooler hinge pins, table hardware.
    steel:    std({ color: C(0xa8abae), roughness: 0.28, metalness: 0.95, envMapIntensity: 1.0 }),
  };
  return _mats;
}

/** Dispose the shared set. Only Camp.js calls this, on teardown. */
export function disposeCampMaterials() {
  if (!_mats) return;
  for (const m of Object.values(_mats)) m.dispose();
  _mats = null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parts — merge-by-material bins
// ─────────────────────────────────────────────────────────────────────────────
export class Parts {
  constructor(label = 'camp') { this.bins = new Map(); this.label = label; }

  /**
   * @param geo   source geometry (consumed — do not reuse it afterwards)
   * @param key   material key in `campMaterials()`
   * @param m     THREE.Matrix4 placement (optional)
   * @param tint  [r,g,b] multiplier, or fn(x,y,z) -> [r,g,b], baked per vertex
   */
  add(geo, key, m = null, tint = null) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (m) g.applyMatrix4(m);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
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
    // Recomputed rather than transformed: `applyMatrix4` above handles normals
    // correctly for rigid transforms but not for the non-uniform scales these
    // helpers lean on, and a wrong normal on a thin prop is a black facet.
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    sanitizeNormals(g);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  /** Merge each bin into one mesh and parent it. */
  flush(parent, { cast = true, receive = true } = {}) {
    const mats = campMaterials();
    const made = [];
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn(`[camp:${this.label}] no material "${key}"`); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn(`[camp:${this.label}] merge failed for "${key}"`); continue; }
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.name = `${this.label}_${key}`;
      parent.add(mesh);
      made.push(mesh);
    }
    this.bins.clear();
    return made;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
export const M = () => new THREE.Matrix4();

export const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  M().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );

/** A rounded box. Radius is clamped so it can never exceed half the thinnest side. */
export const rbox = (w, h, d, r = 0.02, seg = 1) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) * 0.49));

/**
 * A tube, hexagonal by default.
 *
 * Six sides, not twelve: a 14 mm chair leg is about eight pixels wide at any
 * distance the player actually looks at a camp from, and a twelve-sided
 * cylinder at eight pixels is a shimmering grey worm, because no facet is ever
 * more than a pixel and the specular term crawls between them. Six flat facets
 * give a definite lit side and a definite dark side, which is what reads as a
 * round black tube. This is the same argument the tree-trunk author landed on.
 */
export const tube = (r, len, seg = 6) =>
  new THREE.CylinderGeometry(r, r, len, seg, 1, false);

/** A tube with rounded caps, for anything whose end is visible. */
export const rod = (r, len, seg = 6) =>
  new THREE.CapsuleGeometry(r, Math.max(0.001, len - r * 2), 2, seg);

/**
 * Place a tube (or any Y-axis primitive) so it spans from `a` to `b`.
 * Returns the matrix; the geometry should be built with `len = a.distanceTo(b)`.
 */
export function span(a, b, out = M()) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-6) return out.identity().setPosition(a.x, a.y, a.z);
  dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return out.compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * A sagging fabric panel spanning four corners.
 *
 * Fabric is the thing this whole set lives or dies on. A tent wall pulled
 * between two poles is a catenary in both directions and a chair sling with
 * nobody in it still bows about 8% of its span. A flat quad is the loudest tell
 * of programmer art in a set like this — it is why a cheap tent in a photograph
 * still looks like cloth and a game tent often does not.
 *
 * `sag` is the depth of the bow at the centre, in metres, along the panel's own
 * inward normal. `bulge` adds an outward bow instead (a fly stretched over a
 * pole arc pushes *out*, a sling hangs *in*).
 *
 * @param corners [p00, p10, p11, p01] in order around the panel
 * @param nu,nv   subdivisions — 10×10 is plenty; the sag is low-frequency
 * @param sag     centre deflection along -normal (positive = hangs in)
 * @param warp    optional fn(u, v, pos, normal) for wrinkles and seams
 */
export function fabricPanel(corners, nu = 10, nv = 10, sag = 0.05, warp = null) {
  const [p00, p10, p11, p01] = corners;
  const g = new THREE.PlaneGeometry(1, 1, nu, nv);
  const pos = g.attributes.position;
  const n = new THREE.Vector3();
  // Panel normal from the corner fan, so `sag` has a consistent sense whichever
  // way the caller wound the corners.
  {
    const e1 = new THREE.Vector3().subVectors(p10, p00);
    const e2 = new THREE.Vector3().subVectors(p01, p00);
    n.crossVectors(e1, e2).normalize();
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) + 0.5, v = pos.getY(i) + 0.5;
    a.lerpVectors(p00, p10, u);
    b.lerpVectors(p01, p11, u);
    p.lerpVectors(a, b, v);
    // Product of two parabolas: zero along every edge, deepest at the centre.
    const k = 4 * u * (1 - u) * 4 * v * (1 - v);
    p.addScaledVector(n, -sag * k);
    if (warp) warp(u, v, p, n);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  sanitizeNormals(g);
  return g;
}

/**
 * A lathe-swept arc, for tent pole sleeves and fly ridges: sample `fn(t)` for
 * t in 0..1 to get a centreline, then sweep a small polygon along it.
 *
 * Sweeping by hand rather than using TubeGeometry because TubeGeometry's Frenet
 * frames flip on a low-curvature arc — which puts a visible twist in the middle
 * of a tent pole, and that twist is exactly the kind of defect that survives
 * being squinted at.
 */
export function sweptArc(fn, samples = 24, radius = 0.008, sides = 5) {
  const pts = [];
  for (let i = 0; i <= samples; i++) pts.push(fn(i / samples));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0);
  const g = new THREE.TubeGeometry(curve, samples, radius, sides, false);
  sanitizeNormals(g);
  return g;
}

/**
 * Ground dust on the bottom of a prop.
 *
 * Every one of these objects has been carried out of a truck and put down on
 * dirt. Desaturating and lightening the lowest 60–120 mm is most of what makes
 * a prop sit in the world rather than on it — the same trick the camper uses
 * for road grime, and the reason its wheels do not look like they were dropped
 * in from a different render.
 *
 * Returns a tint callback for `Parts.add`.
 */
export function dusted(base, { top = 0.12, amount = 0.34, dust = [1.14, 1.06, 0.88] } = {}) {
  return (x, y) => {
    const k = clamp01(smoothstep(top, 0.0, y)) * amount;
    return [
      base[0] * (1 - k) + dust[0] * k,
      base[1] * (1 - k) + dust[1] * k,
      base[2] * (1 - k) + dust[2] * k,
    ];
  };
}

/** Multiply two tint callbacks (or constants) together. */
export function tintMul(a, b) {
  const f = (t) => (typeof t === 'function' ? t : () => t);
  const fa = f(a), fb = f(b);
  return (x, y, z) => {
    const p = fa(x, y, z), q = fb(x, y, z);
    return [p[0] * q[0], p[1] * q[1], p[2] * q[2]];
  };
}

/**
 * Convert an sRGB hex to the linear multiplier that reproduces it through a
 * material whose own `color` is white.
 *
 * Vertex colours multiply the material colour in *linear* space. Authoring a
 * colourway as a hex and forgetting the conversion is how a set of props ends
 * up uniformly washed out, and it is subtle enough to survive a review.
 */
export function tintOf(hex) {
  const c = C(hex);
  return [c.r, c.g, c.b];
}

/**
 * The same, but relative to a material that already has a colour — returns the
 * multiplier that turns `matHex` into `wantHex`.
 */
export function tintFrom(matHex, wantHex) {
  const a = C(matHex), b = C(wantHex);
  return [b.r / Math.max(a.r, 1e-4), b.g / Math.max(a.g, 1e-4), b.b / Math.max(a.b, 1e-4)];
}

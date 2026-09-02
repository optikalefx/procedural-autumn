// ─────────────────────────────────────────────────────────────────────────────
//  lily_forms — the pad shapes. Geometry only; no placement, no colour.
//
//  A lily pad is a disc with three things wrong with it, and the three are what
//  make it read as a lily pad rather than a green coin:
//
//    · the NOTCH — a V cut from the rim toward the stem. Its width is the
//      single most recognisable feature of the silhouette, so it is the axis
//      the variants differ along (a narrow slit, a wide open V, and two between).
//    · the RIM CURL — a real pad lies flat on the water and turns up at the
//      very edge, a centimetre or two. The curl is what catches the key light
//      as a bright ring and casts the pad's only shadow line. Nothing domes:
//      the middle of a pad is FLAT, and an earlier cut that domed it read as a
//      pile of green buttons from the shore.
//    · the OUTLINE WOBBLE — a low-order radial modulation so no two pads are
//      the same circle. Two or three harmonics is enough; more reads as torn.
//
//  Every pad is authored at UNIT radius with the water at y = 0 and the stem
//  at the origin, so an instance is a Y-rotation and a scale of (r·squash, r, r).
//  The bottom is open — the underside of a floating pad is in the water, and
//  the material is double-sided so the curl's inside face still draws.
//
//  `padProfile` is exported because the streaming system has to answer "how
//  high is the pad's surface at this point" for whatever lands on one, and the
//  answer must be the geometry's, not a second model of it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, smoothstep, mulberry32 } from '../core/MathUtils.js';

// Height of the surface at a normalised radius u (0 at the stem, 1 at the
// rim), in UNITS OF PAD RADIUS. `curl` is the variant's curl strength.
// The rim turns up over the outer quarter; everything inside that is flat.
export function padProfile(u, curl = 1) {
  const t = smoothstep(0.72, 1.0, u);
  return 0.075 * curl * t * t;
}

// Rings from stem to rim, as normalised radii. Dense toward the rim, where
// the curl lives, and a single flat span across the middle. The rim radius
// appears TWICE: the second copy is the skirt ring, which the vertex shader
// drops a fixed world distance so the pad has a thickness. It is a separate
// ring so the skirt is a vertical wall under the rim rather than a slope from
// the curl — the first build dropped the rim ring itself, and the outer strip
// became a wide chamfer that drew as a fat yellow band.
const RINGS = [0.3, 0.58, 0.76, 0.88, 0.95, 1.0, 1.0];
// Skirt vertices carry uv.x just over 1 as their flag; the material tests it.
export const SKIRT_U = 1.002;
const SEGS = 30;             // around the full circle

/**
 * How wide the notch is at ring radius u, as a half-angle. The V is widest at
 * the rim and closes toward the stem, reaching the centre only as a point —
 * a notch cut straight to the middle at full width halves the pad.
 */
function notchHalf(u, rimHalf, reach) {
  // `reach` is how far in from the rim the notch runs (0.45 = a little under
  // half way). Below (1 - reach) the notch is closed.
  const t = clamp01((u - (1 - reach)) / reach);
  return rimHalf * Math.pow(t, 0.8);
}

/**
 * The variants, from a slit to an open V. `reach` couples to width the way
 * real pads do: a wide V tends to be a shallow one.
 */
export const LILY_VARIANTS = [
  { notch: 0.34, reach: 0.56, curl: 0.85, wobble: 0.030 },   // narrow slit
  { notch: 0.58, reach: 0.50, curl: 1.00, wobble: 0.040 },   // the classic
  { notch: 0.84, reach: 0.46, curl: 1.15, wobble: 0.050 },   // open V
  { notch: 1.12, reach: 0.40, curl: 0.95, wobble: 0.060 },   // wide, shallow
];

/**
 * One pad geometry. Position is the surface (unit radius, y up), `uv.x` is the
 * normalised radius u so the material can shade rim and stem without an atan,
 * `uv.y` is the angle around the pad in 0..1 for the vein pattern.
 */
function buildPad(v, rng) {
  const rimHalf = v.notch * 0.5;
  // Outline wobble: three harmonics with random phase. Kept low-order.
  const w1 = v.wobble, w2 = v.wobble * 0.6, w3 = v.wobble * 0.35;
  const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2, p3 = rng() * Math.PI * 2;
  const k2 = 2 + ((rng() * 2) | 0), k3 = 4 + ((rng() * 3) | 0);
  const rimR = (a) => 1 + w1 * Math.sin(a + p1) + w2 * Math.sin(k2 * a + p2) + w3 * Math.sin(k3 * a + p3);

  const pos = [], uv = [], idx = [];
  // Centre vertex (the stem).
  pos.push(0, 0, 0); uv.push(0, 0);
  const ringStart = [];
  for (let ri = 0; ri < RINGS.length; ri++) {
    const u = RINGS[ri];
    const half = notchHalf(u, rimHalf, v.reach);
    ringStart.push(pos.length / 3);
    // The notch is centred on +Z (angle 0). Vertices run from the notch's one
    // edge round to the other, SEGS+1 of them so the two edges are real
    // vertices and the V has a crisp lip.
    const skirt = ri === RINGS.length - 1;
    for (let s = 0; s <= SEGS; s++) {
      const a = half + (s / SEGS) * (Math.PI * 2 - 2 * half);
      const r = u * rimR(a);
      const y = padProfile(u, v.curl);
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r);
      uv.push(skirt ? SKIRT_U : u, a / (Math.PI * 2));
    }
  }
  // Fan from the centre to the first ring. Winding is counter-clockwise seen
  // from ABOVE (+Y): with x = sin a, z = cos a the angle runs clockwise from
  // above, so the vertex order here is (centre, s, s+1) and not the other way
  // round — the first build had it reversed, every normal pointed at the bed,
  // and the whole colony drew as its own wine-red underside.
  for (let s = 0; s < SEGS; s++) {
    idx.push(0, ringStart[0] + s, ringStart[0] + s + 1);
  }
  // Quads between rings, same winding.
  for (let ri = 0; ri < RINGS.length - 1; ri++) {
    const a0 = ringStart[ri], b0 = ringStart[ri + 1];
    for (let s = 0; s < SEGS; s++) {
      const a = a0 + s, b = b0 + s;
      idx.push(a, b, b + 1);
      idx.push(a, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // The skirt ring sits ON the rim ring, so every triangle between the two is
  // zero-area and computeVertexNormals leaves the skirt vertices with a zero
  // normal — which GLSL's normalize turns into NaN, which bloom then smears
  // over the ENTIRE frame (measured: a 100% black capture). The wall's normal
  // is radial anyway; write it, and give the rim ring the same so the wall
  // shades as one face rather than folding at its top edge.
  {
    const nrm = g.attributes.normal.array;
    const rim = ringStart[RINGS.length - 2], sk = ringStart[RINGS.length - 1];
    for (let s = 0; s <= SEGS; s++) {
      const i = (rim + s) * 3, j = (sk + s) * 3;
      const x = pos[j], z = pos[j + 2], l = Math.hypot(x, z) || 1;
      nrm[j] = x / l; nrm[j + 1] = 0; nrm[j + 2] = z / l;
      // The rim: halfway between its curl normal and the wall's.
      nrm[i] = (nrm[i] + x / l) * 0.5; nrm[i + 1] *= 0.5; nrm[i + 2] = (nrm[i + 2] + z / l) * 0.5;
      const m = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= m; nrm[i + 1] /= m; nrm[i + 2] /= m;
    }
    g.attributes.normal.needsUpdate = true;
  }
  g.computeBoundingSphere();
  return g;
}

/** All variants, seeded so the wobble phases are the same on every load. */
export function buildLilyLibrary(seed) {
  const rng = mulberry32((seed ^ 0x11a9) >>> 0);
  return LILY_VARIANTS.map((v) => buildPad(v, rng));
}

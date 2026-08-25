// ─────────────────────────────────────────────────────────────────────────────
//  bald eagle — the bird you stop the car for.
//
//  A bald eagle at the top of a spruce is a landmark, and the same eagle
//  crossing the valley is an event on the order of a deer sighting, so this is
//  a model that has to survive being watched: a lofted body, the white head
//  and tail, a hooked beak, slotted primaries.
//
//  Unit space, nose along +Z, wingspan exactly 1.0 along ±X — the instance
//  scale IS the wingspan in metres. Behaviour is `tree_birds.js`; the aWing /
//  aPose contract is `bird_material.js`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../../core/MathUtils.js';
import { smoothTuples } from '../loft_smooth.js';
import { treeBirdMaterial } from './bird_material.js';

// ── plumage ──────────────────────────────────────────────────────────────────
//
// Bald eagle, with the flocks.js lesson applied: the body is dark brown, not
// black — a perched eagle at 90 m has to silhouette against sky OR read
// against a dark crown, and a near-black bird against a near-black spruce is
// invisible at every distance. The white head/tail carry the identification;
// they are warm off-whites, not 0xffffff, so the tonemapper has room.
const C_BODY  = new THREE.Color(0x4a3826);   // dark warm brown
const C_WING  = new THREE.Color(0x40301f);   // flight feathers, a shade darker
const C_COVERT = new THREE.Color(0x59442c);  // leading-edge coverts, lighter
const C_PRIM  = new THREE.Color(0x33261a);   // slotted primaries, darkest
const C_HEAD  = new THREE.Color(0xd9d2c2);   // white head
const C_TAIL  = new THREE.Color(0xd3ccbb);   // white tail
const C_BEAK  = new THREE.Color(0xc9942e);   // yellow beak
const C_FOOT  = new THREE.Color(0xc9942e);   // yellow tarsi

// ── density ──────────────────────────────────────────────────────────────────
//
// The same recipe the great horned owl is built to (great_horned_owl.js's
// own "density" block carries the long version). This model shipped at 179
// triangles — an eight-sided loft through six stations with nothing
// interpolated between them — and next to a rebuilt owl on the same branch it
// read as exactly what it was: a stack of welded cones with two flat blades
// bolted on.
//
// Triangle count is near-free on this GPU (AGENTS.md: the 4.5 M budget line is
// stale and the trees peak at 7–8 M while driving), and an eagle is capped at
// a handful of live instances. Smaller facets are the cheapest fidelity in the
// file.
//
// FLAT SHADING IS NOT NEGOTIABLE — treeBirdMaterial derives the normal per
// pixel from the derivative, and that is the house style. What is bought here
// is SMALLER facets, never smoother ones.
const RING = 20;          // body loft sides (was 8)
const BODY_SMOOTH = 4;    // Catmull-Rom rings per authored body interval
const WING_SMOOTH = 3;    // Catmull-Rom stations per authored wing interval
const PRIM_SEG = 3;       // segments along each slotted primary
// Chord splits, leading edge to trailing edge.
const WING_CHORD = [0, 0.14, 0.28, 0.42, 0.62, 0.80, 1];

/**
 * The bald eagle, nose along +Z, wingspan exactly 1.0 along ±X so the
 * instance scale IS the wingspan in metres (the flocks.js convention).
 *
 * aWing is 0 on everything that is not wing, and ±(spanwise fraction) on the
 * wings; the shader flaps and folds by rotating each vertex about the shoulder
 * by an angle graded on that fraction, which bends the wing instead of
 * hinging it.
 */
export function buildBaldEagleGeometry() {
  const pos = [], nor = [], wing = [], col = [];
  const _c = new THREE.Color();

  const vert = (p, w, c, mul = 1) => {
    pos.push(p[0], p[1], p[2]);
    nor.push(0, 1, 0);            // flat shading derives the real one per-pixel
    wing.push(w);
    _c.copy(c).multiplyScalar(mul);
    col.push(_c.r, _c.g, _c.b);
  };
  // w is one weight for the whole triangle, or [wa, wb, wc] per vertex — the
  // wings need the latter so the shader's bend is continuous across the span.
  const tri = (a, b, c, w, ca, cb = ca, cc = ca, ma = 1, mb = 1, mc = 1) => {
    const wa = Array.isArray(w) ? w[0] : w;
    const wb = Array.isArray(w) ? w[1] : w;
    const wc = Array.isArray(w) ? w[2] : w;
    vert(a, wa, ca, ma); vert(b, wb, cb, mb); vert(c, wc, cc, mc);
  };
  const quad = (a, b, c, d, w, cab, ccd = cab, mab = 1, mcd = 1) => {
    tri(a, b, c, w, cab, cab, ccd, mab, mab, mcd);
    tri(a, c, d, w, cab, ccd, ccd, mab, mcd, mcd);
  };

  // ── body: a loft through six AUTHORED stations, tail root to forehead ─────
  // Stations: z, half-width, half-depth, centre height. smoothTuples rounds
  // the path between them (BODY_SMOOTH), and the ring is swept at RING sides
  // rather than the eight this model shipped with. The old eight-sided,
  // six-station barrel was the armour plate the owl rebuild names: an eagle
  // is a bird the game asks the player to STOP for, and a stack of welded
  // cones does not survive being looked at.
  //
  // Colour is a FUNCTION OF Z, not of station index. The white head is the
  // one line that says "bald eagle" at forty metres, so it lives in the
  // geometry — and keyed on z it lands in exactly the same place whatever
  // BODY_SMOOTH is set to. The ramp reproduces the old station colours
  // exactly: brown at and below z = 0.028, white at and above z = 0.092.
  const ST_KEY = [
    [-0.150, 0.017, 0.019, 0.034],
    [-0.062, 0.041, 0.047, 0.024],
    [ 0.028, 0.047, 0.053, 0.030],
    [ 0.092, 0.033, 0.037, 0.050],
    [ 0.148, 0.027, 0.029, 0.060],
    [ 0.184, 0.015, 0.016, 0.054],
  ];
  const ST = smoothTuples(ST_KEY, BODY_SMOOTH);
  const ring = (st) => {
    const pts = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      pts.push([Math.cos(a) * st[1], st[3] + Math.sin(a) * st[2], st[0]]);
    }
    return pts;
  };
  const rings = ST.map(ring);
  // Two instances, not one scratch: both colours of a band are alive at the
  // same time inside a tri() call, and one shared Color would hand it the
  // same value twice.
  const _c0 = new THREE.Color(), _c1 = new THREE.Color();
  const bodyCol = (into, z) => into.copy(C_BODY).lerp(C_HEAD, clamp01((z - 0.028) / 0.064));
  for (let i = 0; i < ST.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    bodyCol(_c0, ST[i][0]); bodyCol(_c1, ST[i + 1][0]);
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      // Countershade: the belly a stop lighter than the back, so the bird has
      // internal value range before light touches it (same trick as flocks.js).
      const sA = Math.sin((k / RING) * Math.PI * 2);
      const sB = Math.sin((k2 / RING) * Math.PI * 2);
      const mA = 1 - sA * 0.10 + clamp01(-sA) * 0.14;
      const mB = 1 - sB * 0.10 + clamp01(-sB) * 0.14;
      tri(r0[k], r0[k2], r1[k2], 0, _c0, _c0, _c1, mA, mB, mB);
      tri(r0[k], r1[k2], r1[k], 0, _c0, _c1, _c1, mA, mB, mA);
    }
  }
  // Tail-root cap.
  for (let k = 0; k < RING; k++) {
    tri([0, 0.034, -0.162], rings[0][(k + 1) % RING], rings[0][k], 0, C_BODY);
  }

  // ── beak: fan from the forehead ring to a tip, then the hook ──────────────
  const bk = rings[ST.length - 1];
  const tipA = [0, 0.052, 0.216];
  for (let k = 0; k < RING; k++) tri(bk[k], bk[(k + 1) % RING], tipA, 0, C_BEAK);
  const hook = [0, 0.030, 0.224];
  tri([0.010, 0.050, 0.210], [-0.010, 0.050, 0.210], hook, 0, C_BEAK, C_BEAK, C_BEAK, 0.92, 0.92, 0.8);

  // ── tail: a white fan of six staggered feathers ───────────────────────────
  // Feather angle rides in aWing at a magnitude BELOW the wing band (< 0.105,
  // wings start at 0.12): the shader reads it back and folds the fan shut when
  // the bird perches — spread in flight, a narrow white wedge on the branch.
  const TB = [0, 0.030, -0.140];
  const NF = 6;
  for (let i = 0; i < NF; i++) {
    const a = lerp(-0.46, 0.46, NF === 1 ? 0.5 : i / (NF - 1));
    const wTail = (a / 0.46) * 0.09;
    const dx = Math.sin(a), dz = -Math.cos(a);
    const len = 0.145 - Math.abs(a) * 0.028;         // centre feathers longest
    const y = TB[1] - 0.004 + (i % 2) * 0.005;       // stagger kills coplanar shimmer
    const px = -dz * 0.012, pz = dx * 0.012;         // half-width across the feather
    quad(
      [TB[0] - px, y, TB[2] - pz],
      [TB[0] + px, y, TB[2] + pz],
      [TB[0] + dx * len + px * 1.5, y - 0.012, TB[2] + dz * len + pz * 1.5],
      [TB[0] + dx * len - px * 1.5, y - 0.012, TB[2] + dz * len - pz * 1.5],
      wTail, C_TAIL, C_TAIL, 1, 0.93,
    );
  }

  // ── wings ─────────────────────────────────────────────────────────────────
  // Planform from spanwise stations: broad secondaries, a rounded tip carrying
  // five slotted primaries — the slots are most of what says "eagle, not
  // gull" in silhouette.
  //
  // Five AUTHORED stations, smoothTuples'd to thirteen, and the chord cut into
  // six panels instead of two. Both halves earn their keep and for different
  // reasons: the shader bends the wing by grading its rotation on the spanwise
  // fraction, so SPAN density is what turns the beat from a hinge into a
  // curve, while CHORD density is what stops the panel creasing into two flat
  // facets when the fold stands it on edge. At two chord panels it was,
  // unmistakably, a blade.
  const SPAN_KEY = [
    // x,     LE z,   TE z,    y
    [0.046, 0.112, -0.068, 0.030],
    [0.150, 0.118, -0.082, 0.040],
    [0.270, 0.108, -0.070, 0.046],
    [0.370, 0.088, -0.048, 0.050],
    [0.446, 0.062, -0.018, 0.052],
  ];
  const SPAN = smoothTuples(SPAN_KEY, WING_SMOOTH);
  const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.046) / 0.40);
  // Camber as an arc peaking a third of the way back, rather than the single
  // lifted mid-chord point that made a tent out of it. Peak matches the old
  // 0.008 lift at the old 0.42 mid-line.
  const camber = (t) => 0.0083 * Math.sin(Math.PI * Math.pow(clamp01(t), 0.72));
  // Colour by chord fraction, not by panel index — covert along the leading
  // edge stepping into the flight feathers by 42% of chord, which is where
  // the old two-panel split put the boundary, and the trailing edge a stop
  // down. Keyed on t it stays put however finely the chord is cut.
  const _wc = new THREE.Color();
  const wingCol = (t) => _wc.copy(C_COVERT).lerp(C_WING, clamp01(t / 0.42));
  const wingMul = (t) => lerp(1, 0.9, clamp01((t - 0.42) / 0.58));
  for (const s of [1, -1]) {
    const pt = (st, t) => [s * st[0], st[3] + camber(t), lerp(st[1], st[2], t)];
    for (let i = 0; i < SPAN.length - 1; i++) {
      const A = SPAN[i], D = SPAN[i + 1];
      const wA = s * wingW(A[0]), wD = s * wingW(D[0]);
      for (let j = 0; j < WING_CHORD.length - 1; j++) {
        const t0 = WING_CHORD[j], t1 = WING_CHORD[j + 1];
        // Six vert() calls rather than two tri() calls: every corner wants its
        // own colour and weight, and tri()'s three-colour form cannot express
        // a bilinear patch. Winding matches the old two-panel loft.
        const put = (st, w, t) => vert(pt(st, t), w, wingCol(t), wingMul(t));
        put(A, wA, t0); put(D, wD, t0); put(D, wD, t1);
        put(A, wA, t0); put(D, wD, t1); put(A, wA, t1);
      }
    }
    // Slotted primaries: five fingers off the tip station, progressively swept
    // back, tips curling up the way a soaring eagle's do. Split along their
    // length so the curl reads as a curve rather than a kink at the root.
    const [xt, let_, tet, yt] = SPAN[SPAN.length - 1];
    const FING = [
      // sweep (rad back from +x), length, chord position 0..1 LE→TE
      [-0.10, 0.100, 0.06],
      [ 0.10, 0.116, 0.27],
      [ 0.32, 0.120, 0.50],
      [ 0.56, 0.108, 0.72],
      [ 0.82, 0.090, 0.92],
    ];
    for (const [sw, len, cp] of FING) {
      const bz = lerp(let_, tet, cp);
      const dx = Math.cos(sw), dz = -Math.sin(sw);
      const hw = 0.013;
      const fp = (u, side) => {
        const h = hw * lerp(1, 0.5, u);
        return [s * (xt + dx * len * u), yt + 0.022 * u * u, bz + dz * len * u + h * side];
      };
      for (let g = 0; g < PRIM_SEG; g++) {
        const u0 = g / PRIM_SEG, u1 = (g + 1) / PRIM_SEG;
        quad(fp(u0, 1), fp(u0, -1), fp(u1, -1), fp(u1, 1),
          s * 1.0, C_PRIM, C_PRIM, lerp(1, 0.88, u0), lerp(1, 0.88, u1));
      }
    }
  }

  // ── feet: two yellow tarsi tucked at the belly ────────────────────────────
  // Visible when perched (gripping under the body), lost against the belly in
  // flight — one geometry serves both states. Small and dim on purpose: the
  // first pass hung two bright boxes that read as landing gear.
  for (const s of [1, -1]) {
    const fx = s * 0.020, fz = 0.012;
    quad([fx - 0.005, -0.030, fz + 0.006], [fx + 0.005, -0.030, fz + 0.006],
      [fx + 0.004, -0.052, fz + 0.014], [fx - 0.004, -0.052, fz + 0.014], 0, C_FOOT, C_FOOT, 0.72, 0.72);
    quad([fx + 0.005, -0.030, fz + 0.006], [fx + 0.005, -0.030, fz - 0.006],
      [fx + 0.004, -0.052, fz + 0.000], [fx + 0.004, -0.052, fz + 0.014], 0, C_FOOT, C_FOOT, 0.6, 0.6);
    quad([fx - 0.005, -0.030, fz - 0.006], [fx - 0.005, -0.030, fz + 0.006],
      [fx - 0.004, -0.052, fz + 0.014], [fx - 0.004, -0.052, fz + 0.000], 0, C_FOOT, C_FOOT, 0.6, 0.6);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ── gallery builder ──────────────────────────────────────────────────────────

/** COLORWAYS-style variants for the gallery: judge both states. */
export const BALD_EAGLE_POSES = ['glide', 'perched'];

/**
 * One bald eagle at real scale (2.05 m wingspan) for the object gallery.
 * The pose attribute is baked per-vertex; time is frozen mid-upstroke.
 */
export function buildBaldEagle(rnd, opts = {}) {
  // Spelt out against opts.pose so the gallery's option probe sees a
  // two-value enum and deals each pose its own card (the waders' trick).
  const perched = opts.pose === 'perched' && opts.pose !== 'glide';
  const geo = buildBaldEagleGeometry();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    arr[i * 4] = 0.7;                       // phase → wings a touch raised
    arr[i * 4 + 1] = 0.0;                   // rate 0: frozen for the thumbnail
    arr[i * 4 + 2] = perched ? 0.0 : 0.55;
    arr[i * 4 + 3] = perched ? 1.0 : 0.0;
  }
  geo.setAttribute('aPose', new THREE.Float32BufferAttribute(arr, 4));
  const mesh = new THREE.Mesh(geo, treeBirdMaterial({ time: { value: 0 } }));
  // 4.1 m span — 2x life, matching TREE_BIRD_SPECIES. Both stand-off heights
  // are fractions of the span rather than fixed metres, so a future scale
  // change does not leave the bird buried in the studio floor.
  const SPAN = 4.1;
  mesh.scale.setScalar(SPAN);
  if (perched) { mesh.rotation.x = -0.85; mesh.position.y = SPAN * 0.44; }
  else mesh.position.y = SPAN * 0.59;
  const g = new THREE.Group();
  g.add(mesh);
  void rnd;
  return g;
}

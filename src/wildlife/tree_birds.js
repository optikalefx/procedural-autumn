// ─────────────────────────────────────────────────────────────────────────────
//  tree_birds — birds that live IN the trees, not over them.
//
//  birds.js owns the sky: wheeling specks and a startle burst, nine triangles
//  each, never meant to be looked at. This file owns the opposite moment — a
//  bird you *stop* for. A bald eagle at the top of a spruce is a landmark; the
//  same eagle crossing the valley to another tree is an event on the order of
//  a deer sighting, and it needs a model that survives being watched.
//
//  So these are medium-fidelity: a lofted body, the white head and tail, a
//  hooked beak, slotted primaries. Still one InstancedMesh per species, still
//  one draw call, still animated in the vertex shader — a per-instance pose
//  attribute carries { flap phase, flap rate, flap amplitude, wing fold } and
//  the CPU only ever writes a matrix and four floats per bird.
//
//  The species table is a table because the eagle is not meant to stay alone,
//  and it hasn't: the heron and the flamingo (models in water_birds.js) are
//  rows with habitat: 'water', whose "perch" is a patch of shallow water found
//  through the world's hydro queries instead of a treetop. The behaviour
//  (settle → pick a site in an annulus at random → fly to it → settle) is
//  shared machinery either way.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, mulberry32 } from '../core/MathUtils.js';
import { SPECIES as TREE_SPECIES } from '../vegetation/tree_species.js';
import { smoothTuples } from './loft_smooth.js';
import { buildFlamingoGeometry, buildBlueHeronGeometry } from './water_birds.js';

// ── plumage ──────────────────────────────────────────────────────────────────
//
// Bald eagle, with the birds.js lesson applied: the body is dark brown, not
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
// The same recipe the great horned owl is built to (owl.js's own "density"
// block carries the long version). This model shipped at 179 triangles — an
// eight-sided loft through six stations with nothing interpolated between
// them — and next to a rebuilt owl on the same branch it read as exactly what
// it was: a stack of welded cones with two flat blades bolted on.
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
 * instance scale IS the wingspan in metres (the birds.js convention).
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
      // internal value range before light touches it (same trick as birds.js).
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

/**
 * Standard material — shared fog, shared stylised lighting — with the pose
 * work in the vertex shader. aPose is per-instance in the game and per-vertex
 * in the gallery; GLSL cannot tell the difference, which is the point.
 *
 *   aPose.x  flap phase        aPose.z  flap amplitude (rad at the tip)
 *   aPose.y  flap rate (Hz)    aPose.w  wing fold, 0 = spread, 1 = perched
 */
export function treeBirdMaterial(shared) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTreeBirdTime = shared.time;
    mat.userData.shader = shader;
    shader.vertexShader = /* glsl */`
      attribute float aWing;
      attribute vec4 aPose;
      uniform float uTreeBirdTime;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */`#include <begin_vertex>
      // aWing bands: 0 body, <0.105 tail fan, 0.105..0.111 legs, 0.111..0.119
      // neck, >=0.12 wing spanwise fraction. The leg and neck bands belong to
      // the waders (water_birds.js) and pivot on shared authored points; the
      // eagle has no vertices in either.
      if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.105 ) {
        // Tail feather: aWing encodes the feather angle (x5.1). Fold swings
        // each feather toward the centreline about the tail root, closing the
        // fan when the bird perches.
        float tfold = aPose.w;
        if ( tfold > 0.001 ) {
          float al = aWing * 5.1 * 0.80 * tfold;
          float ca = cos( al ), sa = sin( al );
          float tx = transformed.x, tz = transformed.z + 0.14;
          transformed.x = tx * ca + tz * sa;
          transformed.z = -tx * sa + tz * ca - 0.14;
        }
      }
      else if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.111 ) {
        // Leg. Standing (fold 1) it hangs from the hip; in flight it trails
        // straight back. The negative-side leg also draws up toward the belly
        // when standing — shortened toward the hip rather than bent, which at
        // this fidelity reads as the tucked leg of the one-legged stance.
        float s = aWing > 0.0 ? 1.0 : -1.0;
        float fold = aPose.w;
        float py = -0.015, pz = -0.030;
        float tuck = s < 0.0 ? fold : 0.0;
        if ( tuck > 0.001 ) {
          float k = 1.0 - 0.72 * tuck;
          transformed.y = py + ( transformed.y - py ) * k;
          transformed.z = pz + ( transformed.z - pz ) * k;
        }
        // The tucked stub also angles back, so it reads as a folded shank
        // against the belly rather than a shortened leg pointing at the water.
        float ang = ( 1.0 - fold ) * 1.35 + tuck * 0.9;
        float ca = cos( ang ), sa = sin( ang );
        float ry = transformed.y - py, rz = transformed.z - pz;
        transformed.y = py + ry * ca - rz * sa;
        transformed.z = pz + ry * sa + rz * ca;
      }
      else if ( abs( aWing ) > 0.001 && abs( aWing ) < 0.119 ) {
        // Neck, graded 0 at the root to 1 at the bill tip. The authored pose
        // is the raised standing neck; in flight each vertex pitches forward
        // about the root by its own grade, so the curve unrolls into the
        // extended flight neck rather than hinging like a lamp arm.
        float wn = clamp( ( abs( aWing ) - 0.1115 ) / 0.007, 0.0, 1.0 );
        float ext = 1.0 - aPose.w;
        if ( ext > 0.001 ) {
          float py = 0.045, pz = 0.10;
          float ang = ext * 1.25 * wn;
          float ca = cos( ang ), sa = sin( ang );
          float ry = transformed.y - py, rz = transformed.z - pz;
          transformed.y = py + ry * ca - rz * sa;
          transformed.z = pz + ry * sa + rz * ca;
        }
      }
      else if ( abs( aWing ) > 0.001 ) {
        float w = abs( aWing );
        float s = aWing > 0.0 ? 1.0 : -1.0;
        // Shoulder pivot. Rotating every wing vertex about the SAME pivot by
        // an angle graded on its own spanwise fraction bends the wing into an
        // arc — two-segment articulation for free, no bones.
        float px = s * 0.048;
        float py = 0.030;
        float pz = 0.030;
        // Flap: downstroke fast and deep, upstroke slow and shallow, tip
        // lagging the arm — a plain sine reads as a wind-up toy.
        float ph = uTreeBirdTime * aPose.y * 6.2831853 + aPose.x - w * 1.1;
        float sn = sin( ph );
        float beat = ( sn > 0.0 ? sn * sn : -abs( sn ) * 0.58 ) * aPose.z;
        float ang = beat * ( 0.40 + 0.72 * w );
        float ca = cos( ang ), sa = sin( ang );
        float rx = transformed.x - px, ry = transformed.y - py;
        transformed.x = px + rx * ca - ry * sa * s;
        transformed.y = py + rx * sa * s + ry * ca;
        // Fold: sweep the wing back around the shoulder and shorten it, more
        // at the tip than the root, so it wraps along the body rather than
        // sticking out sideways like a scarecrow.
        float fold = aPose.w;
        if ( fold > 0.001 ) {
          // First roll the sheet vertical — a folded wing is held flat
          // AGAINST the body side, not flat over the back; without this the
          // swept wing reads as a horizontal slab sticking off the bird.
          float rb = fold * ( 0.30 + 0.55 * w );
          float crb = cos( rb ), srb = sin( rb );
          float ax = transformed.x - px, ay = transformed.y - py;
          transformed.x = px + ax * crb + s * ay * srb;
          transformed.y = py - s * ax * srb + ay * crb;
          // Then sweep it back around the shoulder and shorten it. The
          // shortening is horizontal only — scaling y as well was tried and
          // crumples the rolled sheet into the body.
          float th = fold * ( 0.75 + 1.00 * w ) * s;
          float ct = cos( th ), st = sin( th );
          float fx = transformed.x - px, fz = transformed.z - pz;
          float k = 1.0 - 0.52 * fold * w;
          transformed.x = px + ( fx * ct + fz * st ) * k;
          transformed.z = pz + ( fz * ct - fx * st ) * k;
        }
      }`
    );
  };
  mat.customProgramCacheKey = () => 'treeBirdPose';
  return mat;
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

// ── the species table ────────────────────────────────────────────────────────
//
//   live      instance slots (hard cap on simultaneous birds of this species)
//   chance    when a bird leaves the streamed area, the odds it comes back
//             soon rather than going dormant for minutes — the valley should
//             sometimes simply not have an eagle in it
//   wingspan  metres; scale IS wingspan (geometry span is 1.0).
//
//             The two waders are deliberately drawn at 3x life: a real great
//             blue heron is a 2 m span and 1.1 m tall, and at that size it is
//             a grey smudge on a shadowed bank that nobody ever notices. These
//             are landmarks, so they are sized to read as landmarks. Two other
//             numbers move with it and are not free to leave behind — `wade`,
//             because the depth a bird will stand in is a fraction of its leg
//             and a 3 m bird ankle-deep in a puddle looks beached; and
//             `flapHz`, because beat frequency falls as span grows (roughly
//             1/sqrt) and a 6 m wing beating at a 2 m wing's rate buzzes.
//   perchS    seconds on a perch before moving on
//   hop       metres to the next tree, picked at random in that annulus
//   cruise    m/s in level flight
//   flapHz    wingbeat — a bald eagle is a SLOW flapper, and the slowness is
//             most of what distinguishes it from the corvid flocks overhead
//   minTreeH  metres; only mature trees hold a two-metre bird
//   startle   metres; a vehicle closer than this flushes a perched bird
//   startleDelay  seconds that vehicle has to STAY inside `startle`
//              before the bird actually goes. Default 0 — the eagle and
//              the heron leave the moment you crowd them, which is what
//              those birds do. A flamingo colony is the payoff at the end
//              of a boat trip, and a payoff that leaves on the frame you
//              arrive is not one, so it holds for five seconds first.
//
// Waders (habitat: 'water', models in water_birds.js) swap the tree fields
// for water ones:
//   wade       metres of standing-water depth a bird will stand in. The cap
//              is what keeps the belly above the surface at full leg length.
//   minSpan    metres of hydro `span` (how OPEN the water is) the site needs —
//              flamingos want a lake margin, not a brook.
//   footY      unit-space foot height (negative); -footY * scale is how far
//              the body origin stands above the bed.
//   perchPitch standing pitch — a wader stands level, not eagle-upright.
//   dip        metres of takeoff drop. An eagle FALLS off its tree onto its
//              wings; a wader starts half a metre over the water and springs.
//   cruiseUp   metres above the higher endpoint the flight cruises.
//   flock      spawns and lands near others of its kind when it can.
//   colony     if set, this species lives on exactly this many islands in the
//              whole valley and NOWHERE else — no mainland fallback. A bird
//              you can meet anywhere is scenery; one that lives on two known
//              islands is somewhere to go, which is the same reason a perched
//              eagle is written up as a landmark. See _ensureIslands.
export const TREE_BIRD_SPECIES = [
  {
    key: 'baldEagle',
    geometry: buildBaldEagleGeometry,
    live: 4,
    chance: 0.65,
    // 2x life. Less than the waders' 3x on purpose: an eagle is already read
    // against a treetop, which gives it a scale reference and a silhouette
    // against sky that a bird standing on a flat shore never gets.
    wingspan: [3.7, 4.5],
    perchS: [24, 75],
    hop: [55, 150],
    cruise: [11.0, 15.0],
    flapHz: [1.55, 2.0],
    flapAmp: [0.72, 0.95],
    minTreeH: 11,
    startle: 26,
  },
  {
    key: 'heron',
    geometry: buildBlueHeronGeometry,
    habitat: 'water',
    live: 3,
    chance: 0.6,
    // 3x life size, on purpose — see the note over TREE_BIRD_SPECIES.
    wingspan: [5.25, 6.0],
    perchS: [30, 90],          // a heron is a statue with a licence to fish
    hop: [40, 120],
    cruise: [8.0, 11.0],
    flapHz: [0.85, 1.1],       // slow, deep, unhurried — half the read
    flapAmp: [0.62, 0.85],
    startle: 30,
    wade: [0.18, 1.14],
    footY: -0.271,
    perchPitch: -0.10,
    dip: 0.3,
    cruiseUp: [3, 7],
  },
  {
    key: 'flamingo',
    geometry: buildFlamingoGeometry,
    habitat: 'water',
    live: 6,
    chance: 0.7,
    // 3x life size, on purpose — see the note over TREE_BIRD_SPECIES.
    wingspan: [4.05, 4.65],
    perchS: [20, 60],
    hop: [30, 90],
    cruise: [9.0, 13.0],
    flapHz: [1.8, 2.25],       // fast shallow beats, nothing like the eagle
    flapAmp: [0.48, 0.68],
    // Not a shy bird. 34 m made it the twitchiest of the three — it left
    // before you were close enough to see it was pink — so it now lets you
    // inside 14 m AND then holds that for five seconds before going.
    startle: 14,
    startleDelay: 5,
    wade: [0.36, 1.35],
    minSpan: 7,
    footY: -0.436,
    perchPitch: -0.04,
    dip: 0.25,
    cruiseUp: [2.5, 6],
    flock: true,
    colony: 2,
  },
];

// Streaming ring. Spawn perched birds far enough out that materialising is
// invisible, keep them until well past that, and never place one inside the
// view cone unless it is beyond VIS_OK (where a folded eagle is ~4 px).
const SPAWN_R = [85, 190];
const DESPAWN = 280;
const VIS_OK = 150;

// What counts as an island a wader would use (see _ensureIslands). The area
// window is doing two jobs at once: below it a land component is a gravel
// hummock with no room for a bird, and above it we have caught the mainland,
// which in this valley is ~6.9 M m² and would hand back its whole coastline.
const ISLAND_AREA = [400, 160000];
const ISLAND_RING_WET = 0.6;   // fraction of a ring around it that must be water
const ISLAND_OPEN = 6;         // metres of hydro span: a lake, not a creek bend

// Behaviour states.
const P_PERCH = 0, P_FLY = 1;

// How upright a perched bird sits (rotation about X; negative is nose-up).
// -0.5 read as a bird lying on its belly; a real perched eagle is closer to
// vertical than to horizontal.
const PERCH_PITCH = -0.85;

const _pm = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

export class TreeBirds {
  constructor(ctx, seed) {
    this.ctx = ctx;
    this.rnd = mulberry32(seed >>> 0);
    this.group = new THREE.Group();
    this.group.name = 'TreeBirds';
    this.shared = { time: { value: 0 } };
    this.stats = { live: 0, flights: 0 };

    this._dummy = new THREE.Object3D();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._col = new THREE.Color();
    this._time = 0;
    this._scanT = 0.5;
    // Conifer mask by tree-species index: eagles perch on spires, and a spire
    // hides the perch-point error a leaning tree introduces.
    this._conifer = TREE_SPECIES.map((s) => !!s.conifer);
  }

  build() {
    this.mat = treeBirdMaterial(this.shared);
    this.meshes = [];
    this.slots = [];
    for (const S of TREE_BIRD_SPECIES) {
      const geo = S.geometry();
      const mesh = new THREE.InstancedMesh(geo, this.mat, S.live);
      const pose = new THREE.InstancedBufferAttribute(new Float32Array(S.live * 4), 4);
      pose.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aPose', pose);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;       // perched: shadow lands inside the crown
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;    // instances are scattered; sphere is stale
      mesh.userData.pose = pose;
      this.group.add(mesh);
      this.meshes.push(mesh);

      const slots = [];
      for (let i = 0; i < S.live; i++) {
        // The geometry already carries the real plumage in its vertex colours,
        // and instanceColor MULTIPLIES that — so the per-bird variation must
        // stay near white. The first pass tinted with a mid-brown here and
        // turned the white head tan and the brown body black in-game.
        const m0 = 0.92 + this.rnd() * 0.18;
        const warm = (this.rnd() - 0.5) * 0.06;
        this._col.setRGB(m0 * (1 + warm), m0, m0 * (1 - warm));
        mesh.setColorAt(i, this._col);
        slots.push({
          spec: S, mesh, i,
          active: false,
          cool: this.rnd() * 20,     // stagger the first arrivals
          state: P_PERCH,
          x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0,
          sc: lerp(S.wingspan[0], S.wingspan[1], this.rnd()),
          timer: 0,
          tree: -1,
          // pose smoothing
          amp: 0, fold: 1, rate: 2.4, phase: this.rnd() * 6.28,
          spooked: 0,                // seconds a threat has been in startle range
          // flight path
          fx0: 0, fy0: 0, fz0: 0, fcx: 0, fcz: 0, fx1: 0, fy1: 0, fz1: 0,
          ft: 0, fdur: 1, fcruise: 0, fspeed: 12, bout: this.rnd() * 6.28,
        });
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.slots.push(slots);

      // Park everything out of sight until the first scan.
      this._dummy.position.set(0, -9000, 0);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.setScalar(0.0001);
      this._dummy.updateMatrix();
      for (let i = 0; i < S.live; i++) mesh.setMatrixAt(i, this._dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.ctx.scene.add(this.group);
  }

  // ── per frame ──────────────────────────────────────────────────────────────

  update(dt, cam, threat) {
    this._time += dt;
    this.shared.time.value = this._time;

    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = 0.8; this._scan(cam); }

    let live = 0;
    for (let s = 0; s < this.slots.length; s++) {
      const mesh = this.meshes[s];
      let dirty = false;
      for (const b of this.slots[s]) {
        if (!b.active) continue;
        live++;
        this._step(b, dt, threat);
        this._pose(b, mesh);
        dirty = true;
      }
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.userData.pose.needsUpdate = true;
      }
    }
    this.stats.live = live;
  }

  /**
   * Streaming. Perched birds well behind the player are recycled; empty slots
   * refill at the edge of the ring, never visibly. A bird mid-flight is left
   * alone until it lands — a vanishing eagle is worse than a distant one.
   */
  _scan(cam) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const cx = cam.position.x, cz = cam.position.z;

    for (const slots of this.slots) {
      for (const b of slots) {
        const S = b.spec;
        if (b.active) {
          const d = Math.hypot(b.x - cx, b.z - cz);
          if (d > DESPAWN && b.state === P_PERCH) this._park(b);
          continue;
        }
        // The cooldown is what keeps the population breathing. A freed slot
        // that refills within seconds means exactly `live` eagles forever; a
        // slot that sometimes goes dormant for minutes means stretches of
        // valley with no eagle in them, which is what makes the next one land.
        if (b.cool > 0) { b.cool -= 0.8; continue; }
        if (this.rnd() > 0.3) continue;               // per-scan trickle
        const water = S.habitat === 'water';
        for (let attempt = 0; attempt < (water ? 6 : 4); attempt++) {
          // Flock species arrive where their kind already is: most of the
          // time a new flamingo joins the shallows that hold one, and the
          // valley gets a group on one lake instead of six scattered dots.
          let ax, az;
          const mate = S.flock ? this._flockmate(b) : null;
          const nearMate = !!mate && this.rnd() < 0.65;
          if (nearMate) {
            ax = mate.x + (this.rnd() - 0.5) * 36;
            az = mate.z + (this.rnd() - 0.5) * 36;
          } else {
            const a = this.rnd() * Math.PI * 2;
            const r = lerp(SPAWN_R[0], SPAWN_R[1], this.rnd());
            ax = cx + Math.sin(a) * r; az = cz + Math.cos(a) * r;
          }
          if (water) {
            // Island rim first, mainland waterline second — see _ensureIslands
            // for why the mainland alone was not enough. A colony species does
            // NOT fall through: its whole point is to be on its own islands and
            // nowhere else, so failing to find one is the answer, not a reason
            // to scatter it along the nearest bank.
            let site = null;
            if (nearMate) site = this._findWade(ax, az, S);
            if (!site) site = this._islandSite(cx, cz, SPAWN_R[0], SPAWN_R[1], S);
            if (!site && !S.colony) site = this._findWade(ax, az, S);
            if (!site) continue;
            _sphere.center.set(site.x, site.gy + 1, site.z);
            _sphere.radius = 3;
            const dist = Math.hypot(site.x - cx, site.z - cz);
            if (dist < VIS_OK && _frustum.intersectsSphere(_sphere)) continue;
            this._wadeAt(b, site, this.rnd() * Math.PI * 2);
            break;
          }
          const tree = this._findTree(T, ax, az, S.minTreeH, -1);
          if (tree < 0) continue;
          const py = this._perchY(T, tree);
          _sphere.center.set(T.px[tree], py, T.pz[tree]);
          _sphere.radius = 3;
          const dist = Math.hypot(T.px[tree] - cx, T.pz[tree] - cz);
          if (dist < VIS_OK && _frustum.intersectsSphere(_sphere)) continue;
          this._perchAt(b, T, tree, this.rnd() * Math.PI * 2);
          break;
        }
      }
    }
  }

  _park(b) {
    b.active = false;
    // Most departures come back soon; some leave the area for a long while.
    b.cool = this.rnd() < b.spec.chance ? 8 + this.rnd() * 25 : 90 + this.rnd() * 150;
    this._dummy.position.set(0, -9000, 0);
    this._dummy.rotation.set(0, 0, 0);
    this._dummy.scale.setScalar(0.0001);
    this._dummy.updateMatrix();
    b.mesh.setMatrixAt(b.i, this._dummy.matrix);
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The best perch tree near a point: tall wins, conifer wins harder (a spire
   * carries a silhouette; a rounded crown swallows it), with enough jitter
   * that the same grove does not elect the same tree every time.
   */
  _findTree(T, ax, az, minH, exclude) {
    const gx = clamp(((ax + T.half) / T.BS) | 0, 0, T.BW - 1);
    const gz = clamp(((az + T.half) / T.BS) | 0, 0, T.BW - 1);
    let best = -1, bestScore = 0;
    for (let j = -1; j <= 1; j++) {
      const zz = gz + j; if (zz < 0 || zz >= T.BW) continue;
      for (let i = -1; i <= 1; i++) {
        const xx = gx + i; if (xx < 0 || xx >= T.BW) continue;
        const bb = zz * T.BW + xx;
        for (let k = T.bucketStart[bb]; k < T.bucketStart[bb + 1]; k++) {
          const t = T.order[k];
          if (t === exclude) continue;
          const h = T.pImpH[t];
          if (h < minH) continue;
          const dx = T.px[t] - ax, dz = T.pz[t] - az;
          const score = h * (this._conifer[T.pspec[t]] ? 1.8 : 1.0)
            * (0.7 + 0.6 * this.rnd()) / (1 + (dx * dx + dz * dz) / 900);
          if (score > bestScore) { bestScore = score; best = t; }
        }
      }
    }
    return best;
  }

  _perchY(T, t) {
    // ON the tip, not in the crown. The first pass sat 12% down "against the
    // foliage", and the foliage won: a spruce crown is a solid cartoon mass
    // and it swallowed the bird whole — verified with a 25x debug eagle that
    // rendered perfectly while the life-size one was invisible. pImpH is the
    // baked silhouette top, so tip + a little stand-off for the feet.
    // pImpH is the baked silhouette top, and the drawn leader both sits a
    // little below it and LEANS — up to a metre off the trunk axis on a tall
    // spruce. The bird perches on the trunk axis, so it sits low enough that
    // the top whorl's boughs read as what it is standing on; at the tip
    // itself a leaning tree leaves it visibly floating in air.
    return T.py[t] + T.pImpH[t] - 1.35;
  }

  _perchAt(b, T, tree, yaw) {
    b.active = true;
    b.state = P_PERCH;
    b.tree = tree;
    b.x = T.px[tree]; b.z = T.pz[tree];
    b.y = this._perchY(T, tree);
    b.yaw = yaw;
    b.pitch = b.spec.perchPitch ?? PERCH_PITCH;
    b.bank = 0;
    b.fold = 1; b.amp = 0; b.spooked = 0;
    b.timer = lerp(b.spec.perchS[0], b.spec.perchS[1], this.rnd());
  }

  // ── island shores ─────────────────────────────────────────────────────────

  /**
   * Every shoreline point on an island in a lake, found once.
   *
   * This exists because the mainland waterline turned out to be a bad habitat
   * and a worse spawn source. The depth window a wader can stand in is narrow
   * and this terrain mostly goes from dry to over-depth inside a couple of
   * metres, so the standable fringe is a thin broken thread — measured on the
   * spawn lake, a 28 m square of standing water held exactly two cells a
   * flamingo would take. Birds did spawn, just rarely and nowhere anyone
   * drives. An island rim is the opposite: shallow the whole way round, open
   * water on every side, and it reads from clear across the lake. Which is
   * also simply where these birds are in life.
   *
   * Finding them is a flood fill on the hydro sdf, whose sign already asks the
   * right question (>= 0 is water). Land cells group into connected
   * components, and a component that never touches the map border is by
   * construction ringed by water — there is no separate "is it surrounded"
   * test to get wrong. Area and the openness of the water around it then
   * separate a lake island from a bog hummock or a bar in a creek.
   *
   * One pass over a 768² field, on the first scan that finds a bake in place
   * rather than in build(), where the hydro field may not exist yet.
   *
   * @returns {{list: Array, colony: Map}|null} null while the bake is missing
   */
  _ensureIslands() {
    if (this._islands) return this._islands;
    const W = this.ctx.world;
    const h = W?.hydro;
    if (!h?.sdf || !W.getHydro) return null;      // not baked yet — try next scan

    const R = h.res, T = h.texel, half = W.half;
    const N = R * R, sdf = h.sdf;
    const lab = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const kept = [];
    let id = 0;

    for (let s = 0; s < N; s++) {
      if (sdf[s] >= 0 || lab[s] !== -1) continue;
      let sp = 0, n = 0, border = false, sumx = 0, sumz = 0;
      let minc = R, maxc = -1, minr = R, maxr = -1;
      stack[sp++] = s; lab[s] = id;
      while (sp > 0) {
        const c = stack[--sp]; n++;
        const cx = c % R, cz = (c / R) | 0;
        if (cx === 0 || cz === 0 || cx === R - 1 || cz === R - 1) border = true;
        if (cx < minc) minc = cx;
        if (cx > maxc) maxc = cx;
        if (cz < minr) minr = cz;
        if (cz > maxr) maxr = cz;
        sumx += cx; sumz += cz;
        // Stepped one neighbour at a time with the edge guarded per side: a
        // flat c-1 / c+1 would wrap around the row ends and weld the east
        // shore to the west one into a single component that touches nothing.
        if (cx > 0) { const q = c - 1; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cx < R - 1) { const q = c + 1; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cz > 0) { const q = c - R; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
        if (cz < R - 1) { const q = c + R; if (sdf[q] < 0 && lab[q] === -1) { lab[q] = id; stack[sp++] = q; } }
      }
      const area = n * T * T;
      if (!border && area >= ISLAND_AREA[0] && area <= ISLAND_AREA[1]) {
        kept.push({
          id,
          x: (sumx / n + 0.25) * T - half,
          z: (sumz / n + 0.25) * T - half,
          rad: Math.max(maxc - minc + 1, maxr - minr + 1) * T * 0.5,
          open: 0, sites: [],
        });
      }
      id++;
    }

    // Is it in open water, and is it really an island? A component can clear
    // the border test and still be a hummock in a bog, so sample a ring just
    // outside it: most of that ring has to be water, and the water has to be
    // wide enough to read as a lake.
    const hy = {};
    const byId = new Map();
    for (const isl of kept) {
      let wet = 0, tries = 0, open = 0;
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        const rr = isl.rad + 12;
        const x = isl.x + Math.sin(th) * rr, z = isl.z + Math.cos(th) * rr;
        if (!W.isInBounds(x, z)) continue;
        tries++;
        const q = W.getHydro(x, z, hy);
        if (q.sdf > 0) wet++;
        if (q.span > open) open = q.span;
      }
      if (!tries || wet / tries < ISLAND_RING_WET || open < ISLAND_OPEN) continue;
      isl.open = open;
      byId.set(isl.id, isl);
    }

    // The shoreline: every water cell touching one of these islands. Taken
    // from the same field the components came from, so a site is on the rim
    // by construction rather than by a second search that could disagree.
    for (let c = 0; c < N; c++) {
      if (sdf[c] >= 0) continue;
      const isl = byId.get(lab[c]);
      if (!isl) continue;
      const cx = c % R, cz = (c / R) | 0;
      const nb = [
        cx > 0 ? c - 1 : -1, cx < R - 1 ? c + 1 : -1,
        cz > 0 ? c - R : -1, cz < R - 1 ? c + R : -1,
      ];
      for (const q of nb) {
        if (q < 0 || sdf[q] < 0) continue;
        isl.sites.push({ x: ((q % R) + 0.25) * T - half, z: (((q / R) | 0) + 0.25) * T - half });
      }
    }

    const list = [...byId.values()].filter((i) => i.sites.length >= 4);

    // Colony species get a FEW islands in the whole valley, not all of them.
    // A flamingo everywhere is scenery; a flamingo on two known islands is
    // somewhere to go — the same reasoning that makes a perched eagle a
    // landmark rather than a bird. Openness breaks the tie because a big
    // bright lake is where you would actually notice them.
    const colony = new Map();
    for (const S of TREE_BIRD_SPECIES) {
      if (!S.colony) continue;
      const ranked = list
        .map((isl, i) => ({ i, score: isl.open * (0.6 + 0.8 * this.rnd()) }))
        .filter(({ i }) => !S.minSpan || list[i].open >= S.minSpan)
        .sort((a, b) => b.score - a.score)
        .slice(0, S.colony)
        .map(({ i }) => i);
      colony.set(S.key, new Set(ranked));
    }

    this._islands = { list, colony };
    return this._islands;
  }

  /**
   * A shore site on an island whose distance from (cx, cz) lands in
   * [rmin, rmax]. Colony species are held to their own islands; everyone else
   * may use any of them.
   *
   * Depth is only capped, not floored: on a rim the difference between ankle
   * deep and standing on wet sand is a metre of shore, and a bird at the
   * water's edge is right either way. Flooring it here is what made the
   * mainland so barren.
   */
  _islandSite(cx, cz, rmin, rmax, S) {
    const I = this._ensureIslands();
    if (!I) return null;
    const allowed = I.colony.get(S.key);
    const W = this.ctx.world;

    let pick = null, seen = 0;
    for (let k = 0; k < I.list.length; k++) {
      if (allowed && !allowed.has(k)) continue;
      const isl = I.list[k];
      if (S.minSpan && isl.open < S.minSpan) continue;
      const d = Math.hypot(isl.x - cx, isl.z - cz);
      if (d + isl.rad < rmin || d - isl.rad > rmax) continue;
      seen++;
      if (this.rnd() < 1 / seen) pick = isl;      // reservoir: no bias to the first
    }
    if (!pick) return null;

    // A flock lands together. Without this the rim is long enough that six
    // flamingos spread themselves evenly round a 146 m island and read as six
    // separate birds rather than a flock — the same reason _scan biases new
    // arrivals toward a mate on the mainland.
    let near = null;
    if (S.flock) {
      const mate = this._settledOn(pick, S);
      if (mate && this.rnd() < 0.75) {
        near = pick.sites.filter((s) => Math.hypot(s.x - mate.x, s.z - mate.z) < 34);
        if (!near.length) near = null;
      }
    }
    const pool = near ?? pick.sites;

    for (let t = 0; t < 10; t++) {
      const s = pool[(this.rnd() * pool.length) | 0];
      // Jittered off the 4 m lattice the field is stored on, or a flock lines
      // up on a grid like fenceposts.
      const x = s.x + (this.rnd() - 0.5) * 3.2;
      const z = s.z + (this.rnd() - 0.5) * 3.2;
      if (!W.isInBounds(x, z)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d < rmin || d > rmax) continue;
      if (W.getWaterDepth(x, z) > S.wade[1]) continue;
      return { x, z, gy: W.getHeight(x, z), wy: W.getWaterHeight(x, z), island: pick };
    }
    return null;
  }

  // ── wading sites (habitat: 'water') ───────────────────────────────────────

  /**
   * A wading site near (ax, az): standing water inside the species' depth
   * window, open enough if the species cares. Sampled, not searched — water is
   * a quarter of this map, so a handful of throws either lands in some or the
   * neighbourhood genuinely has none and the spawn attempt should fail.
   */
  _findWade(ax, az, S) {
    const W = this.ctx.world;
    if (!W?.getWaterContactDepth) return null;
    for (let k = 0; k < 10; k++) {
      const x = ax + (this.rnd() - 0.5) * 36;
      const z = az + (this.rnd() - 0.5) * 36;
      if (!W.isInBounds(x, z)) continue;
      // Two queries, each for what it is honest about. The hydro sdf gates
      // OUT the phantoms — the raw grid keeps water in speck cells the drawn
      // mesh deliberately drops, and a bird wading in one stands in dry
      // meadow (shipped once, shots/waders/heron-wade.png). The DEPTH is
      // getWaterDepth, which reads the drawn surface's own field: hydro depth
      // is reconstructed as 0.60 x sdf near the waterline, and testing
      // against that put a heron chest-deep in honest-to-goodness water.
      const h = W.getHydro(x, z, this._hy ??= {});
      if (h.sdf < 1.2 || h.wet < 0.5) continue;
      const d = W.getWaterDepth(x, z);
      if (d < S.wade[0] || d > S.wade[1]) continue;
      if (S.minSpan && h.span < S.minSpan) continue;
      return { x, z, gy: W.getHeight(x, z), wy: W.getWaterHeight(x, z) };
    }
    return null;
  }

  /**
   * The standing height: feet on the bed, body up the leg length — but never
   * so deep the belly ships water. The depth window should make the clamp a
   * no-op; it exists because two derivations of "how deep is it here" have
   * already disagreed once each.
   */
  _wadeY(site, S, sc) {
    let y = site.gy - S.footY * sc;
    if (site.wy != null) y = Math.max(y, site.wy + 0.07 * sc);
    return y;
  }

  /** Stand a wader in the shallows: feet on the bed, body up the leg length. */
  _wadeAt(b, site, yaw) {
    b.active = true;
    b.state = P_PERCH;
    b.tree = -1;
    b.x = site.x; b.z = site.z;
    b.y = this._wadeY(site, b.spec, b.sc);
    b.yaw = yaw;
    b.pitch = b.spec.perchPitch ?? PERCH_PITCH;
    b.bank = 0;
    b.fold = 1; b.amp = 0; b.spooked = 0;
    b.timer = lerp(b.spec.perchS[0], b.spec.perchS[1], this.rnd());
  }

  /** A settled bird of species S standing on island `isl`, or null. */
  _settledOn(isl, S) {
    for (const slots of this.slots) {
      if (slots[0]?.spec !== S) continue;
      for (const o of slots) {
        if (!o.active || o.state !== P_PERCH) continue;
        if (Math.hypot(o.x - isl.x, o.z - isl.z) <= isl.rad + 20) return o;
      }
    }
    return null;
  }

  /** A random other settled bird of the same species, or null. */
  _flockmate(b) {
    let pick = null, n = 0;
    for (const slots of this.slots) {
      if (slots[0]?.spec !== b.spec) continue;
      for (const o of slots) {
        if (o === b || !o.active || o.state !== P_PERCH) continue;
        n++;
        if (this.rnd() < 1 / n) pick = o;
      }
    }
    return pick;
  }

  /**
   * Set up the flight state for a hop to (tx, ty, tz). The path is a bowed
   * line, not a bee-line: the control point swings it to one side so the bird
   * banks through a real turn.
   */
  _flightTo(b, tx, ty, tz, d) {
    const S = b.spec;
    b.fx0 = b.x; b.fy0 = b.y; b.fz0 = b.z;
    b.fx1 = tx; b.fy1 = ty; b.fz1 = tz;
    const side = this.rnd() < 0.5 ? -1 : 1;
    const nx = -(tz - b.z) / d, nz = (tx - b.x) / d;
    b.fcx = (b.x + tx) * 0.5 + nx * side * d * (0.12 + this.rnd() * 0.16);
    b.fcz = (b.z + tz) * 0.5 + nz * side * d * (0.12 + this.rnd() * 0.16);
    const up = S.cruiseUp ?? [4, 11];
    b.fcruise = Math.max(b.fy0, b.fy1) + lerp(up[0], up[1], this.rnd());
    b.fspeed = lerp(S.cruise[0], S.cruise[1], this.rnd());
    b.fdur = Math.max(2.5, d * 1.08 / b.fspeed);
    b.ft = 0;
    b.state = P_FLY;
    b.rate = lerp(S.flapHz[0], S.flapHz[1], this.rnd());
    b.bout = this.rnd() * 6.28;
    this.stats.flights++;
  }

  /** Launch a flight from the current perch to a site in an annulus around it. */
  _launch(b, awayX = 0, awayZ = 0) {
    const S = b.spec;
    if (S.habitat === 'water') return this._launchWade(b, awayX, awayZ);
    const T = this.ctx.systems?.trees?.trees;
    if (!T) { b.timer = 8; return false; }
    for (let attempt = 0; attempt < 5; attempt++) {
      let a = this.rnd() * Math.PI * 2;
      // Flushed birds leave away from the threat; wandering birds don't care.
      if (awayX || awayZ) a = Math.atan2(b.x - awayX, b.z - awayZ) + (this.rnd() - 0.5) * 1.6;
      const r = lerp(S.hop[0], S.hop[1], this.rnd());
      const tree = this._findTree(T, b.x + Math.sin(a) * r, b.z + Math.cos(a) * r, S.minTreeH, b.tree);
      if (tree < 0) continue;
      const tx = T.px[tree], tz = T.pz[tree], ty = this._perchY(T, tree);
      const d = Math.hypot(tx - b.x, tz - b.z);
      if (d < 14) continue;                        // hopping one crown over reads as a glitch
      this._flightTo(b, tx, ty, tz, d);
      b.tree = tree;
      return true;
    }
    b.timer = 8;
    return false;
  }

  /** The wader version: the next stand of shallows, biased toward the flock. */
  _launchWade(b, awayX = 0, awayZ = 0) {
    const S = b.spec;
    for (let attempt = 0; attempt < 6; attempt++) {
      let ax, az;
      const mate = (!awayX && !awayZ && S.flock) ? this._flockmate(b) : null;
      if (mate && this.rnd() < 0.5) {
        ax = mate.x + (this.rnd() - 0.5) * 30;
        az = mate.z + (this.rnd() - 0.5) * 30;
      } else {
        let a = this.rnd() * Math.PI * 2;
        if (awayX || awayZ) a = Math.atan2(b.x - awayX, b.z - awayZ) + (this.rnd() - 0.5) * 1.6;
        const r = lerp(S.hop[0], S.hop[1], this.rnd());
        ax = b.x + Math.sin(a) * r; az = b.z + Math.cos(a) * r;
      }
      // Hops stay on the island rims too, so a colony bird works its way round
      // its own island instead of leaving for a bank it can never spawn on.
      // 14 m, not S.hop[0]: a hop between rim points is bounded by the island,
      // and on a small one every point is inside the species' normal hop
      // minimum — hold it to that and a colony bird can never move at all.
      let site = (!awayX && !awayZ) || S.colony
        ? this._islandSite(b.x, b.z, 14, S.hop[1], S) : null;
      if (!site && !S.colony) site = this._findWade(ax, az, S);
      if (!site) continue;
      const ty = this._wadeY(site, S, b.sc);
      const d = Math.hypot(site.x - b.x, site.z - b.z);
      if (d < 12) continue;                        // shuffling one pool over reads as a glitch
      this._flightTo(b, site.x, ty, site.z, d);
      b.tree = -1;
      return true;
    }
    b.timer = 8;
    return false;
  }

  _step(b, dt, threat) {
    const S = b.spec;
    if (b.state === P_PERCH) {
      b.timer -= dt;
      b.fold = damp(b.fold, 1, 5, dt);
      b.amp = damp(b.amp, 0, 6, dt);
      b.pitch = damp(b.pitch, S.perchPitch ?? PERCH_PITCH, 4, dt);
      b.bank = damp(b.bank, 0, 4, dt);
      // Holding its nerve. `startleDelay` is how long a threat has to stay
      // inside `startle` before the bird gives up on it — without it a bird
      // flushes on the frame you arrive, which means the only flamingo anyone
      // ever sees is one already leaving. The count decays at twice the rate
      // it builds, so driving past does not bank credit toward a later flush,
      // but a bird you have already crowded stays jumpy for a moment.
      const pressed = threat && Math.abs(threat.speed) > 4
        && Math.hypot(threat.x - b.x, threat.z - b.z) < S.startle;
      if (pressed) b.spooked += dt;
      else b.spooked = Math.max(0, b.spooked - dt * 2);
      if (pressed && b.spooked >= (S.startleDelay ?? 0)) {
        this._launch(b, threat.x, threat.z);
      } else if (b.timer <= 0) {
        this._launch(b);
      }
      return;
    }

    // ── flight ────────────────────────────────────────────────────────────
    const W = this.ctx.world;
    b.ft += dt / b.fdur;
    const t = clamp01(b.ft);

    // Horizontal: quadratic bezier through the bowed control point.
    const u = 1 - t;
    const x = u * u * b.fx0 + 2 * u * t * b.fcx + t * t * b.fx1;
    const z = u * u * b.fz0 + 2 * u * t * b.fcz + t * t * b.fz1;
    // Vertical: climb off the perch to cruise, hold, descend onto the new
    // one — with a takeoff dip, because an eagle leaves a treetop by falling
    // onto its wings, and that drop is the most recognisable part of the move.
    let y = lerp(b.fy0, b.fcruise, smoothstep(0.04, 0.42, t));
    y = lerp(y, b.fy1, smoothstep(0.60, 0.97, t));
    y -= (S.dip ?? 1.7) * Math.sin(clamp01(t / 0.16) * Math.PI) * clamp01(1 - t * 2);
    // Terrain clearance, windowed to mid-flight: at the endpoints the bird is
    // ON its perch, and a wader's perch is half a metre over the water — the
    // old flat +8 clamp would snatch it into the air the frame it launched.
    if (W.isInBounds(x, z)) {
      const mid = smoothstep(0.05, 0.30, t) * (1 - smoothstep(0.70, 0.95, t));
      y = Math.max(y, W.getHeight(x, z) + lerp(0.35, 8, mid));
    }

    // Heading from the bezier tangent; pitch from the actual climb.
    const dxdt = 2 * u * (b.fcx - b.fx0) + 2 * t * (b.fx1 - b.fcx);
    const dzdt = 2 * u * (b.fcz - b.fz0) + 2 * t * (b.fz1 - b.fcz);
    const wantYaw = Math.atan2(dxdt, dzdt);
    const prevYaw = b.yaw;
    b.yaw = dampAngle(b.yaw, wantYaw, 6, dt);
    const yawRate = (b.yaw - prevYaw) / Math.max(dt, 1e-3);
    b.bank = damp(b.bank, clamp(yawRate * 0.55, -0.8, 0.8), 5, dt);
    const vy = (y - b.y) / Math.max(dt, 1e-3);
    const flare = smoothstep(0.85, 1.0, t);
    const wantPitch = clamp(-Math.atan2(vy, b.fspeed) * 0.8, -0.55, 0.55) - flare * 0.45;
    b.pitch = damp(b.pitch, wantPitch, 6, dt);

    // Wings: open immediately, flap through the climb, then bouts of glide —
    // the flap-flap-glide rhythm is the other half of reading "eagle".
    b.fold = damp(b.fold, 0, 8, dt);
    let wantAmp;
    if (t < 0.32) wantAmp = lerp(S.flapAmp[0], S.flapAmp[1], 0.8);
    else if (flare > 0) wantAmp = lerp(b.amp, 0.9, flare);
    else {
      const gate = Math.sin(this._time * 0.85 + b.bout);
      wantAmp = gate > 0.15 ? S.flapAmp[0] : 0.05;
    }
    b.amp = damp(b.amp, wantAmp, 4, dt);

    b.x = x; b.y = y; b.z = z;

    if (b.ft >= 1) {
      // Touch down exactly on the perch; the flare got the pose close enough
      // that the snap is invisible.
      b.x = b.fx1; b.y = b.fy1; b.z = b.fz1;
      b.state = P_PERCH;
      b.timer = lerp(S.perchS[0], S.perchS[1], this.rnd());
    }
  }

  _pose(b, mesh) {
    const D = this._dummy, E = this._e;
    D.position.set(b.x, b.y, b.z);
    E.set(b.pitch, b.yaw, b.bank);
    D.quaternion.setFromEuler(E);
    D.scale.setScalar(b.sc);
    D.updateMatrix();
    mesh.setMatrixAt(b.i, D.matrix);
    const p = mesh.userData.pose.array;
    p[b.i * 4] = b.phase;
    p[b.i * 4 + 1] = b.rate;
    p[b.i * 4 + 2] = b.amp;
    p[b.i * 4 + 3] = b.fold;
  }

  // ── debug hooks (capture harnesses) ───────────────────────────────────────

  /** Positions and states of every live bird. */
  debugList() {
    const out = [];
    for (const slots of this.slots) {
      for (const b of slots) {
        if (b.active) out.push({ key: b.spec.key, x: b.x, y: b.y, z: b.z, state: b.state, t: b.ft });
      }
    }
    return out;
  }

  /** Force the perched bird nearest (x, z) into the air. */
  debugFly(x, z) {
    let best = null, bd = 1e9;
    for (const slots of this.slots) {
      for (const b of slots) {
        if (!b.active || b.state !== P_PERCH) continue;
        const d = Math.hypot(b.x - x, b.z - z);
        if (d < bd) { bd = d; best = b; }
      }
    }
    if (best) this._launch(best);
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  /**
   * Perch a bird of `key` (default: the first species) on the best site near
   * (x, z) right now, view guard skipped. Trees for the tree birds, shallows
   * for the waders.
   */
  debugPerchNear(x, z, key) {
    const si = key ? TREE_BIRD_SPECIES.findIndex((s) => s.key === key) : 0;
    if (si < 0) return null;
    const slots = this.slots[si];
    const b = slots.find((s) => !s.active) ?? slots[0];
    const S = b.spec;
    if (S.habitat === 'water') {
      const site = this._findWade(x, z, S);
      if (!site) return null;
      this._wadeAt(b, site, this.rnd() * Math.PI * 2);
      return { x: b.x, y: b.y, z: b.z };
    }
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return null;
    const tree = this._findTree(T, x, z, S.minTreeH, -1);
    if (tree < 0) return null;
    this._perchAt(b, T, tree, this.rnd() * Math.PI * 2);
    return { x: b.x, y: b.y, z: b.z };
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
    this.mat.dispose();
  }
}

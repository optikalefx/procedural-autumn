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
//  The species table is a table because the eagle is not meant to stay alone:
//  an owl, a heron, a red-tail are each "a geometry builder plus a row of
//  numbers" away. The behaviour (perch high → pick a tree in an area at
//  random → fly to it → perch) is shared machinery.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, mulberry32 } from '../core/MathUtils.js';
import { SPECIES as TREE_SPECIES } from '../vegetation/tree_species.js';

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

  // ── body: a loft through six stations, tail root to forehead ──────────────
  // Stations: z, half-width, half-depth, centre height, colour. The neck-up
  // stations are white — the head/neck boundary is the one line that says
  // "bald eagle" at forty metres, so it lives in the geometry, not a texture.
  const ST = [
    [-0.150, 0.017, 0.019, 0.034, C_BODY],
    [-0.062, 0.041, 0.047, 0.024, C_BODY],
    [ 0.028, 0.047, 0.053, 0.030, C_BODY],
    [ 0.092, 0.033, 0.037, 0.050, C_HEAD],
    [ 0.148, 0.027, 0.029, 0.060, C_HEAD],
    [ 0.184, 0.015, 0.016, 0.054, C_HEAD],
  ];
  const RING = 8;
  const ring = (s) => {
    const pts = [];
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      pts.push([Math.cos(a) * s[1], s[3] + Math.sin(a) * s[2], s[0]]);
    }
    return pts;
  };
  const rings = ST.map(ring);
  for (let i = 0; i < ST.length - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      // Countershade: the belly a stop lighter than the back, so the bird has
      // internal value range before light touches it (same trick as birds.js).
      const sA = Math.sin((k / RING) * Math.PI * 2);
      const sB = Math.sin((k2 / RING) * Math.PI * 2);
      const mA = 1 - sA * 0.10 + clamp01(-sA) * 0.14;
      const mB = 1 - sB * 0.10 + clamp01(-sB) * 0.14;
      tri(r0[k], r0[k2], r1[k2], 0, ST[i][4], ST[i][4], ST[i + 1][4], mA, mB, mB);
      tri(r0[k], r1[k2], r1[k], 0, ST[i][4], ST[i + 1][4], ST[i + 1][4], mA, mB, mA);
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
  // gull" in silhouette. Chord is split leading/mid/trailing so the colour can
  // step covert → wing → secondary across it.
  const SPAN = [
    // x,     LE z,   TE z,    y
    [0.046, 0.112, -0.068, 0.030],
    [0.150, 0.118, -0.082, 0.040],
    [0.270, 0.108, -0.070, 0.046],
    [0.370, 0.088, -0.048, 0.050],
    [0.446, 0.062, -0.018, 0.052],
  ];
  const wingW = (x) => 0.12 + 0.88 * clamp01((x - 0.046) / 0.40);
  for (const s of [1, -1]) {
    for (let i = 0; i < SPAN.length - 1; i++) {
      const [x0, le0, te0, y0] = SPAN[i];
      const [x1, le1, te1, y1] = SPAN[i + 1];
      const m0 = lerp(le0, te0, 0.42), m1 = lerp(le1, te1, 0.42);
      const w0 = s * wingW(x0), w1 = s * wingW(x1);
      const camber = 0.008;
      tri([s * x0, y0, le0], [s * x1, y1, le1], [s * x1, y1 + camber, m1], [w0, w1, w1], C_COVERT, C_COVERT, C_WING);
      tri([s * x0, y0, le0], [s * x1, y1 + camber, m1], [s * x0, y0 + camber, m0], [w0, w1, w0], C_COVERT, C_WING, C_WING);
      tri([s * x0, y0 + camber, m0], [s * x1, y1 + camber, m1], [s * x1, y1, te1], [w0, w1, w1], C_WING, C_WING, C_WING, 1, 1, 0.9);
      tri([s * x0, y0 + camber, m0], [s * x1, y1, te1], [s * x0, y0, te0], [w0, w1, w0], C_WING, C_WING, C_WING, 1, 0.9, 0.9);
    }
    // Slotted primaries: five fingers off the tip station, progressively swept
    // back, tips curling up the way a soaring eagle's do.
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
      const tipX = xt + dx * len, tipZ = bz + dz * len;
      const hw = 0.013;
      quad(
        [s * xt, yt, bz + hw],
        [s * xt, yt, bz - hw],
        [s * tipX, yt + 0.022, tipZ - hw * 0.5],
        [s * tipX, yt + 0.022, tipZ + hw * 0.5],
        s * 1.0, C_PRIM, C_PRIM, 1, 0.88,
      );
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
  const pose = opts.pose ?? opts.colorway ?? 'glide';
  const geo = buildBaldEagleGeometry();
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 4);
  const perched = pose === 'perched';
  for (let i = 0; i < n; i++) {
    arr[i * 4] = 0.7;                       // phase → wings a touch raised
    arr[i * 4 + 1] = 0.0;                   // rate 0: frozen for the thumbnail
    arr[i * 4 + 2] = perched ? 0.0 : 0.55;
    arr[i * 4 + 3] = perched ? 1.0 : 0.0;
  }
  geo.setAttribute('aPose', new THREE.Float32BufferAttribute(arr, 4));
  const mesh = new THREE.Mesh(geo, treeBirdMaterial({ time: { value: 0 } }));
  mesh.scale.setScalar(2.05);
  if (perched) { mesh.rotation.x = -0.85; mesh.position.y = 0.9; }
  else mesh.position.y = 1.2;
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
//   wingspan  metres; scale IS wingspan (geometry span is 1.0)
//   perchS    seconds on a perch before moving on
//   hop       metres to the next tree, picked at random in that annulus
//   cruise    m/s in level flight
//   flapHz    wingbeat — a bald eagle is a SLOW flapper, and the slowness is
//             most of what distinguishes it from the corvid flocks overhead
//   minTreeH  metres; only mature trees hold a two-metre bird
//   startle   metres; a vehicle closer than this flushes a perched bird
export const TREE_BIRD_SPECIES = [
  {
    key: 'baldEagle',
    geometry: buildBaldEagleGeometry,
    live: 4,
    chance: 0.65,
    wingspan: [1.85, 2.25],
    perchS: [24, 75],
    hop: [55, 150],
    cruise: [11.0, 15.0],
    flapHz: [2.2, 2.8],
    flapAmp: [0.72, 0.95],
    minTreeH: 11,
    startle: 26,
  },
];

// Streaming ring. Spawn perched birds far enough out that materialising is
// invisible, keep them until well past that, and never place one inside the
// view cone unless it is beyond VIS_OK (where a folded eagle is ~4 px).
const SPAWN_R = [85, 190];
const DESPAWN = 280;
const VIS_OK = 150;

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
        for (let attempt = 0; attempt < 4; attempt++) {
          const a = this.rnd() * Math.PI * 2;
          const r = lerp(SPAWN_R[0], SPAWN_R[1], this.rnd());
          const ax = cx + Math.sin(a) * r, az = cz + Math.cos(a) * r;
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
    b.pitch = PERCH_PITCH;
    b.bank = 0;
    b.fold = 1; b.amp = 0;
    b.timer = lerp(b.spec.perchS[0], b.spec.perchS[1], this.rnd());
  }

  /** Launch a flight from the current perch to a tree in an annulus around it. */
  _launch(b, awayX = 0, awayZ = 0) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) { b.timer = 8; return false; }
    const S = b.spec;
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
      b.fx0 = b.x; b.fy0 = b.y; b.fz0 = b.z;
      b.fx1 = tx; b.fy1 = ty; b.fz1 = tz;
      // A bowed line, not a bee-line: the control point swings the path to one
      // side so the bird banks through a real turn.
      const side = this.rnd() < 0.5 ? -1 : 1;
      const nx = -(tz - b.z) / d, nz = (tx - b.x) / d;
      b.fcx = (b.x + tx) * 0.5 + nx * side * d * (0.12 + this.rnd() * 0.16);
      b.fcz = (b.z + tz) * 0.5 + nz * side * d * (0.12 + this.rnd() * 0.16);
      b.fcruise = Math.max(b.fy0, b.fy1) + 4 + this.rnd() * 7;
      b.fspeed = lerp(S.cruise[0], S.cruise[1], this.rnd());
      b.fdur = Math.max(2.5, d * 1.08 / b.fspeed);
      b.ft = 0;
      b.tree = tree;
      b.state = P_FLY;
      b.rate = lerp(S.flapHz[0], S.flapHz[1], this.rnd());
      b.bout = this.rnd() * 6.28;
      this.stats.flights++;
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
      b.pitch = damp(b.pitch, PERCH_PITCH, 4, dt);
      b.bank = damp(b.bank, 0, 4, dt);
      if (threat && Math.abs(threat.speed) > 4
        && Math.hypot(threat.x - b.x, threat.z - b.z) < S.startle) {
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
    y -= 1.7 * Math.sin(clamp01(t / 0.16) * Math.PI) * clamp01(1 - t * 2);
    if (W.isInBounds(x, z)) y = Math.max(y, W.getHeight(x, z) + 8);

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

  /** Perch a bird on the best tree near (x, z) right now, view guard skipped. */
  debugPerchNear(x, z) {
    const T = this.ctx.systems?.trees?.trees;
    if (!T) return null;
    const b = this.slots[0].find((s) => !s.active) ?? this.slots[0][0];
    const tree = this._findTree(T, x, z, b.spec.minTreeH, -1);
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

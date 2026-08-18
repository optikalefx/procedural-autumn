// ─────────────────────────────────────────────────────────────────────────────
//  animal_rig — the geometry + skeleton layer every animal is built from.
//
//  Why a real SkinnedMesh rather than a bag of parented boxes:
//    · one draw call per animal instead of ~25, which is the only way the whole
//      cast fits inside the 60-call wildlife budget
//    · rotating a bone is the entire animation API, so the gait solver never
//      has to think about geometry
//    · Three gives us skinned shadow casting and skinned depth for free
//
//  Everything is authored in *bind-pose model space*: +Z forward, +Y up, origin
//  on the ground between the feet. Every bone is created with identity rotation
//  at its model-space position, so a bone's local rotation means exactly "rotate
//  this joint", which is what makes the animation code below readable. It also
//  means each bone's inverse-bind matrix is a pure translation, so we can write
//  it down instead of computing it from a world-matrix pass.
//
//  Skin weights are *rigid with a seam blend*: a vertex belongs entirely to one
//  bone except in a narrow band either side of a joint, where it splits 50/50.
//  Smooth skinning would round off the joints; the reference art wants faceted,
//  slightly carved forms, and rigid binding keeps the silhouette crisp.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

// Colour-region mix channels. A vertex carries a weight for each, and the hide
// shader resolves them against four per-animal uniforms. Blending in the
// attribute (rather than branching on an ID in the fragment shader) is what
// gives the rump patch and the muzzle band their soft painted edges.
export const MIX = {
  coat: [1, 0, 0, 0],   // main hide
  pale: [0, 1, 0, 0],   // belly, rump patch, chin, muzzle band
  dark: [0, 0, 1, 0],   // lower legs, hooves, nose, ear rims
  horn: [0, 0, 0, 1],   // antler, claw
};
export const mixLerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t,
];

// ── skeleton description ─────────────────────────────────────────────────────

/**
 * Collects a bone hierarchy as flat data. Nothing here is a THREE object — the
 * prototype stores the description, and each spawned animal instantiates its
 * own Bone objects from it, so animals never share a pose.
 */
export class Skel {
  constructor() {
    this.bones = [];      // { name, parent, x, y, z }  (model space)
    this.map = {};        // name -> index
  }

  add(name, parent, x, y, z) {
    const i = this.bones.length;
    this.bones.push({ name, parent: parent == null ? -1 : this.map[parent], x, y, z });
    this.map[name] = i;
    return i;
  }

  /**
   * Same, but the position is an offset from the parent. Spines are natural to
   * author in absolute model space; ears, antlers and limb joints are natural
   * to author as "this far along from the joint above".
   */
  addRel(name, parent, dx, dy, dz) {
    const p = this.bones[this.map[parent]];
    return this.add(name, parent, p.x + dx, p.y + dy, p.z + dz);
  }

  /** Model-space position of a bone, into `out`. */
  at(name, out = new THREE.Vector3()) {
    const b = this.bones[this.map[name]];
    return out.set(b.x, b.y, b.z);
  }

  idx(name) { return this.map[name]; }

  /** Straight-line length between two bones — used for limb-segment maths. */
  span(a, b) {
    const p = this.bones[this.map[a]], q = this.bones[this.map[b]];
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  }
}

// ── geometry builder ─────────────────────────────────────────────────────────

const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _u = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Accumulates a skinned mesh as plain arrays. `aMix` carries the colour-region
 * weights, `aShade` a baked form-shading term (dark under the belly and inside
 * the legs) — cheap painted volume that costs no shader work and survives the
 * flat, near-cel-shaded global lighting, which by design does very little
 * shaping of its own.
 */
export class RigBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.mix = []; this.shade = [];
    this.si = []; this.sw = []; this.index = [];
  }

  get count() { return this.pos.length / 3; }

  vert(x, y, z, nx, ny, nz, mix, shade, b0, w0 = 1, b1 = 0, w1 = 0) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.mix.push(mix[0], mix[1], mix[2], mix[3]);
    this.shade.push(shade);
    this.si.push(b0, b1, 0, 0);
    this.sw.push(w0, w1, 0, 0);
    return this.count - 1;
  }

  tri(a, b, c) { this.index.push(a, b, c); }
  quad(a, b, c, d) { this.index.push(a, b, c, a, c, d); }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aMix', new THREE.Float32BufferAttribute(this.mix, 4));
    g.setAttribute('aShade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.index);
    return g;
  }
}

/**
 * Loft a closed tube through a list of stations. This one primitive builds
 * every part of every animal: barrel, neck, muzzle, limb segment, ear, antler
 * tine. Cross-sections are (super)ellipses so a bear's barrel can be squarer
 * than a deer's without a second code path.
 *
 * station: { x, y, z, rx, ry, bone, bone2?, w2?, mix?, shade?, k? }
 *   rx/ry  half-width (local X) / half-height (local Y) of the cross-section
 *   bone   bone index this ring binds to; bone2/w2 split the weight at a joint
 *   k      superellipse exponent, 1 = ellipse, <1 = boxier
 *
 * opts: { radial, capStart, capEnd, tipStart, tipEnd, mix, shade, ao }
 *   tipX collapses that end to a single point (muzzles, hooves, antler tips)
 *   ao   how much the downward-facing side of the tube is darkened
 */
export function tube(B, stations, opts = {}) {
  const R = opts.radial ?? 6;
  const N = stations.length;
  const defMix = opts.mix ?? MIX.coat;
  const defShade = opts.shade ?? 1;
  const ao = opts.ao ?? 0.35;

  // Tangents, then a parallel-transported frame so long bends do not twist.
  const T = [], S = [], U = [];
  for (let i = 0; i < N; i++) {
    const a = stations[Math.max(0, i - 1)], b = stations[Math.min(N - 1, i + 1)];
    _t.set(b.x - a.x, b.y - a.y, b.z - a.z);
    if (_t.lengthSq() < 1e-10) _t.set(0, 1, 0);
    T.push(_t.clone().normalize());
  }
  // Seed the frame with whichever world axis is least parallel to the tangent.
  _u.copy(Math.abs(T[0].y) < 0.85 ? _s.set(0, 1, 0) : _s.set(0, 0, 1));
  _s.copy(_u).cross(T[0]).normalize();
  S.push(_s.clone());
  U.push(_n.copy(T[0]).cross(S[0]).normalize().clone());
  for (let i = 1; i < N; i++) {
    _s.copy(S[i - 1]).addScaledVector(T[i], -S[i - 1].dot(T[i]));
    if (_s.lengthSq() < 1e-8) _s.set(1, 0, 0);
    _s.normalize();
    S.push(_s.clone());
    U.push(_n.copy(T[i]).cross(_s).normalize().clone());
  }

  const rings = [];
  for (let i = 0; i < N; i++) {
    const st = stations[i];
    const k = st.k ?? opts.k ?? 1;
    const mix = st.mix ?? defMix;
    const shade = st.shade ?? defShade;
    const b0 = st.bone, b1 = st.bone2 ?? 0, w2 = st.w2 ?? 0;
    const ring = [];
    for (let j = 0; j < R; j++) {
      const a = (j / R) * Math.PI * 2;
      let ca = Math.cos(a), sa = Math.sin(a);
      if (k !== 1) {
        ca = Math.sign(ca) * Math.pow(Math.abs(ca), k);
        sa = Math.sign(sa) * Math.pow(Math.abs(sa), k);
      }
      _p.copy(S[i]).multiplyScalar(ca * st.rx).addScaledVector(U[i], sa * st.ry);
      // Ellipse normal, not the offset direction — matters where rx >> ry.
      _n.copy(S[i]).multiplyScalar(ca / Math.max(st.rx, 1e-4))
        .addScaledVector(U[i], sa / Math.max(st.ry, 1e-4)).normalize();
      // Bake form shading: whatever faces down sits in its own occlusion.
      const sh = shade * (1 - ao * Math.max(0, -_n.y) * 0.9 - ao * 0.25 * Math.max(0, -_n.y * 0.5));
      ring.push(B.vert(
        st.x + _p.x, st.y + _p.y, st.z + _p.z,
        _n.x, _n.y, _n.z, mix, sh, b0, 1 - w2, b1, w2,
      ));
    }
    rings.push(ring);
  }

  for (let i = 0; i < N - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < R; j++) {
      const j2 = (j + 1) % R;
      B.quad(a[j], a[j2], b[j2], b[j]);
    }
  }

  const cap = (i, dir) => {
    const st = stations[i], ring = rings[i];
    const mix = st.mix ?? defMix, shade = st.shade ?? defShade;
    const tip = dir > 0 ? opts.tipEnd : opts.tipStart;
    const off = tip ? Math.max(st.rx, st.ry) * 0.85 : 0;
    const c = B.vert(
      st.x + T[i].x * off * dir, st.y + T[i].y * off * dir, st.z + T[i].z * off * dir,
      T[i].x * dir, T[i].y * dir, T[i].z * dir, mix, shade * (tip ? 0.94 : 1),
      st.bone, 1 - (st.w2 ?? 0), st.bone2 ?? 0, st.w2 ?? 0,
    );
    for (let j = 0; j < R; j++) {
      const j2 = (j + 1) % R;
      if (dir > 0) B.tri(ring[j], ring[j2], c);
      else B.tri(ring[j2], ring[j], c);
    }
  };
  if (opts.capStart !== false) cap(0, -1);
  if (opts.capEnd !== false) cap(N - 1, 1);
}

// ── instantiation ────────────────────────────────────────────────────────────

/**
 * Build a prototype: the skeleton description, one geometry per LOD, and the
 * inverse-bind matrices. Shared by every animal of this species-variant.
 */
export function makePrototype(skel, geoms, extra = {}) {
  const boneInverses = skel.bones.map((b) =>
    new THREE.Matrix4().makeTranslation(-b.x, -b.y, -b.z));
  return { skel, geoms, boneInverses, ...extra };
}

/**
 * Spawn a live SkinnedMesh from a prototype. Bones are rebuilt per animal (30
 * Object3D allocations at spawn, none afterwards) so poses are independent
 * while geometry and inverse-bind matrices stay shared.
 */
export function instantiate(proto, material, lod = 0) {
  const bones = [];
  const byName = {};
  for (const d of proto.skel.bones) {
    const b = new THREE.Bone();
    b.name = d.name;
    if (d.parent >= 0) {
      const p = proto.skel.bones[d.parent];
      b.position.set(d.x - p.x, d.y - p.y, d.z - p.z);
      bones[d.parent].add(b);
    } else {
      b.position.set(d.x, d.y, d.z);
    }
    bones.push(b);
    byName[d.name] = b;
  }

  const skeleton = new THREE.Skeleton(bones, proto.boneInverses);
  const mesh = new THREE.SkinnedMesh(proto.geoms[lod], material);
  mesh.add(bones[0]);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The bind-pose bounding sphere would clip a bounding animal in half; the
  // prototype supplies one sized for the widest pose the gait can reach.
  mesh.frustumCulled = true;

  return { mesh, skeleton, bones, byName };
}

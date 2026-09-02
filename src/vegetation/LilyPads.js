// ─────────────────────────────────────────────────────────────────────────────
//  LilyPads — floating leaves on the still water near a shore.
//
//  Structure:
//    lily_forms.js            the pad shapes (silhouette)
//    lily_scatter.js          placement rules (composition) — pure, node-testable
//    shaders/lily_material    the instanced material (shading, bob, skirt)
//    this file                streaming, instancing, the SURFACE QUERY, and
//                             the boat push
//
//  Streaming is the Rocks / GroundCover pattern, because it is the right shape
//  and consistency beats novelty: a 64 m cell grid around the camera, cells
//  generated on a per-frame budget nearest first, one InstancedMesh per pad
//  variant, each instance carrying its own draw radius from its size, and a
//  repack every few metres of travel. Almost every cell in the map is dry and
//  costs one 5x5 hydro probe to reject; a lake-shore cell costs a few hundred
//  world queries.
//
//  ── the pads are SURFACES ────────────────────────────────────────────────────
//
//  A pad is not decoration; it is a place something can stand. So besides the
//  meshes this system publishes a query API that answers, for any point on
//  the water, whether there is a pad under it and exactly how high its surface
//  is THIS frame — including the bob the vertex shader is applying and the rim
//  curl of the variant's geometry. Everything the shader knows about a pad's
//  height is derived from the pad record and `elapsed`, on purpose, so the CPU
//  can evaluate the same function and a frog's feet land on the drawn leaf
//  rather than a metre from it:
//
//    padsNear(x, z, r, out)        every live pad whose LEAF is within r
//    padAt(x, z)                   the pad whose leaf covers (x, z), or null
//    padTop(pad, elapsed)          the height of the pad's flat middle
//    surfaceAt(x, z, elapsed)      the leaf surface under (x, z), or null
//    padCentre(pad, out)           where the leaf IS right now (see below)
//    ensureCell(x, z)              generate the cell synchronously (a frog
//                                  spawner asking about ground the streamer
//                                  has not reached yet)
//
//  Pads exist wherever the streamer has a cell — out to STREAM_RADIUS from the
//  camera — whether or not they are drawn. Draw distance is a picture question
//  and existence is a world question, and the frogs will ask the second one
//  from further away than the pad is visible.
//
//  ── the boat pushes the pads ─────────────────────────────────────────────────
//
//  A hull paddled through a colony shoves the leaves aside, and they drift back
//  toward their stems once it has gone. This is KINEMATIC, not rigid-body: the
//  boat is an analytic model with no Rapier body (boat_physics.js header), water
//  has no colliders, and a leaf on a stem is not a free body anyway — it SLIDES
//  along the surface, flat, and is pulled home by the stem.
//
//  Flat is the rule, and it was learned: the first cut tipped a leaf up against
//  the hull and dipped it, and from the paddler's seat that read as leaves
//  leaning INTO the water and clipping through the hull. Nothing here changes a
//  leaf's height or attitude any more. A pushed leaf is the same leaf, moved.
//
//  What does the pushing is the BOW WAVE, not the planking. Ahead of a moving
//  hull sits an invisible triangle — apex forward, its base a little wider than
//  the beam, longer the faster the boat goes — and a leaf inside it is slid
//  outward and forward along the wedge's edge. By the time the hull arrives the
//  leaf is already clear, which is what a real bow wave does to a real pad and
//  what makes the lane open AHEAD of the boat rather than leaves squirting out
//  from under it. The hull's own outline is still resolved, so a boat drifting
//  sideways, backing, or sitting still cannot end up on top of a leaf.
//
//  So a pad record carries its stem at (x, z) and, while disturbed, an offset
//  (ox, oz) with a velocity. Every frame, for every live hull: the pads whose
//  leaf overlaps the wedge or the hull are resolved fully OUT, given a shove
//  and a drag, and put in a small `_disturbed` set. Then the disturbed leaves
//  are separated from their neighbours — a leaf shoved sideways bumps the one
//  beside it, which bumps the next, so the hull opens a lane through a mat
//  rather than stacking leaves under itself. Never further apart than the two
//  rest at, so a mat that shingles at rest stays shingled and a colony does not
//  explode the moment one leaf is touched. The set is integrated as a damped
//  spring back to the stem and dropped when it has settled. Only those pads
//  have their instance matrices rewritten between repacks, and only their
//  slots are uploaded. Measured cost is in the tens of microseconds.
//
//  `padAt` / `surfaceAt` read the DISPLACED position, so a frog on a bumped pad
//  rides it. `pad.x, pad.z` stay the stem so a frog can find its pad again.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { System } from '../core/System.js';
import { SEED } from '../world/WorldConfig.js';
import { clamp } from '../core/MathUtils.js';
import { buildLilyLibrary, LILY_VARIANTS, padProfile } from './lily_forms.js';
import { LilyScatter } from './lily_scatter.js';
import { createLilyMaterial, LILY_LIFT, LILY_BOB } from '../shaders/lily_material.js';

const CELL = 64;                 // metres per scatter cell
const STREAM_RADIUS = 220;       // metres; > every pad's vis (150) + a cell reach
const CELL_REACH = CELL * Math.SQRT1_2;
const REPACK_MOVE = 10;          // metres of camera travel before a repack
const REFRESH_MOVE = 16;         // metres before the wanted set is recomputed
const BUILD_BUDGET_MS = 1.6;
// Per-variant instance capacity. A shore-hugging camera inside the biggest
// colonies sees a few thousand pads across four variants; nearest cells pack
// first, so an overflow drops the far ones.
const CAP = 3200;

// ── the push ─────────────────────────────────────────────────────────────────
// Spring back to the stem: k in 1/s², c in 1/s. Together they settle a metre
// of displacement in about three seconds with a single soft overshoot — a leaf
// drifting home, not a rubber band.
const PUSH_K = 1.6, PUSH_C = 2.0;
// How much of a hull's penetration becomes leaf velocity (1/s), and how much
// of the hull's forward speed a leaf in contact is dragged along by.
const PUSH_SHOVE = 4.0, PUSH_DRAG = 0.35;
const PUSH_MAX = 1.4;            // metres a leaf may be carried from its stem
// Clearance a leaf keeps from the hull wall, metres, beyond its own radius.
const HULL_GAP = 0.06;
// The bow wedge: base half-width as a multiple of the hull's half-beam plus a
// margin, and its length in metres as a function of forward speed. A kayak at
// 3.5 m/s throws it ~3.7 m ahead; below WEDGE_MIN_SPEED there is no wedge.
const WEDGE_WIDE = 1.5, WEDGE_MARGIN = 0.12;
const WEDGE_BASE_LEN = 1.2, WEDGE_PER_MS = 0.7, WEDGE_MIN_SPEED = 0.15;
// Leaf-to-leaf: a moving leaf keeps this fraction of the summed radii from a
// neighbour (or its rest spacing if that is closer), over this many passes.
const PAIR_GAP = 0.94, PAIR_ITER = 2;
// A pad this close to home and this still is dropped from the disturbed set.
const SETTLED_O = 0.004, SETTLED_V = 0.01;

/** Upload only the first `count` instances of an instance attribute. */
function upload(attr, count) {
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

export class LilyPads extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'LilyPads';
    this.loadLabel = 'Floating the lily pads';

    this.group = new THREE.Group();
    this.group.name = 'LilyPads';

    this.cells = new Map();        // key -> { pads, cx, cz }
    this.queue = [];
    this.meshes = [];              // index === variant

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._lastPack = new THREE.Vector3(1e9, 1e9, 1e9);
    this._lastRefresh = new THREE.Vector3(1e9, 1e9, 1e9);
    this._wanted = new Set();
    this._catchup = 0;
    this._dirty = true;
    // Pads currently away from their stems, and the id of the repack whose
    // slots are live — a pad's `_pk` has to match it before its slot is written.
    this._disturbed = new Set();
    this._packId = 0;
    this._near = [];
    this.stats = { pads: 0, drawn: 0, cells: 0, tris: 0, disturbed: 0 };
  }

  async init() {
    const { scene, world, preset } = this.ctx;
    // Quality spends pads the way it spends grass: a low tier keeps the
    // colonies but thins them.
    const density = 0.45 + 0.55 * (preset?.grassMul ?? 1);
    this.scatter = new LilyScatter(world, SEED, { density });
    this.material = createLilyMaterial();
    this.library = buildLilyLibrary(SEED);

    let baseTris = 0;
    for (let v = 0; v < this.library.length; v++) {
      const g = this.library[v];
      baseTris += g.index.count / 3;
      g.setAttribute('aLily', new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4));
      const mesh = new THREE.InstancedMesh(g, this.material, CAP);
      mesh.name = `lily_${v}`;
      mesh.count = 0;
      mesh.visible = false;
      // No cast: a leaf's shadow falls a few centimetres onto the water under
      // it, which is four shadow draws for a line nobody can see. Receive,
      // because a colony under a shore tree sits in that tree's shade.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    scene.add(this.group);
    console.log(`[lily] ${this.meshes.length} pad variants, ${baseTris | 0} base tris`);
    // Fill the shore around wherever the camera starts.
    this._catchup = 40;
  }

  onQuality(preset) {
    if (!this.scatter) return;
    this.scatter.density = 0.45 + 0.55 * (preset?.grassMul ?? 1);
    // Colonies are decided per cell from the density, so rebuild them.
    this.cells.clear();
    this._disturbed.clear();
    this._lastRefresh.set(1e9, 1e9, 1e9);
    this._dirty = true;
  }

  // ── streaming ──────────────────────────────────────────────────────────────

  _refreshQueue(cam) {
    const wanted = this._wanted;
    wanted.clear();
    this.queue.length = 0;
    const r = Math.ceil(STREAM_RADIUS / CELL);
    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const mx = (cx + 0.5) * CELL, mz = (cz + 0.5) * CELL;
        const d = Math.hypot(mx - cam.x, mz - cam.z);
        if (d - CELL_REACH > STREAM_RADIUS) continue;
        const key = cx * 100003 + cz;
        wanted.add(key);
        if (!this.cells.has(key)) this.queue.push({ cx, cz, key, d });
      }
    }
    this.queue.sort((a, b) => a.d - b.d);
    for (const [key, c] of this.cells) {
      if (wanted.has(key)) continue;
      for (const pad of c.pads) this._disturbed.delete(pad);
      this.cells.delete(key);
      this._dirty = true;
    }
  }

  _build(cx, cz, key) {
    const pads = [];
    this.scatter.generateCell(cx, cz, CELL, pads);
    this.cells.set(key, { pads, cx, cz });
    if (pads.length) this._dirty = true;
    return pads;
  }

  _buildCells(budgetMs) {
    if (!this.queue.length) return;
    const t0 = performance.now();
    let n = 0;
    while (n < this.queue.length) {
      const job = this.queue[n++];
      if (!this.cells.has(job.key)) this._build(job.cx, job.cz, job.key);
      if (performance.now() - t0 > budgetMs) break;
    }
    this.queue.splice(0, n);
  }

  /**
   * The cell under (x, z), generated now if the streamer has not got there.
   * For a spawner that needs an answer this frame. Cells generated this way
   * outside the wanted ring are dropped on the next refresh like any other.
   */
  ensureCell(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const key = cx * 100003 + cz;
    const have = this.cells.get(key);
    if (have) return have.pads;
    return this._build(cx, cz, key);
  }

  // ── packing ────────────────────────────────────────────────────────────────

  /** The pad's instance matrix right now: the stem plus any push. Flat. */
  _matrixFor(pad, m) {
    const p = this._p, q = this._q, s = this._s;
    p.set(pad.x + (pad.ox || 0), pad.y + LILY_LIFT, pad.z + (pad.oz || 0));
    q.setFromAxisAngle(this._up, pad.rot);
    s.set(pad.r * pad.sx, pad.r, pad.r);
    return m.compose(p, q, s);
  }

  _repack(cam) {
    const meshes = this.meshes;
    const counts = new Int32Array(meshes.length);
    const cells = [...this.cells.values()];
    for (const c of cells) c._d = Math.hypot((c.cx + 0.5) * CELL - cam.x, (c.cz + 0.5) * CELL - cam.z);
    cells.sort((a, b) => a._d - b._d);
    const packId = ++this._packId;

    const m = this._m;
    let total = 0, drawn = 0, tris = 0;
    for (const c of cells) {
      total += c.pads.length;
      // A cell whose nearest point is beyond the biggest draw radius has
      // nothing to pack.
      if (c._d - CELL_REACH > 150) continue;
      for (const pad of c.pads) {
        const dx = pad.x - cam.x, dz = pad.z - cam.z;
        if (dx * dx + dz * dz > pad.vis * pad.vis) continue;
        const mesh = meshes[pad.variant];
        const i = counts[pad.variant];
        if (i >= CAP) continue;
        mesh.setMatrixAt(i, this._matrixFor(pad, m));
        pad._pk = packId;
        pad._slot = i;
        const a = mesh.geometry.attributes.aLily.array;
        a[i * 4 + 0] = pad.phase;
        a[i * 4 + 1] = pad.w;
        a[i * 4 + 2] = pad.age;
        a[i * 4 + 3] = pad.tint;
        counts[pad.variant] = i + 1;
        drawn++;
        tris += mesh.geometry.index.count / 3;
      }
    }
    for (let v = 0; v < meshes.length; v++) {
      const mesh = meshes[v], n = counts[v];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        upload(mesh.instanceMatrix, n);
        upload(mesh.geometry.attributes.aLily, n);
      }
    }
    this.stats.pads = total;
    this.stats.drawn = drawn;
    this.stats.tris = tris | 0;
    this.stats.cells = this.cells.size;
    this._lastPack.copy(cam);
    this._dirty = false;
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt, elapsed) {
    if (!this.scatter) return;
    // Pads float on the DRAWN surface, which Water hands over in its init;
    // nothing is placed until that field exists or every pad would sit on the
    // raw grid, up to a metre off the sheet the player sees.
    if (!this.ctx.world._water) return;
    const cam = this.ctx.camera.position;
    this.material.userData.uniforms.uTime.value = elapsed;

    if (this._catchup > 0 || cam.distanceToSquared(this._lastRefresh) > REFRESH_MOVE * REFRESH_MOVE) {
      this._refreshQueue(cam);
      this._lastRefresh.copy(cam);
    }
    if (this._catchup > 0) {
      this._buildCells(12);
      this._catchup--;
      if (!this.queue.length) this._catchup = 0;
    } else {
      this._buildCells(BUILD_BUDGET_MS);
    }
    if (this._dirty || cam.distanceToSquared(this._lastPack) > REPACK_MOVE * REPACK_MOVE) this._repack(cam);
  }

  /**
   * After Boat has stepped this frame (it registers after this system, so
   * `update` would read last frame's hull), so the leaves move with the hull
   * that is drawn and not the one a frame behind it.
   */
  lateUpdate(dt) {
    if (!this.scatter || !this.ctx.world._water) return;
    this._pushHulls(dt);
    this._separate();
    // A neighbour may have been bumped back into the hull; the hull wins.
    this._pushHulls(0);
    this._settle(dt);
  }

  /**
   * Every live hull, as a capsule: the boat's own length and beam from its
   * model record, stern to bow along its heading.
   */
  _pushHulls(dt) {
    const boat = this.ctx.systems.boat;
    const hulls = boat?.boats;
    if (!hulls || !hulls.length) return;
    for (const b of hulls) {
      if (b.sinkT !== null && b.sinkT !== undefined) continue;
      const p = b.phys;
      if (!p) continue;
      const dim = b.group?.userData?.dim ?? boat.models?.[b.kind]?.dim;
      if (!dim) continue;
      const speed = b === boat._aboard ? (p.speed || 0) : 0;
      this._pushCapsule(p.x, p.z, p.heading, dim.length, dim.beam, speed, dt);
    }
  }

  /**
   * Resolve every leaf within reach out of one capsule and shove it. Public
   * for the harness and for anything else that will one day wade through a
   * colony; `speed` is the hull's forward speed for the drag term.
   */
  _pushCapsule(hx, hz, heading, length, beam, speed, dt) {
    const fx = Math.sin(heading), fz = Math.cos(heading);      // boat_physics' +Z bow
    const rx = Math.cos(heading), rz = -Math.sin(heading);     // starboard
    const half = Math.max(0.1, length * 0.5 - beam * 0.5);
    const rad = beam * 0.5;
    // The wedge, only under way and only forward.
    const wedgeLen = speed > WEDGE_MIN_SPEED ? WEDGE_BASE_LEN + WEDGE_PER_MS * speed : 0;
    const wBow = rad * WEDGE_WIDE + WEDGE_MARGIN;
    const near = this.padsNear(hx, hz, half + wedgeLen + wBow + 1.0, this._near);
    for (const pad of near) {
      const qx = pad.x + (pad.ox || 0) - hx, qz = pad.z + (pad.oz || 0) - hz;
      const t = qx * fx + qz * fz;            // along the keel, + toward the bow
      const sd = qx * rx + qz * rz;           // across, + starboard
      const sg = sd >= 0 ? 1 : -1, as = Math.abs(sd);
      let pen, nx, nz;
      if (t > half && wedgeLen > 0 && t < half + wedgeLen) {
        // Inside the wedge's span: its half-width shrinks to a point at the
        // apex. Push along the edge's outward normal, which leans forward —
        // a leaf is carried out AND ahead, the way a bow wave carries it.
        const w = wBow * (1 - (t - half) / wedgeLen);
        const lat = w + pad.r + HULL_GAP - as;
        if (lat <= 0) continue;
        const el = Math.hypot(wedgeLen, wBow);
        nx = (rx * sg * wedgeLen + fx * wBow) / el;
        nz = (rz * sg * wedgeLen + fz * wBow) / el;
        pen = lat * (wedgeLen / el);
      } else if (t > half || t < -half) {
        // The rounded ends of the hull outline, radial.
        const ex = fx * (t > half ? half : -half), ez = fz * (t > half ? half : -half);
        let dx = qx - ex, dz = qz - ez, d = Math.hypot(dx, dz);
        pen = rad * 0.75 + pad.r + HULL_GAP - d;
        if (pen <= 0) continue;
        if (d < 1e-4) { dx = rx * sg; dz = rz * sg; d = 1; }
        nx = dx / d; nz = dz / d;
      } else {
        // Alongside: the hull narrows a little toward its ends — a canoe is
        // full-bodied for most of its length.
        const taper = 1 - 0.25 * (t * t) / (half * half);
        pen = rad * taper + pad.r + HULL_GAP - as;
        if (pen <= 0) continue;
        nx = rx * sg; nz = rz * sg;
      }
      this._disturb(pad);
      // Out of the way now, plus a shove that keeps it sliding.
      pad.ox += nx * pen; pad.oz += nz * pen;
      pad.vx += nx * pen * PUSH_SHOVE;
      pad.vz += nz * pen * PUSH_SHOVE;
      // Drag: while in contact the leaf's velocity RELAXES toward a fraction
      // of the hull's, at a rate — not an increment per frame, which is what
      // the first cut did, and a leaf riding the hull for a second gained
      // metres per second and hit PUSH_MAX every time. dt 0 (the second,
      // corrective pass) leaves velocity alone.
      if (dt > 0) {
        const k = Math.min(1, 6 * dt);
        pad.vx += (fx * speed * PUSH_DRAG - pad.vx) * k;
        pad.vz += (fz * speed * PUSH_DRAG - pad.vz) * k;
      }
    }
  }

  _disturb(pad) {
    if (this._disturbed.has(pad)) return;
    this._disturbed.add(pad);
    pad.ox = pad.ox || 0; pad.oz = pad.oz || 0;
    pad.vx = pad.vx || 0; pad.vz = pad.vz || 0;
  }

  /**
   * Leaf against leaf. For every disturbed pad, every neighbour whose leaf it
   * now overlaps more than the two overlap AT REST is pushed apart along the
   * line between their centres, the bigger leaf moving less. The neighbour
   * joins the disturbed set, which is how a shove propagates through a mat
   * and how the whole thing springs back afterwards.
   */
  _separate() {
    const set = this._disturbed;
    if (!set.size) return;
    const near = this._pairNear ??= [];
    for (let it = 0; it < PAIR_ITER; it++) {
      for (const a of set) {
        const ax = a.x + a.ox, az = a.z + a.oz;
        this.padsNear(ax, az, a.r + 0.7, near);
        for (const b of near) {
          if (b === a) continue;
          const bx = b.x + (b.ox || 0), bz = b.z + (b.oz || 0);
          let dx = bx - ax, dz = bz - az;
          let d = Math.hypot(dx, dz);
          // Rest spacing between the two stems: never push closer than the
          // gap rule, but never force apart two leaves that shingle at rest.
          const rest = Math.hypot(b.x - a.x, b.z - a.z);
          const lim = Math.min((a.r + b.r) * PAIR_GAP, rest);
          if (d >= lim) continue;
          if (d < 1e-4) { dx = 1; dz = 0; d = 1; } else { dx /= d; dz /= d; }
          const pen = lim - d;
          const ma = a.r * a.r, mb = b.r * b.r, wa = mb / (ma + mb), wb = ma / (ma + mb);
          this._disturb(b);
          a.ox -= dx * pen * wa; a.oz -= dz * pen * wa;
          b.ox += dx * pen * wb; b.oz += dz * pen * wb;
          // A little of the shove carries as velocity, so the bump reads as
          // a nudge and not a teleport.
          a.vx -= dx * pen * wa * 2; a.vz -= dz * pen * wa * 2;
          b.vx += dx * pen * wb * 2; b.vz += dz * pen * wb * 2;
        }
      }
    }
  }

  /** Integrate the disturbed leaves home and write their live slots. */
  _settle(dt) {
    const set = this._disturbed;
    if (!set.size) { this.stats.disturbed = 0; return; }
    const meshes = this.meshes, m = this._m, packId = this._packId;
    const touched = this._touched ??= new Set();
    touched.clear();
    for (const pad of set) {
      // Damped spring to the stem.
      pad.vx += (-PUSH_K * pad.ox - PUSH_C * pad.vx) * dt;
      pad.vz += (-PUSH_K * pad.oz - PUSH_C * pad.vz) * dt;
      pad.ox += pad.vx * dt; pad.oz += pad.vz * dt;
      const o = Math.hypot(pad.ox, pad.oz);
      if (o > PUSH_MAX) { const k = PUSH_MAX / o; pad.ox *= k; pad.oz *= k; pad.vx *= 0.5; pad.vz *= 0.5; }
      if (o < SETTLED_O && Math.hypot(pad.vx, pad.vz) < SETTLED_V) {
        pad.ox = pad.oz = pad.vx = pad.vz = 0;
        set.delete(pad);
      }
      if (pad._pk !== packId) continue;      // not drawn this pack
      const mesh = meshes[pad.variant];
      mesh.setMatrixAt(pad._slot, this._matrixFor(pad, m));
      mesh.instanceMatrix.addUpdateRange(pad._slot * 16, 16);
      touched.add(mesh);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    this.stats.disturbed = set.size;
  }

  // ── the surface query ──────────────────────────────────────────────────────

  /** Where the leaf's centre is right now (stem plus any push). */
  padCentre(pad, out = { x: 0, z: 0 }) {
    out.x = pad.x + (pad.ox || 0);
    out.z = pad.z + (pad.oz || 0);
    return out;
  }

  /** Every live pad whose leaf centre is within `r` of (x, z). */
  padsNear(x, z, r, out = []) {
    out.length = 0;
    // A pushed leaf can sit up to PUSH_MAX from the cell its stem is in.
    const reach = r + PUSH_MAX;
    const c0x = Math.floor((x - reach) / CELL), c1x = Math.floor((x + reach) / CELL);
    const c0z = Math.floor((z - reach) / CELL), c1z = Math.floor((z + reach) / CELL);
    const r2 = r * r;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = this.cells.get(cx * 100003 + cz);
        if (!c) continue;
        for (const pad of c.pads) {
          const dx = pad.x + (pad.ox || 0) - x, dz = pad.z + (pad.oz || 0) - z;
          if (dx * dx + dz * dz <= r2) out.push(pad);
        }
      }
    }
    return out;
  }

  /**
   * Is (x, z) over a pad's leaf? The test is the pad's ellipse in its own
   * frame, and the notch is ignored — a frog toe over the V is still a frog on
   * the pad. Where leaves shingle, the LARGER pad wins, which is also the one
   * drawn on top in practice.
   */
  padAt(x, z) {
    const near = this.padsNear(x, z, 0.7, this._nearAt ??= []);
    let best = null;
    for (const pad of near) {
      if (this._inside(pad, x, z) <= 1 && (!best || pad.r > best.r)) best = pad;
    }
    return best;
  }

  /** Normalised radius (0 stem .. 1 rim) of (x, z) in the pad's frame. */
  _inside(pad, x, z) {
    const dx = x - pad.x - (pad.ox || 0), dz = z - pad.z - (pad.oz || 0);
    const c = Math.cos(pad.rot), s = Math.sin(pad.rot);
    // World -> local: rotate by -rot. Local x is squashed by sx.
    const lx = (c * dx - s * dz) / (pad.r * pad.sx);
    const lz = (s * dx + c * dz) / pad.r;
    return Math.hypot(lx, lz);
  }

  /** Height of the pad's flat middle at time `elapsed` — the shader's bob. */
  padTop(pad, elapsed) {
    return pad.y + LILY_LIFT + LILY_BOB * Math.sin(elapsed * pad.w + pad.phase);
  }

  /** The leaf surface under (x, z), or null if no pad covers it. */
  surfaceAt(x, z, elapsed) {
    const pad = this.padAt(x, z);
    if (!pad) return null;
    const u = Math.min(1, this._inside(pad, x, z));
    return this.padTop(pad, elapsed) + pad.r * padProfile(u, LILY_VARIANTS[pad.variant].curl);
  }

  dispose() {
    this.ctx.scene.remove(this.group);
    for (const m of this.meshes) m.geometry.dispose();
    this.material?.dispose();
  }
}

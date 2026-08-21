// ─────────────────────────────────────────────────────────────────────────────
//  RockColliders — the rocks, made solid, streamed around the camper.
//
//  The player's ask was two rules: drive up and over the low ones, be stopped
//  by the big ones. Neither rule is written down anywhere in this file, and
//  that is the point. The camper already carries the two things that decide it:
//
//    · four suspension rays with a 0.44 m wheel on a 0.24 m travel, which climb
//      anything they can get a tyre onto, and
//    · a chassis box whose underside sits 0.62 m over the ground at rest.
//
//  Give a rock a collider and those two answer the question by themselves. A
//  stone standing 0.3 m proud goes under the wheels and the camper rides it; a
//  boulder standing 1.5 m proud meets the box and stops the camper dead; the
//  half-metre ones in between lift a wheel, scrape, and are shoved around or
//  climbed depending on the line you took. That is a threshold nobody has to
//  keep in sync with the vehicle, because it *is* the vehicle.
//
//  What this file is actually responsible for is the cost. Rock is a streamed
//  visual system with thousands of instances live at once and Rapier wants a
//  static collider per rock, so the work here is choosing which handful of them
//  is worth building at any moment:
//
//    · only rocks near the camper (ADD_R, dropped again at DROP_R),
//    · only rocks that stand far enough out of the ground to be felt
//      (`protrusion`, and read that one before touching it — the obvious
//      version of that measurement is what made the mountains hollow),
//    · rescanned when the camper has moved (REFRESH_MOVE) or when the streamer
//      has put more rock on the hill since the last look,
//    · and a few per frame, never a field at once.
//
//  Measured over 34 random drivable spots (tools/_scratch/rockcensus.mjs), the
//  number of rock instances inside ADD_R is a median of 2, a p90 of 10 and a
//  worst case of 23 — so CAP is four times the worst case this world can
//  actually present, and exists only so a future scatter cannot turn a scree
//  slope into a thousand-collider stall. That census sampled ground of slope
//  under 0.9 and never saw a crag: on high, steep ground the same count is a
//  median of 7 and a worst case of 30 (tools/_scratch/cragcollide2.mjs), which
//  the cap still clears three times over.
//
//  The shape is the drawn mesh's own convex hull, scaled per instance. Rock
//  forms are already convex-ish polytopes of 12–82 unique vertices (they are
//  built by plane-clipping a box), so the hull is both cheap and honest: what
//  you hit is the silhouette you were looking at.
//
//  What comes out the other end, driven at from 18 m on a clean lane
//  (tools/_scratch/rockover.mjs), counting whether the camper finished on the
//  far side of the rock:
//
//      protrudes 0.15–0.35 m    3 of 3 driven over
//      protrudes 0.35–0.55 m    2 of 2 driven over
//      protrudes 0.55–0.80 m    4 of 5 driven over
//      protrudes 0.80–1.50 m    6 of 7 driven over
//      protrudes 1.50 m +       5 of 8 driven over, 3 stopped dead
//
//  The crossover is a slope rather than a line, which is the honest answer: a
//  metre-high boulder taken square is a climb and taken on the corner is a
//  wall, and which one you got depends on your line. That is a driving game.
// ─────────────────────────────────────────────────────────────────────────────
import RAPIER from '@dimforge/rapier3d-compat';

const ADD_R = 30;             // m — rocks inside this get a collider
const DROP_R = 38;            // m — and lose it out here. Hysteresis, so a
                              // camper idling on the line does not thrash.
const REFRESH_MOVE = 4;       // m of travel before the wanted set is rescanned
const ADD_PER_FRAME = 3;      // colliders built per frame, at most
// Frames a streaming-triggered rescan waits behind the last one. The trigger is
// the streamer's instance count, which changes on nearly every frame while
// driving — this keeps that from turning into a rescan per frame, and a third
// of a second is far below noticing. A rescan walks every streamed instance and
// costs 0.03 ms of a 16.7 ms frame at its worst, over 3286 of them on high
// ground (tools/_scratch/rescancost.mjs), so the throttle is thrift rather than
// necessity.
const SETTLE_FRAMES = 20;
const CAP = 96;               // live colliders, nearest-first (see above)

// How far a rock must stand out of the ground before it is worth colliding
// with. The physics ground is a 1.375 m heightfield (PATCH_DIV in
// VehiclePhysics) whose own disagreement with the rendered terrain runs to
// ~0.12 m over a concave cell — so anything under this is inside the error bar
// of the surface it would be sitting on, and giving it a collider would only
// add a rattle the player cannot see the cause of.
const MIN_PROTRUDE = 0.14;

// How close the camper may be to a rock's own box before a *new* collider for
// it is held back. Nothing here is about driving: it is about a rock that is
// already inside the camper when its collider would be built, which is what a
// spawn, a teleport or an auto-recovery onto a boulder looks like. Rapier
// resolves that penetration by firing the camper into the sky. Holding the
// collider back leaves exactly today's behaviour (no collision) until the
// camper is clear, at which point it appears. 2.9 m is the chassis
// half-diagonal (0.86, 2.18) plus a little.
//
// Measured against the rock's own local box rather than as a disc around its
// origin, and that distinction is the whole of the second half of the crag bug.
// A disc has to be `SPAWN_CLEAR + max(sx, sz)` wide to cover the stone, which
// for a 20 m cliff block is a 23 m no-build zone — so the camper could stand
// anywhere near the block, in clear air, with the collider permanently held
// back for being *close to the block's centre*. The box is the same test where
// it matters (nothing can be inside the stone without being inside its box) and
// costs a quaternion inverse per queued rock.
const SPAWN_CLEAR = 2.9;

/**
 * How far a rock stands out of the hill it is standing in, in metres.
 *
 * The obvious version of this — top of the rock, minus the terrain height at
 * the rock's own origin — is right on a meadow and badly wrong on a mountain,
 * and it is why the biggest rock in the world was the one you could drive
 * through. A crag block is planted as a wedge driven into the slope
 * (RockScatter._place, the 'sag' anchor): its uphill corner ends up tens of
 * metres inside the hill and its downhill corner reaches out over the fall
 * line, which is what makes a cliff band a cliff band. Anchoring that block
 * puts its ORIGIN as much as 1.3 sizes below the ground at its own centre, so
 * `top - groundY` for a 16 m cliff standing 20 m proud of the slope below it
 * reads as a comfortable −3 m: buried, skip it, no collider. Measured over
 * parked positions on high ground (tools/_scratch/cragwhy.mjs) that dropped a
 * quarter of the rock in front of the camper, and every one of the big ones.
 *
 * The ground under a rock is a plane, not a height, and the scatter already
 * wrote that plane onto the instance — `groundY` with the terrain's own
 * gradient in `groundGX`/`groundGZ` — because the shader needs it to draw the
 * contact band. Following it out to the rock's own edge gives the lowest ground
 * the rock is standing over, which is the face you meet coming at it from
 * downhill. Checked against terrain actually sampled around each rock
 * (tools/_scratch/cragcollide2.mjs) the plane is worth the trust: median error
 * 0.07 m, p90 0.55 m, and it recovers 36 of the 37 standing rocks the old test
 * dropped while wrongly admitting 6 buried ones — which cost nothing, being
 * hulls sat under the heightfield where nothing can reach them.
 *
 * Rotation is ignored on purpose: the reach is the larger plan half-extent, so
 * this is the fall across a disc that contains the block at any yaw. Being a
 * little generous here is the safe direction — the budget it spends is 2 more
 * colliders inside ADD_R at the median (5 → 7, worst case 29 → 30 against a
 * CAP of 96).
 */
function protrusion(r, h) {
  const reach = Math.max(h.bx * r.sx, h.bz * r.sz);
  const fall = Math.hypot(r.groundGX ?? 0, r.groundGZ ?? 0) * reach;
  return r.y + h.topY * r.sy - (r.groundY - fall);
}

/** Deduplicated local-space vertices of one built rock variant. */
function hullPoints(geom) {
  const pos = geom.attributes.position.array;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < pos.length; i += 3) {
    // Quantised to a millimetre: the forms are plane-clipped polytopes, so a
    // shared corner arrives once per face with float noise on it.
    const k = `${Math.round(pos[i] * 1e3)},${Math.round(pos[i + 1] * 1e3)},${Math.round(pos[i + 2] * 1e3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(pos[i], pos[i + 1], pos[i + 2]);
  }
  return new Float32Array(out);
}

export class RockColliders {
  /**
   * @param P      the Rapier world (owned by VehiclePhysics)
   * @param source the Rocks system — read live, never held past a frame, and
   *               allowed to be absent entirely (the capture harness runs
   *               without it, and it streams in after the camper exists).
   */
  constructor(P, source) {
    this.P = P;
    this.source = source;
    this.live = new Map();          // key -> { col, x, z }
    this.pending = [];              // wanted, not built yet — nearest first
    this._next = 0;                 // cursor into `pending`
    this._lastX = 1e9;
    this._lastZ = 1e9;
    this._stamp = -1;               // the streamer's count at the last rescan
    this._sinceScan = 0;            // frames since then
    this._hulls = new Map();        // 'arch:variant' -> { pts, topY, bx, by, bz }
    this.count = 0;
    this.deferred = 0;              // held back by SPAWN_CLEAR, for diagnosis
  }

  /** Local hull, top height and plan extents for one variant, built once. */
  _hull(arch, variant) {
    const key = `${arch}:${variant}`;
    let h = this._hulls.get(key);
    if (h !== undefined) return h;
    const geom = this.source?.library?.[arch]?.[variant];
    if (!geom) { this._hulls.set(key, null); return null; }
    if (!geom.boundingBox) geom.computeBoundingBox();
    const b = geom.boundingBox;
    const pts = hullPoints(geom);
    // Four points is the minimum that bounds a volume; anything less is a
    // degenerate hull Rapier would either reject or turn into a plane.
    h = pts.length >= 12 ? {
      pts,
      topY: b.max.y,
      // Local half-extents, the same numbers `archFootprints` hands the scatter
      // to plant the block with. Used twice below: to work out how far downhill
      // the ground under the rock has fallen by the time it reaches the rock's
      // own edge, and to hold a collider back off the camper by the block's
      // actual shape rather than by a radius.
      bx: Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
      by: Math.max(Math.abs(b.min.y), Math.abs(b.max.y)),
      bz: Math.max(Math.abs(b.min.z), Math.abs(b.max.z)),
    } : null;
    this._hulls.set(key, h);
    return h;
  }

  /**
   * Rescan the rock cells for everything that should be solid right now.
   * Nearest first, so a cap that bites drops the far rocks rather than the one
   * under the front wheel.
   */
  _rescan(x, z) {
    const cells = this.source?.cells;
    this.pending.length = 0;
    if (!cells?.size) return;

    const want = [];
    for (const c of cells.values()) {
      const list = c?.instances;
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const dx = r.x - x, dz = r.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > ADD_R * ADD_R) continue;
        const h = this._hull(r.arch, r.variant);
        if (!h) continue;
        if (protrusion(r, h) < MIN_PROTRUDE) continue;
        want.push({ r, d2, hull: h });
      }
    }
    want.sort((a, b) => a.d2 - b.d2);
    if (want.length > CAP) want.length = CAP;

    // Anything already built stays built; the rest is the build queue.
    const keep = new Set();
    this._next = 0;
    for (const w of want) {
      const key = rockKey(w.r);
      keep.add(key);
      if (!this.live.has(key)) this.pending.push({ key, ...w });
    }

    for (const [key, e] of this.live) {
      if (keep.has(key)) continue;
      // Only *distance* retires a collider. A rock that fell out of the wanted
      // set because its cell was regenerated at a finer LOD is still standing
      // there in front of the camper, and removing it because its identity
      // changed would open a hole in the world for as long as it took to
      // notice. Out at DROP_R nobody can be touching it.
      if (Math.hypot(e.x - x, e.z - z) < DROP_R) continue;
      this.P.removeCollider(e.col, false);
      this.live.delete(key);
    }
    this.count = this.live.size;
  }

  /**
   * Is the camper inside this rock's box, plus SPAWN_CLEAR of slack on every
   * face? Tested in the rock's own frame, so a wall lying along a hillside is
   * tested as the wall it is rather than as a disc big enough to swallow it.
   *
   * The half-extents are multiplied back up by the instance scale, so both
   * sides of each comparison are world metres and the slack is a fixed 2.9 m
   * halo whatever the size of the block.
   */
  _nearBox(r, h, camX, camY, camZ) {
    // The camper's offset, turned by the *inverse* of the instance rotation.
    // The instance quaternion is a unit one (setFromUnitVectors and axis-angle
    // products, see RockScatter.orient), so the conjugate is the inverse and
    // v' = v + 2·(-q.xyz) × ((-q.xyz) × v + q.w·v) holds without normalising.
    const dx = camX - r.x, dy = camY - r.y, dz = camZ - r.z;
    const qx = -r.qx, qy = -r.qy, qz = -r.qz, qw = r.qw;
    const tx = 2 * (qy * dz - qz * dy);
    const ty = 2 * (qz * dx - qx * dz);
    const tz = 2 * (qx * dy - qy * dx);
    const lx = dx + qw * tx + (qy * tz - qz * ty);
    const ly = dy + qw * ty + (qz * tx - qx * tz);
    const lz = dz + qw * tz + (qx * ty - qy * tx);
    return Math.abs(lx) < h.bx * r.sx + SPAWN_CLEAR
        && Math.abs(ly) < h.by * r.sy + SPAWN_CLEAR
        && Math.abs(lz) < h.bz * r.sz + SPAWN_CLEAR;
  }

  /** Build one queued rock. Returns false if it was held back or unbuildable. */
  _build(job, camX, camY, camZ) {
    const { r, hull } = job;
    // See SPAWN_CLEAR: never hand Rapier a collider that is already inside the
    // camper. Dropped rather than retried here — the next rescan re-queues
    // anything wanted that is not live, so it appears the moment it is safe.
    if (this._nearBox(r, hull, camX, camY, camZ)) {
      this.deferred++;
      return false;
    }

    const src = hull.pts;
    const pts = new Float32Array(src.length);
    // The instance transform is T·R·S (see Rocks._repack), and a collider has
    // no scale — so the scale is baked into the points and the collider keeps
    // the translation and rotation. The three are then the same transform.
    for (let i = 0; i < src.length; i += 3) {
      pts[i] = src[i] * r.sx;
      pts[i + 1] = src[i + 1] * r.sy;
      pts[i + 2] = src[i + 2] * r.sz;
    }

    let col = null;
    try {
      const desc = RAPIER.ColliderDesc.convexHull(pts);
      if (!desc) return false;
      desc.setTranslation(r.x, r.y, r.z)
        .setRotation({ x: r.qx, y: r.qy, z: r.qz, w: r.qw })
        // Grippier than the chassis (0.35) and a shade under the ground (1.0):
        // a tyre on a rock should bite, a flank sliding along one should not
        // grab and tip the camper over.
        .setFriction(0.85)
        // Stone does not bounce a two-tonne camper. Any restitution here reads
        // as the rock kicking back, which is the one thing a boulder never does.
        .setRestitution(0.0);
      col = this.P.createCollider(desc);
    } catch (e) {
      return false;
    }
    if (!col) return false;
    this.live.set(job.key, { col, x: r.x, z: r.z });
    return true;
  }

  /** Called once a frame from VehiclePhysics.step, with the chassis position. */
  update(x, y, z) {
    if (!this.source) return;
    const moved = Math.hypot(x - this._lastX, z - this._lastZ);
    // The streamer's own count of what it is drawing. Every trigger below is a
    // movement one, and a camper that has stopped moving does not make any of
    // them fire again — so a rock cell that finished generating after the last
    // scan stayed uncollided for as long as the player stood there. Parked and
    // then nudged a few metres (tools/_scratch/cragwhy.mjs), 61 of 173 rocks
    // inside collider range went from having no collider to having one, purely
    // because the nudge caused a rescan. Watching the count costs nothing and
    // settles by itself: once the streamer is done, it stops changing.
    const stamp = (this.source.stats?.cells ?? 0) * 1e6 + (this.source.stats?.instances ?? 0);
    this._sinceScan++;
    // Rescan on travel, and also whenever the queue has run dry — the rock
    // cells stream in over several frames after a load or a teleport, so the
    // first scan from a standing start sees a fraction of what is there.
    if (moved > REFRESH_MOVE || this._lastX === 1e9
        || (this._next >= this.pending.length && moved > 0.5)
        || (stamp !== this._stamp && this._sinceScan > SETTLE_FRAMES)) {
      this._lastX = x; this._lastZ = z;
      this._stamp = stamp;
      this._sinceScan = 0;
      this._rescan(x, z);
    }
    // Front of the queue is the nearest rock, which is the one the camper is
    // about to arrive at.
    let built = 0;
    while (this._next < this.pending.length && built < ADD_PER_FRAME) {
      if (this._build(this.pending[this._next++], x, y, z)) built++;
    }
    if (this._next >= this.pending.length) { this.pending.length = 0; this._next = 0; }
    this.count = this.live.size;
  }

  /** Drop everything — a teleport lands somewhere none of this is true. */
  clear() {
    for (const e of this.live.values()) this.P.removeCollider(e.col, false);
    this.live.clear();
    this.pending.length = 0;
    this._next = 0;
    this._lastX = 1e9;
    this._lastZ = 1e9;
    this._stamp = -1;
    this._sinceScan = 0;
    this.count = 0;
  }
}

/**
 * A rock's identity, which is its place in the world and not its object.
 *
 * The scatter hands out a fresh instance object every time a cell is
 * regenerated at a finer LOD, and those regenerations happen constantly while
 * driving. Keying on the object would rebuild every collider around the camper
 * each time one did. Quarter-metre quantisation is far finer than any rock this
 * collides with and identical across a regeneration, which is exactly the
 * property wanted.
 */
function rockKey(r) {
  return `${Math.round(r.x * 4)},${Math.round(r.z * 4)},${r.arch}`;
}

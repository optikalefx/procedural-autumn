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
//    · only rocks that stand far enough out of the ground to be felt,
//    · rebuilt only when the camper has actually moved (REFRESH_MOVE),
//    · and a few per frame, never a field at once.
//
//  Measured over 34 random drivable spots (tools/_scratch/rockcensus.mjs), the
//  number of rock instances inside ADD_R is a median of 2, a p90 of 10 and a
//  worst case of 23 — so CAP is four times the worst case this world can
//  actually present, and exists only so a future scatter cannot turn a scree
//  slope into a thousand-collider stall.
//
//  The shape is the drawn mesh's own convex hull, scaled per instance. Rock
//  forms are already convex-ish polytopes of 12–82 unique vertices (they are
//  built by plane-clipping a box), so the hull is both cheap and honest: what
//  you hit is the silhouette you were looking at.
// ─────────────────────────────────────────────────────────────────────────────
import RAPIER from '@dimforge/rapier3d-compat';

const ADD_R = 30;             // m — rocks inside this get a collider
const DROP_R = 38;            // m — and lose it out here. Hysteresis, so a
                              // camper idling on the line does not thrash.
const REFRESH_MOVE = 4;       // m of travel before the wanted set is rescanned
const ADD_PER_FRAME = 3;      // colliders built per frame, at most
const CAP = 96;               // live colliders, nearest-first (see above)

// How far a rock must stand out of the ground before it is worth colliding
// with. The physics ground is a 1.375 m heightfield (PATCH_DIV in
// VehiclePhysics) whose own disagreement with the rendered terrain runs to
// ~0.12 m over a concave cell — so anything under this is inside the error bar
// of the surface it would be sitting on, and giving it a collider would only
// add a rattle the player cannot see the cause of.
const MIN_PROTRUDE = 0.14;

// Plan-view radius around the camper inside which a *new* collider is held
// back. Nothing here is about driving: it is about a rock that is already
// inside the camper when its collider would be built, which is what a spawn, a
// teleport or an auto-recovery onto a boulder looks like. Rapier resolves that
// penetration by firing the camper into the sky. Holding the collider back
// leaves exactly today's behaviour (no collision) until the camper is clear,
// at which point it appears. 2.9 m is the chassis half-diagonal (0.86, 2.18)
// plus a little.
const SPAWN_CLEAR = 2.9;

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
    this._hulls = new Map();        // 'arch:variant' -> { pts, topY }
    this.count = 0;
    this.deferred = 0;              // held back by SPAWN_CLEAR, for diagnosis
  }

  /** Local hull + local top height for one archetype variant, built once. */
  _hull(arch, variant) {
    const key = `${arch}:${variant}`;
    let h = this._hulls.get(key);
    if (h !== undefined) return h;
    const geom = this.source?.library?.[arch]?.[variant];
    if (!geom) { this._hulls.set(key, null); return null; }
    if (!geom.boundingBox) geom.computeBoundingBox();
    const pts = hullPoints(geom);
    // Four points is the minimum that bounds a volume; anything less is a
    // degenerate hull Rapier would either reject or turn into a plane.
    h = pts.length >= 12 ? { pts, topY: geom.boundingBox.max.y } : null;
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
        // `groundY` is the terrain height the scatter measured at this rock's
        // own origin when it planted it — the same number `_place` anchored
        // against, so this costs no terrain sampling and cannot disagree with
        // the placement.
        if (r.y + h.topY * r.sy - r.groundY < MIN_PROTRUDE) continue;
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

  /** Build one queued rock. Returns false if it was held back or unbuildable. */
  _build(job, camX, camZ) {
    const { r, hull } = job;
    // See SPAWN_CLEAR: never hand Rapier a collider that is already inside the
    // camper. Dropped rather than retried here — the next rescan re-queues
    // anything wanted that is not live, so it appears the moment it is safe.
    const reach = Math.max(r.sx, r.sz);
    if (Math.hypot(r.x - camX, r.z - camZ) < SPAWN_CLEAR + reach) {
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
  update(x, z) {
    if (!this.source) return;
    const moved = Math.hypot(x - this._lastX, z - this._lastZ);
    // Rescan on travel, and also whenever the queue has run dry — the rock
    // cells stream in over several frames after a load or a teleport, so the
    // first scan from a standing start sees a fraction of what is there.
    if (moved > REFRESH_MOVE || this._lastX === 1e9
        || (this._next >= this.pending.length && moved > 0.5)) {
      this._lastX = x; this._lastZ = z;
      this._rescan(x, z);
    }
    // Front of the queue is the nearest rock, which is the one the camper is
    // about to arrive at.
    let built = 0;
    while (this._next < this.pending.length && built < ADD_PER_FRAME) {
      if (this._build(this.pending[this._next++], x, z)) built++;
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

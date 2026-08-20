// ─────────────────────────────────────────────────────────────────────────────
//  RockBoom — the rock term in the chase boom's floor.
//
//  `CameraRig._boomFit` marches the boom against `max(getHeight, getWaterHeight)`
//  and shortens at the first sample that would be underground. A 15 m cliff
//  block is neither of those fields, so until now the boom went straight
//  through one: INTEGRATION_REQUESTS P2 measured `rock_cliff_2#0` with its
//  nearest face 1.7 m from the lens, taking 34 of 72 probe rays. The rocks
//  author has since kept rock out of the road corridor (P2-reply), which fixes
//  the *road* cases; this fixes the case where the camper is not on a road, or
//  the boom is longer than the corridor is wide.
//
//  ── the shape of the term ───────────────────────────────────────────────────
//
//  A floor, not a collision volume, because that is what the fit already
//  consumes: `lift(x, z, ground)` answers "how high is the world at this
//  column", and the three places that already take `max(terrain, water)` take
//  one more max and are done.
//
//  Each instance contributes a *dome* over its own plan footprint rather than a
//  box:
//
//      floor = ground + (top - ground) * sqrt(1 - u^DOME_P)
//
//  with `u` the normalised distance across the footprint ellipse. The dome is
//  the whole reason this is usable on a camera. A box floor is exact and
//  discontinuous — the camera would step 15 m vertically the instant it crossed
//  a crag block's plan edge, and back again on the way out. The dome reaches
//  the rock's own top over its centre and decays *to the terrain floor* at the
//  footprint edge, so the term is continuous with the field it is being max'd
//  against and adds no jump anywhere. `DOME_P` trades the two failures against
//  each other: high P keeps the dome near full height until the very edge (less
//  camera inside rock, steeper vertical move), low P is gentler and leakier.
//  It is a measured number — see `tools/_scratch/camrock.mjs --dome`.
//
//  ── on owning this at all ───────────────────────────────────────────────────
//
//  This is an *interim* consumer, and it is written so it can be deleted. The
//  rocks author offered a `nearestRockSurface(x, z)` on the scatter rather than
//  have the extents reimplemented here, and P2-reply-2 in
//  docs/INTEGRATION_REQUESTS.md asks them for `rockFloorAt(x, z, ground)` — the
//  same query in the shape the fit consumes. `attach()` prefers that method the
//  moment it exists; when it does, everything below the marked line goes.
//
//  Until then this reads only *published* fields — `rocks.cells`, whose shape
//  is documented in Rocks.js line 64, and `rocks.library`, whose geometries
//  carry the bounding boxes `archFootprints` itself reads. It does not touch
//  the InstancedMeshes or their matrices, and it does not raycast.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metres a rock must stand above its own ground before the boom cares about it.
 *
 * Not a size filter for cheapness — it is here because the camera's own
 * clearance is 1.6–4.0 m. A 40 cm stone's "top" is already inside the air the
 * camera insists on having under it, so folding it into the floor could only
 * ever lift the shot by a few centimetres, while a talus field of them would
 * have the boom shortening continuously over rubble the camper drives across.
 */
export const MIN_RISE = 1.5;

/**
 * Footprint inflation. The dome is fitted to the instance's bounding box, and a
 * box's corner reaches further than the ellipse inscribed in it; a few per cent
 * of margin buys back most of that without widening the term meaningfully.
 */
export const PLAN_MARGIN = 1.08;

/** Dome profile exponent. See the header, and `camrock.mjs --dome` for why 6. */
export const DOME_P = 6;

/** Bounding-box half extents of one library geometry, cached per arch/variant. */
function extents(cache, lib, arch, variant) {
  const key = `${arch}/${variant}`;
  let e = cache.get(key);
  if (e) return e;
  const g = lib?.[arch]?.[variant];
  const b = g?.boundingBox;
  if (!b) { e = null; }
  else {
    e = {
      rx: Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
      rz: Math.max(Math.abs(b.min.z), Math.abs(b.max.z)),
      hi: b.max.y,
      lo: b.min.y,
      // The tallest the box can be about its own origin, whichever way it is
      // tilted — used for the +Y support below.
      ry: Math.max(Math.abs(b.min.y), Math.abs(b.max.y)),
    };
  }
  cache.set(key, e);
  return e;
}

export class RockBoom {
  constructor() {
    this.cand = [];               // reused candidate records, never reallocated
    this.n = 0;                   // how many of them are live this frame
    this.rocks = null;
    this.native = null;           // rocks-owned query, preferred when it lands
    this._ext = new Map();
    this._px = 1e9; this._pz = 1e9; this._pr = 0;
    // Instance fields rather than the consts directly, so the audit can sweep
    // them without editing this file. The rig never changes them.
    this.domeP = DOME_P;
    this.planMargin = PLAN_MARGIN;
  }

  /**
   * Point at the rocks system, or at nothing. Called every frame from the rig
   * because `ctx.systems.rocks` may not exist yet (or at all — the capture
   * harness runs configurations without it), and because the day the scatter
   * grows its own query this is where it gets picked up.
   */
  attach(rocks) {
    if (rocks === this.rocks) return this;
    this.rocks = rocks ?? null;
    this.native = typeof rocks?.rockFloorAt === 'function'
      ? (x, z, g) => rocks.rockFloorAt(x, z, g)
      : null;
    this._ext.clear();
    this.n = 0;
    return this;
  }

  /**
   * Collect every instance that could touch a disc of `radius` about (x, z).
   *
   * Once per frame, not once per boom sample: the boom takes up to 30 samples
   * and the two hard floors take two more, and they all fall inside one disc.
   * `rocks.cells` is a Map of 64 m cells (Rocks.js:64) — a few hundred of them
   * inside the 1 km stream radius — so the outer loop is a cheap distance
   * reject and the inner one only runs on cells the boom could reach.
   */
  prime(x, z, radius) {
    if (this.native) { this._px = x; this._pz = z; this._pr = radius; this.n = 0; return; }
    this.n = 0;
    const rocks = this.rocks;
    const cells = rocks?.cells;
    const lib = rocks?.library;
    if (!cells || !lib) return;

    // Cell half-diagonal (64 m cells) plus the largest reach any instance can
    // have, so a crag block whose origin is outside the disc but whose face is
    // inside it still gets in.
    const cellPad = 46;
    const outer = radius + cellPad;
    const outer2 = outer * outer;

    for (const c of cells.values()) {
      const mx = (c.cx + 0.5) * 64, mz = (c.cz + 0.5) * 64;
      const ddx = mx - x, ddz = mz - z;
      if (ddx * ddx + ddz * ddz > outer2) continue;
      for (const inst of c.instances) {
        const dx = inst.x - x, dz = inst.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > outer2) continue;
        const e = extents(this._ext, lib, inst.arch, inst.variant);
        if (!e) continue;

        // +Y support of the oriented box: how far its highest corner rises
        // above the instance origin. A 30 m wall laid across a 40° face gets
        // most of its height from the tilt, so this cannot be `hi * sy`.
        const qx = inst.qx, qy = inst.qy, qz = inst.qz, qw = inst.qw;
        const r10 = 2 * (qx * qy + qz * qw);
        const r11 = 1 - 2 * (qx * qx + qz * qz);
        const r12 = 2 * (qy * qz - qx * qw);
        const ex = e.rx * inst.sx, ez = e.rz * inst.sz, ey = e.ry * inst.sy;
        const top = inst.y + Math.abs(r10) * ex + Math.abs(r11) * ey + Math.abs(r12) * ez;
        if (top - inst.groundY < MIN_RISE) continue;

        const ax = ex * this.planMargin, az = ez * this.planMargin;
        const reach = Math.max(ax, az);
        if (d2 > (radius + reach) * (radius + reach)) continue;

        // Plan frame: the transpose of the rotation, horizontal row only.
        const rec = this.cand[this.n] ?? (this.cand[this.n] = {});
        rec.x = inst.x; rec.y = inst.y; rec.z = inst.z;
        rec.ax = ax; rec.az = az; rec.reach2 = reach * reach;
        rec.top = top;
        rec.r00 = 1 - 2 * (qy * qy + qz * qz);
        rec.r20 = 2 * (qx * qz - qy * qw);
        rec.r02 = 2 * (qx * qz + qy * qw);
        rec.r22 = 1 - 2 * (qx * qx + qy * qy);
        // Kept for the audit's exact test only; the dome does not use them.
        rec.qx = qx; rec.qy = qy; rec.qz = qz; rec.qw = qw;
        rec.ex = ex; rec.ez = ez;
        rec.hi = e.hi * inst.sy; rec.lo = e.lo * inst.sy;
        rec.arch = inst.arch; rec.size = inst.size;
        this.n++;
      }
    }
    this._px = x; this._pz = z; this._pr = radius;
  }

  /**
   * The floor at one column, given what terrain and water already put there.
   *
   * Returns `ground` unchanged when no rock covers the column, so the caller
   * can use it as a drop-in `max`.
   */
  lift(x, z, ground) {
    if (this.native) {
      const f = this.native(x, z, ground);
      return f === null || f === undefined || !(f > ground) ? ground : f;
    }
    let best = ground;
    for (let i = 0; i < this.n; i++) {
      const c = this.cand[i];
      if (c.top <= best) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz > c.reach2) continue;
      const lx = c.r00 * dx + c.r20 * dz;
      const lz = c.r02 * dx + c.r22 * dz;
      // Chebyshev, not Euclidean: `u` is normalised distance across the
      // *rectangle*, so u = 1 is the box edge in every direction. An inscribed
      // ellipse leaves the four corners of a crag block's footprint with no
      // term at all — measured at 21 of the 51 arm-off failures still failing
      // (camrock.mjs, ellipse vs box at DOME_P 6: 14 inside vs 5). It stays
      // continuous: `max` is, and the dome still decays to `ground` at u = 1.
      const u = Math.max(Math.abs(lx) / c.ax, Math.abs(lz) / c.az);
      if (u >= 1) continue;
      const u2 = u * u;
      // u^domeP, from u². The default is 6, which is three multiplies.
      const h = this.domeP * 0.5;
      const p = h === 3 ? u2 * u2 * u2 : Math.pow(u2, h);
      const f = ground + (c.top - ground) * Math.sqrt(1 - p);
      if (f > best) best = f;
    }
    return best;
  }

  /**
   * Ground truth for the audit: is this point inside (or within `margin` of)
   * some rock's oriented bounding box?
   *
   * Deliberately *not* what `lift` uses. The dome is the conservative,
   * continuous approximation the camera can actually be flown against; this is
   * the exact box, and the only honest way to score whether the approximation
   * kept the lens out of the rock. Not called on the render path.
   */
  insideAny(x, y, z, margin = 0) {
    let hit = null;
    for (let i = 0; i < this.n; i++) {
      const c = this.cand[i];
      const dx = x - c.x, dy = y - c.y, dz = z - c.z;
      const qx = c.qx, qy = c.qy, qz = c.qz, qw = c.qw;
      const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
      const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
      const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
      const lx = r00 * dx + r10 * dy + r20 * dz;
      const ly = r01 * dx + r11 * dy + r21 * dz;
      const lz = r02 * dx + r12 * dy + r22 * dz;
      const ex = c.ex, ez = c.ez;
      if (Math.abs(lx) > ex + margin) continue;
      if (Math.abs(lz) > ez + margin) continue;
      if (ly < c.lo - margin || ly > c.hi + margin) continue;
      if (!hit || c.size > hit.size) hit = c;
    }
    return hit;
  }

  /**
   * The D3 number, from wherever the camera is: the largest angular size any
   * rock presents. `reach / distance` above 1 is a rock whose own radius
   * exceeds its distance — a flat plane across the lens with no scale in it,
   * which is exactly what the player was shown.
   */
  worstSubtend(x, y, z) {
    let worst = 0, hit = null;
    for (let i = 0; i < this.n; i++) {
      const c = this.cand[i];
      const d = Math.hypot(x - c.x, y - (c.y + c.hi * 0.5), z - c.z);
      const s = Math.max(c.ex, c.ez) / Math.max(1, d);
      if (s > worst) { worst = s; hit = c; }
    }
    return { sub: worst, hit };
  }
}

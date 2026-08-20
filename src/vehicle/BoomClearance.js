// ─────────────────────────────────────────────────────────────────────────────
//  BoomClearance — the standing solids the chase boom has to get out of.
//
//  `CameraRig._boomFit` marched the boom against `max(getHeight, getWaterHeight)`
//  and shortened at the first sample that would be underground. A 15 m cliff
//  block is neither of those fields, and neither is a tree, so the boom went
//  straight through both. Two player-visible frames, one defect:
//
//    P2   `rock_cliff_2#0`, nearest face 1.7 m from the lens, 34 of 72 probe
//         rays, half the frame one flat grey facet with no scale in it.
//    —    a trunk floor to ceiling down the middle of the frame with four
//         branches across it, the camper a sliver in the lower right. The
//         near foliage around it was fading correctly; bark does not fade.
//
//  Two fields, and deliberately two *different* mechanisms, because the two
//  solids fail differently:
//
//    RockField    a floor. Rock is wide, low and opaque from above; the fit
//                 already consumes a floor, and a boom that meets a crag should
//                 ride over it the way it rides over a hill.
//    TrunkField   a retraction. A trunk is thin and tall. Lifting the camera
//                 over a 25 m spruce because the boom passed within a metre of
//                 its bole would be absurd, and *cutting* the boom at the first
//                 trunk it crosses would park the camera at 6 m for the whole
//                 of every forest — which is a feel regression, and is the
//                 problem `Occlusion.js`'s fade exists to solve. What the
//                 player was shown is an *endpoint* problem: a bole against
//                 the lens. So the boom retracts only as far as it must to put
//                 the camera itself out of the bole, and a trunk between the
//                 camper and a camera that is otherwise fine is left to fade.
//
//  Neither substitutes for the other, and neither substitutes for the fade.
//
//  ── the shape of the rock term ──────────────────────────────────────────────
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
//  Both fields are *interim* consumers, and both are written to be deleted. The
//  rocks author offered a `nearestRockSurface(x, z)` on the scatter rather than
//  have the extents reimplemented here; V1 in docs/INTEGRATION_REQUESTS.md asks
//  them and the trees author for one query shape that covers both solids.
//  `attach()` on either field prefers the owner's own method the moment it
//  exists.
//
//  Until then both read only *published* fields, read-only, optional-chained
//  throughout, and neither touches an InstancedMesh, a matrix or a raycast:
//
//    rocks.cells      64 m cells of instances — Rocks.js:64
//    rocks.library    the built geometries, for the bounding boxes that
//                     `archFootprints` itself reads
//    trees.trees      the bucketed placement table — Trees.js:721. The same
//                     table the rescue-site check already reads from
//                     `Vehicle._treeGap` (filed as R3), in the same way.
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

export class RockField {
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

// ─────────────────────────────────────────────────────────────────────────────
//  TrunkField — keep the lens out of a bole.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Air between the lens and the surface of a trunk, in metres.
 *
 * Not a collision radius — a camera that merely *touches* a 40 cm bole still
 * has that bole floor to ceiling across the middle of the frame, which is the
 * frame the player sent. It is the distance at which a trunk stops being the
 * subject of the shot.
 *
 * Swept over 2808 fitted booms in one page load, `camtree.mjs --keep`, scored
 * on a *fixed* 1 m threshold so the rows are comparable:
 *
 *     keep    0.6    0.9    1.1    1.2    1.3    1.5    1.8    2.4    3.2
 *     <1 m     78     34     15     15     16     20     24     38     59
 *     boom  0.939  0.936  0.934  0.931  0.928  0.922  0.913  0.888  0.846
 *
 * (arm off: 125.) The curve turns back up, and that is the interesting part:
 * asking for more air than this does not buy any. A large keep-out finds no
 * clear length at all in dense wood, the fit falls through to the 0.34 clamp,
 * and the camera sits close in beside the camper where trunks are unavoidable —
 * so over-reaching costs boom length *and* puts the lens back in the bark. 1.2
 * is the flat bottom, at 1.3% of mean boom length.
 */
export const TRUNK_KEEP = 1.2;

/**
 * How high above its own base a trunk stops being worth avoiding. Above the
 * crown there is nothing to hit, and a boom pitched down into a valley from
 * above the canopy must not be retracted by the treetops it is looking over.
 * As a fraction of the tree's drawn height: the bole is bare below the crown
 * and the crown itself is what the fade is for.
 */
export const TRUNK_TOP_K = 0.92;

export class TrunkField {
  constructor() {
    this.tx = []; this.tz = []; this.tr = []; this.tt = [];
    this.n = 0;
    this.trees = null;
    this.T = null;
    this.native = null;
  }

  /** @param trees the Trees *system*, not its table. */
  attach(trees) {
    if (trees !== this.trees) {
      this.trees = trees ?? null;
      this.native = typeof trees?.trunkRetract === 'function' ? trees : null;
      this.n = 0;
    }
    // Re-read the table every time: `Trees` rebuilds it, and holding the old
    // one would silently fit the boom against where the forest used to be.
    this.T = trees?.trees ?? null;
    return this;
  }

  /**
   * Collect the trunks within `radius` of (x, z).
   *
   * Straight off the Trees system's own bucketed placement table — a 64 m grid
   * with a prefix-summed index, so this touches a few dozen trees rather than
   * 120 000, and it sees trees currently drawn as far-field impostors too.
   * Same access, same defensiveness, as `Vehicle._treeGap`.
   */
  prime(x, z, radius) {
    this.n = 0;
    const T = this.T;
    if (!T?.n || !T.order || !T.bucketStart) return;
    const { px, py, pz, pscale, pImpH, order, bucketStart, BW, BS, half } = T;
    const bi = (v) => Math.min(BW - 1, Math.max(0, ((v + half) / BS) | 0));
    const bx0 = bi(x - radius), bx1 = bi(x + radius);
    const bz0 = bi(z - radius), bz1 = bi(z + radius);
    const r2 = (radius + 2) * (radius + 2);
    let n = 0;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bz * BW + bx;
        const end = bucketStart[b + 1];
        for (let i = bucketStart[b]; i < end; i++) {
          const t = order[i];
          const dx = px[t] - x, dz = pz[t] - z;
          if (dx * dx + dz * dz > r2) continue;
          this.tx[n] = px[t];
          this.tz[n] = pz[t];
          // Trunk, not crown. A prototype bole is ~0.35 m at scale 1 — the same
          // expression the rescue-site check uses, so the two agree about what
          // a trunk is. A per-tree radius from the species table would be
          // better and is what V1 asks for.
          this.tr[n] = 0.15 + 0.35 * (pscale?.[t] ?? 1);
          this.tt[n] = (py?.[t] ?? 0) + (pImpH?.[t] ?? 18) * TRUNK_TOP_K;
          n++;
        }
      }
    }
    this.n = n;
  }

  /**
   * The trunk this point is inside, counting `keep` metres of air. -1 if none.
   *
   * `list`/`ln` narrow it to a pre-selected subset — see `retract`.
   */
  hit(x, y, z, keep, list = null, ln = 0) {
    const n = list ? ln : this.n;
    for (let k = 0; k < n; k++) {
      const i = list ? list[k] : k;
      if (y > this.tt[i]) continue;
      const dx = x - this.tx[i], dz = z - this.tz[i];
      const r = this.tr[i] + keep;
      if (dx * dx + dz * dz < r * r) return i;
    }
    return -1;
  }

  /**
   * How much of the boom leaves the camera clear of every bole.
   *
   * Scans *inwards* from `maxT` and returns the first length whose endpoint is
   * out of the trunks — so a boom with a clear end is not touched at all, and
   * one that ends in a bole gives up the few metres that costs and no more. A
   * trunk zone is about 4 m across against a 19–68 m boom, so this is a small
   * retraction, and it is the reason this is not the floor mechanism: cutting
   * at the first trunk *crossed* would hold the camera at the 0.34 clamp for
   * the whole of every forest.
   *
   * Plan-only, and that is load-bearing: `_liftEnd` runs after this and only
   * ever raises the endpoint, which cannot move it into a trunk it was clear
   * of, and can only take it further above one.
   */
  retract(anchor, desired, keep, maxT = 1) {
    if (this.native) return this.native.trunkRetract(anchor, desired, keep, maxT);
    if (!this.n) return maxT;
    const dx = desired.x - anchor.x, dy = desired.y - anchor.y, dz = desired.z - anchor.z;
    const run = Math.hypot(dx, dz) * maxT;
    // 1 m, not the fit's 2 m: a bole is thin, and a step that straddles one
    // would hand back a length that is still inside it.
    const steps = Math.min(72, Math.max(6, Math.ceil(run / 1.0)));

    // Narrow to the trunks the boom could actually meet before stepping, once
    // per fit rather than once per step. `prime` collects an 80 m disc because
    // that is what the wheel can ask for; the boom is a line across it, and in
    // dense wood the difference is a few hundred trees against a handful.
    // Point-to-segment in plan, with the segment taken at full `maxT`.
    const near = this._near ?? (this._near = new Int32Array(256));
    const seg2 = dx * dx * maxT * maxT + dz * dz * maxT * maxT;
    let ln = 0;
    for (let i = 0; i < this.n && ln < near.length; i++) {
      const ax = this.tx[i] - anchor.x, az = this.tz[i] - anchor.z;
      let s = seg2 > 1e-6 ? (ax * dx * maxT + az * dz * maxT) / seg2 : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const px = ax - dx * maxT * s, pz = az - dz * maxT * s;
      const r = this.tr[i] + keep;
      if (px * px + pz * pz <= r * r) near[ln++] = i;
    }
    if (!ln) return maxT;

    for (let i = steps; i >= 1; i--) {
      const t = (maxT * i) / steps;
      if (this.hit(anchor.x + dx * t, anchor.y + dy * t, anchor.z + dz * t, keep, near, ln) < 0) return t;
    }
    return 0;
  }
}

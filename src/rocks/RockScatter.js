// ─────────────────────────────────────────────────────────────────────────────
//  RockScatter — where the rock actually goes.
//
//  Rocks are the one scatter layer that must look *caused*. A Poisson sprinkle
//  reads as decoration; a boulder train reads as geology. So nothing here picks
//  a position and asks "is this a valid rock spot" — it picks a position, asks
//  the world what geological process is happening there, and then emits the
//  cluster that process would leave behind:
//
//    riverbed  worn boulders in and beside the channel, partly drowned
//    talus     angular blocks fanning out below a cliff, biggest at the bottom
//    rib       a bedrock rib along a hard band: standing stones + slabs, in line
//    scree     frost-shattered rubble at altitude
//    erratic   a lone hero boulder with its scattered court, out in the meadow
//    cliff     ledges and overhangs driven into a face that is too steep to grass
//
//  Sizes inside a cluster follow a power law, so every field has one rock that
//  dominates it and a lot of rubble that reads as its debris.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, smoothstep, mulberry32, hash2i, bilinear } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Power-law size pick: many small, few large. `k` > 1 biases small. */
const powSize = (rng, lo, hi, k) => lo + (hi - lo) * Math.pow(rng(), k);

export class RockScatter {
  constructor(world, seed) {
    this.world = world;
    this.seed = seed >>> 0;
    this.noise = new NoiseField(seed ^ 0x0c0ffee);

    // Scratch — placement runs thousands of times, it must not allocate.
    this._n = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._qt = new THREE.Quaternion();
    this._ax = new THREE.Vector3();
  }

  hardness(x, z) {
    const W = this.world;
    const gx = (x + W.half) * W.invTexel;
    const gz = (z + W.half) * W.invTexel;
    return bilinear(W.hardness, W.res, W.res, gx, gz);
  }

  /** Uphill unit direction in XZ, plus how cliff-like the ground above is. */
  _uphill(x, z, out) {
    const W = this.world;
    W.getNormal(x, z, this._n, 2.0);
    let ux = -this._n.x, uz = -this._n.z;
    const L = Math.hypot(ux, uz);
    if (L < 1e-4) { out.x = 0; out.z = 0; return 0; }
    ux /= L; uz /= L;
    out.x = ux; out.z = uz;
    // Look up the hill for a genuine cliff band, not just "a bit steep".
    let maxSlope = 0;
    for (const d of [12, 26, 44]) {
      const s = W.getSlope(x + ux * d, z + uz * d);
      if (s > maxSlope) maxSlope = s;
    }
    return maxSlope;
  }

  /**
   * Which geological process is operating here? Returns a kind + strength, or
   * null. Order matters: water beats slope beats altitude beats "just meadow".
   */
  classify(x, z, up) {
    const W = this.world;
    const h = W.getHeight(x, z);
    const slope = W.getSlope(x, z);
    const river = W.getRiver(x, z);
    const depth = W.getWaterDepth(x, z);
    const hard = this.hardness(x, z);

    if (slope > 1.95) return { kind: 'cliff', s: clamp01((slope - 1.95) * 0.9), h, slope, hard };

    if (river > 0.05 || depth > 0.02) {
      return { kind: 'riverbed', s: clamp01(river * 2.2 + 0.35), h, slope, hard };
    }

    const cliffAbove = this._uphill(x, z, up);
    if (slope > 0.5 && slope < 2.1 && cliffAbove > 2.0) {
      return { kind: 'talus', s: clamp01((cliffAbove - 2.0) * 0.8) * clamp01(1.6 - slope * 0.5), h, slope, hard };
    }

    if (h > 195 && slope > 0.45) {
      return { kind: 'scree', s: smoothstep(195, 275, h) * clamp01(slope * 0.8), h, slope, hard };
    }

    if (hard > 0.74 && slope > 0.42) {
      return { kind: 'rib', s: smoothstep(0.74, 0.95, hard) * clamp01(slope * 0.7), h, slope, hard };
    }

    // Erratics only where a low-frequency field says "boulder field". This is
    // the mask that stops the meadow reading as evenly sprinkled gravel.
    const field = this.noise.fbm(x * 0.0034, z * 0.0034, 3, 2.1, 0.5, 1) * 0.5 + 0.5
                + this.noise.fbm(x * 0.011, z * 0.011, 2, 2.0, 0.5, 1) * 0.22;
    const m = smoothstep(0.50, 0.80, field);
    if (m > 0.02 && slope < 0.95) return { kind: 'erratic', s: m, h, slope, hard };
    return null;
  }

  /**
   * Generate every rock in one cell. `minSize` culls the small stuff for cells
   * far from the camera — those instances would never be visible anyway and
   * generating them is the bulk of the cost.
   */
  generateCell(cx, cz, cellSize, minSize, out) {
    const W = this.world;
    const rng = mulberry32(((hash2i(cx, cz, this.seed ^ 0x5eed) * 4294967296) | 0) >>> 0);
    const ox = cx * cellSize, oz = cz * cellSize;
    const up = { x: 0, z: 0 };

    // Four candidate sites per cell; each that lands on an active process
    // becomes a cluster. Cells that land on nothing stay genuinely empty —
    // negative space is what makes the populated ground read as deliberate.
    for (let i = 0; i < 6; i++) {
      const x = ox + rng() * cellSize;
      const z = oz + rng() * cellSize;
      if (!W.isInBounds(x, z)) continue;
      const c = this.classify(x, z, up);
      if (!c) continue;
      if (rng() > Math.sqrt(c.s)) continue;
      this._cluster(x, z, c, up, rng, minSize, out);
    }
  }

  _cluster(x, z, c, up, rng, minSize, out) {
    switch (c.kind) {
      case 'riverbed': return this._clusterRiver(x, z, c, rng, minSize, out);
      case 'talus':    return this._clusterTalus(x, z, c, up, rng, minSize, out);
      case 'rib':      return this._clusterRib(x, z, c, up, rng, minSize, out);
      case 'scree':    return this._clusterScree(x, z, c, rng, minSize, out);
      case 'erratic':  return this._clusterErratic(x, z, c, rng, minSize, out);
      case 'cliff':    return this._clusterCliff(x, z, c, rng, minSize, out);
      default: return;
    }
  }

  // ── cluster shapes ─────────────────────────────────────────────────────────

  /** Rapids: big framing slabs on the banks, worn cobbles in the channel. */
  _clusterRiver(x, z, c, rng, minSize, out) {
    const W = this.world;
    const n = 6 + ((rng() * 12) | 0);
    const R = 9 + rng() * 16;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = R * Math.sqrt(rng());
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      const river = W.getRiver(px, pz);
      const depth = W.getWaterDepth(px, pz);
      if (river < 0.02 && depth <= 0) continue;
      const slope = W.getSlope(px, pz);
      if (slope > 1.9) continue;

      const roll = rng();
      let arch, size;
      if (roll < 0.10 && depth < 0.9) { arch = 'slab'; size = powSize(rng, 1.3, 3.4, 1.5); }
      else if (roll < 0.20) { arch = 'hero'; size = powSize(rng, 1.6, 2.8, 1.8); }
      else if (roll < 0.55) { arch = 'boulder'; size = powSize(rng, 0.55, 1.9, 2.0); }
      else { arch = 'rubble'; size = powSize(rng, 0.16, 0.62, 1.8); }
      if (size * 2 < minSize) continue;
      // Water-worn rock lies on its flattest face and barely tips.
      this._place(px, pz, arch, size, rng, 0.30, 0.10, out);
    }
  }

  /** Talus fan: blocks get bigger and sparser toward the bottom of the run-out. */
  _clusterTalus(x, z, c, up, rng, minSize, out) {
    const W = this.world;
    const n = 10 + ((rng() * 16) | 0);
    const R = 12 + rng() * 20;
    for (let i = 0; i < n; i++) {
      // Elongate the cluster downhill — a fan, not a disc.
      const t = rng();
      const spread = (rng() * 2 - 1) * R * 0.55;
      const along = -(0.1 + t * 1.5) * R;          // negative = downhill
      const px = x + up.x * along - up.z * spread;
      const pz = z + up.z * along + up.x * spread;
      if (!W.isInBounds(px, pz)) continue;
      const slope = W.getSlope(px, pz);
      if (slope > 2.3) continue;
      if (W.getWaterDepth(px, pz) > 0.4) continue;

      // Big blocks roll furthest — the classic sorted talus slope.
      const big = t * t;
      const roll = rng();
      let arch, size;
      if (roll < 0.14 + big * 0.24) { arch = 'talus'; size = powSize(rng, 0.7, 1.1 + big * 2.4, 1.4); }
      else if (roll < 0.32) { arch = 'slab'; size = powSize(rng, 0.5, 1.0 + big * 1.6, 1.6); }
      else { arch = 'rubble'; size = powSize(rng, 0.14, 0.42 + big * 0.4, 1.7); }
      if (size * 2 < minSize) continue;
      this._place(px, pz, arch, size, rng, 0.55, 0.55, out);
    }
  }

  /** Bedrock rib: a line of outcrop following the strike of the hard band. */
  _clusterRib(x, z, c, up, rng, minSize, out) {
    const W = this.world;
    // Strike runs across the slope, so walk perpendicular to uphill.
    let sx = -up.z, sz = up.x;
    if (Math.abs(sx) + Math.abs(sz) < 0.1) { sx = 1; sz = 0; }
    const n = 5 + ((rng() * 8) | 0);
    const step = 4 + rng() * 7;
    let px = x, pz = z;
    for (let i = 0; i < n; i++) {
      px += sx * step + (rng() * 2 - 1) * 3.5;
      pz += sz * step + (rng() * 2 - 1) * 3.5;
      if (!W.isInBounds(px, pz)) break;
      if (this.hardness(px, pz) < 0.6) break;      // the rib ends with the band
      if (W.getWaterDepth(px, pz) > 0.3) continue;

      const roll = rng();
      let arch, size;
      if (roll < 0.42) { arch = 'standing'; size = powSize(rng, 0.55, 1.9, 1.5); }
      else if (roll < 0.75) { arch = 'slab'; size = powSize(rng, 0.7, 2.4, 1.6); }
      else { arch = 'rubble'; size = powSize(rng, 0.18, 0.55, 1.7); }
      if (size * 2 < minSize) continue;
      this._place(px, pz, arch, size, rng, 0.42, 0.18, out);
      // A little debris apron at the foot of each outcrop.
      if (rng() < 0.55) {
        const a = rng() * Math.PI * 2, r = size * (1.4 + rng() * 2.2);
        const dx = px + Math.cos(a) * r, dz = pz + Math.sin(a) * r;
        if (W.isInBounds(dx, dz) && 0.5 >= minSize * 0.5) {
          this._place(dx, dz, 'rubble', powSize(rng, 0.14, 0.4, 1.6), rng, 0.6, 0.6, out);
        }
      }
    }
  }

  /** Frost-shattered scree at altitude: dense, small, angular, uniform-ish. */
  _clusterScree(x, z, c, rng, minSize, out) {
    const W = this.world;
    const n = 14 + ((rng() * 20) | 0);
    const R = 10 + rng() * 18;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = R * Math.sqrt(rng());
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      if (W.getSlope(px, pz) > 2.2) continue;
      const roll = rng();
      let arch, size;
      if (roll < 0.10) { arch = 'talus'; size = powSize(rng, 0.6, 1.7, 1.6); }
      else if (roll < 0.20) { arch = 'slab'; size = powSize(rng, 0.5, 1.3, 1.6); }
      else { arch = 'rubble'; size = powSize(rng, 0.12, 0.46, 1.6); }
      if (size * 2 < minSize) continue;
      this._place(px, pz, arch, size, rng, 0.6, 0.7, out);
    }
  }

  /** Glacial erratic in the meadow: one hero and its court. */
  _clusterErratic(x, z, c, rng, minSize, out) {
    const W = this.world;
    const heroSize = powSize(rng, 1.6, 4.4, 1.7) * (0.6 + c.s * 0.6);
    if (heroSize * 2 >= minSize && W.getWaterDepth(x, z) < 0.3) {
      this._place(x, z, rng() < 0.62 ? 'hero' : 'boulder', heroSize, rng, 0.22, 0.10, out);
    }
    const n = 2 + ((rng() * 7 * c.s) | 0);
    const R = heroSize * 2.4 + 6 + rng() * 14;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = heroSize * 1.6 + R * Math.sqrt(rng());
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      if (W.getWaterDepth(px, pz) > 0.3) continue;
      if (W.getSlope(px, pz) > 1.6) continue;
      const roll = rng();
      let arch, size;
      if (roll < 0.32) { arch = 'boulder'; size = powSize(rng, 0.5, 1.8, 1.8); }
      else if (roll < 0.50) { arch = 'slab'; size = powSize(rng, 0.6, 2.0, 1.8); }
      else { arch = 'rubble'; size = powSize(rng, 0.14, 0.5, 1.8); }
      if (size * 2 < minSize) continue;
      this._place(px, pz, arch, size, rng, 0.28, 0.16, out);
    }
  }

  /**
   * Cliff relief. The terrain shader alone paints a steep slope as a smooth
   * ramp; these blocks give it ledges, overhangs and a broken silhouette.
   * They are deliberately half-buried — only the protruding part is the point.
   */
  _clusterCliff(x, z, c, rng, minSize, out) {
    const W = this.world;
    const n = 4 + ((rng() * 8) | 0);
    const R = 8 + rng() * 18;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = R * Math.sqrt(rng());
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      const slope = W.getSlope(px, pz);
      if (slope < 1.5) continue;

      const roll = rng();
      let arch, size, sink;
      if (roll < 0.55) { arch = 'ledge'; size = powSize(rng, 1.2, 4.0, 1.3); sink = 0.30; }
      else if (roll < 0.80) { arch = 'slab'; size = powSize(rng, 0.9, 2.8, 1.4); sink = 0.34; }
      else { arch = 'standing'; size = powSize(rng, 0.7, 2.0, 1.5); sink = 0.28; }
      if (size * 2 < minSize) continue;
      // Aligned hard to the face so the block reads as a ledge cut out of it.
      this._place(px, pz, arch, size, rng, 0.88, 0.12, out, sink);
    }
  }

  // ── the single placement routine ───────────────────────────────────────────

  /**
   * @param align  0 = stands upright regardless of ground, 1 = lies flush to it
   * @param tumble extra random tip, in radians-ish; fractured blocks tumble
   * @param sink   fraction of the rock's own radius to bury below the lowest
   *               ground sample under its footprint. The min-of-samples is what
   *               guarantees nothing ever hovers on a convex ridge.
   */
  _place(x, z, arch, size, rng, align, tumble, out, sink = 0.14) {
    const W = this.world;
    const n = this._n;
    W.getNormal(x, z, n, Math.max(1.0, size * 0.8));

    // Lowest ground under the footprint.
    let minH = W.getHeight(x, z);
    const fr = size * 0.85;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      const hh = W.getHeight(x + Math.cos(a) * fr, z + Math.sin(a) * fr);
      if (hh < minH) minH = hh;
    }

    const up = this._up.set(0, 1, 0).lerp(n, align).normalize();
    const q = this._q.setFromUnitVectors(UP, up);
    this._qy.setFromAxisAngle(UP, rng() * Math.PI * 2);
    q.multiply(this._qy);
    if (tumble > 0) {
      const a = rng() * Math.PI * 2;
      this._ax.set(Math.cos(a), 0, Math.sin(a));
      this._qt.setFromAxisAngle(this._ax, (rng() * 2 - 1) * tumble);
      q.multiply(this._qt);
    }

    const depth = W.getWaterDepth(x, z);
    const river = W.getRiver(x, z);
    const waterY = W.getWaterHeight(x, z);
    const h = W.getHeight(x, z);

    out.push({
      x, y: minH - size * sink, z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      sx: size * (0.86 + rng() * 0.30),
      sy: size * (0.84 + rng() * 0.34),
      sz: size * (0.86 + rng() * 0.30),
      arch,
      variant: 0,                       // assigned by the caller from the library
      size,
      wet: clamp01(depth * 1.4 + river * 0.30),
      moisture: W.getMoisture(x, z),
      tint: rng() * 2 - 1,
      waterY: waterY === null ? -9999 : waterY,
      frost: smoothstep(200, 285, h),
      // Visible radius: heroes carry for half a kilometre, cobbles do not
      // survive past the near field. This is most of the perf story.
      vis: clamp(size * 210, 85, 780),
      rnd: rng(),
    });
  }
}

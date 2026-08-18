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
//    crag      stepped bench courses and ridge towers that give a mountain a
//              broken silhouette instead of a smooth painted ramp
//
//  Sizes inside a cluster follow a power law, so every field has one rock that
//  dominates it and a lot of rubble that reads as its debris.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, smoothstep, mulberry32, hash2i, bilinear } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Metres of draw distance per metre of rock radius. Rocks.js reads this too.
 *
 * This number is an *art* control, not a perf one. At 190 a 1.5 m cobble was
 * still drawn 280 m away, where it is four pixels of near-white on a hazed
 * hillside — the reference has nothing like that, and en masse it read as
 * popcorn sprinkled on the mountain. 95 puts the cutoff at roughly "you can
 * still tell it is a rock", and the far field is then composed of the big
 * masses only, which is what the plates actually show.
 */
export const VIS_PER_METRE = 95;

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

  /**
   * Local convexity, in slope units: positive on ridges and spurs, negative in
   * gullies. This is the single measurement that lets a crag be placed where it
   * will actually break the skyline rather than be seen against more hillside.
   */
  convexity(x, z, r) {
    const W = this.world;
    const h = W.getHeight(x, z);
    let sum = 0;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.37;
      sum += W.getHeight(x + Math.cos(a) * r, z + Math.sin(a) * r);
    }
    return (h - sum / 6) / r;
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

    if (river > 0.05 || depth > 0.02) {
      return { kind: 'riverbed', s: clamp01(river * 2.2 + 0.35), h, slope, hard };
    }

    // ── the mountain ─────────────────────────────────────────────────────────
    // Everything above here is local. Everything below decides whether this is
    // a spot where bedrock is *exposed*, and the answer has to be "no" over
    // most of a hillside. The first pass said yes to every steep pixel above
    // 110 m and the result was an even sprinkle of small blocks over the whole
    // massif — the exact anti-pattern the brief calls an instant reject.
    //
    // Two masks fix that. `bed` is a stratigraphic band: a smooth function of
    // *altitude* warped by a little noise, thresholded so exposure happens in a
    // few horizontal courses with bare slope between them, the way a resistant
    // bed weathers out. `strength` then ties the amount of rock to bedrock
    // hardness, so the bands sit where the terrain author's geology put them.
    if (slope > 0.55 && h > 60) {
      const conv = this.convexity(x, z, 34);
      // Ridges and spurs: rock in the sky. Weighted hard because this is the
      // only placement that can change the mountain's silhouette.
      const ridge = smoothstep(0.045, 0.22, conv);

      const warp = this.noise.fbm(x * 0.0026, z * 0.0026, 3, 2.1, 0.5, 3) * 26;
      const band = Math.abs(Math.sin((h + warp) * 0.062));
      const bed = smoothstep(0.55, 0.93, band);

      const hardM = smoothstep(0.34, 0.80, hard);
      const steep = smoothstep(0.55, 1.35, slope);
      const alt = smoothstep(60, 150, h);

      // A ridge crest is allowed to carry rock regardless of the bedding band —
      // the crest is where a bed is cut through, so it is always exposed.
      const expose = clamp01(Math.max(bed * 0.85, ridge) * (0.35 + hardM * 0.85));
      const s = expose * steep * (0.30 + alt * 0.70);
      if (s > 0.06) {
        return { kind: 'crag', s, h, slope, hard, ridge, conv };
      }
    }

    const cliffAbove = this._uphill(x, z, up);
    if (slope > 0.5 && slope < 2.1 && cliffAbove > 1.7) {
      return { kind: 'talus', s: clamp01((cliffAbove - 1.7) * 0.9) * clamp01(1.6 - slope * 0.5), h, slope, hard };
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
    const m = smoothstep(0.55, 0.84, field);
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

    // Five candidate sites per cell; each that lands on an active process
    // becomes a cluster. Cells that land on nothing stay genuinely empty —
    // negative space is what makes the populated ground read as deliberate.
    //
    // Crags get a hard rate limit on top of that: at most one group per 64 m
    // cell, and only in a minority of eligible cells. A crag is a landmark and
    // has to be surrounded by bare hillside to read as one; letting every
    // eligible site fire covered the massif in a rash of blocks that looked
    // like dragon's teeth rather than like broken bedrock.
    let cragDone = false;
    for (let i = 0; i < 5; i++) {
      const x = ox + rng() * cellSize;
      const z = oz + rng() * cellSize;
      if (!W.isInBounds(x, z)) continue;
      const c = this.classify(x, z, up);
      if (!c) continue;
      if (c.kind === 'crag') {
        if (cragDone) continue;
        // Ridge sites are strongly favoured: those are the ones that can put
        // rock against the sky, which is the only reason this exists.
        if (rng() > 0.05 + c.ridge * 0.20) continue;
        cragDone = true;
      } else if (rng() > Math.sqrt(c.s)) continue;
      this._cluster(x, z, c, up, rng, minSize, out);
    }
  }

  _cluster(x, z, c, up, rng, minSize, out) {
    this._kind = c.kind;          // tagged onto every instance, for debugging
    switch (c.kind) {
      case 'riverbed': return this._clusterRiver(x, z, c, rng, minSize, out);
      case 'talus':    return this._clusterTalus(x, z, c, up, rng, minSize, out);
      case 'rib':      return this._clusterRib(x, z, c, up, rng, minSize, out);
      case 'scree':    return this._clusterScree(x, z, c, rng, minSize, out);
      case 'erratic':  return this._clusterErratic(x, z, c, rng, minSize, out);
      case 'crag':     return this._clusterCrag(x, z, c, up, rng, minSize, out);
      default: return;
    }
  }

  // ── cluster shapes ─────────────────────────────────────────────────────────

  /** Rapids: big framing slabs on the banks, worn cobbles in the channel. */
  _clusterRiver(x, z, c, rng, minSize, out) {
    const W = this.world;
    const n = 5 + ((rng() * 10) | 0);
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
      if (roll < 0.20 && depth < 0.9) { arch = 'slab'; size = powSize(rng, 1.6, 5.2, 1.5); }
      else if (roll < 0.28) { arch = 'hero'; size = powSize(rng, 2.2, 4.6, 1.7); }
      else if (roll < 0.62) { arch = 'boulder'; size = powSize(rng, 0.5, 3.0, 1.8); }
      else { arch = 'rubble'; size = powSize(rng, 0.12, 0.50, 2.0); }
      if (size * 2 < minSize) continue;
      // A rock that never breaks the surface is invisible and still costs a
      // draw. Rather than delete the whole channel, grow whatever the river
      // gives us until it stands proud of the water; only true pools stay bare.
      if (depth > 0.05) {
        if (depth > 2.4) continue;
        size = Math.max(size, depth * 1.15 + 0.25);
      }
      // Water-worn rock lies on its flattest face and barely tips.
      this._place(px, pz, arch, size, rng, 0.30, 0.10, out, depth > 0.05 ? 0.06 : 0.14);
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
    const heroSize = powSize(rng, 1.6, 7.2, 2.1) * (0.62 + c.s * 0.62);
    if (heroSize * 2 >= minSize && W.getWaterDepth(x, z) < 0.3) {
      // The compound hero mesh is the most expensive thing this system draws;
      // it is reserved for genuinely house-sized erratics.
      const arch = (heroSize > 2.8 && rng() < 0.55) ? 'hero' : 'boulder';
      this._place(x, z, arch, heroSize, rng, 0.22, 0.10, out);
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
   * Crag. The biggest job this system has: the terrain shader alone paints a
   * 40-degree massif as one smooth ramp, and a smooth ramp is what makes the
   * `peaks` and `hero` views look like dunes.
   *
   * Two forms, because a mountain shows two:
   *
   *   crest   towers and blades ON the ridge line, tall enough to punch a
   *           notch in the horizon. Silhouette is the entire point — a crag
   *           you can only see against more hillside does nothing.
   *   band    a stepped course of bench blocks running along the strike, each
   *           overlapping its neighbour so the chain reads as one continuous
   *           broken rock face rather than as a row of separate boulders.
   *
   * Both are sized in *tens* of metres. The previous pass used 2-4 m blocks
   * here and from 300 m they were four white pixels each — popcorn.
   */
  _clusterCrag(x, z, c, up, rng, minSize, out) {
    // Strike runs across the slope. On a crest the gradient points down the
    // flank, so the same vector conveniently runs along the ridge.
    let sx = -up.z, sz = up.x;
    if (Math.abs(sx) + Math.abs(sz) < 0.1) { sx = 1; sz = 0; }

    // Harder bedrock, bigger crag: this is what ties the outcrops to the
    // terrain author's geology instead of scattering them at random.
    //
    // The absolute number matters more than anything else here. A mountain is
    // 800 m of screen; an 8 m block on it is one percent of that and reads as
    // a chip of gravel no matter how well it is shaded. These are sized in
    // *tens* of metres so that a crag changes the mountain's shape.
    const scale = (6.0 + c.hard * 8.0 + c.s * 5.0) * (0.72 + rng() * 0.60);

    // Crests are strongly preferred. Rock on a flank is decoration; rock on a
    // crest is the mountain's outline, and the outline is what the peaks and
    // hero views are actually judged on.
    if (c.ridge > 0.22 && rng() < 0.55 + c.ridge * 0.45) {
      this._cragCrest(x, z, c, sx, sz, scale, rng, minSize, out);
    } else if (c.slope > 1.15) {
      this._cragBand(x, z, c, up, sx, sz, scale * 0.75, rng, minSize, out);
    }
  }

  /** Towers and blades along a ridge crest. */
  _cragCrest(x, z, c, sx, sz, scale, rng, minSize, out) {
    const W = this.world;
    const n = 2 + ((rng() * 3) | 0);
    // Spacing under one body-width: neighbours interpenetrate, so the group
    // resolves as one continuous rocky spine with notches in it. Spaced out,
    // the same towers read as a picket fence.
    const step = scale * (0.85 + rng() * 0.55);
    // Start behind the site so the group straddles it rather than trailing off.
    let px = x - sx * step * n * 0.4, pz = z - sz * step * n * 0.4;

    for (let i = 0; i < n; i++) {
      px += sx * step + (rng() * 2 - 1) * scale * 0.5;
      pz += sz * step + (rng() * 2 - 1) * scale * 0.5;
      if (!W.isInBounds(px, pz)) break;
      // Follow the crest: if we have wandered off it, the group ends. That is
      // what keeps a tower line reading as one landform.
      if (this.convexity(px, pz, 30) < 0.012) break;
      if (W.getWaterDepth(px, pz) > 0.3) break;

      // A tapering profile — tallest near the middle — so the group has a peak
      // instead of being a picket fence.
      const t = 1 - Math.abs((i + 0.5) / n - 0.5) * 1.7;
      const size = scale * (0.55 + t * 0.75) * (0.8 + rng() * 0.5);
      if (size * 2 < minSize) continue;

      // Mostly bench mass with the occasional tower on top of it. A crest of
      // pure towers is a graveyard; the bench is the rock the towers stand on.
      const roll = rng();
      const arch = roll < 0.30 ? 'tower' : 'bench';
      // align 0 keeps towers vertical: a tower tipped to the slope normal is a
      // leaning slab, and a whole crest of them looks like a landslide.
      // 'min' samples the lowest ground under the footprint. On a crest that
      // is the only thing that stops a block hovering: the rendered terrain
      // LOD sags below the true height exactly at a ridge, so a centre sample
      // leaves the block standing on air from a few hundred metres away.
      // Tumble: a bench sitting dead level shows the camera one broad flat
      // top, and from above a broad flat sunlit plane reads as a paving slab
      // or a patch of snow. Tipping it puts a vertical face in view.
      this._place(px, pz, arch, size, rng, arch === 'tower' ? 0.05 : 0.14,
        arch === 'tower' ? 0.10 : 0.34, out, arch === 'tower' ? 0.16 : 0.10, 'min', 0.0);

      // Blocks calved off the tower, resting against its foot.
      if (rng() < 0.35) {
        const a = rng() * Math.PI * 2, r = size * (1.1 + rng() * 1.1);
        const dx = px + Math.cos(a) * r, dz = pz + Math.sin(a) * r;
        const ds = size * (0.30 + rng() * 0.34);
        if (W.isInBounds(dx, dz) && ds * 2 >= minSize) {
          this._place(dx, dz, rng() < 0.5 ? 'talus' : 'bench', ds, rng, 0.5, 0.5, out, 0.30);
        }
      }
    }
  }

  /**
   * A course of bench blocks along the strike. Spacing is deliberately less
   * than the block width so neighbours interpenetrate — the union of the chain
   * is the shape we want, and gaps between blocks are what made the first pass
   * read as scattered boulders rather than as a cliff.
   */
  _cragBand(x, z, c, up, sx, sz, scale, rng, minSize, out) {
    const W = this.world;
    const courses = 1 + ((rng() * 3) | 0);
    // Each course sits below the last by roughly its own height, so the face
    // steps: bench, drop, bench. That stepping is the silhouette.
    let ox = x, oz = z;

    for (let cIdx = 0; cIdx < courses; cIdx++) {
      const cScale = scale * (1 - cIdx * 0.16);
      const n = 3 + ((rng() * 5) | 0);
      const step = cScale * (1.05 + rng() * 0.45);
      let px = ox - sx * step * n * 0.4 + (rng() * 2 - 1) * cScale;
      let pz = oz - sz * step * n * 0.4 + (rng() * 2 - 1) * cScale;

      for (let i = 0; i < n; i++) {
        px += sx * step;
        pz += sz * step;
        // Wander a little up and down the face or the course reads as a drawn
        // line, which is the exact failure the terrain author hit with painted
        // fracture seams.
        const drift = (rng() * 2 - 1) * cScale * 0.55;
        px += up.x * drift; pz += up.z * drift;
        if (!W.isInBounds(px, pz)) break;
        const slope = W.getSlope(px, pz);
        if (slope < 0.80) break;                    // the band dies on the bench
        if (W.getWaterDepth(px, pz) > 0.5) break;

        const size = cScale * (0.62 + rng() * 0.62);
        if (size * 2 < minSize) continue;
        const roll = rng();
        const arch = roll < 0.58 ? 'bench' : (roll < 0.80 ? 'ledge' : (roll < 0.93 ? 'slab' : 'tower'));
        // Near-horizontal, anchored at the centre sample and pushed slightly
        // into the hill. On a steep face that buries the uphill half and
        // leaves the downhill half standing out over air — an overhang.
        this._place(px, pz, arch, size, rng,
          arch === 'tower' ? 0.06 : 0.16 + rng() * 0.18, 0.13, out, 0.10, 'centre', 0.22);
      }

      // Drop to the next course, down the fall line.
      const drop = scale * (1.6 + rng() * 1.6);
      ox -= up.x * drop; oz -= up.z * drop;
      if (!W.isInBounds(ox, oz) || W.getSlope(ox, oz) < 0.5) break;
    }

    // Debris apron on the ground below the band. Sized off the band, so a big
    // crag sheds big blocks — the size hierarchy has to survive downhill.
    const nd = 3 + ((rng() * 6) | 0);
    for (let i = 0; i < nd; i++) {
      const along = scale * (2.0 + rng() * 5.0);
      const across = (rng() * 2 - 1) * scale * 2.6;
      const dx = x - up.x * along - up.z * across;
      const dz = z - up.z * along + up.x * across;
      if (!W.isInBounds(dx, dz)) continue;
      if (W.getWaterDepth(dx, dz) > 0.4) continue;
      const ds = scale * powSize(rng, 0.10, 0.52, 1.7);
      if (ds * 2 < minSize) continue;
      this._place(dx, dz, rng() < 0.55 ? 'talus' : 'rubble', ds, rng, 0.6, 0.7, out, 0.26);
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
  _place(x, z, arch, size, rng, align, tumble, out, sink = 0.14, mode = 'min', shove = 0) {
    const W = this.world;
    const n = this._n;
    W.getNormal(x, z, n, Math.max(1.0, size * 0.8));

    // Push the rock back into the hill so only its outer part protrudes.
    if (shove > 0) {
      const L = Math.hypot(n.x, n.z);
      if (L > 1e-4) { x -= (n.x / L) * size * shove; z -= (n.z / L) * size * shove; }
    }

    let minH;
    if (mode === 'centre') {
      // On a steep face the lowest sample under the footprint is metres below
      // the centre, so min-of-samples would bury the block completely.
      minH = W.getHeight(x, z);
    } else {
      // Lowest ground under the footprint: guarantees nothing hovers on a ridge.
      minH = W.getHeight(x, z);
      const fr = size * 0.85;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const hh = W.getHeight(x + Math.cos(a) * fr, z + Math.sin(a) * fr);
        if (hh < minH) minH = hh;
      }
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
      kind: this._kind,
      variant: 0,                       // assigned by the caller from the library
      size,
      wet: clamp01(depth * 1.4 + river * 0.30),
      moisture: W.getMoisture(x, z),
      tint: rng() * 2 - 1,
      waterY: waterY === null ? -9999 : waterY,
      frost: smoothstep(200, 285, h),
      // Visible radius. Paired with Rocks._minSizeFor: a cell far away is only
      // asked for rocks big enough that this radius still reaches the camera,
      // so nothing is ever generated that cannot be seen.
      vis: clamp(size * VIS_PER_METRE, 80, 900),
      rnd: rng(),
    });
  }
}

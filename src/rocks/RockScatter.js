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
 * popcorn sprinkled on the mountain.
 *
 * 88 rather than 95 because the crag work raised the *count* of mid-sized rock
 * in the mountains: at 95 a 12 m crag block still drew at 1.1 km, and the
 * massif behind the `meadow` anchor came back covered in an even rash of pale
 * rectangles — a chain only reads as a cliff while its blocks are bigger than a
 * few pixels, and past that it reads as noise. 78 was tried and cost `peaks`
 * its bands, which sit 600-900 m out; 88 keeps those and still drops anything
 * under ~15 m past a kilometre.
 */
export const VIS_PER_METRE = 88;

/**
 * Crag siting grid, as a power of two in scatter cells. At CELL = 64 m,
 * CRAG_SHIFT 1 means one crag landform per 128 m square at most.
 *
 * 256 m was tried and leaves the `hero` and `peaks` massifs bare: a mountain
 * flank 600 m across then gets two crag systems or none depending on a hash.
 * The rash that 128 m appeared to cause turned out to be a *distance* problem
 * rather than a density one — it was the far massif behind the `meadow` anchor
 * at 1.3 km, where a chain is a row of five-pixel dots. That is now handled
 * where it belongs, by the visibility cutoff (see VIS_PER_METRE and the vis
 * clamp in `_place`), which leaves this free to give the mountains you can
 * actually see a continuous banded face.
 */
const CRAG_SHIFT = 1;
const CRAG_BLOCK = 1 << CRAG_SHIFT;

/**
 * How exposed the bedrock has to be before a site becomes a crag. See
 * `classify` for what feeds `s` — bedding band, hardness, steepness, altitude.
 */
const CRAG_MIN_STRENGTH = 0.30;

/** Power-law size pick: many small, few large. `k` > 1 biases small. */
const powSize = (rng, lo, hi, k) => lo + (hi - lo) * Math.pow(rng(), k);

/**
 * Where the ground is probed under a crag block's base: the four corners of the
 * footprint, the four edge midpoints and the centre, as fractions of the
 * block's own half-extents. Corners alone miss a hummock under the middle of a
 * thirty-metre wall.
 */
const BASE_SAMPLES = [
  -1, -1, 1, -1, 1, 1, -1, 1,
  -1, 0, 1, 0, 0, -1, 0, 1,
  0, 0,
];

/**
 * Extra metres of burial past bare contact. Small on purpose: this is only
 * absorbing how far the drawn LOD mesh sags below the heightfield (measured at
 * 0.2–0.6 m mean, 6.4 m worst at 800 m) plus enough to put the ground line
 * across the block's face instead of exactly on its bottom edge.
 */
const CONTACT_MARGIN = 2.0;

/**
 * How many of the nine base probes may stay above ground. An overhanging corner
 * is cliff-like; an overhanging half is a crate on a hillside.
 */
const BASE_TOLERATE = 0;

/**
 * Deepest a crag block is planted, as a multiple of its own size. A block is
 * roughly 1.5 sizes tall, so this leaves at least a third of it out of the hill
 * however broken the ground under it is.
 */
const MAX_PLANT = 1.0;

/** Used until `Rocks` hands over the real per-archetype bounds. */
const FOOT_FALLBACK = { rx: 1.3, rz: 1.3, yLo: -0.7 };

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
    this._fv = new THREE.Vector3();
    this._req = new Float64Array(BASE_SAMPLES.length / 2);

    // Per-archetype local bounds, handed over by `Rocks` once the mesh library
    // is built (see `archFootprints`). Placement needs them to know how far a
    // block reaches from its origin before it can decide how deep to plant it.
    this._foot = {};
  }

  /** @param foot arch -> { rx, rz, yLo } in local units, from `archFootprints`. */
  setFootprints(foot) { this._foot = foot ?? {}; }

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
    // 95 m, not 60. At 60 the near hills either side of the valley qualified,
    // and a hillside 200 m from the road covered in house-sized blocks is not
    // cliff relief, it is a rockfall — it read as an avalanche of pale crates
    // across the foreground of `hero`. Crag is the *mountain's* form; below the
    // treeline the erratic and rib clusters are the right vocabulary.
    if (slope > 0.62 && h > 95) {
      const conv = this.convexity(x, z, 34);
      // Ridges and spurs: rock in the sky. Weighted hard because this is the
      // only placement that can change the mountain's silhouette.
      const ridge = smoothstep(0.045, 0.22, conv);

      const warp = this.noise.fbm(x * 0.0026, z * 0.0026, 3, 2.1, 0.5, 3) * 26;
      const band = Math.abs(Math.sin((h + warp) * 0.062));
      const bed = smoothstep(0.55, 0.93, band);

      const hardM = smoothstep(0.34, 0.80, hard);
      const steep = smoothstep(0.55, 1.35, slope);
      const alt = smoothstep(95, 200, h);

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

    // ── crag siting ──────────────────────────────────────────────────────────
    //
    // One crag site per CRAG_BLOCK cells, picked deterministically rather than
    // by a per-cell dice roll. A dice roll produces a Poisson field: some 256 m
    // squares get three groups 60 m apart and some get none, and three groups
    // 60 m apart is precisely the "even sprinkle of chips" read that defeated
    // the previous two passes. Choosing exactly one cell per square guarantees
    // both the spacing between landforms and the bare mountain between them.
    const bx = cx >> CRAG_SHIFT, bz = cz >> CRAG_SHIFT;
    const cragCell =
         ((bx << CRAG_SHIFT) + ((hash2i(bx, bz, this.seed ^ 0x27a1) * CRAG_BLOCK) | 0)) === cx
      && ((bz << CRAG_SHIFT) + ((hash2i(bx, bz, this.seed ^ 0x9f13) * CRAG_BLOCK) | 0)) === cz;

    // Five candidate sites per cell; each that lands on an active process
    // becomes a cluster. Cells that land on nothing stay genuinely empty —
    // negative space is what makes the populated ground read as deliberate.
    let cragDone = false;
    for (let i = 0; i < 5; i++) {
      const x = ox + rng() * cellSize;
      const z = oz + rng() * cellSize;
      if (!W.isInBounds(x, z)) continue;
      const c = this.classify(x, z, up);
      if (!c) continue;
      if (c.kind === 'crag') {
        if (cragDone || !cragCell) continue;
        // A second, *geological* filter on top of the siting grid. The grid
        // controls spacing; this controls which of those sites are actually
        // bedrock exposures worth building. Thinning by hardness and bedding
        // rather than by another dice roll is what makes the surviving bands
        // line up with the terrain author's hard-rock geology instead of
        // wandering across the mountain at random — and it is the difference
        // between a banded face at 800 m and a boulder field at 300 m.
        if (c.s < CRAG_MIN_STRENGTH) continue;
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
      const depth = W.getWaterDepth(px, pz);
      // Deliberately NOT gated on being *in* the channel. The cluster centre
      // already is, so the whole disc is riverside ground, and the reference
      // plates put their biggest slabs on the bank above the waterline rather
      // than in the flow. Requiring river > 0 at every point emptied every
      // bank in the game and left the river view without a single rock.
      const slope = W.getSlope(px, pz);
      if (slope > 1.9) continue;

      const roll = rng();
      let arch, size;
      if (roll < 0.20 && depth < 0.9) { arch = 'slab'; size = powSize(rng, 1.6, 5.2, 1.5); }
      else if (roll < 0.28) { arch = 'hero'; size = powSize(rng, 1.8, 3.6, 1.7); }
      else if (roll < 0.62) { arch = 'boulder'; size = powSize(rng, 0.5, 3.0, 1.8); }
      else { arch = 'rubble'; size = powSize(rng, 0.12, 0.50, 2.0); }
      if (size * 2 < minSize) continue;
      // Shallows only. A rock that never breaks the surface is invisible and
      // still costs a draw, so in the wash at the channel edge it is grown
      // until it stands proud — but only there. Growing rocks to clear any
      // depth is what put a slab in the middle of a lake.
      if (depth > 0.4) continue;
      if (depth > 0.05) size = Math.max(size, depth * 1.15 + 0.25);
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

  /**
   * Glacial erratic in the meadow: one hero and its court.
   *
   * This is the "signature image" placement — a house-sized boulder alone in
   * gold grass with a long shadow off it. It only works if the size hierarchy
   * is brutal: one rock that dominates, a couple of car-sized companions, and
   * rubble. An earlier pass produced an even spread of knee-high cobbles that
   * simply disappeared into the grass, which is worse than no rocks at all.
   */
  _clusterErratic(x, z, c, rng, minSize, out) {
    const W = this.world;
    // Grass in this game stands well over a metre. A boulder has to clear it
    // decisively or it is invisible from the driver's seat.
    const heroSize = Math.min(powSize(rng, 2.2, 9.0, 1.9) * (0.66 + c.s * 0.58), 5.4);
    let placed = false;
    if (heroSize * 2 >= minSize && W.getWaterDepth(x, z) < 0.3 && W.getSlope(x, z) < 1.1) {
      // The compound hero mesh is the most expensive thing this system draws;
      // it is reserved for genuinely house-sized erratics.
      const arch = (heroSize > 3.2 && rng() < 0.6) ? 'hero' : 'boulder';
      this._place(x, z, arch, heroSize, rng, 0.20, 0.10, out);
      placed = true;
    }
    // The court hugs the hero. Scattered wide it stops being a group and
    // becomes the uniform sprinkle the brief calls an instant reject.
    const n = 2 + ((rng() * 6 * c.s) | 0);
    const R = heroSize * 1.5 + 3 + rng() * 7;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = heroSize * 0.9 + R * Math.sqrt(rng());
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      if (W.getWaterDepth(px, pz) > 0.3) continue;
      if (W.getSlope(px, pz) > 1.6) continue;
      const roll = rng();
      // Companions are a definite step down from the hero but still read at
      // 40 m; the rubble is the third tier.
      let arch, size;
      if (roll < 0.34) { arch = 'boulder'; size = heroSize * (0.24 + rng() * 0.30); }
      else if (roll < 0.54) { arch = 'slab'; size = heroSize * (0.20 + rng() * 0.34); }
      else { arch = 'rubble'; size = powSize(rng, 0.18, 0.75, 1.6); }
      if (size * 2 < minSize) continue;
      this._place(px, pz, arch, size, rng, 0.28, 0.16, out);
    }
    void placed;
  }

  /**
   * Crag. The biggest job this system has: the terrain shader alone paints a
   * 40-degree massif as one smooth ramp, and a smooth ramp is what makes the
   * `peaks` and `hero` views look like dunes.
   *
   * The previous pass got the diagnosis right and the prescription wrong. It
   * kept raising and lowering crag *density* and every setting looked like an
   * even sprinkle of chips, so it concluded the massif could not carry rock.
   * The problem was never the count, it was that the unit being scattered was a
   * boulder. A mountain face is not made of boulders; it is made of two things
   * and both of them are hundreds of metres long:
   *
   *   band    a resistant bed weathering out as a continuous wall that follows
   *           a *contour*, stepping down the face in courses. This is the form
   *           that gives a flank shadowed recesses and horizontal structure.
   *   crest   towers and blades standing ON the ridge line, tall enough to
   *           notch the horizon. Silhouette is the entire point — a crag you
   *           can only see against more hillside does nothing for the frame.
   *
   * So: very few sites (one per 256 m, chosen deterministically in
   * `generateCell`), each building a landform tens of blocks long, with wholly
   * bare mountain in between. That is the shape of the reference plates.
   */
  _clusterCrag(x, z, c, up, rng, minSize, out) {
    if (c.ridge > 0.30) {
      this._cragCrest(x, z, c, up, rng, minSize, out);
      // A crest with nothing below it is a row of teeth on a smooth cone. The
      // band under it is what makes the summit read as the top of a cliff.
      if (c.slope > 0.70 && rng() < 0.75) this._cragBands(x, z, c, up, rng, minSize, out);
    } else if (c.slope > 0.62) {
      this._cragBands(x, z, c, up, rng, minSize, out);
    }
  }

  /**
   * A stack of cliff courses on a face.
   *
   * Each course is a chain of overlapping blocks laid along a contour, and the
   * courses step down the fall line, so the face reads wall / ledge / wall.
   */
  _cragBands(x0, z0, c, up, rng, minSize, out) {
    const W = this.world;
    // Sized in tens of metres, deliberately. The massif in `peaks` is roughly
    // 400 m tall and 800 m across and fills half the frame; a 6 m block on it
    // is two pixels. What stops this reading as cardboard boxes on a mountain
    // is that the blocks interpenetrate — the eye reads the union of the chain
    // as one cliff, never any single block.
    // Bigger than it looks: a block of `base` is 2*base metres along the strike,
    // so 9-19 here is an 18-38 m wall segment. It has to clear the visibility
    // cutoff at the range the massif is actually seen from (600-900 m in
    // `peaks`) or the band exists in the scatter and never renders.
    // Scaled by altitude as well as by hardness. A crag at 110 m is a low
    // outcrop on a hill you drive past at 300 m, where a 50 m block reads as a
    // shipping crate; the same block on a 250 m shoulder is 800 m away and
    // reads as a cliff. Tying size to altitude is also the honest geology — the
    // higher a bed sits the more of it has been stripped bare.
    const alt = 0.62 + 0.55 * smoothstep(95, 250, c.h);
    const base = clamp((9 + c.hard * 11 + c.s * 7) * (0.85 + rng() * 0.40) * alt, 7, 17);
    const courses = 1 + ((rng() * 2) | 0);
    let cx = x0, cz = z0;
    let targetY = W.getHeight(cx, cz);

    for (let k = 0; k < courses; k++) {
      const scale = base * (1 - k * 0.13);
      this._contourCourse(cx, cz, targetY, scale, c, up, rng, minSize, out);

      // Down the fall line to the next bed, by about two block heights, so
      // there is bare slope between the courses. Converting a vertical drop
      // into a horizontal step needs the slope, or the courses bunch up on a
      // cliff and spread out on a bench — the opposite of what rock does.
      this._uphill(cx, cz, up);
      const drop = scale * (1.7 + rng() * 1.5);
      const slope = clamp(W.getSlope(cx, cz), 0.45, 2.6);
      cx -= up.x * (drop / slope);
      cz -= up.z * (drop / slope);
      if (!W.isInBounds(cx, cz)) break;
      if (W.getSlope(cx, cz) < 0.42) break;
      targetY = W.getHeight(cx, cz);
    }

    // Debris apron below the whole face. Sized off the band, so a big crag
    // sheds big blocks — the size hierarchy has to survive downhill.
    const nd = 1 + ((rng() * 3) | 0);
    for (let i = 0; i < nd; i++) {
      this._uphill(cx, cz, up);
      const along = base * (1.5 + rng() * 4.5);
      const across = (rng() * 2 - 1) * base * 3.0;
      const dx = cx - up.x * along - up.z * across;
      const dz = cz - up.z * along + up.x * across;
      if (!W.isInBounds(dx, dz)) continue;
      if (W.getWaterDepth(dx, dz) > 0.4) continue;
      const ds = base * powSize(rng, 0.07, 0.24, 1.7);
      if (ds * 2 < minSize) continue;
      this._place(dx, dz, rng() < 0.55 ? 'talus' : 'bench', ds, rng, 0.55, 0.55, out, 0.26);
    }
  }

  /**
   * One course: walk the contour out from the site in both directions, laying
   * blocks closer together than they are wide.
   *
   * Following the *contour* rather than the ground is the whole trick. A chain
   * that simply walks across the slope drifts up or down with every wobble in
   * the terrain and reads as a row of boulders someone rolled onto a hillside;
   * a chain held at one altitude reads as a bed of harder rock, which is what
   * it is meant to be and what the eye recognises on a real mountain.
   */
  _contourCourse(x0, z0, targetY, scale, c, up, rng, minSize, out) {
    const W = this.world;
    // Anything shorter than this is not a cliff band, it is two or three blocks
    // sitting on a smooth slope — which is what every "the crags look like they
    // are floating" report has actually turned out to be. Nothing hovers
    // (measured with tools/_scratch/rockfloat.mjs: every crag block's lowest
    // vertex is 5-20 m below the ground at its own centre); an isolated block
    // on a bare hillside simply has no visible contact and the eye cannot place
    // it. So a course that dies early is discarded rather than left as a stub.
    const startAt = out.length;
    const MIN_COURSE = 4;
    // Blocks are about two scales wide and land two thirds of a scale apart, so
    // each overlaps its neighbours by most of its length. The union is the
    // cliff; no single block is ever meant to read on its own, and any block
    // that ends up isolated on a smooth slope reads as a crate dropped on it —
    // that, and not any actual hovering, is what "the crags look like they are
    // floating" turned out to mean when measured.
    const step = scale * (0.58 + rng() * 0.24);

    for (let dir = -1; dir <= 1; dir += 2) {
      let px = x0, pz = z0;
      // Long. The unit that has to read from 800 m is not the block and not even
      // the course — it is the whole band crossing the face, so a chain runs up
      // to eleven blocks in each direction, 300 m a side.
      const n = 4 + ((rng() * 6) | 0);
      for (let i = 0; i < n; i++) {
        this._uphill(px, pz, up);
        if (Math.abs(up.x) + Math.abs(up.z) < 0.05) break;
        px += -up.z * dir * step;
        pz += up.x * dir * step;
        if (!W.isInBounds(px, pz)) break;

        // Correct back to the bed's altitude along the fall line. Note the
        // sign: `up` points uphill, and a positive error means we have drifted
        // *above* the bed, so the correction walks down. Getting this backwards
        // is a positive feedback — the chain climbs the fall line and comes out
        // as a vertical clump of boulders instead of a horizontal course.
        this._uphill(px, pz, up);
        const slope = clamp(W.getSlope(px, pz), 0.35, 3.0);
        const err = W.getHeight(px, pz) - targetY;
        const corr = clamp(err / slope, -step * 1.3, step * 1.3);
        px -= up.x * corr; pz -= up.z * corr;
        if (!W.isInBounds(px, pz)) break;
        if (W.getSlope(px, pz) < 0.44) break;        // the bed dies on the bench
        if (this.hardness(px, pz) < 0.22) break;     // and where the rock softens
        if (W.getWaterDepth(px, pz) > 0.5) break;

        const size = scale * (0.90 + rng() * 0.50);
        if (size * 2 < minSize) continue;

        // Local +Z faces downhill, local +X runs along the strike, so the
        // block's long axis merges with its neighbours and its stepped shoulder
        // sits back into the hill.
        this._uphill(px, pz, up);
        const yaw = Math.atan2(-up.x, -up.z);
        const roll = rng();
        // Mostly wall. A prow every so often projects out of the face and
        // throws a shadow into the recess beside it — additive geometry cannot
        // cut a gully, but it can make one out of the shadow between two spurs.
        const arch = roll < 0.78 ? 'cliff' : (roll < 0.94 ? 'prow' : 'tower');
        // `align` is the bed's dip, and it is what stops a cliff block hanging
        // in the air. A block laid dead level on a 40-degree face is as deep as
        // it is wide, so its downhill edge stands half a block-width clear of
        // the ground and reads as a floating slab. Tipping it to roughly half
        // the slope angle both kills that and is what a dipping bed does.
        // Burial is the difference between a cliff band and a rockfall. Only
        // the top third of a block is meant to be out of the hill: the eye
        // reads the protruding step as a change in the *terrain*, which is what
        // a resistant bed is, rather than as a crate someone left on a slope.
        // Burial is a balance, not a maximum. Too little and the block's
        // downhill half hangs over air; too much and only its cap shows, so a
        // chain of them reads as separate boulders lying on the slope instead
        // of as one wall. With a thin plank on a ~1.3 slope, sinking about a
        // tenth of the block and shoving it a seventh of its width into the
        // hill puts the base flush at the downhill edge, which leaves the whole
        // vertical face out where neighbours can merge with it.
        // `align` is the bed's dip. It was 0.10 — a block laid dead level —
        // which is the case the comment above warns about and the single
        // biggest reason crag blocks hung over air: a level box on a 40-degree
        // face has to be sunk more than its own height before its downhill
        // edge reaches the ground, so either it floats or it disappears. Laid
        // along the dip it needs to be sunk only by its own thickness, which
        // is what lets it both sit in the hill and stand out of it.
        this._place(px, pz, arch, size * (arch === 'tower' ? 0.66 : 1.0), rng,
          arch === 'cliff' ? 0.62 : 0.55, 0.0, out,
          arch === 'cliff' ? 0.12 : 0.22, 'sag',
          arch === 'cliff' ? 0.14 : 0.20, yaw);
      }
    }
    if (out.length - startAt < MIN_COURSE) out.length = startAt;
  }

  /**
   * A crag massif on a ridge crest — the thing that gives the skyline notches.
   *
   * Two rules, both learned the hard way:
   *
   *   the walk has to *stay on the arete*. Stepping perpendicular to the local
   *   gradient sounds like it follows a ridge, and on a knife edge it does, but
   *   on a summit the gradient rotates through 360 degrees and the chain simply
   *   circles the peak and fills it in. So the direction is carried between
   *   steps and only allowed to turn slowly, and after each step the position is
   *   nudged sideways toward whichever neighbour is higher.
   *
   *   the blocks have to stay smaller than the landform. A 50 m block on a
   *   400 m peak is a cardboard box; the mass has to come from many 20 m blocks
   *   overlapping, which reads as broken bedrock.
   */
  _cragCrest(x0, z0, c, up, rng, minSize, out) {
    const W = this.world;
    const startAt = out.length;              // stub groups are dropped, as above
    const scale = clamp((8 + c.hard * 8 + c.s * 5) * (0.80 + rng() * 0.45)
      * (0.70 + 0.45 * smoothstep(95, 250, c.h)), 6, 14);
    const n = 4 + ((rng() * 5) | 0);
    const step = scale * (0.62 + rng() * 0.26);

    for (let dir = -1; dir <= 1; dir += 2) {
      let px = x0, pz = z0;
      // Seed the heading from the strike at the site, then carry it.
      this._uphill(px, pz, up);
      let hx = -up.z * dir, hz = up.x * dir;
      const L0 = Math.hypot(hx, hz) || 1;
      hx /= L0; hz /= L0;

      for (let i = 0; i < n; i++) {
        this._uphill(px, pz, up);
        // Blend the carried heading with the local strike: enough to follow a
        // curving ridge, not enough to let the chain turn back on itself.
        const tx = -up.z * dir, tz = up.x * dir;
        if (tx * hx + tz * hz > 0.2) {
          hx = hx * 0.62 + tx * 0.38; hz = hz * 0.62 + tz * 0.38;
          const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
        }
        px += hx * step + (rng() * 2 - 1) * scale * 0.10;
        pz += hz * step + (rng() * 2 - 1) * scale * 0.10;
        if (!W.isInBounds(px, pz)) break;

        // Re-centre onto the crest line: sample either side of the heading and
        // slide toward the higher one. Without this the chain slowly slides off
        // the arete onto a flank and the group stops breaking the skyline.
        const ox = -hz * step * 0.75, oz = hx * step * 0.75;
        const hl = W.getHeight(px - ox, pz - oz), hr = W.getHeight(px + ox, pz + oz);
        const cH = W.getHeight(px, pz);
        if (hr > cH) { px += ox * 0.7; pz += oz * 0.7; }
        else if (hl > cH) { px -= ox * 0.7; pz -= oz * 0.7; }
        if (!W.isInBounds(px, pz)) break;
        if (this.convexity(px, pz, 30) < 0.010) break;
        if (W.getWaterDepth(px, pz) > 0.3) break;

        // Tapering profile, so the group has a summit rather than a flat top.
        const t = 1 - (i / n) * 0.75;
        const size = Math.min(scale * (0.62 + t * 0.62) * (0.84 + rng() * 0.36), 12);
        if (size * 2 < minSize) continue;

        // Yaw from the carried heading, not from the local gradient. On an
        // arete the gradient is nearly degenerate and the 2 m normal sample
        // that feeds `_uphill` can point *along* the ridge instead of across
        // it, which rotates a block ninety degrees and breaks the chain into
        // separated uprights — the "rockslide down the front of the peak" read
        // in `hero`. The heading is exactly the direction the blocks have to
        // merge along, so it is the thing to align them to.
        const yaw = Math.atan2(-hz, hx);
        const roll = rng();
        // Wall first: the mass a crest is made of. Towers are the minority that
        // punch the actual notches, and at 40% of the group they stopped
        // reading as pinnacles and started reading as a graveyard on a dune.
        const arch = roll < 0.72 ? 'cliff' : (roll < 0.92 ? 'bench' : 'tower');
        // Walls and benches take the local dip so they sit in the crest rather
        // than on it; towers stay near upright, because a leaning pinnacle is
        // the one crag form that reads as a fallen block.
        this._place(px, pz, arch, size * (arch === 'tower' ? 0.56 : 1.0), rng,
          arch === 'tower' ? 0.22 : 0.50, arch === 'bench' ? 0.16 : 0.0, out,
          arch === 'tower' ? 0.12 : 0.14, 'sag',
          arch === 'cliff' ? 0.14 : 0.08, arch === 'bench' ? null : yaw);

        // A block set back off the crest line, so the outcrop has a shoulder
        // instead of being a single-file wall.
        if (rng() < 0.32) {
          const off = scale * (0.34 + rng() * 0.34) * (rng() < 0.5 ? 1 : -1);
          const bx = px + up.x * off, bz = pz + up.z * off;
          const bs = size * (0.55 + rng() * 0.40);
          if (W.isInBounds(bx, bz) && bs * 2 >= minSize) {
            this._place(bx, bz, rng() < 0.14 ? 'tower' : 'cliff', bs, rng,
              0.50, 0.0, out, 0.14, 'sag', 0.16, yaw);
          }
        }
      }
    }
    if (out.length - startAt < 4) out.length = startAt;
  }

  // ── the single placement routine ───────────────────────────────────────────

  /**
   * @param align  0 = stands upright regardless of ground, 1 = lies flush to it
   * @param tumble extra random tip, in radians-ish; fractured blocks tumble
   * @param sink   fraction of the rock's own radius to bury below the lowest
   *               ground sample under its footprint. The min-of-samples is what
   *               guarantees nothing ever hovers on a convex ridge.
   */
  _place(x, z, arch, size, rng, align, tumble, out, sink = 0.14, mode = 'min', shove = 0,
    yaw = null) {
    const W = this.world;
    const n = this._n;
    W.getNormal(x, z, n, Math.max(1.0, size * 0.8));

    // Push the rock back into the hill so only its outer part protrudes.
    if (shove > 0) {
      const L = Math.hypot(n.x, n.z);
      if (L > 1e-4) { x -= (n.x / L) * size * shove; z -= (n.z / L) * size * shove; }
    }

    // Orientation first: how deep a block has to be planted depends on which
    // way its long axis is pointing, so the anchor cannot be computed before
    // the rotation is known.
    const up = this._up.set(0, 1, 0).lerp(n, align).normalize();
    const q = this._q.setFromUnitVectors(UP, up);
    // A crag form is oriented, not tumbled: local +X runs along the strike so a
    // chain of them overlaps into one wall, and local +Z faces downhill.
    this._qy.setFromAxisAngle(UP, yaw === null ? rng() * Math.PI * 2 : yaw);
    q.multiply(this._qy);
    if (tumble > 0) {
      const a = rng() * Math.PI * 2;
      this._ax.set(Math.cos(a), 0, Math.sin(a));
      this._qt.setFromAxisAngle(this._ax, (rng() * 2 - 1) * tumble);
      q.multiply(this._qt);
    }

    // ── ground anchor ────────────────────────────────────────────────────────
    //
    // Two things must both hold: the rock may never hover, and on a steep face
    // it must still be able to stand out over air as an overhang.
    const centreH = W.getHeight(x, z);
    const wide = arch === 'bench' || arch === 'tower' || arch === 'ledge';
    const huge = mode === 'sag';

    let minH;
    if (huge) {
      // ── planted anchor, for the crag forms ────────────────────────────────
      //
      // Every previous rule here measured the wrong thing, and the audits
      // agreed with them because the audits measured the wrong thing too.
      //
      // A crag block is a wedge driven into a hillside: its uphill corner ends
      // up tens of metres inside the hill while its downhill corner reaches out
      // over the slope. `min over vertices of (y - ground)` — the number
      // `rockfloat.mjs` reported, and the number the wide-ring anchor was tuned
      // against — is dominated by that buried uphill corner, so it reads a
      // comfortable "8 m below ground" for a block whose entire visible
      // downhill edge is hanging in space. Measuring the *base* instead
      // (tools/_scratch/rockview.mjs) found 73% of the crag blocks in `peaks`
      // standing clear of the ground, median 6.5 m and up to 60 m of air under
      // the worst. That is the floating everyone kept reporting; nothing was
      // wrong with the terrain LOD, which tracks the heightfield to within a
      // metre at the ranges these are seen from (raycast against the live
      // `Terrain` group: mean sag 0.2–0.6 m, worst 6.4 m).
      //
      // So anchor to the block's OWN base, not to a ring of arbitrary radius:
      // sample the ground under each corner of the footprint, after rotation,
      // and sink the block until every one of them is in the hill. This is
      // self-scaling — a 34 m wall is planted as deep as a 34 m wall needs and
      // no deeper — which is what the ring rules could never get right, being
      // either far too wide (26 m for a 12 m block: the whole band vanished)
      // or, once corrected for slope, effectively zero.
      const fp = this._foot[arch] ?? FOOT_FALLBACK;
      const v = this._fv;
      // The per-axis scale jitter applied below is 0.84–1.18, and it pulls both
      // ways: a wider block reaches further downhill, a shallower one has less
      // of itself to bury. Take the unsafe end of each.
      const ex = fp.rx * size * 1.18, ez = fp.rz * size * 1.18, ey = fp.yLo * size * 0.84;
      const req = this._req;
      for (let k = 0, i = 0; k < BASE_SAMPLES.length; k += 2, i++) {
        v.set(BASE_SAMPLES[k] * ex, ey, BASE_SAMPLES[k + 1] * ez).applyQuaternion(q);
        // The block's centre may sit no higher than this, or that corner of the
        // base lifts off the ground.
        req[i] = W.getHeight(x + v.x, z + v.z) - v.y;
      }
      req.sort((a, b) => a - b);
      // Not the strict minimum: BASE_TOLERATE of the nine probes are allowed to
      // stay above ground. One corner of a thirty-metre wall reaching out over
      // a gully is an overhang, which is what a cliff band is supposed to do;
      // obeying it would sink the other twenty-five metres out of sight, and
      // the whole course with it — which is how the first attempt at this left
      // a single tooth showing out of a five-block chain, the loneliest thing
      // in the frame.
      let need = req[BASE_TOLERATE];
      // Margin, so contact survives the drawn mesh sagging a little below the
      // heightfield at distance, and so the ground line cuts across the block's
      // face rather than grazing its bottom edge.
      need -= CONTACT_MARGIN + size * 0.05;
      // Ground so broken that planting the block would swallow it whole: stop
      // short instead. Dropping the block outright was tried and is worse — it
      // punches holes in the middle of a course, and a chain with two blocks
      // missing stops reading as one wall and becomes the row of separate
      // crates this whole exercise is about. A little overhang inside a
      // continuous chain is invisible; a gap in the chain is not.
      need = Math.max(need, centreH - size * MAX_PLANT);
      // `y` below is `minH - size * sink`, so fold the sink back in here.
      minH = Math.min(centreH, need + size * sink);
    } else {
      // Everything that is not a crag keeps the old rule: the lowest ground
      // across a modest ring, clamped so a boulder on a cliff does not vanish.
      const fr = Math.max(size * 0.85, wide ? 12 : (mode === 'centre' ? 9 : 3));
      let ringMin = centreH;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.4;
        const hh = W.getHeight(x + Math.cos(a) * fr, z + Math.sin(a) * fr);
        if (hh < ringMin) ringMin = hh;
      }
      if (wide) {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 1.1;
          const hh = W.getHeight(x + Math.cos(a) * fr * 1.7, z + Math.sin(a) * fr * 1.7);
          if (hh < ringMin) ringMin = hh;
        }
      }
      // On a cliff the ring minimum is tens of metres down; following it all the
      // way would bury the block entirely and there would be no relief at all.
      // Clamping the drop keeps the uphill half deeply embedded (which is what
      // stops the float) while the downhill half projects — an overhang.
      const maxDrop = mode === 'centre' ? size * 0.85 : size * 3.0;
      minH = Math.max(ringMin, centreH - maxDrop);
    }

    const depth = W.getWaterDepth(x, z);
    const river = W.getRiver(x, z);
    const waterY = W.getWaterHeight(x, z);
    const h = W.getHeight(x, z);

    // Nothing stands in open water. Reported by the water author, who isolated
    // it: a house-sized slab was sitting in the middle of the lake in `forest`,
    // the most conspicuous object in that frame. `_clusterRiver` used to *grow*
    // a rock until it broke the surface, which is right for a boulder in a
    // rapid and badly wrong for a lake. A part-submerged boulder at the
    // waterline is still wanted, so the veto is at 0.4 m rather than at zero,
    // and it lives here so every cluster type inherits it — the rng has already
    // been consumed at this point, so dropping the instance does not disturb
    // the rest of the cell.
    if (depth > 0.4) return;

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
      // The ground under the rock, as a plane: a height plus the terrain's own
      // gradient. The shader darkens the band just above it — contact occlusion
      // is the cheapest and strongest cue that a heavy object is *sitting in*
      // the ground rather than resting on top of it.
      //
      // The gradient is why this is a plane and not a single height. A crag
      // block is thirty metres across a slope that drops twenty over that
      // distance; against a level reference its whole downhill half is "below
      // ground" and got darkened flat, which reads as a shaded lower half, not
      // as contact. Tilted to the hillside, the band lands where the rock
      // actually enters the hill and draws the ground line the eye is looking
      // for. On flat ground the gradient is zero and nothing changes.
      groundY: minH,
      groundGX: -n.x / Math.max(n.y, 1e-3),
      groundGZ: -n.z / Math.max(n.y, 1e-3),
      // Visible radius. Paired with Rocks._minSizeFor: a cell far away is only
      // asked for rocks big enough that this radius still reaches the camera,
      // so nothing is ever generated that cannot be seen.
      // The far cap is an art call, not a perf one: past about a kilometre a
      // crag chain is a row of five-pixel dots on a hazed hillside, which is
      // the "sprinkle of chips" read. Beyond this the mountains are pure
      // terrain and aerial perspective, which is what the plates show.
      vis: clamp(size * VIS_PER_METRE, 80, 950),
      rnd: rng(),
    });
  }
}

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
const CONTACT_MARGIN = 4.0;

/**
 * How many of the nine base probes may stay above ground. An overhanging corner
 * is cliff-like; an overhanging half is a crate on a hillside.
 *
 * 1, not 0, and the shrink loop in `_place` uses the same probe. They have to
 * agree: with the shrink testing the second-lowest probe and the anchor using
 * the lowest, a block off the end of an arete would be shrunk until its second
 * probe fitted, then anchored against a first probe tens of metres lower, then
 * clamped back up by MAX_PLANT — and end up hanging in clear sky with its whole
 * base in the air. That is exactly the artifact in `waterfall`, and it is the
 * same disagreement in the same two lines that produced the original floating
 * report. One probe of nine over air is a corner overhang; the guard below
 * throws the block away rather than let it become anything more.
 */
const BASE_TOLERATE = 1;

/**
 * Deepest a crag block is planted, as a multiple of its own size. A block is
 * roughly 1.5 sizes tall, so this leaves at least a third of it out of the hill
 * however broken the ground under it is.
 */
const MAX_PLANT = 1.0;

/** Used until `Rocks` hands over the real per-variant bounds. */
const FOOT_FALLBACK = { rx: 1.3, rz: 1.3, lo: new Array(9).fill(-0.5) };

// ── road clearance ───────────────────────────────────────────────────────────
//
// Nothing in this file used to know where the roads are, and it showed. The
// audit (`tools/_scratch/rockroad.mjs`) measured every instance in the world
// against the road network and found **537 of the 3839 road centreline points
// standing inside a rock's own footprint** — one road point in seven with a
// boulder drawn through it. That is the defect reported as INTEGRATION_REQUESTS
// P2: at road anchor 18 a `cliff` block of 15.6 m radius had its nearest face
// 1.7 m from the chase camera and filled half the frame with one flat facet.
// Two of the forty road anchors reproduced it at full strength.
//
// The rule is deliberately expressed in units of the rock's own size rather
// than as a fixed corridor, because those are two different requirements that
// happen to share a mechanism:
//
//   ROAD_TRACK     the bare wheel ruts. Nothing may stand in them whatever its
//                  size. 3.2 m is just inside the 3.6 m that `RoadMask` in
//                  grass_scatter.js already parts the grass for, so a stone at
//                  the edge of the track still sits in grass and not on bare
//                  dirt.
//   ROAD_STANDOFF  how far a rock stands back, as a multiple of its own
//                  horizontal reach. This is the part that fixes the wedge: a
//                  rock whose centre is 2 reaches away can never subtend more
//                  than about 30 degrees from the road however large it is, so
//                  a crag beside a mountain road stays a crag beside a mountain
//                  road and never becomes an unscaled grey plane across the
//                  lens. It is also self-scaling in the right direction —
//                  cobbles line the verge at 4 m, a 20 m wall stands 43 m off.
//
// Measured over the whole world at res 768 (`--sweep`, in the same tool): 2.0
// removes 7.0% of all instances and takes the count of road points inside a
// rock from 537 to 0, and the worst angular size seen from anywhere on the road
// network from 17.96 down to 0.47. 1.6 was tried and leaves 55 road points with
// a rock over half a radian across; 2.5 costs another 1.2% of the world's rock
// and moves nothing that can be seen.
const ROAD_TRACK = 3.2;
const ROAD_STANDOFF = 2.0;

/**
 * "Is there a road within r metres of here?" — a bucketed radius query over the
 * road polylines, which is all the clearance test needs.
 *
 * Not a raster like `RoadMask`: that one answers a fixed 3.6 m question and
 * quantises to a 4 m grid, and this one has to answer out to ~90 m (the reach
 * of the largest crag block times the standoff) without quantisation error at
 * the small end, where the threshold is only 4 m and a 2.8 m grid error would
 * decide it. Buckets are exact, cost ~30 kB for the whole network, and are
 * built once per RockScatter.
 */
class RoadProximity {
  constructor(roads, cell = 64) {
    this.cell = cell;
    this.buckets = new Map();
    for (const line of roads ?? []) {
      for (const p of line) {
        // Densify: road points are ~9 m apart, so the segment between two of
        // them can pass 4.5 m closer to a rock than either endpoint does. At
        // the small end of the threshold that is the whole margin.
        this._add(p.x, p.z);
      }
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        this._add((a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
      }
    }
  }

  _add(x, z) {
    const k = (Math.floor(x / this.cell) * 65536 + Math.floor(z / this.cell)) | 0;
    let arr = this.buckets.get(k);
    if (!arr) this.buckets.set(k, arr = []);
    arr.push(x, z);
  }

  /** True if any road point lies within `r` metres of (x, z). */
  anyWithin(x, z, r) {
    if (!(r > 0) || this.buckets.size === 0) return false;
    const c = this.cell, r2 = r * r;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const arr = this.buckets.get((i * 65536 + j) | 0);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const dx = arr[k] - x, dz = arr[k + 1] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }
}

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

    // Where the player actually drives. Built once; the query is a bucket scan
    // and costs nothing at stream time, and nothing at all at runtime — this is
    // a placement rule, so it is paid when a cell is generated and never again.
    this._roads = new RoadProximity(world?.roads);
    /** Set false to A/B the clearance rule without a second page load. */
    this.roadClearance = true;
  }

  /**
   * @param foot arch -> per-variant { rx, rz, lo } in local units, from
   * `archFootprints`. Handing these over also hands over variant choice: with
   * them, `_place` picks the variant itself (by position hash, so no rng is
   * consumed and nothing else in the cell shifts) and anchors against that
   * variant's actual base rather than against a conservative union.
   */
  setFootprints(foot) {
    this._foot = foot ?? {};
    this._archSeed = {};
    let k = 0;
    for (const a of Object.keys(this._foot)) this._archSeed[a] = (0x51ed27 + (k++) * 0x9e3779b9) | 0;
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
      // `R * sqrt(rng)` is uniform over the disc, which is the flattest
      // distribution there is — and with three or four of these discs
      // overlapping on one bank the result is the even sprinkle the brief calls
      // an automatic reject. It is what `river` came back as: two hundred
      // near-identical cobbles spread at constant density over a whole
      // hillside. A power above a half concentrates the group toward its own
      // centre, so a rock field has a core and an edge.
      const rt = Math.pow(rng(), 1.15);
      const r = R * rt;
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

      // Size follows the same envelope as position: the biggest rock in a
      // riverbed group sits in its middle and the debris rings it. Without this
      // the group has a hierarchy on paper — a power law over four archetypes —
      // and none at all in the picture, because the big ones are as likely to
      // be on the rim as anywhere else and the eye reads density, not tiers.
      const core = 1.0 - rt;
      // Smaller roll = bigger archetype, so the core biases the draw toward the
      // top of the table and the rim toward rubble.
      const roll = rng() * (1.45 - core * 0.85);
      let arch, size;
      if (roll < 0.20 && depth < 0.9) { arch = 'slab'; size = powSize(rng, 1.6, 5.2, 1.5); }
      else if (roll < 0.28) { arch = 'hero'; size = powSize(rng, 1.8, 3.6, 1.7); }
      else if (roll < 0.62) { arch = 'boulder'; size = powSize(rng, 0.5, 3.0, 1.8); }
      else { arch = 'rubble'; size = powSize(rng, 0.12, 0.50, 2.0); }
      size *= 0.66 + core * 0.52;
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
      // Triangular across the fan rather than uniform: a run-out has a dense
      // axis and thins to its edges. Uniform across-slope spread is half of why
      // overlapping fans read as one flat rash of stones.
      const spread = (rng() + rng() - 1) * R * 0.62;
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
      if (roll < 0.14 + big * 0.24) {
        size = powSize(rng, 0.7, 1.1 + big * 2.4, 1.4);
        // ── a frost block is a small thing, and the form says so ───────────
        //
        // RockForms.talus is a deliberate three-plane cuboid: `fill: 3`,
        // `erode: 0.05`, `lump: 0.09`, "boxy, sharp, no rounding at all". That
        // is exactly right for a metre-wide block seen among fifty of them on
        // a scree run-out, and it is a concrete crate at five metres seen alone
        // on a grass bank — which is what the untreated grey plate in `river`
        // turned out to be. Two of these, at size 2.1 and 2.3, overlapping into
        // one 8 m plate at 52 m from the camera, with nothing else its own size
        // within thirty metres.
        //
        // Worth recording because the working hypothesis was wrong and cost an
        // hour: the review had it as the `maxDrop = size * 3.0` overhang. It is
        // not. The bank there is slope 0.52-0.73 (27-36 degrees), the ring
        // minimum sits about 1.8 m below the centre against a 6.6 m allowance,
        // so the clamp never binds and the block's own base probes come back
        // 1.4-2.6 m INSIDE the hill. Nothing is hanging. The form is wrong for
        // the size. (Isolated by capture: `shots/rocks/before-river.png` against
        // `before-river-norocks.png` — the plate is the only thing that goes.)
        //
        // The fan's biggest blocks are also its most exposed: `big` grows with
        // distance down the fan, so the largest talus lands where the slope
        // eases and there is least around it. Past the size where a block stops
        // being one stone among many, hand it to `boulder`, which is built with
        // nine planes, edge erosion and lumps — a broken silhouette.
        arch = size > 1.6 ? 'boulder' : 'talus';
      } else if (roll < 0.32) { arch = 'slab'; size = powSize(rng, 0.5, 1.0 + big * 1.6, 1.6); }
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
      // Concentrated, for the reason given in _clusterRiver: a scree apron has
      // a dense heart and a thinning fringe, and a uniform disc of it laid over
      // the same ground as its neighbours is a texture, not a landform.
      const rt = Math.pow(rng(), 1.25);
      const r = R * rt;
      const core = 1.0 - rt;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!W.isInBounds(px, pz)) continue;
      if (W.getSlope(px, pz) > 2.2) continue;
      const roll = rng() * (1.4 - core * 0.7);
      let arch, size;
      if (roll < 0.10) { arch = 'talus'; size = powSize(rng, 0.6, 1.7, 1.6); }
      else if (roll < 0.20) { arch = 'slab'; size = powSize(rng, 0.5, 1.3, 1.6); }
      else { arch = 'rubble'; size = powSize(rng, 0.12, 0.46, 1.6); }
      size *= 0.66 + core * 0.62;
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
    // The upper clamp is altitude-aware rather than a flat 17. At 17 the clamp
    // bound before the altitude term did, so a 110 m outcrop you drive past at
    // 300 m got the same 34 m-wide blocks as an 800 m crag — which is the
    // ~550 px flat slab the critic found intersecting the mountainside in the
    // starting view. Low crags now top out around 11 m and high ones at 18.
    const altT = smoothstep(95, 250, c.h);
    const alt = 0.62 + 0.55 * altT;
    const base = clamp((9 + c.hard * 11 + c.s * 7) * (0.85 + rng() * 0.40) * alt,
      6, 9 + 9 * altT);
    // Two to four beds, not one or two. A single course on a face is exactly
    // the "string of beads laid on the mountain" read: one line, at one
    // altitude, with nothing above or below it to say it is strata. Banding
    // needs at least a few courses before the eye reads them as a system, and
    // they have to differ from each other in weight and length or the system
    // reads as a repeat.
    const courses = 2 + ((rng() * 3) | 0);
    let cx = x0, cz = z0;
    let targetY = W.getHeight(cx, cz);

    for (let k = 0; k < courses; k++) {
      // Not a monotonic taper. A stratigraphic sequence has one or two thick
      // resistant beds and several thin ones, in no particular order; stepping
      // the scale down by 13% per course just draws parallel lines of
      // decreasing weight, which still reads as a repeat.
      const scale = base * (0.65 + rng() * 0.65);
      // …and they do not all start above one another. Offsetting each course
      // along the strike is what stops the ends of the courses lining up into a
      // vertical seam down the face.
      this._uphill(cx, cz, up);
      const shift = (rng() * 2 - 1) * scale * 2.6;
      const sx0 = cx - up.z * shift, sz0 = cz + up.x * shift;
      // Length varies course to course, and some beds are barely exposed at
      // all. A course that dies to a stub is discarded inside _contourCourse.
      this._contourCourse(W.isInBounds(sx0, sz0) ? sx0 : cx,
        W.isInBounds(sx0, sz0) ? sz0 : cz,
        targetY, scale, c, up, rng, minSize, out, 0.45 + rng() * 0.95);

      // Talus under each course, not only under the last one. A bed that is
      // weathering out is shedding blocks, and the fan of debris directly below
      // it is most of what says the wall above is *rock breaking off a
      // mountain* rather than boxes set down on a slope — which is exactly how
      // the crags in `peaks` read once the value was fixed and the form became
      // legible at all. Small and close in, so it is an apron and not a second
      // scatter layer.
      this._uphill(cx, cz, up);
      const na = 2 + ((rng() * 3) | 0);
      for (let a = 0; a < na; a++) {
        const along = scale * (0.9 + rng() * 2.6);
        const across = (rng() + rng() - 1) * scale * 2.2;
        const ax = cx - up.x * along - up.z * across;
        const az = cz - up.z * along + up.x * across;
        if (!W.isInBounds(ax, az)) continue;
        if (W.getWaterDepth(ax, az) > 0.4) continue;
        const as = scale * powSize(rng, 0.08, 0.30, 1.6);
        if (as * 2 < minSize) continue;
        this._place(ax, az, rng() < 0.6 ? 'talus' : 'slab', as, rng, 0.55, 0.5, out, 0.28);
      }

      // Down the fall line to the next bed, by about two block heights, so
      // there is bare slope between the courses. Converting a vertical drop
      // into a horizontal step needs the slope, or the courses bunch up on a
      // cliff and spread out on a bench — the opposite of what rock does.
      this._uphill(cx, cz, up);
      const drop = scale * (1.5 + rng() * 2.2);
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
  _contourCourse(x0, z0, targetY, scale, c, up, rng, minSize, out, lenMul = 1.0) {
    const W = this.world;
    // Anything shorter than this is not a cliff band, it is two or three blocks
    // sitting on a smooth slope — which is what every "the crags look like they
    // are floating" report has actually turned out to be. Nothing hovers
    // (measured with tools/_scratch/rockfloat.mjs: every crag block's lowest
    // vertex is 5-20 m below the ground at its own centre); an isolated block
    // on a bare hillside simply has no visible contact and the eye cannot place
    // it. So a course that dies early is discarded rather than left as a stub.
    const startAt = out.length;
    const MIN_COURSE = 3;
    // The largest member this course can produce is `scale * 1.0 * 1.46`. If
    // even that is under the cell's visibility cutoff the course cannot be
    // drawn as a wall at this range at all, and rounding every member up to the
    // cutoff would give a line of identical blocks — the bead read arrived at
    // from the opposite direction. Leave the mountain bare instead.
    if (scale * 1.46 * 2 < minSize) return;
    // Blocks are about two scales wide and land two thirds of a scale apart, so
    // each overlaps its neighbours by most of its length. The union is the
    // cliff; no single block is ever meant to read on its own, and any block
    // that ends up isolated on a smooth slope reads as a crate dropped on it —
    // that, and not any actual hovering, is what "the crags look like they are
    // floating" turned out to mean when measured.
    //
    // The stride is a fraction of the LOCAL block, not of the course's nominal
    // scale. That distinction only started to matter once the blocks were
    // allowed to taper: a fixed stride plus a block tapered to 40% leaves a
    // gap two thirds of a block wide at each end of every course, the chain
    // stops overlapping into a wall, and what is left is a line of separate
    // pale blocks on a smooth mountain — the popcorn read, arrived at from the
    // opposite direction to the usual one.
    const stepK = 0.58 + rng() * 0.24;

    for (let dir = -1; dir <= 1; dir += 2) {
      let px = x0, pz = z0;
      // Long. The unit that has to read from 800 m is not the block and not even
      // the course — it is the whole band crossing the face, so a chain runs up
      // to eleven blocks in each direction, 300 m a side.
      const n = Math.max(2, Math.round((4 + rng() * 7) * lenMul));
      // ── the bed is a plane, and a plane cannot close ──────────────────────
      //
      // The necklace has now come back twice, and both previous attempts read
      // it as "this particular ring needs breaking up". It is not. Look at what
      // the walk below used to do: it recomputed `-up.z, up.x` — the local
      // strike — at *every step*. Perpendicular to the local gradient is not
      // the strike, it is the contour, and on a conical massif a contour is a
      // closed ring. So the rule produced a ring **by construction**, and any
      // fix that only perturbs the positions lets it re-form the moment the
      // cone is clean enough. That is exactly what happened between `82cc330`
      // and now.
      //
      // A resistant bed is a *plane in the rock*. Its outcrop is where that
      // plane cuts the topography: straight in plan, bending only as far as the
      // bed is folded, and cut off by the spurs and gullies either side of the
      // face it crops out on. So seed the strike once and CARRY it — which is
      // what `_cragCrest` was already fixed to do, for this same failure, on
      // the crest walk. The altitude correction further down then does the rest
      // on its own: hold a straight plan line at one bed altitude and the chain
      // hugs the face and dies where the ground stops meeting the bed.
      //
      // The old cumulative turn budget is kept, but as a backstop and measured
      // against the *seed line* rather than summed step to step. A sum cannot
      // tell a bed that wanders and comes back from one that circles the peak,
      // and at 1.95 rad it was 112 degrees per direction — 224 across both,
      // three fifths of a ring, before it bound at all.
      this._uphill(px, pz, up);
      if (Math.abs(up.x) + Math.abs(up.z) < 0.05) continue;
      let hx = -up.z * dir, hz = up.x * dir;
      { const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L; }
      const seedX = hx, seedZ = hz;
      // Gaps. A bed is not continuously exposed along its whole outcrop; it is
      // buried under scree, cut by a gully, weathered away. Without this the
      // course is a solid line of touching blocks whatever else varies, and a
      // solid line is a line.
      let gap = 0;
      for (let i = 0; i < n; i++) {
        this._uphill(px, pz, up);
        if (Math.abs(up.x) + Math.abs(up.z) < 0.05) break;
        // Blend a little of the local strike back into the carried heading, so
        // a bed can follow a broad fold — and only while the two still broadly
        // agree, so a spur that swings the gradient through ninety degrees
        // cannot drag the chain around with it. Same guard shape as the crest
        // walk, tighter, because a bed on a face has less excuse to bend than
        // an arete does.
        const tx = -up.z * dir, tz = up.x * dir;
        if (tx * hx + tz * hz > 0.88) {
          hx = hx * 0.80 + tx * 0.20; hz = hz * 0.80 + tz * 0.20;
          const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
        }
        // ~32 degrees off the seed line — 64 across both directions, so the
        // longest arc this can draw is a sixth of a circle whatever the shape
        // of the mountain under it.
        if (Math.acos(clamp(hx * seedX + hz * seedZ, -1, 1)) > 0.55) break;
        const sx = hx, sz = hz;
        // Taper. A course is thickest where the bed is best exposed and thins
        // toward both ends; blocks of one size laid end to end are what makes a
        // chain read as beads however long it is. Evaluated here, before the
        // step, because the stride has to shrink with it or the chain stops
        // overlapping (see stepK).
        const env = 0.50 + 0.50 * Math.sin(Math.PI * Math.min(1, (i + 0.8) / n));
        const step = scale * env * stepK;
        px += sx * step;
        pz += sz * step;
        if (!W.isInBounds(px, pz)) break;

        // Correct back to the bed's altitude along the fall line. Note the
        // sign: `up` points uphill, and a positive error means we have drifted
        // *above* the bed, so the correction walks down. Getting this backwards
        // is a positive feedback — the chain climbs the fall line and comes out
        // as a vertical clump of boulders instead of a horizontal course.
        this._uphill(px, pz, up);
        const slope = clamp(W.getSlope(px, pz), 0.35, 3.0);
        // The bed rolls. Holding the chain at one exact altitude is what draws
        // the isoline — geologically a bed is folded and its outcrop wanders up
        // and down the face by a good fraction of its own thickness. The
        // undulation is a smooth function of world position, so neighbouring
        // courses on the same face roll together and it reads as structure
        // rather than as jitter.
        const rollY = this.noise.fbm(px * 0.0042, pz * 0.0042, 2, 2.1, 0.5, 7) * scale * 1.5;
        const err = W.getHeight(px, pz) - (targetY + rollY);
        const corr = clamp(err / slope, -step * 1.3, step * 1.3);
        px -= up.x * corr; pz -= up.z * corr;
        if (!W.isInBounds(px, pz)) break;
        if (W.getSlope(px, pz) < 0.44) break;        // the bed dies on the bench
        if (this.hardness(px, pz) < 0.22) break;     // and where the rock softens
        if (W.getWaterDepth(px, pz) > 0.5) break;

        // The bed is buried here — advance the walk but leave no rock. One or
        // two slots at a time, so what the gap breaks is one wall into two
        // walls; longer and the segments stop being walls.
        if (gap > 0) { gap--; continue; }
        if (i > 1 && rng() < 0.13) { gap = 1 + ((rng() * 2) | 0); continue; }

        // ── the chain is the unit that has to read, not the block ─────────
        //
        // `minSize` is the per-cell visibility cutoff, and dropping a member
        // that falls under it punches a hole in a wall whose entire design is
        // that neighbours overlap into one mass. Measured on the `peaks`
        // massif at 700-950 m, where the cutoff is 14.5-21 m: 16% of the crag
        // blocks a course generates were being deleted, and they were deleted
        // out of the *middle* of chains, because the taper puts the small ones
        // there as well as at the ends. What is left is a dotted line of
        // separate pale blocks — which is the other half of the necklace. The
        // wall is in the scatter; only its gaps are drawn.
        //
        // At that range the difference between a block at the cutoff and one
        // just under it is well under a pixel. The hole is not. So round the
        // member up to the cutoff instead of dropping it. The whole course is
        // dropped up front when even its largest member cannot clear the
        // cutoff — bare mountain is a far cheaper mistake than a dotted line.
        let size = scale * env * (0.86 + rng() * 0.60);
        if (size * 2 < minSize) size = minSize * 0.5;

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
        // Shove varies block to block, so the face is broken in *plan* as well
        // as in elevation: some blocks stand proud of the wall and some are set
        // back into it. A chain at one constant depth is a flat ribbon, and a
        // flat ribbon on a hillside is the other half of the bead read.
        const shove = (arch === 'cliff' ? 0.14 : 0.20) * (0.62 + rng() * 0.85);
        this._place(px, pz, arch, size * (arch === 'tower' ? 0.66 : 1.0), rng,
          arch === 'cliff' ? 0.62 : 0.55, 0.0, out,
          (arch === 'cliff' ? 0.12 : 0.22) * (0.7 + rng() * 0.8), 'sag',
          shove, yaw);
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
    const n = 5 + ((rng() * 5) | 0);
    // Stride as a fraction of the local block, not of the group's scale — see
    // _contourCourse. The crest taper is steeper than the course's, so this
    // matters more here: at a fixed stride the small blocks at the far end of
    // a crest stand well clear of one another and the arete reads as a row of
    // chips rather than as broken bedrock.
    const stepK = 0.62 + rng() * 0.26;

    for (let dir = -1; dir <= 1; dir += 2) {
      let px = x0, pz = z0;
      // Seed the heading from the strike at the site, then carry it.
      this._uphill(px, pz, up);
      let hx = -up.z * dir, hz = up.x * dir;
      const L0 = Math.hypot(hx, hz) || 1;
      hx /= L0; hz /= L0;

      // Total heading change spent so far. The dot > 0.2 test below rejects
      // only a reversal — it happily allows 78 degrees of turn per step, and
      // on a summit, where the gradient rotates through a full circle, a
      // sequence of legal turns is exactly how the chain ends up ringing the
      // peak. That ring is the "necklace" in `peaks`: twenty-odd near-identical
      // blocks on one isoline, some of them over the back of the summit with
      // sky beneath. A per-step limit alone cannot catch it, because every
      // individual step is small; only the accumulated turn can.
      let turned = 0;
      const seedX = hx, seedZ = hz;
      for (let i = 0; i < n; i++) {
        this._uphill(px, pz, up);
        // Blend the carried heading with the local strike: enough to follow a
        // curving ridge, not enough to let the chain turn back on itself.
        const tx = -up.z * dir, tz = up.x * dir;
        if (tx * hx + tz * hz > 0.86) {
          hx = hx * 0.74 + tx * 0.26; hz = hz * 0.74 + tz * 0.26;
          const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
        }
        turned = Math.acos(clamp(hx * seedX + hz * seedZ, -1, 1));
        if (turned > 1.05) break;               // ~60 degrees off the seed line
        // Tapering profile, so the group has a summit rather than a flat top.
        const t = 1 - (i / n) * 0.75;
        const step = scale * (0.62 + t * 0.62) * stepK;
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

        // Widened from 0.84–1.20. A crest built out of blocks that differ by
        // 40% is a broken outcrop; one built out of blocks that differ by 15%
        // is a row of teeth, and at 800 m the eye reads the *repeat* long
        // before it reads any individual block.
        const size = Math.min(scale * (0.62 + t * 0.62) * (0.70 + 0.72 * rng()), 12);
        if (size * 2 < minSize) continue;
        // A notch in the crest. Not every metre of an arete is bedrock; the
        // gaps are what let the sky through in the places a crest is supposed
        // to let it through, instead of under blocks that are meant to be
        // standing on the ridge.
        if (i > 1 && rng() < 0.11) continue;

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

  /**
   * How deep a crag block of size `s` has to sit before every one of its base
   * probes is in the hill. Fills `this._req` with, per probe, the highest the
   * block's centre may be and still have that part of the base in contact, and
   * returns how many probes the mesh actually reaches.
   *
   * A method rather than a closure inside `_place` on purpose: placement runs
   * thousands of times per cell build and must not allocate.
   */
  _probeBase(x, z, q, fp, s) {
    const W = this.world;
    const v = this._fv, req = this._req;
    // The per-axis scale jitter applied at push time is 0.84–1.18, and it pulls
    // both ways: a wider block reaches further downhill, a shallower one has
    // less of itself to bury. Take the unsafe end of each.
    const ex = fp.rx * s * 1.18, ez = fp.rz * s * 1.18;
    let n = 0;
    for (let k = 0; k < BASE_SAMPLES.length; k += 2) {
      const sx = BASE_SAMPLES[k], sz = BASE_SAMPLES[k + 1];
      const lo = fp.lo[(sx + 1) * 3 + (sz + 1)];
      if (lo === null || lo === undefined) continue;      // mesh does not reach here
      v.set(sx * ex, lo * s * 0.84, sz * ez).applyQuaternion(q);
      req[n++] = W.getHeight(x + v.x, z + v.z) - v.y;
    }
    return n;
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

    // ── loose-stone clumping ─────────────────────────────────────────────────
    //
    // Rubble is by far the most numerous thing this system emits and by far the
    // smallest, and every cluster type sheds it. Summed over the three or four
    // clusters that overlap on any given hillside, the result is a field of
    // near-identical pebbles at constant density from the camera to the horizon
    // — "perfectly even scatter density" and "every object the same size", two
    // separate entries on the brief's automatic-reject list, arrived at without
    // any single cluster being at fault.
    //
    // A 50 m clump field over the top fixes it where it is caused: loose stone
    // collects in some places and not others, so about half the ground carries
    // none at all and the eye gets the negative space that makes the rest read
    // as deliberate. Deliberately NOT applied to anything larger — a boulder or
    // a crag block is placed by a geological argument and must not be second
    // guessed by a noise field.
    // Gated on size rather than on archetype alone: measured at the `drive` and
    // `river` anchors, the even sprinkle is not mostly rubble, it is knee-high
    // `boulder` from erratic courts and rib debris. The threshold is where a
    // stone stops being a *thing in the picture* and becomes ground texture.
    if (arch === 'rubble' || size < 1.0) {
      if (this.noise.fbm(x * 0.021, z * 0.021, 2, 2.1, 0.5, 13) < -0.08) return;
    }

    const n = this._n;
    W.getNormal(x, z, n, Math.max(1.0, size * 0.8));

    // Which mesh variant this instance will draw. Chosen here, not by the
    // caller, because the anchor below has to measure the base of the shape
    // that is actually going to be drawn — variants of one archetype differ in
    // base depth by half a block. From a position hash rather than the rng, so
    // choosing it consumes nothing and the rest of the cell is unchanged.
    const vlist = this._foot[arch];
    const variant = vlist
      ? Math.min(vlist.length - 1,
        (hash2i(Math.round(x * 3), Math.round(z * 3), this._archSeed[arch]) * vlist.length) | 0)
      : 0;

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
      const fp = this._foot[arch]?.[variant] ?? FOOT_FALLBACK;

      // ── shrink to fit ────────────────────────────────────────────────────
      //
      // A block whose base cannot be got into the ground within MAX_PLANT used
      // to be clamped: planted as deep as allowed and left with the rest of its
      // base in the air. That is the residual "sky visible beneath them" the
      // critic found on the `dawn` and `peaks` crests, and it is a different
      // case from the one the base-clearance audit measured — on a *ridge* the
      // ground falls away on both sides, so the plant depth a block needs grows
      // with its own width and a big enough block can never be seated.
      //
      // The answer is not to bury it further (it disappears) and not to drop it
      // (the chain gets a hole), but to make it smaller: the required depth
      // falls roughly with size, the allowance falls exactly with size, so a
      // block that does not fit at 20 m fits at 12 m and is still a block on a
      // ridge. Two damped steps get within a few percent; a third is noise.
      //
      // Two guards on how hard this is allowed to pull, both learned by
      // capture. Unbounded, it shrank crest blocks to a third of their size on
      // steep ground and the massifs came back sprinkled with pale chips —
      // which is the anti-pattern this whole system exists to avoid, traded
      // straight across for the floating one.
      //
      //   * the criterion is the BASE_TOLERATE'th lowest probe — the same one
      //     the anchor below uses, which is the whole point. A crag block
      //     straddling an arete has to have a corner over air; that is what an
      //     overhang is, and demanding all nine probes be in the hill on a
      //     convex ridge is a demand no block of any size can meet.
      //   * and it may not lose more than half its size whatever happens. Past
      //     that the block has stopped being the thing the course needed —
      //     instead the guard after the loop throws it away.
      const size0 = size;
      let nreq = this._probeBase(x, z, q, fp, size);
      let plant = 0;
      for (let it = 0; it < 4; it++) {
        if (nreq === 0) { this._req[0] = centreH; nreq = 1; }
        // The BASE_TOLERATE'th lowest probe, without sorting the whole array.
        let ref = Infinity;
        for (let k = 0; k < nreq; k++) {
          let seen = 0;
          for (let j = 0; j < nreq; j++) if (this._req[j] < this._req[k]) seen++;
          if (seen === Math.min(BASE_TOLERATE, nreq - 1)) { ref = this._req[k]; break; }
        }
        if (!isFinite(ref)) ref = centreH;
        plant = centreH - ref;
        if (plant <= size * MAX_PLANT) break;
        const next = Math.max(size * clamp((size * MAX_PLANT) / plant, 0.72, 0.94), size0 * 0.50);
        if (next >= size - 1e-3) break;
        size = next;
        nreq = this._probeBase(x, z, q, fp, size);
      }
      // Nowhere to stand. The block has been shrunk as far as it is allowed to
      // go and its base still cannot be got into the hill, which happens where
      // a crest walk runs off the end of an arete: the ground falls away on
      // every side and the "hillside" under the block is a hundred metres down.
      // Clamping there is what put a house-sized slab in clear sky above the
      // ridge in `waterfall`, the single worst artifact this system has shipped.
      // A hole in a chain is a much cheaper mistake than a rock in the sky.
      if (plant > size * MAX_PLANT * 1.30) return;

      const reqs = this._req.subarray(0, nreq);
      reqs.sort();
      // Not the strict minimum: BASE_TOLERATE of the nine probes are allowed to
      // stay above ground. One corner of a thirty-metre wall reaching out over
      // a gully is an overhang, which is what a cliff band is supposed to do;
      // obeying it would sink the other twenty-five metres out of sight, and
      // the whole course with it — which is how the first attempt at this left
      // a single tooth showing out of a five-block chain, the loneliest thing
      // in the frame.
      let need = reqs[Math.min(BASE_TOLERATE, nreq - 1)];
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

    // The per-axis jitter, drawn here rather than inside the push so that the
    // road veto below can drop this instance without disturbing anything else
    // in the cell. The rng is shared by every rock in a 64 m cell, so a veto
    // that skips draws reshuffles its neighbours — which is exactly the kind of
    // "the before and after are not the same place" comparison this project has
    // already lost time to twice. Consume first, decide after.
    const jx = size * (0.86 + rng() * 0.30);
    const jy = size * (0.84 + rng() * 0.34);
    const jz = size * (0.86 + rng() * 0.30);
    const jTint = rng() * 2 - 1;
    const jRnd = rng();

    // ── road clearance ───────────────────────────────────────────────────────
    //
    // See ROAD_TRACK / ROAD_STANDOFF above. `rx`/`rz` are the same local
    // half-extents `_probeBase` plants the block against, and 1.18 is the same
    // upper bound on the per-axis jitter, so "reach" here is the furthest this
    // instance can actually extend from its origin in plan — the quantity that
    // decides whether it is standing in the road, rather than a nominal size.
    //
    // Late, after the crag shrink loop, because a block that shrank to fit a
    // ridge needs less clearance than the one that was requested.
    if (this.roadClearance) {
      const fpr = this._foot[arch]?.[variant] ?? FOOT_FALLBACK;
      const reach = Math.max(fpr.rx, fpr.rz) * size * 1.18;
      if (this._roads.anyWithin(x, z, ROAD_TRACK + reach * ROAD_STANDOFF)) return;
    }

    out.push({
      x, y: minH - size * sink, z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      sx: jx,
      sy: jy,
      sz: jz,
      arch,
      kind: this._kind,
      variant,                          // clamped to the library by the caller
      size,
      wet: clamp01(depth * 1.4 + river * 0.30),
      moisture: W.getMoisture(x, z),
      tint: jTint,
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
      // The true terrain height at the origin, not the anchor: the anchor is
      // deliberately a few metres under the surface, and hanging the contact
      // band off it puts the dark line below the ground where nobody can see
      // it. The band belongs where the rock actually enters the hill.
      groundY: centreH,
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
      rnd: jRnd,
    });
  }
}

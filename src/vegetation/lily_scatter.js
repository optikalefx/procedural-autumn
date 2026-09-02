// ─────────────────────────────────────────────────────────────────────────────
//  lily_scatter — where the pads are. Placement only; no geometry, no GL.
//
//  Pure function of (world, seed, cell): the same cell always yields the same
//  pads, in the same order, so the streaming system can drop a cell and rebuild
//  it, and anything that later lives ON a pad (the frogs) can rediscover the
//  exact pad it was standing on from the cell coordinates alone. Nothing here
//  touches three.js, so `tools/_scratch/lilycensus.mjs` runs it over the whole
//  map in node against the real bake.
//
//  ── habitat ─────────────────────────────────────────────────────────────────
//
//  Water lilies root in the bed and float their leaves, so the pad's habitat
//  is a statement about the BED under the water, not about the water:
//
//    · STANDING water. The baked river mask and the flow field's discharge
//      both have to read as still — a pad in a current is torn off its stem.
//      Same discriminator the boat uses for lake-vs-river (boat_site.js).
//    · SHALLOW. Depth between ~0.25 and ~2.6 m of the drawn surface. The
//      stems of real pads run to about two metres; deeper than that the pad
//      is a floating green disc with no reason to be there.
//    · NEAR A SHORE. The hydro sdf (metres inside the waterline) between about
//      1.5 and 15 m. The shore band, not the shoreline itself: a pad touching
//      the bank sits on the damp margin the water shader fades out over.
//    · OPEN water. The hydro `span` has to read as a body rather than a
//      thread — a rivulet that happens to be still is not a pond.
//
//  ── clustering ──────────────────────────────────────────────────────────────
//
//  Pads come in colonies because one rhizome throws many leaves. Three scales:
//
//    1. A low-frequency COVERAGE noise (~120 m) decides which stretches of
//       shore have lilies at all. Most do not; a lake with pads on one bay and
//       clear water on the next reads as a place, a lake fringed all the way
//       round reads as a texture.
//    2. CLUSTER CENTRES are thrown per cell and kept by the habitat score.
//    3. Each cluster fills a disc of 2.5–9 m with pads drawn toward its middle,
//       sizes skewed small with a few big leaves, and a soft overlap rule —
//       real pads shingle over each other, so up to ~30% overlap is allowed
//       and only a pad landing on top of another is rejected.
//
//  The pad record is the contract with everything downstream:
//    x, z        stem position, world metres
//    y           the drawn water level there (the pad floats on it)
//    r           radius, metres        sx   squash across (ellipse), 0.84–1
//    rot         Y rotation, radians (the notch faces +Z locally)
//    variant     index into LILY_VARIANTS
//    phase, w    bob phase and angular rate — see LilyPads.padTop
//    age         0 green .. 1 turning; tint  0..1 hue jitter
//    vis         draw radius, metres, from size
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, smoothstep, mulberry32, hash2i } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';
import { LILY_VARIANTS } from './lily_forms.js';

// ── habitat window ───────────────────────────────────────────────────────────
export const SDF_MIN = 1.5, SDF_MAX = 15;        // metres inside the waterline
export const DEPTH_MIN = 0.22, DEPTH_MAX = 2.6;  // metres of water under the pad
export const MAX_RIVER = 0.05;                   // baked river mask (boat_site)
export const MAX_FLOW = 0.18;                    // |flow| coherence·direction
export const MIN_SPAN = 2.2;                     // hydro openness
// The pad size distribution. Skewed toward small: most leaves in a colony are
// young. `BIG_CHANCE` of them come from the upper band.
export const R_MIN = 0.13, R_MAX = 0.62, BIG_CHANCE = 0.18;
// Draw radius per metre of pad radius. A 0.5 m pad is a 4-pixel dot at 150 m
// on a 1600-wide frame; beyond that a colony is only a tint on the water.
const VIS_PER_M = 260, VIS_FLOOR = 60, VIS_CAP = 150;
// Cluster-centre throws per cell (64 m). The habitat score is what keeps most
// of them; on a dry cell the pre-check below never gets this far.
const CLUSTER_TRIES = 12;

export class LilyScatter {
  /**
   * @param world   WorldData — getHydro, getWaterDepth, getWaterHeight,
   *                getRiver, getFlow, isInBounds
   * @param seed    world seed
   * @param opts.density   multiplier on colony acceptance (quality tiers)
   */
  constructor(world, seed, opts = {}) {
    this.world = world;
    this.seed = seed | 0;
    this.density = opts.density ?? 1;
    this.cover = new NoiseField((seed ^ 0x1e3a5) >>> 0);
    this._hy = {};
    this._fl = {};
  }

  /**
   * Which stretches of shore have lilies at all. 0..1, ~120 m features,
   * thresholded so roughly a third of suitable shore carries a colony and the
   * rest is clear water.
   */
  coverage(x, z) {
    const n = this.cover.fbm(x * (1 / 120), z * (1 / 120), 2, 2.1, 0.5, 1);
    return smoothstep(0.02, 0.42, n);
  }

  /**
   * Habitat score 0..1 at a point — the product of the four windows in the
   * header. Zero means "no pad may exist here", and the per-pad check below
   * uses the same function so a pad can never land where a cluster could not.
   */
  habitat(x, z) {
    const W = this.world;
    if (!W.isInBounds(x, z)) return 0;
    const h = W.getHydro(x, z, this._hy);
    if (h.wet < 0.55 || h.sdf < SDF_MIN || h.sdf > SDF_MAX) return 0;
    if (W.getRiver(x, z) > MAX_RIVER) return 0;
    const f = W.getFlow(x, z, this._fl);
    if (Math.hypot(f.vx, f.vz) > MAX_FLOW || f.q > 0.2) return 0;
    const d = W.getWaterDepth(x, z);
    if (d < DEPTH_MIN || d > DEPTH_MAX) return 0;
    if (h.span < MIN_SPAN) return 0;
    const shore = smoothstep(SDF_MIN, SDF_MIN + 2.0, h.sdf) * (1 - smoothstep(SDF_MAX - 6, SDF_MAX, h.sdf));
    const depth = smoothstep(DEPTH_MIN, DEPTH_MIN + 0.3, d) * (1 - smoothstep(DEPTH_MAX - 0.8, DEPTH_MAX, d));
    const open = smoothstep(MIN_SPAN, MIN_SPAN + 2.5, h.span);
    return shore * depth * open;
  }

  /** Cheap reject: does this cell touch any shore-band water at all? */
  _cellHasShore(x0, z0, cell) {
    const W = this.world, h = this._hy;
    const n = 5, step = cell / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * step, z = z0 + (j + 0.5) * step;
        if (!W.isInBounds(x, z)) continue;
        W.getHydro(x, z, h);
        // Anywhere within a step of the band counts; the throws decide.
        if (h.sdf > -step && h.sdf < SDF_MAX + step && h.wet > 0.05) return true;
      }
    }
    return false;
  }

  /**
   * Generate every pad of cell (cx, cz) into `out`. Returns the number of
   * clusters placed (for the census; the pads are what matter).
   */
  generateCell(cx, cz, cell, out) {
    const W = this.world;
    const x0 = cx * cell, z0 = cz * cell;
    if (!this._cellHasShore(x0, z0, cell)) return 0;

    const rng = mulberry32((hash2i(cx, cz, this.seed ^ 0x9ad5) * 4294967296) >>> 0);
    let clusters = 0;
    const padsHere = [];

    for (let t = 0; t < CLUSTER_TRIES; t++) {
      const kx = x0 + rng() * cell, kz = z0 + rng() * cell;
      // Every throw consumes the same rng calls whether or not it lands, so a
      // rejected throw cannot shift the pads of the accepted ones after it.
      const u1 = rng(), u2 = rng(), u3 = rng();
      const score = this.habitat(kx, kz) * this.coverage(kx, kz) * this.density;
      if (u1 >= score) continue;

      // The colony: a disc, denser toward its middle, radius from openness.
      const R = 2.5 + u2 * u2 * 6.5;
      // Pads per colony: a MAT, not a sprinkle. Throws per square metre of
      // colony, most of which the shingle rule and the habitat test will
      // reject; what survives is roughly one leaf per half square metre at
      // the middle, thinning to the edge. The first cut threw a quarter of
      // this and the colonies read as coins scattered on the water.
      const K = Math.min(140, Math.round(R * R * (1.6 + u3 * 1.2)));
      const start = padsHere.length;
      // Colony-wide traits: one rhizome's leaves are alike in colour and age.
      const cTint = rng(), cAge = rng() * rng();
      const crng = mulberry32((hash2i(Math.round(kx * 3), Math.round(kz * 3), this.seed) * 4294967296) >>> 0);

      for (let k = 0; k < K; k++) {
        const ang = crng() * Math.PI * 2;
        const rad = Math.pow(crng(), 0.65) * R;
        const px = kx + Math.sin(ang) * rad, pz = kz + Math.cos(ang) * rad;
        const s1 = crng(), s2 = crng(), s3 = crng(), s4 = crng(), s5 = crng(), s6 = crng();
        // Size: skewed small, with a big-leaf band.
        const r = s1 < BIG_CHANCE
          ? 0.42 + s2 * (R_MAX - 0.42)
          : R_MIN + Math.pow(s2, 1.5) * (0.46 - R_MIN);
        // The pad itself has to be over lily ground — a colony on a shelf
        // edge drops the leaves that would hang over the deep.
        if (this.habitat(px, pz) <= 0) continue;
        // Shingle rule: reject only a pad sitting ON another. 0.64 of the
        // summed radii lets leaves overlap by about a third, which is how a
        // real mat packs; the drawn order (bigger pads pack first within a
        // cell, and sit a hair higher by their curl) keeps the overlap legible.
        let ok = true;
        for (let i = start; i < padsHere.length; i++) {
          const p = padsHere[i];
          const dx = p.x - px, dz = p.z - pz;
          const lim = (p.r + r) * 0.64;
          if (dx * dx + dz * dz < lim * lim) { ok = false; break; }
        }
        if (!ok) continue;
        const y = W.getWaterHeight(px, pz);
        if (y === null) continue;
        padsHere.push({
          x: px, z: pz, y, r,
          sx: 0.84 + s3 * 0.16,
          rot: s4 * Math.PI * 2,
          variant: (s5 * LILY_VARIANTS.length) | 0,
          phase: s6 * Math.PI * 2,
          // Bob rate 0.7–1.3 rad/s; smaller pads ride the ripples faster.
          w: 0.7 + 0.6 * (1 - (r - R_MIN) / (R_MAX - R_MIN)) * (0.6 + 0.4 * crng()),
          age: clamp01(cAge * 0.7 + crng() * crng() * 0.5),
          tint: clamp01(cTint * 0.7 + crng() * 0.3),
          vis: clamp(r * VIS_PER_M, VIS_FLOOR, VIS_CAP),
          cell: cx * 100003 + cz,
        });
      }
      if (padsHere.length > start) clusters++;
    }
    for (const p of padsHere) out.push(p);
    return clusters;
  }
}

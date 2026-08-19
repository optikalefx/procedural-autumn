// ─────────────────────────────────────────────────────────────────────────────
//  Ground-cover placement.
//
//  Everything is generated per 48 m cell, deterministically, from world data.
//  Three ideas do all the work:
//
//  1. CLUMPS, EDGES AND CLEARINGS — never a scatter. Each layer draws its own
//     low-frequency field, thresholds it hard, and emits *sites* that then emit
//     2-5 members. Large stretches get nothing at all, which is what makes the
//     stretches that do get something read as thickets and drifts.
//
//  2. THE LAYER IS COMPOSED AGAINST THE TREES, not merely correlated with them.
//     Trees.js publishes its placement arrays, so undergrowth, deadfall and
//     leaf litter are placed off *actual trunks and actual crowns* — a skirt of
//     fern and moss at the base, litter drifted downwind of deciduous crowns —
//     rather than off a moisture field that happens to look similar. A coarse
//     canopy raster stamped from the same array gives the cheap field lookup
//     that the per-candidate tests need.
//
//  3. NOTHING STANDS IN WATER, and the test is per *instance*, not per site.
//     The grass author lost a round to exactly this: a clump centre that tests
//     dry frays members several metres out, and on a lake shore — where the
//     river mask is zero and only depth can tell you there is water — that puts
//     plants in open water. Every emitted instance gets its own eight-point
//     spill probe at its own footprint radius.
//
//  A note on determinism under streaming. A cell is regenerated at a finer
//  detail band as the camera approaches, and anything already visible must come
//  back bit-identical or the field visibly reshuffles in front of the player.
//  That is why every *site* owns an independent RNG stream keyed on (cell,
//  layer, site index) instead of drawing from one sequential stream: skipping a
//  band-gated block then cannot shift the draws of the site after it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NoiseField } from '../core/Noise.js';
import { clamp01, smoothstep, mulberry32, hash2i } from '../core/MathUtils.js';
// Shared with the grass field on purpose: the wheel ruts have to be bare in
// both layers, or the track reads as a mown stripe with bushes growing in it.
import { RoadMask } from './grass_scatter.js';
import { SPECIES } from './tree_species.js';
import { ARCH_INDEX, COVER_ARCHETYPES } from './cover_forms.js';

const TAU = Math.PI * 2;

// Floats per instance in the flat cell buffers.
//  0..2  position      3  yaw        4..6  scale
//  7..9  colour A     10..12 colour B
//  13 wind amp   14 wind phase   15 tone   16 vis radius
//  17 archetype  18 variant      19,20 terrain normal xz
export const COVER_STRIDE = 21;

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// Palette. Dark green and dark maroon are the two value anchors this layer
// exists to supply; everything else is accent. Nothing here is at full
// saturation, and nothing here is grey.
const PAL = {
  // Everything here was lifted by about 1.8x in linear over the previous
  // values, and the reason is measured rather than aesthetic: see
  // docs/INTEGRATION_REQUESTS.md item 5. A flat warm term downstream of every
  // material floors any surface darker than ~0.10 linear at rendered
  // sRGB (72, 61, 49), so at the old values this layer's entire palette was
  // arriving at the screen indistinguishable from pure black — a capture with
  // the albedo forced to `vec3(0.0)` measured the same pixel to within one
  // level. These values are still dark against the meadow (the reference's own
  // shrubs sit at 0.72 of its sunlit gold's luma, and ours land close to that);
  // they are simply far enough above the floor for form and hue to survive it.
  // Widened. The pair sets the whole value range available inside a bush, and
  // at #668f5f -> #9cc072 that range was about a fifth of a stop — so a form
  // rebuilt specifically to *carry* interior value had almost none to carry.
  // Both ends stay well clear of the black floor described above; the deep end
  // is the brief's own conifer anchor family, which is what the reference's
  // shaded bush foliage measures at.
  shrubDeep:   C(0x557a50), shrubLit:    C(0xaecb75),
  shrubMaroon: C(0xa8613f), shrubMarLit: C(0xd08a48),
  berryLeaf:   C(0x9c5236), berryLit:    C(0xd4652c), berry: C(0xbe4038),
  // A step darker and a step more saturated than the terrain's sunlit gold
  // (#f0ad46). Dry scrub against gold meadow is a *tonal* accent — it has to
  // sit below the ground it stands on or it reads as a pale rag.
  scrubBase:   C(0xc9954c), scrubTip:    C(0xefc972), scrubPale: C(0xdcaf5e),
  // Plate 1's open meadow is dotted with small *rust* tufts, not only tan
  // ones. They are the mid rung of the size ladder and the only warm-red note
  // at ankle height, so a share of the dry scrub takes them.
  scrubRust:   C(0xb56a35), scrubRustTip: C(0xd99a4e),
  willow:      C(0x8fa855), willowTip:   C(0xd8e078),
  alder:       C(0x6b8a4e), alderTip:    C(0xaec258),
  fernBase:    C(0x718646), fernBronze:  C(0xd08e4e), fernGold: C(0xecc05e),
  broadleaf:   C(0x6a884b), broadTip:    C(0xb0c45c),
  moss:        C(0x7a9a55), mossDeep:    C(0x58754a),
  stem:        C(0x96a05a), stemDry:     C(0xc0b26a),
  aster:       C(0xa993e4), asterPink:   C(0xd292c8),
  goldenrod:   C(0xf3d060),
  seedTip:     C(0xe3cd9e),
  // Lifted about a fifth. The rule these follow is still the right one — a
  // fallen leaf must be a step *down* from the meadow it lies on or it reads
  // as paper confetti — but a step down from #f0ad46 is a warm rust, and at
  // the previous values a leaf scatter at 2 m read as small black chips.
  // `litterRed` warmed and lifted a step. At #b04338 a single fallen leaf on
  // sunlit gold was a hard, near-black-red diamond — the value gap the rule
  // above asks for, overshot into a hole. It still sits below the meadow; it
  // is simply on the rust side of red rather than the blood side.
  litterWarm:  C(0xd2803a), litterGold:  C(0xe8b455), litterRed: C(0xbe5a3a),
  // Weathered wood, and much paler than it looks written down. Forcing this
  // pair to pure white and re-capturing showed a correctly lit, clearly
  // faceted cylinder, so the normals and the light were always fine — the
  // previous 0xa1968a simply arrived at the screen as a flat black band across
  // the bottom of the `forest` frame. Plate 2 and plate 5 back the pale
  // reading anyway: their fallen wood and driftwood are near the value of the
  // rock, not the value of the shadow.
  barkGrey:    C(0xd6ccbc), barkWarm:    C(0xb69878),
  // Ground substrate. Stone follows the brief's rock anchors exactly —
  // lavender-grey lit, violet-grey shaded, never brown-grey — and it is the
  // only cool note this layer puts at ground level. Straw sits just below the
  // sunlit meadow gold so a mat of it reads as texture, not as a bald patch.
  // Pushed further round toward violet than the brief's literal `#c3bfcc` /
  // `#5c5a75`, because the key light is strongly gold: a stone authored at
  // neutral lavender arrives on screen as salmon, and the only cool note
  // this layer is allowed at ground level then does not exist.
  //
  // PULLED BACK HALF WAY, and the frame that decides it is `river`. On the big
  // shaded slope that fills the left of that view the ground is a desaturated
  // blue-teal, so the gold key is not there to warm these back toward neutral —
  // and forty stones authored at (211,208,230) come out as the highest-chroma
  // marks anywhere in the picture, hot pink on cold teal. That is the critic's
  // blocker 4 ("the cool half is arriving as candy pink") with this layer's
  // fingerprints on it. The compensation is only correct in *sunlight*, so it
  // has to be small enough to survive being wrong in shade: half the violet
  // push, and both ends down toward the brief's own `#c3bfcc` / `#5c5a75`.
  stoneLit:    C(0xc6c3d7), stoneDeep:   C(0x82819e),
  strawPale:   C(0xecc47c), strawDeep:   C(0xc69a58),
};

// Fixed leaf-drift direction. Litter piles downwind of a crown, and the whole
// valley agreeing on one prevailing wind is what makes that read as weather
// rather than as random offsetting.
const DRIFT_X = Math.cos(0.7), DRIFT_Z = Math.sin(0.7);

const CAN_CELL = 6;                  // metres per canopy raster cell

// Layer salts. Distinct constants so no two layers can ever share a stream.
const L_OPEN = 0x51a1, L_SCRUB = 0x5c2b, L_BANK = 0xba17;
const L_UNDER = 0x0fe2, L_FLOWER = 0xf10e, L_LITTER = 0x11e2, L_DEAD = 0xdead;
const L_GROUND = 0x9704, L_STONE = 0x5701;

export class CoverScatter {
  constructor(world, seed, opts = {}) {
    this.world = world;
    this.seed = seed >>> 0;
    this.mul = opts.mul ?? 1;
    this.noise = new NoiseField(seed ^ 0xc07e21);
    this.roads = new RoadMask(world, 4);

    this.canRes = Math.ceil((world.half * 2) / CAN_CELL) + 1;
    this.canopy = new Uint8Array(this.canRes * this.canRes);
    this.litter = new Uint8Array(this.canRes * this.canRes);
    this.trees = null;

    this._w = {};                    // surface-weight scratch
    this._c = new THREE.Color();
    this._c2 = new THREE.Color();
    this._hsl = {};
  }

  // ── canopy rasters ─────────────────────────────────────────────────────────

  /**
   * Stamp Trees.js's placement into two coarse fields: where there is a crown
   * overhead, and where its leaves land. Both are read hundreds of times per
   * cell, so they have to be a texture lookup rather than a spatial query.
   */
  attachTrees(trees) {
    this.trees = (trees && trees.n) ? trees : null;
    if (!this.trees) return;
    const { n, px, pz, pspec, pImpW } = trees;
    for (let t = 0; t < n; t++) {
      const w = Math.max(1.2, pImpW[t]);
      this._stampDisc(this.canopy, px[t], pz[t], w * 0.95, 235);
      if (!SPECIES[pspec[t]]?.conifer) {
        this._stampDisc(this.litter, px[t] + DRIFT_X * w * 0.55,
                        pz[t] + DRIFT_Z * w * 0.55, w * 1.10, 210);
      }
    }
  }

  _stampDisc(grid, x, z, r, peak) {
    const res = this.canRes, half = this.world.half;
    const gx = (x + half) / CAN_CELL, gz = (z + half) / CAN_CELL;
    const R = Math.max(1, Math.ceil(r / CAN_CELL));
    const ci = Math.round(gx), cj = Math.round(gz);
    for (let j = -R; j <= R; j++) {
      const jj = cj + j; if (jj < 0 || jj >= res) continue;
      for (let i = -R; i <= R; i++) {
        const ii = ci + i; if (ii < 0 || ii >= res) continue;
        const d = Math.hypot((ii - gx) * CAN_CELL, (jj - gz) * CAN_CELL);
        if (d > r) continue;
        const v = peak * (1 - smoothstep(r * 0.35, r, d));
        const o = jj * res + ii;
        // Max, not add: two overlapping crowns are still one canopy.
        if (v > grid[o]) grid[o] = v;
      }
    }
  }

  _sample(grid, x, z) {
    const res = this.canRes, half = this.world.half;
    const gx = (x + half) / CAN_CELL, gz = (z + half) / CAN_CELL;
    const i0 = Math.floor(gx), j0 = Math.floor(gz);
    if (i0 < 0 || j0 < 0 || i0 >= res - 1 || j0 >= res - 1) return 0;
    const fx = gx - i0, fz = gz - j0;
    const a = grid[j0 * res + i0], b = grid[j0 * res + i0 + 1];
    const c = grid[(j0 + 1) * res + i0], d = grid[(j0 + 1) * res + i0 + 1];
    return ((a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz) / 255;
  }

  /** Canopy without trees: a moisture stand-in, so the layer degrades sanely. */
  _canopyAt(x, z) {
    if (this.trees) return this._sample(this.canopy, x, z);
    return clamp01(smoothstep(0.48, 0.78, this.world.getMoisture(x, z)));
  }

  _litterAt(x, z) {
    if (this.trees) return this._sample(this.litter, x, z);
    return clamp01(smoothstep(0.55, 0.85, this.world.getMoisture(x, z)) * 0.7);
  }

  // ── ground suitability ─────────────────────────────────────────────────────

  /**
   * Is this exact spot plantable, and how strongly? `foot` is the instance's
   * own footprint radius — the eight-point probe is the whole reason nothing in
   * this layer ends up standing in a lake.
   */
  _ground(x, z, foot) {
    const W = this.world;
    if (!W.isInBounds(x, z)) return 0;
    if (W.getWaterDepth(x, z) > 0.15) return 0;
    const s = foot, d = foot * 0.72;
    if (W.getWaterDepth(x + s, z) > 0.15 || W.getWaterDepth(x - s, z) > 0.15 ||
        W.getWaterDepth(x, z + s) > 0.15 || W.getWaterDepth(x, z - s) > 0.15 ||
        W.getWaterDepth(x + d, z + d) > 0.15 || W.getWaterDepth(x - d, z + d) > 0.15 ||
        W.getWaterDepth(x + d, z - d) > 0.15 || W.getWaterDepth(x - d, z - d) > 0.15) return 0;

    const slope = W.getSlope(x, z);
    if (slope > 1.20) return 0;
    const w = W.getSurfaceWeights(x, z, this._w);
    if (w.rock > 0.60 || w.snow > 0.45) return 0;

    let g = (1 - smoothstep(0.18, 0.58, w.rock)) * (1 - w.snow);
    g *= 1 - smoothstep(0.50, 1.08, slope);
    g *= 1 - this.roads.sample(x, z) * 0.97;
    return g;
  }

  /**
   * Plantability for a 10 cm object. No eight-point spill probe and no surface
   * weights: a pebble cannot straddle a shoreline, and this runs a few hundred
   * times per cell where `_ground` runs a few dozen.
   *
   * Roads are only *thinned* here, not excluded. A dirt track with stones and
   * twigs on it reads as a track; a track swept clean of them reads as a
   * painted stripe, and the 2 m close-up the critic measured is taken standing
   * on one.
   */
  _groundTiny(x, z, wet = false) {
    const W = this.world;
    if (!W.isInBounds(x, z)) return 0;
    if (W.getWaterDepth(x, z) > 0.08) return 0;
    // Near a shoreline the single centre sample is not enough: a leaf patch is
    // 30-70 cm across and a straw mound close to a metre, so a centre that
    // tests dry puts half the prop out over open water. `close-grass-2m` shows
    // exactly that — gold straw and orange leaf chips lying on the river
    // surface a metre from the bank, which is the same defect the eight-point
    // probe in `_ground` exists to prevent, on the layer that skipped it for
    // cost. The probe is only run where the site's own coarse test said there
    // was water within a metre and a half, so open meadow still pays one
    // lookup.
    if (wet) {
      const s = 0.42;
      if (W.getWaterDepth(x + s, z) > 0.08 || W.getWaterDepth(x - s, z) > 0.08 ||
          W.getWaterDepth(x, z + s) > 0.08 || W.getWaterDepth(x, z - s) > 0.08) return 0;
    }
    if (W.getSlope(x, z) > 1.35) return 0;
    return 1 - this.roads.sample(x, z) * 0.30;
  }

  /** Is there water within ~1.5 m of here? Four lookups, per clump site. */
  _nearWater(x, z) {
    const W = this.world, s = 1.5;
    return W.getWaterDepth(x + s, z) > 0.02 || W.getWaterDepth(x - s, z) > 0.02 ||
           W.getWaterDepth(x, z + s) > 0.02 || W.getWaterDepth(x, z - s) > 0.02;
  }

  // ── instance emission ──────────────────────────────────────────────────────

  /**
   * Write one instance. Colours are jittered per instance (value, saturation
   * and a small hue rotation) because forty identical greens read as decals;
   * the reference's bushes differ from their neighbours by a visible amount.
   */
  _emit(out, n, cap, archKey, x, z, rng, o) {
    if (n >= cap) return n;
    const W = this.world;
    const ai = ARCH_INDEX[archKey];
    const arch = COVER_ARCHETYPES[ai];
    const y = W.getHeight(x, z) - (o.sink ?? 0.04);

    // Terrain normal from the same central difference the grass field uses.
    //
    // `flat` skips it. Four extra `getHeight` calls are ~80% of the cost of
    // emitting one instance, and the substrate props are 3-30 cm objects that
    // only ever take 55% of the terrain's tilt anyway — a pebble leaning half a
    // degree is not a thing anyone can see. Skipping it is what makes the
    // several-thousand-instance ground layer affordable inside the per-frame
    // cell budget; without it the density this layer needs was a measurable
    // hitch on every new cell.
    let gx = 0, gz = 0, inv = 1;
    if (!o.flat) {
      const e = 0.9;
      gx = (W.getHeight(x + e, z) - W.getHeight(x - e, z)) / (2 * e);
      gz = (W.getHeight(x, z + e) - W.getHeight(x, z - e)) / (2 * e);
      inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    }

    const c = this._c.copy(o.colA);
    const c2 = this._c2.copy(o.colB);
    const hue = o.hue ?? 0.035;
    c.getHSL(this._hsl);
    c.setHSL(this._hsl.h + (rng() - 0.5) * hue,
             clamp01(this._hsl.s * (0.90 + rng() * 0.22)),
             clamp01(this._hsl.l * (0.82 + rng() * 0.30)));
    c2.getHSL(this._hsl);
    c2.setHSL(this._hsl.h + (rng() - 0.5) * hue,
              clamp01(this._hsl.s * (0.90 + rng() * 0.22)),
              clamp01(this._hsl.l * (0.86 + rng() * 0.24)));

    const s = o.scale ?? 1;
    const i = n * COVER_STRIDE;
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
    out[i + 3] = o.yaw ?? rng() * TAU;
    out[i + 4] = s * (0.90 + rng() * 0.20);
    out[i + 5] = s * (0.86 + rng() * 0.30);
    out[i + 6] = s * (0.90 + rng() * 0.20);
    out[i + 7] = c.r; out[i + 8] = c.g; out[i + 9] = c.b;
    out[i + 10] = c2.r; out[i + 11] = c2.g; out[i + 12] = c2.b;
    out[i + 13] = arch.wind * (0.6 + rng() * 0.9);
    out[i + 14] = rng() * TAU;
    out[i + 15] = o.tone ?? 1;
    out[i + 16] = arch.vis * (o.visMul ?? 1);
    out[i + 17] = ai;
    // `variant` lets a caller weight the choice. The uniform roll is right for
    // foliage, where the variants are the same plant grown twice, and wrong for
    // the stone tiers, where they are three different sizes and a flat third
    // each is the uniform grade the brief forbids.
    out[i + 18] = Math.min(arch.variants - 1,
      o.variant !== undefined ? o.variant : (rng() * arch.variants) | 0);
    out[i + 19] = -gx * inv;
    out[i + 20] = -gz * inv;
    return n + 1;
  }

  _cellKey(cx, cz, salt) {
    return (hash2i(cx, cz, this.seed ^ salt) * 4294967296) >>> 0;
  }

  // ── the layers ─────────────────────────────────────────────────────────────

  /**
   * @param {number} band 0 = closest (everything) … 3 = far (big shapes only)
   * @returns {number} instances written
   */
  generateCell(cx, cz, S, band, out, cap) {
    let n = 0;
    n = this._layerOpen(cx, cz, S, band, out, n, cap);
    if (band <= 2) n = this._layerScrub(cx, cz, S, out, n, cap);
    n = this._layerBank(cx, cz, S, out, n, cap);
    if (band <= 2) n = this._layerLitter(cx, cz, S, out, n, cap);
    n = this._layerDeadfall(cx, cz, S, band, out, n, cap);
    if (band <= 2) n = this._layerStones(cx, cz, S, out, n, cap);
    if (band <= 1) n = this._layerUnderstory(cx, cz, S, out, n, cap);
    if (band <= 0) n = this._layerFlowers(cx, cz, S, out, n, cap);
    // Skirt before substrate. Both want the same near-field budget, and if one
    // of them has to be cut short it must be the grit: a tree with no clumps at
    // its foot reads as a post pushed into a lawn, which is a structural defect,
    // where a square metre with four pebbles instead of six is not.
    n = this._layerTreeSkirt(cx, cz, S, band, out, n, cap);
    if (band <= 0) n = this._layerGround(cx, cz, S, out, n, cap);
    return n;
  }

  /**
   * The ground substrate: stones, fallen leaves, straw mats, twigs and moss on
   * the bare dirt between the grass tufts.
   *
   * This layer answers the measured ship-blocker — 65% of the 2 m road
   * close-up and 40% of `vehicle` were a smooth untextured orange slab, which
   * is the brief's named anti-pattern in the exact place the player looks
   * while driving. It is the only layer here with no ecological gate: every
   * other layer asks permission from a canopy, a river or a moisture field
   * first, and the consequence was that open meadow — most of the game —
   * received nothing at all below knee height.
   *
   * What it does still respect is *clumping*. A uniform dusting of pebbles is
   * the brief's other anti-pattern, so accumulation runs off a mid-frequency
   * field: hollows and lees collect, ridges stay swept. The floor under that
   * field is high enough that no open stretch is ever completely bare.
   *
   * The mix is chosen from what the ground actually is at each site. Stony,
   * dry and sloped emits stone; under a deciduous crown emits leaves; damp and
   * shaded emits moss; the default open meadow emits straw. That correlation
   * is doing the same job the shrub layer's region field does — it makes the
   * detritus look like it came from somewhere.
   */
  _layerGround(cx, cz, S, out, n, cap) {
    const N = this.noise, W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_GROUND);
    // 260 sites over a 48 m cell put roughly one accepted clump every 12 m²,
    // and after the visibility radius took its share the 2 m close-up still
    // measured as a bare slab with a handful of objects on it. What reads as
    // "the ground has stuff on it" is closer to one clump every 3 m².
    const sites = Math.round(820 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_GROUND, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const g = this._groundTiny(x, z);
      if (g < 0.20) continue;

      const acc = smoothstep(-0.50, 0.50, N.fbm(x * 0.045 + 17.3, z * 0.045 + 91.7, 2, 2.2, 0.5, 1));

      const w = W.getSurfaceWeights(x, z, this._w);
      // How bare this spot is. The surface weights are read before the accept
      // roll rather than after it, and that ordering is the point: the whole
      // reason this layer exists is the *bare* ground, and until now it was
      // spread at one density over grass and clay alike. So the places that
      // needed it most — the river bank, the roadside, the dirt shoulders —
      // got exactly the same dusting as a meadow that already had a full grass
      // carpet hiding it. `river` measured as half a frame of open clay with
      // seventy stones on it for precisely that reason.
      const bare = clamp01(1 - w.grass * 1.15) * (1 - clamp01(w.snow * 2));
      // Floor raised: the accumulation field is there to make hollows richer
      // than ridges, not to leave whole stretches of ground with nothing on
      // them at all — a swept ridge in the plates still has grit and straw.
      if (rng() > clamp01((0.60 + acc * 0.50) * (1 + bare * 1.15)) * g) continue;

      const moist = W.getMoisture(x, z);
      const slope = W.getSlope(x, z);
      const can = this._canopyAt(x, z);
      const lit = this._litterAt(x, z);
      const road = this.roads.sample(x, z);

      // Unnormalised weights; the roll below divides through by the total, so
      // these read as "how much more stone than straw", not as probabilities.
      // The road term came down from 1.8 and the straw term went up, and the
      // reason is a coverage argument rather than an ecological one. On a dirt
      // track the old weights had stone leading about twice as often as straw —
      // which is *true of a track* and useless here, because a stone clump is
      // twenty pieces of 3-8 cm grit covering four hundredths of a square metre
      // while a thatch mound covers a third of one. The 2 m road anchor is the
      // frame the critic keeps naming, and it was being handed the one mix in
      // the table that cannot put anything on it. Gravel still wins on actual
      // rock and gravel bars, where the surface weights say so directly.
      const wStone = 0.55 + w.rock * 2.2 + w.dirt * 0.6 + slope * 0.9
                   + road * 1.0 - moist * 0.35;
      const wLeaf  = 0.35 + lit * 2.4 + can * 0.55;
      // Straw was carrying two thirds of the mix and hitting its instance cap
      // while stone and leaf sat at a quarter of theirs. It is also the weakest
      // of the three: it sits inside the meadow's own gold, so it adds texture
      // but no value or hue break, and the slab it is covering is gold too.
      // …and this is the other half of the same rebalance. The note above was
      // written when straw was one flat strand mat and genuinely the weakest of
      // the three; with the thatch mound behind it, straw is now the only entry
      // in the mix that covers ground, so on bare ground it should lead.
      const wStraw = (0.34 + (1 - moist) * 0.55 + bare * 1.25) * (1 - clamp01(can * 0.75));
      // Moss needs shade *and* damp, not either. On its own the moisture term
      // was putting green cushions all over the open river clay, where they had
      // nothing to grow on and read as loose green cards lying on bare dirt —
      // half the "orphaned quads" in `river`. Moss in the plates is always
      // against something: a trunk, a log, the shaded side of a stone.
      // The `+ 0.10` floor in the canopy term was letting moss lead a clump on
      // open ground after all: small, but a lead is winner-take-all and three
      // quarters of a twenty-member clump then follow it. In `river` that is
      // the flat olive-green quad lying by itself on a bare shaded slope — the
      // last of the "loose green cards", arrived at through the clump lead
      // rather than through the weight. Moss needs something to grow *on*, so
      // the canopy term is now a hard gate rather than a bias.
      const wMoss  = can < 0.14 ? 0
                   : Math.max(0, moist - 0.55) * 2.2 * clamp01(can * 1.6)
                     + can * 0.35 - road * 1.0;
      // Halved on open ground. Twigs are the only thing in this layer that
      // renders as a *line*, and a line on a flat gold slab is read as a
      // scratch on the picture long before it is read as wood. Under a canopy
      // they still belong; out in the meadow they were the loudest thing in a
      // 2 m frame at a twentieth of the instance count.
      const wTwig  = 0.045 + can * 0.60 + lit * 0.30;
      const total = Math.max(1e-4, wStone + wLeaf + wStraw + wMoss + wTwig);

      // Clump size runs with the accumulation field rather than sitting in a
      // narrow band, so a swept ridge gets three or four scattered pieces and a
      // hollow gets a proper drift of twenty. Even spacing at a fixed count is
      // the anti-pattern; the variance is the point.
      const members = 4 + ((rng() * (6 + acc * 13 + bare * 14)) | 0);
      // Tightened by roughly half. A twenty-member clump spread over a 3.7 m
      // radius is not a clump, it is a dusting with a soft edge — which is
      // exactly what the river bank measured as: "~70 identical pebbles with no
      // clumping". The accumulation field still widens it, but a drift now
      // lands inside a metre or two and leaves real gaps between drifts, which
      // is the only way a scatter reads as weather rather than as noise.
      const spread = 0.26 + rng() * (0.40 + acc * 1.05);

      // ONE TYPE WINS PER CLUMP. Rolling the mix independently per member is
      // what turned every drift into confetti: twenty pieces inside two metres,
      // each independently a stone, a leaf, a straw mat or a twig, average to
      // "some small brown things" wherever you stand, and the whole layer
      // reads as one uniform noise field over the entire valley. The flower
      // layer already knew this — "mixed confetti reads as a texture; a
      // single-species drift reads as a plant that grew there" — and it is just
      // as true of detritus. So the weights choose the clump's *character*
      // once, and only a quarter of the members are drawn against the mix
      // again, which is enough to keep a straw drift from being pure straw.
      const pickKind = () => {
        let roll = rng() * total;
        if ((roll -= wStone) < 0) return 0;
        if ((roll -= wLeaf) < 0) return 1;
        if ((roll -= wStraw) < 0) return 2;
        if ((roll -= wMoss) < 0) return 3;
        return 4;
      };
      // …except that a twig can never *lead* a clump. Only one stick is allowed
      // per clump (see below), so a twig-led clump would skip three quarters of
      // its own members and leave a hole in the ground exactly where the field
      // said to put something.
      let lead = pickKind();
      if (lead === 4) lead = wStone > wStraw ? 0 : 2;
      // One stick per clump, at most. A clump can run to twenty members inside a
      // 2 m radius, and three or four sticks landing in one is a star of thin
      // dark strips radiating from a point — the same "scratches on the lens"
      // read the straw mats had, arrived at from the other direction.
      let sticks = 0;
      // A stone drift gets exactly one big stone, and it is the first member —
      // placed at the centre, with the grit landing around it. That is the
      // difference between a size *hierarchy* and a size *range*: a range gives
      // you seventy stones of assorted sizes evenly spaced, which measures as
      // varied and reads as uniform, because there is nothing for the eye to
      // group the small ones around.
      let bigStone = false;
      const wet = this._nearWater(x, z);
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = m === 0 ? x : x + Math.cos(ang) * r;
        const mz = m === 0 ? z : z + Math.sin(ang) * r;
        if (this._groundTiny(mx, mz, wet) < 0.20) continue;

        const kind = rng() < 0.76 ? lead : pickKind();
        if (kind === 0) {
          // Power law over the three stone tiers. Grit is the common case and
          // a cobble is a once-in-a-while event, which is what gives a stony
          // stretch a readable size hierarchy instead of a uniform grade.
          // Cobbles left this clump and became their own layer (`_layerStones`).
          // They carried a 74 m visibility radius while the only thing that
          // emitted them ran at band 0, i.e. inside 50 m — so every cobble in
          // the game popped into existence at fifty metres, fully sized, with
          // twenty-four metres of its fade still to go. Splitting them also
          // gives the anchor role to something honest: within a grit drift the
          // big piece is now the large pebble tier, and the landmark-scale
          // stones are placed against the ground that actually has them.
          const anchor = !bigStone && m === 0 && rng() < 0.62;
          if (anchor) bigStone = true;
          const t = anchor ? 0.70 + rng() * 0.16 : rng() * 0.58;
          n = this._emit(out, n, cap, 'pebble', mx, mz, rng, {
            colA: PAL.stoneDeep, colB: PAL.stoneLit, sink: 0.02,
            variant: t < 0.58 ? 0 : 1,
            // Squared, so within a tier most stones sit near the bottom of its
            // range and only a few reach the top. A flat scale range is what
            // produced the measured "every stone within ±30% of the same size".
            scale: (anchor ? 0.85 + rng() * 0.75 : 0.50 + rng() * rng() * 0.95),
            tone: 0.86 + rng() * 0.28, hue: 0.020, flat: true,
          });
        } else if (kind === 1) {
          // Weighted to the rust and crimson end rather than the gold. A
          // fallen leaf that is *lighter* than the meadow it lies on reads as
          // paper confetti at 2 m; the reference's litter is always a step
          // down in value from the ground and a step round toward red.
          const warm = rng();
          n = this._emit(out, n, cap, 'leafScatter', mx, mz, rng, {
            colA: warm < 0.82 ? PAL.litterWarm : PAL.litterRed,
            colB: warm < 0.22 ? PAL.litterRed : PAL.litterGold,
            sink: 0.01, scale: 0.65 + rng() * rng() * 1.10,
            tone: 0.90 + rng() * 0.24, hue: 0.028, flat: true,
          });
        } else if (kind === 2) {
          // Variant 1 is the thatch mound, variant 0 the flat strand mat, and
          // the split is weighted by how bare the ground is rather than rolled
          // evenly. That is the whole point of the mound: loose strands are a
          // fine texture *on top of* a grass carpet, and useless as the only
          // thing on an open clay slab, where what is missing is relief. Where
          // the grass weight is high the flat mat still wins, so the meadow
          // does not turn lumpy.
          const mound = rng() < 0.42 + bare * 0.46;
          n = this._emit(out, n, cap, 'deadTuft', mx, mz, rng, {
            colA: PAL.strawDeep, colB: PAL.strawPale,
            // Mounds sit *into* the ground. A swell whose rim is proud of the
            // surface has a visible under-edge and reads as an object lying on
            // the ground rather than as the ground itself.
            sink: mound ? 0.035 : 0.01, variant: mound ? 1 : 0,
            scale: mound ? 0.72 + rng() * rng() * 0.62
                         : 0.70 + rng() * rng() * 0.80,
            tone: 0.90 + rng() * 0.24,
            hue: 0.022, flat: true,
          });
        } else if (kind === 3) {
          n = this._emit(out, n, cap, 'moss', mx, mz, rng, {
            colA: PAL.mossDeep, colB: PAL.moss, sink: 0.01,
            scale: 0.7 + rng() * 0.8, tone: 0.88 + rng() * 0.22, hue: 0.03,
            flat: true,
          });
        } else if (sticks === 0) {
          sticks++;
          n = this._emit(out, n, cap, 'branch', mx, mz, rng, {
            // Weighted to the pale end out in the open. Weathered wood lying in
            // full sun is close to the value of the stone beside it; the darker
            // `barkWarm` belongs under canopy, and out here a scatter of it
            // reads as a handful of dark dashes on gold.
            colA: rng() < 0.72 ? PAL.barkGrey : PAL.barkWarm, colB: PAL.moss,
            // Big sticks are the rare case out on open ground; under a canopy
            // the deadfall layer supplies them properly.
            variant: rng() < 0.78 ? 0 : 1,
            scale: 0.55 + rng() * rng() * 0.85, sink: 0.0,
            tone: 0.86 + rng() * 0.26, hue: 0.015, flat: true,
            visMul: 0.75,
          });
        }
      }
    }
    return n;
  }

  /**
   * Stone. Cobbles and boulder chips on the ground that actually has them:
   * eroding banks, gravel bars, dry rocky slopes.
   *
   * Its own layer rather than the top tier of the grit clump, for two reasons.
   * The first is a fix — see the note in `_layerGround`; the second is that a
   * 30 cm stone and a 4 cm chip do not answer the same question. Grit is
   * *texture* on ground the player is standing on, so it wants a short radius
   * and huge numbers; a cobble is an *object* that gives a bank its scale from
   * fifty metres away, and it wants the opposite. The critic measured the river
   * bank as "~70 identical pebbles with no clumping and no size hierarchy" on a
   * frame where the bank fills half the picture, and no amount of retuning one
   * shared clump was going to produce both readings at once.
   *
   * Ecology rather than noise: `_ground` refuses anything over 1.2 slope, so
   * the steep eroding banks that most need something on them are exactly where
   * every other layer here declines to build. This one takes them.
   */
  _layerStones(cx, cz, S, out, n, cap) {
    const W = this.world, N = this.noise;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_STONE);
    const sites = Math.round(64 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_STONE, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > 0.10) continue;
      const slope = W.getSlope(x, z);
      if (slope > 1.45) continue;

      const w = W.getSurfaceWeights(x, z, this._w);
      const river = W.getRiver(x, z);
      // The slope term was doing too much and the grass penalty too little, so
      // "stony" was true of any hillside — and a hillside is most of the map.
      // In `river` that is forty mauve chips spread evenly across a single
      // enormous shaded slope, which is the reading the critic filed under
      // uniform scatter. A stone belongs where the ground is actually stone:
      // rock, dirt, gravel bar, eroding bank. Slope is a hint, not a licence.
      const stony = clamp01(w.rock * 1.5 + w.dirt * 1.0 + w.sand * 0.7
                            + smoothstep(0.20, 0.75, slope) * 0.45
                            + smoothstep(0.06, 0.32, river) * 0.9
                            - w.grass * 1.10 - w.snow * 2.0);
      if (stony < 0.10) continue;
      // Stones come in bars and scree runs, not in an even grade over a
      // hillside. The field is what leaves clean stretches between them.
      const field = smoothstep(-0.40, 0.45,
        N.fbm(x * 0.021 + 55.1, z * 0.021 - 33.7, 2, 2.2, 0.5, 1));
      // Squared in `stony`: marginal ground now gets a handful of groups rather
      // than a thinned-out version of a gravel bar's density, which is the
      // difference between "there are stones over there" and "there are stones
      // everywhere, sparsely".
      if (rng() > clamp01(stony * stony * (0.45 + field * 1.35))) continue;

      // One big stone at the centre with a handful of smaller ones around it.
      // The size step between member 0 and the rest is deliberately large: a
      // hierarchy is what lets the eye group a scatter into objects, and a
      // narrow range is what stopped it doing so before.
      //
      // …which was true and still measured as uniform, because the hierarchy
      // was being *erased by distance*. The chips carry the same 74 m radius as
      // the anchor they sit around, so past about 35 m the small ones are two
      // pixels and gone while every anchor is still drawn at full size — and
      // what is left is one size of stone, evenly spread, which is exactly the
      // reading of `river`'s slope. Two changes, and they work together: the
      // chips get a shorter radius so they and their anchor fade out together
      // rather than the group dissolving into its largest member; and the
      // anchor's own scale is drawn over a much wider power-law range, so the
      // stones that *do* survive to 60 m are themselves a hierarchy instead of
      // a repeated prop.
      const members = 2 + ((rng() * 5) | 0);
      const spread = 0.55 + rng() * 1.85;
      // Squared and wide: most groups are ankle-height, one in ten is a
      // knee-height block that gives the bank its scale from across the river.
      const anchor = 0.62 + rng() * rng() * 1.75;
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = m === 0 ? 0 : spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (!W.isInBounds(mx, mz)) continue;
        if (W.getWaterDepth(mx, mz) > 0.10) continue;
        const lead = m === 0;
        n = this._emit(out, n, cap, 'cobble', mx, mz, rng, {
          colA: PAL.stoneDeep, colB: PAL.stoneLit, sink: 0.05,
          variant: lead ? 1 : 0,
          scale: lead ? anchor : anchor * (0.22 + rng() * rng() * 0.46),
          // The chips fade with their anchor rather than surviving it. Scaled
          // off the anchor too, so a small group stays a small group all the
          // way out instead of dissolving into its biggest stone.
          visMul: lead ? 1 : 0.46 + anchor * 0.14,
          tone: 0.86 + rng() * 0.28, hue: 0.018, flat: true,
        });
      }
    }
    return n;
  }

  /**
   * Open ground: the dark shrubs that break the gold meadow. This layer is the
   * reason the system exists — they are the only strong dark value between the
   * grass and the treeline, and without them the meadow has no scale at all.
   */
  _layerOpen(cx, cz, S, band, out, n, cap) {
    const N = this.noise, W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_OPEN);
    const sites = Math.round(26 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_OPEN, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      if (this._ground(x, z, 1.4) < 0.06) continue;

      const can = this._canopyAt(x, z);
      const moist = W.getMoisture(x, z);

      // Shrubland is its own regional field, so bushes come in loose bands and
      // leave whole hillsides clear rather than dusting everything evenly.
      const region = N.fbm(x * 0.0055 + 41.2, z * 0.0055 - 19.7, 2, 2.1, 0.5, 1);
      const patch = N.fbm(x * 0.026 - 7.1, z * 0.026 + 3.9, 2, 2.3, 0.5, 1);
      // Forest edges are where scrub actually grows: peaks where the canopy is
      // half-open. Without it the treeline is a hard cut from wood to lawn.
      const edge = clamp01(can * (1 - can) * 4.2);
      const open = 1 - clamp01(can * 1.15);

      let d = clamp01(smoothstep(-0.20, 0.34, region * 0.75 + patch * 0.55) * open + edge * 0.90);
      // Damp ground grows more, but the dry meadow is the frame that needs the
      // dark value most, so the floor here is high.
      d *= 0.78 + moist * 0.45;
      if (rng() > d * 1.25) continue;

      // Decided before the band gate so the choice cannot change with distance:
      // a berry bush that turned into a dark shrub at 195 m would pop, since
      // the two archetypes carry different visibility radii.
      const berry = rng() < 0.20;
      if (berry && band > 2) continue;
      const maroon = rng() < 0.22;

      // One site is a small group, not one plant.
      const members = 1 + ((rng() * (1.6 + d * 2.6)) | 0);
      const spread = 1.6 + rng() * 3.4;
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        const mg = this._ground(mx, mz, 1.1);
        if (mg < 0.06) continue;
        // Scrub reads as head-height black blobs along the treeline at the
        // previous scale. In the plates these are knee-to-waist shrubs dotted
        // through the meadow — small enough that the gold reads past them.
        const sc = (0.48 + rng() * 0.34) * (0.85 + mg * 0.30);
        if (berry) {
          n = this._emit(out, n, cap, 'shrubBerry', mx, mz, rng, {
            colA: PAL.berryLeaf, colB: rng() < 0.5 ? PAL.berry : PAL.berryLit,
            scale: sc, tone: 0.94 + rng() * 0.18, hue: 0.03,
          });
        } else {
          n = this._emit(out, n, cap, 'shrubDark', mx, mz, rng, {
            colA: maroon ? PAL.shrubMaroon : PAL.shrubDeep,
            colB: maroon ? PAL.shrubMarLit : PAL.shrubLit,
            scale: sc, tone: 0.90 + rng() * 0.20, hue: 0.028,
          });
        }
        // Debris banked against the foot of the bush. The form carries its own
        // skirt of ground-hugging lobes, but litter that is visibly *separate*
        // from the plant is what actually kills the cut line: it puts small
        // objects across the intersection at a different scale and colour, so
        // there is no single silhouette edge left to read as a straight join.
        // Band 0 only — the join is unreadable past about 40 m anyway.
        if (band > 0) continue;
        const debris = 1 + ((rng() * 3) | 0);
        for (let k = 0; k < debris && n < cap; k++) {
          const da = rng() * TAU, dr = sc * (0.7 + rng() * 1.5);
          const bx = mx + Math.cos(da) * dr, bz = mz + Math.sin(da) * dr;
          if (this._groundTiny(bx, bz) < 0.20) continue;
          if (rng() < 0.45) {
            n = this._emit(out, n, cap, 'leafScatter', bx, bz, rng, {
              colA: PAL.litterWarm, colB: rng() < 0.4 ? PAL.litterRed : PAL.litterGold,
              sink: 0.01, scale: 0.7 + rng() * 0.7, tone: 0.86 + rng() * 0.22, hue: 0.028,
            });
          } else {
            n = this._emit(out, n, cap, 'deadTuft', bx, bz, rng, {
              colA: PAL.strawDeep, colB: PAL.strawPale,
              sink: 0.01, scale: 0.75 + rng() * 0.8, tone: 0.86 + rng() * 0.22, hue: 0.022,
            });
          }
        }
      }
    }
    return n;
  }

  /**
   * Dry scrub. Its own layer rather than a rider on the shrub sites, because it
   * wants the *opposite* ground — exposed, dry, mildly sloped — so the two
   * interleave across a hillside instead of stacking on the same spots.
   */
  _layerScrub(cx, cz, S, out, n, cap) {
    const N = this.noise, W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_SCRUB);
    const sites = Math.round(34 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_SCRUB, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const g = this._ground(x, z, 1.0);
      if (g < 0.08) continue;
      const moist = W.getMoisture(x, z);
      const slope = W.getSlope(x, z);
      const open = 1 - clamp01(this._canopyAt(x, z) * 1.3);
      const patch = N.fbm(x * 0.031 + 88.5, z * 0.031 - 51.2, 2, 2.2, 0.5, 1);

      const d = clamp01((1 - moist) * 1.15 - 0.10 + smoothstep(0.12, 0.62, slope) * 0.55
                        + patch * 0.45) * open * g;
      if (rng() > d * 1.5) continue;

      const tufts = 2 + ((rng() * (2 + d * 5)) | 0);
      const spread = 2.0 + rng() * 5.0;
      for (let m = 0; m < tufts && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 0.8) < 0.08) continue;
        const rust = rng() < 0.32;
        n = this._emit(out, n, cap, 'scrubDry', mx, mz, rng, {
          colA: rust ? PAL.scrubRust : (rng() < 0.4 ? PAL.scrubPale : PAL.scrubBase),
          colB: rust ? PAL.scrubRustTip : PAL.scrubTip,
          // Squared so most tufts are small and a few are twice the size —
          // the ladder inside one archetype, which a flat 0.58-1.00 had none of.
          scale: 0.45 + rng() * rng() * 0.95,
          tone: 0.92 + rng() * 0.22, hue: 0.02,
        });
      }
    }
    return n;
  }

  /** Riverbank and lake-shore thickets — willow and alder. */
  _layerBank(cx, cz, S, out, n, cap) {
    const W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_BANK);

    for (let a = 0; a < 9 && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_BANK, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const river = W.getRiver(x, z);
      const moist = W.getMoisture(x, z);
      // Wants the bank, not the channel: peaks just outside the water line.
      const bankness = clamp01(smoothstep(0.03, 0.16, river) * (1 - smoothstep(0.34, 0.60, river)))
                     + clamp01(smoothstep(0.66, 0.90, moist)) * 0.40;
      if (bankness < 0.12) continue;
      const g = this._ground(x, z, 2.0);
      if (g < 0.10) continue;
      if (rng() > bankness * g * 1.2) continue;

      const alder = rng() < 0.45;
      const members = 2 + ((rng() * 3.2) | 0);
      const spread = 2.2 + rng() * 4.5;
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 1.5) < 0.10) continue;
        n = this._emit(out, n, cap, 'thicket', mx, mz, rng, {
          colA: alder ? PAL.alder : PAL.willow,
          colB: alder ? PAL.alderTip : PAL.willowTip,
          scale: 0.72 + rng() * 0.70, tone: 0.88 + rng() * 0.22, hue: 0.030,
        });
      }
    }
    return n;
  }

  /** Forest floor: ferns, low broadleaf, moss on the damp side of things. */
  _layerUnderstory(cx, cz, S, out, n, cap) {
    const W = this.world, N = this.noise;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_UNDER);
    // 36 rather than 20. The forest floor measured as bare violet substrate
    // between grass tufts, and at 20 sites a 2304 m2 cell placed one fern bed
    // every 30 m of walking.
    const sites = Math.round(36 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_UNDER, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const can = this._canopyAt(x, z);
      const moist = W.getMoisture(x, z);
      let d = clamp01(can * 1.35 + smoothstep(0.62, 0.86, moist) * 0.4);
      if (d < 0.08) continue;
      const g = this._ground(x, z, 0.9);
      if (g < 0.10) continue;
      // Fern beds are patchy even inside a wood — a continuous fern carpet is
      // as wrong as a continuous lawn.
      d *= smoothstep(-0.30, 0.30, N.fbm(x * 0.038 + 66.1, z * 0.038 - 12.4, 2, 2.2, 0.5, 1));
      d *= g;
      if (rng() > d * 1.3) continue;

      const members = 2 + ((rng() * 6.0) | 0);
      const spread = 0.9 + rng() * 2.1;
      // Bronzing runs by patch, so a whole bed turns colour together.
      const bronze = N.fbm(x * 0.012 + 5.0, z * 0.012 + 9.0, 2, 2, 0.5, 1);
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 0.6) < 0.10) continue;
        const roll = rng();
        if (roll < 0.56) {
          n = this._emit(out, n, cap, 'fern', mx, mz, rng, {
            colA: PAL.fernBase, colB: bronze > 0.15 ? PAL.fernGold : PAL.fernBronze,
            scale: 0.72 + rng() * 0.70, tone: 0.88 + rng() * 0.24, hue: 0.035,
          });
        } else if (roll < 0.86) {
          n = this._emit(out, n, cap, 'broadleaf', mx, mz, rng, {
            colA: PAL.broadleaf, colB: PAL.broadTip,
            scale: 0.80 + rng() * 0.55, tone: 0.86 + rng() * 0.26, hue: 0.035,
          });
        } else if (moist > 0.5) {
          n = this._emit(out, n, cap, 'moss', mx, mz, rng, {
            colA: PAL.mossDeep, colB: PAL.moss, sink: 0.01,
            scale: 0.8 + rng() * 0.9, tone: 0.90 + rng() * 0.20, hue: 0.03,
          });
        }
      }
    }
    return n;
  }

  /** Late-season wildflowers. Rare, and only ever in drifts. */
  _layerFlowers(cx, cz, S, out, n, cap) {
    const W = this.world, N = this.noise;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_FLOWER);

    for (let a = 0; a < 8 && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_FLOWER, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      // Hard threshold on a slow field: about one patch of ground in ten ever
      // qualifies, which is what makes finding one feel like finding something.
      const drift = smoothstep(0.20, 0.50, N.fbm(x * 0.0090 + 123.4, z * 0.0090 - 88.2, 2, 2.0, 0.5, 1));
      if (drift < 0.05) continue;
      const g = this._ground(x, z, 1.0);
      if (g < 0.12) continue;
      if (this._canopyAt(x, z) > 0.55) continue;   // sun-lovers
      if (rng() > drift * g) continue;

      // One species wins per drift. Mixed confetti reads as a texture; a
      // single-species drift reads as a plant that grew there.
      const pick = rng();
      const kind = pick < 0.34 ? 'flowerAster' : (pick < 0.70 ? 'goldenrod' : 'seedHead');
      const moist = W.getMoisture(x, z);
      const members = 3 + ((rng() * 7) | 0);
      const spread = 1.4 + rng() * 3.6;
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 0.5) < 0.12) continue;
        if (kind === 'flowerAster') {
          n = this._emit(out, n, cap, 'flowerAster', mx, mz, rng, {
            colA: PAL.stem, colB: rng() < 0.75 ? PAL.aster : PAL.asterPink,
            scale: 0.8 + rng() * 0.6, tone: 0.94 + rng() * 0.16, hue: 0.02,
          });
        } else if (kind === 'goldenrod') {
          n = this._emit(out, n, cap, 'goldenrod', mx, mz, rng, {
            colA: moist > 0.5 ? PAL.stem : PAL.stemDry, colB: PAL.goldenrod,
            scale: 0.8 + rng() * 0.7, tone: 0.94 + rng() * 0.16, hue: 0.02,
          });
        } else {
          n = this._emit(out, n, cap, 'seedHead', mx, mz, rng, {
            colA: PAL.stemDry, colB: PAL.seedTip,
            scale: 0.78 + rng() * 0.75, tone: 0.94 + rng() * 0.18, hue: 0.02,
          });
        }
      }
    }
    return n;
  }

  /** Leaf litter, in drifts, downwind of deciduous crowns. */
  _layerLitter(cx, cz, S, out, n, cap) {
    const N = this.noise;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_LITTER);
    const sites = Math.round(16 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_LITTER, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const lit = this._litterAt(x, z);
      if (lit < 0.10) continue;
      const g = this._ground(x, z, 1.2);
      if (g < 0.12) continue;
      // Litter collects in hollows and against obstacles, never evenly under a
      // crown; a mid-frequency field stands in for that accumulation.
      const acc = smoothstep(-0.35, 0.35, N.fbm(x * 0.055 + 3.3, z * 0.055 - 21.0, 2, 2.2, 0.5, 1));
      const d = clamp01(lit * 1.5) * (0.35 + acc * 0.9) * g;
      if (rng() > d * 1.1) continue;

      const members = 1 + ((rng() * 3.4) | 0);
      const spread = 1.0 + rng() * 2.8;
      const warm = rng();
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 0.9) < 0.12) continue;
        n = this._emit(out, n, cap, 'leafDrift', mx, mz, rng, {
          colA: warm < 0.6 ? PAL.litterWarm : PAL.litterGold,
          colB: warm < 0.3 ? PAL.litterRed : PAL.litterGold,
          scale: 0.75 + rng() * 0.65, sink: 0.02,
          tone: 0.90 + rng() * 0.22, hue: 0.028,
        });
      }
    }
    return n;
  }

  /** Deadfall: logs, stumps, broken branches. */
  _layerDeadfall(cx, cz, S, band, out, n, cap) {
    const W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_DEAD);

    for (let a = 0; a < 7 && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_DEAD, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const can = this._canopyAt(x, z);
      const moist = W.getMoisture(x, z);
      const d = clamp01(can * 1.1 + smoothstep(0.55, 0.85, moist) * 0.35);
      if (d < 0.12) continue;
      const g = this._ground(x, z, 1.6);
      if (g < 0.15) continue;
      if (rng() > d * g * 0.80) continue;

      const roll = rng();
      const grey = rng() < 0.68;
      if (roll < 0.45) {
        n = this._emit(out, n, cap, 'log', x, z, rng, {
          colA: grey ? PAL.barkGrey : PAL.barkWarm, colB: PAL.moss,
          scale: 0.85 + rng() * 0.55, sink: 0.0,
          tone: 0.88 + rng() * 0.24, hue: 0.015,
        });
      } else if (roll < 0.68) {
        n = this._emit(out, n, cap, 'stump', x, z, rng, {
          colA: grey ? PAL.barkGrey : PAL.barkWarm, colB: PAL.moss,
          scale: 0.8 + rng() * 0.6, sink: 0.06,
          tone: 0.88 + rng() * 0.24, hue: 0.015,
        });
      }
      if (band > 1) continue;                      // branches are band-1 detail
      const sticks = 1 + ((rng() * 3) | 0);
      for (let m = 0; m < sticks && n < cap; m++) {
        const ang = rng() * TAU, r = 1.0 + rng() * 4.0;
        const mx = x + Math.cos(ang) * r, mz = z + Math.sin(ang) * r;
        if (this._ground(mx, mz, 0.6) < 0.12) continue;
        n = this._emit(out, n, cap, 'branch', mx, mz, rng, {
          colA: grey ? PAL.barkGrey : PAL.barkWarm, colB: PAL.moss,
          // Under a canopy the sticks are limbs off the trees overhead, so the
          // long tier dominates here and the short one is the filler.
          variant: rng() < 0.62 ? 1 : 0,
          scale: 0.70 + rng() * 0.75, sink: 0.0,
          // Lifted. A thin cylinder shows the camera mostly its flanks, which
          // sit at the bottom of `tube`'s AO ramp, so an authored mid-tan stick
          // arrives around srgb(106,90,60) — dark enough against gold that a
          // few crossing sticks read as pen strokes rather than as wood.
          tone: 1.00 + rng() * 0.26, hue: 0.015,
        });
      }
    }
    return n;
  }

  /**
   * The skirt at the foot of an actual trunk: a few dark green clumps, some
   * fern and moss, a litter drift on the downwind side. Plate 1 has exactly
   * this at every birch base, and it is what stops trees reading as posts
   * pushed into a lawn.
   *
   * The band gates here are ordered coarse-to-fine on purpose: refining a cell
   * only ever *appends* draws to each tree's stream, so nothing already placed
   * moves.
   */
  _layerTreeSkirt(cx, cz, S, band, out, n, cap) {
    const T = this.trees;
    if (!T) return n;
    const { px, pz, pspec, pImpW, order, bucketStart, BW, BS, half } = T;
    const ox = cx * S, oz = cz * S;

    const b0x = Math.max(0, Math.floor((ox + half) / BS));
    const b1x = Math.min(BW - 1, Math.floor((ox + S + half) / BS));
    const b0z = Math.max(0, Math.floor((oz + half) / BS));
    const b1z = Math.min(BW - 1, Math.floor((oz + S + half) / BS));

    for (let bz = b0z; bz <= b1z; bz++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const b = bz * BW + bx;
        const s0 = bucketStart[b], s1 = bucketStart[b + 1];
        for (let k = s0; k < s1 && n < cap; k++) {
          const t = order[k];
          const tx = px[t], tz = pz[t];
          if (tx < ox || tx >= ox + S || tz < oz || tz >= oz + S) continue;
          const w = Math.max(1.0, pImpW[t]);
          if (w < 1.6) continue;                   // saplings get no skirt
          const rng = mulberry32((hash2i(t, 0x5c17, this.seed) * 4294967296) >>> 0);
          const decid = !SPECIES[pspec[t]]?.conifer;
          const moist = this.world.getMoisture(tx, tz);

          // Dark clumps hugging the base — the reference's signature.
          const clumps = (rng() < 0.62 ? 1 : 0) + ((rng() * 2.4) | 0);
          for (let m = 0; m < clumps && n < cap; m++) {
            const ang = rng() * TAU, r = w * (0.20 + rng() * 0.45);
            const mx = tx + Math.cos(ang) * r, mz = tz + Math.sin(ang) * r;
            if (this._ground(mx, mz, 1.0) < 0.10) continue;
            n = this._emit(out, n, cap, 'shrubDark', mx, mz, rng, {
              colA: PAL.shrubDeep, colB: PAL.shrubLit,
              scale: 0.60 + rng() * 0.55, tone: 0.82 + rng() * 0.20, hue: 0.03,
            });
          }

          if (band <= 2 && decid) {
            const drifts = 1 + ((rng() * 2.4) | 0);
            for (let m = 0; m < drifts && n < cap; m++) {
              const r = w * (0.30 + rng() * 0.85);
              const off = (rng() - 0.5) * w * 0.8;
              const mx = tx + DRIFT_X * r - DRIFT_Z * off;
              const mz = tz + DRIFT_Z * r + DRIFT_X * off;
              if (this._ground(mx, mz, 0.9) < 0.12) continue;
              n = this._emit(out, n, cap, 'leafDrift', mx, mz, rng, {
                colA: rng() < 0.6 ? PAL.litterWarm : PAL.litterGold,
                colB: rng() < 0.4 ? PAL.litterRed : PAL.litterGold,
                scale: 0.8 + rng() * 0.7, sink: 0.02,
                tone: 0.90 + rng() * 0.22, hue: 0.028,
              });
            }
          }

          if (band <= 1) {
            const under = (rng() * (1.5 + moist * 4.0)) | 0;
            for (let m = 0; m < under && n < cap; m++) {
              const ang = rng() * TAU, r = w * (0.25 + rng() * 0.75);
              const mx = tx + Math.cos(ang) * r, mz = tz + Math.sin(ang) * r;
              if (this._ground(mx, mz, 0.6) < 0.10) continue;
              const roll = rng();
              if (roll < 0.5) {
                n = this._emit(out, n, cap, 'fern', mx, mz, rng, {
                  colA: PAL.fernBase, colB: rng() < 0.4 ? PAL.fernGold : PAL.fernBronze,
                  scale: 0.7 + rng() * 0.7, tone: 0.86 + rng() * 0.24, hue: 0.035,
                });
              } else if (roll < 0.8) {
                n = this._emit(out, n, cap, 'broadleaf', mx, mz, rng, {
                  colA: PAL.broadleaf, colB: PAL.broadTip,
                  scale: 0.80 + rng() * 0.50, tone: 0.86 + rng() * 0.24, hue: 0.035,
                });
              } else {
                // Moss on the damp north side, not all the way round.
                const na = Math.PI * 1.5 + (rng() - 0.5) * 1.5;
                const mx2 = tx + Math.cos(na) * w * 0.30;
                const mz2 = tz + Math.sin(na) * w * 0.30;
                if (this._ground(mx2, mz2, 0.4) < 0.10) continue;
                n = this._emit(out, n, cap, 'moss', mx2, mz2, rng, {
                  colA: PAL.mossDeep, colB: PAL.moss, sink: 0.01,
                  scale: 0.7 + rng() * 0.8, tone: 0.88 + rng() * 0.20, hue: 0.03,
                });
              }
            }
          }
        }
      }
    }
    return n;
  }
}

export { PAL as COVER_PALETTE };

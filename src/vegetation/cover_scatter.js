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
import { clamp01, smoothstep, mulberry32, hash2i, bilinear } from '../core/MathUtils.js';
// Shared with the grass field on purpose: the wheel ruts have to be bare in
// both layers, or the track reads as a mown stripe with bushes growing in it.
import { RoadMask } from './grass_scatter.js';
import { SPECIES } from './tree_species.js';
import { ARCH_INDEX, COVER_ARCHETYPES, REED_HEIGHT } from './cover_forms.js';

const TAU = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
//  DISTANCE TO WATER
//
//  Everything a shoreline layer wants to know is "how far is the water from
//  here", and that is the one field the world does not publish. `TerrainGen`
//  computes it — `_climate()` builds exactly this raster to drive moisture and
//  stores it as `this.distToWater` — but it is not in `bakeFormat.js`, so it
//  does not survive the worker boundary; and `WorldData.distToShoreApprox` is a
//  stub that answers 0 or 8 off the river mask, which is blind to every lake in
//  the world. Requested properly in docs/INTEGRATION_REQUESTS.md; rebuilt here
//  meanwhile, because a shoreline placement rule keyed off anything else is a
//  rule keyed off rivers only.
//
//  Why a raster and not a probe. The alternative is to ask `getWaterDepth` on a
//  ring of candidate radii, which is what `_nearWater` does at one radius for
//  one bit of information. Answering "3.4 metres" that way costs a couple of
//  dozen depth lookups per candidate site, on a layer that has to run a few
//  dozen candidates per cell over every cell in the world — including the great
//  majority that hold no water at all and whose entire cost should be one
//  fetch. A chamfer is built once and read for the price of a bilinear.
//
//  Two passes of a 3-4-5-ish chamfer rather than an exact Euclidean transform.
//  The error is under 2% at the ranges this is used over (0-10 m), which is
//  centimetres, and nothing here is deciding anything at centimetre precision.
//
//  Stored quantised to 1/8 m in a Uint16 (4.7 MB at the shipping 1536² grid,
//  against 9.4 for floats). The `INF` seed is well under the type's ceiling so
//  that `d + step` inside the sweep cannot wrap — a wrapped distance reads as
//  "touching the water" and would put a reed bed on a mountain top.
// ─────────────────────────────────────────────────────────────────────────────
const SHORE_Q = 8;                     // quantisation steps per metre
const SHORE_INF = 60000;               // ≈ 7.5 km, and 60000 + 24 cannot wrap

export class ShoreField {
  constructor(world) {
    const R = world.res, N = R * R;
    this.res = R;
    this.half = world.half;
    this.invTexel = world.invTexel;
    const d = new Uint16Array(N).fill(SHORE_INF);

    // Wet from the BAKED grids rather than from `getWaterDepth`. The baked
    // water surface is what both the river ribbon and the lake mesh are derived
    // from, it is already on this exact grid, and reading it directly is two
    // million array indexes instead of two million bilinear interpolations plus
    // two million noise evaluations of `microDetail`.
    //
    // The threshold is 2 cm of standing water, not "the cell is marked". A
    // priority-flood marks the whole filled basin including the rim texels it
    // raised by nothing, and seeding the chamfer from those puts the shoreline a
    // texel or two out into the meadow all the way round every lake.
    const h = world.height, w = world.water;
    for (let i = 0; i < N; i++) if (w[i] > -9000 && w[i] - h[i] > 0.02) d[i] = 0;

    const S = Math.round(world.texel * SHORE_Q);              // orthogonal step
    const D = Math.round(world.texel * SHORE_Q * 1.41421356); // diagonal step
    // Forward sweep: every texel takes the best of the four causal neighbours.
    for (let y = 1; y < R; y++) {
      const row = y * R, prev = row - R;
      for (let x = 1; x < R - 1; x++) {
        const i = row + x;
        let v = d[i];
        const a = d[i - 1] + S; if (a < v) v = a;
        const b = d[prev + x] + S; if (b < v) v = b;
        const c = d[prev + x - 1] + D; if (c < v) v = c;
        const e = d[prev + x + 1] + D; if (e < v) v = e;
        d[i] = v;
      }
    }
    // Backward sweep: the other four, which is what makes the result symmetric.
    for (let y = R - 2; y >= 0; y--) {
      const row = y * R, next = row + R;
      for (let x = R - 2; x >= 1; x--) {
        const i = row + x;
        let v = d[i];
        const a = d[i + 1] + S; if (a < v) v = a;
        const b = d[next + x] + S; if (b < v) v = b;
        const c = d[next + x + 1] + D; if (c < v) v = c;
        const e = d[next + x - 1] + D; if (e < v) v = e;
        d[i] = v;
      }
    }
    this.grid = d;
    // ── the half-texel the chamfer cannot see ────────────────────────────────
    //
    // What the sweep above measures is the distance to the nearest wet TEXEL
    // CENTRE, and the waterline is not at a texel centre — it is somewhere
    // inside the last wet texel, on average half a texel short of its middle.
    // At the shipping 2 m grid that is a metre of systematic error, in the one
    // metre that matters most: a caller asking "put this 0.3 m up the bank"
    // and walking to `at() == 0.3` lands 0.7 m OUT IN THE WATER. Measured
    // exactly that way — 22 instances placed against the ~200 the site count
    // predicted, all of them the ones whose own jitter pushed them back uphill.
    //
    // Subtracting the bias here rather than in each caller is the right place
    // for it: it makes `at()` mean "metres to the water's edge", which is what
    // every caller believes it already means, and it keeps `RockScatter`'s
    // waterline wetness honest for free. It cannot be exact — a raster does not
    // know where inside a texel the shore runs — so callers that must land on
    // dry ground still confirm against `getWaterDepth`.
    this.lip = world.texel * 0.5;
  }

  /** Metres from (x, z) to the water's edge. 0 inside it. */
  at(x, z) {
    const gx = (x + this.half) * this.invTexel;
    const gz = (z + this.half) * this.invTexel;
    const d = bilinear(this.grid, this.res, this.res, gx, gz) / SHORE_Q - this.lip;
    return d > 0 ? d : 0;
  }
}

/**
 * One field per world, shared by every system that needs it.
 *
 * Cached on the world object rather than owned by a scatterer because both
 * `CoverScatter` and `RockScatter` want it and neither should pay 4.7 MB and a
 * chamfer twice. Built lazily on first use, not in a constructor: `Water.js`
 * hands `WorldData` its lake surface after both scatterers exist, and a field
 * built at construction time would predate it.
 */
export function shoreField(world) {
  let f = world.__shoreField;
  if (!f) { f = new ShoreField(world); world.__shoreField = f; }
  return f;
}

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
  // Pulled a step cooler and a step more saturated, and the lit end brought
  // down. Measured against the plates rather than reasoned about: the bushes at
  // plate 1's birch bases and plate 2's river bank are a *blue-green* against
  // the gold — that complementary split is what makes them read at 60 px — and
  // they sit at about 0.42-0.48 luma against the meadow's 0.70. At the previous
  // pair, once the mass-normal fix in `cover_forms.js` gave the sunward flank a
  // real value, the lit end came out a warm olive within a hair of the meadow's
  // own hue, and a bush that shares the ground's hue is a smudge on it.
  // Deep end lifted with `uAoDepth` and for the same measured reason: the
  // reference's shaded bush foliage is a saturated mid green at luma ~0.31, and
  // the pair's deep end has to start high enough that the game's stylised
  // shadow floor lands there rather than three stops under it.
  shrubDeep:   C(0x58895a), shrubLit:    C(0x9dc267),
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
  // ── the water margin ──────────────────────────────────────────────────────
  // The one place in this palette where a *cool* green is correct. Everything
  // else at ground level is a warm olive pulled toward the meadow's gold,
  // because everything else is standing on gold; a reed bed is standing on
  // water, and the water it stands on is the coolest, darkest area of the
  // frame. The reference plate's reed margin separates from the river behind it
  // by hue as much as by value — a blue-green against a violet-blue — and a
  // reed authored in the meadow's olive family disappears into the bank instead.
  //
  // The deep end sits at luma ~0.14 linear, comfortably clear of the flat warm
  // floor documented at the head of this palette (~0.10), and it is the value
  // that carries the base of a stand and its thatch. The lit end is where the
  // backlit crest lands.
  reedDeep:    C(0x4d7346), reedLit:     C(0xa8c25e),
  // A share of every stand has gone over to seed. Reeds in late autumn are not
  // uniformly green — a bed is patched green and straw, and that patching is
  // most of what stops a stand reading as one flat green shape. Warmer and a
  // step lighter than the green pair, so a dry clump reads as a highlight
  // inside the bed rather than as a different plant.
  reedDry:     C(0xae8f4a), reedDryTip:  C(0xe4cd7e),
  // Sedge on the bank lip. Deliberately between the reed green and the meadow
  // gold: this is the form that has to hand one off to the other, so it is a
  // damp olive at the root running to a sunlit gold-green at the blade tips.
  sedgeDeep:   C(0x64803a), sedgeTip:    C(0xd0c866),
  // The damp band itself — a ground mat pair, cooler and a clear step darker
  // than the dry meadow's `matDry` (#a87f3a / #ecc478). This is the middle of
  // the three bands the reference plate shows across a bank: hot gold behind,
  // this, then water. It only ever appears within about three metres of a
  // waterline, so it is allowed to be the strongest hue break in the layer.
  matDamp:     C(0x5c7838), matDampLit:  C(0xa4bb5a),
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
  // The broad ground mats. Three pairs, chosen at the site from what the ground
  // is, and all three authored to sit *just under* the surface they dress —
  // a mat that is lighter than the terrain reads as a spill and one that is a
  // whole value step darker reads as a stain. Half a step down and a step up in
  // chroma is the reading the plates give: the reference's open ground is never
  // one flat colour, it is gold worked over with slightly deeper gold.
  // Deep ends pulled DOWN a value step and the lit ends held, which widens the
  // pair rather than darkening the mat. Measured in situ on the critic's
  // hillside (tools/_scratch/px.mjs on shots/cover/a1-river.png): the shaded
  // slope reads srgb(92,64,28), luma 0.27, and the mats on it read
  // srgb(141,111,54), luma 0.45 — 1.7x the ground they lie on, at every single
  // instance, so each one read as a separate pale object rather than as the
  // surface. A mat is vegetation on dirt and is *supposed* to be lighter than
  // it; what it is not supposed to be is uniformly lighter. With the deep end
  // down, a mat's own shaded flank now lands near the ground's value and only
  // its lit strand tips reach the old one, which is the value structure the
  // reference's ground has and the flat pair did not.
  matDry:      C(0xa87f3a), matDryLit:   C(0xecc478),
  matHerb:     C(0x6f7238), matHerbLit:  C(0xc0c66a),
  // The rust pair, and it is now the pair that has to work, because it is the
  // one that lands on the `river` hillside — see the choice below in
  // `_layerMat`, which used to hand that hillside the GOLD pair five times in
  // eight. Both ends came down. The rule the whole block above states — a mat
  // sits half a value step over the surface it dresses — was calibrated on the
  // meadow, where the ground is sunlit gold; measured with the region masked
  // from world data rather than by rect (tools/_scratch/cover/rivermap.mjs plus
  // covermask.mjs), the near hillside's raw terrain is srgb(103,58,34) at luma
  // 0.257, and the mats lying on it rendered at luma 0.395. That is 1.54x the
  // ground, at every instance, which is the "pale decal" reading and it is the
  // same defect the deep ends were pulled down for last round, one surface
  // further out.
  //
  // …and then HALF WAY BACK UP, because the first attempt at this overshot and
  // the capture says so. At #8c5a30 / #cf9350 the mats on that hillside
  // rendered at luma 0.297 against the ground's 0.251 — 1.18x, which is not a
  // mat lying on the ground, it is the ground. The band's own mean went DOWN
  // (0.300 -> 0.286) and its vivid share with it (15.6% -> 12.8%), both away
  // from the plate floor of 0.37 / 31%. A mat has to be a lift; the defect was
  // that it was a 1.54x lift in the wrong hue, not that it was a lift.
  //
  // So: the hue correction stays and the value comes back to about 1.3x, which
  // is what the block above means by "half a step up in value and a step up in
  // chroma". The lit end goes back up too — it now only ever appears on 2-5 cm
  // strand tips (see `buildGroundMat`), where the pale end is texture rather
  // than the 13 cm laths it used to paint.
  matRust:     C(0xa56a39), matRustLit:  C(0xe3aa62),
};

// Fixed leaf-drift direction. Litter piles downwind of a crown, and the whole
// valley agreeing on one prevailing wind is what makes that read as weather
// rather than as random offsetting.
const DRIFT_X = Math.cos(0.7), DRIFT_Z = Math.sin(0.7);

const CAN_CELL = 6;                  // metres per canopy raster cell

// Layer salts. Distinct constants so no two layers can ever share a stream.
const L_OPEN = 0x51a1, L_SCRUB = 0x5c2b, L_BANK = 0xba17;
const L_UNDER = 0x0fe2, L_FLOWER = 0xf10e, L_LITTER = 0x11e2, L_DEAD = 0xdead;
const L_GROUND = 0x9704, L_STONE = 0x5701, L_MAT = 0x3a71, L_SHORE = 0x5e3d;

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
    this._n2 = { nx: 0, nz: 0 };     // per-clump terrain normal scratch
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

    // ── THE SLOPE GATE, AND WHY IT IS NOT ALSO A ROCK GATE ──────────────────
    //
    // This is critic blocker 5's remaining half: `review/045` and
    // `shots/round46/river.png` show an entire hillside, 20 to 120 m out and
    // most of the frame, as bare brown ground with nothing whatever growing on
    // it. Everything below is the result of reading the inputs at those exact
    // pixels (`tools/_scratch/cover/hillprobe.mjs`) rather than reasoning about
    // which gate might be closing, and the answer was not the one the previous
    // two rounds assumed.
    //
    // Ray-marched onto the terrain at the `river` anchor, every bare pixel on
    // that hillside reports:
    //
    //     slope 0.84 … 1.93   rock 1.00   dirt 0.70   grass 0.00   snow 0.00
    //
    // and the old gate below vetoed on `w.rock > 0.60`. So the hillside was
    // rejected for being ROCK. It is not rock. Read `WorldData.getSurfaceWeights`:
    //
    //     rockW = smoothstep( 0.55, 1.15, slope ) + smoothstep( 230, 300, h ) * 0.6
    //
    // Below the alpine line `w.rock` is a *pure restatement of slope*. It
    // carries no independent information about the substrate at all. Which
    // means the previous round's reasoning — "ground cover stops where the
    // surface becomes rock, not where it becomes steep, and `w.rock` is already
    // the test for that" — was exactly backwards, and its raise of the slope
    // limit from 1.20 to 1.55 changed nothing: `rock > 0.60` is `slope > 0.93`,
    // and the `smoothstep(0.18, 0.58, w.rock)` fade below had already taken `g`
    // to zero at slope 0.92. Cover stopped dead at 42°, whatever the number on
    // the line above said. That is the whole defect.
    //
    // So the two halves of `rockW` are separated here and treated as what they
    // actually are:
    //
    //  · the ALTITUDE half is real information — above ~230 m the world is
    //    genuinely crag and scree, and it still vetoes.
    //  · the SLOPE half is a slope term, and is applied once, as a fade, with a
    //    hard stop only where a plant would be standing on something near
    //    vertical (1.95 ≈ 63°).
    //
    // The reference supports the generous reading: plate 2 carries gold grass
    // and scrub right up the cut bank behind the truck, and plate 3's far slope
    // is dressed to the scree line. A 45° hillside in autumn is covered.
    const slope = W.getSlope(x, z);
    if (slope > 1.95) return 0;
    const w = W.getSurfaceWeights(x, z, this._w);
    if (w.snow > 0.45) return 0;
    // The altitude half of `w.rock`, recovered exactly as WorldData builds it.
    // Kept in this form rather than eyeballed so that if that formula ever
    // changes, the mismatch is visible here instead of silent.
    const alpine = smoothstep(230, 300, W.getHeight(x, z));
    if (alpine > 0.55) return 0;

    let g = (1 - smoothstep(0.10, 0.55, alpine)) * (1 - w.snow);
    g *= 1 - smoothstep(1.30, 1.95, slope);
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
  _groundTiny(x, z, wet = false, slopeCheck = true) {
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
    // Skipped for clump *members*. The site two metres away already tested it,
    // terrain slope does not change meaningfully over a clump's own radius, and
    // this call runs ten thousand times per band-0 cell against the site's few
    // hundred — it is pure cost in the hot loop for a result that is a copy of
    // one already taken.
    // Raised with `_ground`'s, and for the same reason. Grit and straw lying on
    // a 40° bank is what the reference's banks are made of.
    if (slopeCheck && W.getSlope(x, z) > 1.95) return 0;
    return 1 - this.roads.sample(x, z) * 0.30;
  }

  /**
   * Terrain normal at a clump site, as the two horizontal components of the
   * unit normal — the form `_emit` stores and `GroundCover._repack` expects.
   *
   * Four height lookups, taken ONCE for a whole clump. Everything in the
   * substrate tier used to skip this entirely (`flat: true`) on the grounds
   * that a pebble leaning half a degree is invisible, which is true of a pebble
   * and false of the metre-wide thatch mats and leaf patches that share the
   * layer. See the long note in `_emit`.
   */
  _clumpNormal(x, z, out) {
    const W = this.world, e = 0.9;
    const gx = (W.getHeight(x + e, z) - W.getHeight(x - e, z)) / (2 * e);
    const gz = (W.getHeight(x, z + e) - W.getHeight(x, z - e)) / (2 * e);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    out.nx = -gx * inv;
    out.nz = -gz * inv;
    return out;
  }

  /**
   * The world's distance-to-water raster, built on first use. See `ShoreField`.
   */
  _shore() {
    return this._sf || (this._sf = shoreField(this.world));
  }

  /**
   * Plantability at the water's edge, where `_ground` is the wrong test.
   *
   * `_ground` refuses anything with water within its own footprint radius, and
   * that rule is correct for every other layer in this file — it is the reason
   * nothing here stands in a lake. It is also exactly why the shoreline in
   * `shots/w-base/river.png` is a bare tan band: every layer backs off its own
   * radius from the waterline, so the last metre and a half of bank is swept
   * clean by construction and the terrain's shore texel is left showing.
   *
   * The reference plate has no such band. Gold grass grows to the water and
   * *overhangs* it; the plant silhouette is the shoreline. So the margin layer
   * tests its own centre and lets its blades hang out over the water, which is
   * what a bank tuft does. `wade` is how much standing water the centre itself
   * may sit in — zero for a mat, a few centimetres for a sedge whose crown is
   * on wet mud.
   */
  _shoreGround(x, z, wade = 0.03) {
    const W = this.world;
    if (!W.isInBounds(x, z)) return 0;
    if (W.getWaterDepth(x, z) > wade) return 0;
    const slope = W.getSlope(x, z);
    // A cut bank is not a margin. Past about 55° the ground is undercut rock and
    // clay, which the plates show bare and which `_layerStones` already dresses.
    if (slope > 1.60) return 0;
    return (1 - smoothstep(1.05, 1.60, slope)) * (1 - this.roads.sample(x, z) * 0.85);
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
    //
    // …and that reasoning is right about a pebble and WRONG about everything
    // else in the substrate tier, which is where the near half of the `river`
    // frame went. A `deadTuft` mat is 0.7-1.2 m across and a `leafScatter`
    // patch 0.3-0.7 m; laid flat in WORLD space on the 49-degree bank that
    // fills that frame, a metre-wide mat's uphill edge is a quarter of a metre
    // underground and its downhill edge the same distance in the air. The
    // ground eats most of it and what survives hangs off the hill. Generation
    // was never the problem — probed at the bare pixels, one 6 m box holds 133
    // tufts, 26 leaf patches and 19 stones, and the frame shows almost none of
    // them. The meadow is flat, so none of this is visible there; it is visible
    // exactly where the hillside is steep, which is where it was reported.
    //
    // So a caller may now hand in a normal it computed ONCE PER CLUMP. A clump
    // is a metre or two across and the terrain normal does not turn meaningfully
    // inside it, so ten to twenty members share one four-lookup central
    // difference instead of paying for their own — which is cheaper than the
    // per-instance version this flag was introduced to avoid, not dearer.
    // `o.nx` / `o.nz` are the horizontal components of the unit normal, already
    // normalised by the caller; they are written straight through at the tail.
    let gx = 0, gz = 0, inv = 1;
    if (o.nx !== undefined) { /* supplied */ } else if (!o.flat) {
      const e = 0.9;
      gx = (W.getHeight(x + e, z) - W.getHeight(x - e, z)) / (2 * e);
      gz = (W.getHeight(x, z + e) - W.getHeight(x, z - e)) / (2 * e);
      inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    }

    const c = this._c.copy(o.colA);
    const c2 = this._c2.copy(o.colB);
    // Two colour paths, and which one you get is the same `flat` flag that
    // skips the terrain normal — for the same reason, measured the same way.
    //
    // The round trip through HSL is four `getHSL`/`setHSL` calls per instance,
    // and `setHSL` runs three `hue2rgb` branches. `tools/_scratch/cover/
    // costprobe.mjs` times one band-0 cell at 6-7 ms for ~10,000 instances, and
    // the substrate is nearly all of that count — so this one block is a
    // several-millisecond spike on every cell the streamer builds, which is
    // exactly the shape of the >50 ms frames `perf.mjs` reports (140 of them
    // with this layer present, 2 with it hidden).
    //
    // A pebble does not need a hue rotation. What per-instance jitter is *for*
    // is stopping forty identical props reading as decals, and on a 4 cm stone
    // a value-and-saturation jitter does that as well as a hue one does. So the
    // substrate takes a multiply in RGB — value, plus a pull toward or away
    // from its own luma for saturation — and foliage, where the hue turn is the
    // whole point of a bronzing fern or a rust-tipped scrub, keeps HSL.
    if (o.flat) {
      const v1 = 0.82 + rng() * 0.30, s1 = 0.90 + rng() * 0.22;
      const v2 = 0.86 + rng() * 0.24, s2 = 0.90 + rng() * 0.22;
      const l1 = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
      c.setRGB(clamp01((l1 + (c.r - l1) * s1) * v1),
               clamp01((l1 + (c.g - l1) * s1) * v1),
               clamp01((l1 + (c.b - l1) * s1) * v1));
      const l2 = c2.r * 0.299 + c2.g * 0.587 + c2.b * 0.114;
      c2.setRGB(clamp01((l2 + (c2.r - l2) * s2) * v2),
                clamp01((l2 + (c2.g - l2) * s2) * v2),
                clamp01((l2 + (c2.b - l2) * s2) * v2));
    } else {
      const hue = o.hue ?? 0.035;
      c.getHSL(this._hsl);
      c.setHSL(this._hsl.h + (rng() - 0.5) * hue,
               clamp01(this._hsl.s * (0.90 + rng() * 0.22)),
               clamp01(this._hsl.l * (0.82 + rng() * 0.30)));
      c2.getHSL(this._hsl);
      c2.setHSL(this._hsl.h + (rng() - 0.5) * hue,
                clamp01(this._hsl.s * (0.90 + rng() * 0.22)),
                clamp01(this._hsl.l * (0.86 + rng() * 0.24)));
    }

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
    // ── visibility radius, per instance, not per archetype ──────────────
    // `visSpread` widens an archetype's single radius into a distribution.
    // Without it every instance of a type finishes shrinking at exactly the
    // same distance, so what the player sees approaching is a COHERENT RING of
    // props inflating out of the ground together — the defect the player
    // reported twice ("the pop-in of grass and rocks is basically right in
    // front of the car"). Sweeping the disappearance distance across a range
    // turns that ring into a density gradient: at any distance in the band some
    // props are full size, some are half grown and some are not there yet, and
    // there is no edge anywhere for the eye to lock onto.
    //
    // `rng() * rng()` rather than a flat roll, and the shape is the whole
    // economy of it. Instance count grows with the SQUARE of reach, so a flat
    // roll over [V, 1.4V] would buy the far end at the price of the near field.
    // The product of two uniforms piles most instances at the bottom of the
    // range and sends a thin tail to the top — a dense near field with a few
    // stragglers carrying the far one, which is also what a real drift of
    // litter looks like. Mean multiplier is 1 + 0.25*(spread-1).
    const vs = arch.visSpread;
    out[i + 16] = arch.vis * (o.visMul ?? 1) * (vs ? 1 + (vs - 1) * rng() * rng() : 1);
    out[i + 17] = ai;
    // `variant` lets a caller weight the choice. The uniform roll is right for
    // foliage, where the variants are the same plant grown twice, and wrong for
    // the stone tiers, where they are three different sizes and a flat third
    // each is the uniform grade the brief forbids.
    out[i + 18] = Math.min(arch.variants - 1,
      o.variant !== undefined ? o.variant : (rng() * arch.variants) | 0);
    if (o.nx === undefined) {
      out[i + 19] = -gx * inv;
      out[i + 20] = -gz * inv;
    } else {
      out[i + 19] = o.nx;
      out[i + 20] = o.nz;
    }
    return n + 1;
  }

  _cellKey(cx, cz, salt) {
    return (hash2i(cx, cz, this.seed ^ salt) * 4294967296) >>> 0;
  }

  // ── the layers ─────────────────────────────────────────────────────────────

  /** How many resumable slices the substrate layer is cut into. */
  static GROUND_SLICES = 4;

  /** Sites per slice, so the streamer can size its jobs without guessing. */
  // 620, down from 720, and this is the near-field half of a trade rather than
  // a saving. Reach and density both cost instances, but they do not cost the
  // same instances: density is bought in the near field, where a prop is
  // hundreds of pixels and overdraw is the whole frame cost, and reach is
  // bought in an annulus where each prop is a handful of pixels. So the
  // cheapest way to pay for a substrate that now reaches 44-64 m is to thin the
  // one that sits under the bumper — 14% fewer clumps at 0-20 m, against
  // roughly three times as much of it visible overall. The layer still answers
  // the blocker it was written for (65% of the 2 m road close-up was a smooth
  // untextured slab); it answers it with 620 clumps instead of 720, and it now
  // answers it out to where the player is looking as well.
  groundSites() { return Math.round(620 * this.mul); }

  /**
   * @param {number} band 0 = closest (everything) … 3 = far (big shapes only)
   * @param {boolean} deferGround leave the substrate to `generateGroundSlice`
   * @returns {number} instances written
   */
  generateCell(cx, cz, S, band, out, cap, deferGround = false) {
    let n = 0;
    // Mats first. They are the layer that decides whether a frame reads as
    // dressed ground at all, they are only a few hundred instances, and if a
    // cell ever clips its buffer it must not be them that goes.
    if (band <= 1) n = this._layerMat(cx, cz, S, out, n, cap);
    n = this._layerOpen(cx, cz, S, band, out, n, cap);
    if (band <= 2) n = this._layerScrub(cx, cz, S, out, n, cap);
    n = this._layerBank(cx, cz, S, out, n, cap);
    // Ahead of everything below it, and for the same reason the mats run first:
    // the margin is the layer that decides whether a waterline reads at all,
    // it is a few hundred instances in the cells that hold a shoreline and
    // literally zero in every other cell in the world, and if a cell ever clips
    // its buffer it must not be the shoreline that goes.
    if (band <= 2) n = this._layerShore(cx, cz, S, band, out, n, cap);
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
    if (band <= 0 && !deferGround) n = this._layerGround(cx, cz, S, out, n, cap, 0, Infinity);
    return n;
  }

  /**
   * One slice of the substrate layer for a cell, so the streamer can spread a
   * band-0 cell over several frames.
   *
   * This exists because of a measured hitch and it is worth stating what the
   * measurement was. `tools/_scratch/cover/costprobe.mjs` times one band-0 cell
   * at 5-7 ms, generating 8-10,000 instances; the streamer's per-frame budget
   * is 1.6 ms and is only checked *between* cells, so one cell is one 5 ms
   * spike however small the budget is. `perf.mjs` over a 45 s drive: 140 frames
   * over 50 ms with this layer present against 2 with it hidden, and three
   * frames over 100 ms against none.
   *
   * Slicing is safe here only because of the determinism rule at the top of
   * this file: every *site* owns an RNG stream keyed on (cell, layer, site
   * index) rather than drawing from one sequential stream, so sites 240-479
   * produce bit-identical output whether or not sites 0-239 ran first. That
   * property was put there for band refinement and it pays for itself twice.
   */
  generateGroundSlice(cx, cz, S, out, n, cap, slice) {
    const per = Math.ceil(this.groundSites() / CoverScatter.GROUND_SLICES);
    return this._layerGround(cx, cz, S, out, n, cap, slice * per, (slice + 1) * per);
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
  _layerGround(cx, cz, S, out, n, cap, from = 0, to = Infinity) {
    const N = this.noise, W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_GROUND);
    // 260 sites over a 48 m cell put roughly one accepted clump every 12 m²,
    // and after the visibility radius took its share the 2 m close-up still
    // measured as a bare slab with a handful of objects on it. What reads as
    // "the ground has stuff on it" is closer to one clump every 3 m².
    const sites = Math.min(to, this.groundSites());

    for (let a = from; a < sites && n < cap; a++) {
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
      //
      // `w.rock` IS NOT ROCK, and keying grit on it was the single reason the
      // near half of the `river` frame was bare. Below the alpine line the
      // terrain's rock weight is a restatement of slope — commit 87cd828 found
      // exactly this gating the mats, and the same misreading was still here.
      // Probed at the pixels that look bare (7-15 m from the camera, not the
      // distant hillside everyone including me assumed it was):
      //
      //     slope 1.08-1.20   grass 0.00   rock 0.97-1.00   dirt 0.70
      //
      // which put `wStone` at 3.90 against `wStraw` 1.77 — stone leading 64% of
      // clumps on a surface filling half the frame. Grit is the one entry in
      // this mix that covers no ground at all: a twenty-piece clump of 3-8 cm
      // chips covers four hundredths of a square metre, where a thatch mound
      // covers a third of one. So the layer was running at full density on that
      // bank and spending nearly two thirds of it on something invisible.
      //
      // Genuine stone ground reads on `sand`, on a road, and on rock that is
      // NOT also dirt — a scree slope is rock without soil on it. A 48° dirt
      // bank in a wooded valley is thatch and fallen leaf.
      const scree = clamp01(w.rock - w.dirt * 0.85) * 2.0 + clamp01(w.sand) * 1.4;
      const wStone = 0.45 + scree + clamp01(w.dirt) * 0.35
                   + smoothstep(0.60, 1.60, slope) * 0.45
                   + road * 1.0 - moist * 0.35;
      // A bare open slope in autumn is not swept clean of leaf. `lit` is the
      // tree system's deciduous-litter field and it is zero the moment there is
      // no crown overhead, which left open ground with the mix's floor value
      // and nothing else — so the one entry in the table that carries the
      // reference's rust and crimson never led a clump out in the open.
      const wLeaf  = 0.35 + lit * 2.4 + can * 0.55 + bare * 0.50;
      // Straw was carrying two thirds of the mix and hitting its instance cap
      // while stone and leaf sat at a quarter of theirs. It is also the weakest
      // of the three: it sits inside the meadow's own gold, so it adds texture
      // but no value or hue break, and the slab it is covering is gold too.
      // …and this is the other half of the same rebalance. The note above was
      // written when straw was one flat strand mat and genuinely the weakest of
      // the three; with the thatch mound behind it, straw is now the only entry
      // in the mix that covers ground, so on bare ground it should lead.
      const wStraw = (0.34 + (1 - moist) * 0.55 + bare * 1.60) * (1 - clamp01(can * 0.75));
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
      // One normal for the whole clump. The members below are all within a
      // couple of metres of here, and on this bank the difference between a
      // mat that knows which way the hill faces and one that does not is the
      // difference between a dressed slope and a bare one.
      const cn = this._clumpNormal(x, z, this._n2);
      for (let m = 0; m < members && n < cap; m++) {
        const ang = rng() * TAU, r = spread * Math.sqrt(rng());
        const mx = m === 0 ? x : x + Math.cos(ang) * r;
        const mz = m === 0 ? z : z + Math.sin(ang) * r;
        if (this._groundTiny(mx, mz, wet, false) < 0.20) continue;

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
            tone: 0.86 + rng() * 0.28, hue: 0.020, flat: true, nx: cn.nx, nz: cn.nz,
            // Reach follows what can actually be resolved, which on this tier
            // spans an order of magnitude. Grit is 3-10 cm: at 30 m it is one
            // pixel, so its radius costs a great deal (it is the most numerous
            // thing in the game) and buys nothing past there. The anchor stone
            // is 20-50 cm and reads as an object — it is the piece the eye
            // groups the drift around, and it is the one that has to be
            // present before the player is close enough to notice it arrive.
            visMul: anchor ? 1.7 : 1,
          });
        } else if (kind === 1) {
          // Weighted to the rust and crimson end rather than the gold. A
          // fallen leaf that is *lighter* than the meadow it lies on reads as
          // paper confetti at 2 m; the reference's litter is always a step
          // down in value from the ground and a step round toward red.
          const warm = rng();
          // …and the pale end of that pair has to follow the ground too. The
          // rule above is stated against "the meadow it lies on", and on the
          // meadow `litterGold` is indeed a step down from sunlit gold. On the
          // open clay of the `river` bank the ground measures srgb(103,58,34)
          // and `litterGold` (232,180,85) is nearly three times its luma — the
          // paper-confetti reading the rule exists to prevent, arrived at by
          // applying the rule to the wrong surface. Under a crown, and out in
          // the gold meadow, the gold end is still right; `bare` is the term
          // that separates the two and it is already computed above.
          n = this._emit(out, n, cap, 'leafScatter', mx, mz, rng, {
            colA: warm < 0.82 ? PAL.litterWarm : PAL.litterRed,
            colB: warm < 0.22 || bare > 0.55 ? PAL.litterRed : PAL.litterGold,
            sink: 0.01, scale: 0.65 + rng() * rng() * 1.10,
            tone: 0.90 + rng() * 0.24, hue: 0.028, flat: true, nx: cn.nx, nz: cn.nz,
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
            hue: 0.022, flat: true, nx: cn.nx, nz: cn.nz,
          });
        } else if (kind === 3) {
          n = this._emit(out, n, cap, 'moss', mx, mz, rng, {
            colA: PAL.mossDeep, colB: PAL.moss, sink: 0.01,
            scale: 0.7 + rng() * 0.8, tone: 0.88 + rng() * 0.22, hue: 0.03,
            flat: true, nx: cn.nx, nz: cn.nz,
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
            tone: 0.86 + rng() * 0.26, hue: 0.015, flat: true, nx: cn.nx, nz: cn.nz,
            visMul: 0.75,
          });
        }
      }
    }
    return n;
  }

  /**
   * The broad ground mats — critic blocker 5, "bare substrate ... an entire
   * hillside is bare brown".
   *
   * This is a *range* layer, not a density one, and that is the whole point of
   * it. Everything in `_layerGround` carries a 22-24 m visibility radius and
   * only runs in band-0 cells, so past about 24 metres the game has no ground
   * dressing whatever and the terrain albedo is the entire picture. The RIVER
   * tile in `review/045` is that fact: a hillside from 20 to 120 m out with a
   * thin scurf of thatch along its bottom edge and nothing at all above it. No
   * achievable number of 30 cm props reaches 90 m — see `buildGroundMat`.
   *
   * Placement is driven by BARENESS and almost nothing else, which is what
   * keeps this affordable. Where the grass carpet already covers, the layer
   * emits close to nothing and costs close to nothing; where the surface
   * weights say clay, dirt or thin dry ground, it fills. So the meadow — most
   * of the game, and the part that already reads — is untouched, and the frame
   * that fails is the frame that pays.
   *
   * The mix follows the ground the same way `_layerGround`'s does: damp and
   * shaded goes herbaceous green, dry and exposed goes gold thatch, and the
   * eroding warm ground round a river cut takes the rust pair, which is the
   * only place in the layer where a mat is allowed to be a colour accent
   * rather than a texture.
   */
  _layerMat(cx, cz, S, out, n, cap) {
    const N = this.noise, W = this.world;
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_MAT);
    // 260 sites over a 2304 m² cell is one candidate every 8.9 m². A broad
    // swathe puts strands and body over roughly a third of its own disc, i.e.
    // 6-8 m², so a fully bald slope — which accepts nearly every candidate —
    // comes out at around 60% of the ground actually dressed, and a closed
    // meadow, where the bareness gate below drops acceptance to about an
    // eighth, comes out at 8%. Those two numbers are the layer's whole job.
    //
    // Held near the original 240 rather than raised, and the density for a
    // bald slope taken from the drift loop below instead, because THIS is the
    // number that costs. A site pays `getSurfaceWeights` whether or not it is
    // accepted, and the layer runs on every cell out to 134 m; a drift member
    // only runs on a site that was already accepted, which on the meadow is one
    // in eight. Raised to 430 the perf gate went from settled 63.7 fps to 45.9;
    // the density it bought is now bought where it is nearly free.
    const sites = Math.round(260 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_MAT, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;

      // ORDER MATTERS HERE, and it is the difference between this layer costing
      // nothing and costing forty per cent of the frame rate.
      //
      // `_ground` is by a distance the most expensive test in this file: nine
      // `getWaterDepth` probes plus a surface-weight fetch. The first version of
      // this layer ran it on every candidate site and did the cheap acceptance
      // roll afterwards, so 240 cells' worth of the most expensive query in the
      // system was being spent to keep about a third of it. Measured on the
      // player's configuration, `tools/dprtest.mjs --dpr 2 --w 1170 --h 870`:
      // settled 62.5 fps with this layer off against 37.3 with it on. Rolling
      // first and probing only what survives is the whole fix.
      const slope = W.getSlope(x, z);
      if (slope > 1.95) continue;
      const can = this._canopyAt(x, z);
      const moist = W.getMoisture(x, z);
      const w = W.getSurfaceWeights(x, z, this._w);

      // NOT gated on bareness, and that is a correction rather than a choice.
      //
      // The first version of this layer keyed off `1 - w.grass`, on the
      // reasonable-sounding theory that the grass weight says where the ground
      // is already dressed. That was dropped, and the note that replaced it
      // claimed the critic's hillside measures `grass` 0.97-1.00. It does not —
      // that reading was taken along the anchor's own yaw ray, which lands on
      // the flat valley floor to the RIGHT of the bare slope. Probed at the
      // pixels that actually look bare (`tools/_scratch/cover/hillprobe.mjs`)
      // the hillside measures `grass 0.00, rock 1.00, dirt 0.70, slope 1.0-1.9`.
      // The lesson stands and the number was wrong: sample where the defect is,
      // not where the camera is pointing.
      //
      // So the bareness gate is BACK, on the correct reading, and it is the
      // single most valuable line in this layer.
      //
      // The cap is the binding constraint, not the acceptance rate: measured on
      // the `river` anchor, `groundMat_0` sits at 700/700 while the hillside it
      // exists for is still bare. Every mat spent in closed meadow is a mat not
      // spent on the slope, and in the meadow it is worse than wasted — a pale
      // flat lozenge lying on a closed gold carpet is the "hard-edged decal"
      // artefact the look author logged against this layer. Concentration, not
      // volume, is what fills the frame that fails.
      //
      // `w.grass` measures 0.00 on the bare hillside and 0.86-0.99 across the
      // meadow floor, so it separates the two cases almost perfectly, and the
      // 0.16 floor keeps a thin scatter of texture in the good meadow rather
      // than a visible boundary where the layer switches off.
      const bare = 1 - smoothstep(0.30, 0.90, w.grass);
      const lean = smoothstep(0.22, 0.95, slope) * 0.45
                 + clamp01(w.dirt) * 0.35;
      // Mid-frequency, so mats arrive in drifts with open ground between them
      // rather than as an even quilt. Deliberately a different frequency and
      // offset from the substrate's accumulation field: two layers clumping on
      // the same noise would stack into one blotch pattern.
      const acc = smoothstep(-0.55, 0.55,
        N.fbm(x * 0.026 - 143.1, z * 0.026 + 58.9, 2, 2.1, 0.5, 1));
      // Floor raised on the clump field. At 0.46 the drift wavelength (38 m)
      // is wide enough that whole stretches of a ten-metre-wide bare strip fall
      // in a trough and get nothing — visible in shots/cover/a8-river.png as
      // brown gaps between dressed bands. Clumping is meant to make hollows
      // richer than ridges, not to leave the ground the layer exists for empty.
      if (rng() > clamp01((0.16 + 0.84 * bare) * (0.64 + acc * 0.36) * (1 + lean))) continue;

      // Only now the expensive one. A mat is two to five metres across, so it
      // needs the eight-point spill probe at a real footprint — a centre that
      // tests dry a metre from a bank puts half a swathe out over the river.
      const g = this._ground(x, z, 1.6);
      if (g < 0.20) continue;

      // Broad swathes lead on open ground; the small mat is for the ragged
      // margins and the steeper ground, where a three-metre swathe would
      // overhang whatever it is edging.
      const broad = rng() < 0.62 - clamp01(slope * 0.30) - can * 0.20;
      const herb = moist * 0.9 + can * 0.9 - slope * 0.35;
      const rust = clamp01((1 - moist) * 0.7 + slope * 0.5 + clamp01(w.dirt) * 0.8 - can * 0.6);
      let colA, colB;
      // Threshold raised from 0.88. In open meadow `moist` sits near 0.7 and
      // `can` near 0.3, which cleared 0.88 and made the *herbaceous* pair the
      // default on the drive route — dull olive patches on gold, which is what
      // shots/cover/a10/drive.png shows. Herb is for genuinely damp shaded
      // ground under a canopy, and 1.06 is where that starts.
      if (herb > 1.06) { colA = PAL.matHerb; colB = PAL.matHerbLit; }
      // The rust share is drawn from `rust` itself rather than from a flat
      // coin, and that is the single cheapest thing in this pass.
      //
      // `rust` is already the right field — dry, sloped, dirty ground — and on
      // the `river` hillside it saturates at 1.0 (moist 0.68, slope 1.06,
      // dirt 0.69). But it was only used as a gate, with a 0.38 coin after it,
      // so five mats in eight on a rust-brown clay bank came out of the GOLD
      // pair. Gold on rust is a hue break as well as a value break, and a
      // ground mat is the one thing in this layer that must never be either:
      // its whole job is to be the ground, worked over. Where the field is
      // ambiguous the gold pair still leads, which is what keeps the meadow —
      // low slope, low dirt, damp — exactly as it was.
      else if (rng() < clamp01((rust - 0.46) * 1.7)) { colA = PAL.matRust; colB = PAL.matRustLit; }
      else { colA = PAL.matDry; colB = PAL.matDryLit; }

      // Two or three swathes per accepted site on genuinely bare ground, one on
      // grass — a drift rather than a single stamp.
      //
      // This is where the density for the bald hillside comes from, and it is
      // deliberately bought here rather than by raising `sites`. The site count
      // is what pays for `_ground`, which is nine `getWaterDepth` probes and a
      // surface-weight fetch and by a distance the most expensive call in this
      // file; the members are free by comparison because they only run on sites
      // that already passed it, and on the meadow — most of the map — the
      // bareness term keeps the count at one so nothing changes there at all.
      //
      // RAISED with the drop in `buildGroundMat`'s radius. A broad pad now
      // covers about a third of the ground a swathe nominally did, because the
      // old radius was placing geometry the terrain immediately ate — see the
      // deviation table in that function. The reach has to come back as more
      // patches rather than bigger ones, and this is where it is cheapest: a
      // member only runs on a site that already passed `_ground`, which on the
      // meadow is one candidate in eight, so the meadow pays almost nothing for
      // it and the bald slope the layer exists for gets all of it.
      // STEEP AND BARE GETS MORE STILL, and the reason is the near fade rather
      // than ecology. On a slope this camera stands 6 m above, the ground in
      // front of it is 7-12 m away for a third of the frame, and a broad mat
      // (visMul 1, radius 130 m) is 0% grown at 8 m and 28% at 12 m — so every
      // mat that comes out of the broad tier is spent somewhere the player
      // cannot see it from here, and on this hillside two thirds of them do
      // (`cover_groundMat_1` 168 instances inside the world-data hillside mask
      // against `_0`'s 85). The small tier carries the whole near field alone,
      // and it sits at 185/1200 of its cap, so the headroom is free.
      //
      // Bought in the drift rather than in `sites` for the reason stated above:
      // a site costs `_ground`, a member does not, and on the meadow `bare` is
      // near zero so this term is exactly zero there.
      const steepBare = smoothstep(0.55, 1.20, slope) * bare;
      const drift = 1 + ((rng() * (0.9 + bare * 6.2 + steepBare * 3.2)) | 0);
      for (let mI = 0; mI < drift && n < cap; mI++) {
        let mx = x, mz = z;
        if (mI > 0) {
          // Tightened with the radius: patches want to overlap into a drift,
          // and at the old spacing a smaller pad just leaves bare ground
          // between every pair of them.
          const ma = rng() * TAU, mr = 0.9 + rng() * 2.6;
          mx = x + Math.cos(ma) * mr; mz = z + Math.sin(ma) * mr;
          // A member is a two-to-three metre object like its site, so it gets
          // the same spill probe. Anything cheaper puts half a swathe over the
          // river, which is the defect the eight-point probe exists for.
          if (this._ground(mx, mz, 1.5) < 0.20) continue;
        }
        const mBroad = mI === 0 ? broad : rng() < 0.55 - clamp01(slope * 0.30);
        n = this._emit(out, n, cap, 'groundMat', mx, mz, rng, {
          colA, colB,
          variant: mBroad ? 1 : 0,
          // The small mat carries a third of the radius. Two jobs out of one
          // archetype: the near-field fade in the material is a fraction of the
          // instance's own radius, so this is what lets small mats dress the
          // ground from 7 m while broad swathes stay out until 20.
          visMul: mBroad ? 1 : 0.34,
          // Sunk, so the rim of the mat is buried and there is no under-edge to
          // read as an object lying on the ground.
          sink: 0.04 + rng() * 0.05,
          scale: 0.86 + rng() * 0.34,
          // Wide. Forty mats at one tone is a repeated stamp; the reference's
          // ground is the same colour worked over at a dozen values.
          tone: 0.76 + rng() * 0.42, hue: 0.034,
        });
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
      const cn = this._clumpNormal(x, z, this._n2);
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
          nx: cn.nx, nz: cn.nz,
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

  /**
   * Riverbank and lake-shore thickets — willow and alder.
   *
   * Keyed on distance to water rather than on the river mask, and that is a fix
   * rather than a refactor. `getRiver` is the *channel* raster: it is zero over
   * every lake in the world, so the only water this layer could ever see was
   * flowing water, and a lake shore got thickets only where the moisture term
   * happened to clear 0.66 — which is a regional field, not a shoreline. Half
   * the waterline in the game was invisible to the one layer whose whole job is
   * to stand on it.
   */
  _layerBank(cx, cz, S, out, n, cap) {
    const W = this.world, N = this.noise, SF = this._shore();
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_BANK);

    for (let a = 0; a < 9 && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_BANK, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;
      const river = W.getRiver(x, z);
      const moist = W.getMoisture(x, z);
      const sd = SF.at(x, z);
      // A willow stands back from the lip — it wants wet feet and dry roots —
      // so the weight peaks a few metres up the bank and dies by twelve. The
      // river term is kept as a *bonus* rather than as the gate: a big channel
      // carries more bank vegetation than a pond does, which is true, and it is
      // no longer the only thing that can open the layer at all.
      const bankness = clamp01(smoothstep(0.4, 2.6, sd) * (1 - smoothstep(6.0, 13.0, sd)))
                     * (0.55 + clamp01(smoothstep(0.03, 0.30, river)) * 0.55)
                     + clamp01(smoothstep(0.66, 0.90, moist)) * 0.28;
      if (bankness < 0.12) continue;
      // Thickets come in groves with bare bank between them, and the field they
      // clump on is deliberately offset from the reed layer's so the two
      // interleave along a shore instead of arriving together. A bank where
      // every reed bed has a willow behind it reads as a repeated motif.
      const grove = smoothstep(-0.28, 0.30,
        N.fbm(x * 0.014 - 502.9, z * 0.014 + 61.4, 2, 2.1, 0.5, 1));
      const g = this._ground(x, z, 2.0);
      if (g < 0.10) continue;
      if (rng() > bankness * g * grove * 1.9) continue;

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

  /**
   * The water margin: reed stands in the shallows, a damp bank band above them,
   * and a sedge fringe on the lip that hangs over the waterline.
   *
   * ── WHY THIS IS ONE LAYER AND NOT THREE ────────────────────────────────────
   *
   * They are three *bands of one section* through a bank, and the whole point
   * of the reference plate is that the three read as a sequence: hot gold
   * meadow, a darker olive damp band, then water, with the plant silhouette
   * doing the joining. Splitting them into separate layers means three
   * independent noise fields deciding independently where they stop, and a
   * bank where the damp mat is present and the sedge is not is a bank with a
   * painted stripe on it. Sharing one site, one shore distance and one stand
   * field is what keeps the section coherent as it runs along the shore.
   *
   * ── THE ONE RULE THAT MATTERS: STANDS, NOT AN OUTLINE ──────────────────────
   *
   * Uniform density along a contour is the single most artificial thing this
   * layer could do. It is also the thing it does by default, because the gate
   * — "is there shallow water here" — is itself a contour, so any density
   * applied evenly to everything that passes it draws a green pipe-cleaner
   * around every lake in the world.
   *
   * `stand` is the answer and it is deliberately a HARD threshold on a slow
   * field: `smoothstep(0.06, 0.40, fbm)` over a ~55 m wavelength accepts about a
   * quarter of the shoreline and refuses the rest outright. Three quarters of
   * every waterline in this game has no reeds on it at all, which is what makes
   * the quarter that does read as a reed bed rather than as an edge treatment.
   *
   * `bay` is the second half of it and it is measured rather than noised. Eight
   * depth probes on a 9 m ring: on a straight bank about half come back wet, in
   * a bay — where the water wraps around you — more than half, on a point fewer.
   * Reeds want slack water, which is what a bay is, so the two multiply and the
   * beds land in the re-entrants and leave the headlands bare. That correlation
   * is what makes the placement read as *caused* instead of as noise that
   * happens to be lumpy, and it is the same argument `RockScatter` opens with.
   *
   * The damp band is deliberately NOT stand-gated. It is a property of the
   * ground rather than a plant that chose to grow there — everything within
   * two metres of standing water is damp — so gating it would produce exactly
   * the painted-stripe artefact described above, in the opposite direction. It
   * is modulated in *width* instead, by a faster field, so the band scallops in
   * and out rather than running as a ribbon of constant gauge.
   */
  _layerShore(cx, cz, S, band, out, n, cap) {
    const W = this.world, N = this.noise, SF = this._shore();
    const ox = cx * S, oz = cz * S;
    const key = this._cellKey(cx, cz, L_SHORE);
    // 74 candidates over a 2304 m² cell. Higher than the shrub layers because
    // the target is a strip a few metres wide rather than an area: a cell that
    // a shoreline crosses corner to corner holds maybe 300 m² of margin, i.e.
    // an eighth of the cell, so an eighth of these land anywhere useful. The
    // other seven eighths cost ONE `ShoreField.at` each and are gone — which is
    // the whole reason the distance raster exists rather than a probe ring.
    const sites = Math.round(74 * this.mul);

    for (let a = 0; a < sites && n < cap; a++) {
      const rng = mulberry32((hash2i(a, L_SHORE, key) * 4294967296) >>> 0);
      const x = ox + rng() * S, z = oz + rng() * S;

      // The cheap gate first, and it is the only thing most of the world pays.
      // 5.5 rather than the band's own width: the dry half walks its site down
      // the distance gradient into the band (see below), so a candidate five
      // metres out is not a candidate in the wrong place, it is a candidate the
      // layer can still use. Widening it is how the band gets its density.
      const sd = SF.at(x, z);
      if (sd > 7.0) continue;
      const g = this._shoreGround(x, z, 0.80);
      if (g < 0.10) continue;

      const depth = W.getWaterDepth(x, z);
      // 0.80, not the brief's 0.4. The brief's number is the depth a reed bed
      // is *densest* at, and it is the right number for that; measured across
      // this world's channels (`tools/_scratch/banks/shoreprobe.mjs`) the bed
      // frequently drops from 0 to 7 m inside four metres of bank, so a hard
      // 0.4 m ceiling leaves a shelf one texel wide and a bed with nowhere to
      // stand. The thinning curve in the member loop is what actually shapes
      // the bed — this is only the point past which it is open water.
      if (depth > 0.80) continue;

      // ~55 m wavelength, thresholded hard. See the note above: this is the
      // line that makes a bed a bed. Offset and frequency are unique to this
      // layer — sharing either with the mat or shrub fields would stack the
      // two into one blotch pattern along the same shore.
      const stand = smoothstep(0.06, 0.40,
        N.fbm(x * 0.018 + 311.7, z * 0.018 - 174.3, 2, 2.15, 0.5, 1));

      if (depth > 0.04) {
        // ── reeds, standing in the water ───────────────────────────────────
        if (stand < 0.05) continue;
        // Eight probes, and they are only ever paid by a candidate that already
        // knows it is standing in shallow water — a few per cell, on the cells
        // that hold a shoreline at all.
        let wetRing = 0;
        for (let k = 0; k < 8; k++) {
          const ang = k * 0.7853982 + 0.31;
          if (W.getWaterDepth(x + Math.cos(ang) * 9, z + Math.sin(ang) * 9) > 0.05) wetRing++;
        }
        // 0 on a headland, ~0.45 on a straight bank, 1 in a re-entrant.
        const bay = clamp01((wetRing / 8 - 0.28) * 2.1);
        // Fast water scours a bed out. The river mask is channel strength, so a
        // big trunk river's centre gets nothing and its slack margins keep the
        // full weight — which is also where a real reed bed is.
        const slack = 1 - smoothstep(0.30, 0.68, W.getRiver(x, z));
        const d = stand * (0.30 + bay * 0.85) * slack;
        if (rng() > d * 1.35) continue;

        // ── the stand is elongated along the shore ─────────────────────────
        //
        // A circular clump dropped on a margin puts a third of itself out into
        // open water, where the depth test then deletes it — so what survives is
        // a half-disc with a straight edge along the contour, which is the
        // outline read arriving through the back door. The depth GRADIENT points
        // into deeper water, so its perpendicular is the shore tangent; running
        // the stand two or three times as far along that as across it fills a
        // bay the way a bed actually grows into one, and the members that do
        // stray deep are deleted at the frayed end where it does not show.
        const e = 3.0;
        let gx = W.getWaterDepth(x + e, z) - W.getWaterDepth(x - e, z);
        let gz = W.getWaterDepth(x, z + e) - W.getWaterDepth(x, z - e);
        const gl = Math.hypot(gx, gz);
        if (gl < 1e-4) { gx = 1; gz = 0; } else { gx /= gl; gz /= gl; }
        const tx = -gz, tz = gx;
        const along = 3.4 + rng() * 5.2, across = 1.1 + rng() * 1.9;

        // One character per stand. The file's own rule, and it is worth
        // restating here because a reed bed is the case where breaking it is
        // most tempting: rolling green-or-straw per culm gives a bed of evenly
        // mixed confetti, which averages to one dull colour over any area big
        // enough to read. A stand that has gone over to seed *as a stand* is a
        // straw-coloured patch inside a green bed, which is what the plates
        // show and what gives the margin its internal variation.
        const dryStand = rng() < 0.30;
        // A bed is a MASS. This is the count that decides whether the layer
        // reads as a stand or as a scatter of green wires, and it is bought at
        // the only place in this layer where instances are cheap: a member runs
        // one depth lookup where a site has already paid a raster fetch, a
        // ground test, eight ring probes and two gradient probes. Twenty-odd
        // members inside a 4x2 m lens is roughly two clumps per square metre,
        // which is what a photographed reed bed measures at and what the
        // reference plate's margin reads as.
        const members = 10 + ((rng() * (9 + stand * 14 + bay * 10)) | 0);
        for (let m = 0; m < members && n < cap; m++) {
          const u = (rng() + rng() - 1) * along;
          const v = (rng() + rng() - 1) * across;
          const mx = x + tx * u + gx * v, mz = z + tz * u + gz * v;
          if (!W.isInBounds(mx, mz)) continue;
          const md = W.getWaterDepth(mx, mz);
          // Thinning with depth rather than a cliff at one number. A bed that
          // stops dead at a depth draws a second contour just outside the
          // first, which is the outline read this whole layer is written to
          // avoid, arrived at from inside the bed.
          if (md > 0.75) continue;
          if (rng() > 0.28 + 0.72 * smoothstep(0.70, 0.12, md)) continue;
          if (this.world.getSlope(mx, mz) > 1.5) continue;

          // Tier follows depth, so the bed shortens toward the mud and drops
          // its short tier as the water deepens past what a spike rush can
          // stand in. The scale floor then guarantees emergence: a culm has to
          // clear its own depth by a comfortable margin or the water closes
          // over it, and a reed level with the surface reads as nothing at all.
          // `REED_HEIGHT` is exported from `cover_forms.js` precisely so this
          // arithmetic is against the mesh that exists rather than a guess.
          let variant;
          if (md > 0.18) variant = rng() < 0.68 ? 0 : 1;
          else if (md > 0.07) variant = rng() < 0.55 ? 1 : 0;
          else variant = rng() < 0.50 ? 2 : 1;
          const sc = Math.max((md + 0.34) / REED_HEIGHT[variant], 0.74 + rng() * 0.46);

          const dry = rng() < 0.22 ? !dryStand : dryStand;
          n = this._emit(out, n, cap, 'reed', mx, mz, rng, {
            colA: dry ? PAL.reedDry : PAL.reedDeep,
            colB: dry ? PAL.reedDryTip : PAL.reedLit,
            variant, scale: sc,
            // Rooted on the bed, not floated on the surface. `_emit` takes the
            // terrain height, and the sink is small because a culm emerging
            // from silt has no visible base to hide.
            sink: 0.02,
            tone: 0.88 + rng() * 0.26, hue: 0.030,
            // Straight up. `_emit` would otherwise hand the instance the bed's
            // own normal, and a submerged shelf tilts; a whole bed leaning one
            // way reads as combed. `conform` in the archetype table takes what
            // little of this survives down to 15%.
            nx: 0, nz: 0,
          });
        }
        continue;
      }

      // ── the dry side: damp band and sedge fringe ───────────────────────────
      //
      // ── WALK THE SITE INTO THE BAND, DO NOT WAIT FOR ONE TO LAND IN IT ────
      //
      // This is the whole economy of the dry half and the first version got it
      // wrong by a factor of twenty. Candidates are drawn uniformly over
      // everything inside `sd < 5.5`, the band that actually wants dressing is
      // the first metre or two, and area grows with distance — so measured at
      // the `mouth` anchor (`tools/_scratch/banks/drybranch.mjs`) the shore
      // distance of an accepted dry candidate came out as: 4 sites under 1 m,
      // 58 between 1 and 2, 215 between 2 and 3, 426 between 3 and 4. The damp
      // test then threw away 759 of 801. Six sedge tufts and thirty-six mats
      // survived over a 288 m square, which in the capture is a shoreline of
      // bare pink sand with nothing whatever on it.
      //
      // A distance field has a gradient of magnitude one, so "move three metres
      // closer to the water" is one multiply — there is no search and no
      // rejection. Draw the offset the site WANTS from the band profile and
      // walk it there. Acceptance goes from 5% to ~90% for the same number of
      // candidates and the same cost per candidate, and the distribution across
      // the band is now the one that was authored rather than the one that
      // falls out of the geometry of an annulus.
      const q = 2.0;
      let ax = SF.at(x - q, z) - SF.at(x + q, z);
      let az = SF.at(x, z - q) - SF.at(x, z + q);
      const al = Math.hypot(ax, az);
      // No gradient means a flat pan of standing water or a raster plateau far
      // from anything; there is no "toward the water" to walk along.
      if (al < 1e-3) continue;
      ax /= al; az /= al;
      const toWater = Math.atan2(az, ax);

      // Width, not presence. `edge` is the scalloping field — a faster
      // wavelength than `stand`, so the damp band swells to three metres in
      // places and pinches to half of one in others, and the boundary between
      // damp and dry meadow is a wandering line rather than an offset contour.
      const edge = N.fbm(x * 0.042 - 88.3, z * 0.042 + 27.6, 2, 2.2, 0.5, 1);
      // 1.4 to 4.0 m, not the brief's "metre or two". The brief describes the
      // reference plate, where the meadow runs to the water and the damp strip
      // is all that separates them. This world's terrain paints a much wider
      // pale shore — sectioned at the `river` anchor
      // (`tools/_scratch/banks/transect.mjs`) the bare band between waterline
      // and closed grass runs three to six metres — so a band authored at the
      // plate's width covers a third of what it has to cover and leaves a
      // second, paler stripe outside it. The proper fix is upstream (the
      // terrain's `sand` weight is gated on `WorldData.distToShoreApprox`,
      // which is a stub; logged in docs/INTEGRATION_REQUESTS.md); until then
      // the band is authored against the ground that is actually there.
      const width = 1.4 + clamp01(edge + 0.9) * 2.4;
      // Squared toward the water, because that is where the band is dark and
      // where the sand it has to cover is: two thirds of every site lands in
      // the inner half of the band and the outer half gets the stragglers that
      // blur its edge into the meadow.
      const want = 0.05 + width * rng() * rng();
      let bx = x + ax * (sd - want), bz = z + az * (sd - want);
      if (!W.isInBounds(bx, bz)) continue;

      // ── and then confirm against the depth field ─────────────────────────
      //
      // `ShoreField.at` already carries the half-texel lip correction, so the
      // walk lands close to where it was aimed; what it cannot do is know where
      // inside a texel the shore actually runs, which on a shallow shelf is a
      // metre either way. One depth lookup settles it in the common case, and
      // three 0.8 m steps back up the gradient cover a texel and a half, which
      // is more than the residual error can be.
      for (let k = 0; k < 3; k++) {
        if (W.getWaterDepth(bx, bz) <= 0.02) break;
        bx -= ax * 0.8; bz -= az * 0.8;
      }
      const bsd = SF.at(bx, bz);
      if (bsd > width * 1.4 + 0.8) continue;

      const cn = this._clumpNormal(bx, bz, this._n2);
      const damp = clamp01(1 - smoothstep(width * 0.45, width * 1.15, bsd));
      // ── the band is a STRIP, and a strip needs a strip's density ──────────
      //
      // The arithmetic that sets this, because it is not the same arithmetic
      // any other layer in this file uses. Every other layer dresses an AREA
      // and its density is per hectare; this one dresses two metres either side
      // of a line. A hundred and twenty metres of shoreline in frame is about
      // 240 m² of band, and a sward that reads as a sward — the reference's
      // damp olive strip is continuous turf, not dotted clumps — needs three or
      // four tufts per square metre over it. That is a thousand instances in a
      // frame, out of a layer whose sites can only ever land a hundred or two
      // in the band at all.
      //
      // So the density is bought in the MEMBERS, which cost one raster fetch
      // and one ground test each, and not in `sites`, which cost a fetch, a
      // ground test, a depth lookup, two gradient probes and a walk. A member
      // spread of ±3.4 m along the shore by the band's own width across is
      // about 8 m², so twenty-odd members in it is the 3/m² the sward wants.
      //
      // `lush` is the same scalloping field that sets the width, reused rather
      // than drawn again — so where the band is wide it is also thick, and
      // where it pinches it thins to a scatter. Modulating both from one field
      // is what makes the fringe read as scalloped bays and points instead of a
      // ribbon of even gauge, which on a shoreline is the same defect the reeds'
      // `stand` field exists to prevent.
      const lush = clamp01(edge + 0.55);
      const members = 4 + ((rng() * (4 + damp * 9 + lush * 15)) | 0);
      for (let m = 0; m < members && n < cap; m++) {
        // Members spread ALONG the shore, not across it. Scattering them in a
        // disc walks half of them out of the band they were placed in, which
        // both wastes them and blurs the band's outer edge into the meadow.
        const su = (rng() + rng() - 1) * 3.4;
        const sv = (rng() - 0.5) * width * 1.25;
        const mx = bx - Math.sin(toWater) * su + Math.cos(toWater) * sv;
        const mz = bz + Math.cos(toWater) * su + Math.sin(toWater) * sv;
        const msd = SF.at(mx, mz);
        if (msd > width * 1.4 + 0.8) continue;
        const mdamp = clamp01(1 - smoothstep(width * 0.45, width * 1.15, msd));

        // The lip gets sedge; the shoulder behind it gets the damp mat. The
        // split is by distance rather than by a coin, because the whole section
        // is trying to read as three bands and a mat in front of a sedge tuft
        // would put the pale note on the wrong side of the dark one.
        //
        // The sedge share is high and that is deliberate: this is the form
        // whose blades arch out over the water, and the tan shore texel it has
        // to cover is not a thin line — in `shots/banks/mouth.png` it is two
        // metres of pink sand along the whole waterline. A mat lies flat and
        // shows the sand between its strands; a fringe of overhanging tufts is
        // what actually hides it.
        // Three tufts to one mat, right across the band, and the ratio is a
        // correction. Splitting them evenly by distance gave 1200 damp mats per
        // 288 m square against 500 tufts — which is the whole cap of
        // `groundMat` spent on a shoreline, stolen from the meadow layer that
        // shares it, on the one form here that does NOT cover the tan shore
        // texel. A mat lies flat and shows the ground between its strands; a
        // fringe of arching tufts is what hides it. The mat's job in this band
        // is only to carry the damp olive *colour* under and between the tufts,
        // and a quarter of the members is enough for that.
        if (rng() < clamp01(0.92 - msd * 0.14)) {
          // A sedge crown may sit in a few centimetres of water. That is not a
          // tolerance, it is the form's job: a tuft whose base is exactly on
          // the line leaves the line visible, and one whose base is a hand's
          // width into it covers it.
          if (this._shoreGround(mx, mz, 0.11) < 0.10) continue;
          // Fine sedge right at the lip, coarse tufts behind: a size ladder
          // across a metre, which is what makes the edge read as ragged rather
          // than as a row.
          const fine = msd < 0.5 ? rng() < 0.62 : rng() < 0.25;
          n = this._emit(out, n, cap, 'sedge', mx, mz, rng, {
            colA: PAL.sedgeDeep,
            // A share takes the meadow's own straw at the tip. This is the
            // hand-off: at the top of the band the fringe is gold like the
            // meadow behind it, at the water it is olive like the reeds, and
            // nothing anywhere is a hard boundary between the two.
            colB: rng() < 0.18 + msd * 0.40 ? PAL.strawPale : PAL.sedgeTip,
            variant: fine ? 1 : 0,
            // Yawed so the overhang leans at the water. Without this the form's
            // lay points at a random bearing and a third of every tuft hangs
            // backwards into the bank, where it is invisible.
            yaw: toWater + (rng() - 0.5) * 0.9,
            scale: (fine ? 0.86 : 1.02) + rng() * 0.50,
            sink: 0.02, tone: 0.88 + rng() * 0.26, hue: 0.032,
            nx: cn.nx, nz: cn.nz,
          });
        } else {
          if (this._shoreGround(mx, mz, 0.04) < 0.10) continue;
          n = this._emit(out, n, cap, 'groundMat', mx, mz, rng, {
            colA: PAL.matDamp, colB: PAL.matDampLit,
            // Small pads only. The broad variant is a three-metre swathe and
            // this band is one to three metres wide — a broad one accepted at
            // its centre lies half of itself in dry gold meadow, which is the
            // one place the damp pair must never appear.
            variant: 0, visMul: 0.78,
            sink: 0.04 + rng() * 0.05,
            scale: 0.90 + rng() * 0.40,
            // Narrower than the meadow's mats. A tone jitter is what stops
            // forty mats reading as one stamp, but here the whole point is that
            // the band is a distinguishable VALUE — spread it as wide as the
            // dry mats and the band's own mean drifts back toward the gold it
            // is supposed to separate from.
            tone: 0.84 + rng() * 0.28, hue: 0.026,
            nx: cn.nx, nz: cn.nz,
          });
        }
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

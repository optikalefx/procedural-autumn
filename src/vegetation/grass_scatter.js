// ─────────────────────────────────────────────────────────────────────────────
//  Grass placement.
//
//  Fills one tile's instance buffer. Everything here is driven off ctx.world so
//  the field agrees with what the terrain shader has already painted.
//
//  Two rules matter more than the rest:
//
//   1. Clumps, not scatter. Blades are emitted in tufts around a clump centre,
//      and the *world sampling* happens once per clump. That is what makes a
//      15 000-blade tile cost ~1 ms instead of ~10 ms, and it is also what makes
//      the meadow read as drifts and bare patches instead of an even lawn.
//   2. Density is a field, not a constant. Surface weights, moisture, slope,
//      river gravel, roads and two octaves of macro noise all multiply into one
//      0..1 number that becomes *how many blades this tuft gets*.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp01, smoothstep, mulberry32, hash2i } from '../core/MathUtils.js';

// Interleaved layout, floats per instance.
export const STRIDE = 14;
//  0..2   aPos    x,z relative to the tile origin; y is absolute world height
//  3..6   aShape  height, width, static bend, phase
//  7..10  aTint   yaw, tone (gold→olive), dryness, per-clump shade
// 11..13  aMisc   terrain normal x, terrain normal z, fade rank

const TAU = Math.PI * 2;

/**
 * @returns {number} blades written (the tile's instanceCount)
 */
export function fillTile(world, roads, ring, ox, oz, seed, out, bounds) {
  const S = ring.tileSize;
    const max = ring.maxBlades;
  const rng = mulberry32(hash2i(Math.round(ox / S), Math.round(oz / S), seed ^ ring.salt));
  const noise = world.noise;
  const w = bounds.weights;

  let n = 0;
  let minY = Infinity, maxY = -Infinity;

  const attempts = ring.clumpAttempts;
  for (let a = 0; a < attempts && n < max; a++) {
    const cx = ox + (rng() - 0.5) * S;
    const cz = oz + (rng() - 0.5) * S;

    // ── hard rejects ────────────────────────────────────────────────────────
    if (world.getWaterDepth(cx, cz) > 0.02) continue;

    const slope = world.getSlope(cx, cz);
    if (slope > 1.15) continue;

    world.getSurfaceWeights(cx, cz, w);
    // Grass and dry straw both grow blades; rock, snow and sand do not.
    let d = clamp01(w.grass + w.dry * 0.8);
    d *= 1 - smoothstep(0.22, 0.62, w.rock);
    d *= 1 - w.snow;
    if (d < 0.02) continue;

    const moist = world.getMoisture(cx, cz);
    const river = world.getRiver(cx, cz);

    // Thin out on gravel bars, and on anything steep enough to be scree.
    d *= 1 - smoothstep(0.06, 0.32, river) * 0.80;
    d *= 1 - smoothstep(0.52, 1.05, slope);

    // Forest floor keeps grass but loses the thick meadow stand. Trees.js owns
    // the canopy; this is the moisture band it plants into.
    d *= 1 - smoothstep(0.54, 0.80, moist) * 0.34;

    // Wheel ruts: the track is a bare line through the field.
    if (roads) d *= 1 - roads.sample(cx, cz) * 0.94;

    // ── macro structure: drifts, patches and bare ground ────────────────────
    // A perfectly even field is an instant reject; these two octaves are what
    // give the meadow its lay.
    const drift = noise.fbm(cx * 0.0115, cz * 0.0115, 2, 2.1, 0.5, 1);
    const patch = noise.fbm(cx * 0.049 + 17.3, cz * 0.049 - 4.1, 2, 2.3, 0.5, 1);
    const lay = drift * 0.55 + patch * 0.75;
    // Never all the way to zero: a hole in the field shows raw terrain, and a
    // black hole in the near ground is far uglier than a thin patch.
    d *= 0.34 + 0.66 * smoothstep(-0.45, 0.28, lay);
    if (d < 0.03) continue;

    // ── the tuft ────────────────────────────────────────────────────────────
    const count = Math.min(max - n, Math.round(ring.perClump * d * (0.55 + rng() * 0.9)));
    if (count < 1) continue;

    const baseH = world.getHeight(cx, cz);
    // Local plane through the clump: one height sample per blade is the single
    // most expensive thing we could do, and over a 1 m tuft it buys nothing.
    const e = 1.0;
    const hL = world.getHeight(cx - e, cz), hR = world.getHeight(cx + e, cz);
    const hD = world.getHeight(cx, cz - e), hU = world.getHeight(cx, cz + e);
    const gx = (hR - hL) / (2 * e), gz = (hU - hD) / (2 * e);
    // Terrain normal from the same gradient (cheaper than getNormal again).
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    const nX = -gx * inv, nZ = -gz * inv;

    // ── colour ──────────────────────────────────────────────────────────────
    // Gold is the key. Olive is an accent that only wins in genuinely damp
    // ground and along the riverbank; straw wins on dry exposed slopes.
    const tone = clamp01(moist * 1.85 - 0.82 + river * 0.80 + patch * 0.18);
    const dry = clamp01((1 - moist) * 1.35 - 0.55 + smoothstep(0.18, 0.62, slope) * 0.50
                        + drift * 0.22) * (1 - tone * 0.8);
    const shade = 0.78 + rng() * 0.40 + drift * 0.08;

    // ── height ──────────────────────────────────────────────────────────────
    // Tall stands in damp hollows, cropped on dry exposed ground.
    const stand = ring.height * (0.52 + moist * 0.85 + patch * 0.30
                                 - smoothstep(0.25, 0.85, slope) * 0.28);
    const clumpH = Math.max(0.16, stand * (0.82 + rng() * 0.36));
    const clumpBend = 0.08 + rng() * 0.24;
    const clumpYaw = rng() * TAU;
    const radius = ring.clumpRadius * (0.55 + rng() * 0.75);

    for (let b = 0; b < count; b++) {
      // Gaussian-ish falloff so a tuft is dense in the middle and frays out.
      const r = radius * (rng() * rng() * 0.6 + rng() * 0.4);
      const ang = rng() * TAU;
      const dx = Math.cos(ang) * r, dz = Math.sin(ang) * r;

      const i = n * STRIDE;
      const y = baseH + gx * dx + gz * dz;
      out[i    ] = cx + dx - ox;
      out[i + 1] = y;
      out[i + 2] = cz + dz - oz;

      // Trimodal: a cropped understorey closes the gaps at eye level, the main
      // stand carries the mass, and a few tall seed stalks break the flat top —
      // a meadow with a level haircut is the giveaway of procedural grass.
      const rh = rng();
      let hj, thin = 1;
      if (rh < 0.30)      hj = 0.28 + rng() * 0.32;
      else if (rh > 0.94) { hj = 1.45 + rng() * 0.80; thin = 0.62; }
      else                hj = 0.66 + rng() * 0.62;
      out[i + 3] = clumpH * hj;
      out[i + 4] = ring.width * thin * (0.70 + rng() * 0.66);
      out[i + 5] = clumpBend * (0.50 + rng() * 0.85);
      out[i + 6] = rng();                                   // wind phase

      // Blades in a tuft share a facing, splayed a little — that read of a
      // common lay is what stops a meadow looking like a pin cushion.
      out[i +  7] = clumpYaw + (rng() - 0.5) * 1.5;
      out[i +  8] = tone;
      out[i +  9] = dry;
      out[i + 10] = shade * (0.93 + rng() * 0.14);

      out[i + 11] = nX;
      out[i + 12] = nZ;
      out[i + 13] = rng();                                  // LOD fade rank

      const top = y + clumpH * hj;
      if (y < minY) minY = y;
      if (top > maxY) maxY = top;
      n++;
    }
  }

  if (n === 0) { bounds.minY = 0; bounds.maxY = 0; return 0; }
  bounds.minY = minY;
  bounds.maxY = maxY;
  return n;
}

/**
 * A coarse raster of the dirt tracks so grass can part for the road without
 * testing every blade against every polyline.
 */
export class RoadMask {
  constructor(world, cell = 4) {
    this.cell = cell;
    this.half = world.half;
    this.res = Math.ceil((world.half * 2) / cell) + 1;
    this.data = new Uint8Array(this.res * this.res);
    this._rasterise(world.roads ?? []);
  }

  _rasterise(roads) {
    const { cell, res, data, half } = this;
    const rad = 3.6;                       // metres of bare wheel track
    const rc = Math.ceil(rad / cell);
    for (const line of roads) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t, pz = a.z + dz * t;
          const gi = Math.round((px + half) / cell);
          const gj = Math.round((pz + half) / cell);
          for (let j = -rc; j <= rc; j++) {
            for (let k = -rc; k <= rc; k++) {
              const ii = gi + k, jj = gj + j;
              if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
              const d = Math.hypot(k * cell, j * cell);
              const v = Math.round(255 * (1 - smoothstep(rad * 0.35, rad, d)));
              const o = jj * res + ii;
              if (v > data[o]) data[o] = v;
            }
          }
        }
      }
    }
  }

  sample(x, z) {
    const gi = Math.round((x + this.half) / this.cell);
    const gj = Math.round((z + this.half) / this.cell);
    if (gi < 0 || gj < 0 || gi >= this.res || gj >= this.res) return 0;
    return this.data[gj * this.res + gi] / 255;
  }
}

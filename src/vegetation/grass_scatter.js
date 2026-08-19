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
 * Fill (or continue filling) one tile.
 *
 * Resumable: a 19 000-blade tile costs several milliseconds, and building one
 * atomically put a ~5 ms spike in the frame every time the camera crossed a
 * tile boundary at speed. `st.deadline` stops the loop mid-tile and `st.a` /
 * `st.n` carry the position over to the next frame.
 *
 * Resuming is only possible because each clump owns an independent RNG stream
 * keyed off (tile, clump index) rather than drawing from one sequential stream
 * for the whole tile — which also means a tile is bit-identical no matter how
 * many pieces it was built in.
 *
 * @param {{a:number,n:number,minY:number,maxY:number,weights:object,deadline:number}} st
 * @returns {boolean} true when the tile is complete
 */
export function fillTile(world, roads, ring, ox, oz, seed, out, st) {
  const S = ring.tileSize;
  const max = ring.maxBlades;
  const tileKey = (hash2i(Math.round(ox / S), Math.round(oz / S), seed ^ ring.salt) * 4294967296) >>> 0;
  const noise = world.noise;
  const w = st.weights;

  let n = st.n;
  let minY = st.minY, maxY = st.maxY;

  const attempts = ring.clumpAttempts;
  let a = st.a;
  for (; a < attempts && n < max; a++) {
    // Deadline checked in blocks: performance.now() every clump would itself
    // be a measurable share of the build.
    if ((a & 31) === 0 && a > st.a && performance.now() > st.deadline) break;

    const rng = mulberry32((hash2i(a, ring.salt, tileKey) * 4294967296) >>> 0);
    const cx = ox + (rng() - 0.5) * S;
    const cz = oz + (rng() - 0.5) * S;

    // ── hard rejects ────────────────────────────────────────────────────────
    if (world.getWaterDepth(cx, cz) > 0.02) continue;

    // getWaterDepth is a heightfield test and reads 0 in stretches of channel
    // that Water.js still surfaces (measured: getRiver 0.33 with depth 0.0 on
    // the river anchor). Trusting depth alone left blades standing in the
    // stream, so the channel mask is a hard reject in its own right.
    const river = world.getRiver(cx, cz);
    if (river > 0.42) continue;

    const slope = world.getSlope(cx, cz);
    if (slope > 1.15) continue;

    world.getSurfaceWeights(cx, cz, w);
    // Grass and dry straw both grow blades; rock, snow and sand do not.
    let d = clamp01(w.grass + w.dry * 0.8);
    d *= 1 - smoothstep(0.22, 0.62, w.rock);
    d *= 1 - w.snow;
    if (d < 0.02) continue;

    const moist = world.getMoisture(cx, cz);

    // ── shoreline ─────────────────────────────────────────────────────────
    // The clump centre being dry is not enough: a far-ring tuft frays out over
    // four metres, and on a lake shore — where the river mask is 0 and only
    // depth can tell you there is water — that put blades standing in open
    // water. Probe the spill radius, and when it reaches water, pull the tuft
    // in and test every blade individually. The per-blade water lookup is
    // affordable precisely because only shoreline clumps ever pay for it.
    const spill = ring.clumpRadius * 1.35;
    const sd = spill * 0.72;
    const nearWater =
      world.getWaterDepth(cx + spill, cz) > 0.02 || world.getWaterDepth(cx - spill, cz) > 0.02 ||
      world.getWaterDepth(cx, cz + spill) > 0.02 || world.getWaterDepth(cx, cz - spill) > 0.02 ||
      world.getWaterDepth(cx + sd, cz + sd) > 0.02 || world.getWaterDepth(cx - sd, cz + sd) > 0.02 ||
      world.getWaterDepth(cx + sd, cz - sd) > 0.02 || world.getWaterDepth(cx - sd, cz - sd) > 0.02;


    // Thin out on gravel bars, and on anything steep enough to be scree.
    d *= 1 - smoothstep(0.05, 0.40, river) * 0.95;
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
    // A separate ~50 m field for *height* alone. Driving density and height off
    // the same noise makes thin patches short and thick patches tall, which is
    // one relationship and reads as one texture; the reference meadow has
    // cropped ground under a full stand and tall stands over thin ground.
    const stature = noise.fbm(cx * 0.021 + 91.7, cz * 0.021 + 13.3, 2, 2.0, 0.5, 1);
    const lay = drift * 0.55 + patch * 0.75;
    // Never all the way to zero: a hole in the field shows raw terrain, and a
    // black hole in the near ground is far uglier than a thin patch. The floor
    // rises for the near ring, where a thin drift is read as a bald spot and
    // whatever is underneath it is close enough to be legible.
    const floor = ring.floor ?? 0.34;
    d *= floor + (1 - floor) * smoothstep(-0.45, 0.28, lay);
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
    // Olive is an accent: it needs damp ground or a riverbank to win, but the
    // patch octave lets a few drifts inside a dry meadow go green so the field
    // is not one flat hue from horizon to horizon.
    let tone = clamp01(moist * 1.70 - 0.62 + river * 0.90 + patch * 0.30);
    if (nearWater) tone = clamp01(tone + 0.35);
    const dry = clamp01((1 - moist) * 1.35 - 0.55 + smoothstep(0.18, 0.62, slope) * 0.50
                        + drift * 0.22) * (1 - tone * 0.8);
    // Per-*clump* brightness reads as painterly drifts; per-*blade* brightness
    // reads as salt-and-pepper noise. Keep the spread on the clump and let the
    // blade vary only enough to break the tuft into strokes.
    const shade = 0.82 + rng() * 0.32 + drift * 0.14;

    // ── height ──────────────────────────────────────────────────────────────
    // Tall stands in damp hollows, cropped on dry exposed ground.
    // Scale note: the vehicle is ~2 m tall and the reference plates put meadow
    // grass at roughly knee height on a bear. An earlier tuning produced 1.3-1.5 m
    // typical and ~2 m at the waterline, which visually swallowed the camper.
    // Keep the *relative* structure (damp hollows tall, dry slopes cropped) and
    // narrow the spread so the field reads as ground cover, not as a wheat crop.
    const stand = ring.height * (0.62 + moist * 0.54 + stature * 0.44 + patch * 0.12
                                 - smoothstep(0.25, 0.85, slope) * 0.28);
    // Reeds at the waterline: taller than the meadow behind them, and greener.
    // Blades *at* the water sell a shoreline; blades standing in two metres of
    // it read as a bug, which is what the per-blade test below prevents.
    const clumpH = Math.max(0.12, stand * (0.84 + rng() * 0.32) * (nearWater ? 1.34 : 1.0));
    const clumpBend = 0.11 + rng() * 0.38;   // a tuft has a lay, not a haircut
    const clumpYaw = rng() * TAU;
    let radius = ring.clumpRadius * (0.55 + rng() * 0.75) * (1 - river * 0.75);
    if (nearWater) radius *= 0.55;

    for (let b = 0; b < count; b++) {
      // Gaussian-ish falloff so a tuft is dense in the middle and frays out.
      const r = radius * (rng() * rng() * 0.6 + rng() * 0.4);
      const ang = rng() * TAU;
      const dx = Math.cos(ang) * r, dz = Math.sin(ang) * r;

      // Shallows are a reed bed; anything deeper is a blade standing in a lake.
      if (nearWater && world.getWaterDepth(cx + dx, cz + dz) > 0.15) continue;

      const i = n * STRIDE;
      const y = baseH + gx * dx + gz * dz;
      out[i    ] = cx + dx - ox;
      out[i + 1] = y;
      out[i + 2] = cz + dz - oz;

      // Trimodal: a cropped understorey closes the gaps at eye level, the main
      // stand carries the mass, and a *few* tall seed stalks break the flat top.
      // At 6% the stalks stopped reading as an accent and started reading as
      // wires laid across the frame — they want to be rare.
      const rh = rng();
      let hj, thin = 1;
      if (rh < 0.38)       hj = 0.34 + rng() * 0.36;
      else if (rh > 0.978) { hj = 1.30 + rng() * 0.55; thin = 0.55; }
      else                 hj = 0.66 + rng() * 0.62;
      out[i + 3] = clumpH * hj;
      out[i + 4] = ring.width * thin * (0.70 + rng() * 0.66);
      out[i + 5] = clumpBend * (0.50 + rng() * 0.85);
      out[i + 6] = rng();                                   // wind phase

      // Blades in a tuft share a facing, splayed a little — that read of a
      // common lay is what stops a meadow looking like a pin cushion.
      out[i +  7] = clumpYaw + (rng() - 0.5) * 1.5;
      out[i +  8] = tone;
      out[i +  9] = dry;
      out[i + 10] = shade * (0.965 + rng() * 0.07);

      out[i + 11] = nX;
      out[i + 12] = nZ;
      out[i + 13] = rng();                                  // LOD fade rank

      const top = y + clumpH * hj;
      if (y < minY) minY = y;
      if (top > maxY) maxY = top;
      n++;
    }
  }

  st.a = a;
  st.n = n;
  st.minY = minY;
  st.maxY = maxY;
  return a >= attempts || n >= max;
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

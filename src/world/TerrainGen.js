// ─────────────────────────────────────────────────────────────────────────────
//  TerrainGen — offline world bake.
//
//  Pipeline:
//    1. Tectonic base       ridged multifractal + domain warp + continental mask
//    2. Hydraulic erosion   droplet sim carves real drainage networks
//    3. Depression filling  priority-flood -> lake basins
//    4. Flow accumulation   D8 over the filled surface -> river discharge
//    5. Channel carving     rivers cut banks proportional to discharge
//    6. Water surface       monotone downhill river/lake surface + waterfall tags
//    7. Climate             moisture from rivers/altitude -> biome weights
//
//  Runs inside a worker. Emits transferable Float32Arrays.
// ─────────────────────────────────────────────────────────────────────────────
import { NoiseField } from '../core/Noise.js';
import { clamp, clamp01, lerp, smoothstep, mulberry32 } from '../core/MathUtils.js';

// Low passes in the mountain rim, in radians of azimuth.
const GATES = [
  { dir: 0.62,  width: 0.40, depth: 1.00 },   // primary valley mouth
  { dir: -2.35, width: 0.26, depth: 0.72 },   // secondary side canyon
];

export class TerrainGen {
  constructor(opts = {}) {
    this.res = opts.res ?? 1536;
    this.worldSize = opts.worldSize ?? 3072;
    this.seed = opts.seed ?? 20261018;
    this.maxAltitude = opts.maxAltitude ?? 340;
    this.noise = new NoiseField(this.seed);
    this.rng = mulberry32(this.seed ^ 0x77aa33);
    this.onProgress = opts.onProgress ?? (() => {});
  }

  generate() {
    const R = this.res;
    const N = R * R;
    this.height = new Float32Array(N);
    this.hardness = new Float32Array(N);   // erosion resistance -> rock outcrops
    this.sediment = new Float32Array(N);

    this._tectonic();          this.onProgress(0.15, 'Raising mountains');
    this._erode(320000);       this.onProgress(0.52, 'Carving valleys');
    this._relax();             this.onProgress(0.58, 'Settling the bedrock');
    this._fillDepressions();   this.onProgress(0.66, 'Filling lake basins');
    this._flowAccumulation();  this.onProgress(0.76, 'Routing rivers');
    this._carveChannels();     this.onProgress(0.85, 'Cutting riverbeds');
    this._waterSurface();      this.onProgress(0.92, 'Pooling water');
    this._climate();           this.onProgress(0.98, 'Seeding biomes');

    return {
      res: R,
      worldSize: this.worldSize,
      height: this.height,
      water: this.water,
      riverMask: this.riverMask,
      flow: this.flow,
      moisture: this.moisture,
      hardness: this.hardness,
      sediment: this.sediment,
      slope: this.slope,
      waterfalls: this.waterfalls,
      lakes: this.lakes,
      riverPolylines: this.riverPolylines,
      minHeight: this.minHeight,
      maxHeight: this.maxHeight,
    };
  }

  // ── 1. Tectonic base ───────────────────────────────────────────────────────
  //  Composed in three deliberate scales so the world reads as *places*:
  //    continent  – where the massifs and the basin are          (~1.5 cycles)
  //    relief     – ridgelines and foothills, masked to massifs  (~6-50 cycles)
  //    surface    – rolling meadow undulation in the basin       (~10 cycles)
  //  Erosion then supplies the fine detail, so nothing here is high-frequency.
  _tectonic() {
    const R = this.res, h = this.height, hard = this.hardness;
    const n = this.noise;
    const inv = 1 / R;
    const A = this.maxAltitude;

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const u = (x * inv) * 2 - 1;
        const v = (y * inv) * 2 - 1;

        // Warp the *continent* field only — keeps landmasses organic without
        // shredding the fine scales.
        const [cwx, cwy] = n.warp(u, v, 0.30, 0.45, 2);

        // ── continent: which regions are highland vs basin ──────────────────
        let cont = n.fbm(cwx * 0.62, cwy * 0.62, 3, 2.1, 0.52, 1);   // -1..1
        cont += n.fbm(cwx * 1.35 + 17.2, cwy * 1.35 - 8.4, 2, 2.0, 0.5, 1) * 0.32;

        // Radial rim: the far field rises so the horizon is always mountains,
        // and the interior stays a drivable bowl.
        const r = Math.min(1.6, Math.hypot(u, v));
        let rim = smoothstep(0.46, 1.28, r);
        const bowl = 1 - smoothstep(0.10, 0.70, r);

        // ── drainage gates ─────────────────────────────────────────────────
        // A ring of mountains with no outlet is an endorheic basin: depression
        // filling then floods half the map into one dead lake, and D8 routing
        // over the resulting flat produces dead-straight "rivers". Two low
        // passes in the rim give the water somewhere to go, so lakes stay small
        // and river courses follow real topography.
        const ang = Math.atan2(v, u);
        let gate = 0;
        for (const g of GATES) {
          let d = Math.abs(((ang - g.dir + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          gate = Math.max(gate, smoothstep(g.width, g.width * 0.25, d) * g.depth);
        }
        rim *= 1 - gate;

        // Regional tilt toward the primary gate keeps the whole basin draining.
        const tiltX = Math.cos(GATES[0].dir), tiltY = Math.sin(GATES[0].dir);
        const regionalTilt = (u * tiltX + v * tiltY) * -7.0;

        // Highland mask, 0 in the meadow basin, 1 in the high massifs.
        const massif = clamp01(smoothstep(-0.10, 0.52, cont) * 0.78 + rim * 0.72 - bowl * 0.30);

        // ── relief: ridged mountains, only where the mask allows ────────────
        const [rwx, rwy] = n.warp2(u * 1.9, v * 1.9, 0.17, 0.07, 0.42, 2);
        // Spectrum is deliberately steep: at 2 m per texel, an octave with a
        // 20 m wavelength and 10 m amplitude is indistinguishable from noise.
        // Erosion — not noise — is what supplies convincing fine detail.
        const ridge  = n.ridged(rwx * 1.00, rwy * 1.00, 5, 2.05, 0.40, 1.0, 1.25);
        const ridge2 = n.ridged(rwx * 2.55 + 5.1, rwy * 2.55 - 3.7, 3, 2.10, 0.40, 1.0, 1.6);
        const relief = ridge * 0.85 + ridge2 * 0.15;

        // ── foothills: broad shoulders that tie mountains into the basin ────
        const foot = (n.fbm(rwx * 1.25 + 41.0, rwy * 1.25 + 12.0, 3, 2.05, 0.42, 1) * 0.5 + 0.5);

        // ── basin: gentle drivable undulation, hills you can crest ──────────
        const roll  = n.fbm(u * 3.4 + 63.1, v * 3.4 - 22.8, 3, 2.1, 0.40, 1) * 0.5 + 0.5;
        const roll2 = n.billow(u * 7.0 - 11.4, v * 7.0 + 30.9, 2, 2.2, 0.38, 1) * 0.5 + 0.5;
        const basin = roll * 0.72 + roll2 * 0.28;

        // ── compose, in metres ─────────────────────────────────────────────
        const m2 = massif * massif;                        // sharpen the transition
        let elev =
          basin * 34.0 * (1 - m2 * 0.75) +                 // 0–34 m meadow relief
          foot  * 78.0 * smoothstep(0.05, 0.70, massif) +  // 0–78 m foothills
          relief * A * 0.92 * m2;                          // the big peaks

        // A dedicated low basin so there is somewhere for lakes and meadows.
        elev -= bowl * 9.0;
        elev += regionalTilt;
        // Cut the gorge floor down through the rim so the outlet actually flows.
        elev -= gate * smoothstep(0.55, 1.20, r) * 92.0;

        // Mesas / benches in a few regions — the reference art has flat shelves.
        const shelfSel = n.fbm(u * 1.15 - 7.1, v * 1.15 + 3.3, 3, 2, 0.5, 1) * 0.5 + 0.5;
        if (shelfSel > 0.60 && massif > 0.25) {
          const t = smoothstep(0.60, 0.84, shelfSel) * smoothstep(0.25, 0.55, massif);
          const stepH = 26.0;
          const q = elev / stepH;
          const terraced = (Math.floor(q) + smoothstep(0.36, 0.64, q - Math.floor(q))) * stepH;
          elev = lerp(elev, terraced, t * 0.62);
        }

        h[y * R + x] = elev + 4.0;   // a little ground below sea level for lakes

        // Hardness: banded bedrock. Drives erosion resistance, cliff formation,
        // the angle of repose in relaxation, and rock colour in the shader.
        const band = n.fbm(rwx * 2.7 + 21.7, rwy * 2.7 - 13.9, 4, 2.35, 0.5, 1);
        const strata = Math.abs(n.n2(u * 0.9 + elev * 0.004, v * 0.9));
        hard[y * R + x] = clamp01(0.30 + band * 0.42 + strata * 0.30 + massif * 0.34);
      }
    }
  }

  // ── 2. Hydraulic erosion (droplet / particle based) ────────────────────────
  //  Operates on the NORMALISED heightfield (~0..1). Every constant below is
  //  tuned for that range; running it in metres makes the sim diverge.
  _erode(iterations) {
    const R = this.res, h = this.height, hard = this.hardness, sedMap = this.sediment;
    const rng = this.rng;

    // Constants are in METRES, scaled to this grid's 2 m texel pitch.
    const texel = this.worldSize / R;
    const maxLifetime = 56;
    const inertia = 0.06;
    const capacityFactor = 0.09;    // sediment carried per metre of descent
    const minSlope = 0.008 * texel; // metres of drop treated as the floor
    const depositSpeed = 0.26;
    const erodeSpeed = 0.28;
    const gravity = 0.55;           // speed^2 gain per metre dropped
    const evaporate = 0.018;
    const radius = 3;
    const MAX_EDIT = 0.085;         // metres per droplet step — stability net
    const MAX_SPEED = 5.0;

    // Soft-disc erosion brush so channels do not alias into the grid.
    const brushDX = [], brushDY = [], brushW = [];
    let wsum = 0;
    for (let by = -radius; by <= radius; by++) {
      for (let bx = -radius; bx <= radius; bx++) {
        const d2 = bx * bx + by * by;
        if (d2 > radius * radius) continue;
        const w = 1 - Math.sqrt(d2) / radius;
        brushDX.push(bx); brushDY.push(by); brushW.push(w);
        wsum += w;
      }
    }
    for (let i = 0; i < brushW.length; i++) brushW[i] /= wsum;
    const brushLen = brushW.length;

    // Bilinear height + gradient at a fractional cell.
    let gx = 0, gy = 0, gh = 0;
    const sampleGrad = (px, py) => {
      const x = px | 0, y = py | 0;
      const fx = px - x, fy = py - y;
      const i = y * R + x;
      const nw = h[i], ne = h[i + 1], sw = h[i + R], se = h[i + R + 1];
      gx = (ne - nw) * (1 - fy) + (se - sw) * fy;
      gy = (sw - nw) * (1 - fx) + (se - ne) * fx;
      gh = nw * (1 - fx) * (1 - fy) + ne * fx * (1 - fy) + sw * (1 - fx) * fy + se * fx * fy;
    };

    const lo = radius + 2, hi = R - radius - 3;

    for (let iter = 0; iter < iterations; iter++) {
      let px = lo + rng() * (hi - lo);
      let py = lo + rng() * (hi - lo);
      let dx = 0, dy = 0;
      let speed = 1, water = 1, sediment = 0;

      for (let life = 0; life < maxLifetime; life++) {
        const nx = px | 0, ny = py | 0;
        const cellFx = px - nx, cellFy = py - ny;
        const cellIdx = ny * R + nx;

        sampleGrad(px, py);
        const oldH = gh;

        dx = dx * inertia - gx * (1 - inertia);
        dy = dy * inertia - gy * (1 - inertia);
        const len = Math.hypot(dx, dy);
        if (len < 1e-7) {
          const a = rng() * Math.PI * 2;
          dx = Math.cos(a); dy = Math.sin(a);
        } else { dx /= len; dy /= len; }

        px += dx; py += dy;
        if (px < lo || px > hi || py < lo || py > hi) break;

        sampleGrad(px, py);
        const dh = gh - oldH;

        const capacity = Math.max(-dh, minSlope) * speed * water * capacityFactor;

        if (dh > 0 || sediment > capacity) {
          // Deposit into the cell we just left (never the one we moved into).
          let amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositSpeed;
          amount = Math.min(amount, MAX_EDIT);
          if (amount > 0) {
            sediment -= amount;
            // Deposit through the same soft disc used for erosion. Point
            // deposits against brush erosion is what grows single-cell spires.
            for (let b = 0; b < brushLen; b++) {
              const bi = (ny + brushDY[b]) * R + (nx + brushDX[b]);
              h[bi] += amount * brushW[b];
            }
            sedMap[cellIdx] = Math.min(1, sedMap[cellIdx] + amount * 2.4);
          }
          void cellFx; void cellFy;
        } else {
          // Erode, resisted by the local bedrock hardness.
          let amount = Math.min((capacity - sediment) * erodeSpeed, -dh);
          amount = Math.min(amount, MAX_EDIT);
          if (amount > 0) {
            for (let b = 0; b < brushLen; b++) {
              const bx = nx + brushDX[b], by = ny + brushDY[b];
              const bi = by * R + bx;
              const resist = 0.5 + hard[bi] * 1.1;
              const want = (amount * brushW[b]) / resist;
              const take = h[bi] > want ? want : Math.max(0, h[bi]);
              h[bi] -= take;
              sediment += take;
            }
          }
        }

        speed = Math.min(MAX_SPEED, Math.sqrt(Math.max(0, speed * speed - dh * gravity)));
        if (!isFinite(speed)) break;
        water *= 1 - evaporate;
        if (water < 0.01) break;
      }

      if ((iter & 32767) === 0) this.onProgress(0.15 + 0.37 * (iter / iterations), 'Carving valleys');
    }
  }

  /**
   * Slope-limited relaxation. Droplet erosion occasionally leaves single-cell
   * spires; this walks the field and shaves anything steeper than the angle of
   * repose for the local rock, then applies one light smoothing pass. Cheap,
   * and it is the difference between "mountains" and "a bed of nails".
   */
  _relax() {
    const R = this.res, h = this.height, hard = this.hardness;
    const texel = this.worldSize / R;
    const N = R * R;

    // Angle of repose: soft ground ~34°, hard rock up to ~72°.
    const talus = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const deg = 34 + hard[i] * 38;
      talus[i] = Math.tan((deg * Math.PI) / 180) * texel;
    }

    const D = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
    const DL = D.map(([a, b]) => Math.hypot(a, b));

    for (let pass = 0; pass < 6; pass++) {
      for (let y = 1; y < R - 1; y++) {
        for (let x = 1; x < R - 1; x++) {
          const i = y * R + x;
          const hi = h[i];
          const t = talus[i];
          for (let k = 0; k < 8; k++) {
            const ni = i + D[k][1] * R + D[k][0];
            const diff = hi - h[ni];
            const lim = t * DL[k];
            if (diff > lim) {
              const move = (diff - lim) * 0.36;
              h[i] -= move;
              h[ni] += move;
            }
          }
        }
      }
    }

    // Curvature-selective smoothing: only texels that stick out from their own
    // neighbourhood get pulled in. Ridgelines have low local curvature relative
    // to their run, so they survive intact while single-texel fizz is erased.
    for (let pass = 0; pass < 2; pass++) {
      const tmp = new Float32Array(h);
      for (let y = 1; y < R - 1; y++) {
        for (let x = 1; x < R - 1; x++) {
          const i = y * R + x;
          const mean = (tmp[i - 1] + tmp[i + 1] + tmp[i - R] + tmp[i + R]) * 0.175
                     + (tmp[i - R - 1] + tmp[i - R + 1] + tmp[i + R - 1] + tmp[i + R + 1]) * 0.075;
          const dev = tmp[i] - mean;
          // Blend proportionally to how far this texel deviates: 0 for smooth
          // ground, up to 0.85 for a spike.
          const w = Math.min(0.85, Math.abs(dev) / (texel * 1.6));
          h[i] = tmp[i] - dev * w;
        }
      }
    }
  }

  // ── 3. Priority-flood depression filling -> lakes ──────────────────────────
  _fillDepressions() {
    const R = this.res, h = this.height;
    const N = R * R;
    const filled = new Float32Array(h);
    const closed = new Uint8Array(N);
    const heap = new MinHeap(N >> 2);

    // Seed with the border
    for (let x = 0; x < R; x++) {
      for (const y of [0, R - 1]) {
        const i = y * R + x;
        closed[i] = 1; heap.push(filled[i], i);
      }
    }
    for (let y = 1; y < R - 1; y++) {
      for (const x of [0, R - 1]) {
        const i = y * R + x;
        closed[i] = 1; heap.push(filled[i], i);
      }
    }

    const EPS = 0.0008;
    while (heap.size > 0) {
      const { key: hv, val: i } = heap.pop();
      const y = (i / R) | 0, x = i - y * R;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
          const ni = ny * R + nx;
          if (closed[ni]) continue;
          closed[ni] = 1;
          if (filled[ni] <= hv) filled[ni] = hv + EPS;
          heap.push(filled[ni], ni);
        }
      }
    }

    this.filled = filled;
    // Lake depth = how much we had to raise the surface.
    this.lakeDepth = new Float32Array(N);
    let lakeCells = 0;
    for (let i = 0; i < N; i++) {
      const d = filled[i] - h[i];
      if (d > 0.12) { this.lakeDepth[i] = d; lakeCells++; }
    }
    this.lakes = { cellCount: lakeCells };
  }

  // ── 4. D8 flow accumulation ────────────────────────────────────────────────
  _flowAccumulation() {
    const R = this.res, N = R * R;
    const src = this.filled;
    const flow = new Float32Array(N).fill(1);
    const dir = new Int32Array(N).fill(-1);

    const D = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    const DL = D.map(([a,b]) => 1 / Math.hypot(a,b));

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const i = y * R + x;
        let best = 0, bestI = -1;
        for (let k = 0; k < 8; k++) {
          const nx = x + D[k][0], ny = y + D[k][1];
          if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
          const ni = ny * R + nx;
          const drop = (src[i] - src[ni]) * DL[k];
          if (drop > best) { best = drop; bestI = ni; }
        }
        dir[i] = bestI;
      }
    }

    // Process cells from highest to lowest so upstream flow is complete first.
    const order = new Uint32Array(N);
    for (let i = 0; i < N; i++) order[i] = i;
    const keys = src;
    // Radix-ish sort by height using a typed sort on indices
    const idx = Array.from(order);
    idx.sort((a, b) => keys[b] - keys[a]);

    for (let n = 0; n < N; n++) {
      const i = idx[n];
      const d = dir[i];
      if (d >= 0) flow[d] += flow[i];
    }

    this.flow = flow;
    this.flowDir = dir;

    // Normalise into a discharge measure and build the river mask.
    const riverMask = new Float32Array(N);
    const RIVER_MIN = 900;      // cells of upstream drainage to be a stream
    for (let i = 0; i < N; i++) {
      // A lake has no channel. Routing D8 across the flat filled surface of a
      // lake yields dead-straight "rivers"; masking them out is both correct
      // and the thing that stops the map looking like a circuit board.
      if (this.lakeDepth[i] > 0.6) continue;
      const f = flow[i];
      if (f > RIVER_MIN) {
        riverMask[i] = clamp01(Math.log(f / RIVER_MIN) / Math.log(220));
      }
    }
    this.riverMask = riverMask;
  }

  // ── 5. Carve channels proportional to discharge ────────────────────────────
  _carveChannels() {
    const R = this.res, N = R * R, h = this.height, rm = this.riverMask;
    const carve = new Float32Array(N);

    // Splat a widening channel around every river cell.
    for (let y = 1; y < R - 1; y++) {
      for (let x = 1; x < R - 1; x++) {
        const i = y * R + x;
        const m = rm[i];
        if (m <= 0) continue;
        const width = 1.0 + m * 7.5;               // texels
        const depth = 0.8 + m * m * 6.0;           // metres
        const w = Math.ceil(width);
        for (let dy = -w; dy <= w; dy++) {
          for (let dx = -w; dx <= w; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
            const d = Math.hypot(dx, dy) / width;
            if (d > 1) continue;
            const prof = Math.cos(d * Math.PI * 0.5);      // U-shaped bed
            const amt = depth * prof * prof;
            const ni = ny * R + nx;
            if (amt > carve[ni]) carve[ni] = amt;
          }
        }
      }
    }

    for (let i = 0; i < N; i++) h[i] -= carve[i];
    this.carve = carve;

    // Recompute slope after carving — used everywhere downstream.
    const slope = new Float32Array(N);
    const texel = this.worldSize / R;
    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const i = y * R + x;
        const xm = y * R + Math.max(0, x - 1), xp = y * R + Math.min(R - 1, x + 1);
        const ym = Math.max(0, y - 1) * R + x, yp = Math.min(R - 1, y + 1) * R + x;
        const gx = (h[xp] - h[xm]) / (2 * texel);
        const gy = (h[yp] - h[ym]) / (2 * texel);
        slope[i] = Math.sqrt(gx * gx + gy * gy);
        if (h[i] < mn) mn = h[i];
        if (h[i] > mx) mx = h[i];
      }
    }
    this.slope = slope;
    this.minHeight = mn;
    this.maxHeight = mx;
  }

  // ── 6. Water surface & waterfall detection ─────────────────────────────────
  _waterSurface() {
    const R = this.res, N = R * R, h = this.height, rm = this.riverMask;
    const water = new Float32Array(N).fill(-9999);
    const waterfalls = [];
    const texel = this.worldSize / R;

    // River surface sits just above the carved bed.
    for (let i = 0; i < N; i++) {
      if (rm[i] > 0) water[i] = h[i] + 0.22 + rm[i] * 0.9;
      if (this.lakeDepth[i] > 0.12) {
        water[i] = Math.max(water[i], this.filled[i] + 0.05);
      }
    }

    // Enforce monotone-downhill along flow direction, so water never runs uphill.
    const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => this.filled[b] - this.filled[a]);
    for (const i of idx) {
      if (water[i] < -9000) continue;
      const d = this.flowDir[i];
      if (d < 0 || water[d] < -9000) continue;
      if (water[d] > water[i]) water[d] = water[i] - 0.002;
    }

    // Waterfalls: river cells with a large drop over a short run.
    for (let y = 2; y < R - 2; y++) {
      for (let x = 2; x < R - 2; x++) {
        const i = y * R + x;
        if (rm[i] < 0.20) continue;
        const d = this.flowDir[i];
        if (d < 0) continue;
        const drop = h[i] - h[d];
        if (drop > 2.4) {
          // Follow downstream to measure the total fall.
          let cur = d, total = drop, steps = 0;
          while (steps < 24) {
            const nd = this.flowDir[cur];
            if (nd < 0) break;
            const dd = h[cur] - h[nd];
            if (dd < 0.9) break;
            total += dd; cur = nd; steps++;
          }
          if (total > 5.0) {
            const ey = (cur / R) | 0, ex = cur - ey * R;
            waterfalls.push({
              top: [(x / R) * this.worldSize - this.worldSize / 2, water[i], (y / R) * this.worldSize - this.worldSize / 2],
              bottom: [(ex / R) * this.worldSize - this.worldSize / 2, water[cur], (ey / R) * this.worldSize - this.worldSize / 2],
              height: total,
              discharge: rm[i],
              width: 1.5 + rm[i] * 9,
            });
          }
        }
      }
    }

    // Deduplicate waterfalls that sit on top of each other.
    waterfalls.sort((a, b) => b.height - a.height);
    const kept = [];
    for (const wf of waterfalls) {
      let dup = false;
      for (const k of kept) {
        const dx = k.top[0] - wf.top[0], dz = k.top[2] - wf.top[2];
        if (dx * dx + dz * dz < 40 * 40) { dup = true; break; }
      }
      if (!dup) kept.push(wf);
      if (kept.length >= 28) break;
    }

    this.water = water;
    this.waterfalls = kept;
    this.riverPolylines = this._traceRivers();
    void texel;
  }

  // Trace the main river trunks as polylines for ribbon meshes & audio emitters.
  _traceRivers() {
    const R = this.res, rm = this.riverMask, flow = this.flow;
    const visited = new Uint8Array(R * R);
    const lines = [];
    const heads = [];

    for (let y = 2; y < R - 2; y += 2) {
      for (let x = 2; x < R - 2; x += 2) {
        const i = y * R + x;
        if (rm[i] < 0.10) continue;
        // A head is a river cell with no significant river neighbour uphill.
        let isHead = true;
        for (let dy = -1; dy <= 1 && isHead; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const ni = (y + dy) * R + (x + dx);
            if (rm[ni] > 0.08 && this.flowDir[ni] === i) { isHead = false; break; }
          }
        if (isHead) heads.push({ i, f: flow[i] });
      }
    }
    heads.sort((a, b) => b.f - a.f);

    for (const head of heads.slice(0, 220)) {
      let cur = head.i;
      const pts = [];
      let steps = 0;
      while (cur >= 0 && steps < 6000) {
        if (visited[cur] && steps > 3) break;
        visited[cur] = 1;
        const cy = (cur / R) | 0, cx = cur - cy * R;
        pts.push({
          x: (cx / R) * this.worldSize - this.worldSize / 2,
          y: this.water[cur] > -9000 ? this.water[cur] : this.height[cur],
          z: (cy / R) * this.worldSize - this.worldSize / 2,
          w: 1.2 + rm[cur] * 11,
          flow: rm[cur],
        });
        cur = this.flowDir[cur];
        steps++;
      }
      if (pts.length > 12) lines.push(pts);
    }
    return lines;
  }

  // ── 7. Climate / moisture / biome weights ──────────────────────────────────
  _climate() {
    const R = this.res, N = R * R, h = this.height;
    const moisture = new Float32Array(N);
    const n = this.noise;

    // Distance-to-water via a cheap multi-pass jump flood on the river mask.
    const dist = new Float32Array(N).fill(1e9);
    for (let i = 0; i < N; i++) if (this.water[i] > -9000) dist[i] = 0;
    for (let pass = 0; pass < 6; pass++) {
      for (let y = 1; y < R; y++) for (let x = 1; x < R; x++) {
        const i = y * R + x;
        const a = dist[i - 1] + 1, b = dist[i - R] + 1, c = dist[i - R - 1] + 1.4142;
        dist[i] = Math.min(dist[i], a, b, c);
      }
      for (let y = R - 2; y >= 0; y--) for (let x = R - 2; x >= 0; x--) {
        const i = y * R + x;
        const a = dist[i + 1] + 1, b = dist[i + R] + 1, c = dist[i + R + 1] + 1.4142;
        dist[i] = Math.min(dist[i], a, b, c);
      }
    }

    const texel = this.worldSize / R;
    for (let i = 0; i < N; i++) {
      const y = (i / R) | 0, x = i - y * R;
      const u = (x / R) * 2 - 1, v = (y / R) * 2 - 1;
      const nearWater = 1 - clamp01((dist[i] * texel) / 90);
      const alt = clamp01(h[i] / this.maxAltitude);
      const regional = n.fbm(u * 2.2 + 31.4, v * 2.2 - 17.8, 4, 2.1, 0.5, 1) * 0.5 + 0.5;
      moisture[i] = clamp01(nearWater * 0.55 + regional * 0.45 - alt * 0.35);
    }
    this.moisture = moisture;
    this.distToWater = dist;
  }
}

// Compact binary min-heap over (float key, int value).
class MinHeap {
  constructor(cap = 1024) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.size = 0;
  }
  _grow() {
    const k = new Float64Array(this.keys.length * 2);
    const v = new Int32Array(this.vals.length * 2);
    k.set(this.keys); v.set(this.vals);
    this.keys = k; this.vals = v;
  }
  push(key, val) {
    if (this.size === this.keys.length) this._grow();
    let i = this.size++;
    this.keys[i] = key; this.vals[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const key = this.keys[0], val = this.vals[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.vals[0] = this.vals[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(i, m); i = m;
      }
    }
    return { key, val };
  }
  _swap(a, b) {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
  }
}

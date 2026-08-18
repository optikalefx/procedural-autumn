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
    this._erode(Math.round(R * R * 0.22));  this.onProgress(0.52, 'Carving valleys');
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
  //  Composed in four deliberate scales so the world reads as *places*:
  //    continent  – where the massifs and the basin are          (~1.5 cycles)
  //    relief     – ridgelines and foothills, masked to massifs  (~6-50 cycles)
  //    surface    – rolling meadow undulation in the basin       (~10 cycles)
  //    grain      – 40-120 m swells and swales you drive over    (~25-40 cycles)
  //  Erosion then supplies everything finer, so nothing here is high-frequency.
  //
  //  It also lays down the *rock record*: a regional competence field plus a
  //  bedded stratigraphy (dipping layers of alternating hardness). Those beds
  //  are what later stages turn into cliffs, benches and talus fans — the
  //  single biggest difference between "a noise field" and "a mountain".
  _tectonic() {
    const R = this.res, h = this.height, hard = this.hardness;
    const n = this.noise;
    const inv = 1 / R;
    const A = this.maxAltitude;
    const N = R * R;

    // Stratigraphy, kept as its own arrays because later stages must re-sample
    // the bed at the *current* surface height, not the original one.
    this.bedK = new Float32Array(N);       // radians of bed phase per metre
    this.bedPhase = new Float32Array(N);   // dip / offset of the bedding plane
    this.strataW = new Float32Array(N);    // how strongly this region is bedded

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
        // Squared once here (rather than at use) so the basin/mountain
        // transition is a definite edge instead of a long mushy ramp.
        const massifRaw = clamp01(smoothstep(-0.10, 0.52, cont) * 0.78 + rim * 0.72 - bowl * 0.30);
        const massif = smoothstep(0.13, 0.78, massifRaw);

        // ── massif character ───────────────────────────────────────────────
        // Two very low frequency selectors give each range one personality for
        // its whole length. Without this every mountain is the average of all
        // mountains, which is exactly what "blobby" means.
        //   alpine  – jagged, high-relief, steep repose, weakly bedded
        //   mesa    – terraced benches, strongly bedded, flat tops
        //   rounded – grassy domes, shallow repose, almost unbedded
        const cs1 = n.fbm(u * 1.05 + 90.3, v * 1.05 - 51.7, 2, 2.0, 0.5, 1);
        const cs2 = n.fbm(u * 0.85 - 14.6, v * 0.85 + 77.2, 2, 2.0, 0.5, 1);
        const wAlpine = smoothstep(0.00, 0.30, cs1);
        const wMesa   = smoothstep(0.04, 0.34, cs2) * (1 - wAlpine);
        const wRound  = clamp01(1 - wAlpine - wMesa);

        // ── relief: ridged mountains, only where the mask allows ────────────
        const [rwx, rwy] = n.warp2(u * 1.9, v * 1.9, 0.17, 0.07, 0.42, 2);
        // Spectrum is deliberately steep: at 2 m per texel, an octave with a
        // 20 m wavelength and 10 m amplitude is indistinguishable from noise.
        // Erosion — not noise — is what supplies convincing fine detail.
        const ridge  = n.ridged(rwx * 1.00, rwy * 1.00, 5, 2.05, 0.40, 1.0, 1.0);
        const ridge2 = n.ridged(rwx * 2.55 + 5.1, rwy * 2.55 - 3.7, 3, 2.10, 0.40, 1.0, 1.4);
        const dome   = n.billow(rwx * 1.15 + 3.3, rwy * 1.15 - 7.9, 3, 2.1, 0.45, 1) * 0.5 + 0.5;
        // Same ridge field, three different transfer curves. Raising a 0..1
        // ridge to a power >1 narrows the crests (alpine); <1 fattens the
        // shoulders and flattens the summits (mesa / rounded).
        //
        // Both curves are renormalised to the same mean (E[x^p] = 1/(p+1) for
        // x on 0..1) before blending. Without that the archetypes sit at
        // different average elevations and the character boundary shows up as
        // a 100 m smear across the map — a seam, not a mountain.
        const ridgeSharp = Math.pow(ridge, 1.55) * 2.55 * 0.5;
        const ridgeFat   = Math.pow(ridge, 0.70) * 1.70 * 0.5;
        const relief =
          (ridgeSharp * 0.86 + ridge2 * 1.4 * 0.14) * wAlpine +
          (ridgeFat * 0.80 + dome * 0.20)           * wMesa +
          (ridgeFat * 0.52 + dome * 0.48)           * wRound;

        // ── foothills: broad shoulders that tie mountains into the basin ────
        const foot = (n.fbm(rwx * 1.25 + 41.0, rwy * 1.25 + 12.0, 3, 2.05, 0.42, 1) * 0.5 + 0.5);

        // ── basin: gentle drivable undulation, hills you can crest ──────────
        const roll  = n.fbm(u * 3.4 + 63.1, v * 3.4 - 22.8, 3, 2.1, 0.40, 1) * 0.5 + 0.5;
        const roll2 = n.billow(u * 7.0 - 11.4, v * 7.0 + 30.9, 2, 2.2, 0.38, 1) * 0.5 + 0.5;
        const basin = roll * 0.72 + roll2 * 0.28;

        // ── grain: the scale the driver actually reads ──────────────────────
        // Everything above has a wavelength of 400 m or more, which at 40 m
        // from the bonnet is a dead flat plane. These two octaves put swells,
        // shallow bowls and low ribs at 40-120 m, still gentle enough to drive.
        const grainA = n.fbm(u * 24.0 + 5.5, v * 24.0 - 18.2, 3, 2.15, 0.45, 1);
        const grainB = n.ridged(u * 41.0 - 33.1, v * 41.0 + 9.4, 2, 2.2, 0.45, 1, 1.1);
        const grain = grainA * 4.6 + (grainB - 0.42) * 3.1;

        // ── compose, in metres ─────────────────────────────────────────────
        const m2 = massif * massif;                        // sharpen the transition
        let elev =
          basin * 34.0 * (1 - m2 * 0.75) +                 // 0–34 m meadow relief
          foot  * 78.0 * smoothstep(0.05, 0.70, massif) +  // 0–78 m foothills
          relief * A * 0.94 * m2;                          // the big peaks

        // Grain everywhere, but taller on open ground than on cliff faces
        // (where erosion products, not noise, should be doing the work).
        elev += grain * (1.0 - m2 * 0.62);

        // A dedicated low basin so there is somewhere for lakes and meadows.
        elev -= bowl * 9.0;
        elev += regionalTilt;

        // Carve the outlet gorge to a *target floor* rather than subtracting a
        // fixed depth. Subtracting 90 m produced a trench that then had to be
        // clamped, and the clamp turned the whole gorge into a flat pan that
        // flooded — 9% of the map was dead water. A floor that falls gently
        // from +5 m to -10 m is all the basin needs to drain, and it reads as a
        // river mouth instead of an inland sea.
        const gTaper = gate * smoothstep(0.40, 0.70, r);
        if (gTaper > 0) {
          const gateFloor = 5.0 - smoothstep(0.48, 1.35, r) * 15.0;
          elev = lerp(elev, Math.min(elev, gateFloor - 4.0), gTaper);
        }

        // Mesas / benches — the reference art has flat shelves. Driven by the
        // character field now, so terracing lands on the mesa massifs instead
        // of being sprinkled at random.
        if (wMesa > 0.02 && massif > 0.14) {
          // Kept mild: differential weathering now cuts the real benches, and
          // stacking a second terracing operator on top reads as contour lines.
          const t = smoothstep(0.02, 0.45, wMesa) * smoothstep(0.14, 0.46, massif) * 0.42;
          const stepH = 34.0 + (n.fbm(u * 1.7, v * 1.7, 2, 2, 0.5, 1) * 0.5 + 0.5) * 26.0;
          const q = elev / stepH;
          const terraced = (Math.floor(q) + smoothstep(0.30, 0.70, q - Math.floor(q))) * stepH;
          elev = lerp(elev, terraced, t * 0.70);
        }

        // Backstop only — nothing should reach this now, but a runaway negative
        // would flood the map and it costs one compare.
        if (elev < -16) elev = -16 - Math.log1p(-16 - elev) * 1.5;

        const i = y * R + x;
        h[i] = elev + 4.0;   // a little ground below sea level for lakes

        // ── the rock record ────────────────────────────────────────────────
        // Regional competence: which parts of the range are made of tough rock.
        // Deliberately smooth — it selects *where* cliffs are possible.
        const band = n.fbm(rwx * 2.7 + 21.7, rwy * 2.7 - 13.9, 4, 2.35, 0.5, 1);
        hard[i] = clamp01(0.34 + band * 0.44 + massif * 0.30);

        // Bedding. Dipping, so an outcrop trace cuts diagonally across a
        // hillside rather than following an elevation contour exactly.
        //
        // THICKNESS IS THE WHOLE BALLGAME. A bed's outcrop width in map view is
        // its thickness divided by how steeply the ground falls across it, so on
        // the 45°+ faces where strata are visible at all, a 34 m bed paints a
        // 10-15 m rib — measured, not guessed. Dozens of 10 m ribs down a flank
        // is corduroy, and corduroy is what made the mountains read as a
        // topographic map. Beds of 90-190 m put three or four real ledges on a
        // massif instead, which is what the canyon reference plate actually
        // shows and roughly what a 340 m range should carry.
        const thickness = 92.0 + (n.fbm(u * 1.4 + 4.4, v * 1.4 - 9.1, 2, 2, 0.5, 1) * 0.5 + 0.5) * 98.0;
        const k = (Math.PI * 2) / thickness;
        this.bedK[i] = k;
        const dipDir = n.fbm(u * 0.80 - 60.2, v * 0.80 + 25.5, 2, 2.0, 0.5, 1) * Math.PI * 2;
        const dipMag = 0.26 + (n.fbm(u * 0.95 + 12.7, v * 0.95 - 4.1, 2, 2, 0.5, 1) * 0.5 + 0.5) * 0.34;
        // Metres of bed rise per metre travelled, resolved into world XZ.
        const wx = u * (this.worldSize * 0.5), wz = v * (this.worldSize * 0.5);
        const bedRise = (wx * Math.cos(dipDir) + wz * Math.sin(dipDir)) * dipMag;
        this.bedPhase[i] = -bedRise * k;
        // Mesas are the most obviously layered thing in the reference art;
        // alpine horns are jointed but not benched; grassy domes hide it all.
        // Weighted hard toward mesa country: in four of the five reference
        // plates the mountains carry no visible bedding whatsoever, and the one
        // that does is a canyon. Alpine and rounded flanks get their structure
        // from the drainage grain the erosion sim cuts, not from stratigraphy.
        this.strataW[i] = clamp01((wMesa * 1.00 + wAlpine * 0.26 + wRound * 0.10)
                                  * smoothstep(0.16, 0.48, massif));
      }
    }
  }

  /**
   * Hard-band fraction (0 soft rock, 1 hard rock) of the bed exposed at `hv`.
   *
   * Two details matter more than they look. The phase is frequency-modulated,
   * so bed thicknesses alternate instead of marching at a fixed pitch — a pure
   * sine gives every massif the same corduroy ripple. And the hard fraction is
   * biased so only about a third of the column is resistant: real cliff country
   * is a few prominent ledges in a lot of soft rock, not evenly striped.
   *
   * ALWAYS CALL THIS WITH A FROZEN REFERENCE HEIGHT (`this.bedRef`), never with
   * the live surface. Evaluating it against a surface that the same loop is
   * lowering closes a feedback loop — weather a cell, it drops into the next
   * bed, weather it again — and that runaway is what covered every flank in
   * fine evenly-spaced ripples far thinner than any bed. Freezing the reference
   * at the post-erosion surface keeps one bed per cell for the whole
   * relaxation, which is what turns dozens of ripples into a few real ledges.
   */
  _bedHard(i, hv) {
    const t = hv * this.bedK[i] + this.bedPhase[i];
    const b = 0.5 + 0.5 * Math.sin(t + 0.85 * Math.sin(t * 0.41 + 1.7));
    return smoothstep(0.50, 0.74, b);
  }

  // ── 2. Hydraulic erosion (droplet / particle based) ────────────────────────
  //  Operates on the NORMALISED heightfield (~0..1). Every constant below is
  //  tuned for that range; running it in metres makes the sim diverge.
  _erode(iterations) {
    const R = this.res, h = this.height, hard = this.hardness, sedMap = this.sediment;
    const rng = this.rng;

    // Constants are in METRES, scaled to this grid's texel pitch.
    //
    // These used to be set so conservatively that the whole stage was a no-op:
    // a droplet could shift ~1 mm per cell, so "eroded" and "tectonic" came out
    // within 0.5% of each other and every mountain was raw ridged noise wearing
    // an erosion label. Carrying capacity and the per-step edit clamp are the
    // two that matter; everything else follows from them.
    const texel = this.worldSize / R;
    const maxLifetime = 64;
    // Inertia is what stops every droplet cutting its own private groove
    // straight down the fall line. At near zero the sim combs a mountain into
    // dozens of identical parallel flutes that read as fabric, not rock; with
    // momentum the droplets wander, capture each other and merge into fewer,
    // larger valleys with interfluves between them.
    const inertia = 0.24;
    const capacityFactor = 0.50;    // sediment carried per metre of descent
    const minSlope = 0.010 * texel; // metres of drop treated as the floor
    const depositSpeed = 0.34;
    const erodeSpeed = 0.42;
    const gravity = 0.90;           // speed^2 gain per metre dropped
    const evaporate = 0.014;
    const radius = 3;               // brush width sets channel width
    const MAX_EDIT = 0.30;          // metres per droplet step — stability net
    const MAX_SPEED = 5.5;

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
            sedMap[cellIdx] += amount;     // raw metres; normalised at the end of _relax
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
   * Hillslope processes: differential weathering, then mass wasting.
   *
   * These are the two mechanisms that turn a noise field into rock. Erosion by
   * water carves *down*; weathering eats *sideways* into whatever is softest,
   * and gravity then limits how steep the result can stand. Alternating them is
   * what produces the cliff-and-bench profile the reference art is full of:
   * a soft bed retreats until the hard bed above it is undercut, the debris
   * runs out at the angle of repose, and you get a riser, a ledge, and a talus
   * fan at the bottom. Doing only the talus limiter (as this used to) can never
   * make a cliff — it can only ever make things gentler.
   */
  _relax() {
    const R = this.res, h = this.height, hard = this.hardness;
    const texel = this.worldSize / R;
    const N = R * R;

    // Which bed each cell exposes, frozen at the post-erosion surface — and
    // frozen against a *smoothed* copy of it. A bed is a geological plane tens
    // of metres thick; the metre-scale roughness the droplet sim leaves behind
    // has no business deciding which bed a cell is in. Sampling the raw surface
    // swings the bed phase by a radian between adjacent cells, so `bedHard`
    // came out as per-cell binary flicker rather than as bands, and weathering
    // then amplified that flicker into the fine corduroy ripple that made every
    // flank read as wood grain. Smoothing first is what turns it back into a
    // handful of broad ledges.
    this.bedRef = this._boxBlur(h, 16, 2);
    this.bedHard = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.bedHard[i] = this.strataW[i] > 0.02 ? this._bedHard(i, this.bedRef[i]) : 0.5;
    }

    // Weathering budget. Without a cap a cell keeps stepping down through bed
    // after bed and the whole range ends up ribbed like corduroy; in reality a
    // retreating face is armoured by its own debris after a few metres.
    this._weatherBudget = new Float32Array(N).fill(7.0);

    // Precompute the two repose limits per cell. Soft beds and grassy country
    // lie back at 28-42°; competent, well-bedded rock stands at up to ~82°.
    const talusLo = new Float32Array(N);
    const talusHi = new Float32Array(N);
    const DEG = Math.PI / 180;
    for (let i = 0; i < N; i++) {
      const sw = this.strataW[i];
      // The soft limit governs everything that is not a resistant bed, which
      // includes every gully wall the droplet sim just cut. At 42 deg it was
      // quietly back-filling all of them, which is why the mountains came out
      // smooth however hard the erosion ran. Competent rock holds much steeper.
      talusLo[i] = Math.tan((29 + hard[i] * 24) * DEG) * texel;
      talusHi[i] = Math.tan((48 + hard[i] * 22 + sw * 9) * DEG) * texel;
    }

    const D = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
    const DL = D.map(([a, b]) => Math.hypot(a, b));
    const DI = D.map(([a, b]) => b * R + a);

    // Weather/waste cycles. Each talus pass is also a low-pass filter, so
    // spending more of them buys stepped cliffs at the price of erasing the
    // drainage grain the droplet sim just cut. The under-relaxed talus below
    // moves roughly half as much per pass as the old over-relaxed one, so the
    // pass count is up to match — same total mass wasting, no ripple.
    for (let cycle = 0; cycle < 3; cycle++) {
      this._weather(1.55, DI, DL);
      this._talus(3, talusLo, talusHi, DI, DL);
      this.onProgress(0.52 + 0.02 * cycle, 'Settling the bedrock');
    }

    // Curvature-selective smoothing: only texels that stick out from their own
    // neighbourhood get pulled in. Ridgelines have low local curvature relative
    // to their run, so they survive intact while single-texel fizz is erased.
    // One pass only — two was quietly rounding off every cliff lip we just cut.
    {
      const tmp = new Float32Array(h);
      for (let y = 1; y < R - 1; y++) {
        for (let x = 1; x < R - 1; x++) {
          const i = y * R + x;
          const mean = (tmp[i - 1] + tmp[i + 1] + tmp[i - R] + tmp[i + R]) * 0.175
                     + (tmp[i - R - 1] + tmp[i - R + 1] + tmp[i + R - 1] + tmp[i + R + 1]) * 0.075;
          const dev = tmp[i] - mean;
          // Blend proportionally to how far this texel deviates: 0 for smooth
          // ground, up to the cap for a genuine single-texel spike. The ramp is
          // deliberately late and shallow — at the old settings a 4 m bump (a
          // cliff lip, a spur nose, exactly the relief a mountain needs) lost
          // half its height, which is a lot of what made the massifs read as
          // smooth. Only fizz finer than the grid should be removed here.
          const w = Math.min(0.40, Math.max(0.0, Math.abs(dev) / texel - 1.4) * 0.45);
          h[i] = tmp[i] - dev * w;
        }
      }
    }

    // Bake the *displayed* hardness: regional competence modulated by whichever
    // bed the final surface actually exposes. This is what paints the banding
    // on cliff faces, and it now agrees with the geometry instead of being an
    // independent noise field that happens to sit on top of it.
    for (let i = 0; i < N; i++) {
      const sw = this.strataW[i];
      this.hardness[i] = clamp01(hard[i] * (1 - sw * 0.55) + this.bedHard[i] * sw * 0.95);
    }

    // Sediment has accumulated as raw metres of debris. Squash it through
    // x/(x+k) rather than clamping the running total, because clamping is what
    // it used to do and a third of the map came out sitting at exactly 1.0 —
    // the shader could no longer tell a talus fan from a valley floor a single
    // droplet had once crossed, and it painted a fifth of the world scree grey.
    // A soft saturation keeps the ordering intact: a metre of debris reads
    // ~0.4, a real fan reads near 1, and ground that only ever saw a dusting
    // stays near 0.
    const K = 1.5;
    const sed = this.sediment;
    for (let i = 0; i < N; i++) {
      const s = sed[i];
      sed[i] = s > 0 ? s / (s + K) : 0;
    }
  }

  /** Separable box blur with a radius in metres. O(N) per pass, edge-clamped. */
  _boxBlur(src, radiusM, passes) {
    const R = this.res;
    const rad = Math.max(1, Math.round(radiusM / (this.worldSize / R)));
    const inv = 1 / (rad * 2 + 1);
    const cl = (v) => (v < 0 ? 0 : v >= R ? R - 1 : v);
    let a = Float32Array.from(src);
    const b = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < R; y++) {
        const row = y * R;
        let sum = 0;
        for (let k = -rad; k <= rad; k++) sum += a[row + cl(k)];
        for (let x = 0; x < R; x++) {
          b[row + x] = sum * inv;
          sum += a[row + cl(x + rad + 1)] - a[row + cl(x - rad)];
        }
      }
      for (let x = 0; x < R; x++) {
        let sum = 0;
        for (let k = -rad; k <= rad; k++) sum += b[cl(k) * R + x];
        for (let y = 0; y < R; y++) {
          a[y * R + x] = sum * inv;
          sum += b[cl(y + rad + 1) * R + x] - b[cl(y - rad) * R + x];
        }
      }
    }
    return a;
  }

  /**
   * Differential weathering. Soft beds retreat; hard beds hold. `rate` is the
   * maximum metres removed per pass from a fully soft, fully exposed cell.
   * The debris is handed to the steepest downhill neighbour, which is what
   * grows the talus fans (and marks them in the sediment map for the shader).
   */
  _weather(rate, DI, DL) {
    const R = this.res, h = this.height, hard = this.hardness, sed = this.sediment;
    const texel = this.worldSize / R;
    const sw = this.strataW;
    // Read the surface from a snapshot. Reading and writing the same buffer
    // lets a cell weather, receive its neighbour's debris, and weather again in
    // the same sweep — a standing wave that ripples every gentle slope.
    const src = this._weatherSrc || (this._weatherSrc = new Float32Array(h.length));
    src.set(h);

    for (let y = 1; y < R - 1; y++) {
      for (let x = 1; x < R - 1; x++) {
        const i = y * R + x;
        const w = sw[i];
        if (w < 0.06) continue;

        const bh = this.bedHard[i];
        // Exposure: a bed only retreats where it is already a face. Requiring a
        // real gradient (~14 deg) before anything happens is what keeps the
        // benching on cliffs instead of ribbing the meadow with contour lines.
        const gx = (src[i + 1] - src[i - 1]) / (2 * texel);
        const gy = (src[i + R] - src[i - R]) / (2 * texel);
        const expo = smoothstep(0.25, 0.85, Math.hypot(gx, gy));
        if (expo <= 0.001) continue;

        let amount = (1 - bh) * w * expo * rate * (1.2 - hard[i] * 0.55);
        const budget = this._weatherBudget[i];
        if (amount > budget) amount = budget;
        if (amount <= 0.0005) continue;
        this._weatherBudget[i] = budget - amount;

        h[i] -= amount;

        // Hand the debris downhill. Splitting it over the two steepest
        // neighbours keeps fans from turning into single-texel tongues.
        let b0 = -1, b1 = -1, d0 = 0, d1 = 0;
        for (let k = 0; k < 8; k++) {
          const ni = i + DI[k];
          const drop = (src[i] - src[ni]) / DL[k];
          if (drop > d0) { d1 = d0; b1 = b0; d0 = drop; b0 = ni; }
          else if (drop > d1) { d1 = drop; b1 = ni; }
        }
        if (b0 < 0) continue;
        const give = amount * 0.62;
        if (b1 >= 0 && d1 > 0) {
          const s = d0 + d1;
          h[b0] += give * (d0 / s); h[b1] += give * (d1 / s);
          sed[b0] += give * (d0 / s);
          sed[b1] += give * (d1 / s);
        } else {
          h[b0] += give;
          sed[b0] += give;
        }
      }
    }
  }

  /**
   * Angle-of-repose limiter, with the repose angle set by the exposed bed.
   *
   * JACOBI, AND MASS-CONSERVING. This used to be an in-place Gauss–Seidel sweep
   * that shed 28% of the excess to *each* of eight neighbours independently —
   * up to 2.24x the material actually needed. That is an over-relaxation, and
   * an over-relaxed diffusion oscillates: it was the single largest source of
   * the fine corduroy ripple that made every mountain flank read as wood grain
   * or as a topographic map. Alternating the sweep direction hid the scan-order
   * bias but could not fix the overshoot, because the overshoot is per-cell.
   *
   * The replacement accumulates into a delta buffer (so no cell can see a
   * neighbour that has already moved this pass, which is what made the result
   * depend on raster order at all), and each cell sheds a fixed fraction of the
   * *worst* single excess, split between the over-steep neighbours in
   * proportion to how over-steep each one is. Shedding less than the full
   * excess makes the iteration monotone — it can approach the repose angle but
   * never cross it — so the ripple has nowhere to come from.
   *
   * Being gentler per pass, it needs more passes for the same amount of mass
   * wasting; that is the trade and it is worth it.
   */
  _talus(passes, talusLo, talusHi, DI, DL) {
    const R = this.res, h = this.height, sw = this.strataW;
    const N = h.length;
    const delta = this._talusDelta || (this._talusDelta = new Float32Array(N));
    const ex = this._talusEx || (this._talusEx = new Float64Array(8));
    // Under-relaxation factor. Above ~0.5 the Jacobi update can overshoot when
    // a cell is shedding into a neighbour that is shedding back.
    const RELAX = 0.45;

    for (let pass = 0; pass < passes; pass++) {
      delta.fill(0);
      for (let y = 1; y < R - 1; y++) {
        for (let x = 1; x < R - 1; x++) {
          const i = y * R + x;
          const hi = h[i];
          const w = sw[i];
          // Unbedded ground just uses the soft limit. Note the bedded limit
          // comes from the *frozen* bed: a repose angle that oscillated with
          // the live surface height put every slumping cell into a limit cycle
          // — hold, slump, hold — which ripples a flank as surely as the
          // weathering feedback did.
          const t = w < 0.06 ? talusLo[i]
                             : lerp(talusLo[i], talusHi[i], this.bedHard[i] * w);

          let total = 0, worst = 0;
          for (let k = 0; k < 8; k++) {
            const e = hi - h[i + DI[k]] - t * DL[k];
            if (e > 0) { ex[k] = e; total += e; if (e > worst) worst = e; }
            else ex[k] = 0;
          }
          if (total <= 0) continue;

          const give = worst * RELAX;
          delta[i] -= give;
          const inv = give / total;
          for (let k = 0; k < 8; k++) {
            if (ex[k] > 0) delta[i + DI[k]] += ex[k] * inv;
          }
        }
      }
      for (let i = 0; i < N; i++) h[i] += delta[i];
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

    this._carveRills();

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

  /**
   * Hillslope rill network — the micro-relief the player actually reads.
   *
   * Everything above works at 100 m and up; at 2-40 m from the bonnet that is a
   * dead flat plane, which is why the ground used to look like a sand dune.
   * Every cell drains somewhere, and below the river threshold that drainage
   * still leaves a grain in the ground: gullies on slopes, swales and dry beds
   * on the flat. Unlike added noise this structure is topologically correct —
   * it converges downhill, it never crosses itself, and it lines up with the
   * rivers it eventually feeds.
   */
  _carveRills() {
    const R = this.res, N = R * R, h = this.height, flow = this.flow;
    const texel = this.worldSize / R;
    const rill = new Float32Array(N);

    const RILL_MIN = 30;     // upstream cells before a rill is worth cutting
    const RILL_MAX = 900;    // where the river carver takes over
    const invLog = 1 / Math.log(RILL_MAX / RILL_MIN);
    const hard = this.hardness;

    for (let y = 1; y < R - 1; y++) {
      for (let x = 1; x < R - 1; x++) {
        const i = y * R + x;
        const f = flow[i];
        if (f <= RILL_MIN) continue;
        let t = Math.log(f / RILL_MIN) * invLog;
        if (t > 1) t = 1;

        const gx = (h[i + 1] - h[i - 1]) / (2 * texel);
        const gy = (h[i + R] - h[i - R]) / (2 * texel);
        const g = Math.hypot(gx, gy);
        // Depth grows with catchment and slope: a swale in the meadow is
        // knee-deep, the same drainage on a mountain flank is a gully you could
        // stand in, and that contrast is most of what makes a hillside read.
        //
        // Incision is also gated on rock competence. Cutting every drainage
        // line to the same depth combs a mountain into identical vertical
        // flutes — it reads as drapery, not as a hillside. Letting soft ground
        // incise while hard ground resists is what leaves the smooth
        // interfluves and buttresses standing between the gullies.
        const soft = 1.28 - hard[i] * 0.88;
        const w = 0.24 + Math.min(1.0, g * 1.25) * 0.78;
        // And it scales super-linearly with slope. A uniform 3 m incision gave
        // the meadow a decent grain but left a 45-degree massif as a smooth
        // cone with a faint texture on it — the "mountains read as smooth
        // painted ramps" note from the art review. Real alpine flanks are
        // grooved by gullies ten or twenty metres deep with spurs standing
        // between them, and that relief is what gives a silhouette its
        // ridgelines and gives the shading something to catch on.
        const steepGain = 1.0 + Math.min(1.6, g) * 2.4;
        rill[i] = Math.pow(t, 1.5) * 2.6 * w * soft * steepGain;
      }
    }

    // A 2 m-wide slot cut straight into a 2 m grid aliases into a staircase.
    // Two cheap box passes spread it into a channel with banks.
    const tmp = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass === 0 ? rill : tmp;
      const dst = pass === 0 ? tmp : rill;
      for (let y = 1; y < R - 1; y++) {
        for (let x = 1; x < R - 1; x++) {
          const i = y * R + x;
          dst[i] = (src[i] * 4
                  + (src[i - 1] + src[i + 1] + src[i - R] + src[i + R]) * 2
                  + (src[i - R - 1] + src[i - R + 1] + src[i + R - 1] + src[i + R + 1])) * (1 / 16);
        }
      }
    }

    for (let i = 0; i < N; i++) h[i] -= rill[i];
    this.rill = rill;
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
      // 0.12 m was low enough that the priority-flood's epsilon flats counted
      // as lakes, sheeting water over huge areas of merely-level meadow.
      if (this.lakeDepth[i] > 0.55) {
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

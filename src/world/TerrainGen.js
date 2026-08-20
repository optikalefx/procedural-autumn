// ─────────────────────────────────────────────────────────────────────────────
//  TerrainGen — offline world bake.
//
//  Pipeline:
//    1. Tectonic base       ridged multifractal + domain warp + continental mask
//    2. Hydraulic erosion   droplet sim carves real drainage networks
//    3. Depression filling  priority-flood -> lake basins
//    4. Flow accumulation   D8 over the filled surface -> river discharge,
//                           then lake bodies (level + spill point) and the
//                           river mask that excludes them
//    5. Channel carving     centrelines are traced and SMOOTHED first, then the
//                           bed is cut along them
//    6. Water surface       rasterised from those same centrelines plus the
//                           lake levels, so a mouth, a lake and an outlet are
//                           one continuous surface; waterfall tags
//    7. Climate             moisture from rivers/altitude -> biome weights
//
//  Steps 5 and 6 both consume `this.channels`, which `_traceRivers` builds at
//  the top of step 5. That is deliberate ordering, not an accident of where the
//  call landed: for three rounds the carve was splatted around the raw D8
//  river mask while the ribbon was swept along a polyline, and where the two
//  diverged the carved bed showed as a bare tan channel *beside* the water.
//  One centreline, carved from and drawn from, is the fix.
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

// 8-neighbourhood, shared by the lake labeller and anything else that walks it.
const D8X = [-1, 0, 1, -1, 1, -1, 0, 1];
const D8Y = [-1, -1, -1, 0, 0, 1, 1, 1];

// ── the river↔lake join, in constants ────────────────────────────────────────
// How far the depression fill had to raise a cell before it counts as standing
// water. Three passes used to carry three different answers to this — 0.12 in
// `_fillDepressions`, 0.6 in the mask, 0.55 in the surface — so a trace could
// walk into a cell the surface pass had already called lake and emit a ribbon
// across it. One constant, one answer.
const LAKE_MIN_DEPTH = 0.55;
// Under this a "body" is a handful of texels the priority flood caught in a
// local pit: no shoreline, no depth and no reflection — a puddle-shaped bug.
// In square metres, not in cells, because the same world is baked at three
// resolutions and a cell count would mean three different definitions of lake.
const LAKE_MIN_AREA = 400;
// ...and a body only gets to *terminate a river* if it is a lake you could put
// a boat on. Measured on this seed at res 768: 161 bodies, of which 46 clear
// this bar and hold 93% of the standing water between them. The other 115 are
// pans and hollows a metre across strewn along the valley floor, and clipping a
// trace at every one of them cut the river network from 93 trunks to 17 — the
// channel runs *through* a pond, it does not end at one.
const LAKE_MAJOR_AREA = 3000;
const LAKE_MAJOR_DEPTH = 1.5;
// Metres of channel over which a reach hands over to standing water, and over
// which one is born again at a spill point. Long enough that the flare reads as
// a delta from a moving vehicle, short enough that a 150 m tributary is not all
// mouth. The contract asks for 25-40 m.
const MOUTH_LEN = 34;
const OUTLET_LEN = 30;
// Metres the mouth carries on *past* the waterline, and metres an outlet starts
// *inside* the lake. Both reaches need a little geometry over open water: it is
// what lets the ribbon slide under the lake surface instead of stopping on a
// quad edge in mid-air.
const MOUTH_INTO = 12;
const OUTLET_PRE = 10;
// How much wider a channel runs where it spreads into standing water. A delta
// is not a pipe that stops; it is the same discharge over three times the area,
// which is exactly why it is also shallow and slow.
const MOUTH_FLARE = 1.7;
// Laplacian passes over the traced centreline. See `_traceRivers` — the per
// point displacement clamp, not this count, is what makes the smoothing
// width-aware, so this only has to be large enough to kill a 4 m staircase.
const SMOOTH_PASSES = 12;
// Shortest reach worth carving, in metres. A river network chopped at every
// lake has short links in it by construction — pond to pond down a valley
// floor — and they are as much of the connectivity as the trunks are.
// Deliberately short: this governs what exists in the terrain, not what gets
// a ribbon. PUBLISH_MIN_W is what governs that.
const MIN_REACH = 12;
// Meander wavelength, in channel widths. Natural meander trains run 10-14.
const MEANDER_WAVE = 16;
// Peak lateral offset, in channel widths. A sine-generated curve of amplitude A
// and wavelength L swings 2*pi*A/L radians off its axis, and sinuosity is
// 1/J0(that): at L = 12w, A = 2.0w gives 1.05 rad and 1.36, A = 2.4w gives
// 1.26 rad and 1.55. The valley-floor gate takes most reaches below whatever
// is asked for here, so it is set at the top of the plausible range.
const MEANDER_AMP = 5.0;
// Metres the ground may rise above the reach's own surface before the meander
// stops growing into it. This is the valley floor, in one number: a bend fills
// the flat it is in and stops at the bank.
const MEANDER_FREEBOARD = 1.8;
// Radians of phase wander per unit of fbm — see the call site. This is what
// makes one bend longer than the next; at 0 every meander is the same length.
const MEANDER_GAIN = 2.5;
// Cells of upstream drainage before a channel counts as a stream. Also the
// seed for the moisture field — see `_climate`, which must not be tied to what
// the ribbon happens to draw.
const RIVER_MIN = 900;
// Narrowest channel that gets a published polyline. Every traced reach carves
// its bed, writes its water surface and paints its mask, because that is the
// terrain; only reaches this wide are handed to Water.js, audio and wildlife.
// Water.js already refuses anything under 1.5 m — a one-texel brook swept as a
// ribbon is a blue thread laid over gold grass — so publishing them costs a
// megabyte of JSON in the bake header, and two hundred thousand transparent
// double-sided triangles, to draw something that is a defect when it does show.
// Four metres, measured: it is where `w = 1.2 + discharge*11` crosses a quarter
// of full discharge, and the reaches it drops still carve their beds, write
// their water surface and paint their mask. They read as damp gullies with a
// rill in them, which is what a stream that narrow is.
const PUBLISH_MIN_W = 4.0;
// ...and how deep a hollow has to be to count as damp ground for the same
// purpose. Calibrated, not chosen: it is the value at which the mean moisture
// of the map comes back to the 0.54 it measured before the water grid stopped
// being a per-texel derivation, which is the number the whole forest, shrub
// and grass distribution was tuned against.
const DAMP_MIN_DEPTH = 0.3;

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
      distToWaterM: this.distToWaterM,
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

    // Structural benching (see _structure). Same plane family as the bedding
    // above, subdivided, and carried in metres so the terrace operator does not
    // have to go back through radians.
    this.benchStep = new Float32Array(N);  // metres of elevation per bench
    this.benchPhase = new Float32Array(N); // where the bench boundary sits, metres
    this.benchW = new Float32Array(N);     // how strongly this region benches
    this.massifW = new Float32Array(N);    // 0 basin .. 1 high massif
    this.spurGain = new Float32Array(N);   // see the spur emphasis in _structure

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

        // ── the bench family ───────────────────────────────────────────────
        // Stratigraphy above selects where *albedo* banding and differential
        // weathering happen. This selects where the surface itself steps, and
        // it is a different problem, so it gets its own numbers.
        //
        // A 92-190 m bed is the right scale for "this massif has three or four
        // prominent ledges" and the wrong scale for what the critic actually
        // asked for, which is planar faces at 10-60 m that catch and lose the
        // light. Subdividing the same plane family by four gives 23-48 m
        // benches that sit *inside* the big ledges rather than fighting them.
        //
        // Phase carries the dip, so a bench trace cuts diagonally across a
        // flank instead of drawing a level curve, plus a ~170 m wander worth a
        // fifth of a step. The wander is the whole defence against the failure
        // mode this pass could otherwise cause: a terrace whose boundary is a
        // clean iso-height line reads as a contour map, and that artefact has
        // already been removed from this game twice.
        const benchStep = thickness * 0.42;
        // Wander worth most of a whole step, at ~110 m. Below that the traces
        // are still recognisably a family of parallel lines however irregular
        // their spacing is; at this amplitude a bench visibly climbs and falls
        // across a face, which is the difference between a ledge and a contour.
        const wander = n.fbm(u * 14.1 + 7.7, v * 14.1 - 31.4, 2, 2.1, 0.5, 1) * benchStep * 0.85;
        this.benchStep[i] = benchStep;
        this.benchPhase[i] = -bedRise + wander;
        // Alpine gets far more weight here than it does in strataW. Jointed
        // horns do not carry bedding *colour*, but they very much carry planar
        // faces and ledges — that is what a fractured face is — and alpine is
        // the character on the massifs the hero, peaks and dawn cameras look
        // at. Rounded stays near zero: a grassy dome is supposed to be smooth.
        // Patchy in space. Benching every steep cell in the world at the same
        // strength is corduroy however wide the pitch is — the first version of
        // this pass did exactly that and the hillshade came back as a contour
        // map. A ~250 m octave means one buttress is strongly stepped and the
        // spur beside it is a plain face, which is both what the reference
        // cliffs look like and what stops the eye reading a repeating texture.
        const benchPatch = 0.42 + 0.58 * clamp01(
          n.fbm(u * 12.4 - 22.1, v * 12.4 + 63.5, 2, 2.1, 0.5, 1) * 0.9 + 0.5);
        this.benchW[i] = clamp01((wMesa * 1.00 + wAlpine * 1.00 + wRound * 0.30)
                                 * smoothstep(0.10, 0.42, massif)) * benchPatch;
        this.massifW[i] = massif;
        // Spur emphasis gain, ~180 m. Signed on purpose: see _structure.
        this.spurGain[i] = 0.10 + n.fbm(u * 17.3 + 13.1, v * 17.3 - 46.2, 2, 2.15, 0.5, 1) * 0.82;
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

    this._structure();
  }

  /**
   * Structural benching — the pass that puts planes on a mountain.
   *
   * THE DEFECT THIS EXISTS FOR. Every massif in hero, peaks and dawn arrived as
   * a smooth satin drape: a single continuous gradient from crest to foot, with
   * the rocks system's crag blocks sitting on it looking like faceted stone
   * dropped onto a wax candle. Raking dawn light revealed nothing because there
   * was nothing in the surface to reveal. Everything the pipeline produced
   * before this point is either far too coarse (400 m+ tectonic octaves) or far
   * too fine (the droplet sim's metre-scale drainage grain, which the talus
   * limiter then low-passes). The 10-60 m band — the band that decides whether
   * a face reads as one ramp or as a set of planes — was empty.
   *
   * TWO PREVIOUS ATTEMPTS AT THIS DEFECT WERE ALBEDO, AND BOTH WERE REVERTED.
   * A dark curve painted on a shaded face reads as a contour line on a map, and
   * that is true however it is weighted. The fix has to be in the surface, so
   * that a plane is genuinely turned toward or away from the sun and the light
   * does the work — then it survives every hour of the day, appears in the
   * shadow map and in the silhouette, and cannot look like ink.
   *
   * The operator is a terrace on the *bedding plane family*, not on elevation.
   * That distinction is the whole reason this is not a contour map: terracing
   * elevation puts the step boundary on a level curve by construction, whereas
   * a bed dips, so its outcrop trace runs diagonally across a flank and changes
   * direction with the regional dip. A ~170 m wander on top breaks the residual
   * straightness. The transfer is flat over the first 44% of each band and
   * rises through the rest, which is what makes a tread and a riser instead of
   * a sine.
   *
   * Placed after mass wasting deliberately. Running it before the talus limiter
   * would have the limiter immediately lie the risers back down — which is what
   * the limiter is for — and running it after depression filling would let the
   * treads pond water. Here, the hydrology stages downstream re-route on the
   * benched surface, so streams find the new ledges and any tread that closes a
   * hollow is filled as a tarn rather than left as a pit.
   */
  _structure() {
    const R = this.res, h = this.height;
    const texel = this.worldSize / R;
    const N = R * R;
    const step = this.benchStep, phase = this.benchPhase, bw = this.benchW;
    if (!step) return;

    // Slope is read from the surface as it stands, once, into a scratch buffer,
    // because the pass must not see its own output — benching a cell, finding
    // it steeper, and benching it harder is a runaway, and a runaway here is
    // exactly the corduroy artefact this file has fought before.
    const src = new Float32Array(h);
    const out = new Float32Array(N);
    const mw = this.massifW, sg = this.spurGain;

    // ── spur emphasis ────────────────────────────────────────────────────────
    // The droplet sim cuts drainage grain at a fairly constant pitch, and every
    // rill on a flank ends up about as deep as every other one. Rendered, that
    // is corduroy: a pleated curtain of identical parallel flutes running the
    // full height of the face, which is the note the peaks and drive massifs
    // still drew after the benches landed. Real ranges are not uniform — one
    // buttress is deeply ribbed, the spur beside it is a plain sheet of rock —
    // and it is the *variation* that reads as structure, not the ribs.
    //
    // An unsharp mask with a signed, spatially varying gain does exactly that
    // for the price of one blur: where the gain is positive the flutes deepen
    // into real ribs, where it is negative they are pressed back into a plain
    // face. It only ever scales relief that is already there, so it cannot
    // invent a pattern of its own, and it is applied before the terrace so the
    // benches cut across the ribs it leaves.
    const lowPass = this._boxBlur(h, 22, 1);
    const slopeBuf = new Float32Array(N);
    for (let y = 0; y < R; y++) {
      const ym = Math.max(0, y - 1) * R, yp = Math.min(R - 1, y + 1) * R, y0 = y * R;
      for (let x = 0; x < R; x++) {
        const i = y0 + x;
        const xm = Math.max(0, x - 1), xp = Math.min(R - 1, x + 1);
        const gx = (h[y0 + xp] - h[y0 + xm]) / (2 * texel);
        const gz = (h[yp + x] - h[ym + x]) / (2 * texel);
        const sl = Math.hypot(gx, gz);
        slopeBuf[i] = sl;
        const gate = smoothstep(0.24, 0.60, sl) * smoothstep(0.08, 0.40, mw[i]);
        if (gate < 0.02) continue;
        // Clamped below at -0.40, not at -1. Variation is the point of this
        // term, but a gain near -1 planes a flank perfectly flat, and a
        // perfectly flat natural slope is its own artefact: at -0.72 the most
        // prominent face in the hero frame came back as a smooth waxy sheet
        // with nothing on it, which is the note this whole pass exists to
        // answer. A quiet face should be quiet, not blank.
        const g = clamp(sg[i], -0.40, 1.05) * gate;
        src[i] = h[i] + (h[i] - lowPass[i]) * g;
      }
    }

    // ── de-fluting ───────────────────────────────────────────────────────────
    // Run between the spur emphasis and the terrace, deliberately: the unsharp
    // mask above is a broadband amplifier and it doubles contour-parallel
    // ripple along with the ribs it is there for, and the terrace wants to cut
    // into clean ground.
    this._deflute(src);

    for (let y = 0; y < R; y++) {
      const y0 = y * R;
      for (let x = 0; x < R; x++) {
        const i = y0 + x;
        out[i] = src[i];
        const w0 = bw[i];
        if (w0 < 0.02) continue;

        const slope = slopeBuf[i];

        // Steep ground only. A bench cut into a meadow is a farm terrace, and
        // the player drives on that ground: the gate opens at ~17 degrees and
        // is only at full strength past ~35, which is above anything drivable.
        // It also keeps the operator away from valley floors, where a step
        // across a stream course would dam it.
        // Benches live on moderate ground and die on walls, and that is not a
        // compromise — it is what a bench is. A bed's outcrop width in map view
        // is its thickness divided by the local fall, so on a 65 degree face a
        // 55 m bench compresses to a 25 m stripe and a stack of them is ruled
        // corduroy again; the hillshade showed exactly that when the gate was a
        // plain smoothstep. Above ~63 degrees the surface is the riser, and a
        // riser wants to be one clean plane.
        const wSlope = smoothstep(0.28, 0.62, slope) * (1.0 - smoothstep(1.15, 2.00, slope));
        let w = w0 * wSlope * 0.58;
        if (w < 0.01) continue;

        const s = step[i];
        const u = (src[i] + phase[i]) / s;
        const uf = Math.floor(u);
        const fr = u - uf;
        // Per-band prominence. Real cliff country is two or three conspicuous
        // ledges in a lot of ordinary slope, not an evenly ruled staircase, and
        // an evenly ruled staircase is the exact artefact that gets this kind of
        // pass reverted. Hashed on the band index, so a band keeps the same
        // prominence along its whole outcrop and neighbouring cells agree.
        //
        // SPARSE, not merely uneven. A spread of 0.24-1.0 still steps every
        // band to some degree, and on a mesa flank that came back as a dozen
        // parallel gold stripes on grey — grass catching every tread and bare
        // rock on every riser. Geometric or not, that is the wood-grain
        // artefact, and it is the third time this file has produced it. Roughly
        // two bands in five step at all; the rest are a whisper. Three real
        // ledges on a massif is what the canyon plate shows.
        const bh = Math.sin(uf * 12.9898 + 4.13) * 43758.5453;
        const bf = bh - Math.floor(bh);
        w *= bf < 0.62 ? 0.10 : 0.45 + 1.15 * ((bf - 0.62) / 0.38);
        // Tread over the low 44%, riser through the rest. Not a hard step: a
        // hard step is a vertical wall one texel wide, which aliases into a
        // stair-tread pattern the moment the mesh LOD samples it at 6 m.
        const target = (uf + smoothstep(0.40, 0.86, fr)) * s - phase[i];
        out[i] = src[i] + (target - src[i]) * w;
      }
    }

    h.set(out);
  }

  /**
   * Fall-line smoothing of the fine band on steep faces — the "combed hair"
   * fix, and half of the gold-ribbon fix.
   *
   * MEASURED DEFECT. On steep massif faces the residual after a 30 m low-pass
   * decorrelates markedly faster along the fall line than along the contour
   * (ACF at 30 m lag: 0.148 down-slope against 0.318 across it). That is a
   * corrugation whose crests run along the contours, and it does two things.
   * Rendered, it is the brushed-metal surface every flank was wearing instead
   * of plane-and-crease. And because the grass/rock mask is a threshold on
   * slope, each micro-bench of it dips under the cut and gets painted as a thin
   * grass ribbon — twelve parallel gold bands across the peaks massif, in the
   * same place at every hour of the day, because none of it is shading.
   *
   * The operator is a 1-D Gaussian applied ALONG THE LOCAL FALL LINE, to the
   * band finer than 20 m only. That direction is the whole point: relief that
   * runs down the slope — the drainage flutes, the gullies, the spur noses,
   * everything the erosion sim cut and everything the reference cliffs actually
   * show — varies slowly along the fall line and passes through untouched,
   * while relief that runs across it is exactly what the kernel averages away.
   * An isotropic blur would take both and give back the wax drape this file has
   * already been criticised for twice.
   *
   * Everything coarser than 20 m is reconstructed bit for bit, so the benches,
   * the ledges and the massif silhouette are not in scope.
   */
  _deflute(buf) {
    const R = this.res, N = R * R;
    const texel = this.worldSize / R;
    const mw = this.massifW;
    const lp = this._boxBlur(buf, 48, 1);
    // Direction is taken from a much wider read than the signal being filtered,
    // so the kernel cannot align itself with the very ripple it is removing.
    const dir = this._boxBlur(buf, 60, 1);
    const fine = new Float32Array(N);
    for (let i = 0; i < N; i++) fine[i] = buf[i] - lp[i];

    // sigma 15 m, taps out to +/-30 m. Sized by measurement, not by eye: the
    // ripple that reaches the slope field lives at 20-45 m, so a 6 m sigma
    // (the first attempt) removed 8% of it and measured as a no-op. This takes
    // 97% of a 30 m wave and 90% of a 45 m one while leaving a 120 m ledge at
    // two thirds of its height, which is the line between a corrugation and the
    // bedding-plane benching that is supposed to be there.
    //
    // Expressed in METRES and converted, so a 512 or 768 preview bake filters
    // the same ground as the shipping 1536 one rather than a kernel four times
    // wider.
    const px = R / this.worldSize;
    const T = [0, 7.5, -7.5, 15, -15, 22.5, -22.5, 30, -30].map(v => v * px);
    const Wt = [1.0, 0.885, 0.885, 0.607, 0.607, 0.325, 0.325, 0.135, 0.135];
    let wsum = 0; for (const w of Wt) wsum += w;
    for (let k = 0; k < Wt.length; k++) Wt[k] /= wsum;

    const bil = (gx, gy) => {
      if (gx < 0) gx = 0; else if (gx > R - 1.001) gx = R - 1.001;
      if (gy < 0) gy = 0; else if (gy > R - 1.001) gy = R - 1.001;
      const x = gx | 0, y = gy | 0, fx = gx - x, fy = gy - y, i = y * R + x;
      return fine[i] * (1 - fx) * (1 - fy) + fine[i + 1] * fx * (1 - fy)
           + fine[i + R] * (1 - fx) * fy + fine[i + R + 1] * fx * fy;
    };

    for (let y = 1; y < R - 1; y++) {
      const y0 = y * R;
      for (let x = 1; x < R - 1; x++) {
        const i = y0 + x;
        const gx = dir[i + 1] - dir[i - 1], gz = dir[i + R] - dir[i - R];
        const L = Math.hypot(gx, gz);
        if (L < 1e-5) continue;
        // THE GATE READS THE SMOOTHED SLOPE, NOT THE RAW ONE, AND THAT IS THE
        // WHOLE PASS. Gated on slopeBuf the operator defeated itself: the
        // corrugation swings the local slope by +/-0.6, so on a 1.0 face the
        // troughs of the very ripple being removed fell under the gate and
        // were preserved. Measured on a synthetic 20 m ripple over a 45 degree
        // plane, the raw gate took it from 1.34 to 0.48 where the arithmetic
        // says 0.09; on the smoothed gate it reaches 0.09.
        const slopeSm = L / (2 * texel);
        const w = 0.96 * smoothstep(0.44, 0.92, slopeSm)
                       * smoothstep(0.06, 0.34, mw[i]);
        if (w < 0.02) continue;
        const fx = gx / L, fz = gz / L;
        let s = 0;
        for (let k = 0; k < T.length; k++) s += Wt[k] * bil(x + fx * T[k], y + fz * T[k]);
        buf[i] = lp[i] + fine[i] + (s - fine[i]) * w;
      }
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

    // Two surfaces come out of one flood, and the difference between them is
    // the whole reason this round found the valley floor covered in ponds.
    //
    //   filled  carries the +EPS per popped cell that gives a flat area a
    //           drainage direction. D8 needs it: over a perfectly level fill
    //           there is no downhill neighbour and routing stalls.
    //   flat    is the same flood without it — the spill elevation propagated
    //           unchanged, so a cell that genuinely drains keeps its own height.
    //
    // Lake depth has to be measured against `flat`. Measured against `filled`,
    // the epsilon accumulates along the processing order — 8e-4 m per cell, so
    // 690 cells of merely-level meadow "fills" to 0.55 m — and a top-down
    // render of the bake comes back with the whole basin speckled in false
    // ponds, 160 bodies over 17% of the map, every one of them clipping the
    // rivers that ought to run through it. It also means a body's level is now
    // exactly constant across it, which is what standing water is.
    const EPS = 0.0008;
    const flat = new Float32Array(h);
    while (heap.size > 0) {
      const { key: hv, val: i } = heap.pop();
      const fv = flat[i];
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
          if (fv > flat[ni]) flat[ni] = fv;
          heap.push(filled[ni], ni);
        }
      }
    }

    this.filled = filled;
    this.fillFlat = flat;
    // Lake depth = how much standing water is above the bed. The 0.12 floor
    // here is only noise rejection; what counts as a lake is LAKE_MIN_DEPTH,
    // decided once in `_lakeBodies`, which is also what publishes `this.lakes`.
    this.lakeDepth = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = flat[i] - h[i];
      if (d > 0.12) this.lakeDepth[i] = d;
    }
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

    // Lake bodies before the mask, because the mask is defined against them.
    this._lakeBodies();

    // Normalise into a discharge measure and build the river mask.
    const riverMask = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // A lake has no channel. Routing D8 across the flat filled surface of a
      // lake yields dead-straight "rivers"; masking them out is both correct
      // and the thing that stops the map looking like a circuit board.
      //
      // Gated on a *major* labelled body rather than on raw fill depth, so
      // neither a puddle nor a knee-deep pan silently punches a hole in a
      // river the trace then has to be clipped at.
      const lb = this.lakeId[i];
      if (lb >= 0 && this.lakeMajorFlag[lb]) continue;
      const f = flow[i];
      if (f > RIVER_MIN) {
        riverMask[i] = clamp01(Math.log(f / RIVER_MIN) / Math.log(220));
      }
    }
    this.riverMask = riverMask;
  }

  /**
   * Connected bodies of standing water: which cells, what level, and the rim
   * cell each one spills over.
   *
   * Nothing in the bake had a concept of a lake as an *object* before this, and
   * that absence is four of the five defects in the water round. `_traceRivers`
   * could not ask "am I about to walk into a lake", so it followed D8 straight
   * across one — over the flat filled surface, at riverMask 0 — and emitted a
   * dead 1.2 m ribbon at zero discharge over open water. That is the pale
   * stripe in shots/w-base/river.png. And with no spill point recorded, a river
   * leaving a lake was an unrelated trace that began in the middle of nowhere.
   *
   * The level comes from `fillFlat`, the epsilon-free flood, so it is exactly
   * the spill elevation and exactly constant over the body. Averaged over
   * `filled` instead it would dome by a third of a metre from rim to centre —
   * a lake that is not level, which is the one thing standing water never is,
   * and at a shallow shoreline a third of a metre is metres of waterline.
   */
  _lakeBodies() {
    const R = this.res, N = R * R;
    const id = new Int32Array(N).fill(-1);
    const bodies = [];
    const stack = new Int32Array(N);
    const cells = new Int32Array(N);
    const d = this.lakeDepth, filled = this.fillFlat;
    const cellArea = (this.worldSize / R) * (this.worldSize / R);
    const minCells = Math.max(4, Math.round(LAKE_MIN_AREA / cellArea));
    const majorCells = Math.round(LAKE_MAJOR_AREA / cellArea);

    for (let s = 0; s < N; s++) {
      if (d[s] <= LAKE_MIN_DEPTH || id[s] >= 0) continue;
      const b = bodies.length;
      let sp = 0, n = 0, sum = 0, deepest = 0;
      let spill = -1, spillH = Infinity;
      stack[sp++] = s; id[s] = b;
      while (sp > 0) {
        const i = stack[--sp];
        cells[n++] = i; sum += filled[i];
        if (d[i] > deepest) deepest = d[i];
        const y = (i / R) | 0, x = i - y * R;
        for (let k = 0; k < 8; k++) {
          const nx = x + D8X[k], ny = y + D8Y[k];
          if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
          const ni = ny * R + nx;
          if (d[ni] > LAKE_MIN_DEPTH) {
            if (id[ni] < 0) { id[ni] = b; stack[sp++] = ni; }
          } else if (filled[ni] < spillH) {
            // The outlet, recovered rather than recomputed: the priority flood
            // raised every cell inside this basin to the elevation of the
            // lowest cell on its rim, so the lowest rim cell IS the spill.
            spillH = filled[ni]; spill = ni;
          }
        }
      }
      if (n < minCells) {
        for (let k = 0; k < n; k++) id[cells[k]] = -1;
        continue;
      }
      bodies.push({
        level: sum / n, cells: n, spill, spillH, deepest,
        major: n >= majorCells && deepest >= LAKE_MAJOR_DEPTH,
      });
    }

    this.lakeId = id;
    this.lakeBodies = bodies;
    // Flat lookup so the hot loops can ask "is this a lake a river ends at?"
    // without chasing an object per texel.
    this.lakeMajorFlag = Uint8Array.from(bodies, (b) => (b.major ? 1 : 0));
    let labelled = 0, major = 0;
    for (const b of bodies) { labelled += b.cells; if (b.major) major++; }
    this.lakes = { cellCount: labelled, bodyCount: bodies.length, majorCount: major };
  }

  // ── 5. Carve channels along the smoothed centrelines ───────────────────────
  /**
   * The bed is cut from the same polyline the ribbon is swept along.
   *
   * It used to be splatted around every cell of the raw D8 river mask — a
   * staircase of 2 m texels — while the water was drawn along a polyline, and
   * where those two diverged you saw the carved bed as a bare tan channel
   * *beside* the water. That is the defect logged three rounds running as "the
   * tan stripe beside the fall". Two derivations of one channel is the whole
   * bug; there is now one.
   *
   * The cut is also stated as an ELEVATION rather than as a depth to subtract.
   * `bedC` is exactly `surf - wdep`, the surface the rasteriser is about to
   * write minus the water depth at the centreline, so the bed cannot end up
   * above the water it is supposed to hold — which is the other half of the
   * same defect, water drawn where the ground had been left too high.
   *
   * Guarded, though, by the old relative carve: taken literally an absolute
   * cut flattens whatever it passes through, and a river in a gorge would
   * bulldoze its own walls into a floodplain the full splat radius wide.
   * Whichever of the two removes LESS rock wins, so the shaping happens on the
   * valley floor where the channel is and the walls stand.
   */
  _carveChannels() {
    // The centrelines have to exist before the carve, and they are traced here
    // rather than in generate() so that the two can never be run out of order.
    this._traceRivers();

    const R = this.res, N = R * R, h = this.height;
    const texel = this.worldSize / R, half = this.worldSize / 2;
    const hOrig = Float32Array.from(h);
    const bedTarget = new Float32Array(N).fill(Infinity);

    const splat = (wx, wz, m, lk, surf, wdep, dcarve) => {
      // Same footprint the mask splat used — (1 + m*7.5) texels — so the
      // valley the carve cuts is the one the terrain has always had, widened
      // where the channel spreads into a delta.
      const radT = (1.0 + m * 7.5) * (1 + lk * 0.6);
      const bedC = surf - wdep;
      const gx = (wx + half) / texel, gz = (wz + half) / texel;
      const x0 = Math.max(0, Math.floor(gx - radT)), x1 = Math.min(R - 1, Math.ceil(gx + radT));
      const z0 = Math.max(0, Math.floor(gz - radT)), z1 = Math.min(R - 1, Math.ceil(gz + radT));
      const invR = 1 / radT;
      for (let iy = z0; iy <= z1; iy++) {
        const dz = iy + 0.5 - gz;
        for (let ix = x0; ix <= x1; ix++) {
          const dx = ix + 0.5 - gx;
          const d = Math.sqrt(dx * dx + dz * dz) * invR;
          if (d > 1) continue;
          const prof = Math.cos(d * Math.PI * 0.5);        // U-shaped bed
          const p2 = prof * prof;
          const ni = iy * R + ix;
          const ho = hOrig[ni];
          const lowered = ho - dcarve * p2;
          const shaped = bedC + (ho - bedC) * (1 - p2);
          const tgt = lowered > shaped ? lowered : shaped;
          if (tgt < bedTarget[ni]) bedTarget[ni] = tgt;
        }
      }
    };

    for (const sta of this.channels) {
      for (let k = 0; k < sta.length - 1; k++) {
        const a = sta[k], b = sta[k + 1];
        // Sub-step along the segment: stations are up to 6 m apart and a disc
        // every 6 m is a string of beads, not a channel.
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        const sub = Math.max(1, Math.ceil(seg / (texel * 0.7)));
        for (let t = 0; t < sub; t++) {
          const u = t / sub;
          splat(lerp(a.x, b.x, u), lerp(a.z, b.z, u),
                lerp(a.m, b.m, u), lerp(a.lake, b.lake, u),
                lerp(a.surf, b.surf, u), lerp(a.wdep, b.wdep, u),
                lerp(a.dcarve, b.dcarve, u));
        }
      }
    }

    const carve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (bedTarget[i] < h[i]) { carve[i] = h[i] - bedTarget[i]; h[i] = bedTarget[i]; }
    }
    this.carve = carve;

    this._carveRills();

    // Recompute slope after carving — used everywhere downstream.
    const slope = new Float32Array(N);
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
  /**
   * Rasterise the water surface from the centrelines and the lake levels.
   *
   * Not from the grid: `rm[i] > 0 ? h[i] + 0.22 + rm[i]*0.9 : ...` sampled the
   * carved bed per texel, which meant the ribbon's height and the grid's height
   * were two different functions of two different things and disagreed by
   * whatever the carve happened to do at that texel. Now the polyline is the
   * only statement of where the surface is, and both the ribbon and this grid
   * read it — so `getWaterHeight`, the shoreline depth fade, the wet-ground
   * shading and the ribbon cannot drift apart.
   *
   * The river mask is rebuilt from the same lines for the same reason. It is
   * what puts tan riverbed albedo on the ground (see TerrainMaterial's `river`
   * channel); leaving it on the D8 staircase while the water followed a smooth
   * line is precisely how a bare channel ends up drawn beside a river.
   */
  _waterSurface() {
    const R = this.res, N = R * R, h = this.height;
    const water = new Float32Array(N).fill(-9999);
    const rm = new Float32Array(N);
    const waterfalls = [];
    const texel = this.worldSize / R;
    const half = this.worldSize / 2;

    // Standing water first: one flat level per body.
    for (let i = 0; i < N; i++) {
      const b = this.lakeId[i];
      if (b >= 0) water[i] = this.lakeBodies[b].level;
    }

    // Then the channels, over a footprint a little wider than the ribbon so the
    // shoreline fade and the damp band have ground to finish on.
    const wsplat = (wx, wz, m, surf, hw, wdep) => {
      const radT = Math.max(1.2, (hw * 1.35) / texel);
      // Below this the ground has fallen out from under the channel and the
      // splat is painting water over a lip. Writing it anyway is what puts a
      // hard-edged pale blue wedge on the grass below a plunge pool — a lake
      // triangle at full alpha over ground five metres beneath it, with a
      // dead-straight edge, because the depth fade in the shader can only ask
      // whether there is ground *under* the water and there is, a long way
      // under. A channel is a few metres deep; past that this is a waterfall,
      // and the falls system draws it.
      const floor = surf - wdep - 3.0;
      const gx = (wx + half) / texel, gz = (wz + half) / texel;
      const x0 = Math.max(0, Math.floor(gx - radT)), x1 = Math.min(R - 1, Math.ceil(gx + radT));
      const z0 = Math.max(0, Math.floor(gz - radT)), z1 = Math.min(R - 1, Math.ceil(gz + radT));
      const invR = 1 / radT;
      for (let iy = z0; iy <= z1; iy++) {
        const dz = iy + 0.5 - gz;
        for (let ix = x0; ix <= x1; ix++) {
          const dx = ix + 0.5 - gx;
          const d = Math.sqrt(dx * dx + dz * dz) * invR;
          if (d > 1) continue;
          const ni = iy * R + ix;
          if (h[ni] < floor) continue;
          if (surf > water[ni]) water[ni] = surf;
          // The mask has to stop close to the wet channel. TerrainMaterial
          // paints tan riverbed wherever it exceeds 0.02 and a pale gravel bar
          // wherever it exceeds 0.04, so every metre of mask that reaches past
          // the waterline is a metre of dry ground painted as riverbed — the
          // stripe this round exists to remove, in its quietest form.
          //
          // Gated on the ground, not only on the distance: the radial taper
          // alone cannot know that this particular texel is four metres up a
          // bank. Half a metre of freeboard is the gravel bar and the damp
          // margin the reference plates always show; past that it is a bank,
          // and a bank is grass.
          if (h[ni] > surf + 0.5) continue;
          const v = m * (1 - smoothstep(0.42, 0.80, d));
          if (v > rm[ni]) rm[ni] = v;
        }
      }
    };
    for (const sta of this.channels) {
      for (let k = 0; k < sta.length - 1; k++) {
        const a = sta[k], b = sta[k + 1];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        const sub = Math.max(1, Math.ceil(seg / (texel * 0.7)));
        for (let t = 0; t < sub; t++) {
          const u = t / sub;
          wsplat(lerp(a.x, b.x, u), lerp(a.z, b.z, u), lerp(a.m, b.m, u),
                 lerp(a.surf, b.surf, u), lerp(a.w, b.w, u) * 0.5,
                 lerp(a.wdep, b.wdep, u));
        }
      }
    }
    this.riverMask = rm;

    // Enforce monotone-downhill along flow direction, so water never runs uphill.
    // Standing water is exempt: a lake is level by definition, and letting this
    // pass shave 2 mm off successive cells across one would put a gradient on
    // the one surface in the map that must not have one.
    const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => this.filled[b] - this.filled[a]);
    for (const i of idx) {
      if (water[i] < -9000) continue;
      const d = this.flowDir[i];
      if (d < 0 || water[d] < -9000 || this.lakeId[d] >= 0) continue;
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
  }

  /**
   * Trace the river trunks as smooth centrelines, clipped at standing water,
   * with a mouth where a reach arrives at a lake and an outlet where one is
   * born at a spill point.
   *
   * This runs BEFORE the carve, and everything downstream — the bed, the water
   * grid, the ribbon, the audio emitters, the wildlife pathing — is derived
   * from what it returns. Three separate defects were all one thing: the trace
   * was the *last* step of the bake and nothing else could agree with it.
   *
   * Two structures come out:
   *   this.channels        the full-fat stations, with the bed depth and the
   *                        water depth the carve and the rasteriser need
   *   this.riverPolylines  exactly the six fields docs/WATER_CONTRACT.md
   *                        publishes, rounded, because they go through
   *                        JSON.stringify into the bake header
   */
  _traceRivers() {
    const R = this.res, rm = this.riverMask, flow = this.flow;
    const N = R * R;
    const texel = this.worldSize / R;
    const half = this.worldSize / 2;
    const filled = this.filled, lakeId = this.lakeId, bodies = this.lakeBodies;
    const major = this.lakeMajorFlag;
    const visited = new Uint8Array(N);
    // Where the reach that claimed each cell ended up putting its centreline,
    // AFTER smoothing and meandering. A tributary that runs into a claimed cell
    // has to finish on the trunk's line, not on the raw D8 cell it happened to
    // reach: the trunk has since moved up to four channel widths sideways, so
    // ending at the cell leaves a visible gap and the network reads as a
    // scatter of disconnected dashes. This is the "disconnected" half of the
    // brief, and it is a lookup, not a search.
    const ownerX = new Float32Array(N), ownerZ = new Float32Array(N);
    const channels = [];
    const heads = [];

    // Every cell, not every other cell. The old stride of 2 looked at one
    // river cell in four, so three quarters of the headwaters were never
    // candidates and their reaches only entered the network below the first
    // confluence that happened to land on an even texel.
    for (let y = 2; y < R - 2; y++) {
      for (let x = 2; x < R - 2; x++) {
        const i = y * R + x;
        if (rm[i] <= 0) continue;
        // A head is a river cell with no river neighbour uphill.
        //
        // Both thresholds here used to sit at 0.08-0.10 of the mask, which is
        // flow > 1533 against the RIVER_MIN of 900 that defines a stream at
        // all. Everything in that band — the low-discharge tips of every
        // tributary, and measured on this seed 75.8% of all river cells — was
        // neither a head nor reachable from one, so no centreline ever ran
        // through it. That was survivable while the mask and the water grid
        // were separate per-texel derivations. It is not now that the carve,
        // the water surface and the mask all come off these lines: it deleted
        // three quarters of the drainage network from the map, including the
        // 96 m fall at [-720, -30] that half the comments in TerrainMaterial
        // are written about.
        let isHead = true;
        for (let dy = -1; dy <= 1 && isHead; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const ni = (y + dy) * R + (x + dx);
            if (rm[ni] > 0 && this.flowDir[ni] === i) { isHead = false; break; }
          }
        if (isHead) heads.push({ i, f: flow[i] });
      }
    }
    heads.sort((a, b) => b.f - a.f);

    const px = new Float64Array(6000), pz = new Float64Array(6000);
    const ox = new Float64Array(6000), oz = new Float64Array(6000);
    const tx = new Float64Array(6000), tz = new Float64Array(6000);
    const pm = new Float32Array(6000), pb = new Float32Array(6000);
    const lim = new Float32Array(6000), cum = new Float64Array(6000);

    // ── every head, not the largest 220 ────────────────────────────────────
    // The cap was harmless while the mask and the water grid were computed
    // per-texel from flow accumulation and the polylines were only used to
    // sweep ribbons. They are not any more: the carve, the water surface, the
    // river mask and — through the mask — the moisture field and every tree,
    // shrub and grass blade that moisture places all come off these lines. A
    // cap is then a cap on how much of the drainage network exists at all, and
    // at 220 it took the forest off the near ridge of the hero frame.
    //
    // `visited` already makes this cheap: a reach stops at the first cell an
    // earlier trace claimed, so the total work is the number of river cells,
    // not the number of heads times the length of a river.
    for (const head of heads) {
      // ── walk downstream, and STOP at standing water ─────────────────────
      // The old walk kept following flowDir across the flat filled surface of
      // a lake. Every one of those points had riverMask 0, so it emitted at
      // w = 1.2 and flow = 0: a dead ribbon across open water.
      let cur = head.i, steps = 0, endBody = -1, n0 = 0, joinCell = -1;
      while (cur >= 0 && steps < 6000) {
        const lb = lakeId[cur];
        if (lb >= 0 && major[lb]) { endBody = lb; break; }
        if (visited[cur] && steps > 3) { joinCell = cur; break; }
        visited[cur] = 1;
        const cy = (cur / R) | 0, cx = cur - cy * R;
        px[n0] = ox[n0] = (cx / R) * this.worldSize - half;
        pz[n0] = oz[n0] = (cy / R) * this.worldSize - half;
        // Seed the ownership with the raw cell, so that a tributary joining a
        // reach that is later rejected for being too short lands on the cell
        // rather than on the world origin.
        ownerX[cur] = px[n0]; ownerZ[cur] = pz[n0];
        pm[n0] = rm[cur];
        pb[n0] = filled[cur];
        n0++;
        cur = this.flowDir[cur];
        steps++;
      }
      // Finish on the trunk, not a texel short of it. The junction point is
      // the confluence: pinned through the smoothing and tapered out of the
      // meander at both ends, so it stays exactly where the trunk's centreline
      // is however far either line has moved.
      if (joinCell >= 0 && n0 > 0 && n0 < 6000) {
        px[n0] = ox[n0] = ownerX[joinCell];
        pz[n0] = oz[n0] = ownerZ[joinCell];
        pm[n0] = pm[n0 - 1];
        pb[n0] = filled[joinCell];
        n0++;
      }

      // In metres, not in texels. `n0 < 12` was 24 m at res 1536 and 48 m at
      // res 768, so the same world baked at two resolutions had two different
      // river networks — and once traces are clipped at lakes the reaches
      // between two of them are legitimately short, which is exactly the class
      // this threshold was quietly deleting.
      if (n0 < 4 || n0 * texel < MIN_REACH) continue;

      // Is this reach an outlet? Below a lake the mask resumes immediately, so
      // a head lands within a texel or two of the shore — which is why an
      // outlet river already existed in the bake and simply began nowhere.
      let startBody = -1;
      {
        const hy = (head.i / R) | 0, hx = head.i - hy * R;
        let best = 1e9;
        for (let dy = -3; dy <= 3; dy++) {
          const ny = hy + dy; if (ny < 0 || ny >= R) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = hx + dx; if (nx < 0 || nx >= R) continue;
            const b = lakeId[ny * R + nx];
            if (b < 0 || !major[b]) continue;
            const dd = dx * dx + dy * dy;
            if (dd < best) { best = dd; startBody = b; }
          }
        }
      }

      // ── repair the discharge ────────────────────────────────────────────
      // Discharge only ever grows downstream, and the raw sample drops to the
      // headwater minimum roughly one point in eight where the D8 walk strays
      // a texel off the channel core. A running maximum is the exact repair.
      // Water.js used to do this with a windowed maximum instead, which also
      // dragged the next confluence's width five stations upstream — and would
      // now undo the mouth's decay, so it moves here where it belongs: the
      // carve and the ribbon have to agree about how wide the channel is.
      for (let k = 1; k < n0; k++) if (pm[k] < pm[k - 1]) pm[k] = pm[k - 1];
      {
        const B = 6, tmp = new Float32Array(n0);
        for (let k = 0; k < n0; k++) {
          let s = 0, c = 0;
          for (let j = Math.max(0, k - B); j <= Math.min(n0 - 1, k + B); j++) { s += pm[j]; c++; }
          tmp[k] = s / c;
        }
        pm.set(tmp.subarray(0, n0));
      }

      // ── take the staircase out of the centreline ────────────────────────
      // flowDir is D8 on a 2 m grid, so every raw trace is a 45°/90° zigzag
      // with a ~4 m period, and until now nothing smoothed the *position*:
      // Water.js smoothed the width and the discharge and then swept the
      // ribbon along the original staircase coordinates.
      //
      // Laplacian passes rather than Chaikin, because the displacement of
      // every point is re-clamped against its ORIGINAL position on each pass
      // and so the line can never leave its own valley however hard it is
      // smoothed. The clamp is a fraction of the channel half-width, and that
      // is what makes this width-aware without a per-reach iteration count: a
      // 12 m trunk may cut five metres off a hairpin, a 2 m brook is held to
      // within a texel of the bed it actually cut.
      for (let k = 0; k < n0; k++) lim[k] = Math.max(texel * 1.5, (1.2 + pm[k] * 11) * 0.6);
      for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
        tx[0] = px[0]; tz[0] = pz[0];
        tx[n0 - 1] = px[n0 - 1]; tz[n0 - 1] = pz[n0 - 1];
        for (let k = 1; k < n0 - 1; k++) {
          tx[k] = px[k] + ((px[k - 1] + px[k + 1]) * 0.5 - px[k]) * 0.55;
          tz[k] = pz[k] + ((pz[k - 1] + pz[k + 1]) * 0.5 - pz[k]) * 0.55;
        }
        for (let k = 0; k < n0; k++) {
          let dx = tx[k] - ox[k], dz = tz[k] - oz[k];
          // Saturated, not clipped. A hard projection onto the circle of
          // radius lim puts every point of a tight bend on the boundary and
          // the line then inherits the boundary's corners — measured, 1.8% of
          // stations came out with a turning radius smaller than the channel
          // width, which is the contract's own definition of "sharp". tanh
          // takes the same limit asymptotically and is smooth everywhere.
          const L = Math.hypot(dx, dz);
          if (L > 1e-9) {
            const q = L / lim[k];
            const s = 1 / Math.pow(1 + q * q * q * q * q * q, 1 / 6);
            dx *= s; dz *= s;
          }
          px[k] = ox[k] + dx; pz[k] = oz[k] + dz;
        }
      }

      // ── meander ─────────────────────────────────────────────────────────
      // D8 steepest descent on a smooth fractal heightfield produces very
      // nearly direct paths, and de-staircasing them only makes that visible:
      // measured over 288 trunks the sinuosity was median 1.08, and the LONGEST
      // trunks — the ones that fill a frame — were the straightest at 1.07.
      // Geomorphology calls anything under 1.05 straight and a lowland
      // meandering river 1.4-3.0. Nothing in this generator ever produced a
      // meander; smoothing did not remove the sinuosity, it revealed that there
      // was none.
      //
      // A sine-generated curve is the standard model of one (Langbein &
      // Leopold): the direction angle swings sinusoidally along the path, and
      // the sinuosity is then 1/J0(w) in the peak swing w — 1.1 rad of swing is
      // 1.4. Expressed as a lateral offset of amplitude A at wavelength L that
      // is w = 2*pi*A/L, and the wavelength of a natural meander train is
      // 10-14 channel widths. So both scales come off the width this reach
      // already carries, which is what makes a 12 m trunk swing forty metres
      // and a 2 m brook barely wander.
      //
      // The signal is fbm rather than a sine so that no two bends are the same
      // length, and the phase is integrated per station so a channel that
      // widens downstream lengthens its meanders as it goes.
      {
        cum[0] = 0;
        for (let k = 1; k < n0; k++) cum[k] = cum[k - 1] + Math.hypot(px[k] - px[k - 1], pz[k] - pz[k - 1]);
        const len = cum[n0 - 1];
        if (len > MIN_REACH) {
          const nrm = this.noise;
          const phase = new Float64Array(n0);
          const offs = new Float64Array(n0);
          const nrmX = new Float64Array(n0), nrmZ = new Float64Array(n0);
          const cap = new Float64Array(n0), amp = new Float64Array(n0);
          const seed = (head.i % 977) * 3.77;
          for (let k = 1; k < n0; k++) {
            const wch = 1.2 + pm[k] * 11;
            phase[k] = phase[k - 1] + (cum[k] - cum[k - 1]) / (MEANDER_WAVE * wch);
          }
          for (let k = 0; k < n0; k++) {
            const wch = 1.2 + pm[k] * 11;
            // Unit normal, from a tangent taken over a few stations so the
            // offset direction is not itself noisy.
            const a = Math.max(0, k - 3), b = Math.min(n0 - 1, k + 3);
            const tx2 = px[b] - px[a], tz2 = pz[b] - pz[a];
            const tl = Math.hypot(tx2, tz2) || 1;
            const nx = -tz2 / tl, nz = tx2 / tl;

            // A sine with a wandering phase, not amplitude-modulated noise.
            // Bends in a real meander train are close to a constant amplitude
            // and irregular in *spacing*; fbm gives the opposite, and its RMS
            // is only 0.27 of full scale, which held the mean lateral offset
            // to 2.2 m where the channel had 9.2 m of room. Phase modulation
            // puts the irregularity where it belongs and lets the crests reach
            // the amplitude the sinuosity target is computed from.
            const sig = Math.sin(phase[k] * Math.PI * 2
                                 + nrm.fbm(phase[k] * 0.35, seed, 2, 2.0, 0.5, 1) * MEANDER_GAIN);
            // How far the valley floor lets it go, each way independently, so
            // a bend fills the flat it is in and stops at the bank. Without
            // this the meander climbs the hillside, which is worse than a
            // straight line.
            const want = MEANDER_AMP * wch;
            // The bar the ground has to clear is the reach's own bed, not the
            // ground it happens to be standing on: the carve that follows this
            // line cuts 0.8 + discharge^2 * 6 metres, so a river can migrate
            // anywhere it can cut down to its own bed, and a trunk in an
            // eroded V has far more room than the un-carved surface suggests.
            // Measured against the pre-carve surface alone the gate closed at
            // the first texel almost everywhere and the meander never grew:
            // median sinuosity moved 1.081 -> 1.089.
            const ref = pb[k] + MEANDER_FREEBOARD + (0.8 + pm[k] * pm[k] * 6.0) * 0.8;
            let room = want;
            const dir = sig >= 0 ? 1 : -1;
            for (let t = texel; t <= want; t += texel) {
              const gx = Math.round((px[k] + nx * dir * t + half) / texel);
              const gz = Math.round((pz[k] + nz * dir * t + half) / texel);
              if (gx < 0 || gz < 0 || gx >= R || gz >= R) { room = t - texel; break; }
              if (this.height[gz * R + gx] > ref) { room = t - texel; break; }
            }
            // Taper to nothing at both ends: the head is a confluence or a
            // spill point and the tail is a waterline, and neither may move.
            const taperM = Math.min(20, len * 0.2);
            const tp = Math.min(1, Math.min(cum[k], len - cum[k]) / Math.max(taperM, 1e-3));
            // `sig` carries the sign; `dir` only chose which side to probe for
            // room, so the magnitude and the side are applied once each.
            // A slow envelope over the whole train. Bends of one constant
            // amplitude for a kilometre read as a decorative squiggle rather
            // than as a river; real reaches alternate between tight bend
            // trains and long gentle sweeps, and the envelope's wavelength is
            // several meanders, so it does not fight the bends themselves.
            const env = 0.45 + 0.55 * (nrm.fbm(phase[k] * 0.17 + 41.0, seed, 2, 2.0, 0.5, 1) * 0.5 + 0.5);
            cap[k] = Math.min(want, room) * tp * env;
            amp[k] = Math.abs(sig) * dir;
            nrmX[k] = nx; nrmZ[k] = nz;
          }
          // Smooth the CAP, not the offset. The valley's available width is a
          // smooth quantity and the probe that measures it is not — it steps a
          // texel at a time, so `room` jitters station to station and puts a
          // corner in the line wherever it changes. Smoothing the finished
          // offset instead also attenuates the meander, badly on a narrow
          // brook where the wavelength is only ten stations: measured, median
          // sinuosity 1.354 -> 1.204 for a fifth of the sharp-corner count.
          // The signal is already smooth; only its ceiling is not.
          for (let pass = 0; pass < 4; pass++) {
            for (let k = 1; k < n0 - 1; k++) {
              cap[k] += ((cap[k - 1] + cap[k + 1]) * 0.5 - cap[k]) * 0.5;
            }
          }
          for (let k = 0; k < n0; k++) {
            offs[k] = amp[k] * cap[k];
            tx[k] = px[k] + nrmX[k] * offs[k];
            tz[k] = pz[k] + nrmZ[k] * offs[k];
          }
          // Two light unconstrained passes: the offset is band-limited but the
          // room gate is not, so a bend that runs into a bank gets a corner
          // where it was clipped. Endpoints stay pinned.
          for (let pass = 0; pass < 2; pass++) {
            for (let k = 1; k < n0 - 1; k++) {
              tx[k] += ((tx[k - 1] + tx[k + 1]) * 0.5 - tx[k]) * 0.5;
              tz[k] += ((tz[k - 1] + tz[k + 1]) * 0.5 - tz[k]) * 0.5;
            }
          }
          // A meander that crosses itself is an oxbow the moment it forms, and
          // we have no mechanism to cut one off. Non-adjacent stations closer
          // than a channel width get pulled back toward the unmeandered line
          // until they are not.
          // The window is in METRES of channel, not in station indices. Station
          // spacing is one texel, so an index window of "four stations" is 8 m
          // at res 1536 and 16 m at res 768 — under a channel width in the
          // first case, which made every station of every wide river look like
          // a near-crossing with its own immediate neighbours and pulled the
          // entire meander back onto the axis. Two neighbouring stations of a
          // 12 m river are SUPPOSED to be less than 12 m apart.
          for (let guard = 0; guard < 4; guard++) {
            let hit = false;
            for (let k = 0; k < n0; k++) {
              const wch = 1.2 + pm[k] * 11;
              const near = cum[k] + wch * 4;             // ignore anything nearer than this along the line
              const far = cum[k] + MEANDER_WAVE * wch * 1.3;
              for (let j = k + 1; j < n0 && cum[j] < far; j++) {
                if (cum[j] < near) continue;
                const dd = Math.hypot(tx[j] - tx[k], tz[j] - tz[k]);
                if (dd >= wch * 1.2) continue;
                hit = true;
                tx[k] = (tx[k] + px[k]) * 0.5; tz[k] = (tz[k] + pz[k]) * 0.5;
                tx[j] = (tx[j] + px[j]) * 0.5; tz[j] = (tz[j] + pz[j]) * 0.5;
              }
            }
            if (!hit) break;
          }
          for (let k = 0; k < n0; k++) { px[k] = tx[k]; pz[k] = tz[k]; }
          // The base elevation has to be re-read where the line actually is
          // now, or the water surface follows ground the channel has left.
          for (let k = 0; k < n0; k++) {
            const gx = Math.min(R - 1, Math.max(0, Math.round((px[k] + half) / texel)));
            const gz = Math.min(R - 1, Math.max(0, Math.round((pz[k] + half) / texel)));
            pb[k] = filled[gz * R + gx];
          }
        }
      }

      cum[0] = 0;
      for (let k = 1; k < n0; k++) cum[k] = cum[k - 1] + Math.hypot(px[k] - px[k - 1], pz[k] - pz[k - 1]);
      const total = cum[n0 - 1];
      if (total < MIN_REACH) continue;

      // Unit tangents at the two ends, for the runs that carry on past the
      // waterline at either end. Over eight points, not three: a three-point
      // baseline is 6 m at res 1536 and picks up whatever wobble the smoothing
      // left, and the extrapolation then leaves the line at an angle to it — a
      // 120 degree corner at the last station of a mouth, measured, which
      // sweeps the ribbon back over itself in the delta.
      const e0 = Math.min(n0 - 1, 8), e1 = Math.max(0, n0 - 9);
      const hx0 = px[0] - px[e0], hz0 = pz[0] - pz[e0];
      const l0 = Math.hypot(hx0, hz0) || 1;
      const hx1 = px[n0 - 1] - px[e1], hz1 = pz[n0 - 1] - pz[e1];
      const l1 = Math.hypot(hx1, hz1) || 1;

      // Arc-length sampler over the smoothed line, extrapolating straight off
      // either end so the mouth reaches open water and the outlet is born in it.
      let cursor = 0;
      const at = (s, out) => {
        if (s <= 0) {
          out.x = px[0] + (hx0 / l0) * -s; out.z = pz[0] + (hz0 / l0) * -s;
          out.m = pm[0]; out.b = pb[0]; return out;
        }
        if (s >= total) {
          const e = s - total;
          out.x = px[n0 - 1] + (hx1 / l1) * e; out.z = pz[n0 - 1] + (hz1 / l1) * e;
          out.m = pm[n0 - 1]; out.b = pb[n0 - 1]; return out;
        }
        while (cursor < n0 - 2 && cum[cursor + 1] < s) cursor++;
        while (cursor > 0 && cum[cursor] > s) cursor--;
        const seg = cum[cursor + 1] - cum[cursor];
        const t = seg > 1e-6 ? (s - cum[cursor]) / seg : 0;
        out.x = px[cursor] + (px[cursor + 1] - px[cursor]) * t;
        out.z = pz[cursor] + (pz[cursor + 1] - pz[cursor]) * t;
        out.m = pm[cursor] + (pm[cursor + 1] - pm[cursor]) * t;
        out.b = pb[cursor] + (pb[cursor + 1] - pb[cursor]) * t;
        return out;
      };

      // Neither ramp may eat the whole reach; a 60 m connector between two
      // lakes is legitimately almost all mouth, a 600 m trunk is not.
      const mLen = endBody >= 0 ? Math.min(MOUTH_LEN, total * 0.45) : 0;
      const oLen = startBody >= 0 ? Math.min(OUTLET_LEN, total * 0.45) : 0;
      // The runs past either waterline are straight extrapolations, so they
      // have to be walked out one step at a time and stopped the moment they
      // leave the water. A reach that arrives at a perched pool on a lip had
      // its outlet projected ten metres back along its own tangent — straight
      // out over the void — and drew a flared, dead-flat blue chevron pinned to
      // a vertical rock face in the waterfall view.
      const probe = { x: 0, z: 0, m: 0, b: 0 };
      const overWater = (s, body) => {
        at(s, probe);
        const gx = Math.round((probe.x + half) / texel);
        const gz = Math.round((probe.z + half) / texel);
        if (gx < 0 || gz < 0 || gx >= R || gz >= R) return false;
        return lakeId[gz * R + gx] === body;
      };
      let sStart = 0, sEnd = total;
      if (startBody >= 0) {
        for (let s = -2; s >= -OUTLET_PRE; s -= 2) {
          if (!overWater(s, startBody)) break;
          sStart = s;
        }
      }
      if (endBody >= 0) {
        for (let s = total + 2; s <= total + MOUTH_INTO; s += 2) {
          if (!overWater(s, endBody)) break;
          sEnd = s;
        }
      }

      const sta = [];
      const tmpP = { x: 0, z: 0, m: 0, b: 0 };
      for (let s = sStart; ; ) {
        at(s, tmpP);
        const m = tmpP.m;
        const lkM = mLen > 0 ? clamp01((s - (total - mLen)) / mLen) : 0;
        const lkO = oLen > 0 ? clamp01((oLen - s) / oLen) : 0;
        const lk = Math.max(lkM, lkO);
        // The bed shallows and the water thins as the channel spreads out.
        // Both have to go to nothing or the delta is a trench with a step in
        // the surface at the end of it.
        const dcarve = (0.8 + m * m * 6.0) * (1 - lk);
        const wdep = 0.22 + m * 0.9 * (1 - lk * 0.75);
        sta.push({
          s, x: tmpP.x, z: tmpP.z, m, lake: lk, lkM, lkO,
          dcarve, wdep,
          surf: tmpP.b - dcarve + wdep,
          w: 0,
        });
        if (s >= sEnd) break;
        // Station spacing scales with the channel: a 12 m trunk does not need
        // the same density as a 1.5 m brook, and the header is JSON.
        let ns = s + clamp(m * 11 * 0.35, 2.0, 6.0);
        // Snap to the end rather than leaving a sliver behind it. A five
        // centimetre final segment has an essentially arbitrary direction, and
        // the ribbon's last cross-section is swept perpendicular to it: a 120
        // degree kink in the last quad of a mouth, measured, for a segment too
        // short to be worth having.
        if (sEnd - ns < 1.0) ns = sEnd;
        s = Math.min(sEnd, ns);
      }
      if (sta.length < 5) continue;

      // ── one continuous water surface ────────────────────────────────────
      // Monotone first — water never runs uphill, and a confluence can hand a
      // reach a `filled` sample a few centimetres above its predecessor — then
      // the lake anchors, which are exact. River surface and lake surface used
      // to be two different functions of two different fields (`bed + 0.22 +
      // rm*0.9` against `filled + 0.05`), and the step where a channel reached
      // standing water is what that disagreement looked like.
      for (let k = 1; k < sta.length; k++) {
        if (sta[k].surf > sta[k - 1].surf) sta[k].surf = sta[k - 1].surf;
      }
      if (endBody >= 0) {
        const lv = bodies[endBody].level;
        for (const p of sta) if (p.lkM > 0) p.surf = lerp(p.surf, lv, p.lkM);
      }
      if (startBody >= 0) {
        const lv = bodies[startBody].level;
        for (const p of sta) if (p.lkO > 0) p.surf = lerp(p.surf, lv, p.lkO);
      }

      // ── backwater ────────────────────────────────────────────────────────
      // Water cannot stand below the water it drains into, and until this pass
      // existed it did: `lakeDepth` is measured on the PRE-carve terrain, so a
      // trace is clipped where the untouched ground meets the lake and the
      // carve then incises its bed up to 5.7 m below that. The mouth ramp then
      // had to climb back out — 65 of 288 reaches ran measurably uphill, and
      // one 30 m strait between two lakes at the same level dipped 5.6 m in
      // the middle and came back, a trench of water with a lake at each end.
      //
      // A backward maximum is both the guarantee (monotone downhill, which the
      // forward pass alone stops giving once the lake anchors are applied) and
      // the phenomenon: where a channel is cut below the level of the lake it
      // enters, the lake reaches up it. That is a drowned mouth, and it ends
      // by itself where the natural surface climbs past the lake.
      for (let k = sta.length - 2; k >= 0; k--) {
        if (sta[k].surf < sta[k + 1].surf) {
          const raised = sta[k + 1].surf - sta[k].surf;
          sta[k].surf = sta[k + 1].surf;
          // Raised water is standing water. Half a metre of backwater is a
          // slack pool at the mouth; anything more is an arm of the lake, and
          // it should flare, stop flowing and stop foaming like one.
          const drown = clamp01(raised / 0.5);
          if (drown > sta[k].lake) sta[k].lake = drown;
        }
      }
      // Width, and the bed profile the carve cuts, both follow the FINAL lake
      // value — the drowned part of a mouth is as wide and as shallow as the
      // ramped part, or the delta has a trench down the middle of it.
      for (const p of sta) {
        p.dcarve = (0.8 + p.m * p.m * 6.0) * (1 - p.lake);
        p.wdep = 0.22 + p.m * 0.9 * (1 - p.lake * 0.75);
        p.w = (1.2 + p.m * 11) * (1 + p.lake * (MOUTH_FLARE - 1));
      }

      // Publish where this reach's centreline actually ended up, cell by cell,
      // so a tributary arriving later can finish on it.
      for (let k = 0; k < n0; k++) {
        const gx = Math.min(R - 1, Math.max(0, Math.round((ox[k] + half) / texel)));
        const gz = Math.min(R - 1, Math.max(0, Math.round((oz[k] + half) / texel)));
        const ci = gz * R + gx;
        ownerX[ci] = px[k]; ownerZ[ci] = pz[k];
      }

      channels.push(sta);
    }

    this.channels = channels;
    // The published contract, and only the published contract: every extra
    // property here is paid for in the bake header, which is JSON and already
    // a couple of megabytes. Rounded for the same reason — 0.1 is three
    // characters where 0.11999999731779099 is nineteen, and a decimetre is two
    // orders finer than anything a ribbon metres wide can show. Height keeps a
    // centimetre because a step in a water surface is visible at that scale.
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    this.riverPolylines = channels.filter((sta) => {
      let w = 0;
      for (const p of sta) if (p.w > w) w = p.w;
      return w >= PUBLISH_MIN_W;
    }).map((sta) => sta.map((p) => ({
      x: r1(p.x), y: r2(p.surf), z: r1(p.z),
      w: r1(p.w), flow: r3(p.m * (1 - p.lake)), lake: r3(p.lake),
    })));
    return this.riverPolylines;
  }

  // ── 7. Climate / moisture / biome weights ──────────────────────────────────
  _climate() {
    const R = this.res, N = R * R, h = this.height;
    const moisture = new Float32Array(N);
    const n = this.noise;

    // Distance-to-water via a cheap multi-pass jump flood on the river mask.
    // Seeded from the drainage network, not from the drawn water surface. A
    // valley bottom is moist because water collects there, whether or not a
    // ribbon is swept along it — and once the water grid became a rasterisation
    // of the traced centrelines, tying moisture to it made the forest a
    // function of how many reaches survived the trace. Measured: mean moisture
    // 0.54 -> 0.41 and the near ridge of the hero frame lost its trees.
    //
    // Same argument for the hollows. A pan too small and too shallow to draw as
    // a lake still collects water, and there are thousands of them strewn over
    // this valley floor; dropping them from the *seed* moved the mean distance
    // to water from 26 m to 46 m and took a fifth of the forest with it.
    const dist = new Float32Array(N).fill(1e9);
    for (let i = 0; i < N; i++) {
      if (this.water[i] > -9000 || this.flow[i] > RIVER_MIN || this.lakeDepth[i] > DAMP_MIN_DEPTH) dist[i] = 0;
    }
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

    // ...and publish it, in metres, because every shoreline rule downstream is
    // a function of this and until now the bake computed it, used it for
    // moisture, and threw it away.
    //
    // What consumers had instead was `WorldData.distToShoreApprox`, which
    // returns 0 where the *channel* mask is non-zero and 8 otherwise. Two
    // values, no gradient, and — because the channel mask is identically zero
    // over standing water — blind to every lake in the world. It is live in
    // `getSurfaceWeights` gating the `sand` term, so that term was a step
    // function: measured over 19,138 dry sample points this round, mean sand
    // weight inside the mask 0.992 and outside it 0.004. Fully on or fully
    // off. That is the hard-edged pale slab across the foreground of the
    // `mouth` framing, and widening the river mask this round (0.95% of the
    // map to 2.3%, and continuous across the channel rather than a ridge along
    // its middle) made it 2.4x larger without changing anything about it.
    //
    // Capped at 48 m so it quantises to u8 at 19 cm — finer than the 2 m grid
    // it is derived from, and nothing downstream cares about a shoreline
    // fifty metres away. Note `moisture` above deliberately keeps reading the
    // uncapped cell distance over its own 90 m range; the cap is on what is
    // published, not on what the climate model sees.
    const distM = new Float32Array(N);
    for (let i = 0; i < N; i++) distM[i] = Math.min(dist[i] * texel, 48);
    this.distToWaterM = distM;
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

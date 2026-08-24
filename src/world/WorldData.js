// ─────────────────────────────────────────────────────────────────────────────
//  WorldData — the single source of truth every system samples from.
//  Terrain mesh, physics, scatter placement, wildlife pathing and the camera
//  all read heights through here, so nothing can ever disagree about the ground.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { WORLD, BIOME } from './WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep, bilinear } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';
import { buildHydroField } from './hydroField.js';

export class WorldData {
  constructor(baked, seed = 20261018) {
    this.res = baked.res;
    this.worldSize = baked.worldSize;
    this.half = baked.worldSize / 2;
    this.texel = baked.worldSize / baked.res;
    this.invTexel = 1 / this.texel;

    this.height = baked.height;
    this.water = baked.water;
    this.riverMask = baked.riverMask;
    this.flow = baked.flow;
    this.moisture = baked.moisture;
    this.hardness = baked.hardness;
    this.sediment = baked.sediment;
    this.slopeMap = baked.slope;
    this.waterfalls = baked.waterfalls;
    this.riverPolylines = baked.riverPolylines;
    // The flow field. See TerrainGen._flowField: this is what lets ONE water
    // surface be a lake in one place and a river in another.
    this.flowVX = baked.flowVX;
    this.flowVZ = baked.flowVZ;
    this.flowQ = baked.flowQ;
    this.flowT = baked.flowT;
    this.minHeight = baked.minHeight;
    this.maxHeight = baked.maxHeight;

    this.noise = new NoiseField(seed ^ 0xbeef);
    this._v = new THREE.Vector3();
    this.hydro = buildHydroField(this.height, this.water, this.res, this.worldSize);
    this._repairWaterfalls();
    this._buildTextures();
    this._buildRoadNetwork();
  }

  /**
   * The plunge point of a waterfall is a WATER SURFACE sample, and the water
   * grid's "no water here" sentinel is -9999.
   *
   * `TerrainGen._waterfalls` walks downstream from the lip until the drop per
   * cell falls under 0.9 m and writes `water[cur]` as the bottom. That walk
   * follows `flowDir`, which does not stop at the river mask, so the terminus
   * is very often a dry cell — and the sentinel is then written into the record
   * as a height in metres. Counted straight out of the shipped 1536 bake's
   * header, which carries the waterfall records verbatim: **11 of 28 falls**.
   *
   * By height they are ranks 3, 5 and 6 (88.8 m, 68.3 m, 67.4 m) and eight
   * smaller, down to 18.4 m. The **two tallest are clean** — 93.7 m and 90.4 m
   * — and so is the 93.7 m fall at (-732, 10) that every canonical camera
   * anchor is built on. This paragraph previously read "8 of 28 falls, and all
   * four of the tallest, including the one every camera anchor is built on",
   * which is the failure docs/CRITIC_PROTOCOL.md's table is about: a
   * well-measured number attached to the wrong object. No bake on disk yields
   * 8 of 28 — the 768 bake is 13 of 25 and the 512 bake is 5 of 19 — and the
   * anchor fall is one of the two that never carried the sentinel at all.
   *
   * What is true, and is why the anchored views showed the defect anyway: fall
   * #13, 42.1 m, plunges at (-742, 28), twenty-one metres from that anchor and
   * squarely inside the `waterfall` and `fallbase` framings. The frames were
   * right about the broken foot; the attribution was not.
   *
   * Nothing downstream range-checked it:
   *
   *   - `Waterfalls._buildPaths` clamps its last path point to `bottom[1]+0.4`,
   *     so the curtain's final vertex sat at -9998.6 m and the 1-2-1 smoothing
   *     dragged the last few rows of the sheet thousands of metres with it.
   *   - The impact burst and the mist are both spawned from that same last
   *     point, so eleven falls — including three of the six biggest — had **no
   *     spray, no mist and no churn at their feet at all** — the "bottom of the
   *     waterfall looks horrible" defect, in one number.
   *   - `audio/water.js` puts each fall's emitter a third of the way up the
   *     drop, i.e. at -6714 m, so they were inaudible too.
   *
   * Repairing it here rather than in `TerrainGen` is deliberate: the bake cache
   * key is an FNV hash of `TerrainGen.js` alone, so fixing it there would
   * invalidate every `.pab` on disk and leave the shipped bakes still carrying
   * the sentinel. Here it fixes the world every consumer sees, on the bakes
   * that exist. The generator should still stop writing it — filed in
   * `docs/INTEGRATION_REQUESTS.md`.
   */
  _repairWaterfalls() {
    const list = this.waterfalls;
    if (!list?.length) return;
    let fixed = 0;
    for (const wf of list) {
      const [bx, , bz] = wf.bottom;
      const ground = this.getHeight(bx, bz);
      const surf = this.getWaterHeight(bx, bz);
      const level = surf !== null && surf > ground ? surf : ground;
      // Repair anything outside the map's own vertical range, not just the
      // exact sentinel: a NaN or a wild value has to be caught by the same
      // gate or this is a guard against one literal rather than against bad
      // data. Stated positively — keep the value only if it is provably sane —
      // so a NaN fails the test instead of surviving it.
      const sane = (v) => Number.isFinite(v) && v > this.minHeight - 50 && v < this.maxHeight + 50;
      if (!sane(wf.bottom[1])) { wf.bottom[1] = level; fixed++; }
      if (!sane(wf.top[1])) wf.top[1] = this.getHeight(wf.top[0], wf.top[2]);
      // A plunge above its own lip is the same class of defect and reads as a
      // fall running backwards; keep the pair ordered.
      if (wf.bottom[1] > wf.top[1] - 0.5) wf.bottom[1] = wf.top[1] - Math.max(1, wf.height * 0.5);
    }
    if (fixed) console.warn(`[world] repaired ${fixed}/${list.length} waterfall plunge points ` +
                            `carrying the water grid's -9999 sentinel`);
  }

  // World XZ -> heightmap texel space
  toGrid(x, z) {
    return [(x + this.half) * this.invTexel, (z + this.half) * this.invTexel];
  }

  // Micro-detail added on top of the baked heightmap.
  //
  // MEASURED range -0.427 .. +0.438 m, RMS 0.131 m, over octave wavelengths
  // 18.2 / 8.3 / 4.8 / 3.8 / 2.0 m. It is the difference between the ground the
  // player drives over and the field every shader samples, and it is applied
  // here so the terrain mesh, the collider and the scatterers all get the same
  // ground.
  //
  // ── faded out at the waterline ──────────────────────────────────────────
  //
  // Because at a shoreline it is not detail, it is noise on the one curve in
  // the frame the eye reads as a hard edge. Half a metre of bump on a bank
  // whose gradient is 1:30 moves the visible waterline fifteen metres, and the
  // bumps are 2-8 m across — which is precisely the lobed, scalloped edge this
  // round exists to remove, arriving from the geometry after the bake has been
  // conditioned to remove it from the field.
  //
  // The taper is in metres of ground, from the hydro field's signed distance,
  // so it is a real distance and not a depth over a gradient: nothing within
  // 1.5 m of the waterline, full strength again by 9 m out. That band is a
  // twentieth of a percent of the map's area and the flattening is invisible
  // anywhere except where it is the whole point.
  microDetail(x, z) {
    const n = this.noise;
    const d = n.fbm(x * 0.055, z * 0.055, 3, 2.2, 0.45, 1) * 0.42
            + n.fbm(x * 0.21, z * 0.21, 2, 2.4, 0.4, 1) * 0.11;
    const h = this.hydro;
    if (!h) return d;
    const HR = h.res;
    // -0.25, not -0.5. The hydro field is stored at half the bake's resolution
    // by area-averaging pairs, so sample k represents (k + 0.25) hydro texels
    // from the corner, not (k + 0.5). MEASURED on a synthetic half-plane whose
    // true waterline is at x = -55.000: with -0.5 this fade's zero landed at
    // -54.000, with -0.25 at -55.000 exactly. Two metres per axis from the
    // shader's own registration error in the opposite direction, which is how
    // two mild bugs become one 2.83 m one.
    const gx = clamp((x + this.half) / h.texel - 0.25, 0, HR - 1.001);
    const gz = clamp((z + this.half) / h.texel - 0.25, 0, HR - 1.001);
    const sd = Math.abs(bilinear(h.sdf, HR, HR, gx, gz));
    if (sd >= 9) return d;
    const t = clamp01((sd - 1.5) / 7.5);
    return d * (t * t * (3 - 2 * t));
  }

  /** Ground height in metres at world (x, z). */
  getHeight(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    const h = bilinear(this.height, this.res, this.res, gx, gz);
    return h + this.microDetail(x, z);
  }

  /** Height without micro-detail — used where the collider must match the mesh LOD. */
  getBaseHeight(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    return bilinear(this.height, this.res, this.res, gx, gz);
  }

  /** Surface normal via central differences. */
  getNormal(x, z, out = new THREE.Vector3(), eps = 1.0) {
    const hL = this.getHeight(x - eps, z), hR = this.getHeight(x + eps, z);
    const hD = this.getHeight(x, z - eps), hU = this.getHeight(x, z + eps);
    return out.set(hL - hR, 2 * eps, hD - hU).normalize();
  }

  /** 0 = flat, 1 = vertical. */
  getSlope(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    return bilinear(this.slopeMap, this.res, this.res, gx, gz);
  }

  getMoisture(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    return bilinear(this.moisture, this.res, this.res, gx, gz);
  }

  getRiver(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    return bilinear(this.riverMask, this.res, this.res, gx, gz);
  }

  /**
   * Bilinear sample of the hydro field at world (x, z):
   * `{ sdf, span, depth, wet }` — see hydroField.js for what each channel is.
   *
   * The -0.25 texel registration is mandatory and measured, not taste: the
   * field is stored at HALF the bake's resolution by area-averaging pairs, so
   * sample k represents (k + 0.25) hydro texels from the corner — see the note
   * in `microDetail` above. Public so consumers (the boat's launch-site tests
   * were the fourth) stop inlining their own copies of that constant.
   */
  getHydro(x, z, out = {}) {
    const h = this.hydro;
    if (!h) { out.sdf = -1e9; out.span = 0; out.depth = -1; out.wet = 0; return out; }
    const HR = h.res;
    const gx = clamp((x + this.half) / h.texel - 0.25, 0, HR - 1.001);
    const gz = clamp((z + this.half) / h.texel - 0.25, 0, HR - 1.001);
    out.sdf = bilinear(h.sdf, HR, HR, gx, gz);
    out.span = bilinear(h.span, HR, HR, gx, gz);
    out.depth = bilinear(h.depth, HR, HR, gx, gz);
    out.wet = bilinear(h.wet, HR, HR, gx, gz);
    return out;
  }

  /** The drawn water surface, handed over by Water._buildSurface. */
  setWaterField(field) { this._water = field; }

  getWaterHeight(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    const gxi = clamp(Math.round(gx), 0, this.res - 1);
    const gzi = clamp(Math.round(gz), 0, this.res - 1);
    const raw = this.water[gzi * this.res + gxi];
    const w = raw < -9000 ? null : raw;
    // The drawn mesh is not a point sample of this grid: it coarsens the 2 m
    // texels into a 4 m quad, dilates outward so the shoreline fade has
    // geometry to finish inside, and averages each vertex over the quads that
    // touch it. So the two derivations disagreed, and this query — the one every
    // other system trusts — was the wrong one: it returned null under 4-5% of
    // water over four metres deep, and at (-768, 832) reported dry ground under
    // 41.1 m of drawn water. That is somewhere an animal can stand, grass can
    // grow, and the chase camera sinks with no floor under it.
    //
    // Answer for the surface that is actually DRAWN, and take the higher of the
    // two where both know something — under-reporting is the only direction that
    // puts an animal in a lake or takes the floor out from under the camera.
    // Over the dry part of the dilation ring the level is below the terrain, so
    // getWaterDepth still returns 0 and nothing there changes: measured, the
    // ring splits 35 774 dry / 181 wet, identical before and after.
    const m = this._water ? this._water.levelAt(x, z) : null;
    if (w === null) return m;
    if (m === null) return w;
    return w > m ? w : m;
  }

  /** Depth of water above the bed; <= 0 means dry. */
  getWaterDepth(x, z) {
    const w = this.getWaterHeight(x, z);
    if (w === null) return 0;
    return Math.max(0, w - this.getHeight(x, z));
  }

  /**
   * Depth for contact effects and vehicle physics. The drawn water mesh extends
   * past the actual waterline so the shader can render a damp shoreline fade;
   * that margin is visible water-adjacent geometry, but a tyre on it is still
   * on dry ground and must not trigger splash, bow-wave audio or drag.
   */
  getWaterContactDepth(x, z) {
    const h = this.getHydro(x, z, this._hydroContact ??= {});
    if (h.sdf <= 0 || h.depth <= 0) return 0;
    const m = this._water?.depthAt?.(x, z);
    if (m !== null && m !== undefined) return Math.max(0, Math.min(m, h.depth));
    return h.depth;
  }

  isInBounds(x, z) {
    return x > -this.half && x < this.half && z > -this.half && z < this.half;
  }

  /** Biome classification driven by altitude, slope, moisture and rivers. */
  getBiome(x, z) {
    const h = this.getHeight(x, z);
    const s = this.getSlope(x, z);
    const m = this.getMoisture(x, z);
    const r = this.getRiver(x, z);
    const depth = this.getWaterDepth(x, z);
    if (depth > 0.05) return BIOME.WETLAND;
    if (r > 0.05 || depth > 0) return BIOME.RIVERBANK;
    if (s > 0.85) return BIOME.ROCKY;
    if (h > 205) return BIOME.ALPINE;
    if (m > 0.52) return BIOME.FOREST;
    return BIOME.MEADOW;
  }

  /**
   * Continuous surface weights the terrain shader and scatterers both use.
   * Returns { grass, dry, rock, dirt, snow, sand, litter }.
   */
  getSurfaceWeights(x, z, out = {}) {
    const h = this.getHeight(x, z);
    const s = this.getSlope(x, z);
    const m = this.getMoisture(x, z);
    const depth = this.getWaterDepth(x, z);
    const distShore = clamp01(depth * 4);

    const rockW = smoothstep(0.55, 1.15, s) + smoothstep(230, 300, h) * 0.6;
    const snowW = smoothstep(258, 320, h) * (1 - smoothstep(0.9, 1.4, s));
    // Bare shore, and it has to be *narrow*. Reference plate 3 puts gold grass
    // right to the waterline with a bright broken lace on it and no bare sand
    // anywhere; plate 5 puts grass tufts straight against whitewater. A wide
    // pale beach is not in the art direction at all, and the previous form —
    // a step function on the two-valued shore stub — drew one across the whole
    // foreground of the `mouth` framing.
    //
    // 2.2 m of real distance, and capped well below 1 so the gold underneath
    // still reads through it. This is a damp margin the grass thins over, not
    // a surface of its own.
    const sandW = smoothstep(0.9, 0.0, depth)
                * smoothstep(2.2, 0.15, this.getDistToWater(x, z)) * 0.72;
    const grassW = clamp01((1 - rockW) * (0.35 + m * 0.85)) * (1 - snowW);
    const dryW = clamp01((1 - rockW) * (1 - m) * 1.1) * (1 - snowW);
    const dirtW = clamp01(smoothstep(0.35, 0.75, s) * (1 - snowW) * 0.7);

    out.rock = clamp01(rockW);
    out.snow = clamp01(snowW);
    out.sand = clamp01(sandW * (1 - distShore));
    out.grass = grassW;
    out.dry = dryW;
    out.dirt = dirtW;
    out.litter = clamp01(m * 0.6 + 0.2);
    return out;
  }

  /**
   * Metres to the nearest water, from the baked chamfer field. Capped at 48.
   *
   * This replaces `distToShoreApprox`, which returned 0 where the *channel*
   * mask was non-zero and 8 otherwise — two values, no gradient, and blind to
   * every lake in the world, because the channel mask is identically zero over
   * standing water. See the note at the end of `TerrainGen._climate`.
   */
  getDistToWater(x, z) {
    // A bake written before this field existed decodes without it — the field
    // list lives in each bake's own header, so old files stay readable. Fall
    // back to the far end of the range rather than to NaN, which would silently
    // paint sand across the whole map through getSurfaceWeights below.
    if (!this.distToWaterM) return 48;
    const [gx, gz] = this.toGrid(x, z);
    return bilinear(this.distToWaterM, this.res, this.res, gx, gz);
  }

  /** Data textures consumed by terrain / grass / water shaders. */
  _buildTextures() {
    const R = this.res;
    // RG = height (packed float via linear filtering on a float texture), B = river, A = moisture
    const data = new Float32Array(R * R * 4);
    for (let i = 0; i < R * R; i++) {
      data[i * 4 + 0] = this.height[i];
      data[i * 4 + 1] = this.water[i] < -9000 ? -9999 : this.water[i];
      data[i * 4 + 2] = this.riverMask[i];
      data[i * 4 + 3] = this.moisture[i];
    }
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.dataTexture = tex;

    // Auxiliary: slope / hardness / sediment / flow(log)
    const aux = new Float32Array(R * R * 4);
    for (let i = 0; i < R * R; i++) {
      aux[i * 4 + 0] = this.slopeMap[i];
      aux[i * 4 + 1] = this.hardness[i];
      aux[i * 4 + 2] = this.sediment[i];
      aux[i * 4 + 3] = Math.log(1 + this.flow[i]) / 14;
    }
    const auxTex = new THREE.DataTexture(aux, R, R, THREE.RGBAFormat, THREE.FloatType);
    auxTex.minFilter = auxTex.magFilter = THREE.LinearFilter;
    auxTex.wrapS = auxTex.wrapT = THREE.ClampToEdgeWrapping;
    auxTex.needsUpdate = true;
    this.auxTexture = auxTex;

    // ── the hydro texture ────────────────────────────────────────────────────
    // See src/world/hydroField.js for what each channel is and why it exists.
    // R = depth to test against, G = signed metres to the waterline, B = wet
    // coverage 0..1, A = how open the water is here, in metres.
    //
    // Half-float, at half the bake's resolution, with a mip chain built here
    // rather than by the driver. Three reasons, all measured:
    //
    //   * the field is band-limited by construction — every channel is a
    //     low-pass at 6-10 m or a distance transform — so storing it at 2 m is
    //     storing three copies of every number. 768^2 RGBA16F is 4.7 MB against
    //     the 37.7 MB an RGBA32F at 1536 would cost.
    //   * the channels are DIFFERENCES, so half-float's step is 0.004 m in the
    //     eight-metre band where every shoreline decision is made. An absolute
    //     elevation would have stepped 0.25 m at 365 m, which is three times the
    //     micro-detail this field exists to reconcile.
    //   * generateMipmaps on a float texture is not portable, and without a mip
    //     chain a 2 m field is point-sampled at every range — which is the
    //     narrow jagged zigzag every distant river draws in the `hero` framing.
    //     A box-filtered chain built here is portable and is the right filter
    //     for a field whose whole job is to be smooth.
    {
      const HR = this.hydro.res;
      const half = (v) => THREE.DataUtils.toHalfFloat(v);
      const pack = (res, depth, sdf, wet, span) => {
        const a = new Uint16Array(res * res * 4);
        for (let i = 0; i < res * res; i++) {
          a[i * 4] = half(depth[i]);
          a[i * 4 + 1] = half(sdf[i]);
          a[i * 4 + 2] = half(wet[i]);
          a[i * 4 + 3] = half(span[i]);
        }
        return a;
      };
      const mips = [];
      let lr = HR;
      let cd = this.hydro.depth, cs = this.hydro.sdf, cw = this.hydro.wet, cb = this.hydro.span;
      mips.push({ data: pack(lr, cd, cs, cw, cb), width: lr, height: lr });
      while (lr > 4) {
        const nr = lr >> 1;
        const nd = new Float32Array(nr * nr), ns = new Float32Array(nr * nr);
        const nw = new Float32Array(nr * nr), nb = new Float32Array(nr * nr);
        for (let z = 0; z < nr; z++) {
          for (let x = 0; x < nr; x++) {
            const k = z * nr + x;
            const a = (z * 2) * lr + x * 2, b = a + 1, c = a + lr, d = c + 1;
            nd[k] = (cd[a] + cd[b] + cd[c] + cd[d]) * 0.25;
            ns[k] = (cs[a] + cs[b] + cs[c] + cs[d]) * 0.25;
            nw[k] = (cw[a] + cw[b] + cw[c] + cw[d]) * 0.25;
            nb[k] = (cb[a] + cb[b] + cb[c] + cb[d]) * 0.25;
          }
        }
        lr = nr; cd = nd; cs = ns; cw = nw; cb = nb;
        mips.push({ data: pack(lr, cd, cs, cw, cb), width: lr, height: lr });
      }
      const hy = new THREE.DataTexture(mips[0].data, HR, HR, THREE.RGBAFormat, THREE.HalfFloatType);
      hy.mipmaps = mips;
      hy.generateMipmaps = false;
      hy.minFilter = THREE.LinearMipmapLinearFilter;
      hy.magFilter = THREE.LinearFilter;
      hy.wrapS = hy.wrapT = THREE.ClampToEdgeWrapping;
      hy.needsUpdate = true;
      this.hydroTexture = hy;
      this.hydroTexel = 1 / HR;
    }

    // ── the flow field ───────────────────────────────────────────────────────
    // R,G = flow direction times coherence, encoded to 0..1; B = discharge;
    // A = turbulence. See TerrainGen._flowField for what each one means.
    //
    // Eight bits and not a float texture, deliberately. The two float RGBA
    // textures above are 37 MB each at res 1536; a third would be a third of a
    // gigabyte of world data for a field whose direction is smoothed over 9 m
    // and whose other two channels only ever scale a scroll rate and a foam
    // drive. u8 is 9.4 MB and resolves the bearing to half a degree.
    const flow = new Uint8Array(R * R * 4);
    const enc = (v) => {
      const b = (v * 0.5 + 0.5) * 255;
      return b < 0 ? 0 : b > 255 ? 255 : b | 0;
    };
    const u8 = (v) => {
      const b = v * 255;
      return b < 0 ? 0 : b > 255 ? 255 : b | 0;
    };
    const vX = this.flowVX, vZ = this.flowVZ, fQ = this.flowQ, fT = this.flowT;
    for (let i = 0; i < R * R; i++) {
      // A bake written before the field existed decodes without it. Still
      // water everywhere is the right fallback: the surface then draws as a
      // lake, which is what this build did before the unification.
      flow[i * 4 + 0] = vX ? enc(vX[i]) : 128;
      flow[i * 4 + 1] = vZ ? enc(vZ[i]) : 128;
      flow[i * 4 + 2] = fQ ? u8(fQ[i]) : 0;
      flow[i * 4 + 3] = fT ? u8(fT[i]) : 0;
    }
    const flowTex = new THREE.DataTexture(flow, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
    flowTex.minFilter = flowTex.magFilter = THREE.LinearFilter;
    flowTex.wrapS = flowTex.wrapT = THREE.ClampToEdgeWrapping;
    flowTex.needsUpdate = true;
    this.flowTexture = flowTex;
  }

  /**
   * A gentle dirt-track network linking flat, dry, low-slope ground.
   * Greedy walk biased downhill-ish, avoiding water — reads like a game trail.
   */
  _buildRoadNetwork() {
    this.roads = [];
    const tries = 10;
    for (let t = 0; t < tries; t++) {
      const a = (t / tries) * Math.PI * 2;
      let x = Math.cos(a) * this.half * 0.72;
      let z = Math.sin(a) * this.half * 0.72;
      // Snap to drivable ground
      const pts = [];
      let dir = a + Math.PI;
      for (let i = 0; i < 420; i++) {
        pts.push(new THREE.Vector3(x, this.getHeight(x, z) + 0.05, z));
        // Sample a fan of candidate directions, pick the flattest & driest.
        let best = -Infinity, bestDir = dir;
        for (let k = -4; k <= 4; k++) {
          const d = dir + k * 0.16;
          const nx = x + Math.cos(d) * 9, nz = z + Math.sin(d) * 9;
          if (!this.isInBounds(nx, nz)) continue;
          const slope = this.getSlope(nx, nz);
          const depth = this.getWaterDepth(nx, nz);
          const score = -slope * 4 - depth * 6 - Math.abs(k) * 0.06
                      + this.noise.fbm(nx * 0.01, nz * 0.01, 2, 2, 0.5, 1) * 0.4;
          if (score > best) { best = score; bestDir = d; }
        }
        dir = bestDir;
        x += Math.cos(dir) * 9;
        z += Math.sin(dir) * 9;
        if (!this.isInBounds(x, z)) break;
      }
      if (pts.length > 40) this.roads.push(pts);
    }
  }

  dispose() {
    this.dataTexture?.dispose();
    this.auxTexture?.dispose();
    this.flowTexture?.dispose();
  }
}

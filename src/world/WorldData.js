// ─────────────────────────────────────────────────────────────────────────────
//  WorldData — the single source of truth every system samples from.
//  Terrain mesh, physics, scatter placement, wildlife pathing and the camera
//  all read heights through here, so nothing can ever disagree about the ground.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { WORLD, BIOME } from './WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep, bilinear } from '../core/MathUtils.js';
import { NoiseField } from '../core/Noise.js';

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
    this._buildTextures();
    this._buildRoadNetwork();
  }

  // World XZ -> heightmap texel space
  toGrid(x, z) {
    return [(x + this.half) * this.invTexel, (z + this.half) * this.invTexel];
  }

  // Micro-detail added on top of the baked heightmap. Must match the shader.
  microDetail(x, z) {
    const n = this.noise;
    return n.fbm(x * 0.055, z * 0.055, 3, 2.2, 0.45, 1) * 0.42
         + n.fbm(x * 0.21, z * 0.21, 2, 2.4, 0.4, 1) * 0.11;
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

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

  /** Water surface height, or null when there is no water here. */
  getWaterHeight(x, z) {
    const [gx, gz] = this.toGrid(x, z);
    const gxi = clamp(Math.round(gx), 0, this.res - 1);
    const gzi = clamp(Math.round(gz), 0, this.res - 1);
    const w = this.water[gzi * this.res + gxi];
    return w < -9000 ? null : w;
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
    const sandW = smoothstep(0.9, 0.0, depth) * smoothstep(3.0, 0.2, this.distToShoreApprox(x, z));
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

  distToShoreApprox(x, z) {
    const r = this.getRiver(x, z);
    return r > 0 ? 0 : 8;
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
  }
}

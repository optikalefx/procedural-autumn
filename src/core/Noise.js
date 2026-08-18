// Noise field library: simplex-backed FBM, ridged multifractal, domain warp,
// worley/cellular. Everything is seeded and deterministic.
import { createNoise2D, createNoise3D } from 'simplex-noise';
import { mulberry32 } from './MathUtils.js';

export class NoiseField {
  constructor(seed = 1337) {
    this.seed = seed;
    const rng = mulberry32(seed);
    this.n2 = createNoise2D(rng);
    this.n3 = createNoise3D(mulberry32(seed ^ 0x5f3759df));
    this.n2b = createNoise2D(mulberry32(seed ^ 0xa5a5a5));
    this.n2c = createNoise2D(mulberry32(seed ^ 0x13579b));
  }

  // Fractal Brownian motion, [-1,1]-ish.
  fbm(x, y, octaves = 6, lacunarity = 2.0, gain = 0.5, freq = 1) {
    let amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.n2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged multifractal — the classic mountain-ridge generator.
  ridged(x, y, octaves = 6, lacunarity = 2.0, gain = 0.5, freq = 1, sharpness = 1.0) {
    let amp = 1, sum = 0, norm = 0, weight = 1;
    for (let i = 0; i < octaves; i++) {
      let n = this.n2(x * freq, y * freq);
      n = 1 - Math.abs(n);
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2.0));
      sum += amp * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    const v = sum / norm;
    return sharpness === 1 ? v : Math.pow(v, sharpness);
  }

  // Billowy noise — rounded hills / cloud puffs.
  billow(x, y, octaves = 5, lacunarity = 2.0, gain = 0.5, freq = 1) {
    let amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * (Math.abs(this.n2(x * freq, y * freq)) * 2 - 1);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Domain warp. The warp field MUST be lower-frequency than the field it
   * displaces — a warp whose own detail is finer than the target's features
   * does not make terrain organic, it shreds it into noise. Keep `octaves`
   * small and `freq` at or below the target frequency.
   */
  warp(x, y, strength = 1, freq = 0.5, octaves = 2) {
    const qx = this.fbm(x + 5.2, y + 1.3, octaves, 2, 0.5, freq);
    const qy = this.fbm(x + 9.7, y + 4.4, octaves, 2, 0.5, freq);
    return [x + strength * qx, y + strength * qy];
  }

  /** Two-stage warp for large, sweeping distortion. Same frequency discipline. */
  warp2(x, y, s1 = 1, s2 = 0.4, freq = 0.5, octaves = 2) {
    const qx = this.fbm(x, y, octaves, 2, 0.5, freq);
    const qy = this.fbm(x + 5.2, y + 1.3, octaves, 2, 0.5, freq);
    const rx = this.fbm(x + 2 * qx + 1.7, y + 2 * qy + 9.2, octaves, 2, 0.5, freq * 1.7);
    const ry = this.fbm(x + 2 * qx + 8.3, y + 2 * qy + 2.8, octaves, 2, 0.5, freq * 1.7);
    return [x + s1 * qx + s2 * rx, y + s1 * qy + s2 * ry];
  }

  // Cellular / Worley F1 distance. Used for rock cracking + biome patches.
  worley(x, y, freq = 1) {
    x *= freq; y *= freq;
    const xi = Math.floor(x), yi = Math.floor(y);
    let best = 1e9;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i, cy = yi + j;
        const px = cx + 0.5 + 0.5 * this.n2b(cx * 0.731, cy * 1.317);
        const py = cy + 0.5 + 0.5 * this.n2c(cx * 1.117, cy * 0.577);
        const dx = px - x, dy = py - y;
        const d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }

  n3d(x, y, z) { return this.n3(x, y, z); }
}

export const defaultNoise = new NoiseField(20261018);

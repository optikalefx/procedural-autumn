// ─────────────────────────────────────────────────────────────────────────────
//  Procedural leaf-cluster atlas.
//
//  The single decision that makes or breaks stylised foliage is what a "leaf"
//  is. Modelling individual leaves is unaffordable and reads as noise; a single
//  soft blob reads as cotton wool. The reference plates read as *paint
//  splatter*: a mass of small crisp marks, dense in the middle, breaking into
//  isolated flecks at the rim. So each atlas tile is exactly that — a few
//  hundred small hard-edged marks with a density falloff, drawn once at load
//  into a canvas.
//
//  Channel layout (this is a data texture, not a picture):
//    R  per-mark value jitter        — breaks the mass into readable marks
//    G  radial "core" mask           — 1 deep inside the clump, 0 at its rim;
//                                      drives interior occlusion in the shader
//    B  unused (kept 0.5 for debug)
//    A  coverage                     — alphaTest cutout, so trees sort and cast
//                                      real shadows instead of blending
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32 } from '../core/MathUtils.js';

export const TILE = {
  FINE: 0,     // birch / aspen — small dashes, airy
  BROAD: 1,    // maple / oak   — bigger rounder marks, heavier mass
  NEEDLE: 2,   // conifer bough — a drooping spiky fringe
  SPARSE: 3,   // crown rim     — half the marks, wider spread, breaks silhouette
};

const TAU = Math.PI * 2;

/** One small mark. Slight elongation + rotation stops them reading as dots. */
function mark(g, x, y, r, elong, rot, value, alpha = 1) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.ellipse(0, 0, r * elong, r, 0, 0, TAU);
  const v = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
  g.fillStyle = `rgba(${v},0,128,${alpha})`;
  g.fill();
  g.restore();
}

/**
 * Deciduous clump: dense solid core, stippled rim.
 * `spread` > 1 pushes marks outward for the sparse rim variant.
 */
function drawClump(g, ox, oy, size, rng, opts) {
  const cx = ox + size * 0.5, cy = oy + size * 0.5;
  const R = size * 0.46 * (opts.spread ?? 1);
  const n = opts.count;
  for (let i = 0; i < n; i++) {
    // pow < 0.5 concentrates toward the centre; the rim gets the leftovers.
    const t = Math.pow(rng(), opts.corePull);
    const a = rng() * TAU;
    // Slightly squashed vertically so a clump is wider than tall, like a spray.
    const px = cx + Math.cos(a) * t * R;
    const py = cy + Math.sin(a) * t * R * 0.86;
    const shrink = 1 - opts.rimShrink * t;
    const r = size * opts.markSize * shrink * (0.65 + 0.7 * rng());
    // Marks near the rim are dimmer only in *jitter*, not alpha — a soft alpha
    // rim would defeat alphaTest and make the tree fizz at distance.
    mark(g, px, py, r, 1.0 + rng() * opts.elong, rng() * TAU,
         0.30 + 0.70 * rng() * (1 - 0.25 * t));
  }
}

/** Conifer bough: a fringe that fans out and droops, seen edge-on. */
function drawNeedleFan(g, ox, oy, size, rng) {
  const cx = ox + size * 0.5;
  const top = oy + size * 0.16;
  const strands = 30;
  for (let s = 0; s < strands; s++) {
    const side = s & 1 ? 1 : -1;
    const f = (s >> 1) / (strands / 2 - 1);          // 0 centre .. 1 outermost
    const spread = 0.20 + 1.05 * f + (rng() - 0.5) * 0.14;
    const len = size * (0.52 - 0.16 * f) * (0.8 + 0.4 * rng());
    const dx = Math.sin(spread) * side, dy = Math.cos(spread);
    const steps = 14;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Quadratic droop: boughs sag under their own weight.
      const px = cx + dx * len * t;
      const py = top + dy * len * t * 0.55 + t * t * size * 0.30;
      const r = size * 0.030 * (1 - 0.55 * t) * (0.7 + 0.6 * rng());
      mark(g, px, py, r, 2.6 + rng() * 1.6, Math.atan2(dy, dx) + (rng() - 0.5) * 0.5,
           0.22 + 0.55 * rng());
    }
  }
  // A denser wedge near the trunk so the whorl is not see-through at its root.
  for (let i = 0; i < 90; i++) {
    const t = Math.pow(rng(), 0.6);
    const a = (rng() - 0.5) * 1.5;
    mark(g, cx + Math.sin(a) * size * 0.22 * t, top + size * 0.16 * t + size * 0.05,
         size * 0.028 * (0.6 + 0.8 * rng()), 2.2, a, 0.2 + 0.4 * rng());
  }
}

/**
 * Build the 2×2 cluster atlas. Returns a THREE.Texture.
 * `px` is the size of one tile; the atlas is 2*px square.
 */
export function buildClusterAtlas(seed = 7, px = 256) {
  const size = px * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, size, size);

  drawClump(g, 0, 0, px, mulberry32(seed + 11), {
    count: 1100, corePull: 0.55, markSize: 0.0165, rimShrink: 0.40, elong: 1.5,
  });
  drawClump(g, px, 0, px, mulberry32(seed + 23), {
    count: 780, corePull: 0.50, markSize: 0.0225, rimShrink: 0.36, elong: 0.7,
  });
  drawNeedleFan(g, 0, px, px, mulberry32(seed + 37));
  drawClump(g, px, px, px, mulberry32(seed + 53), {
    count: 380, corePull: 0.88, markSize: 0.0185, rimShrink: 0.22, elong: 1.6, spread: 1.08,
  });

  // Second pass in JS: write the radial core mask into G. Doing it here rather
  // than with a canvas gradient keeps it independent of what the marks painted.
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const ox = tx * px, oy = ty * px;
      const cx = ox + px * 0.5, cy = oy + px * 0.5;
      const R = px * 0.47;
      for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
          const i = ((oy + y) * size + ox + x) * 4;
          const dx = (ox + x) - cx, dy = (oy + y) - cy;
          const t = Math.min(1, Math.hypot(dx, dy) / R);
          d[i + 1] = Math.round((1 - t * t) * 255);   // 1 in the core, 0 at rim
        }
      }
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;    // this is data, not colour
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * UV rect for one atlas tile, inset by a texel so mip filtering cannot drag a
 * neighbouring tile's marks across the seam.
 */
export function tileUV(tile, inset = 0.004) {
  const tx = tile & 1, ty = tile >> 1;
  return {
    u0: tx * 0.5 + inset, v0: 1 - (ty * 0.5 + 0.5) + inset,
    u1: (tx + 1) * 0.5 - inset, v1: 1 - (ty * 0.5) - inset,
  };
}

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

/** One mark. Slight elongation + rotation stops them reading as dots. */
function mark(g, x, y, r, elong, rot, value, alpha = 1) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.ellipse(0, 0, r * elong, r, 0, 0, TAU);
  const v = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
  g.fillStyle = 'rgba(' + v + ',0,128,' + alpha + ')';
  g.fill();
  g.restore();
}

/**
 * Deciduous clump: dense solid core, chunky stippled rim.
 * `spread` > 1 pushes marks outward for the sparse rim variant.
 *
 * The mark *sizes* here are the whole of the silhouette defect. The previous
 * pass sprayed 200-340 marks at 0.023-0.028 of a tile and shrank them further
 * toward the rim, which at a tile magnification of anything under 1:1 is a
 * cloud of sub-pixel islands — confetti, not brush marks, exactly as the critic
 * measured at the canopy boundary. Marks now start large and *stay* large out
 * to the rim (rimShrink near zero), and there are far fewer of them, so a mark
 * is still several pixels across at the distance the mid LOD takes over.
 */
function drawClump(g, ox, oy, size, rng, opts) {
  const cx = ox + size * 0.5, cy = oy + size * 0.5;
  const R = size * 0.46 * (opts.spread ?? 1);
  const n = opts.count;

  // Torn envelope. A clump drawn inside a circle stays a circle no matter how
  // the marks inside it are distributed, and a canopy assembled out of circles
  // reads as a bunch of grapes however cleverly the clumps are placed. Two
  // angular harmonics turn the outline into a lopsided paint dab with bays and
  // promontories — which is what the reference plates actually paint, and it
  // costs nothing at runtime because it is baked into the atlas.
  const k1 = 2 + ((rng() * 3) | 0), k2 = 5 + ((rng() * 4) | 0);
  const p1 = rng() * TAU, p2 = rng() * TAU;
  const a1 = (0.17 + 0.17 * rng()) * (opts.tear ?? 1);
  const a2 = (0.08 + 0.11 * rng()) * (opts.tear ?? 1);
  const env = (a) => 1 + a1 * Math.sin(k1 * a + p1) + a2 * Math.sin(k2 * a + p2);

  for (let i = 0; i < n; i++) {
    // pow < 0.5 concentrates toward the centre; the rim gets the leftovers.
    const t = Math.pow(rng(), opts.corePull);
    const a = rng() * TAU;
    const RR = R * env(a);
    // Slightly squashed vertically so a clump is wider than tall, like a spray.
    const px = cx + Math.cos(a) * t * RR;
    const py = cy + Math.sin(a) * t * RR * 0.86;
    const shrink = 1 - opts.rimShrink * t;
    const r = size * opts.markSize * shrink * (0.72 + 0.62 * rng());
    // Marks near the rim are dimmer only in *jitter*, not alpha — a soft alpha
    // rim would defeat alphaTest and make the tree fizz at distance.
    mark(g, px, py, r, 1.0 + rng() * opts.elong, rng() * TAU,
         0.22 + 0.78 * rng() * (1 - 0.22 * t));
  }
}

/**
 * Conifer bough: a fan of tapered spikes seen edge-on.
 *
 * This used to be drawn as a chain of small ellipses along each strand, which
 * at any distance disintegrated into the scatter of two-pixel ticks floating
 * clear of the tree that the critic photographed. A frond is one filled
 * polygon: a wide base tapering to a point, with a serrated edge and a droop.
 * It gives the same spiky reference silhouette but it is a single connected
 * shape, so minification erodes its outline rather than dissolving its body.
 */
function drawFrond(g, x0, y0, dx, dy, len, halfW, droop, rng, value) {
  const STEPS = 7;
  const left = [], right = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    // Centreline, sagging quadratically under its own weight.
    const cxp = x0 + dx * len * t;
    const cyp = y0 + dy * len * t + t * t * droop;
    // Width tapers to a point, with a sawtooth so the edge reads as needles.
    const saw = i === STEPS ? 0 : (i & 1 ? 1.0 : 0.58) * (0.75 + 0.5 * rng());
    const w = halfW * Math.pow(1 - t, 0.75) * saw;
    const nx = -dy, ny = dx;
    left.push([cxp + nx * w, cyp + ny * w]);
    right.push([cxp - nx * w, cyp - ny * w]);
  }
  g.beginPath();
  g.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i <= STEPS; i++) g.lineTo(left[i][0], left[i][1]);
  for (let i = STEPS - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
  g.closePath();
  const v = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
  g.fillStyle = 'rgba(' + v + ',0,128,1)';
  g.fill();
}

/** Conifer bough tile: a fringe of fronds that fans out and droops. */
function drawNeedleFan(g, ox, oy, size, rng) {
  const cx = ox + size * 0.5;
  const top = oy + size * 0.14;
  const strands = 15;
  for (let s = 0; s < strands; s++) {
    const side = s & 1 ? 1 : -1;
    const f = (s >> 1) / (strands / 2 - 1);          // 0 centre .. 1 outermost
    const spread = 0.22 + 1.02 * f + (rng() - 0.5) * 0.14;
    // Wide length variance is the whole point: an even fringe reads as a plate,
    // a ragged one reads as needles. Roughly every fourth frond is a runt.
    const stub = rng() < 0.24 ? 0.52 : 1.0;
    const len = size * (0.58 - 0.16 * f) * (0.74 + 0.52 * rng()) * stub;
    const dx = Math.sin(spread) * side, dy = Math.cos(spread);
    drawFrond(g, cx, top, dx, dy, len, size * (0.052 + 0.030 * (1 - f)),
              size * 0.26, rng, 0.24 + 0.56 * rng());
  }
  // A solid wedge near the trunk so the whorl is not see-through at its root
  // and the fronds have one mass to spring from.
  g.beginPath();
  g.moveTo(cx - size * 0.20, top + size * 0.30);
  g.lineTo(cx, top - size * 0.03);
  g.lineTo(cx + size * 0.20, top + size * 0.30);
  g.lineTo(cx, top + size * 0.44);
  g.closePath();
  g.fillStyle = 'rgba(120,0,128,1)';
  g.fill();
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

  // Two passes per tile, and the second one is what sells it. A single mark
  // size gives you either a smooth lobe (marks too big) or a disc whose stipple
  // the mip chain erases by 25 m (marks too small). So: a coarse pass builds a
  // solid, lobed mass, then a fine pass sprays past its rim. That is exactly
  // what the reference plates paint — a definite mass with a fizzing edge.
  // Fewer, larger marks in the coarse pass than you would expect: they are
  // meant to read as three or four overlapping lobes, not to fill a disc. The
  // fine pass then sprays well past them. Between the two, the tile has a
  // definite mass with a torn edge and marks you can still count at 5 m.
  drawClump(g, 0, 0, px, mulberry32(seed + 11), {
    count: 26, corePull: 0.50, markSize: 0.098, rimShrink: 0.16, elong: 1.3, spread: 0.82, tear: 1.15,
  });
  drawClump(g, 0, 0, px, mulberry32(seed + 12), {
    count: 78, corePull: 0.78, markSize: 0.050, rimShrink: 0.10, elong: 1.5, spread: 1.14, tear: 1.3,
  });
  drawClump(g, px, 0, px, mulberry32(seed + 23), {
    count: 22, corePull: 0.48, markSize: 0.112, rimShrink: 0.14, elong: 0.8, spread: 0.82, tear: 1.1,
  });
  drawClump(g, px, 0, px, mulberry32(seed + 24), {
    count: 62, corePull: 0.82, markSize: 0.058, rimShrink: 0.08, elong: 1.0, spread: 1.12, tear: 1.25,
  });
  drawNeedleFan(g, 0, px, px, mulberry32(seed + 37));
  // The rim tile is what draws every silhouette edge in the game, so it is the
  // one that must never fizz: a handful of large, well-separated dabs and no
  // fine pass at all. It reads as a torn edge because the dabs are far apart,
  // not because they are small.
  drawClump(g, px, px, px, mulberry32(seed + 53), {
    count: 15, corePull: 0.92, markSize: 0.108, rimShrink: 0.02, elong: 1.4, spread: 0.96, tear: 1.5,
  });
  drawClump(g, px, px, px, mulberry32(seed + 54), {
    count: 26, corePull: 1.00, markSize: 0.060, rimShrink: 0.0, elong: 1.6, spread: 1.16, tear: 1.6,
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

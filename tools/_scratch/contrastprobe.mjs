#!/usr/bin/env node
/**
 * What field is wedge's contour actually a level set of?
 *
 * wedge cuts at  |frame - nowater| summed over sRGB channels / 765 = 0.045.
 * That quantity is  alpha(d) * C(x,y)  where C is the LOCAL COLOUR CONTRAST
 * between the water and whatever ground is behind it. So the contour is a level
 * set of alpha x contrast, and if C varies ALONG the shore the contour moves
 * even though the water does not.
 *
 * Displacement, for a coverage ramp of width aa px:
 *     d(shift) = (T / C) * (dC / C) * aa
 * because the crossing sits at alpha* = T/C, and moving C by dC moves alpha* by
 * that fraction, which costs alpha*(dC/C) of coverage, which is that times aa
 * of ground.
 *
 * This prints C, dC/C and the predicted shift per framing, to be compared with
 * the wobble that finewhere.mjs measures directly.
 */
import { readPNG } from '../_pngread.mjs';
const files = process.argv.slice(2);
const DIFF_T = 0.045;
console.log('frame                 C(p50)  dC/C(p50 over 24px)   aaPx*   predicted wobble px');
for (const path of files) {
  const { w: W, h: H, px } = readPNG(path);
  const nw = readPNG(path.replace(/\.png$/, '-nowater.png'));
  const N = W * H;
  const F = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    F[i] = (Math.abs(px[i*3]-nw.px[i*3]) + Math.abs(px[i*3+1]-nw.px[i*3+1]) + Math.abs(px[i*3+2]-nw.px[i*3+2])) / 765;
  }
  // C at a shore pixel: the field value a few px INSIDE the water, i.e. where
  // alpha is 1 — take the max of F over a 9 px inward walk from each boundary
  // pixel, along the field's own gradient.
  const Cs = [];
  const pts = [];
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x;
    const a = F[i] - DIFF_T;
    const b = F[i + 1] - DIFF_T;
    if ((a >= 0) === (b >= 0)) continue;
    // gradient direction
    const gx = F[i + 1] - F[i - 1], gy = F[i + W] - F[i - W];
    const g = Math.hypot(gx, gy); if (g < 1e-6) continue;
    let best = 0;
    for (let s = 1; s <= 9; s++) {
      const xx = Math.round(x + gx / g * s), yy = Math.round(y + gy / g * s);
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) break;
      best = Math.max(best, F[yy * W + xx]);
    }
    if (best > DIFF_T) { Cs.push(best); pts.push([x, y, best]); }
  }
  if (!Cs.length) { console.log(`${path}: no shore found`); continue; }
  const srt = [...Cs].sort((a, b) => a - b);
  const Cp50 = srt[srt.length >> 1];
  // dC/C: local variation of C along the shore, over a 24 px neighbourhood
  const bin = new Map();
  for (const p of pts) { const k = `${p[0] >> 4},${p[1] >> 4}`; if (!bin.has(k)) bin.set(k, []); bin.get(k).push(p); }
  const rel = [];
  for (const [x, y, c] of pts) {
    const near = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = bin.get(`${(x >> 4) + dx},${(y >> 4) + dy}`); if (!b) continue;
      for (const q of b) if (Math.hypot(q[0] - x, q[1] - y) <= 12) near.push(q[2]);
    }
    if (near.length < 6) continue;
    const m = near.reduce((s, v) => s + v, 0) / near.length;
    rel.push(Math.abs(c - m) / m);
  }
  rel.sort((a, b) => a - b);
  const dRel = rel.length ? rel[rel.length >> 1] : 0;
  // aa* : take it from the caller's wedge run; estimate here from the gradient
  const aaEst = (() => {
    const t = [];
    for (const [x, y] of pts) {
      const i = y * W + x;
      const gx = (F[i + 1] - F[i - 1]) / 2, gy = (F[i + W] - F[i - W]) / 2;
      const g = Math.hypot(gx, gy); if (g > 1e-6) t.push(0.70 * Cp50 / g);
    }
    t.sort((a, b) => a - b); return t.length ? t[t.length >> 1] : 0;
  })();
  const pred = (DIFF_T / Cp50) * dRel * aaEst;
  console.log(`${path.split('/').pop().padEnd(20)} ${Cp50.toFixed(3)}   ${(dRel*100).toFixed(1)}%              ${aaEst.toFixed(2)}    ${pred.toFixed(3)}`);
}

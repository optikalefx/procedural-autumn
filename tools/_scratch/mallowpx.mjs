#!/usr/bin/env node
/**
 * The same silhouette metrics as `mallowsil.mjs`, but read off a CAPTURED
 * FRAME instead of off the geometry.
 *
 *   node tools/_scratch/mallowpx.mjs shots/roast/r3/mallow-*.png
 *
 * `mallowsil.mjs` is exact and knows nothing about lighting, blisters, the
 * upscaler or the grade. This knows nothing about the model and measures what
 * the critic actually looked at. Where the two agree, the shape is the shape;
 * where they disagree, the difference is everything the renderer adds, which
 * this round is mostly the toast stage's blisters.
 *
 * Segmentation is a flood from the frame border with a LOCAL tolerance — each
 * step compares against the pixel it came from, not against a seed colour — so
 * it walks the whole smooth background gradient and stops at any hard edge.
 * The marshmallow, the shaft and the near logs are then the unfilled
 * components; an erode/dilate pass sheds the shaft, which is thin, and the
 * component nearest the frame centre is the subject.
 */
import { readPNG } from '../_pngread.mjs';

const FLAGV = new Set(['--tol', '--erode']);
const files = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { if (FLAGV.has(a)) i++; continue; }
  files.push(a);
}
const argN = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const TOL = argN('tol', 10);      // per-step channel tolerance, 0-255
const ERODE = argN('erode', 9);   // px; must exceed half the shaft's width

function segment(img) {
  const { w: W, h: H, px: data } = img;
  const at = (i, c) => data[i * 3 + c];
  const bg = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
  for (const i of stack) bg[i] = 1;
  const q = stack.slice();
  let head = 0;
  while (head < q.length) {
    const i = q[head++];
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (bg[j]) continue;
      const d = Math.max(Math.abs(at(j, 0) - at(i, 0)),
                         Math.abs(at(j, 1) - at(i, 1)),
                         Math.abs(at(j, 2) - at(i, 2)));
      if (d > TOL) continue;
      bg[j] = 1; q.push(j);
    }
  }

  // Everything not background, eroded to shed the shaft.
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = bg[i] ? 0 : 1;
  const core = morph(fg, W, H, -ERODE);
  // The component of the eroded set nearest the frame centre.
  const lbl = new Int32Array(W * H).fill(-1);
  let bestId = -1, bestD = Infinity, id = 0;
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (!core[s] || lbl[s] >= 0) continue;
    const st = [s]; lbl[s] = id; let n = 0, sx = 0, sy = 0;
    while (st.length) {
      const i = st.pop(); n++; sx += i % W; sy += (i / W) | 0;
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (core[j] && lbl[j] < 0) { lbl[j] = id; st.push(j); }
      }
    }
    const d = Math.hypot(sx / n - W / 2, sy / n - H / 2) - Math.sqrt(n);
    comps.push({ id, n });
    if (n > 400 && d < bestD) { bestD = d; bestId = id; }
    id++;
  }
  if (bestId < 0) return null;
  const sel = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lbl[i] === bestId) sel[i] = 1;
  // Grow back and clip to the original foreground, so the eroded rim returns
  // but the shaft — which was severed, not eroded — does not.
  const grown = morph(sel, W, H, ERODE + 1);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = grown[i] && fg[i] ? 1 : 0;
  return fillHoles(out, W, H);
}

/** Chebyshev erode (r < 0) or dilate (r > 0), separable. */
function morph(src, W, H, r) {
  const k = Math.abs(r), dil = r > 0;
  let a = src, b = new Uint8Array(W * H);
  for (const axis of [0, 1]) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = dil ? 0 : 1;
        for (let d = -k; d <= k; d++) {
          const nx = axis ? x : x + d, ny = axis ? y + d : y;
          const s = (nx < 0 || ny < 0 || nx >= W || ny >= H) ? 0 : a[ny * W + nx];
          if (dil) { if (s) { v = 1; break; } } else if (!s) { v = 0; break; }
        }
        b[y * W + x] = v;
      }
    }
    const t = a === src ? new Uint8Array(W * H) : a;
    a = b; b = t;
  }
  return a;
}

function fillHoles(m, W, H) {
  const outside = new Uint8Array(W * H);
  const q = [];
  for (let x = 0; x < W; x++) { q.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { q.push(y * W, y * W + W - 1); }
  for (const i of q) if (!m[i]) outside[i] = 1;
  let h = 0;
  while (h < q.length) {
    const i = q[h++]; if (!outside[i]) continue;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!m[j] && !outside[j]) { outside[j] = 1; q.push(j); }
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = (m[i] || !outside[i]) ? 1 : 0;
  return out;
}

// ── metrics, identical in definition to mallowsil.mjs ───────────────────────

function measure(mask, W, H) {
  let A = 0, sx = 0, sy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { A++; sx += i % W; sy += (i / W) | 0; }
  if (!A) return null;
  const cx = sx / A, cy = sy / A;
  let mxx = 0, myy = 0, mxy = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const dx = (i % W) - cx, dy = ((i / W) | 0) - cy;
    mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
  }
  mxx /= A; myy /= A; mxy /= A;
  const th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const ux = Math.cos(th), uy = Math.sin(th);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const dx = (i % W) - cx, dy = ((i / W) | 0) - cy;
    const a = dx * ux + dy * uy, b = -dx * uy + dy * ux;
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  const Wb = a1 - a0, Hb = b1 - b0;

  const out = trace(mask, W, H);
  const P = out.length;
  let per = 0;
  for (let i = 0; i < P; i++) {
    const a = out[i], b = out[(i + 1) % P];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const k = Math.max(4, Math.round(P * 0.03));
  const isFlat = new Uint8Array(P);
  for (let i = 0; i < P; i++) {
    const a = out[(i - k + P) % P], b = out[i], c = out[(i + k) % P];
    let dt = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
    while (dt > Math.PI) dt -= 2 * Math.PI;
    while (dt < -Math.PI) dt += 2 * Math.PI;
    if (Math.abs(dt) < 2 * Math.PI * (2 * k / P) * 0.35) isFlat[i] = 1;
  }
  let flat = 0; for (let i = 0; i < P; i++) flat += isFlat[i];
  let run = 0, best = 0;
  for (let i = 0; i < P * 2; i++) { if (isFlat[i % P]) { run++; if (run > best) best = run; } else run = 0; }
  best = Math.min(best, P);
  return {
    px: Math.max(Wb, Hb),
    aspect: Wb / Hb,
    fill: A / (Wb * Hb),
    circ: (4 * Math.PI * A) / (per * per),
    flat: flat / P,
    edge: (best / P) * per / Math.hypot(Wb, Hb),
  };
}

function trace(mask, W, H) {
  let s = -1;
  for (let i = 0; i < W * H && s < 0; i++) if (mask[i]) s = i;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : mask[y * W + x];
  const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let x = s % W, y = (s / W) | 0, d = 0;
  const start = [x, y], chain = [];
  for (let g = 0; g < 400000; g++) {
    chain.push([x, y]);
    let moved = false;
    for (let i = 0; i < 8; i++) {
      const nd = (d + 6 + i) % 8;
      const nx = x + D[nd][0], ny = y + D[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
    }
    if (!moved) break;
    if (x === start[0] && y === start[1]) break;
  }
  return chain;
}

console.log('  frame                              px   aspect   fill    circ    flat    edge');
for (const f of files) {
  const img = readPNG(f);
  const m = segment(img);
  const r = m && measure(m, img.w, img.h);
  if (!r) { console.log(`  ${f.padEnd(34)}  — nothing segmented`); continue; }
  console.log(`  ${f.padEnd(34)} ${r.px.toFixed(0).padStart(4)}   ` +
    `${r.aspect.toFixed(3)}  ${r.fill.toFixed(3)}  ${r.circ.toFixed(3)}  ` +
    `${r.flat.toFixed(3)}  ${r.edge.toFixed(3)}`);
}
console.log('\n  reference: a sphere is aspect 1.000  fill 0.785  circ 1.000  flat 0.000  edge 0.000');

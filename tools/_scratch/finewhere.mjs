#!/usr/bin/env node
/**
 * WHERE is wedge's `fine` mass, and what is it sitting on?
 *
 * wedge.mjs reports one scalar per frame. That scalar has been wrong about the
 * object four times on this project, so before any constant is touched this
 * asks the only question that matters: for each metre of contour that scores
 * `fine`, HOW WIDE IS THE WATER THERE?
 *
 * `fine` is the fraction of contour whose Menger curvature radius, on a 1 px
 * resampling, is under 3 px. The outline of a ribbon W px wide has radius ~W/2
 * at every bend and at both ends BY CONSTRUCTION. So a ribbon under 6 px wide
 * cannot score anything but `fine`, however perfect its edge is.
 *
 * Extraction is copied from tools/wedge.mjs verbatim so the contour is the
 * same object the reported number is computed on. The added column is the
 * local opposite-bank distance: for every contour vertex, the distance to the
 * nearest vertex that is more than 12 px away ALONG the chain. On a bank that
 * is the width of nothing (there is no opposite side within the search radius);
 * on a 4 px ribbon it is 4.
 */
import { readPNG } from '../_pngread.mjs';
import { writePNG, canvas, text } from '../_png.mjs';
import { mkdirSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VALUED = new Set(['out', 'narrow', 'marks']);
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUED.has(a.slice(2))) i++; continue; }
  files.push(a);
}
const OUT = arg('out', null);
const NARROW = parseFloat(arg('narrow', '6'));
const MARKS = arg('marks', null);
const DIFF_T = 0.045, MINCOMP = 0.02;

function extract(path) {
  const { w: W, h: H, px } = readPNG(path);
  const N = W * H;
  const nwPath = path.replace(/\.png$/, '-nowater.png');
  const haveDiff = existsSync(nwPath);
  const F = new Float32Array(N);
  if (haveDiff) {
    const nw = readPNG(nwPath);
    for (let i = 0; i < N; i++) {
      const d = Math.abs(px[i * 3] - nw.px[i * 3]) + Math.abs(px[i * 3 + 1] - nw.px[i * 3 + 1])
              + Math.abs(px[i * 3 + 2] - nw.px[i * 3 + 2]);
      F[i] = (d / 765) - DIFF_T;
    }
  } else throw new Error('need -nowater twin');
  const raw = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (F[i] >= 0) raw[i] = 1;
  const lab = new Int32Array(N).fill(-1); const comps = []; const stack = [];
  for (let s = 0; s < N; s++) {
    if (!raw[s] || lab[s] !== -1) continue;
    const id = comps.length; let n = 0, row0 = 0;
    stack.push(s); lab[s] = id;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      if (y === 0) row0++;
      if (x > 0 && raw[p - 1] && lab[p - 1] === -1) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && raw[p + 1] && lab[p + 1] === -1) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && raw[p - W] && lab[p - W] === -1) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && raw[p + W] && lab[p + W] === -1) { lab[p + W] = id; stack.push(p + W); }
    }
    comps.push({ id, n, row0 });
  }
  comps.sort((a, b) => b.n - a.n);
  const survivors = comps.filter((c) => c.row0 === 0);
  const largest = survivors.length ? survivors[0].n : 0;
  const floor = Math.max(MINCOMP * largest, 0.0002 * N);
  const keep = new Set();
  for (const c of survivors) if (c.n >= floor) keep.add(c.id);
  const mask = new Uint8Array(N); let maskN = 0;
  for (let i = 0; i < N; i++) if (lab[i] >= 0 && keep.has(lab[i])) { mask[i] = 1; maskN++; }
  const G = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0;
    if (mask[i]) { G[i] = F[i]; continue; }
    let t = false;
    for (let dy = -1; dy <= 1 && !t; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (mask[yy * W + xx]) { t = true; break; }
    }
    G[i] = t ? Math.min(F[i], -1e-4) : -1;
  }
  const enclosed = new Uint8Array(N);
  {
    const seen = new Uint8Array(N), st = new Int32Array(N), comp = new Int32Array(N);
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || mask[s0]) continue;
      let sp = 0, n = 0, tb = 0;
      st[sp++] = s0; seen[s0] = 1;
      while (sp > 0) {
        const k = st[--sp]; comp[n++] = k;
        const x = k % W, y = (k / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) tb = 1;
        if (x > 0 && !seen[k - 1] && !mask[k - 1]) { seen[k - 1] = 1; st[sp++] = k - 1; }
        if (x < W - 1 && !seen[k + 1] && !mask[k + 1]) { seen[k + 1] = 1; st[sp++] = k + 1; }
        if (y > 0 && !seen[k - W] && !mask[k - W]) { seen[k - W] = 1; st[sp++] = k - W; }
        if (y < H - 1 && !seen[k + W] && !mask[k + W]) { seen[k + W] = 1; st[sp++] = k + W; }
      }
      if (!tb && n < 6000) for (let i = 0; i < n; i++) enclosed[comp[i]] = 1;
    }
  }
  const segs = []; const holeOf = [];
  const lp = (p, q, vp, vq) => { const t = vp / (vp - vq); return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const P = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
    const V = [G[y * W + x], G[y * W + x + 1], G[(y + 1) * W + x + 1], G[(y + 1) * W + x]];
    let code = 0; for (let k = 0; k < 4; k++) if (V[k] > 0) code |= 1 << k;
    if (code === 0 || code === 15) continue;
    const E = [];
    for (let k = 0; k < 4; k++) { const a = k, b = (k + 1) & 3; if ((V[a] > 0) !== (V[b] > 0)) E.push(lp(P[a], P[b], V[a], V[b])); }
    const occl = enclosed[y * W + x] || enclosed[y * W + x + 1] || enclosed[(y + 1) * W + x] || enclosed[(y + 1) * W + x + 1];
    for (let k = 0; k + 1 < E.length; k += 2) { segs.push([E[k], E[k + 1]]); holeOf.push(!!occl); }
  }
  const key = (p) => `${Math.round(p[0] * 64)},${Math.round(p[1] * 64)}`;
  const adj = new Map();
  segs.forEach(([a, b], si) => {
    const ka = key(a), kb = key(b); if (ka === kb) return;
    if (!adj.has(ka)) adj.set(ka, { p: a, n: [], h: false });
    if (!adj.has(kb)) adj.set(kb, { p: b, n: [], h: false });
    adj.get(ka).n.push(kb); adj.get(kb).n.push(ka);
    if (holeOf[si]) { adj.get(ka).h = true; adj.get(kb).h = true; }
  });
  const seen = new Set(); const lines = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const out = []; let cur = start, prev = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur); out.push([adj.get(cur).p[0], adj.get(cur).p[1], adj.get(cur).h ? 1 : 0]);
      const nb = adj.get(cur).n.filter((k) => k !== prev && !seen.has(k));
      prev = cur; cur = nb[0] ?? null;
    }
    if (out.length >= 6) lines.push(out);
  }
  return { W, H, px, lines, maskN, N, F, mask };
}

const polyLen = (L) => { let s = 0; for (let i = 1; i < L.length; i++) s += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]); return s; };
const resample = (L, sp) => {
  const out = [L[0].slice()]; let acc = 0;
  for (let i = 1; i < L.length; i++) {
    let a = out[out.length - 1], b = L[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-9) continue;
    while (seg >= sp - acc) {
      const t = (sp - acc) / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[2]]);
      a = out[out.length - 1]; seg -= (sp - acc); acc = 0;
    }
    acc += seg;
  }
  return out;
};

for (const path of files) {
  const { W, H, px, lines, maskN, N, F, mask } = extract(path);
  // Global spatial hash of every contour vertex, tagged with (line, index).
  const CELL = 16;
  const gw = Math.ceil(W / CELL), gh = Math.ceil(H / CELL);
  const bins = new Map();
  const RL = lines.map((L) => (polyLen(L) < 12 ? null : resample(L, 1.0))).map((L) => (L && L.length >= 6 ? L : null));
  RL.forEach((L, li) => { if (!L) return; L.forEach((p, i) => {
    const gx = Math.min(gw - 1, (p[0] / CELL) | 0), gy = Math.min(gh - 1, (p[1] / CELL) | 0);
    const k = gy * gw + gx; if (!bins.has(k)) bins.set(k, []); bins.get(k).push([p[0], p[1], li, i]);
  }); });
  // opposite-side distance: nearest vertex >12 px away along the chain (or on
  // another chain) — i.e. the local width of the water body / of the gap.
  const oppDist = (x, y, li, i) => {
    let best = Infinity;
    const gx = (x / CELL) | 0, gy = (y / CELL) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const b = bins.get((gy + dy) * gw + (gx + dx)); if (!b) continue;
      for (const [px2, py2, lj, j] of b) {
        if (lj === li && Math.abs(j - i) <= 12) continue;
        const d = Math.hypot(px2 - x, py2 - y); if (d < best) best = d;
      }
    }
    return best;
  };

  // ── the physical quantity `fine` is a proxy for: how far, in pixels, does
  // the contour sit from its own smoothed curve, and at what wavelength.
  // fine fires at k > 1/3, which on a 1 px resampling of a STRAIGHT line means
  // a lateral deviation of only 1/6 px between consecutive samples. So report
  // the deviation itself.
  const gauss = (L, sigma) => {
    const r = Math.max(1, Math.round(sigma * 2.5));
    const w = []; for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    return L.map((_, i) => { let sx = 0, sy = 0, sw = 0;
      for (let k = -r; k <= r; k++) { const j = Math.min(L.length - 1, Math.max(0, i + k)), ww = w[k + r];
        sx += L[j][0] * ww; sy += L[j][1] * ww; sw += ww; }
      return [sx / sw, sy / sw]; });
  };
  const resid = [];
  let zc = 0, zn = 0;
  RL.forEach((L) => {
    if (!L || L.length < 12) return;
    const S = gauss(L, 4.0);
    let prevSign = 0;
    for (let i = 2; i + 2 < L.length; i++) {
      const tx = S[i + 1][0] - S[i - 1][0], ty = S[i + 1][1] - S[i - 1][1];
      const tl = Math.hypot(tx, ty); if (tl < 1e-6) continue;
      const nx = -ty / tl, ny = tx / tl;
      const d = (L[i][0] - S[i][0]) * nx + (L[i][1] - S[i][1]) * ny;
      resid.push(Math.abs(d));
      const sg = Math.sign(d);
      if (prevSign && sg && sg !== prevSign) zc++;
      if (sg) prevSign = sg;
      zn++;
    }
  });
  resid.sort((a, b) => a - b);
  const rms = Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / Math.max(1, resid.length));
  const p90 = resid.length ? resid[Math.floor(resid.length * 0.90)] : 0;
  const lam = zc > 0 ? (2 * zn / zc) : 0;

  // local edge width in px, from the field's own gradient at the vertex, in
  // exactly wedge's aaPx form: 0.70 * FULL / |grad F|.
  const FULLv = (() => { const t = []; for (let i = 0; i < N; i++) if (mask[i]) t.push(F[i] + 0.045);
    t.sort((a, b) => a - b); return Math.max(1e-3, t[Math.floor(t.length * 0.90)]); })();
  const bil = (fx, fy) => {
    const x = Math.min(W - 1.001, Math.max(0, fx)), y = Math.min(H - 1.001, Math.max(0, fy));
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    const a = F[y0 * W + x0], b = F[y0 * W + x0 + 1], c = F[(y0 + 1) * W + x0], d = F[(y0 + 1) * W + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  const localAA = (x, y) => {
    const gx = (bil(x + 0.5, y) - bil(x - 0.5, y)), gy = (bil(x, y + 0.5) - bil(x, y - 0.5));
    const g = Math.hypot(gx, gy);
    return g > 1e-7 ? 0.70 * FULLv / g : 99;
  };

  let tot = 0, fine = 0, fineNarrow = 0, fineHole = 0, fineWide = 0, totWide = 0, wideFine = 0;
  const aaFine = [], aaAll = [], wobFine = [];
  const marks = [];
  RL.forEach((L, li) => {
    if (!L) return;
    for (let i = 1; i + 1 < L.length; i++) {
      const a = L[i - 1], b = L[i], c = L[i + 1];
      const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - b[0], by = c[1] - b[1];
      const cross = Math.abs(ax * by - ay * bx);
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const k = la * lb * lc > 1e-6 ? (2 * cross) / (la * lb * lc) : 0;
      const w = (la + lb) * 0.5;
      const od = oppDist(b[0], b[1], li, i);
      aaAll.push(localAA(b[0], b[1]));
      const wide = od >= NARROW;
      tot += w; if (wide) totWide += w;
      if (k > 1 / 3.0) {
        fine += w;
        if (b[2]) fineHole += w;
        else if (!wide) fineNarrow += w;
        else { fineWide += w; wideFine += w; }
        marks.push([b[0], b[1], b[2] ? 2 : (wide ? 0 : 1)]);
        aaFine.push(localAA(b[0], b[1]));
      }
    }
  });
  const pc = (a, b) => b > 0 ? (a / b * 100).toFixed(1) : '0.0';
  console.log(`${path}`);
  console.log(`  contour ${tot.toFixed(0)} px   fine ${pc(fine, tot)}%  of which:`
    + ` hole-rim ${pc(fineHole, fine)}%  narrow(<${NARROW}px) ${pc(fineNarrow, fine)}%  wide-water ${pc(fineWide, fine)}%`);
  const med = (a) => { if (!a.length) return 0; const t = [...a].sort((x, y) => x - y); return t[t.length >> 1]; };
  console.log(`  local edge width at the FINE vertices: median ${med(aaFine).toFixed(2)} px   over ALL contour: ${med(aaAll).toFixed(2)} px`);
  console.log(`  wobble off its own 4px-smoothed curve: RMS ${rms.toFixed(3)} px  p90 ${p90.toFixed(3)} px  mean wavelength ${lam.toFixed(1)} px`);
  console.log(`  RESTRICTED to contour with >= ${NARROW} px of open water opposite:`
    + ` ${totWide.toFixed(0)} px (${pc(totWide, tot)}% of contour), fine ${pc(wideFine, totWide)}%`);

  if (MARKS) {
    const fs = await import('node:fs');
    fs.mkdirSync(MARKS, { recursive: true });
    fs.writeFileSync(`${MARKS}/${path.replace(/[^\w]+/g, '_')}.json`,
      JSON.stringify(marks.map((m) => [Math.round(m[0]), Math.round(m[1]), m[2]])));
  }
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    const img = canvas(W, H + 14, [10, 10, 12]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 3;
      img.put(x, y + 14, px[k] * 0.45 + 20, px[k + 1] * 0.45 + 20, px[k + 2] * 0.45 + 20);
    }
    RL.forEach((L) => { if (!L) return; for (const p of L) img.put(Math.round(p[0]), Math.round(p[1]) + 14, 60, 210, 90); });
    for (const [x, y, kind] of marks) {
      const col = kind === 2 ? [90, 140, 255] : kind === 1 ? [255, 210, 40] : [255, 30, 30];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) img.put(Math.round(x) + dx, Math.round(y) + dy + 14, col[0], col[1], col[2]);
    }
    text(img, 3, 3, `${path}  RED=fine on WIDE water (real)  YELLOW=fine on <${NARROW}px ribbon  BLUE=fine on hole rim`, [240, 240, 240], 1);
    const out = `${OUT}/${path.replace(/[^\w]+/g, '_')}.png`;
    writePNG(out, img);
    console.log(`  overlay: ${out}`);
  }
}

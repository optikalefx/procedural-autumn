#!/usr/bin/env node
/**
 * Unantialiased albedo steps, found in the frame rather than argued from the
 * source.
 *
 * Run on a uDebugMask 6 capture — RAW ALBEDO, unlit, no fog, no tonemap — so a
 * step in the number IS a step in the material and nothing downstream can have
 * put it there or taken it away.
 *
 * The signature of an unramped threshold is not "a big gradient". A cliff edge,
 * a rock/grass boundary and a shadow terminator all have big gradients and all
 * of them are meant to. The signature is a jump that is NOT SUPPORTED BY ITS
 * NEIGHBOURS: a pixel that differs from the one before it and from the one
 * after it, in opposite directions. That is the salt-and-pepper the last round
 * saw when it forced `damp` on alone, and it is what a threshold with no
 * fwidth does when its field crosses the threshold inside one pixel.
 *
 *   ink    px whose |log2 ratio| to BOTH horizontal neighbours exceeds `min`
 *          stops with the SAME sign -- an isolated spike, not an edge.
 *   p99    the 99th percentile of those spikes, in stops.
 */
import { readPNG } from '../_pngread.mjs';
import { writePNG, canvas, text } from '../_png.mjs';
import { mkdirSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const files = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { i++; continue; } files.push(a); }
const MIN = parseFloat(arg('min', '0.08'));
const OUT = arg('out', null);
const srgb2lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
console.log('frame                  ink px   ink%     p50 st   p90 st   p99 st   max st');
for (const path of files) {
  const { w: W, h: H, px } = readPNG(path);
  const Y = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++)
    Y[i] = 0.2126 * srgb2lin(px[i*3]) + 0.7152 * srgb2lin(px[i*3+1]) + 0.0722 * srgb2lin(px[i*3+2]);
  const spikes = [];
  const marks = [];
  let n = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (Y[i] < 0.004) continue;   // sky / black: a level IS a stop down there
    n++;
    for (const [ia, ib] of [[i - 1, i + 1], [i - W, i + W]]) {
      if (Y[ia] < 0.004 || Y[ib] < 0.004) continue;
      const a = Math.log2(Y[i] / Y[ia]), b = Math.log2(Y[i] / Y[ib]);
      if (Math.sign(a) !== Math.sign(b)) continue;
      const m = Math.min(Math.abs(a), Math.abs(b));
      if (m >= MIN) { spikes.push(m); marks.push([x, y, m]); break; }
    }
  }
  spikes.sort((a, b) => a - b);
  const q = (f) => spikes.length ? spikes[Math.min(spikes.length - 1, Math.floor(spikes.length * f))] : 0;
  console.log(`${path.split('/').slice(-2).join('/').padEnd(22)} ${String(spikes.length).padStart(6)}  ${(spikes.length / n * 100).toFixed(3)}%  `
    + `${q(0.5).toFixed(3)}    ${q(0.9).toFixed(3)}    ${q(0.99).toFixed(3)}    ${(spikes.length ? spikes[spikes.length - 1] : 0).toFixed(3)}`);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    const img = canvas(W, H + 14, [10, 10, 12]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 3;
      img.put(x, y + 14, px[k] * 0.4 + 15, px[k+1] * 0.4 + 15, px[k+2] * 0.4 + 15);
    }
    for (const [x, y, m] of marks) {
      const t = Math.min(1, (m - MIN) / 0.4);
      img.put(x, y + 14, 255, Math.round(220 * (1 - t)), 30);
    }
    text(img, 3, 3, `${path}  isolated albedo spikes >= ${MIN} stops`, [240, 240, 240], 1);
    const o = `${OUT}/${path.replace(/[^\w]+/g, '_')}.png`;
    writePNG(o, img);
    console.log(`   overlay: ${o}`);
  }
}

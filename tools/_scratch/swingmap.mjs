#!/usr/bin/env node
/**
 * swingmap — turn a run of frames into one picture of what MOVED.
 *
 *   node tools/_scratch/swingmap.mjs --dir shots/_scratch/scopetwinkle
 *
 * A still cannot show twinkle and two stills 6 s apart do not show it either:
 * the differences are a few percent of a small number and the eye slides off
 * them. This takes max-luma minus min-luma per pixel across every frame in a
 * directory and prints that, scaled up. A star that never changes is black
 * here; a star that swings is a bright dot, and how bright IS the swing.
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = resolve(arg('dir', 'shots/_scratch/scopetwinkle'));
const GAIN = parseFloat(arg('gain', '6'));

const files = readdirSync(DIR).filter((f) => /^f\d+\.png$/.test(f)).sort();
if (files.length < 2) { console.error('swingmap: need at least two frames'); process.exit(1); }
const b64s = files.map((f) => readFileSync(join(DIR, f)).toString('base64'));

const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ({ b64s, gain }) => {
  let W = 0, H = 0, mn = null, mx = null;
  for (const b of b64s) {
    const img = new Image(); img.src = 'data:image/png;base64,' + b; await img.decode();
    W = img.width; H = img.height;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    if (!mn) { mn = new Float32Array(W * H).fill(1e9); mx = new Float32Array(W * H).fill(-1e9); }
    for (let i = 0, n = W * H; i < n; i++) {
      const j = i * 4;
      const l = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
      if (l < mn[i]) mn[i] = l;
      if (l > mx[i]) mx[i] = l;
    }
  }
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  let peak = 0;
  for (let i = 0, n = W * H; i < n; i++) {
    const s = Math.min(1, (mx[i] - mn[i]) * gain);
    peak = Math.max(peak, mx[i] - mn[i]);
    const v = Math.round(Math.pow(s, 0.75) * 255);
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const b of buf) s += String.fromCharCode(b);
  return { png: btoa(s), peak };
}, { b64s, gain: GAIN });

const dest = join(DIR, 'swingmap.png');
writeFileSync(dest, Buffer.from(out.png, 'base64'));
console.log(`${files.length} frames, peak per-pixel swing ${out.peak.toFixed(4)} luma, gain x${GAIN}`);
console.log(dest);
await browser.close();

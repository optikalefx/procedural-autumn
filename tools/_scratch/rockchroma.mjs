#!/usr/bin/env node
/**
 * Rect-restricted colour statistics that report the MEAN and the DISTRIBUTION
 * of the same pixels, side by side.
 *
 *   node tools/_scratch/rockchroma.mjs <image> <fx,fy,fw,fh> [label] [...]
 *
 * This exists because two honest rock measurements in this project disagree:
 * one author measured a channel *ratio* at sample points and closed the colour
 * half of blocker #1; critic pass 6 measured the *distribution* of neutral vs
 * vivid pixels over the whole mass and called the same surface a different
 * material. Those are different quantities and a surface can pass one and fail
 * the other badly, so every reading here prints both, plus the chroma spread
 * and the hue spread that a single ratio cannot see.
 *
 * Rects are fractional (0-1) so they can be re-run against any resolution and
 * quoted in a commit message, per the critic's method note.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: rockchroma.mjs <image> <fx,fy,fw,fh> [label] [<image> <rect> [label] ...]');
  process.exit(1);
}

// Parse triples/pairs: image, rect, optional label (a label is any token that
// is not a path and not a rect).
const jobs = [];
for (let i = 0; i < args.length; ) {
  const file = args[i++];
  const rect = args[i++].split(',').map(Number);
  let label = '';
  if (i < args.length && !args[i].includes('/') && !/^[\d.]+,/.test(args[i])) label = args[i++];
  jobs.push({ file, rect, label: label || file.split('/').pop() });
}

await acquire('rockchroma');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const rows = [];
for (const job of jobs) {
  const ext = /\.jpe?g$/i.test(job.file) ? 'jpeg' : 'png';
  const b64 = readFileSync(job.file).toString('base64');
  const s = await page.evaluate(async ({ b64, ext, rect }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const [fx, fy, fw, fh] = rect;
    const sx = Math.round(fx * img.width), sy = Math.round(fy * img.height);
    const sw = Math.max(1, Math.round(fw * img.width)), sh = Math.max(1, Math.round(fh * img.height));
    const c = new OffscreenCanvas(sw, sh);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data;

    let sr = 0, sg = 0, sb = 0, n = 0, neutral = 0, vivid = 0;
    const lumas = [], chromas = [];
    const hues = new Array(12).fill(0);
    let chromatic = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      sr += r; sg += gg; sb += b; n++;
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const ch = mx - mn;
      lumas.push(l); chromas.push(ch);
      // Same thresholds as tools/colorstats.mjs so numbers are comparable.
      if (ch < 0.06) neutral++;
      if (ch > 0.35) vivid++;
      if (ch > 0.06) {
        chromatic++;
        let h;
        if (mx === r) h = ((gg - b) / ch) % 6;
        else if (mx === gg) h = (b - r) / ch + 2;
        else h = (r - gg) / ch + 4;
        h = ((h * 60) + 360) % 360;
        hues[Math.floor(h / 30)]++;
      }
    }
    lumas.sort((a, b) => a - b); chromas.sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const mean = lumas.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const mr = sr / n, mg = sg / n, mb = sb / n;
    // How many 30-degree hue buckets hold at least 5% of the chromatic pixels.
    const liveBuckets = hues.filter((h) => chromatic > 0 && h / chromatic >= 0.05).length;
    return {
      px: n,
      srgb: [Math.round(mr * 255), Math.round(mg * 255), Math.round(mb * 255)],
      ratio: [1, +(mg / mr).toFixed(3), +(mb / mr).toFixed(3)],
      lumaMean: +mean.toFixed(3),
      contrastStd: +sd.toFixed(3),
      chromaMean: +(chromas.reduce((a, b) => a + b, 0) / n).toFixed(3),
      chromaP05: +q(chromas, 0.05).toFixed(3),
      chromaP95: +q(chromas, 0.95).toFixed(3),
      chromaSpread: +(q(chromas, 0.95) - q(chromas, 0.05)).toFixed(3),
      neutralPct: +((neutral / n) * 100).toFixed(1),
      vividPct: +((vivid / n) * 100).toFixed(1),
      hueBuckets: liveBuckets,
    };
  }, { b64, ext, rect: job.rect });
  rows.push({ label: job.label, ...s });
}
await browser.close();

const keys = ['srgb', 'ratio', 'lumaMean', 'contrastStd', 'chromaMean', 'chromaP05',
  'chromaP95', 'chromaSpread', 'neutralPct', 'vividPct', 'hueBuckets'];
const w = Math.max(...rows.map((r) => r.label.length), 12);
console.log('MEAN-side and DISTRIBUTION-side statistics, same pixels');
console.log('field'.padEnd(14) + rows.map((r) => r.label.padStart(w + 2)).join(''));
for (const k of keys) {
  console.log(k.padEnd(14) + rows.map((r) => String(Array.isArray(r[k]) ? r[k].join(':') : r[k]).padStart(w + 2)).join(''));
}

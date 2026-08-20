#!/usr/bin/env node
/**
 * Rock-only statistics on a mask derived from a PAINT frame.
 *
 *   node tools/_scratch/rockpaintstats.mjs shots/rocks/wf-paint.png \
 *     --host shots/rocks/wf-hidden.png \
 *     shots/rocks/wf-base.png base shots/rocks/wf-z102.png z102
 *
 * Why not the --diff mask in rockmaskmap.mjs: differencing a rocks-on frame
 * against a rocks-hidden frame also catches everything that moved between the
 * two screenshots. Measured here, that mask covered 18.5% of the `waterfall`
 * frame with a whole-frame bounding box, and the pixels "behind the rock"
 * came back at chroma 0.295 / 43.7% vivid — that is swaying gold foliage and
 * moving water, not hillside. The rock system does not cover 18% of that frame.
 *
 * A paint frame (uRockDesat 1, uRockCast 6,0,0) marks rock by hue instead, so
 * a leaf that moved is still a leaf. The mask is computed ONCE and then applied
 * to every frame in the sweep, which also means every variant is measured over
 * an identical pixel set — a per-frame mask would move under the dial being
 * measured, and did: the diff mask swung 18.5% -> 21.9% across the sweep.
 *
 * --host <frame> additionally reports what those same pixels look like with the
 * rock hidden, i.e. exactly the hillside each rock covers. That pair is the
 * necklace test: rock against its own host, not against a rect drawn by eye.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const paint = argv[0];
const hi = argv.indexOf('--host');
const host = hi === -1 ? null : argv[hi + 1];
const ri = argv.indexOf('--region');
const region = ri === -1 ? null : argv[ri + 1].split(',').map(Number);

const rest = argv.slice(1).filter((a, i, arr) => {
  const prev = i === 0 ? argv[0] : arr[i - 1];
  return !a.startsWith('--') && prev !== '--host' && prev !== '--region';
});
const frames = [];
for (let i = 0; i < rest.length; i += 2) frames.push({ file: rest[i], label: rest[i + 1] || rest[i] });

await acquire('rockpaintstats');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const load = async (f) => page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  return { w: img.width, h: img.height, d: Array.from(d) };
}, readFileSync(f).toString('base64'));

await page.evaluate(() => { window.__store = {}; });
const put = async (key, f) => {
  const b64 = readFileSync(f).toString('base64');
  await page.evaluate(async ({ key, b64 }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    window.__store[key] = { w: img.width, h: img.height,
      d: g.getImageData(0, 0, img.width, img.height).data };
  }, { key, b64 });
};

await put('paint', paint);
if (host) await put('host', host);
for (const f of frames) await put(f.label, f.file);

const out = await page.evaluate(({ labels, hasHost, region }) => {
  const P = window.__store.paint;
  const { w, h, d } = P;
  // Same red test rockmaskmap.mjs uses: the most saturated warm thing in the
  // scene is a crimson canopy and it stays under +60.
  const idx = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (region && !(x >= region[0] * w && x < (region[0] + region[2]) * w
      && y >= region[1] * h && y < (region[1] + region[3]) * h)) continue;
    const i = (y * w + x) * 4;
    if (d[i] - d[i + 1] > 70 && d[i] - d[i + 2] > 70) idx.push(i);
  }
  const stat = (key) => {
    const a = window.__store[key];
    if (!a) return null;
    let sr = 0, sg = 0, sb = 0, sl = 0, sc = 0, neutral = 0, vivid = 0;
    const ls = [], cs = [];
    for (const i of idx) {
      const r = a.d[i] / 255, g = a.d[i + 1] / 255, b = a.d[i + 2] / 255;
      sr += r; sg += g; sb += b;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const ch = Math.max(r, g, b) - Math.min(r, g, b);
      sl += l; sc += ch; ls.push(l); cs.push(ch);
      if (ch < 0.06) neutral++;
      if (ch > 0.35) vivid++;
    }
    const n = idx.length;
    const mean = sl / n;
    const sd = Math.sqrt(ls.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return {
      srgb: [Math.round(255 * sr / n), Math.round(255 * sg / n), Math.round(255 * sb / n)],
      ratio: [1, +(sg / sr).toFixed(3), +(sb / sr).toFixed(3)],
      luma: +mean.toFixed(3),
      contrastStd: +sd.toFixed(3),
      chromaMean: +(sc / n).toFixed(3),
      neutralPct: +(100 * neutral / n).toFixed(1),
      vividPct: +(100 * vivid / n).toFixed(1),
    };
  };
  const rows = {};
  for (const l of labels) rows[l] = stat(l);
  if (hasHost) rows['HOST(hidden)'] = stat('host');
  return { pct: +(100 * idx.length / (w * h)).toFixed(3), px: idx.length, w, h, rows };
}, { labels: frames.map((f) => f.label), hasHost: !!host, region });

await browser.close();

console.log(`paint mask: ${out.px} px = ${out.pct}% of ${out.w}x${out.h}${region ? ' (region-restricted)' : ''}`);
const labels = Object.keys(out.rows);
const keys = ['srgb', 'ratio', 'luma', 'contrastStd', 'chromaMean', 'neutralPct', 'vividPct'];
const w = Math.max(...labels.map((l) => l.length), 13);
console.log('field'.padEnd(13) + labels.map((l) => l.padStart(w + 2)).join(''));
for (const k of keys) {
  console.log(k.padEnd(13) + labels.map((l) => {
    const v = out.rows[l] ? out.rows[l][k] : '-';
    return String(Array.isArray(v) ? v.join(':') : v).padStart(w + 2);
  }).join(''));
}

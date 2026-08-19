#!/usr/bin/env node
// Fine hue histogram (10 deg bins) + per-bin mean saturation, for judging hue
// *spread* rather than which coarse bucket a mass landed in.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from '../_lock.mjs';
const NB = parseInt(process.env.NB || '36', 10);
const files = process.argv.slice(2);
await acquire('huefine');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const rows = [];
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  rows.push([basename(f).slice(0, 14), await page.evaluate(async ({ b64, ext, NB }) => {
    const img = new Image(); img.src = `data:image/${ext};base64,${b64}`; await img.decode();
    const W = 480, H = Math.round(img.height / img.width * W);
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const N = parseInt(NB,10), hist = new Array(N).fill(0), sats = new Array(N).fill(0);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), ch = mx - mn;
      if (ch <= 0.04) continue;
      let h;
      if (mx === r) h = ((gg - b) / ch + 6) % 6;
      else if (mx === gg) h = (b - r) / ch + 2;
      else h = (r - gg) / ch + 4;
      const bin = Math.min(N - 1, Math.floor(h / 6 * N));
      hist[bin]++; sats[bin] += ch / mx; n++;
    }
    return hist.map((v, i) => [+(v / n * 100).toFixed(1), v ? +(sats[i] / v).toFixed(2) : 0]);
  }, { b64, ext, NB })]);
}
await browser.close();
const deg = (i) => String(Math.round(i * 360 / NB)).padStart(3);
console.log('deg  ' + rows.map((r) => r[0].padStart(16)).join(''));
for (let i = 0; i < NB; i++) {
  if (rows.every((r) => r[1][i][0] < 0.15)) continue;
  console.log(deg(i) + '  ' + rows.map((r) => `${String(r[1][i][0]).padStart(6)}% s${String(r[1][i][1]).padStart(5)}`).join(' '));
}

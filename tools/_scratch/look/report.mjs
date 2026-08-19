#!/usr/bin/env node
// One-stop look report for a set of frames. Pure image analysis, no browser
// boot beyond the offscreen canvas colorstats already uses.
//
//   node tools/_scratch/look/report.mjs shots/look/take/*.png
//
// Per frame:
//   P05 / P95 / range / std / chromaMean / neutral% / vivid%
//   hue-family census over CHROMATIC pixels only (chroma > 0.06), in the same
//   families the critic's numbers are quoted in, plus the cool half total.
//   The rose+magenta share is blocker 4; coolPct is blocker 2.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from '../../_lock.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: report.mjs <image …>'); process.exit(1); }

await acquire('lookreport');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const rows = [];
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  rows.push(await page.evaluate(async ({ b64, ext, name }) => {
    const img = new Image(); img.src = `data:image/${ext};base64,${b64}`; await img.decode();
    const W = 640, H = Math.max(1, Math.round(img.height / img.width * W));
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const lumas = [];
    let chromaSum = 0, neutral = 0, vivid = 0, n = 0;
    // 12 families, 30 deg each, starting at red.
    const FAM = ['red', 'orange', 'yellow', 'ygrn', 'green', 'sprg',
                 'cyan', 'azure', 'blue', 'viol', 'mgnt', 'rose'];
    const fam = new Array(12).fill(0);
    let chromatic = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const ch = mx - mn;
      lumas.push(l); chromaSum += ch; n++;
      if (ch < 0.06) neutral++;
      if (ch > 0.30) vivid++;
      if (ch > 0.06) {
        chromatic++;
        let h;
        if (mx === r) h = ((gg - b) / ch) % 6;
        else if (mx === gg) h = (b - r) / ch + 2;
        else h = (r - gg) / ch + 4;
        h = ((h * 60) % 360 + 360) % 360;
        fam[Math.floor(h / 30) % 12]++;
      }
    }
    lumas.sort((a, b) => a - b);
    const q = (p) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
    const mean = lumas.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const pc = (x) => +(100 * x / Math.max(chromatic, 1)).toFixed(1);
    const o = {
      frame: name,
      mean: +mean.toFixed(3), P05: +q(0.05).toFixed(3), P95: +q(0.95).toFixed(3),
      range: +(q(0.95) - q(0.05)).toFixed(3), std: +std.toFixed(3),
      chroma: +(chromaSum / n).toFixed(3),
      neut: +(100 * neutral / n).toFixed(1), vivid: +(100 * vivid / n).toFixed(1),
    };
    for (let i = 0; i < 12; i++) o[FAM[i]] = pc(fam[i]);
    // cool half = cyan..rose (indices 6..11)
    o.cool = +(o.cyan + o.azure + o.blue + o.viol + o.mgnt + o.rose).toFixed(1);
    o.rosemag = +(o.mgnt + o.rose).toFixed(1);
    return o;
  }, { b64, ext, name: basename(f).replace(/\.(png|jpg|jpeg)$/i, '') }));
}
await browser.close();
const short = rows.map((r) => ({
  frame: r.frame, mean: r.mean, P05: r.P05, P95: r.P95, range: r.range,
  std: r.std, chroma: r.chroma, neut: r.neut, vivid: r.vivid,
  cool: r.cool, rosemag: r.rosemag,
}));
console.table(short);
console.table(rows.map((r) => ({
  frame: r.frame, red: r.red, orange: r.orange, yellow: r.yellow, ygrn: r.ygrn,
  green: r.green, sprg: r.sprg, cyan: r.cyan, azure: r.azure, blue: r.blue,
  viol: r.viol, mgnt: r.mgnt, rose: r.rose,
})));

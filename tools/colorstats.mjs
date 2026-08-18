#!/usr/bin/env node
/**
 * Objective colour/tone statistics for a frame, so matching a reference look is
 * measurement rather than opinion.
 *
 *   node tools/colorstats.mjs shots/style/b-drive.png "reference-art/Zight ….jpg"
 *
 * Reports, per image: mean/median luminance, contrast (luma std dev), the 5th
 * and 95th luminance percentiles (the practical black and white points), mean
 * chroma, the share of pixels that are near-neutral vs strongly saturated, and
 * a coarse hue histogram. Two images side by side make it obvious whether a
 * frame is too dark, too flat, too desaturated, or hue-shifted.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from './_lock.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: colorstats.mjs <image> [image …]'); process.exit(1); }

await acquire('colorstats');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const rows = [];
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  const stats = await page.evaluate(async ({ b64, ext }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    // Downsample for speed; statistics are stable well below full resolution.
    const W = 480, H = Math.max(1, Math.round((img.height / img.width) * W));
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;

    const lumas = [], chromas = [];
    const hues = new Array(12).fill(0);
    let neutral = 0, vivid = 0, n = 0;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const chroma = mx - mn;
      lumas.push(l); chromas.push(chroma);
      if (chroma < 0.06) neutral++;
      if (chroma > 0.35) vivid++;
      if (chroma > 0.04) {
        let h;
        if (mx === r) h = ((gg - b) / chroma + 6) % 6;
        else if (mx === gg) h = (b - r) / chroma + 2;
        else h = (r - gg) / chroma + 4;
        hues[Math.min(11, Math.floor((h / 6) * 12))] += 1;
      }
      n++;
    }

    lumas.sort((a, b) => a - b);
    const pct = (p) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const varr = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
    const meanChroma = chromas.reduce((a, b) => a + b, 0) / chromas.length;
    const hueTotal = hues.reduce((a, b) => a + b, 0) || 1;

    return {
      lumaMean: +mean.toFixed(3),
      lumaMedian: +pct(0.5).toFixed(3),
      lumaP05: +pct(0.05).toFixed(3),
      lumaP95: +pct(0.95).toFixed(3),
      lumaRange: +(pct(0.95) - pct(0.05)).toFixed(3),
      contrastStd: +Math.sqrt(varr).toFixed(3),
      chromaMean: +meanChroma.toFixed(3),
      neutralPct: +((neutral / n) * 100).toFixed(1),
      vividPct: +((vivid / n) * 100).toFixed(1),
      hueHist: hues.map((v) => +((v / hueTotal) * 100).toFixed(1)),
    };
  }, { b64, ext });
  rows.push({ file: basename(f), ...stats });
}
await browser.close();

const HUE_LABELS = ['red', 'orange', 'yellow', 'y-grn', 'green', 'sprg', 'cyan', 'azure', 'blue', 'violet', 'mgnta', 'rose'];
const pad = (s, w) => String(s).padEnd(w);
const num = (v, w = 7) => String(v).padStart(w);

console.log(pad('metric', 15) + rows.map((r) => num(r.file.slice(0, 22), 24)).join(''));
for (const k of ['lumaMean', 'lumaMedian', 'lumaP05', 'lumaP95', 'lumaRange', 'contrastStd', 'chromaMean', 'neutralPct', 'vividPct']) {
  console.log(pad(k, 15) + rows.map((r) => num(r[k], 24)).join(''));
}
console.log('\nhue distribution (% of chromatic pixels)');
console.log(pad('hue', 15) + rows.map((r) => num(r.file.slice(0, 22), 24)).join(''));
for (let i = 0; i < 12; i++) {
  console.log(pad(HUE_LABELS[i], 15) + rows.map((r) => num(r.hueHist[i], 24)).join(''));
}

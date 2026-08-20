#!/usr/bin/env node
/**
 * Rect-restricted colour statistics, with the chroma *distribution* rather than
 * only its mean — which is the whole point of this tool.
 *
 *   node tools/_scratch/rockchroma.mjs <image> --rect x,y,w,h [--rect …] [--label name]
 *
 * A surface can carry the right mean channel ratio and still be the wrong
 * material, because the mean is blind to how chroma is *spread*. Two masses
 * with identical mean srgb:
 *
 *   A: every pixel at chroma 0.04                 -> neutralPct 100, vividPct 0
 *   B: half at chroma 0.45 warm, half 0.45 cool   -> neutralPct   0, vividPct 100
 *
 * So this reports mean ratio (comparable with every earlier measurement in
 * docs/) *and* neutralPct / vividPct / chroma percentiles / the chroma-vs-luma
 * split, on exactly the same pixels. Thresholds match tools/colorstats.mjs
 * (neutral < 0.06, vivid > 0.35) so the numbers are directly comparable.
 *
 * --split reports mean ratio separately for the darkest and brightest thirds of
 * the rect by luma, which is how you see a warm-lit / cool-shadow split that a
 * single mean hides.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const rects = [];
const consumed = new Set();
for (let i = 0; i < argv.length; i++) {
  // Value-taking flags consume the next token. Index-based, not value-based:
  // `--rect a --rect b` repeats the flag, so a set of values would only ever
  // mask the first one and every later rect would be mistaken for a filename.
  if (argv[i] === '--rect' || argv[i] === '--label') { consumed.add(i); consumed.add(i + 1); }
  if (argv[i] === '--rect') rects.push(argv[i + 1]);
}
const files = argv.filter((a, i) => !a.startsWith('--') && !consumed.has(i));
const SPLIT = argv.includes('--split');
const JSONOUT = argv.includes('--json');
if (!rects.length) rects.push('0,0,1,1');
if (!files.length) { console.error('usage: rockchroma.mjs <image …> --rect x,y,w,h'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const out = [];
for (const f of files) {
  const ext = /\.png$/i.test(f) ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  const res = await page.evaluate(async ({ b64, ext, rects, SPLIT }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const rows = [];
    for (const spec of rects) {
      const [rx, ry, rw, rh] = spec.split(',').map(Number);
      const x = Math.round(rx * img.width), y = Math.round(ry * img.height);
      const w = Math.max(1, Math.round(rw * img.width)), h = Math.max(1, Math.round(rh * img.height));
      const d = g.getImageData(x, y, w, h).data;
      let sr = 0, sg = 0, sb = 0, n = 0, neutral = 0, vivid = 0;
      const lumas = [], chromas = [], px = [];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
        const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        const ch = Math.max(r, gg, b) - Math.min(r, gg, b);
        sr += r; sg += gg; sb += b; n++;
        if (ch < 0.06) neutral++;
        if (ch > 0.35) vivid++;
        lumas.push(l); chromas.push(ch); px.push([l, r, gg, b]);
      }
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      const sorted = (a) => a.slice().sort((p, q) => p - q);
      const pct = (a, p) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))];
      const lm = mean(lumas);
      const sd = Math.sqrt(mean(lumas.map((v) => (v - lm) ** 2)));
      const R = sr / n, G = sg / n, B = sb / n;
      const row = {
        rect: spec, n,
        srgb: [Math.round(R * 255), Math.round(G * 255), Math.round(B * 255)],
        ratio: [1, +(G / R).toFixed(3), +(B / R).toFixed(3)],
        lumaMean: +lm.toFixed(3), contrastStd: +sd.toFixed(3),
        lumaP05: +pct(lumas, 0.05).toFixed(3), lumaP95: +pct(lumas, 0.95).toFixed(3),
        range: +(pct(lumas, 0.95) - pct(lumas, 0.05)).toFixed(3),
        chromaMean: +mean(chromas).toFixed(3),
        chromaP50: +pct(chromas, 0.5).toFixed(3), chromaP90: +pct(chromas, 0.9).toFixed(3),
        neutralPct: +(100 * neutral / n).toFixed(1),
        vividPct: +(100 * vivid / n).toFixed(1),
      };
      if (SPLIT) {
        px.sort((p, q) => p[0] - q[0]);
        const third = Math.floor(px.length / 3);
        const band = (arr) => {
          const r = mean(arr.map((p) => p[1])), gg = mean(arr.map((p) => p[2])), b = mean(arr.map((p) => p[3]));
          const ch = arr.map((p) => Math.max(p[1], p[2], p[3]) - Math.min(p[1], p[2], p[3]));
          return {
            srgb: [Math.round(r * 255), Math.round(gg * 255), Math.round(b * 255)],
            ratio: [1, +(gg / r).toFixed(3), +(b / r).toFixed(3)],
            chromaMean: +mean(ch).toFixed(3),
          };
        };
        row.dark = band(px.slice(0, third));
        row.light = band(px.slice(-third));
      }
      rows.push(row);
    }
    return rows;
  }, { b64, ext, rects, SPLIT });
  for (const r of res) out.push({ file: basename(f), ...r });
}
await browser.close();
if (JSONOUT) console.log(JSON.stringify(out, null, 1));
else for (const r of out) {
  console.log(`${r.file}  ${r.rect}  srgb(${r.srgb})  ${r.ratio[0]}:${r.ratio[1]}:${r.ratio[2]}`);
  console.log(`   luma ${r.lumaMean} sd ${r.contrastStd} range ${r.range} | chroma mean ${r.chromaMean} p50 ${r.chromaP50} p90 ${r.chromaP90} | neutral ${r.neutralPct}% vivid ${r.vividPct}%`);
  if (r.dark) console.log(`   dark3rd srgb(${r.dark.srgb}) ${r.dark.ratio.join(':')} C${r.dark.chromaMean}   light3rd srgb(${r.light.srgb}) ${r.light.ratio.join(':')} C${r.light.chromaMean}`);
}

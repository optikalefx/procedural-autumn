#!/usr/bin/env node
/**
 * Crop + magnify a region of a PNG so a defect can actually be looked at.
 *   node crop.mjs <in.png> <x> <y> <w> <h> <scale> <out.png>
 * Also prints the mean/median sRGB of the crop.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [inp, X, Y, W, H, S, out] = process.argv.slice(2);
const x = +X, y = +Y, w = +W, h = +H, s = +(S || 3);

const b64 = readFileSync(inp).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const res = await page.evaluate(async ({ b64, x, y, w, h, s }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * s; c.height = h * s;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  // stats on the unscaled crop
  const c2 = document.createElement('canvas');
  c2.width = w; c2.height = h;
  const g2 = c2.getContext('2d');
  g2.drawImage(img, x, y, w, h, 0, 0, w, h);
  const d = g2.getImageData(0, 0, w, h).data;
  let r = 0, gg = 0, bb = 0, n = 0;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++;
    lum.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
  }
  lum.sort((a, b) => a - b);
  const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
  return {
    png: c.toDataURL('image/png').split(',')[1],
    mean: [Math.round(r / n), Math.round(gg / n), Math.round(bb / n)],
    lumaP05: +q(0.05).toFixed(3), lumaP50: +q(0.5).toFixed(3), lumaP95: +q(0.95).toFixed(3),
  };
}, { b64, x, y, w, h, s });
writeFileSync(out, Buffer.from(res.png, 'base64'));
console.log(`${inp} [${x},${y} ${w}x${h}] mean=srgb(${res.mean.join(',')}) luma p05/p50/p95 = ${res.lumaP05}/${res.lumaP50}/${res.lumaP95}`);
await browser.close();

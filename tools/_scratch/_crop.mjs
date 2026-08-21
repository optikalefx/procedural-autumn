#!/usr/bin/env node
/**
 * _crop — cut a square out of a capture and scale it up, nearest-neighbour.
 *
 *   node tools/_scratch/_crop.mjs in.png out.png <cx> <cy> <half> <scale>
 *
 * A planet is forty pixels of a 1600x900 frame. Judging its limb, its Cassini
 * division or whether its edge is aliasing cannot be done at that size, and
 * scaling with smoothing invents detail that is not there — which is the one
 * thing an instrument must not do. Nearest-neighbour only.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [src, dst, cx, cy, half, scale] = process.argv.slice(2);
const b64 = readFileSync(src).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const out = await page.evaluate(async ({ b64, cx, cy, half, scale }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const n = half * 2, o = n * scale;
  const c = new OffscreenCanvas(o, o);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, cx - half, cy - half, n, n, 0, 0, o, o);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}, { b64, cx: +cx, cy: +cy, half: +half, scale: +scale });
writeFileSync(dst, Buffer.from(out, 'base64'));
await browser.close();

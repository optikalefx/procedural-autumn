#!/usr/bin/env node
// Crop + nearest-neighbour zoom a PNG. usage: zoom.mjs in.png x,y,w,h out.png [scale]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [file, geo, out, S] = process.argv.slice(2);
const [x, y, w, h] = geo.split(',').map(Number);
const scale = Number(S || 2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const b64 = readFileSync(file).toString('base64');
const dataUrl = await page.evaluate(async ({ b64, x, y, w, h, scale }) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
  const c = new OffscreenCanvas(w * scale, h * scale);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * scale, h * scale);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}, { b64, x, y, w, h, scale });
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(dataUrl, 'base64'));
console.log('ok', out);

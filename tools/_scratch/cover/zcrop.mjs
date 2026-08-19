// zcrop.mjs <file> x,y,w,h <out.png> [scale]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const [file, geo, out, scaleArg] = process.argv.slice(2);
const [x, y, w, h] = geo.split(',').map(Number);
const S = Number(scaleArg || 1);
const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const b64 = readFileSync(file).toString('base64');
const png = await page.evaluate(async ({ b64, x, y, w, h, mime, S }) => {
  const img = new Image(); img.src = 'data:' + mime + ';base64,' + b64; await img.decode();
  const c = new OffscreenCanvas(Math.round(w * S), Math.round(h * S));
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, Math.round(w * S), Math.round(h * S));
  const blob = await c.convertToBlob({ type: 'image/png' });
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}, { b64, x, y, w, h, mime, S });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(png));
console.log('wrote', out);
await browser.close();

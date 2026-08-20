import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [file, x, y, w, h, scale, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 64, height: 64 } });
const png = await p.evaluate(async ({ b64, x, y, w, h, s }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = new OffscreenCanvas(w * s, h * s);
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s2 = ''; for (const v of buf) s2 += String.fromCharCode(v);
  return btoa(s2);
}, { b64: readFileSync(file).toString('base64'), x: +x, y: +y, w: +w, h: +h, s: +scale });
writeFileSync(out, Buffer.from(png, 'base64'));
await b.close();

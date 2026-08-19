import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [file, geo, out] = process.argv.slice(2);
const [x,y,w,h] = geo.split(',').map(Number);
const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const b64 = readFileSync(file).toString('base64');
const png = await page.evaluate(async ({ b64, x, y, w, h, mime }) => {
  const img = new Image(); img.src = `data:${mime};base64,${b64}`; await img.decode();
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
  g.drawImage(img, x, y, w, h, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const ab = await blob.arrayBuffer();
  return Array.from(new Uint8Array(ab));
}, { b64, x, y, w, h, mime });
writeFileSync(out, Buffer.from(png));
console.log('wrote', out);
await browser.close();

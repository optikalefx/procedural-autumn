#!/usr/bin/env node
/** Width of the bright (whitewater) run per scanline, in a column band. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [inp, X0, X1, Y0, Y1, STEP] = process.argv.slice(2);
const x0 = +X0, x1 = +X1, y0 = +Y0, y1 = +Y1, step = +(STEP || 20);
const b64 = readFileSync(inp).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const rows = await page.evaluate(async ({ b64, x0, x1, y0, y1, step }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const out = [];
  for (let y = y0; y <= y1; y += step) {
    let lo = -1, hi = -1, n = 0;
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      const r = d[i], gg = d[i + 1], bb = d[i + 2];
      const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * bb) / 255;
      // whitewater: bright and not warm (blue >= red)
      if (lum > 0.70 && bb >= r - 4) { if (lo < 0) lo = x; hi = x; n++; }
    }
    out.push({ y, lo, hi, span: lo < 0 ? 0 : hi - lo + 1, n });
  }
  return out;
}, { b64, x0, x1, y0, y1, step });
for (const r of rows) console.log(`y=${r.y}  x ${r.lo}..${r.hi}  span=${r.span}px  lit=${r.n}`);
await browser.close();

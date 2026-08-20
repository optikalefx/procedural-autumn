#!/usr/bin/env node
// False-colour the rose/magenta pixels so the number is looked at before it is
// quoted. Green = hue 285-350 deg with chroma > 0.04. sRGB as stored.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 64, height: 64 } });
const d = await p.evaluate(async ({ B }) => {
  const i = new Image(); i.src = 'data:image/png;base64,' + B; await i.decode();
  const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d');
  g.drawImage(i, 0, 0);
  const im = g.getImageData(0, 0, i.width, i.height), a = im.data;
  for (let k = 0; k < a.length; k += 4) {
    const r = a[k] / 255, gg = a[k + 1] / 255, bb = a[k + 2] / 255;
    const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb), ch = mx - mn;
    if (ch <= 0.04) continue;
    let h; if (mx === r) h = ((gg - bb) / ch + 6) % 6;
    else if (mx === gg) h = (bb - r) / ch + 2; else h = (r - gg) / ch + 4;
    const deg = h * 60;
    if (deg >= 285 && deg < 350) { a[k] = 0; a[k + 1] = 255; a[k + 2] = 0; }
  }
  g.putImageData(im, 0, 0);
  const bl = await c.convertToBlob({ type: 'image/png' });
  return Array.from(new Uint8Array(await bl.arrayBuffer()));
}, { B: readFileSync(inp).toString('base64') });
writeFileSync(out, Buffer.from(d));
console.log(out);
await b.close();

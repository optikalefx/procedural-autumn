// Mean sRGB of rectangles in any image (jpg/png). usage: refsample.mjs img x,y,w,h[:label] ...
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, ...rects] = process.argv.slice(2);
const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const b64 = readFileSync(file).toString('base64');
const out = await page.evaluate(async ({ b64, rects, mime }) => {
  const img = new Image(); img.src = `data:${mime};base64,${b64}`; await img.decode();
  const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return rects.map((spec) => {
    const [geo, label] = spec.split(':');
    const [x, y, w, h] = geo.split(',').map(Number);
    const d = g.getImageData(x, y, w, h).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    r /= n; gg /= n; b /= n;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    return { label: label ?? geo, r: +r.toFixed(1), g: +gg.toFixed(1), b: +b.toFixed(1),
             luma: +((0.2126*r + 0.7152*gg + 0.0722*b) / 255).toFixed(3),
             chroma: +((mx - mn) / 255).toFixed(3),
             hex: '#' + [r,gg,b].map(v => Math.round(v).toString(16).padStart(2,'0')).join('') };
  });
}, { b64, rects, mime });
console.log(out.map(o => `${o.label.padEnd(18)} ${o.hex}  rgb(${o.r},${o.g},${o.b})  luma ${o.luma}  chroma ${o.chroma}`).join('\n'));
await browser.close();

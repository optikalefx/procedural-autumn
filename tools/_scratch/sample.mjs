import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, ...boxes] = process.argv.slice(2);
const b = readFileSync(file).toString('base64');
const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const out = await page.evaluate(async ({ b, ext, boxes }) => {
  const img = new Image(); img.src = `data:image/${ext};base64,${b}`; await img.decode();
  const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return boxes.map((bx) => {
    const [fx, fy, fw, fh] = bx.split(',').map(Number);
    const x = Math.round(fx * img.width), y = Math.round(fy * img.height);
    const w = Math.max(1, Math.round(fw * img.width)), h = Math.max(1, Math.round(fh * img.height));
    const d = g.getImageData(x, y, w, h).data;
    let r = 0, gg = 0, bb = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i+1]; bb += d[i+2]; n++; }
    r /= n; gg /= n; bb /= n;
    const L = (0.2126*r + 0.7152*gg + 0.0722*bb) / 255;
    return `${bx}  srgb(${r.toFixed(0)},${gg.toFixed(0)},${bb.toFixed(0)})  luma ${L.toFixed(3)}  chroma ${((Math.max(r,gg,bb)-Math.min(r,gg,bb))/255).toFixed(3)}`;
  });
}, { b, ext, boxes });
console.log(file); out.forEach((o) => console.log(' ', o));
await browser.close();

// Report the brightest pixels in a region, and the region histogram peak.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, ...rects] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 32, height: 32 } });
const data = 'data:image/png;base64,' + readFileSync(file).toString('base64');
const out = await p.evaluate(async ({ data, rects }) => {
  const img = new Image(); img.src = data; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  return rects.map((r) => {
    const [x, y, w, h] = r.split(',').map(Number);
    const d = g.getImageData(x, y, w, h).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i+1], d[i+2]]);
    px.sort((a, b) => (b[0]+b[1]+b[2]) - (a[0]+a[1]+a[2]));
    const top = px.slice(0, Math.max(1, (px.length * 0.08) | 0));
    let R=0,G=0,B=0; for (const q of top) { R+=q[0]; G+=q[1]; B+=q[2]; }
    R/=top.length; G/=top.length; B/=top.length;
    return `${r} top8% srgb(${R.toFixed(0)},${G.toFixed(0)},${B.toFixed(0)}) ratio 1:${(G/R).toFixed(3)}:${(B/R).toFixed(3)}  [${img.width}x${img.height}]`;
  });
}, { data, rects });
console.log(out.join('\n'));
await b.close();

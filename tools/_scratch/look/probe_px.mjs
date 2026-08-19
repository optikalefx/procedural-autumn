// Average colour of normalised rectangles of an image. Regions: name,x0,y0,x1,y1 (0..1)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
const file = process.argv[2];
const regions = JSON.parse(process.argv[3]);
await acquire('colorstats');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 64, height: 64 } });
const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
const b64 = readFileSync(file).toString('base64');
const out = await p.evaluate(async ({ b64, ext, regions }) => {
  const img = new Image(); img.src = `data:image/${ext};base64,${b64}`; await img.decode();
  const W = 640, H = Math.round(img.height / img.width * W);
  const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  return regions.map(([n, x0, y0, x1, y1]) => {
    const X = Math.round(x0*W), Y = Math.round(y0*H);
    const w = Math.max(1, Math.round((x1-x0)*W)), h = Math.max(1, Math.round((y1-y0)*H));
    const d = g.getImageData(X, Y, w, h).data;
    let r=0,gg=0,bb=0,n2=0;
    for (let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];bb+=d[i+2];n2++;}
    r=Math.round(r/n2); gg=Math.round(gg/n2); bb=Math.round(bb/n2);
    const hex = '#'+[r,gg,bb].map(v=>v.toString(16).padStart(2,'0')).join('');
    const lum = (0.2126*r+0.7152*gg+0.0722*bb)/255;
    const chroma = (Math.max(r,gg,bb)-Math.min(r,gg,bb))/255;
    const ratio = `1:${(gg/Math.max(r,1e-6)).toFixed(3)}:${(bb/Math.max(r,1e-6)).toFixed(3)}`;
    return `${n.padEnd(16)} ${hex}  srgb(${r},${gg},${bb})  ${ratio}  luma ${lum.toFixed(3)}  chroma ${chroma.toFixed(3)}`;
  });
}, { b64, ext, regions });
console.log(out.join('\n'));
await b.close();

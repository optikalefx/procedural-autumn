import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [f1, f2, region] = process.argv.slice(2);
const [rx, ry, rw, rh] = region.split(',').map(Number);
const b = await chromium.launch(); const p = await b.newPage();
const enc = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
const r = await p.evaluate(async ([a, c, rx, ry, rw, rh]) => {
  const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
  const A = await load(a), B = await load(c);
  const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(A, 0, 0); const da = g.getImageData(rx, ry, rw, rh).data;
  g.clearRect(0,0,A.width,A.height); g.drawImage(B, 0, 0); const db = g.getImageData(rx, ry, rw, rh).data;
  let n = 0, max = 0, sum = 0, tot = rw*rh;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i]-db[i]), Math.abs(da[i+1]-db[i+1]), Math.abs(da[i+2]-db[i+2]));
    if (d > 2) n++; if (d > max) max = d; sum += d;
  }
  return { n, max, mean: sum/tot, pct: 100*n/tot };
}, [enc(f1), enc(f2), rx, ry, rw, rh]);
console.log(`region ${region}: changed ${r.pct.toFixed(1)}%, max ${r.max}, mean ${r.mean.toFixed(2)}`);
await b.close();

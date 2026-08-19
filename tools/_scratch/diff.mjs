import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const files = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage();
const enc = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
const r = await p.evaluate(async ([a, c]) => {
  const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
  const A = await load(a), B = await load(c);
  const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, A.width, A.height).data;
  g.clearRect(0,0,A.width,A.height); g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, A.width, A.height).data;
  let n = 0, max = 0, sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i]-db[i]), Math.abs(da[i+1]-db[i+1]), Math.abs(da[i+2]-db[i+2]));
    if (d > 2) n++; if (d > max) max = d; sum += d;
  }
  return { n, max, mean: sum / (A.width*A.height), total: A.width*A.height };
}, [enc(files[0]), enc(files[1])]);
console.log(`${files[0]} vs ${files[1]}: differing pixels(>2) ${r.n} (${(100*r.n/r.total).toFixed(2)}%), max ${r.max}, mean ${r.mean.toFixed(2)}`);
await b.close();

// Whole-arc tone/colour table for two sweep directories, side by side, with no
// browser. `colorstats.mjs` launches Chromium per invocation, which is fine for
// four frames and unusable for the thirteen hours this round judges as a
// sequence. Same statistics, read straight off the PNG bytes.
//
//   node tools/_scratch/arcstats.mjs --a shots/tod-seedbase --b shots/tod-r3 --view river
import { readPNG } from '../_pngread.mjs';
import { readdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const A = arg('a'), B = arg('b'), VIEW = arg('view', 'river');

const hourOf = (f) => parseFloat(f.replace(/^.*-h/, '').replace('.png', '').replace('p', '.'));
const files = readdirSync(A).filter((f) => f.startsWith(VIEW + '-h')).sort((x, y) => hourOf(x) - hourOf(y));

function stats(path) {
  const { w: width, h: height, px: data } = readPNG(path);
  const n = width * height;
  const lum = new Float64Array(n);
  let chroma = 0, neutral = 0, vivid = 0;
  for (let i = 0, p = 0; p < n; p++, i += 3) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const c = Math.max(r, g, b) - Math.min(r, g, b);
    chroma += c;
    if (c < 0.06) neutral++;
    if (c > 0.35) vivid++;
  }
  lum.sort();
  const pct = (q) => lum[Math.floor(q * n)];
  const mean = lum.reduce((x, y) => x + y, 0) / n;
  let v = 0; for (let i = 0; i < n; i++) v += (lum[i] - mean) ** 2;
  return {
    mean, p05: pct(0.05), p95: pct(0.95), range: pct(0.95) - pct(0.05),
    std: Math.sqrt(v / n), chroma: chroma / n, neutral: neutral / n * 100, vivid: vivid / n * 100,
  };
}

const f3 = (x) => x.toFixed(3).padStart(6);
console.log(`${VIEW}                       A = ${A}   B = ${B}`);
console.log('hour     mean A / B      P05 A / B      P95 A / B     range A / B      std A / B   chroma A / B   neut%A / B');
for (const f of files) {
  let a, b;
  try { a = stats(`${A}/${f}`); b = stats(`${B}/${f}`); } catch { continue; }
  console.log(
    `${String(hourOf(f)).padStart(5)}  ${f3(a.mean)}${f3(b.mean)}  ${f3(a.p05)}${f3(b.p05)}  ` +
    `${f3(a.p95)}${f3(b.p95)}  ${f3(a.range)}${f3(b.range)}  ${f3(a.std)}${f3(b.std)}  ` +
    `${f3(a.chroma)}${f3(b.chroma)}  ${a.neutral.toFixed(1).padStart(5)}${b.neutral.toFixed(1).padStart(6)}`);
}

// Scratch: how many pixels OUTSIDE the marshmallow change between two ladder rungs.
//   node tools/_scratch/mglow.mjs dir a b [thresh]
import { readPNG } from '../_pngread.mjs';
import { readFileSync } from 'node:fs';
const [dir, A, B, T] = process.argv.slice(2);
const th = +(T ?? 2);
const meta = JSON.parse(readFileSync(`${dir}/ROAST.json`, 'utf8'));
const f = (n) => meta.frames.find((x) => x.name === n);
const a = readPNG(`${dir}/${A}.png`), b = readPNG(`${dir}/${B}.png`);
const mp = f(A).probe.mallowPx, r = mp.diameter / 2 * 1.6;
const bpp = a.px.length / (a.w * a.h);
let n = 0, sum = 0, mx = 0;
for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
  if (Math.hypot(x - mp.x, y - mp.y) < r) continue;
  const o = (y * a.w + x) * bpp;
  const d = Math.max(Math.abs(a.px[o] - b.px[o]), Math.abs(a.px[o+1] - b.px[o+1]), Math.abs(a.px[o+2] - b.px[o+2]));
  if (d >= th) { n++; sum += d; mx = Math.max(mx, d); }
}
console.log(`${A} vs ${B}: outside-subject pixels changed by >=${th}: ${n}  meanDelta ${(sum/Math.max(1,n)).toFixed(2)}  maxDelta ${mx}  glow ${f(A).state.glow.toFixed(3)} -> ${f(B).state.glow.toFixed(3)}`);

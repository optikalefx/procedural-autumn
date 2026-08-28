// Scratch: the standing rule. Marshmallow value against the flame core's.
//   node tools/_scratch/mgate.mjs dir frame
// The flame core is found, not assumed: the brightest 120x120 window in the
// frame that does not overlap the recorded mallowPx disc. Reporting where it
// landed is part of the output, because a gate that measured the wrong object
// is the failure mode docs/CRITIC_PROTOCOL.md is about.
import { readPNG } from '../_pngread.mjs';
import { readFileSync } from 'node:fs';
const [dir, name] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(`${dir}/ROAST.json`, 'utf8'));
const f = meta.frames.find((x) => x.name === name);
const img = readPNG(`${dir}/${name}.png`), bpp = img.px.length / (img.w * img.h);
const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LUT = Array.from({ length: 256 }, (_, i) => lin(i));
const L = new Float32Array(img.w * img.h);
for (let i = 0, o = 0; i < L.length; i++, o += bpp)
  L[i] = 0.2126 * LUT[img.px[o]] + 0.7152 * LUT[img.px[o + 1]] + 0.0722 * LUT[img.px[o + 2]];

const mp = f.probe.mallowPx, mr = mp.diameter / 2;
const W = 120, STEP = 20;
let best = -1, bx = 0, by = 0;
for (let y = 0; y + W < img.h; y += STEP) for (let x = 0; x + W < img.w; x += STEP) {
  if (Math.hypot(x + W / 2 - mp.x, y + W / 2 - mp.y) < mr + W * 0.7) continue;
  let s = 0;
  for (let j = y; j < y + W; j += 4) for (let i = x; i < x + W; i += 4) s += L[j * img.w + i];
  if (s > best) { best = s; bx = x; by = y; }
}
const q = (arr, p) => { arr.sort((a, b) => a - b); return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]; };
const grab = (fn) => { const a = []; for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (fn(x, y)) a.push(L[y * img.w + x]); return a; };
const mall = grab((x, y) => Math.hypot(x - mp.x, y - mp.y) < mr * 0.80);
const flame = grab((x, y) => x >= bx && x < bx + W && y >= by && y < by + W);
const show = (n, a) => console.log(n.padEnd(12), 'mean', (a.reduce((p, c) => p + c, 0) / a.length).toFixed(3),
  'p95', q(a.slice(), 0.95).toFixed(3), 'p99', q(a.slice(), 0.99).toFixed(3), 'max', q(a.slice(), 1).toFixed(3));
console.log(`${dir}/${name}.png  hour ${f.hour}  doneness ${f.state.doneness.toFixed(2)}  flame box at ${bx},${by}`);
show('marshmallow', mall);
show('flame core', flame);
const mmax = q(mall.slice(), 1), fp95 = q(flame.slice(), 0.95);
console.log(mmax < fp95 ? `PASS  mallow max ${mmax.toFixed(3)} < flame p95 ${fp95.toFixed(3)}`
                        : `FAIL  mallow max ${mmax.toFixed(3)} >= flame p95 ${fp95.toFixed(3)}`);
console.log(`      mallow p99 ${q(mall.slice(),0.99).toFixed(4)} vs flame p99 ${q(flame.slice(),0.99).toFixed(4)}`);

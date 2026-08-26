// Scratch: per-rung colour/value report for the marshmallow body.
//   node tools/_scratch/mallowramp.mjs <dir> [frame ...]
// Body region = disc of 0.80 of the recorded mallowPx radius; background =
// annulus 1.20r..1.55r. Linear luma is Rec.709 on linearised sRGB.
import { readPNG } from '../_pngread.mjs';
import { readFileSync } from 'node:fs';

const dir = process.argv[2] ?? 'shots/roast/r5-view';
const want = process.argv.slice(3);
const meta = JSON.parse(readFileSync(`${dir}/ROAST.json`, 'utf8'));
const byName = Object.fromEntries(meta.frames.map((f) => [f.name, f]));

const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LUT = Array.from({ length: 256 }, (_, i) => lin(i));

function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c < 1e-6) return { h: 0, c: 0, s: 0 };
  let h;
  if (mx === r) h = ((g - b) / c + 6) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return { h: h * 60, c, s: c / Math.max(mx, 1e-6) };
}

function stats(px, w, h, cx, cy, r0, r1) {
  const out = { n: 0, lum: [], r: 0, g: 0, b: 0, hue: new Array(24).fill(0), hueN: 0, sat: 0 };
  const bpp = px.length / (w * h);
  for (let y = Math.max(0, Math.floor(cy - r1)); y < Math.min(h, Math.ceil(cy + r1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r1)); x < Math.min(w, Math.ceil(cx + r1)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r0 || d > r1) continue;
      const o = (y * w + x) * bpp;
      const R = px[o], G = px[o + 1], B = px[o + 2];
      out.n++; out.r += R; out.g += G; out.b += B;
      out.lum.push(0.2126 * LUT[R] + 0.7152 * LUT[G] + 0.0722 * LUT[B]);
      const { h: hu, c, s } = hueOf(R, G, B);
      if (c > 20) { out.hue[Math.min(23, Math.floor(hu / 15))]++; out.hueN++; out.sat += s; }
    }
  }
  out.lum.sort((a, b) => a - b);
  const q = (p) => out.lum[Math.min(out.lum.length - 1, Math.floor(p * out.lum.length))];
  return {
    n: out.n,
    mean: out.lum.reduce((a, b) => a + b, 0) / out.lum.length,
    p50: q(0.5), p95: q(0.95), p99: q(0.99), max: out.lum[out.lum.length - 1],
    rgb: [out.r / out.n, out.g / out.n, out.b / out.n].map((v) => Math.round(v)),
    hue: out.hue, hueN: out.hueN, sat: out.sat / Math.max(1, out.hueN),
  };
}

const names = want.length ? want : meta.frames.map((f) => f.name).filter((n) => /^(mallow|ladder)-/.test(n));
console.log('frame        done   bodyLuma  p95    max    meanRGB        meanHue satMean  bg     ratio');
for (const n of names) {
  const f = byName[n]; if (!f) continue;
  const mp = f.probe?.mallowPx; if (!mp?.onScreen) { console.log(n, 'no mallowPx'); continue; }
  const img = readPNG(`${dir}/${n}.png`);
  const r = mp.diameter / 2;
  const body = stats(img.px, img.w, img.h, mp.x, mp.y, 0, r * 0.80);
  const bg = stats(img.px, img.w, img.h, mp.x, mp.y, r * 1.25, r * 1.60);
  const hm = hueOf(body.rgb[0], body.rgb[1], body.rgb[2]);
  const top = body.hue.map((v, i) => [v / Math.max(1, body.hueN), i * 15]).sort((a, b) => b[0] - a[0]).slice(0, 3)
    .filter((x) => x[0] > 0.02).map(([p, d]) => `${d}deg:${(p * 100).toFixed(0)}%`).join(' ');
  console.log(
    n.padEnd(12),
    (f.state?.doneness ?? 0).toFixed(2),
    body.mean.toFixed(4).padStart(8), body.p95.toFixed(3), body.max.toFixed(3),
    `[${body.rgb.join(',')}]`.padEnd(15),
    `${hm.h.toFixed(0)}deg`.padStart(7), body.sat.toFixed(2).padStart(6),
    bg.mean.toFixed(3).padStart(6), (body.mean / bg.mean).toFixed(2).padStart(5), ' ', top,
  );
}

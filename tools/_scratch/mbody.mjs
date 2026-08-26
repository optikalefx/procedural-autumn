// Scratch: the marshmallow's BODY, in the composed first-person frame.
//
//   node tools/_scratch/mbody.mjs shots/roast/r9-toast [--mask]
//
// mgate.mjs measures a disc at 0.80 of the recorded radius, and at the ladder
// pose that disc is not the marshmallow. Two things get inside it:
//
//   · the plume, which is brighter than the object and leaks past the
//     silhouette at the top and the right;
//   · the STICK, whose tip emerges at (+24, +1) px from the recorded centre and
//     renders at 253,169,144 on EVERY rung — raw and char alike, to one unit of
//     255. That single speck is what mgate reports as "mallow max" from
//     ladder-2 down, which is why rungs 3, 4 and 5 all came back at exactly
//     0.513: it was never reading the sugar.
//
// This measures three rings instead, all inside the real silhouette, and the
// stick is cut out of every one of them:
//
//   body   r < 0.45 R    what the eye calls "the marshmallow's colour"
//   limb   0.62 - 0.76 R the paper-lantern rim (inside the real silhouette,
//                       which is smaller than the recorded bounding disc)
//   back   1.30 - 1.70 R the backdrop the subject has to separate from
//
// The stick cut is a wedge, not a colour key: the stick leaves the mallow
// toward the lower right at a fixed screen angle in this view, so the sample
// drops everything within STICK_HALF of that bearing. --mask writes the sample
// footprint next to the frame so the cut can be checked rather than trusted.
import { readPNG } from '../_pngread.mjs';
import { readFileSync } from 'node:fs';
import { writePNG } from '../_png.mjs';

const args = process.argv.slice(2);
const dir = args[0];
const WANT_MASK = args.includes('--mask');
const meta = JSON.parse(readFileSync(`${dir}/ROAST.json`, 'utf8'));

const lin = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LUT = Array.from({ length: 256 }, (_, i) => lin(i));

// Screen bearing of the stick out of the marshmallow, and the half-angle cut.
const STICK_DIR = Math.atan2(0.62, 0.78);   // down and to the right
const STICK_HALF = 0.80;                     // radians

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((p, c) => p + c, 0) / a.length;

function ring(img, bpp, mp, lo, hi, cutStick, mask) {
  const R = mp.diameter / 2;
  const L = [], r = [], g = [], b = [];
  const x0 = Math.max(0, Math.floor(mp.x - hi * R - 2)), x1 = Math.min(img.w - 1, Math.ceil(mp.x + hi * R + 2));
  const y0 = Math.max(0, Math.floor(mp.y - hi * R - 2)), y1 = Math.min(img.h - 1, Math.ceil(mp.y + hi * R + 2));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - mp.x, dy = y - mp.y, d = Math.hypot(dx, dy) / R;
    if (d < lo || d > hi) continue;
    if (cutStick) {
      let a = Math.atan2(dy, dx) - STICK_DIR;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      if (Math.abs(a) < STICK_HALF) continue;
    }
    const o = (y * img.w + x) * bpp;
    const lr = LUT[img.px[o]], lg = LUT[img.px[o + 1]], lb = LUT[img.px[o + 2]];
    L.push(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
    r.push(lr); g.push(lg); b.push(lb);
    if (mask) mask[y * img.w + x] = 1;
  }
  return { L, r: mean(r), g: mean(g), b: mean(b), n: L.length };
}

const rows = [];
for (const f of meta.frames) {
  const mp = f.probe?.mallowPx;
  if (!mp?.onScreen) continue;
  if (!/^ladder-/.test(f.name)) continue;
  const img = readPNG(`${dir}/${f.name}.png`), bpp = img.px.length / (img.w * img.h);
  const mask = WANT_MASK ? new Uint8Array(img.w * img.h) : null;
  const body = ring(img, bpp, mp, 0, 0.45, true, mask);
  const limb = ring(img, bpp, mp, 0.62, 0.76, true, mask);
  const back = ring(img, bpp, mp, 1.30, 1.70, false, null);
  // The gate window: everything inside 0.80 R that is not the stick, which is
  // mgate's own window with the one thing that was setting its answer taken
  // out. The flame is mgate's box, found the same way.
  const gate = ring(img, bpp, mp, 0, 0.80, true, null);
  // A whole-frame linear-luma plane, so the flame side of the standing rule
  // can be found below without re-reading the PNG.
  const L = new Float32Array(img.w * img.h);
  for (let i = 0, o = 0; i < L.length; i++, o += bpp)
    L[i] = 0.2126 * LUT[img.px[o]] + 0.7152 * LUT[img.px[o + 1]] + 0.0722 * LUT[img.px[o + 2]];
  rows.push({ name: f.name, done: f.state.doneness, body, limb, back, gate, img, L, mp });
  if (mask) {
    const px = new Uint8Array(img.w * img.h * 3);
    for (let i = 0; i < mask.length; i++) {
      const o = i * bpp;
      if (mask[i]) { px[i * 3] = 0; px[i * 3 + 1] = 255; px[i * 3 + 2] = 0; }
      else { px[i * 3] = img.px[o]; px[i * 3 + 1] = img.px[o + 1]; px[i * 3 + 2] = img.px[o + 2]; }
    }
    writePNG(`${dir}/${f.name}-mask.png`, { w: img.w, h: img.h, px });
  }
}

console.log(`${dir}  hour ${meta.hour}   (linear luma; G/R is linear)`);
console.log('rung        done   bodyMean  bodyMed   limbMean  back    body:back   body G/R');
for (const r of rows) {
  const bm = mean(r.body.L), bk = mean(r.back.L);
  console.log(
    r.name.padEnd(11),
    r.done.toFixed(2).padStart(4),
    '  ' + bm.toFixed(4).padStart(7),
    ' ' + q(r.body.L, 0.5).toFixed(4).padStart(7),
    '  ' + mean(r.limb.L).toFixed(4).padStart(7),
    ' ' + bk.toFixed(4).padStart(6),
    '  ' + (bm / bk).toFixed(3).padStart(6),
    '     ' + (r.body.g / r.body.r).toFixed(3),
  );
}
const b0 = mean(rows[0]?.body.L ?? [0]);
console.log('\nas a fraction of the raw rung:',
  rows.map((r) => (mean(r.body.L) / b0).toFixed(2)).join('  '));
let mono = true;
for (let i = 1; i < rows.length; i++) if (mean(rows[i].body.L) >= mean(rows[i - 1].body.L)) mono = false;
console.log(mono ? 'MONOTONIC  every rung darker than the one before it'
                 : 'NOT MONOTONIC');

console.log('\nthe standing rule, with the stick cut out of the window:');
console.log('rung        p95     p99     max   | flame p95   margin');
// The FLAME side of the rule, found the way mgate.mjs finds it — the brightest
// 120 x 120 window that does not overlap the recorded marshmallow disc, so the
// object it measures is reported rather than assumed. mgate's flame half was
// never the broken half; only its marshmallow window was (it sampled the stick
// tip). This pairs mgate's flame finder with this tool's body window so the
// rule is measured with the right sample on both sides in one run.
for (const r of rows) {
  const img = r.img, L = r.L, mp = r.mp, mr = mp.diameter / 2;
  const W = 120, STEP = 20;
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y + W < img.h; y += STEP) for (let x = 0; x + W < img.w; x += STEP) {
    if (Math.hypot(x + W / 2 - mp.x, y + W / 2 - mp.y) < mr + W * 0.7) continue;
    let s2 = 0;
    for (let j = y; j < y + W; j += 4) for (let i = x; i < x + W; i += 4) s2 += L[j * img.w + i];
    if (s2 > best) { best = s2; bx = x; by = y; }
  }
  const flame = [];
  for (let y = by; y < by + W; y++) for (let x = bx; x < bx + W; x++) flame.push(L[y * img.w + x]);
  const fp95 = q(flame, 0.95), mmax = q(r.gate.L, 1);
  console.log(r.name.padEnd(11),
    q(r.gate.L, 0.95).toFixed(3), ' ', q(r.gate.L, 0.99).toFixed(3), ' ', q(r.gate.L, 1).toFixed(3),
    '  |  ' + fp95.toFixed(3) + '     ' + (fp95 / mmax).toFixed(2) + 'x  ' +
    (mmax < fp95 ? 'PASS' : 'FAIL') + '   flame box ' + bx + ',' + by);
}

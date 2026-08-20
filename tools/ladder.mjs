#!/usr/bin/env node
/**
 * Point-sample any image — a reference plate or one of our captures — at named
 * normalised positions, and report what is actually there.
 *
 * colorstats.mjs answers "is the whole frame too flat"; it cannot answer "is
 * our zenith the same colour as the plate's zenith", which is the only question
 * that matters when matching a sky. Every sky number in Lighting.js was
 * arrived at by eye or by whole-frame averages, and the comments there record
 * how often that went wrong.
 *
 *   node tools/ladder.mjs reference-art/morning-night-dawn-dusk/night.jpg --sky
 *   node tools/ladder.mjs plate.jpg shots/ours.png --sky        # side by side
 *   node tools/ladder.mjs img.png --at 0.5,0.1 --at 0.2,0.8
 *   node tools/ladder.mjs night.jpg --stars
 *
 * Ratios are linear-light R:G:B normalised to the max channel, which is the
 * form the keyframe comments in Lighting.js are written in.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--') &&
  /\.(png|jpe?g)$/i.test(a));
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const ats = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--at' && argv[i + 1]) {
    const [x, y] = argv[i + 1].split(',').map(Number);
    ats.push({ label: `${x},${y}`, x, y });
  }
}

if (!files.length) { console.error('usage: ladder.mjs <image…> [--sky] [--stars] [--at x,y]'); process.exit(1); }

// A vertical ladder up the frame plus a horizon band. Positions are the ones
// the art brief actually argues about: the top of the dome, mid sky, the band
// just over the ridge, and the ground in three depth planes.
const SKY_POINTS = [
  { label: 'zenith      ', x: 0.50, y: 0.03 },
  { label: 'upper sky   ', x: 0.50, y: 0.12 },
  { label: 'mid sky     ', x: 0.50, y: 0.25 },
  { label: 'low sky     ', x: 0.50, y: 0.36 },
  { label: 'horizon band', x: 0.50, y: 0.46 },
  { label: 'sky L edge  ', x: 0.06, y: 0.20 },
  { label: 'sky R edge  ', x: 0.94, y: 0.20 },
  { label: 'far ground  ', x: 0.50, y: 0.56 },
  { label: 'mid ground  ', x: 0.50, y: 0.72 },
  { label: 'near ground ', x: 0.50, y: 0.92 },
  { label: 'near L      ', x: 0.14, y: 0.88 },
  { label: 'near R      ', x: 0.86, y: 0.88 },
];

const points = ats.length ? ats : (has('sky') || !has('stars') ? SKY_POINTS : []);
const PATCH = parseInt(arg('patch', '11'), 10);

await acquire('ladder');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const results = [];
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async ({ b64, ext, points, PATCH, wantStars }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const W = img.width, H = img.height;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

    const samples = points.map((p) => {
      const cx = Math.round(p.x * (W - 1)), cy = Math.round(p.y * (H - 1));
      const h = PATCH >> 1;
      let r = 0, gq = 0, b = 0, n = 0;
      for (let y = Math.max(0, cy - h); y <= Math.min(H - 1, cy + h); y++)
        for (let x = Math.max(0, cx - h); x <= Math.min(W - 1, cx + h); x++) {
          const px = at(x, y); r += px[0]; gq += px[1]; b += px[2]; n++;
        }
      r /= n; gq /= n; b /= n;
      const lr = toLin(r), lg = toLin(gq), lb = toLin(b);
      const mx = Math.max(lr, lg, lb) || 1e-6;
      const luma = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      const smx = Math.max(r, gq, b) / 255, smn = Math.min(r, gq, b) / 255;
      return {
        label: p.label,
        srgb: [Math.round(r), Math.round(gq), Math.round(b)],
        hex: '#' + [r, gq, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
        ratio: [lr / mx, lg / mx, lb / mx],
        luma, chroma: smx - smn,
      };
    });

    let stars = null;
    if (wantStars) {
      // Count local maxima in the upper 45% of the frame that sit clearly above
      // their own neighbourhood. That is what reads as "a star" and it is
      // insensitive to how bright the sky behind it is.
      const y1 = Math.floor(H * 0.45);
      const lum = new Float32Array(W * y1);
      for (let y = 0; y < y1; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        lum[y * W + x] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      let count = 0; const mags = []; let skySum = 0, skyN = 0;
      for (let y = 2; y < y1 - 2; y++) for (let x = 2; x < W - 2; x++) {
        const v = lum[y * W + x];
        skySum += v; skyN++;
        let localMax = true, ring = 0, rn = 0;
        for (let dy = -2; dy <= 2 && localMax; dy++) for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const u = lum[(y + dy) * W + (x + dx)];
          if (u > v) { localMax = false; break; }
          if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { ring += u; rn++; }
        }
        if (!localMax) continue;
        const bg = ring / Math.max(1, rn);
        if (v - bg > 0.045) { count++; mags.push(v - bg); }
      }
      mags.sort((a, b) => b - a);
      const q = (p) => mags.length ? mags[Math.min(mags.length - 1, Math.floor(p * mags.length))] : 0;
      stars = {
        count,
        perMpx: count / ((W * y1) / 1e6),
        skyMeanLuma: skySum / Math.max(1, skyN),
        magP10: q(0.10), magP50: q(0.50), magP90: q(0.90), magMax: mags[0] ?? 0,
        // Brightness spread: a field where every star is the same value reads
        // as noise, not as a sky.
        magRatio: (mags[0] ?? 0) / Math.max(1e-6, q(0.90)),
      };
    }
    return { W, H, samples, stars };
  }, { b64, ext, points, PATCH, wantStars: has('stars') });

  results.push({ f, ...r });
}

for (const r of results) {
  console.log(`\n── ${basename(r.f)}  ${r.W}x${r.H}`);
  if (r.samples.length) {
    console.log('   point           hex       sRGB              lin R:G:B            luma   chroma');
    for (const s of r.samples) {
      console.log(`   ${s.label}  ${s.hex}  ${String(s.srgb.join(',')).padEnd(15)}  ` +
        `1 : ${(s.ratio[1] / s.ratio[0]).toFixed(3)} : ${(s.ratio[2] / s.ratio[0]).toFixed(3)}`.padEnd(21) +
        `  ${s.luma.toFixed(3)}  ${s.chroma.toFixed(3)}`);
    }
  }
  if (r.stars) {
    const s = r.stars;
    console.log(`   stars: ${s.count} (${s.perMpx.toFixed(0)}/Mpx)  sky mean luma ${s.skyMeanLuma.toFixed(4)}`);
    console.log(`   magnitude over local sky — p10 ${s.magP10.toFixed(3)}  p50 ${s.magP50.toFixed(3)}  ` +
                `p90 ${s.magP90.toFixed(3)}  max ${s.magMax.toFixed(3)}  spread x${s.magRatio.toFixed(1)}`);
  }
}
console.log();
await browser.close();

#!/usr/bin/env node
/**
 * Scratch: the blink test, measured rather than squinted at.
 *
 * Takes a burst of frames captured at the same pose a fraction of a second
 * apart, finds every firefly in the union of them, and prints a per-insect
 * brightness track. What it has to show is (a) individual tracks that move,
 * and (b) tracks that do NOT move together — a field pulsing in unison is the
 * failure mode, and it would show here as identical columns.
 *
 *   node tools/_scratch/ffblink.mjs shots/ff-blink/camp-h22-*.png
 */
import { readPNG } from './../_pngread.mjs';

const files = process.argv.slice(2);
const imgs = files.map(readPNG);
const W = imgs[0].w, H = imgs[0].h;
const lit = (d, i) => d[i + 1] > 90 && d[i + 1] - d[i + 2] > 30 && d[i + 1] >= d[i] - 10;

// Union mask over the burst, then coarse blobs — an insect dark in one frame
// still has to be found, so the sites come from the union and not from frame 0.
const cell = 7, gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
const grid = new Uint8Array(gw * gh);
for (const im of imgs) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lit(im.px, (y * W + x) * 3)) grid[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
  }
}
const seen = new Uint8Array(gw * gh);
const sites = [];
for (let i = 0; i < grid.length; i++) {
  if (!grid[i] || seen[i]) continue;
  const stack = [i]; seen[i] = 1; let sx = 0, sy = 0, n = 0;
  while (stack.length) {
    const j = stack.pop(), jx = j % gw, jy = (j / gw) | 0;
    sx += jx; sy += jy; n++;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = jx + dx, ny = jy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const k = ny * gw + nx;
      if (grid[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
  }
  sites.push([Math.round((sx / n) * cell + cell / 2), Math.round((sy / n) * cell + cell / 2)]);
}

const peak = (im, cx, cy, rad = 6) => {
  let m = 0;
  for (let y = Math.max(0, cy - rad); y <= Math.min(H - 1, cy + rad); y++) {
    for (let x = Math.max(0, cx - rad); x <= Math.min(W - 1, cx + rad); x++) {
      const i = (y * W + x) * 3;
      const g = im.px[i + 1] - im.px[i + 2];   // green over blue: the firefly signal
      if (g > m) m = g;
    }
  }
  return m;
};

console.log(`${sites.length} insect sites across ${imgs.length} frames; each row is one insect's`);
console.log('green-over-blue peak per frame (0 = dark):\n');
const rows = sites.map(([x, y]) => [x, y, imgs.map((im) => peak(im, x, y))]);
let moved = 0;
for (const [x, y, t] of rows) {
  const mn = Math.min(...t), mx = Math.max(...t);
  if (mx - mn > 20) moved++;
}
for (const [x, y, t] of rows.slice(0, 28)) {
  console.log(`(${String(x).padStart(4)},${String(y).padStart(3)})  ` + t.map((v) => String(v).padStart(4)).join(''));
}
console.log(`\n${moved} of ${rows.length} insects changed brightness by more than 20 across the burst.`);
// Unison check: the per-frame totals of a field pulsing together swing hugely;
// independent phases keep the total nearly flat while the individuals move.
const totals = imgs.map((im, k) => rows.reduce((a, r) => a + r[2][k], 0));
const tmin = Math.min(...totals), tmax = Math.max(...totals);
console.log('per-frame TOTAL:', totals.map((v) => v.toFixed(0)).join('  '),
            `  swing ${(100 * (tmax - tmin) / tmax).toFixed(1)}% of peak`);

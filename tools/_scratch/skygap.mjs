// How much sky the canopy lets through, in a shipped framing.
//
// The blind A/B split 1-1 on whether the fuller mid crowns read better, which
// is what a +8% area change on mid trees looks like to the eye in a dusk
// frame. This counts it instead: a pixel is "sky" if it is bright and low in
// chroma, and the canopy band is the part of the frame above the horizon where
// the trees are. Fewer sky pixels in the same framing = a crown that covers.
import { readPNG } from '../_pngread.mjs';

const views = process.argv.slice(3);
const dirs = process.argv[2].split(',');

for (const v of views) {
  const row = [];
  for (const d of dirs) {
    const { w, h, px } = readPNG(`${d}/${v}.png`);
    let sky = 0, n = 0;
    const y1 = Math.floor(h * 0.55);              // above the ground plane
    for (let y = 0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        const r = px[o], g = px[o + 1], b = px[o + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        n++;
        if (mx > 150 && mx - mn < 46) sky++;      // bright and near-neutral
      }
    }
    row.push({ d, pct: (sky / n) * 100 });
  }
  console.log(v.padEnd(11), row.map((r) => `${r.d.split('/').pop()} ${r.pct.toFixed(2)}%`).join('   '),
    `  first->last ${(row[row.length - 1].pct - row[0].pct).toFixed(2)} pts`);
}

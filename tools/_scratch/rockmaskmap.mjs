#!/usr/bin/env node
/**
 * Where on screen does the rock material actually draw?
 *
 *   node tools/_scratch/rockmaskmap.mjs shots/rocks/mask-hero-paint.png
 *
 * Feed it a frame captured with the rock material forced to pure red
 * (uRockDesat 1, uRockCast 6,0,0). Prints the share of the frame the material
 * owns, its bounding box, and a coarse occupancy grid so a measurement rect can
 * be aimed at rock instead of at whatever is behind it.
 *
 * Written because two separate findings in docs/CRITIC_FINDINGS.md quote rock
 * colour on rects picked by eye off a screenshot, and a rect picked that way
 * cannot tell a rock from the terrain massif it is sitting on.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// --diff A B: mask = pixels that differ by more than --thresh (default 6/255).
// Use it with a rocks-hidden frame; a paint mask misses anything far enough
// away that the haze has eaten the paint, and rock at 800 m is exactly that.
const DIFF = argv.includes('--diff');
const TH = Number((argv[argv.indexOf('--thresh') + 1]) || 6);
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--thresh');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const pairs = DIFF ? [[files[0], files[1]]] : files.map((f) => [f, null]);
for (const [f, f2] of pairs) {
  const res = await page.evaluate(async ({ b64, b642, TH }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let d2 = null;
    if (b642) {
      const j = new Image();
      j.src = 'data:image/png;base64,' + b642;
      await j.decode();
      const c2 = new OffscreenCanvas(j.width, j.height);
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(j, 0, 0);
      d2 = g2.getImageData(0, 0, j.width, j.height).data;
    }
    const GX = 20, GY = 12;
    const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
    const cell = Array.from({ length: GY }, () => new Array(GX).fill(0));
    let hits = 0, n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const gy = Math.min(GY - 1, Math.floor(y / img.height * GY));
      const gx = Math.min(GX - 1, Math.floor(x / img.width * GX));
      cell[gy][gx]++; n++;
      // "Red-led far beyond anything the palette contains." The most saturated
      // warm thing in the scene is a crimson canopy, which stays under +60.
      const hit = d2
        ? (Math.abs(r - d2[i]) + Math.abs(gg - d2[i + 1]) + Math.abs(b - d2[i + 2])) / 3 > TH
        : (r - gg > 70 && r - b > 70);
      if (hit) {
        hits++; grid[gy][gx]++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return {
      w: img.width, h: img.height, pct: +(100 * hits / n).toFixed(3), hits,
      bbox: hits ? [+(x0 / img.width).toFixed(3), +(y0 / img.height).toFixed(3),
        +((x1 - x0) / img.width).toFixed(3), +((y1 - y0) / img.height).toFixed(3)] : null,
      grid: grid.map((row, gy) => row.map((v, gx) => Math.round(100 * v / cell[gy][gx]))),
    };
  }, { b64: readFileSync(f).toString('base64'), b642: f2 ? readFileSync(f2).toString('base64') : null, TH });
  console.log(`${f}${f2 ? ' vs ' + f2 : ''}  ${res.w}x${res.h}  mask covers ${res.pct}% of pixels  bbox ${JSON.stringify(res.bbox)}`);
  console.log('  occupancy %, 20x12 grid (row = 1/12 of frame height):');
  for (const row of res.grid) console.log('   ' + row.map((v) => String(v).padStart(3)).join(''));
}
await browser.close();

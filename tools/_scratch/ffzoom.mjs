#!/usr/bin/env node
/**
 * Scratch: crop a region of a capture and nearest-neighbour magnify it, plus a
 * count of "hot green pixels" so the density and the blink can be measured
 * rather than squinted at. A 3 px firefly does not survive being looked at in a
 * downscaled review image, which is how the first pass read as "renders
 * nothing" when it was in fact drawing.
 *
 *   node tools/_scratch/ffzoom.mjs shots/x.png --box 300,380,500,260 --zoom 3 --out /tmp/z.png
 *   node tools/_scratch/ffzoom.mjs shots/x.png --count
 */
import { readPNG } from './../_pngread.mjs';
import { writePNG } from './../_png.mjs';

const argv = process.argv.slice(2);
const src = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const img = readPNG(src);
const W = img.w, H = img.h, data = img.px, ch = 3;
const px = (x, y) => {
  const i = (y * W + x) * ch;
  return [data[i], data[i + 1], data[i + 2]];
};

if (has('count')) {
  // A firefly pixel: green-dominant, green well above blue, and bright. The
  // night scene's grass is lavender (B >= G), so this cannot pick it up.
  let hot = 0, sumx = 0, sumy = 0;
  const cols = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(x, y);
    if (g > 90 && g - b > 30 && g >= r - 10) { hot++; sumx += x; sumy += y; cols.push([r, g, b]); }
  }
  // Connected-ish blob count via a coarse grid, good enough to say "two dozen".
  const cell = 6, gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(x, y);
    if (g > 90 && g - b > 30 && g >= r - 10) grid[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
  }
  let blobs = 0;
  const seen = new Uint8Array(gw * gh);
  const stack = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || seen[i]) continue;
    blobs++; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), jx = j % gw, jy = (j / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (grid[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
  }
  const avg = cols.length ? cols.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => Math.round(v / cols.length)) : [0, 0, 0];
  console.log(JSON.stringify({ file: src, hotPixels: hot, blobs, avgHot: avg }));
} else {
  const [bx, by, bw, bh] = String(arg('box', `0,0,${W},${H}`)).split(',').map(Number);
  const z = Number(arg('zoom', '3'));
  const out = { w: bw * z, h: bh * z, px: new Uint8Array(bw * z * bh * z * 3) };
  for (let y = 0; y < bh * z; y++) for (let x = 0; x < bw * z; x++) {
    const [r, g, b] = px(Math.min(W - 1, bx + ((x / z) | 0)), Math.min(H - 1, by + ((y / z) | 0)));
    const o = (y * bw * z + x) * 3;
    out.px[o] = r; out.px[o + 1] = g; out.px[o + 2] = b;
  }
  const dst = arg('out', '/tmp/ffzoom.png');
  writePNG(dst, out);
  console.log(dst, out.w + 'x' + out.h);
}

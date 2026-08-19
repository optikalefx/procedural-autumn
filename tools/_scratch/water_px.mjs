#!/usr/bin/env node
/**
 * Water author's pixel probe. Same PNG decode as rock_px.mjs (no capture slot),
 * but reports what matters for water: the value *spread* inside a rectangle and
 * how much of it is clipped, because a fall that has gone flat white and a fall
 * with structure in it have almost the same mean.
 *
 *   node tools/_scratch/water_px.mjs shots/water/d3/fallnear.png 0.38,0.4,0.55,0.95
 */
import { decodePNG } from './rock_px.mjs';

const [file, ...rects] = process.argv.slice(2);
const { w: width, h: height, ch, data } = decodePNG(file);

const report = (name, x0, y0, x1, y1) => {
  const ls = [];
  let clipped = 0, n = 0, r = 0, g = 0, b = 0;
  for (let y = Math.round(y0 * height); y < Math.round(y1 * height); y++) {
    for (let x = Math.round(x0 * width); x < Math.round(x1 * width); x++) {
      const i = (y * width + x) * ch;
      const R = data[i] / 255, G = data[i + 1] / 255, B = data[i + 2] / 255;
      r += R; g += G; b += B; n++;
      if (R > 0.985 && G > 0.985 && B > 0.985) clipped++;
      ls.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
  }
  ls.sort((a, c) => a - c);
  const q = (p) => ls[Math.min(ls.length - 1, Math.round(p * ls.length))].toFixed(3);
  console.log(`${name}  n=${n}  rgb=${(r / n).toFixed(3)},${(g / n).toFixed(3)},${(b / n).toFixed(3)}` +
              `  luma p05=${q(0.05)} p50=${q(0.5)} p95=${q(0.95)}` +
              `  white=${(clipped / n * 100).toFixed(1)}%`);
};

if (!rects.length) {
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    report(`cell ${i},${j}`, i / 3, j / 3, (i + 1) / 3, (j + 1) / 3);
  }
} else {
  for (const rc of rects) {
    const [x0, y0, x1, y1] = rc.split(',').map(Number);
    report(rc, x0, y0, x1, y1);
  }
}

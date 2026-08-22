#!/usr/bin/env node
/**
 * Whole-arc tone/colour table for two or three shot directories, in Node, with
 * no browser. One row per <view>-<hour> per arm, so a change to the keyframe
 * table can be read as a sequence rather than as fifty separate stills.
 *
 *   node tools/_scratch/arcstat.mjs --dirs shots/r2-base,shots/r2-head,shots/r2-t1
 *   node tools/_scratch/arcstat.mjs --dirs a,b --only sunlow
 *
 * Columns, all on the *display* pixels the player sees:
 *   mean   frame mean luma
 *   P05/95 practical black and white points
 *   sd     luma standard deviation — the frame's contrast
 *   chr    mean chroma, (max-min)/max on the sRGB triple
 *   warm   mean of (R-B)/(R+B+1e-6), the frame's warm/cool balance
 *   gband  the same four for the lower third of the frame only, which is the
 *          ground in every one of the five canonical framings. A vista's mean
 *          is mostly sky and a sky that did not move can hide a ground that
 *          did — this is the column the terminator lives in.
 *
 * NOT a substitute for looking. It cannot see a terminator, a silhouette or a
 * hue that is merely ugly; it exists to narrow which frames are worth reading
 * at full resolution.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readPNG } from '../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const dirs = String(arg('dirs', '')).split(',').map((s) => s.trim()).filter(Boolean);
if (dirs.length < 1) { console.error('need --dirs a,b[,c]'); process.exit(1); }
const only = arg('only', null);

function stats(path) {
  const { w: W, h: H, px: data } = readPNG(path);
  const CH = data.length / (W * H);
  const acc = (y0, y1) => {
    const lum = [];
    let chr = 0, warm = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * CH;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        chr += mx > 0 ? (mx - mn) / mx : 0;
        warm += (r - b) / (r + b + 1e-6);
        n++;
      }
    }
    lum.sort((a, b) => a - b);
    const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
    const sd = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / lum.length);
    const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
    return { mean, sd, p05: q(0.05), p95: q(0.95), chr: chr / n, warm: warm / n };
  };
  return { full: acc(0, H), ground: acc(Math.floor(H * 2 / 3), H) };
}

const names = new Set();
for (const d of dirs) {
  if (!existsSync(d)) { console.error(`missing dir: ${d}`); process.exit(1); }
  for (const f of readdirSync(d)) if (f.endsWith('.png')) names.add(f);
}
const keep = [...names].filter((f) => !only || f.startsWith(only + '-'));

// view, then hour numerically — so the arc reads in order.
const hourOf = (f) => parseFloat(basename(f, '.png').split('-h')[1].replace('p', '.'));
const viewOf = (f) => basename(f, '.png').split('-h')[0];
keep.sort((a, b) => viewOf(a).localeCompare(viewOf(b)) || hourOf(a) - hourOf(b));

const tag = dirs.map((d) => basename(d).padEnd(9));
console.log(`frame              arm        mean   P05    P95    sd     chr    warm  | gnd mean  sd     chr    warm`);
let lastView = null;
for (const f of keep) {
  if (viewOf(f) !== lastView) { lastView = viewOf(f); console.log(''); }
  for (let i = 0; i < dirs.length; i++) {
    const p = join(dirs[i], f);
    if (!existsSync(p)) continue;
    const s = stats(p);
    const n = (v) => v.toFixed(3).padStart(6);
    console.log(
      `${(i === 0 ? basename(f, '.png') : '').padEnd(18)} ${tag[i]} ` +
      `${n(s.full.mean)}${n(s.full.p05)}${n(s.full.p95)}${n(s.full.sd)}${n(s.full.chr)}${n(s.full.warm)} | ` +
      `${n(s.ground.mean)}${n(s.ground.sd)}${n(s.ground.chr)}${n(s.ground.warm)}`);
  }
}

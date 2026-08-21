#!/usr/bin/env node
/**
 * shellprobe — measure ONLY the shell-tinted surfaces, and bisect what lifts
 * them at dusk.
 *
 * Every previous attempt at this question measured the wrong pixels: once the
 * whole prop's histogram, in which the dew shield is 8%; once a hand-picked box
 * that turned out to be sky. So the region comes from a build with
 * `SHELL = 0xff0000`, which makes every shell-tinted surface unambiguous, and
 * that frame is used as a mask over the normal build shot from the identical
 * camera. `scopelab` is deterministic — same seed, same site, same pose — so
 * the two frames register exactly.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const MASK = process.argv[2];
const FRAMES = process.argv.slice(3);
const release = await acquire('shellprobe');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const f of FRAMES) {
  const r = await page.evaluate(async ({ a, b }) => {
    const load = async (s) => {
      const img = new Image(); img.src = `data:image/png;base64,${s}`; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    };
    const d = await load(a), mk = await load(b);
    const ls = [];
    for (let i = 0; i < d.length; i += 4) {
      // Strongly red in the mask build = a shell-tinted surface. The grade
      // desaturates it, so this is a red-dominance test, not an equality test.
      if (mk[i] > 90 && (mk[i] - mk[i + 1]) > 40 && (mk[i] - mk[i + 2]) > 30) {
        ls.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      }
    }
    ls.sort((x, y) => x - y);

    return { n: ls.length, med: ls.length ? ls[Math.floor(ls.length * 0.5)] : 0,
             p90: ls.length ? ls[Math.floor(ls.length * 0.9)] : 0,
             p10: ls.length ? ls[Math.floor(ls.length * 0.1)] : 0 };
  }, { a: readFileSync(f).toString('base64'), b: readFileSync(MASK).toString('base64') });
  console.log(`${f.split('/').pop().padEnd(30)} shell px ${String(r.n).padStart(6)}  ` +
    `p10 ${r.p10.toFixed(1).padStart(6)}  med ${r.med.toFixed(1).padStart(6)}  p90 ${r.p90.toFixed(1).padStart(6)}`);
}
await browser.close();
release();

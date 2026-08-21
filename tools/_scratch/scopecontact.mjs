#!/usr/bin/env node
/**
 * scopecontact — how much does the telescope darken the ground under it?
 *
 *   node tools/_scratch/scopecontact.mjs shots/camp/scope/r15/reflector-high.png
 *
 * The measurement three critic rounds have led with, made repeatable. The camp
 * chair darkens the ground beneath it by 44-65% and the telescope measured 1.7%,
 * which is noise; the sun's shadow map cannot resolve a 34 mm tripod leg, so the
 * contact is authored as a blended pool instead. This says whether the pool is
 * doing the job, by differencing the frame against a twin shot with the pool
 * hidden — `scopelab` writes that twin for the plan view.
 *
 * Reports the mean darkening over the pixels the pool actually affects, its
 * peak, and the area it covers, so "the shadow is there" and "the shadow is
 * strong enough" are two separate answers.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from '../_lock.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: scopecontact.mjs <frame.png> […]'); process.exit(1); }

const release = await acquire('scopecontact');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const f of files) {
  const twin = f.replace(/\.png$/, '.nocontact.png');
  if (!existsSync(twin)) { console.log(`${basename(f)}: no .nocontact twin — reshoot with scopelab`); continue; }
  const r = await page.evaluate(async ({ a, b }) => {
    const load = async (s) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    };
    const A = await load(a), B = await load(b);
    const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let n = 0, sum = 0, peak = 0;
    const drops = [];
    for (let i = 0; i < A.length; i += 4) {
      const la = L(A, i), lb = L(B, i);
      // Only where the pool made it DARKER, and by more than the scene's own
      // frame-to-frame motion: grass moves, so a 1% threshold measures wind.
      const drop = lb > 0.02 ? (lb - la) / lb : 0;
      if (drop > 0.03) { n++; sum += drop; drops.push(drop); if (drop > peak) peak = drop; }
    }
    // The CORE, which is what a critic measures when they say "under the
    // object": the darkest tenth of the affected pixels. A mean over the whole
    // pool is dominated by its own falloff and says a broad weak stain and a
    // tight strong contact are the same thing, which is the mistake that took
    // one revision of this asset in the wrong direction.
    drops.sort((a, b) => b - a);
    const core = drops.slice(0, Math.max(1, Math.round(drops.length * 0.1)));
    const coreMean = core.reduce((a, b) => a + b, 0) / core.length;
    return { px: n, mean: n ? sum / n : 0, core: coreMean, peak, total: A.length / 4 };
  }, { a: readFileSync(f).toString('base64'), b: readFileSync(twin).toString('base64') });
  const verdict = r.px < 400 ? 'FAIL — the pool is not drawing'
    : r.core < 0.44 ? `WEAK — core ${(r.core * 100).toFixed(1)}% against a chair's 44-65%`
    : 'PASS';
  console.log(`${basename(f).padEnd(26)} darkened ${r.px} px ` +
    `(${((r.px / r.total) * 100).toFixed(2)}% of frame)  core ${(r.core * 100).toFixed(1)}%  ` +
    `mean ${(r.mean * 100).toFixed(1)}%  peak ${(r.peak * 100).toFixed(1)}%   ${verdict}`);
}
await browser.close();
release();

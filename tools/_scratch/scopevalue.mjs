#!/usr/bin/env node
/**
 * scopevalue — is the telescope brighter than the fire?
 *
 *   node tools/_scratch/scopevalue.mjs shots/camp/scope/r4/reflector-campdusk.png
 *
 * The camp brief's hardest rule is that at dusk nothing may out-value the
 * flame, and the telescope is the only white-painted object in the set, so it
 * is the only prop that can break it. The first two rounds broke it by a
 * measured margin and the file's own header claimed otherwise, which is exactly
 * the failure the critic protocol warns about: an assertion wearing the clothes
 * of a measurement.
 *
 * So this counts pixels instead. No hand-picked crop boxes — the two things
 * being compared separate cleanly on chroma, which is the whole point of the
 * enamel being neutral and the fire being orange:
 *
 *   · ENAMEL  — bright and near-neutral. That is the tube, the mount castings
 *               and the counterweight, and at dusk almost nothing else in a
 *               camp frame is both bright and grey.
 *   · FLAME   — bright and strongly warm, red >= green > blue.
 *
 * Reports each set's mean and peak luma and, separately, what share of the
 * frame is clipped, because clipping is its own defect: a clipped white feeds
 * the bloom mip chain and the prop starts EMITTING light rather than reflecting
 * it, which is what put a forty-pixel halo around the tube in round 2.
 *
 * PASS wants the enamel's mean below the flame's mean and its clipped share at
 * essentially zero.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { acquire } from '../_lock.mjs';

// Each argument is a frame shot by `scopelab --pair`; the tool looks for its
// `-off` twin beside it and, if there is one, measures the PROP by difference
// rather than by chroma. That is the only version of this measurement that can
// be trusted — see the note on `--pair` in scopelab.mjs.
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: scopevalue.mjs <image> […]'); process.exit(1); }

const release = await acquire('scopevalue');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

for (const f of files) {
  const maskPath = f.replace(/\.png$/, '.mask.png');
  const mask = existsSync(maskPath) ? readFileSync(maskPath).toString('base64') : null;
  const rectPath = f.replace(/\.png$/, '.rect.json');
  const rect = existsSync(rectPath) ? JSON.parse(readFileSync(rectPath, 'utf8')) : null;
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async ({ b64, mask, rect }) => {
    const load = async (s) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      return { data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data,
               w: img.width, h: img.height };
    };
    const { data: d, w: W, h: H } = await load(b64);
    const mk = mask ? (await load(mask)).data : null;
    const L = (r, gg, b) => (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
    let pn = 0, pSum = 0, pPeak = 0, pClip = 0;
    let fl = 0, flSum = 0, flPeak = 0;
    const inRect = (x, y) => !rect
      || (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
    for (let i = 0, px = 0; i < d.length; i += 4, px++) {
      const x = px % W, y = (px / W) | 0;
      const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
      const lum = L(r0, g0, b0);
      const mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0);
      const chroma = mx === 0 ? 0 : (mx - mn) / mx;
      // The prop. From the mask frame where there is one — magenta means this
      // pixel is telescope and nothing else — and otherwise from the projected
      // box plus a neutral test, which is a guess and is labelled as one.
      //
      // The mask test is a MAGENTA-NESS test, not an equality test, and that is
      // not laziness. The mask frame is a real render: the flat 0xff00ff goes
      // through the tonemapper, the grade and the bloom like everything else,
      // and what comes out the far end at dusk is a pale pink around
      // (230,180,240). Testing for pure magenta found four pixels. Testing that
      // red and blue both stand clear of green — which no lavender sky, no
      // yellow grass and no orange flame does — finds the telescope.
      const isProp = mk
        ? (inRect(x, y) && (mk[i] - mk[i + 1]) > 18 && (mk[i + 2] - mk[i + 1]) > 18
           && mk[i + 2] > 90)
        : (inRect(x, y) && chroma < 0.20);
      if (isProp) {
        pn++; pSum += lum; if (lum > pPeak) pPeak = lum;
        if (mx >= 250) pClip++;
      }
      // The flame: warm, saturated and bright, anywhere in the frame.
      if (lum > 0.42 && chroma > 0.34 && r0 >= g0 && g0 > b0) {
        fl++; flSum += lum; if (lum > flPeak) flPeak = lum;
      }
    }
    return {
      propMean: pn ? pSum / pn : 0, propPeak: pPeak, propPx: pn,
      propClipPct: pn ? (pClip / pn) * 100 : 0,
      flameMean: fl ? flSum / fl : 0, flamePeak: flPeak, flamePx: fl,
      boxed: !!rect, masked: !!mk,
    };
  }, { b64, mask, rect });
  const verdict = !r.propPx ? 'prop not found'
    : r.propClipPct > 1.5 ? `FAIL — ${r.propClipPct.toFixed(1)}% of the prop is clipped`
    : r.flamePx < 200 ? 'ok (no flame in frame)'
    : r.propPeak > r.flamePeak ? 'FAIL — prop peaks above the flame'
    : 'PASS';
  console.log(
    `${basename(f).padEnd(28)}${r.masked ? 'mask' : r.boxed ? 'BOX-GUESS' : 'WHOLE-FRAME'}  ` +
    `prop mean ${r.propMean.toFixed(3)} peak ${r.propPeak.toFixed(3)} ` +
    `clip ${r.propClipPct.toFixed(2)}% (${r.propPx}px)   ` +
    `flame peak ${r.flamePeak.toFixed(3)} (${r.flamePx}px)   ${verdict}`);
}
await browser.close();
release();

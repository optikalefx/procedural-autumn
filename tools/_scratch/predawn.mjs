#!/usr/bin/env node
/**
 * Which light is painting the pre-dawn meadow?
 *
 * `meadow-h5p45` is a large, uniform, salmon-pink field under a blue-violet
 * sky with no motivating light anywhere in the frame. Two rounds have argued
 * about the cause from the frame alone. This turns each contributor off in
 * turn, after Lighting.update has run — so SKY_STATE, and therefore the dome,
 * the aureole and the haze colour, are bit-identical between the variants and
 * the only thing that moves is the light on the world.
 *
 * Reports the lower third of the frame (the meadow) for each variant.
 *
 *   node tools/_scratch/predawn.mjs --url http://127.0.0.1:5203 --seed 20261018
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const seed = arg('seed', null);
const url = arg('url', 'http://127.0.0.1:5203') + (seed ? `?seed=${seed}` : '');
const hours = String(arg('hours', '5.45')).split(',').map(Number);
const viewName = arg('view', 'meadow');
const OUT = arg('out', null);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
if (OUT) mkdirSync(OUT, { recursive: true });

const poseFn = new Function('P', POSE_SRC);
const v = VIEWS[viewName];

// Each variant is a mutation applied to the lights AFTER update() has run, and
// held there by pinning cycleSpeed to 0 and re-applying every frame.
const VARIANTS = ['full', 'no-sun', 'no-hemi', 'no-fill', 'no-moon', 'grey-sun'];

const stats = async () => {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b; await img.decode();
    const W = 400, H = Math.round(img.height / img.width * W);
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, Math.floor(H * 2 / 3), W, H - Math.floor(H * 2 / 3)).data;
    let lum = 0, chr = 0, R = 0, G = 0, B = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, bb = d[i + 2] / 255;
      lum += 0.2126 * r + 0.7152 * gg + 0.0722 * bb;
      const mx = Math.max(r, gg, bb), mn = Math.min(r, gg, bb);
      chr += mx > 0 ? (mx - mn) / mx : 0;
      R += r; G += gg; B += bb; n++;
    }
    return { mean: lum / n, chr: chr / n, r: R / n, g: G / n, b: B / n };
  }, b64);
};

console.log('hour  variant     gndMean  chroma   mean sRGB (R,G,B)');
for (const hour of hours) {
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
  await page.evaluate(poseFn, { v, frozen: null, dynamic: ['vehicle'] });

  for (const mode of VARIANTS) {
    await page.evaluate((m) => {
      const L = window.__lighting;
      if (L.__probeHook) L.__probeHook = null;
      const orig = L.update.bind(L);
      L.update = (dt, f) => {
        orig(dt, f);
        if (m === 'no-sun') L.sun.intensity = 0;
        if (m === 'no-hemi') L.hemi.intensity = 0;
        if (m === 'no-fill') L.fill.intensity = 0;
        if (m === 'no-moon' && L.moon) L.moon.intensity = 0;
        if (m === 'grey-sun') {
          const c = L.sun.color;
          const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
          c.setRGB(l, l, l);
        }
      };
      L.__restore = orig;
    }, mode);
    await page.evaluate(async () => {
      if (window.__settleStable) await window.__settleStable();
      else if (window.__settle) await window.__settle(40);
    });
    await page.waitForTimeout(500);
    const s = await stats();
    if (OUT) await page.screenshot({ path: `${OUT}/${viewName}-h${String(hour).replace('.', 'p')}-${mode}.png` });
    console.log(`${String(hour).padStart(5)}  ${mode.padEnd(10)} ${s.mean.toFixed(4).padStart(7)}  ` +
      `${s.chr.toFixed(4).padStart(6)}   ${(s.r * 255).toFixed(0).padStart(3)},${(s.g * 255).toFixed(0).padStart(4)},${(s.b * 255).toFixed(0).padStart(4)}`);
    await page.evaluate(() => { const L = window.__lighting; if (L.__restore) { L.update = L.__restore; L.__restore = null; } });
  }
}

await browser.close();

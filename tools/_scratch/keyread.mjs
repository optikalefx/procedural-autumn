#!/usr/bin/env node
/**
 * Read the KEY LIGHT off the DirectionalLight, hour by hour, in one boot.
 *
 * This exists because the previous round eliminated "the key's hue" using
 * keyfill.mjs's `keyChroma`/`keyHue` columns, and those columns measure the
 * chroma of the *frame* — albedo, haze and dome — not of the light. The light
 * is a THREE.Color on `__lighting.sun`; nothing has to be inferred from pixels
 * at all. Printed in the working (linear) space as a ratio to the red channel,
 * which is the form the multiply into albedo actually takes, and as the sRGB
 * hex a person can picture.
 *
 *   node tools/_scratch/keyread.mjs --url http://127.0.0.1:5203 --seed 20261018
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const seed = arg('seed', null);
const url = arg('url', 'http://127.0.0.1:5203') + (seed ? `?seed=${seed}` : '');
const hours = String(arg('hours', '5.45,6.25,7,7.4,9.5,12.5,15.5,16.5,17.1,17.5,17.9,18.25,19,19.8,21'))
  .split(',').map(Number);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const rows = await page.evaluate((hs) => {
  const L = window.__lighting;
  L.cycleSpeed = 0;
  const out = [];
  for (const h of hs) {
    L.hour = h;
    L.update(0.016, null);
    const c = L.sun.color;
    const d = c.clone().convertLinearToSRGB();
    const hex = '#' + [d.r, d.g, d.b]
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    out.push({
      h,
      elevDeg: Math.asin(L.sunDir.y) * 180 / Math.PI,
      sunI: L.sun.intensity,
      hemiI: L.hemi.intensity,
      cast: L.sun.castShadow,
      g: c.g / c.r, b: c.b / c.r,
      sat: mx > 0 ? (mx - mn) / mx : 0,
      hex,
    });
  }
  return out;
}, hours);

console.log('hour   elev°   sunI  hemiI cast   key linear 1:G:B      sat    sRGB');
for (const r of rows) {
  console.log(
    `${String(r.h).padStart(5)} ${r.elevDeg.toFixed(2).padStart(7)} ${r.sunI.toFixed(2).padStart(6)} ` +
    `${r.hemiI.toFixed(2).padStart(6)} ${String(r.cast).padStart(5)}   ` +
    `1 : ${r.g.toFixed(3)} : ${r.b.toFixed(3)}   ${r.sat.toFixed(3)}  ${r.hex}`);
}

await browser.close();

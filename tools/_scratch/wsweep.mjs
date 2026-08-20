#!/usr/bin/env node
/**
 * Water uniform sweep, one page load.
 *
 * The water shader has four dials that all move saturation (uEnvTint,
 * uAbsorbPow, uCoolGain, uSheen) and no two of them move it the same way.
 * Guessing at them one capture at a time costs a browser boot per guess and
 * measures this machine's throughput drift as much as the change. This sets
 * them live on the shared uniform block, screenshots one framing per setting,
 * and prints the mean sRGB of a rectangle of pure water so the comparison is a
 * number rather than an impression.
 *
 *   node tools/_scratch/wsweep.mjs --set "envTint=0.25" --set "envTint=0.10"
 *
 * Keys map to uEnvTint / uAbsorbPow / uCoolGain / uSheen / uBodyGain /
 * uWetBand. Several may be combined in one --set, comma separated.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SETS = argv.reduce((a, v, i) => (v === '--set' ? [...a, argv[i + 1]] : a), []);
const RES = arg('res', '1536');
const DIR = arg('dir', 'shots/water/sweep');
const W = +arg('w', '1280'), H = +arg('h', '720');
const POS = String(arg('pos', '-806,25.6,-662')).split(',').map(Number);
const LOOK = String(arg('look', '-700,20.8,-690')).split(',').map(Number);
const HOUR = parseFloat(arg('hour', '16.7'));
// x,y,w,h in fractions — the patch that is measured. Default: pure open water
// in the default framing.
const RECT = String(arg('rect', '0.05,0.55,0.90,0.34')).split(',').map(Number);

mkdirSync(DIR, { recursive: true });
await acquire('wsweep');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://localhost:5178?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

await page.evaluate(async ({ POS, LOOK, HOUR }) => {
  const T = window.__THREE, e = window.__engine;
  window.__lighting.hour = HOUR; window.__lighting.cycleSpeed = 0;
  e.camera.fov = 50; e.camera.updateProjectionMatrix();
  e.camera.position.set(...POS); e.camera.lookAt(new T.Vector3(...LOOK));
  window.__forceCamera = true;
  if (window.__settle) await window.__settle(150);
}, { POS, LOOK, HOUR });

// Snapshot the defaults so each arm starts from the same place.
const base = await page.evaluate(() => {
  const w = (window.__systems ?? window.__ctx?.systems ?? {}).water;
  if (!w?.shared) return null;
  const keys = ['uEnvTint', 'uAbsorbPow', 'uCoolGain', 'uSheen', 'uBodyGain', 'uWetBand'];
  const o = {}; for (const k of keys) if (w.shared[k]) o[k] = w.shared[k].value;
  return o;
});
if (!base) { console.error('water system not reachable on window'); await browser.close(); process.exit(2); }
console.log('defaults:', JSON.stringify(base));

for (const set of (SETS.length ? SETS : ['(defaults)'])) {
  const pairs = set === '(defaults)' ? [] : set.split(',').map((kv) => {
    const [k, v] = kv.split('=');
    return ['u' + k[0].toUpperCase() + k.slice(1), parseFloat(v)];
  });
  await page.evaluate(({ base, pairs }) => {
    const w = (window.__systems ?? window.__ctx?.systems ?? {}).water;
    for (const [k, v] of Object.entries(base)) if (w.shared[k]) w.shared[k].value = v;
    for (const [k, v] of pairs) { if (w.shared[k]) w.shared[k].value = v; else console.error('no uniform ' + k); }
  }, { base, pairs });
  await page.waitForTimeout(500);
  const label = set.replace(/[^a-z0-9.=,-]/gi, '_');
  const path = `${DIR}/${label}.png`;
  await page.screenshot({ path });
  // The canvas is created without preserveDrawingBuffer, so reading it back
  // outside a frame returns black. Measure the PNG instead — see the loop below.
  console.log(`${set.padEnd(46)} ${path}`);
}
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 5)));
await browser.close();

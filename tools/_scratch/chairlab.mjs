#!/usr/bin/env node
/**
 * chairlab — turntable a camp chair in a style the layout did not happen to roll.
 *
 *   node tools/_scratch/chairlab.mjs --dir shots/camp/chair/r2 --style sling
 *   node tools/_scratch/chairlab.mjs --dir shots/camp/chair/r2 --style sling --colorway 1
 *
 * `campshot --turntable chair` shoots whichever chair the layout put nearest the
 * fire, and `camp_site.js` picks each chair's style from its own RNG. On the
 * meadow site every author gets — the only POI whose terrain `pitchNear` will
 * accept — that roll came up 'arm' three times out of three, so half of
 * `camp_chair.js` was unphotographable. `--seed` does not help: `Camp.js` keys
 * its RNG off the site's world position (`siteRng`) and ignores the
 * `window.__camp.__seed` that campshot sets.
 *
 * So: pitch the camp exactly as campshot does, then rebuild the chair props
 * through `buildChair` with the style and colourway forced, keeping each one's
 * position, orientation and wear. Nothing else in the scene is touched, the
 * framings are campshot's own, and the frames drop into the round directory
 * beside it under a `sling-`/`arm-` prefix so `ab.mjs` pairs them across rounds.
 *
 * Scratch, and only useful while the chair round is open — see
 * docs/CAMP_REQUESTS.md for the request to give campshot a real `--style`.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const DIR = arg('dir', 'shots/camp/chair/lab');
const STYLE = arg('style', 'sling');
const COLORWAY = arg('colorway', null);
const PREFIX = arg('prefix', STYLE);
const RES = arg('res', '768');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);

// campshot's PROP.chair framing, verbatim, so a lab frame and a campshot frame
// of the same chair are the same picture.
const P = { az: 0.75, dist: 1.85, elev: 0.85, fov: 36, aim: 0.42 };
const AZ = [
  ['front', 0.00, P.elev], ['fq', 0.75, P.elev], ['side', 1.57, P.elev],
  ['bq', 2.35, P.elev], ['back', 3.14, P.elev], ['high', 0.90, P.elev + P.dist * 0.9],
];

const release = await acquire('chairlab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
               set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);

const site = await page.evaluate(async ({ style, colorway }) => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!s) return null;
  const mod = await import('/src/camp/camp_chair.js');
  const { mulberry32 } = await import('/src/core/MathUtils.js');
  let k = 0;
  for (const p of window.__camp.props) {
    if (p.item.kind !== 'chair') continue;
    const opts = { ...(p.item.opts ?? {}), style };
    if (colorway !== null) opts.colorway = parseInt(colorway, 10);
    const g = mod.buildChair(mulberry32(0x9e3779b9 ^ (k++ * 2654435761)), opts);
    g.position.copy(p.obj.position);
    g.quaternion.copy(p.obj.quaternion);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    p.obj.parent.add(g);
    p.obj.parent.remove(p.obj);
    p.obj = g;
  }
  const chairs = window.__camp.props.filter((q) => q.item.kind === 'chair');
  return { ...s, chairs: chairs.length };
}, { style: STYLE, colorway: COLORWAY });

if (!site) { console.error('chairlab: no valid site'); await browser.close(); release(); process.exit(2); }
console.log(`chairlab: ${site.chairs} chair(s) rebuilt as ${STYLE}`);
mkdirSync(resolve(DIR), { recursive: true });

const jobs = AZ.map(([name, az, elev]) => ({ name: `${PREFIX}-${name}`, f: { ...P, az, elev }, hour: null }));
jobs.push({ name: `${PREFIX}-dusk`, f: { ...P, az: 0.75 }, hour: 20.4 });

for (const job of jobs) {
  await page.evaluate(async ({ f, hour }) => {
    const THREE = window.__THREE, e = window.__engine;
    if (hour !== null) { window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0; }
    const p = window.__camp.props.find((q) => q.item.kind === 'chair').item;
    const a = p.yaw + f.az;
    e.camera.fov = f.fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(p.x + Math.sin(a) * f.dist, p.y + f.elev, p.z + Math.cos(a) * f.dist);
    e.camera.lookAt(new THREE.Vector3(p.x, p.y + f.aim, p.z));
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
  }, { f: job.f, hour: job.hour });
  await page.waitForTimeout(600);
  const out = resolve(DIR, `${job.name}.png`);
  await page.screenshot({ path: out });
  console.log(`shot: ${out}`);
}

if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();
release();

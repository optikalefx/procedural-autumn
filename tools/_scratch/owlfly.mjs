#!/usr/bin/env node
/**
 * The owl in the air: force a perch, launch it, then chase it with the camera
 * and take a frame every few sim frames. The question this answers is whether
 * the wing BENDS across the span through the beat, or hinges like a scarecrow.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owlfly.mjs <outdir> [hour] [key]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2] || 'shots/owlfly';
const HOUR = parseFloat(process.argv[3] ?? '22');
const KEY = process.argv[4] ?? 'owl';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';
mkdirSync(dir, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate((h) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false;
  window.__lighting.hour = h; window.__lighting.cycleSpeed = 0;
}, HOUR);

const start = await page.evaluate(async (key) => {
  await window.__settle(60);
  const tb = window.__systems.wildlife.treeBirds;
  const cam = window.__engine.camera.position;
  let p = null;
  for (const [dx, dz] of [[40, 0], [0, 40], [-40, 0], [0, -40], [70, 70]]) {
    p = tb.debugPerchNear(cam.x + dx, cam.z + dz, key);
    if (p) break;
  }
  if (!p) return null;
  return tb.debugFly(p.x, p.z) ? p : null;
}, KEY);
if (!start) { console.error('no owl to launch'); await browser.close(); process.exit(1); }
console.log('launched from', JSON.stringify(start));

for (let i = 0; i < 10; i++) {
  const p = await page.evaluate(async ({ key, step }) => {
    const THREE = window.__THREE, e = window.__engine;
    const tb = window.__systems.wildlife.treeBirds;
    window.__forceCamera = true;
    await window.__settle(step);
    const b = tb.debugList().find((x) => x.key === key && x.state === 1);
    if (!b) return null;
    // Stand off to the side and slightly above, so the frame shows the whole
    // wing rather than a foreshortened plank. Posed and then settled two more
    // frames INSIDE this call: posing and returning let the game's own camera
    // reclaim the shot before the screenshot landed, which is how a strip of
    // ten frames came back with the bird in the corner of two of them.
    e.camera.fov = 34;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(b.x + 10, b.y + 2.5, b.z + 7);
    e.camera.lookAt(new THREE.Vector3(b.x, b.y, b.z));
    await window.__settle(2);
    e.camera.position.set(b.x + 10, b.y + 2.5, b.z + 7);
    e.camera.lookAt(new THREE.Vector3(b.x, b.y, b.z));
    return { x: b.x, y: b.y, z: b.z, t: b.t };
  }, { key: KEY, step: i === 0 ? 8 : 10 });
  if (!p) { console.log(`frame ${i}: landed`); break; }
  await page.waitForTimeout(90);
  await page.screenshot({ path: resolve(dir, `fly-${String(i).padStart(2, '0')}.png`) });
  console.log(`fly-${i}  t=${p.t.toFixed(2)}  y=${p.y.toFixed(1)}`);
}
if (errs.length) console.log('page-errors:', JSON.stringify([...new Set(errs)].slice(0, 5)));
await browser.close();

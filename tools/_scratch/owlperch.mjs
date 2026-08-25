#!/usr/bin/env node
/**
 * One owl on one tree, orbited at its own height — the "is it swallowed by the
 * crown" test. The eagle's perch height (silhouette top minus 1.35 m) was
 * chosen for a 4.1 m bird; this asks whether a 2.8 m one still clears it.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owlperch.mjs <outdir> [hour] [key]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2] || 'shots/owlperch';
const HOUR = parseFloat(process.argv[3] ?? '22');
const KEY = process.argv[4] ?? 'owl';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';
mkdirSync(dir, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
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

const info = await page.evaluate(async (key) => {
  await window.__settle(60);
  const tb = window.__systems.wildlife.treeBirds;
  const cam = window.__engine.camera.position;
  let p = null;
  for (const [dx, dz] of [[40, 0], [0, 40], [-40, 0], [0, -40], [70, 70], [-70, 70]]) {
    p = tb.debugPerchNear(cam.x + dx, cam.z + dz, key);
    if (p) break;
  }
  if (!p) return null;
  // What tree is it on, and how far below that tree's silhouette top?
  const T = window.__systems.trees.trees;
  const b = tb.slots.flat().find((s) => s.active && s.spec.key === key
    && Math.hypot(s.x - p.x, s.z - p.z) < 0.5);
  const t = b?.tree ?? -1;
  return {
    ...p, sc: b?.sc,
    treeTop: t >= 0 ? T.py[t] + T.pImpH[t] : null,
    treeH: t >= 0 ? T.pImpH[t] : null,
    below: t >= 0 ? (T.py[t] + T.pImpH[t]) - p.y : null,
  };
}, KEY);
if (!info) { console.error('no perch found'); await browser.close(); process.exit(1); }
console.log(JSON.stringify(info));

for (const [name, az, dist, dy, fov] of [
  ['orbit-a', 0.0, 18, 1.0, 26],
  ['orbit-b', 1.6, 18, 1.0, 26],
  ['orbit-c', 3.1, 18, 1.0, 26],
  ['orbit-d', 4.7, 18, 1.0, 26],
  ['low-25', 0.8, 25, -8, 30],
  ['far-60', 0.8, 60, 0, 34],
]) {
  await page.evaluate(async (v) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__forceCamera = true;
    e.camera.fov = v.fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(v.x, v.y, v.z);
    e.camera.lookAt(new THREE.Vector3(v.ax, v.ay, v.az));
    await window.__settle?.(16);
  }, {
    x: info.x + Math.sin(az) * dist, y: info.y + dy, z: info.z + Math.cos(az) * dist,
    ax: info.x, ay: info.y, az: info.z, fov,
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
  console.log('shot:', name);
}
if (errs.length) console.log('page-errors:', JSON.stringify([...new Set(errs)].slice(0, 5)));
await browser.close();

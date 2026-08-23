#!/usr/bin/env node
/**
 * Many posed frames from ONE page load.
 *
 *   node tools/_scratch/perchshot.mjs poses.json outdir
 *
 * poses.json: [{name, pos:[x,y,z], look:[x,y,z], fov, hour, hide:[...]}]
 * Diagnostic scratch for the perched-river round; shot.mjs takes one --pos per
 * boot and this round needs twenty framings of the same world.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const poses = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const dir = process.argv[3] || 'shots/perch';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5211/?seed=20261018';
mkdirSync(dir, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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
page.on('pageerror', (e) => console.error('ERR', String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
});

for (const p of poses) {
  await page.evaluate(async (v) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = v.hour ?? 16.7;
    window.__lighting.cycleSpeed = 0;
    for (const n of ['Trees', 'Grass', 'GroundCover', 'Rocks', 'Wildlife', 'Camp', 'Water', 'Weather', 'Clouds', 'Waterfalls']) {
      const o = e.scene.getObjectByName(n);
      if (o) o.visible = !(v.hide || []).includes(n);
    }
    e.camera.fov = v.fov ?? 50;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    e.camera.lookAt(new THREE.Vector3(v.look[0], v.look[1], v.look[2]));
    window.__forceCamera = true;
    await window.__settle?.(60);
  }, p);
  await page.waitForTimeout(900);
  const out = resolve(dir, `${p.name}.png`);
  await page.screenshot({ path: out });
  console.log('shot:', out);
}
await browser.close();

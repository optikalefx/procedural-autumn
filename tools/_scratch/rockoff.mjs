#!/usr/bin/env node
/**
 * Interleaved within-one-page-load A/B: is a given blob in the frame drawn by
 * the Rocks system at all?
 *
 * Two captures of this tree 34 minutes apart differed in half their pixels, so
 * "capture, edit, capture" cannot answer a question this small. This toggles
 * `rocks.group.visible` inside one page load, alternating which arm goes first,
 * and writes both frames plus a difference mask. Anything that survives with
 * rocks hidden is not a rock.
 *
 *   node tools/_scratch/rockoff.mjs meadow  <outdir>
 *   node tools/_scratch/rockoff.mjs peaks   <outdir>
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const view = process.argv[2] || 'meadow';
const OUT = process.argv[3] || 'shots/rockoff';
const VIEWS = {
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  peaks:  { anchor: 'peak',   height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  dawn:   { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
};
const v = VIEWS[view];
const anchors = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));
const a = anchors[v.anchor];
mkdirSync(OUT, { recursive: true });

await acquire('rockoff');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
        set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto('http://localhost:5178');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

await p.evaluate(async ({ a, v }) => {
  const THREE = window.__THREE;
  const cam = window.__engine.camera;
  const w = window.__world;
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const yaw = a.yaw ?? 0;
  const gy = w.getHeight(a.x, a.z) + v.height;
  const pos = new THREE.Vector3(a.x, gy, a.z);
  const look = new THREE.Vector3(a.x + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
  cam.fov = v.fov;
  cam.updateProjectionMatrix();
  cam.position.copy(pos);
  cam.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  await window.__settleStable(1500, 30);
}, { a, v });

// Alternate the order so neither arm is systematically the settled one.
const order = ['on', 'off', 'off', 'on'];
const shots = {};
for (const arm of order) {
  await p.evaluate(async (on) => {
    window.__systems.rocks.group.visible = on === 'on';
    await window.__settle(12);
  }, arm);
  shots[arm] = await p.screenshot();      // last write wins; both arms captured twice
  writeFileSync(`${OUT}/${view}-${arm}.png`, shots[arm]);
}
console.log(`wrote ${OUT}/${view}-on.png and ${OUT}/${view}-off.png`);
await b.close();

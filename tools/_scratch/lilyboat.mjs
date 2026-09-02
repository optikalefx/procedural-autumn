#!/usr/bin/env node
/**
 * Paddle a kayak through a lily colony, headless, and measure the push.
 *
 *   node tools/_scratch/lilyboat.mjs [--url http://127.0.0.1:5253] [--dir shots/lily]
 *
 * Boots the game, stops the engine and steps it by hand at 1/30 s (the pane
 * and headless Chromium both freeze rAF; see the capture-traps memory), spawns
 * a kayak at the edge of the busiest colony on seed 20261018, boards it, paddles
 * straight through, and writes three frames: mid-colony, just past, and after
 * the leaves have settled. Prints the disturbed count, the largest offset, and
 * the CPU cost of LilyPads.lateUpdate per frame.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5253');
const DIR = arg('dir', 'shots/lily');
mkdirSync(DIR, { recursive: true });

await acquire('lilyboat');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  try { localStorage.setItem('pa.hud', JSON.stringify({ introSeen: true, seenHint: true })); } catch {}
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${URL}/?seed=20261018&car=camper&quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

// Stage: engine stopped, fixed step, camera ours.
await page.evaluate(() => {
  const e = window.__engine;
  e.stop();
  e.clock.getDelta = () => 1 / 30;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const j = window.__systems.hud?.journal; if (j?.active) j.close?.();
});

// Colony A on seed 20261018 (tools/_scratch/lilypose.mjs): centroid (367.9, -23.8),
// bank to the north at (370.2, -5.9). Spawn 3 m inside the water, bow south.
const START = { x: 369.5, z: -9.5, heading: Math.atan2(367.9 - 369.5, -23.8 + 9.5), kind: arg('kind', 'canoe') };

const step = async (frames) => page.evaluate((n) => {
  const e = window.__engine, L = window.__systems.lilyPads;
  let us = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    // Time only the pad system's late pass: engine loop, then subtract nothing
    // — instead call lateUpdate once more with dt 0 to price it in isolation.
    e._loop();
    const t1 = performance.now();
    L.lateUpdate(0);
    us += (performance.now() - t1) * 1000;
  }
  return us / n;
}, frames);

const snapshot = () => page.evaluate(() => {
  const L = window.__systems.lilyPads, b = window.__systems.boat.state().boats[0];
  let maxO = 0, n = 0, inHull = 0;
  const dim = window.__systems.boat.models[b.kind].dim;
  const fx = Math.sin(b.heading), fz = Math.cos(b.heading), half = dim.length / 2 - dim.beam / 2;
  for (const p of L._disturbed) { n++; maxO = Math.max(maxO, Math.hypot(p.ox, p.oz)); }
  // Any leaf whose centre lies inside the hull's waterline outline is a clip.
  for (const p of L.padsNear(b.x, b.z, 4)) {
    const qx = p.x + (p.ox || 0) - b.x, qz = p.z + (p.oz || 0) - b.z;
    const t = Math.max(-half, Math.min(half, qx * fx + qz * fz));
    const d = Math.hypot(qx - fx * t, qz - fz * t);
    if (d < dim.beam / 2) inHull++;
  }
  return { disturbed: n, maxOffset: +maxO.toFixed(3), leavesUnderHull: inHull, boat: b && { x: +b.x.toFixed(1), z: +b.z.toFixed(1), speed: +b.speed.toFixed(2) }, stats: L.stats };
});

// Pose our own camera and render ONE frame with it. Not through _loop: the
// boarded boat mounts the camera in its lateUpdate every frame, so a pose set
// before the loop is overwritten inside it (the first run of this harness
// produced three identical behind-the-paddler frames that way).
const frame = (path) => page.evaluate((path) => {
  const e = window.__engine, T = window.__THREE, b = window.__systems.boat.state().boats[0];
  const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
  // Off the port quarter, above: the hull's side and the lane it leaves.
  e.camera.position.set(b.x - fx * 3.5 + fz * 5.0, b.y + 2.6, b.z - fz * 3.5 - fx * 5.0);
  e.camera.lookAt(new T.Vector3(b.x + fx * 1.0, b.y, b.z + fz * 1.0));
  e.camera.fov = 50; e.camera.updateProjectionMatrix();
  if (path.includes('top')) {
    // Straight down over the boat, like the player's zoomed-out paddling view.
    e.camera.position.set(b.x + fx * 1.0, b.y + 9, b.z + fz * 1.0);
    e.camera.up.set(fx, 0, fz);
    e.camera.lookAt(new T.Vector3(b.x + fx * 1.0, b.y, b.z + fz * 1.0));
    e.camera.fov = 45; e.camera.updateProjectionMatrix();
  }
  e.camera.updateMatrixWorld(true);
  if (e._render) e._render(1 / 30, e.elapsed); else e.renderer.render(e.scene, e.camera);
}, path).then(() => page.screenshot({ path }));

await page.evaluate((S) => {
  const boat = window.__systems.boat, W = window.__world;
  const y = W._water.levelAt(S.x, S.z) ?? W.getWaterHeight(S.x, S.z);
  boat.spawn(S.x, S.z, { kind: S.kind, heading: S.heading, y });
  boat.board();
  boat.drive(1, 0);
  const L = window.__systems.lilyPads; L._catchup = 40;
}, START);

// Warm up: let streaming catch up and the boat get under way.
let cost = await step(40);
console.log('after 40 frames', JSON.stringify(await snapshot()), `lateUpdate ${cost.toFixed(0)} us`);
const frames = [];
for (let k = 0; k < 8; k++) {
  cost = await step(30);
  const s = await snapshot();
  console.log(`+${(k + 1) * 30}f`, JSON.stringify(s), `lateUpdate ${cost.toFixed(0)} us`);
  frames.push(s);
  if (k === 2 || k === 5) {
    await frame(`${DIR}/boat-push-${k === 2 ? 'mid' : 'past'}.png`);
    if (k === 5) await frame(`${DIR}/boat-push-top.png`);
  }
}
// Stop paddling and let the leaves settle.
await page.evaluate(() => window.__systems.boat.drive(0));
cost = await step(120);
console.log('settled 4 s', JSON.stringify(await snapshot()), `lateUpdate ${cost.toFixed(0)} us`);
await frame(`${DIR}/boat-push-settled.png`);
if (errs.length) console.log('page errors:', errs.slice(0, 5));
await browser.close();

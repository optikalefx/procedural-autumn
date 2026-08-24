#!/usr/bin/env node
/**
 * sightrange — does an animal sighting mean an animal that was actually close?
 *
 *   node tools/_scratch/sightrange.mjs
 *
 * `src/game/Stats.js` credits a sighting only inside SIGHT metres of where the
 * player is (20 m, per the user). This puts a deer at a series of distances and
 * checks that the counter moves for the near ones and not for the far ones —
 * and that nothing is announced while it does, because the logbook records
 * rather than interrupts.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('sightrange');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {},
        set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
  try { localStorage.removeItem('pa.stats'); } catch { /* private mode */ }
});
await p.goto(`${process.env.AUTUMN_URL || 'http://localhost:5178'}/?seed=20261018&res=512&car=camper&quality=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

console.log(await p.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wl = window.__systems.wildlife;
  const veh = window.__systems.vehicle;

  // Watch the toast element rather than trusting a reading of the source: this
  // is a check that nothing is announced, and the DOM is where announcing
  // happens.
  const toasts = [];
  const toastEl = window.__hud.toastEl;
  new MutationObserver(() => {
    const t = toastEl.textContent.trim();
    if (t) toasts.push(t);
  }).observe(toastEl, { childList: true, characterData: true, subtree: true });

  // Park, and aim the camera down the camper's nose so the deer is in frame.
  veh.rescue();
  for (let i = 0; i < 120; i++) await frame();
  const me = veh.position.clone();

  const out = [];
  for (const dist of [10, 18, 35, 90]) {
    wl.debugClear();
    for (let i = 0; i < 6; i++) await frame();
    const before = window.__stats.get('seen.deer');

    // Place the deer at a known range from the CAMPER, then point the camera
    // at it — the range gate measures from the player, the frustum test from
    // the camera, and this has to satisfy both to isolate the range gate.
    const a = veh.heading;
    const x = me.x + Math.sin(a) * dist, z = me.z + Math.cos(a) * dist;
    const spawned = wl.debugSpawn('deer', { x, z, count: 1, clear: 4 });
    if (!spawned) { out.push({ dist, error: 'no free deer site nearby' }); continue; }

    window.__forceCamera = true;
    const cam = window.__engine.camera;
    cam.position.set(me.x, me.y + 2.2, me.z);
    cam.lookAt(spawned.x, spawned.y + 0.8, spawned.z);
    cam.updateMatrixWorld(true);
    for (let i = 0; i < 30; i++) await frame();
    window.__forceCamera = false;

    const real = Math.hypot(spawned.x - me.x, spawned.z - me.z);
    out.push({ asked: dist, actual: +real.toFixed(1),
               credited: window.__stats.get('seen.deer') > before });
  }
  return { sightings: out, toasts };
}));
await b.close();

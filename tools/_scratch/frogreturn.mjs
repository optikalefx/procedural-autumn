#!/usr/bin/env node
/**
 * Three ways a scared colony can come back, measured in one page load.
 *
 *   node tools/_scratch/frogreturn.mjs [--url http://127.0.0.1:5253]
 *
 * `_scan` refuses a pad that is inside the frustum AND closer than FAR_OK
 * (26 m). That is one rule, and it comes apart into three different player
 * actions — only one of which is actually "go away and come back":
 *
 *   TURN    stay put, look somewhere else for a while, look back.
 *   BACK    stay looking at the pond, but withdraw past 26 m.
 *   LEAVE   go past DESPAWN_R (58 m) so everything is deleted, then return.
 *
 * Each is run from the same scared-empty state and reports how many frogs are
 * alive and how many are in the view cone when the player looks again.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5253');

await acquire('frogreturn');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
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

const out = await page.evaluate(async () => {
  const e = window.__engine, W = window.__world, T = window.__THREE;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const j = window.__systems.hud?.journal; if (j?.active) j.close?.();

  const C = { x: 367.9, z: -23.8 };
  const wy = W.getWaterHeight(C.x, C.z);
  const L = window.__systems.lilyPads;
  const F = window.__systems.wildlife.frogs;
  const fr = new T.Frustum(), pm = new T.Matrix4(), v = new T.Vector3();

  const look = (dist, bearing, awayFromPond = false) => {
    const px = C.x + Math.sin(bearing) * dist, pz = C.z + Math.cos(bearing) * dist;
    e.camera.position.set(px, wy + 1.1, pz);
    if (awayFromPond) e.camera.lookAt(px + Math.sin(bearing) * 20, wy, pz + Math.cos(bearing) * 20);
    else e.camera.lookAt(C.x, wy, C.z);
    e.camera.fov = 55; e.camera.updateProjectionMatrix();
    e.camera.updateMatrixWorld(true);
  };
  const census = () => {
    e.camera.updateMatrixWorld(true);
    pm.multiplyMatrices(e.camera.projectionMatrix, e.camera.matrixWorldInverse);
    fr.setFromProjectionMatrix(pm);
    let live = 0, visible = 0, onPond = 0;
    for (const f of F.frogs) {
      live++;
      if (fr.containsPoint(v.set(f.x, f.y, f.z))) visible++;
      if (Math.hypot(f.x - C.x, f.z - C.z) < 6) onPond++;
    }
    return { live, visible, onPond };
  };
  const run = (secs) => { const n = Math.round(secs * 30); for (let i = 0; i < n; i++) { e._loop(); F.events.length = 0; } };

  // Park at the pond and fill it.
  look(6, 0.7);
  L._lastRefresh.set(1e9, 1e9, 1e9); L._catchup = 40;
  run(1.5);
  for (let k = 0; k < 6; k++) F.debugSpawn(C.x + (k % 3 - 1) * 0.8, C.z + (k < 3 ? 0.6 : -0.6));
  run(1);
  const filled = census();

  // Scare the pond empty, and confirm it is empty in view.
  const scare = () => {
    for (const f of [...F.frogs]) F._beginDive(f, L, true);
    run(2.5);
  };
  scare();
  const scared = census();

  const results = { filled, scared };

  // ── TURN: stay put, look away 20 s, look back ─────────────────────────────
  look(6, 0.7, true);            // same spot, facing away from the pond
  run(20);
  look(6, 0.7);                  // look back
  results.turnAway20s = census();

  // Reset to scared-empty for the next route.
  scare();

  // ── BACK: withdraw to 35 m, keep watching, 20 s, then walk back in ────────
  look(35, 0.7);
  run(20);
  const atDistance = census();
  look(6, 0.7);
  results.backOff35m = { whileBackedOff: atDistance, onReturn: census() };

  scare();

  // ── LEAVE: go 90 m away (past DESPAWN_R), 20 s, then come back ────────────
  look(90, 0.7);
  run(20);
  const away = census();
  look(6, 0.7);
  const arriveImmediately = census();
  run(10);                        // and give the scan a few passes at close range
  results.leave90m = { whileAway: away, theMomentYouArrive: arriveImmediately, tenSecondsLater: census() };

  // ── APPROACH: the realistic return — paddle in from 60 m, not teleport ────
  //
  // The LEAVE case above jumps 90 m -> 6 m in one frame, which skips the whole
  // stretch where the pond is in view but beyond 26 m and therefore eligible.
  // A player in a boat covers that stretch at 2-3 m/s, so this walks the camera
  // in over 20 s and censuses on arrival.
  scare();
  look(90, 0.7);
  run(6);
  for (let step = 0; step < 20; step++) {
    look(60 - step * 2.7, 0.7);        // 60 m -> ~6 m
    run(1);
  }
  look(6, 0.7);
  results.paddleBackIn = census();

  return results;
});

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('page errors:', errs.slice(0, 4));
await browser.close();

#!/usr/bin/env node
/**
 * The in-view spawn guard, through a lens.
 *
 *   node tools/_scratch/frogzoom.mjs [--url http://127.0.0.1:5253]
 *
 * `frogs.js` refuses a pad inside the frustum and closer than FAR_OK, and that
 * threshold is scaled by the camera's magnification (see the note on FAR_OK).
 * This aims at a colony from 30 m — inside SPAWN_R, outside the unmagnified
 * 26 m guard — and counts how many frogs APPEAR inside the view cone over
 * half a minute, at each lens.
 *
 * The 24 mm row is the control: it must still behave like the walking-around
 * camera. The 200 and 400 rows are the bug this exists to catch — at those
 * focal lengths a frog arriving at 30 m is 34 and 67 px tall, so any count
 * above zero is a frog materialising in somebody's viewfinder.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5253');

await acquire('frogzoom');
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
  const lens = await import('/src/photo/lens_models.js');
  const hide = await import('/src/wildlife/mammals/hide.js');
  e.stop(); e.clock.getDelta = () => 1 / 30;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const j = window.__systems.hud?.journal; if (j?.active) j.close?.();

  const C = { x: 367.9, z: -23.8 };
  const wy = W.getWaterHeight(C.x, C.z);
  const L = window.__systems.lilyPads;
  const F = window.__systems.wildlife.frogs;
  const fr = new T.Frustum(), pm = new T.Matrix4(), v = new T.Vector3();
  const DIST = 30;                                   // inside SPAWN_R, outside 26 m

  const aim = (fov) => {
    const a = 0.7;
    e.camera.position.set(C.x + Math.sin(a) * DIST, wy + 1.4, C.z + Math.cos(a) * DIST);
    e.camera.lookAt(C.x, wy, C.z);
    e.camera.fov = fov; e.camera.updateProjectionMatrix(); e.camera.updateMatrixWorld(true);
  };
  const inCone = () => {
    e.camera.updateMatrixWorld(true);
    pm.multiplyMatrices(e.camera.projectionMatrix, e.camera.matrixWorldInverse);
    fr.setFromProjectionMatrix(pm);
    let n = 0;
    for (const f of F.frogs) if (fr.containsPoint(v.set(f.x, f.y, f.z))) n++;
    return n;
  };

  aim(55);
  L._lastRefresh.set(1e9, 1e9, 1e9); L._catchup = 40;
  for (let i = 0; i < 40; i++) e._loop();

  const rows = [];
  for (const mm of [24, 70, 200, 400]) {
    // Clear the board, then watch through this lens only.
    while (F.frogs.length) F._remove(F.frogs.length - 1);
    const fov = lens.cameraFovForFocal(mm, 16 / 9);
    aim(fov);
    let peakInCone = 0, live = 0;
    for (let i = 0; i < 30 * 30; i++) {          // 30 s
      e._loop(); F.events.length = 0;
      if (i % 15 === 0) { peakInCone = Math.max(peakInCone, inCone()); }
    }
    live = F.frogs.length;
    rows.push({
      lens: `${mm}mm`, vfov: +fov.toFixed(1),
      guardMetres: +(26 * Math.max(1, hide.SIL_FOV_REF / fov)).toFixed(0),
      liveAfter30s: live, everInCone: peakInCone,
    });
  }
  return { standOff: DIST, silFovRef: hide.SIL_FOV_REF, rows };
});

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('page errors:', errs.slice(0, 4));
await browser.close();

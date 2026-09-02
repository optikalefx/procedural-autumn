#!/usr/bin/env node
/**
 * Does a colony you are LOOKING AT refill after you scare it?
 *
 *   node tools/_scratch/frogrespawn.mjs [--url http://127.0.0.1:5253] [--seconds 90] [--dist 6]
 *
 * `frogs.js` deletes a frog 0.6 s after it enters the water and refills the
 * population from `_scan`, which refuses any pad that is INSIDE the frustum and
 * closer than FAR_OK (26 m) — the rule that stops an animal appearing in front
 * of the player. This parks the camera at a colony, dives every frog (what a
 * paddling player causes), and then measures, per scan, how many frogs come
 * back and WHERE: in front of the camera or behind it, near or far.
 *
 * The number that matters is `visibleLive` — frogs alive inside the view cone.
 * If that stays at zero while the player watches, the pond they came to look at
 * is dead for as long as they keep looking at it.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5253');
const SECONDS = parseFloat(arg('seconds', '90'));
const DIST = parseFloat(arg('dist', '6'));

await acquire('frogrespawn');
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

const out = await page.evaluate(async ({ seconds, dist }) => {
  const e = window.__engine, W = window.__world, T = window.__THREE;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const j = window.__systems.hud?.journal; if (j?.active) j.close?.();

  const C = { x: 367.9, z: -23.8 };                 // colony A on seed 20261018
  const wy = W.getWaterHeight(C.x, C.z);
  // Stand off the colony and look straight at it, the way a player in a boat does.
  const a = 0.7;
  e.camera.position.set(C.x + Math.sin(a) * dist, wy + 1.1, C.z + Math.cos(a) * dist);
  e.camera.lookAt(C.x, wy, C.z);
  e.camera.fov = 55; e.camera.updateProjectionMatrix();

  const L = window.__systems.lilyPads;
  L._lastRefresh.set(1e9, 1e9, 1e9); L._catchup = 40;
  for (let i = 0; i < 40; i++) e._loop();

  const F = window.__systems.wildlife.frogs;
  const fr = new T.Frustum(), pm = new T.Matrix4(), v = new T.Vector3();
  const inView = (x, y, z) => {
    e.camera.updateMatrixWorld(true);
    pm.multiplyMatrices(e.camera.projectionMatrix, e.camera.matrixWorldInverse);
    fr.setFromProjectionMatrix(pm);
    return fr.containsPoint(v.set(x, y, z));
  };
  const census = () => {
    let live = 0, visible = 0;
    for (const f of F.frogs) { live++; if (inView(f.x, f.y, f.z)) visible++; }
    return { live, visible };
  };

  // Fill the colony by hand, then let it settle so everything is SITting.
  for (let k = 0; k < 6; k++) F.debugSpawn(C.x + (k % 3 - 1) * 0.8, C.z + (k < 3 ? 0.6 : -0.6));
  for (let i = 0; i < 30; i++) e._loop();
  const before = census();

  // Scare the pond: every frog dives, which is what paddling into it does.
  for (const f of [...F.frogs]) F._beginDive(f, L, true);
  const divers = F.frogs.length;

  // Watch. Sample every half second.
  const samples = [];
  const frames = Math.round(seconds * 30);
  let minLiveAfter = 99, maxVisibleAfter = 0, firstVisibleAt = null;
  for (let i = 0; i < frames; i++) {
    e._loop();
    F.events.length = 0;                       // no audio layer here to drain it
    if (i % 15 === 0) {
      const c = census();
      const t = +(i / 30).toFixed(1);
      samples.push({ t, live: c.live, visible: c.visible });
      if (t > 3) {
        minLiveAfter = Math.min(minLiveAfter, c.live);
        maxVisibleAfter = Math.max(maxVisibleAfter, c.visible);
        if (c.visible > 0 && firstVisibleAt === null) firstVisibleAt = t;
      }
    }
  }
  const end = census();
  // Where did the survivors end up, relative to the camera?
  const where = F.frogs.map((f) => ({
    d: +Math.hypot(f.x - e.camera.position.x, f.z - e.camera.position.z).toFixed(1),
    inView: inView(f.x, f.y, f.z),
  }));
  return {
    standOff: dist, before, divers,
    samples: samples.filter((s, i) => i % 4 === 0 || s.t < 6),
    end, minLiveAfter, maxVisibleAfter, firstVisibleAt, where,
    stats: F.stats,
    padsDrawn: L.stats.drawn,
  };
}, { seconds: SECONDS, dist: DIST });

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('page errors:', errs.slice(0, 4));
await browser.close();

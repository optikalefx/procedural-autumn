#!/usr/bin/env node
/**
 * Frogs in the world, headless: put frogs on colony A's pads, step the game by
 * hand, log every state change, and film one jump as a filmstrip from a camera
 * beside the pad.
 *
 *   node tools/_scratch/frogsim.mjs [--url http://127.0.0.1:5253] [--dir shots/frog] [--seconds 40]
 *
 * Also reports the audio events the frogs raised (croak / land / splash) so
 * the sound layer's inputs can be checked without ears.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', process.env.AUTUMN_URL || 'http://127.0.0.1:5253');
const DIR = arg('dir', 'shots/frog');
const SECONDS = parseFloat(arg('seconds', '40'));
mkdirSync(DIR, { recursive: true });

await acquire('frogsim');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
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

// Colony A (seed 20261018): centroid (367.9, -23.8). Camera on the bank looking down at it.
const C = { x: 367.9, z: -23.8 };
await page.evaluate((C) => {
  const e = window.__engine, W = window.__world, L = window.__systems.lilyPads;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const j = window.__systems.hud?.journal; if (j?.active) j.close?.();
  const wy = W.getWaterHeight(C.x, C.z);
  e.camera.position.set(C.x + 2.2, wy + 1.1, C.z + 2.6);
  e.camera.lookAt(C.x, wy, C.z);
  e.camera.fov = 45; e.camera.updateProjectionMatrix();
  L._lastRefresh.set(1e9, 1e9, 1e9); L._catchup = 40;
  for (let i = 0; i < 30; i++) e._loop();
}, C);

// Spawn three frogs by hand near the centroid, so the camera has something to
// look at without waiting for the spawner's out-of-view rule.
const spawned = await page.evaluate((C) => {
  const F = window.__systems.wildlife.frogs;
  const out = [];
  for (let k = 0; k < 3; k++) {
    const f = F.debugSpawn(C.x + (k - 1) * 0.9, C.z + (k % 2) * 0.8);
    out.push(f ? [f.x.toFixed(2), f.z.toFixed(2), f.size] : null);
  }
  return out;
}, C);
console.log('spawned', JSON.stringify(spawned));

// Step, logging state changes and events; film the first hop.
const log = await page.evaluate(async ({ seconds, dir }) => {
  const e = window.__engine, F = window.__systems.wildlife.frogs;
  const A = window.__systems.audio?.wildlife;
  const lines = [], events = [];
  let last = '';
  const frames = Math.round(seconds * 30);
  let filmed = 0, filming = null;
  window.__frogFrames = [];
  for (let i = 0; i < frames; i++) {
    // Capture the audio events before the audio layer drains them.
    // Drain the queue ourselves: headless, the audio layer never starts, so
    // nothing else does, and the same event would be logged every frame.
    for (const ev of F.events) events.push({ t: +(i / 30).toFixed(2), ...ev });
    F.events.length = 0;
    e._loop();
    const st = F.debugState().map((f) => f.state).join(',');
    if (st !== last) { lines.push(`${(i / 30).toFixed(2)}s ${st}`); last = st; }
    // Film: the first frog to leave SIT, one frame every 2 sim frames, 24 frames.
    const jumper = F.debugState().findIndex((f) => f.state !== 'sit');
    if (filming === null && jumper >= 0 && filmed === 0) filming = { idx: jumper, n: 0 };
    if (filming && i % 2 === 0 && filming.n < 24) {
      window.__frogFrames.push(i);
      filming.n++;
      if (filming.n >= 24) { filmed = 1; filming = null; }
    }
  }
  return { lines, events, stats: F.stats, live: F.debugState() };
}, { seconds: SECONDS, dir: DIR });
console.log(log.lines.join('\n'));
console.log('events', JSON.stringify(log.events.slice(0, 20)));
console.log('stats', JSON.stringify(log.stats), 'live', JSON.stringify(log.live));

// A second, filmed run: fresh frog, forced hop, frames written every other step.
await page.evaluate((C) => {
  const F = window.__systems.wildlife.frogs, L = window.__systems.lilyPads;
  while (F.frogs.length) F._remove(F.frogs.length - 1);
  // A leaf with a neighbour in hop range, so the filmed jump is a HOP.
  const pads = L.padsNear(C.x, C.z, 8, []).filter((p) => p.r >= 0.19)
    .filter((p) => L.padsNear(p.x, p.z, 1.2, []).some((q) => q !== p && q.r >= 0.16 && Math.hypot(q.x - p.x, q.z - p.z) > 0.35))
    .sort((a, b) => Math.hypot(a.x - C.x, a.z - C.z) - Math.hypot(b.x - C.x, b.z - C.z));
  const p = pads[0];
  F.debugSpawn(p ? p.x : C.x, p ? p.z : C.z);
}, C);
const target = await page.evaluate(() => {
  const F = window.__systems.wildlife.frogs, L = window.__systems.lilyPads;
  const f = F.frogs[0];
  if (!f) return null;
  f.croakT = 99;
  // Force the hop now (a dive if no leaf is in reach) rather than waiting on
  // the frog's own timer, which may choose to sit for another six seconds.
  if (!F._beginHop(f, L, 0)) F._beginDive(f, L, false);
  // Camera: 1.4 m off the pad, low, looking at the frog.
  const e = window.__engine;
  // Outside STARTLE_CAMERA (1.7 m), or the camera films a startle-dive every time.
  e.camera.position.set(f.x + 1.7, f.y + 0.7, f.z + 1.5);
  e.camera.lookAt(f.x, f.y + 0.05, f.z);
  e.camera.fov = 40; e.camera.updateProjectionMatrix();
  return { x: f.x, z: f.z };
});
if (target) {
  let shot = 0;
  for (let i = 0; i < 120 && shot < 30; i++) {
    const st = await page.evaluate(() => { window.__engine._loop(); return window.__systems.wildlife.frogs.debugState()[0]?.state ?? 'gone'; });
    if (st !== 'sit' || shot > 0) {
      if (i % 2 === 0) { await page.screenshot({ path: `${DIR}/jump-${String(shot).padStart(2, '0')}-${st}.png` }); shot++; }
    }
    if (st === 'gone') break;
  }
  console.log(`filmed ${shot} frames of a jump`);
}
if (errs.length) console.log('page errors:', errs.slice(0, 5));
await browser.close();

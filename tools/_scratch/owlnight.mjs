#!/usr/bin/env node
/**
 * The owl, in the world, at night — and NOT in the world in the afternoon.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owlnight.mjs <outdir>
 *
 * Four things, all from one page load:
 *   1. at hour 22, does an owl arrive on its own (natural streaming)?
 *   2. force one onto a tree near the camera and photograph it — the "can you
 *      see it, and does it read as an owl" test that no gallery card answers.
 *   3. put it in the air (debugFly) and take a strip through the flap.
 *   4. flip to hour 16.6: no owls, and the day birds still arrive.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2] || 'shots/owlnight';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';
mkdirSync(dir, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
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
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false;
});

const setHour = (h) => page.evaluate((hh) => {
  window.__lighting.hour = hh; window.__lighting.cycleSpeed = 0;
}, h);

// ── 1. natural arrival at night ────────────────────────────────────────────
await setHour(22);
const census = await page.evaluate(async () => {
  const tb = window.__systems.wildlife.treeBirds;
  const out = [];
  for (let i = 0; i < 26; i++) {
    await window.__settle(90);
    const list = tb.debugList();
    out.push(list.filter((b) => b.key === 'owl').length);
  }
  const cam = window.__engine.camera.position;
  return {
    night: window.__skyState?.nightFactor ?? null,
    counts: out,
    list: tb.debugList(),
    cam: { x: cam.x, y: cam.y, z: cam.z },
  };
});
console.log('night owl counts over time:', JSON.stringify(census.counts));
console.log('all tree birds at h22:', JSON.stringify(census.list.map((b) => b.key)));

// ── 2. a forced owl, photographed ──────────────────────────────────────────
const shot = async (name, look) => {
  await page.evaluate(async (v) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__forceCamera = true;
    e.camera.fov = v.fov ?? 42;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    e.camera.lookAt(new THREE.Vector3(v.at[0], v.at[1], v.at[2]));
    await window.__settle?.(v.frames ?? 30);
  }, look);
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
  console.log('shot:', name);
};

const owl = await page.evaluate(async () => {
  const tb = window.__systems.wildlife.treeBirds;
  const cam = window.__engine.camera.position;
  // Try a ring of offsets — a perch needs a tall enough tree nearby.
  for (const [dx, dz] of [[40, 0], [0, 40], [-40, 0], [0, -40], [70, 70], [-70, 70], [90, 0], [0, 90]]) {
    const p = tb.debugPerchNear(cam.x + dx, cam.z + dz, 'owl');
    if (p) return p;
  }
  return null;
});
if (!owl) { console.error('could not perch an owl anywhere near the camera'); }
else {
  console.log('owl perched at', JSON.stringify(owl));
  for (const [name, d, h, fov] of [['perch-near', 16, 3, 30], ['perch-mid', 38, 8, 42], ['perch-far', 85, 16, 45]]) {
    await shot(name, { pos: [owl.x + d * 0.75, owl.y + h * 0.3 - 6, owl.z + d * 0.66], at: [owl.x, owl.y, owl.z], fov, frames: 20 });
  }
}

// ── 3. in flight ───────────────────────────────────────────────────────────
if (owl) {
  const flew = await page.evaluate((o) => {
    const tb = window.__systems.wildlife.treeBirds;
    return tb.debugFly(o.x, o.z);
  }, owl);
  console.log('launched:', JSON.stringify(flew));
  for (let i = 0; i < 6; i++) {
    const p = await page.evaluate(async () => {
      const tb = window.__systems.wildlife.treeBirds;
      await window.__settle(14);
      const b = tb.debugList().find((x) => x.key === 'owl' && x.state === 1);
      return b ?? null;
    });
    if (!p) { console.log(`flight frame ${i}: owl not airborne`); break; }
    await shot(`flight-${i}`, { pos: [p.x + 26, p.y + 5, p.z + 20], at: [p.x, p.y, p.z], fov: 34, frames: 0 });
  }
}

// ── 4. daytime: no owls, day birds unaffected ──────────────────────────────
await setHour(16.6);
const day = await page.evaluate(async () => {
  const tb = window.__systems.wildlife.treeBirds;
  // Long enough that every owl alive at nightfall has had time to leave and
  // every day bird has had a dozen chances to arrive.
  const seen = [];
  for (let i = 0; i < 30; i++) {
    await window.__settle(90);
    seen.push(tb.debugList().map((b) => b.key));
  }
  return {
    owlsPerTick: seen.map((s) => s.filter((k) => k === 'owl').length),
    final: seen[seen.length - 1],
    eagles: seen.map((s) => s.filter((k) => k === 'baldEagle').length),
  };
});
console.log('day owl counts:', JSON.stringify(day.owlsPerTick));
console.log('day eagle counts:', JSON.stringify(day.eagles));
console.log('day final birds:', JSON.stringify(day.final));
await shot('day-scene', { pos: [census.cam.x + 30, census.cam.y + 10, census.cam.z + 30], at: [census.cam.x, census.cam.y, census.cam.z], fov: 50 });

if (errs.length) console.log('page-errors:', JSON.stringify([...new Set(errs)].slice(0, 8), null, 1));
else console.log('page-errors: none');
await browser.close();

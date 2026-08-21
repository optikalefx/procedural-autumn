#!/usr/bin/env node
/**
 * Two camps in one frame.
 *
 * The clearing is a shader array now (camp_clearing.js), so the thing that has
 * to be seen rather than asserted is that BOTH discs actually suppress their
 * grass — an array that silently only ever reads slot 0 would pass every unit
 * check in campmulti.mjs and look exactly like a bug here.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2400);

const info = await page.evaluate(async () => {
  const camp = window.__camp, v = window.__systems.vehicle, W = window.__world, S = window.__campSiteMod;
  const spin = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  camp.strike(); await spin(20);
  const made = [];
  // Two camps close enough to share a frame and far enough apart to be legal.
  for (const [dx, dz] of [[16, 6], [-4, 24]]) {
    const s = S.bestSite(W, v.position.x + dx, v.position.z + dz,
      { blocked: (bx, bz, br) => camp._blocked(bx, bz, br) });
    if (!s.ok) { made.push({ skipped: s.reason }); continue; }
    const c = camp.pitchAt(s.x, s.z, { instant: true });
    await spin(6);
    made.push({ x: +c.x.toFixed(1), z: +c.z.toFixed(1), r: c.radius, props: c.props.length });
  }
  return { made, camps: camp.camps.length,
           slots: window.__ctx ? null : null };
});
console.log('camps:', JSON.stringify(info));

mkdirSync(resolve('shots/camp/two'), { recursive: true });
await page.evaluate(async () => {
  const camp = window.__camp, e = window.__engine, T = window.__THREE;
  window.__lighting.hour = 16.8; window.__lighting.cycleSpeed = 0;
  // Frame both camps: stand back along the line between them, up high.
  const cs = camp.camps;
  const mx = cs.reduce((a, c) => a + c.x, 0) / cs.length;
  const mz = cs.reduce((a, c) => a + c.z, 0) / cs.length;
  const y = window.__world.getHeight(mx, mz);
  e.camera.fov = 52; e.camera.updateProjectionMatrix();
  e.camera.position.set(mx + 26, y + 22, mz + 26);
  e.camera.lookAt(mx, y, mz);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(700, 24);
});
await page.waitForTimeout(700);
await page.screenshot({ path: resolve('shots/camp/two/both.png') });
console.log('shot: shots/camp/two/both.png');
if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 4));
await browser.close();

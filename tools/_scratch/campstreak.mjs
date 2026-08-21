#!/usr/bin/env node
/**
 * What are the purple diagonal bands on the camp dirt?
 *
 * They have survived three rounds of work on camp_ground.js, which is good
 * evidence that they are not IN camp_ground.js. The alternative hypothesis is
 * that the dirt is correctly receiving a world-space effect that is simply
 * invisible on gold grass and obvious on pale earth — cloud shadow, the massif
 * shadow field, or the stylised shadow-cooling tint.
 *
 * Turns each suspect off in turn and photographs the same frame.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) return { readyState: 3, url: u, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    return new Real(u, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow'); window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(2200);

const site = await page.evaluate(() => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  return s;
});
const DIR = 'shots/camp/streak';
mkdirSync(resolve(DIR), { recursive: true });

const pose = async () => page.evaluate(async (s) => {
  const e = window.__engine, T = window.__THREE;
  e.camera.fov = 46; e.camera.updateProjectionMatrix();
  e.camera.position.set(s.x + 9, s.y + 8.5, s.z + 9);
  e.camera.lookAt(s.x, s.y, s.z);
  window.__forceCamera = true;
  if (window.__settleStable) await window.__settleStable(400, 20);
}, site);

const cases = {
  baseline:    () => {},
  'no-clouds': () => { window.__systems.clouds.enabled = false;
                       const a = window.__atmosphere.params;
                       a.cloudShadowTint.set(1, 1, 1); a.cloudStrength = 0; },
  'no-massif': () => { window.__atmosphere.params.massifStrength = 0;
                       if (window.__atmosphere.massif) window.__atmosphere.massif.strength = 0; },
  'no-shadowcool': () => { const p = window.__stylize.params;
                           p.shadowCoolAmt = 0; p.shadowCoolLift = 0; },
  'no-sunshadow': () => { window.__engine.renderer.shadowMap.enabled = false; },
};
for (const [name, fn] of Object.entries(cases)) {
  await page.evaluate(`(${fn.toString()})()`);
  await pose();
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(DIR, `${name}.png`) });
  console.log('shot', name);
}
await browser.close();

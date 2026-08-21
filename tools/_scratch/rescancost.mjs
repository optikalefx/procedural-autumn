#!/usr/bin/env node
/** What one rock-collider rescan costs, on the worst ground for it. */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
        send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForFunction(() => !!window.__vehicle && !!window.__systems?.rocks, null, { timeout: 60000, polling: 200 });
await page.waitForTimeout(2000);
const rows = [];
for (let i = 0; i < 6; i++) {
  const spot = await page.evaluate(() => {
    const W = window.__world;
    for (let k = 0; k < 100000; k++) {
      const x = (Math.random() * 2 - 1) * 1250, z = (Math.random() * 2 - 1) * 1250;
      if (W.getWaterDepth(x, z) > 0.05) continue;
      if (W.getSlope(x, z) > 0.7 || W.getHeight(x, z) < 90) continue;
      return { x, z };
    }
    return null;
  });
  if (!spot) continue;
  await page.evaluate((S) => window.__vehicleTeleport(S.x, S.z, 0), spot);
  await page.waitForTimeout(2500);
  rows.push(await page.evaluate(() => {
    const RC = window.__vehicle.phys.rocks, s = window.__vehicleState();
    let instances = 0;
    for (const c of window.__systems.rocks.cells.values()) instances += c.instances.length;
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) RC._rescan(s.x, s.z);
    const ms = (performance.now() - t0) / 20;
    return { instances, ms, colliders: RC.count };
  }));
}
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`${rows.length} spots on high ground`);
console.log(`  streamed rock instances scanned: ${Math.max(...rows.map((r) => r.instances))} worst`);
console.log(`  one rescan: median ${ms[ms.length >> 1].toFixed(2)} ms   worst ${ms[ms.length - 1].toFixed(2)} ms`);
console.log(`  (a 60 fps frame is 16.7 ms; a rescan happens at most every 20 frames)`);
await browser.close();

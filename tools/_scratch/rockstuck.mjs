#!/usr/bin/env node
/**
 * When solid rock stops the camper, WHAT stopped it?
 *
 * Drives from river banks with the throttle held and, the moment the camper is
 * genuinely stuck, photographs the frame and reports the rock in front of it:
 * how far it stands out of the ground, how wide it is, and whether the wheels
 * are on it or the chassis is against it. A boulder standing 2 m out of a
 * riverbed stopping a camper is the feature working; a 40 cm cobble doing it is
 * a bug, and only the frame and the numbers together tell you which.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const ANCHORS = parseInt(arg('anchors', '6'), 10);
mkdirSync('shots/rockstuck', { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 560 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {}, send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const rocks = window.__systems.rocks;
  const tops = {};
  for (const [a, gs] of Object.entries(rocks.library)) {
    tops[a] = gs.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox.max.y; });
  }
  window.__rockProbe = () => {
    const v = window.__vehicle, W = window.__world;
    const p = v.position, f = v.forward;
    let best = null;
    for (const c of rocks.cells.values()) {
      for (const r of c.instances) {
        const dx = r.x - p.x, dz = r.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 9) continue;
        // In front, roughly: the thing we are pushing against.
        const ahead = (dx * f.x + dz * f.z) / Math.max(d, 1e-3);
        if (ahead < 0.25) continue;
        const prot = r.y + (tops[r.arch]?.[r.variant] ?? 1) * r.sy - r.groundY;
        const gap = d - Math.max(r.sx, r.sz);
        if (!best || gap < best.gap) {
          best = { arch: r.arch, size: +r.size.toFixed(2), prot: +prot.toFixed(2),
            reach: +Math.max(r.sx, r.sz).toFixed(2), d: +d.toFixed(2), gap: +gap.toFixed(2),
            waterHere: +W.getWaterDepth(r.x, r.z).toFixed(2) };
        }
      }
    }
    return { rock: best,
      wheels: v.wheels.map((w) => ({ g: w.grounded, c: +w.compression.toFixed(2) })),
      colliders: v.phys.rocks?.count ?? 0,
      // How high the body sits over the terrain: a chassis resting on a rock
      // reads high, a chassis jammed against one reads normal.
      lift: +(p.y - W.getHeight(p.x, p.z)).toFixed(2),
      water: +v.waterDepth.toFixed(2),
    };
  };
});

const banks = await page.evaluate((n) => {
  const W = window.__world, poi = window.__poi;
  const out = [];
  for (let i = 0; i < 20 && out.length < n; i++) {
    const p = poi.best('river', i);
    if (!p) break;
    let bestAng = 0, bestR = -1;
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      let r = 0;
      for (let d = 6; d <= 30; d += 6) r += W.getRiver(p.x + Math.sin(ang) * d, p.z + Math.cos(ang) * d);
      if (r > bestR) { bestR = r; bestAng = ang; }
    }
    const sx = p.x - Math.sin(bestAng) * 18, sz = p.z - Math.cos(bestAng) * 18;
    if (!W.isInBounds(sx, sz) || W.getWaterDepth(sx, sz) > 0.05) continue;
    out.push({ x: sx, z: sz, ang: bestAng });
  }
  return out;
}, ANCHORS);

for (let i = 0; i < banks.length; i++) {
  await page.evaluate((B) => { window.__vehicleTeleport(B.x, B.z, B.ang); window.__vehicle.phys.recoveries = 0; }, banks[i]);
  await page.waitForTimeout(1100);
  await page.keyboard.down('KeyW');
  let stuckFor = 0, probe = null;
  for (let k = 0; k < 110; k++) {
    await page.waitForTimeout(130);
    const s = await page.evaluate(() => ({ st: window.__vehicleState(), pr: window.__rockProbe() }));
    if (Math.abs(s.st.speed) < 0.6) stuckFor += 0.13; else stuckFor = 0;
    if (stuckFor > 1.5 && s.pr.rock) { probe = s.pr; break; }
  }
  await page.keyboard.up('KeyW');
  if (!probe) { console.log(`bank ${i}: never stuck against a rock`); continue; }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `shots/rockstuck/bank${i}.png` });
  console.log(`bank ${i}: ${JSON.stringify(probe)}`);
}
await browser.close();

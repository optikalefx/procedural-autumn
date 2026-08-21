#!/usr/bin/env node
/**
 * Does making rock solid break the river crossing?
 *
 * drive.mjs's river scenario went from a clean run to five auto-recoveries once
 * rocks became colliders, and river beds are full of rock by design. This runs
 * that same scenario twice from one boot — once with the rock colliders live,
 * once with them switched off at runtime — over the same twelve river anchors,
 * so the difference is the rock and nothing else.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '22'));
const ANCHORS = parseInt(arg('anchors', '6'), 10);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
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
await page.goto('http://localhost:5178?res=640');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

// Same anchor search drive.mjs uses, resolved once so both arms share it.
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

async function arm(rocksOn) {
  await page.evaluate((on) => {
    const phys = window.__vehicle.phys;
    if (!on) { phys.rocks?.clear(); phys.__savedRocks = phys.__savedRocks ?? phys.rocks; phys.rocks = null; }
    else if (phys.__savedRocks) { phys.rocks = phys.__savedRocks; }
  }, rocksOn);
  const runs = [];
  for (const b of banks) {
    await page.evaluate((B) => {
      window.__vehicleTeleport(B.x, B.z, B.ang);
      window.__vehicle.phys.recoveries = 0;
    }, b);
    await page.waitForTimeout(1100);
    const t0 = await page.evaluate(() => window.__vehicleState());
    await page.keyboard.down('KeyW');
    let stuckSamples = 0, n = 0;
    const tEnd = Date.now() + SECONDS * 1000;
    while (Date.now() < tEnd) {
      await page.waitForTimeout(140);
      const s = await page.evaluate(() => window.__vehicleState());
      n++;
      if (Math.abs(s.speed) < 0.5) stuckSamples++;
    }
    await page.keyboard.up('KeyW');
    const s = await page.evaluate(() => window.__vehicleState());
    runs.push({
      dist: Math.hypot(s.x - t0.x, s.z - t0.z),
      recoveries: s.recoveries,
      stuckFrac: stuckSamples / Math.max(1, n),
      water: s.water,
    });
  }
  return runs;
}

const on = await arm(true);
const off = await arm(false);
const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
console.log(`\n${banks.length} river banks x ${SECONDS}s, throttle held\n`);
for (const [label, a] of [['rocks SOLID', on], ['rocks OFF  ', off]]) {
  console.log(`── ${label}   total distance ${sum(a, 'dist').toFixed(0)} m   recoveries ${sum(a, 'recoveries')}   stuck ${(100 * sum(a, 'stuckFrac') / a.length).toFixed(0)}% of samples`);
  console.log(`   per bank: ${a.map((r) => `${r.dist.toFixed(0)}m/${r.recoveries}r`).join('  ')}`);
}
await browser.close();

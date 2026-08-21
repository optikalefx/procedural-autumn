#!/usr/bin/env node
/**
 * The player's two rules, tested as one question per rock:
 *
 *   "drive at it in a straight line — did the camper end up on the far side?"
 *
 * Crossing is unambiguous in a way that "how close did it get" is not: the
 * camper's centre starts on one side of the plane through the rock's centre and
 * either finishes on the other side or it does not. Grouped by how far the rock
 * stands out of the ground, that is the whole feature in one table.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '30'), 10);
const RUN = 18;                       // metres back from the rock

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
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

await page.evaluate(() => {
  const rocks = window.__systems.rocks;
  window.__tops = {};
  for (const [a, gs] of Object.entries(rocks.library)) {
    window.__tops[a] = gs.map((g) => { if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox.max.y; });
  }
});

// Collect candidates spread across the protrusion range, each with a clean,
// flat, dry approach lane so the run measures the rock and not the hill.
const targets = await page.evaluate(async (P) => {
  const W = window.__world, rocks = window.__systems.rocks, veh = window.__systems.vehicle;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pool = [];
  for (let attempt = 0; attempt < 120 && pool.length < P.n * 4; attempt++) {
    const x = (Math.random() * 2 - 1) * 1250, z = (Math.random() * 2 - 1) * 1250;
    if (W.getWaterDepth(x, z) > 0.05 || W.getSlope(x, z) > 0.5) continue;
    veh.phys.teleport(x, z, 0);
    await sleep(650);
    for (const c of rocks.cells.values()) {
      for (const r of c.instances) {
        if (Math.hypot(r.x - x, r.z - z) > 55) continue;
        const prot = r.y + (window.__tops[r.arch]?.[r.variant] ?? 1) * r.sy - r.groundY;
        if (prot < 0.15) continue;
        // A lane that is flat, dry and free of other rock, from some bearing.
        let lane = null;
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const sx = r.x + Math.cos(a) * P.run, sz = r.z + Math.sin(a) * P.run;
          if (!W.isInBounds(sx, sz)) continue;
          let bad = false, worst = 0;
          for (let s = 0; s <= 1.0; s += 0.08) {
            const px = sx + (r.x - sx) * s, pz = sz + (r.z - sz) * s;
            if (W.getWaterDepth(px, pz) > 0.05) { bad = true; break; }
            worst = Math.max(worst, W.getSlope(px, pz));
          }
          if (bad || worst > 0.55) continue;
          if (!lane || worst < lane.worst) lane = { sx, sz, worst };
        }
        if (!lane) continue;
        pool.push({ x: r.x, z: r.z, prot, size: r.size, arch: r.arch,
          reach: Math.max(r.sx, r.sz), sx: lane.sx, sz: lane.sz });
      }
    }
  }
  const seen = new Set();
  const uniq = pool.filter((f) => { const k = `${Math.round(f.x)},${Math.round(f.z)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => a.prot - b.prot);
  // Spread the sample across the range rather than taking the smallest n.
  const out = [];
  for (let i = 0; i < P.n && uniq.length; i++) {
    out.push(uniq[Math.min(uniq.length - 1, Math.round(i * (uniq.length - 1) / Math.max(1, P.n - 1)))]);
  }
  return out;
}, { n: N, run: RUN });

console.log(`${targets.length} rocks with a clean approach lane`);

const results = [];
for (const t of targets) {
  const yaw = Math.atan2(t.x - t.sx, t.z - t.sz);
  await page.evaluate((T) => { window.__vehicleTeleport(T.sx, T.sz, T.yaw); window.__vehicle.phys.recoveries = 0; },
    { ...t, yaw });
  await page.waitForTimeout(1000);
  // Unit vector from start toward the rock; the camper has crossed when its
  // projection along it passes the rock's own projection.
  const ux = (t.x - t.sx) / RUN, uz = (t.z - t.sz) / RUN;
  const rockS = t.x * ux + t.z * uz;
  await page.keyboard.down('KeyW');
  let crossed = false, maxS = -Infinity, recov = 0;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(130);
    const s = await page.evaluate(() => window.__vehicleState());
    recov = s.recoveries;
    if (recov > 0) break;                       // a rescue invalidates the run
    const proj = s.x * ux + s.z * uz;
    maxS = Math.max(maxS, proj);
    if (proj > rockS + 0.5) { crossed = true; break; }
  }
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(200);
  results.push({ ...t, crossed, short: rockS - maxS, recov });
  process.stdout.write(crossed ? '·' : 'x');
}
console.log('');

const bands = [[0.15, 0.35], [0.35, 0.55], [0.55, 0.80], [0.80, 1.50], [1.50, 99]];
console.log('\n  protrusion      n   drove over   stopped');
for (const [lo, hi] of bands) {
  const g = results.filter((r) => r.prot >= lo && r.prot < hi && r.recov === 0);
  if (!g.length) continue;
  const over = g.filter((r) => r.crossed).length;
  console.log(`  ${lo.toFixed(2)}–${hi === 99 ? ' +  ' : hi.toFixed(2)}   ${String(g.length).padStart(3)}   ${String(over).padStart(10)}   ${String(g.length - over).padStart(7)}`);
}
console.log('\n  rocks that stopped the camper, by size:');
for (const r of results.filter((q) => !q.crossed && q.recov === 0).sort((a, b) => a.prot - b.prot)) {
  console.log(`    ${r.arch.padEnd(9)} protrudes ${r.prot.toFixed(2)} m, ${(r.reach * 2).toFixed(1)} m wide — stopped ${r.short.toFixed(1)} m short`);
}
const skipped = results.filter((r) => r.recov > 0).length;
if (skipped) console.log(`\n  (${skipped} runs discarded: the auto-rescue fired)`);
if (errors.length) console.log('\nPAGE ERRORS:', errors.slice(0, 5));
await browser.close();

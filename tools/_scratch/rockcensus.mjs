#!/usr/bin/env node
/**
 * Rock census for the collision work: how many rock instances stand within a
 * collider radius of the camper, and how far each one actually protrudes above
 * the terrain. Both numbers decide the budget and the size gate.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const R = parseFloat(arg('r', '34'));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
// Immune to a peer saving a file mid-run — see the same stub in drive.mjs.
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
await page.goto(`http://localhost:5178?res=768`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async (RAD) => {
  const W = window.__world, e = window.__engine;
  const rocks = window.__systems.rocks;
  const veh = window.__systems.vehicle;
  const lib = rocks.library;

  // Local top of every variant, in local units.
  const tops = {};
  for (const [arch, geoms] of Object.entries(lib)) {
    tops[arch] = geoms.map((g) => { g.computeBoundingBox(); return g.boundingBox.max.y; });
  }

  // Random *drivable* ground, not the road network: the road has a rock veto
  // built into the scatter, so sampling it measures the one corridor that is
  // guaranteed to be clear.
  const sample = [];
  let guard = 0;
  while (sample.length < 34 && guard++ < 4000) {
    const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
    if (W.getWaterDepth(x, z) > 0.05) continue;
    if (W.getSlope(x, z) > 0.9) continue;
    sample.push({ x, z });
  }

  const rows = [];
  for (const s of sample) {
    veh.phys.teleport(s.x, s.z, 0);
    // Let the rock streamer catch up on this position.
    for (let k = 0; k < 40; k++) { e.clock.getDelta = () => 1 / 30; rocks.update(1 / 30, k / 30); await new Promise((r2) => setTimeout(r2, 16)); }
    const near = [];
    for (const c of rocks.cells.values()) {
      for (const inst of c.instances) {
        const dx = inst.x - s.x, dz = inst.z - s.z;
        if (dx * dx + dz * dz > RAD * RAD) continue;
        const topLocal = tops[inst.arch]?.[inst.variant] ?? 1;
        const top = inst.y + topLocal * inst.sy;
        const g = W.getHeight(inst.x, inst.z);
        near.push({ arch: inst.arch, size: inst.size, prot: top - g,
          rx: Math.max(inst.sx, inst.sz) });
      }
    }
    rows.push({ x: s.x, z: s.z, near });
  }
  return { rows };
}, R);

const all = out.rows.flatMap((r) => r.near);
const counts = out.rows.map((r) => r.near.length).sort((a, b) => a - b);
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
console.log(`stops ${out.rows.length}  radius ${R} m`);
console.log(`instances within radius: median ${pct(counts, 0.5)}  p90 ${pct(counts, 0.9)}  max ${counts[counts.length - 1]}`);

for (const t of [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.60, 0.90]) {
  const per = out.rows.map((r) => r.near.filter((n) => n.prot >= t).length).sort((a, b) => a - b);
  console.log(`  protrude >= ${t.toFixed(2)} m : median ${pct(per, 0.5)}  p90 ${pct(per, 0.9)}  max ${per[per.length - 1]}`);
}
const byArch = {};
for (const a of all) {
  const b = byArch[a.arch] ??= { n: 0, prot: [] };
  b.n++; b.prot.push(a.prot);
}
console.log('\nby archetype (count, median protrusion, p90 protrusion, max):');
for (const [k, v] of Object.entries(byArch).sort((a, b) => b[1].n - a[1].n)) {
  v.prot.sort((a, b) => a - b);
  console.log(`  ${k.padEnd(9)} n=${String(v.n).padStart(5)}  med ${pct(v.prot, 0.5).toFixed(2)}  p90 ${pct(v.prot, 0.9).toFixed(2)}  max ${v.prot[v.prot.length - 1].toFixed(2)}`);
}
await browser.close();

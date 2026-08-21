#!/usr/bin/env node
/**
 * Pop-in, measured deterministically.
 *
 * An earlier version of this drove the camper with real keys, and the two arms
 * of the A/B took different paths through the valley — which made the numbers
 * swing further between runs than the change being measured. So: no physics.
 * The engine is stopped and the camera is walked along a FIXED straight line at
 * a fixed speed with a fixed timestep, calling the rock streamer by hand. Both
 * arms see the identical path, so any difference is the streaming maths.
 *
 * `rocks._buildCells` spends a wall-clock budget per call, so one call per
 * simulated frame gives the builder exactly the budget it would get in a real
 * frame — the one thing about this that must stay honest.
 *
 * For each instance that comes into existence, records how far it was from the
 * camera at that moment. A rock that appears already inside its own draw radius
 * is one the player watched wink on.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const LINES = parseInt(arg('lines', '6'), 10);
const LEN = parseFloat(arg('len', '600'));      // metres per line
const SPEED = parseFloat(arg('speed', '16'));   // m/s

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
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
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async (P) => {
  const e = window.__engine, W = window.__world, rocks = window.__systems.rocks;
  e.stop();
  window.__forceCamera = true;
  const cam = e.camera;

  // Deterministic line picker: a fixed lattice of starts and bearings, so both
  // arms and every re-run walk the same ground.
  const lines = [];
  for (let i = 0; i < P.lines; i++) {
    const a = (i / P.lines) * Math.PI * 2 + 0.37;
    const r = 900;
    lines.push({ x: Math.cos(a + 2.1) * r * 0.8, z: Math.sin(a + 2.1) * r * 0.8, dx: Math.cos(a), dz: Math.sin(a) });
  }

  const newMin = rocks._minSizeFor;
  const oldMin = function (d) {
    const need = (2 * d) / 88;
    if (need < 0.9) return 0;
    if (need < 2.2) return 0.8;
    if (need < 4.0) return 2.0;
    if (need < 6.5) return 3.8;
    if (need < 10.0) return 6.2;
    if (need < 15.0) return 9.6;
    if (need < 22.0) return 14.5;
    if (need < 30.0) return 21.0;
    return 29.0;
  };

  async function walk(useOld) {
    // The old build also only reassessed cells on a 64 m cell crossing; force
    // that by making the travel test unreachable.
    rocks._minSizeFor = useOld ? oldMin : newMin;
    rocks.__forceCellOnly = !!useOld;
    const events = [];
    let created = 0;
    for (const L of lines) {
      rocks.cells.clear(); rocks.queue.length = 0;
      rocks._lastCell.x = 1e9; rocks._lastCell.z = 1e9;
      rocks._lastRefresh.set(1e9, 1e9, 1e9);
      rocks._dirty = true;
      cam.position.set(L.x, W.getHeight(L.x, L.z) + 9, L.z);
      // Settle at rest, exactly as arriving somewhere does.
      rocks._catchup = 60;
      for (let k = 0; k < 70; k++) { rocks.update(1 / 30, k / 30); await new Promise((r) => setTimeout(r)); }
      let seen = new Set();
      for (const c of rocks.cells.values()) for (const r of c.instances) seen.add(`${Math.round(r.x * 8)},${Math.round(r.z * 8)}`);

      const steps = Math.round(P.len / (P.speed / 30));
      for (let s = 0; s < steps; s++) {
        const px = L.x + L.dx * (s * P.speed / 30), pz = L.z + L.dz * (s * P.speed / 30);
        if (!W.isInBounds(px, pz)) break;
        cam.position.set(px, W.getHeight(px, pz) + 9, pz);
        rocks.update(1 / 30, s / 30);
        await new Promise((r) => setTimeout(r));
        const now = new Set();
        for (const c of rocks.cells.values()) {
          for (const r of c.instances) {
            const k = `${Math.round(r.x * 8)},${Math.round(r.z * 8)}`;
            now.add(k);
            if (seen.has(k)) continue;
            created++;
            const d = Math.hypot(r.x - px, r.z - pz);
            if (d <= r.vis) events.push({ d, size: r.size, arch: r.arch });
          }
        }
        seen = now;
      }
    }
    return { events, created, cells: rocks.cells.size, tris: rocks.stats.tris, drawn: rocks.stats.instances };
  }

  const oldRun = await walk(true);
  const newRun = await walk(false);
  rocks.__forceCellOnly = false;
  return { oldRun, newRun };
}, { lines: LINES, len: LEN, speed: SPEED });

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
console.log(`\n${LINES} straight lines x ${LEN} m at ${SPEED} m/s, identical path in both arms\n`);
for (const [label, r] of [['OLD gate  (2d/V)', out.oldRun], ['NEW gate  (exact + lead)', out.newRun]]) {
  const ds = r.events.map((e) => e.d);
  console.log(`── ${label}`);
  console.log(`   instances created while moving: ${r.created}`);
  console.log(`   …of which VISIBLE the instant they existed: ${r.events.length}`);
  if (ds.length) {
    console.log(`   nearest wink-on ${Math.min(...ds).toFixed(1)} m   p10 ${pct(ds, 0.1).toFixed(1)} m   median ${pct(ds, 0.5).toFixed(1)} m`);
    console.log(`   winked on within 20 m: ${ds.filter((d) => d < 20).length}   within 40 m: ${ds.filter((d) => d < 40).length}   within 80 m: ${ds.filter((d) => d < 80).length}`);
  }
  console.log(`   end state: ${r.cells} cells, ${r.drawn} drawn, ${r.tris} tris\n`);
}
await browser.close();

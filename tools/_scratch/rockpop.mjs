#!/usr/bin/env node
/**
 * Rock pop-in audit.
 *
 * Two gates decide whether you see a rock and they are written in different
 * places:
 *   · GENERATION  Rocks._minSizeFor(d), d = camera→CELL CENTRE
 *   · DRAWING     inst.vis = clamp(size * 88, 80, 950), from camera→ROCK
 * This measures how far apart they are: at each sample it lists what is
 * generated now, then regenerates every nearby cell at full detail and counts
 * what was missing — and how close the nearest missing rock was.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '18'), 10);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (p === 'vite-hmr' || String(p).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
        send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, p);
  };
  window.WebSocket.prototype = Real.prototype;
});
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async (want) => {
  const W = window.__world, rocks = window.__systems.rocks, veh = window.__systems.vehicle;
  const CELL = 64;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  let guard = 0;
  while (rows.length < want && guard++ < 300) {
    const x = (Math.random() * 2 - 1) * 1300, z = (Math.random() * 2 - 1) * 1300;
    if (W.getWaterDepth(x, z) > 0.05 || W.getSlope(x, z) > 0.7) continue;
    veh.phys.teleport(x, z, 0);
    await sleep(900);
    const cam = window.__engine.camera.position.clone();

    // What exists right now, keyed by position.
    const have = new Map();
    for (const c of rocks.cells.values()) {
      for (const r of c.instances) have.set(`${Math.round(r.x * 8)},${Math.round(r.z * 8)}`, r);
    }
    // What SHOULD exist: regenerate every cell within 200 m at full detail.
    const truth = [];
    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const list = [];
        rocks.scatter.generateCell(ccx + dx, ccz + dz, CELL, 0, list);
        for (const r of list) truth.push(r);
      }
    }
    const missing = [];
    for (const r of truth) {
      const d = Math.hypot(r.x - cam.x, r.z - cam.z);
      const vis = Math.min(950, Math.max(80, r.size * 88));
      if (d > vis) continue;                                 // would not be drawn anyway
      if (have.has(`${Math.round(r.x * 8)},${Math.round(r.z * 8)}`)) continue;
      missing.push({ d, size: r.size, arch: r.arch });
    }
    missing.sort((a, b) => a.d - b.d);
    const drawnNow = [...have.values()].filter((r) => {
      const d = Math.hypot(r.x - cam.x, r.z - cam.z);
      return d <= Math.min(950, Math.max(80, r.size * 88));
    }).length;
    rows.push({
      x, z, drawnNow, missing: missing.length,
      nearestMissing: missing.length ? missing[0].d : null,
      nearestSize: missing.length ? missing[0].size : null,
      within20: missing.filter((m) => m.d < 20).length,
      within40: missing.filter((m) => m.d < 40).length,
      stats: { ...rocks.stats },
    });
  }
  return rows;
}, N);

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
console.log(`samples ${out.length}`);
console.log(`rocks drawn now (per spot): median ${pct(out.map((r) => r.drawnNow), 0.5)}  p90 ${pct(out.map((r) => r.drawnNow), 0.9)}`);
console.log(`MISSING but inside their own draw radius: median ${pct(out.map((r) => r.missing), 0.5)}  p90 ${pct(out.map((r) => r.missing), 0.9)}  max ${Math.max(...out.map((r) => r.missing))}`);
console.log(`  missing within 40 m: median ${pct(out.map((r) => r.within40), 0.5)}  max ${Math.max(...out.map((r) => r.within40))}`);
console.log(`  missing within 20 m: median ${pct(out.map((r) => r.within20), 0.5)}  max ${Math.max(...out.map((r) => r.within20))}`);
const nm = out.map((r) => r.nearestMissing).filter((v) => v != null);
console.log(`  nearest missing rock: min ${Math.min(...nm).toFixed(1)} m  median ${pct(nm, 0.5).toFixed(1)} m`);
console.log(`live instances: median ${pct(out.map((r) => r.stats.instances), 0.5)}  p90 ${pct(out.map((r) => r.stats.instances), 0.9)}`);
console.log(`live tris:      median ${pct(out.map((r) => r.stats.tris), 0.5)}  p90 ${pct(out.map((r) => r.stats.tris), 0.9)}`);
await browser.close();

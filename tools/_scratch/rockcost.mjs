#!/usr/bin/env node
/**
 * What the rock streamer costs per frame, old gate vs new, on the identical
 * path — so a whole-frame perf regression can be attributed or ruled out
 * without touching the shared source tree.
 *
 * Same deterministic walk as rockpopdrive.mjs. Times rocks.update alone.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const LINES = parseInt(arg('lines', '6'), 10);
const LEN = parseFloat(arg('len', '600'));
const SPEED = parseFloat(arg('speed', '16'));

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
  const lines = [];
  for (let i = 0; i < P.lines; i++) {
    const a = (i / P.lines) * Math.PI * 2 + 0.37;
    lines.push({ x: Math.cos(a + 2.1) * 720, z: Math.sin(a + 2.1) * 720, dx: Math.cos(a), dz: Math.sin(a) });
  }
  const newMin = rocks._minSizeFor;
  const oldMin = function (d) {
    const need = (2 * d) / 88;
    if (need < 0.9) return 0; if (need < 2.2) return 0.8; if (need < 4.0) return 2.0;
    if (need < 6.5) return 3.8; if (need < 10.0) return 6.2; if (need < 15.0) return 9.6;
    if (need < 22.0) return 14.5; if (need < 30.0) return 21.0; return 29.0;
  };
  async function walk(useOld) {
    rocks._minSizeFor = useOld ? oldMin : newMin;
    rocks.__forceCellOnly = !!useOld;
    const times = [];
    for (const L of lines) {
      rocks.cells.clear(); rocks.queue.length = 0;
      rocks._lastCell.x = 1e9; rocks._lastCell.z = 1e9;
      rocks._lastRefresh.set(1e9, 1e9, 1e9);
      cam.position.set(L.x, W.getHeight(L.x, L.z) + 9, L.z);
      rocks._catchup = 60;
      for (let k = 0; k < 70; k++) { rocks.update(1 / 30, k / 30); await new Promise((r) => setTimeout(r)); }
      const steps = Math.round(P.len / (P.speed / 30));
      for (let s = 0; s < steps; s++) {
        const px = L.x + L.dx * (s * P.speed / 30), pz = L.z + L.dz * (s * P.speed / 30);
        if (!W.isInBounds(px, pz)) break;
        cam.position.set(px, W.getHeight(px, pz) + 9, pz);
        const t0 = performance.now();
        rocks.update(1 / 30, s / 30);
        times.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r));
      }
    }
    return times;
  }
  const o = await walk(true);
  const n = await walk(false);
  rocks.__forceCellOnly = false;
  return { o, n };
}, { lines: LINES, len: LEN, speed: SPEED });

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
console.log(`\nrocks.update cost per frame, ${LINES} lines x ${LEN} m at ${SPEED} m/s\n`);
for (const [k, a] of [['OLD gate', out.o], ['NEW gate', out.n]]) {
  console.log(`── ${k}   frames ${a.length}`);
  console.log(`   p50 ${pct(a, 0.5).toFixed(2)} ms   p95 ${pct(a, 0.95).toFixed(2)} ms   p99 ${pct(a, 0.99).toFixed(2)} ms   worst ${Math.max(...a).toFixed(1)} ms`);
  console.log(`   frames over 5 ms: ${a.filter((v) => v > 5).length}   over 10 ms: ${a.filter((v) => v > 10).length}\n`);
}
await browser.close();

#!/usr/bin/env node
/**
 * Far-field rock census — the "white chips sprinkled on the massif" metric.
 *
 * The old generation gate silently halved every rock's draw distance (it
 * generated `size >= 2d/V`, so a rock only ever existed within `size*V/2`).
 * Making the gate exact restores the draw rule as written, which is a change to
 * the FAR field as well as a fix to the near one. This counts what is drawn
 * past 250 m and how big it is on screen, so that change is a number.
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '10'), 10);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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

const out = await page.evaluate(async (want) => {
  const W = window.__world, rocks = window.__systems.rocks, veh = window.__systems.vehicle, e = window.__engine;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  let guard = 0;
  while (rows.length < want && guard++ < 200) {
    const x = (Math.random() * 2 - 1) * 1200, z = (Math.random() * 2 - 1) * 1200;
    if (W.getWaterDepth(x, z) > 0.05 || W.getSlope(x, z) > 0.7) continue;
    veh.phys.teleport(x, z, 0);
    await sleep(1400);
    const cam = e.camera.position.clone();
    // Apparent size in pixels, vertical FOV, 720 px tall frame.
    const pxPerRad = 720 / (e.camera.fov * Math.PI / 180);
    const bands = { '250-450': 0, '450-700': 0, '700+': 0 };
    let tinyDrawn = 0, drawn = 0;
    for (const c of rocks.cells.values()) {
      for (const r of c.instances) {
        const d = Math.hypot(r.x - cam.x, r.z - cam.z);
        if (d > r.vis) continue;
        drawn++;
        if (d < 250) continue;
        bands[d < 450 ? '250-450' : d < 700 ? '450-700' : '700+']++;
        const px = (2 * Math.max(r.sx, r.sy, r.sz) / d) * pxPerRad;
        if (px < 6) tinyDrawn++;
      }
    }
    rows.push({ drawn, ...bands, tinyDrawn, stats: { ...rocks.stats } });
  }
  return rows;
}, N);

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const col = (k) => out.map((r) => r[k]);
console.log(`samples ${out.length}`);
for (const k of ['drawn', '250-450', '450-700', '700+', 'tinyDrawn']) {
  console.log(`  ${k.padEnd(10)} median ${String(pct(col(k), 0.5)).padStart(5)}  p90 ${String(pct(col(k), 0.9)).padStart(5)}  max ${String(Math.max(...col(k))).padStart(5)}`);
}
console.log(`  packed tris median ${pct(out.map((r) => r.stats.tris), 0.5)}  p90 ${pct(out.map((r) => r.stats.tris), 0.9)}`);
console.log(`  cells held median ${pct(out.map((r) => r.stats.cells), 0.5)}`);
await browser.close();

#!/usr/bin/env node
/**
 * nightcost — GPU frame time on a sky-filling night view.
 *
 * The star block in Sky.js is guarded by `starVis > 0.002`, so nothing it costs
 * is visible to perf.mjs, which drives in daylight. This poses the one framing
 * where the field is nearly the whole screen and times the frames.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', 'http://localhost:5180');
const SEC = parseFloat(arg('seconds', '8'));

await acquire('nightcost');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, 0);
await page.evaluate(new Function('P', POSE_SRC), {
  v: { anchor: 'vista', height: 60, dist: 150, pitch: 0.62, fov: 70 }, frozen, dynamic: ['vehicle'],
});
await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(); });

const r = await page.evaluate(async (sec) => {
  const dt = [];
  let last = performance.now();
  const t0 = last;
  await new Promise((res) => {
    const step = () => {
      const n = performance.now();
      dt.push(n - last); last = n;
      if (n - t0 < sec * 1000) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  dt.shift(); dt.sort((a, b) => a - b);
  const q = (p) => dt[Math.min(dt.length - 1, Math.floor(p * dt.length))];
  return { n: dt.length, p50: q(0.5), p95: q(0.95) };
}, SEC);
console.log(`frames ${r.n}   p50 ${r.p50.toFixed(2)} ms   p95 ${r.p95.toFixed(2)} ms`);
await browser.close();

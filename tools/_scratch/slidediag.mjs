#!/usr/bin/env node
/**
 * slidediag — why does the camper move after a rescue that landed it on flat
 * ground? Traces the three seconds after a landing at ~60 Hz.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const URL = `${arg('url', 'http://localhost:5178')}?res=${arg('res', '640')}`;
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const release = await acquire('slidediag');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
// Immune to another author saving a file mid-run.
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
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => typeof window.__vehicleRescue === 'function', null, { timeout: 20000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  window.__tr = []; window.__trOn = false;
  const loop = () => {
    requestAnimationFrame(loop);
    if (!window.__trOn) return;
    const v = window.__vehicle;
    if (!v?.phys?.ready) return;
    const lv = v.phys.body.linvel();
    const p = v.position;
    window.__tr.push({
      t: performance.now(), x: p.x, y: p.y, z: p.z,
      vy: lv.y, vh: Math.hypot(lv.x, lv.z), up: v.up.y,
      g: window.__world.getHeight(p.x, p.z),
      pg: window.__vehicle.phys._patchHeight(p.x, p.z),
      wheels: v.wheels.filter((w) => w.grounded).length,
    });
  };
  requestAnimationFrame(loop);
});

const runs = [];
for (let i = 0; i < 24; i++) {
  const site = await page.evaluate(() => { window.__tr.length = 0; window.__trOn = true; return window.__vehicleRescue(true); });
  if (!site) { await page.waitForTimeout(200); continue; }
  await page.waitForTimeout(3000);
  const tr = await page.evaluate(() => { window.__trOn = false; return window.__tr; });
  if (!tr || tr.length < 10) continue;
  const t0 = tr[0].t;
  const first = tr[0], last = tr[tr.length - 1];
  // How far above the rendered ground did it start, and did it fall?
  const dropStart = first.y - first.g;
  const dPatch = first.g - first.pg;
  let peakVy = 0, peakVh = 0, tGrounded = NaN, bounce = 0;
  for (const s of tr) {
    if (Math.abs(s.vy) > Math.abs(peakVy)) peakVy = s.vy;
    peakVh = Math.max(peakVh, s.vh);
    if (Number.isNaN(tGrounded) && s.wheels >= 3) tGrounded = (s.t - t0) / 1000;
    if (s.wheels < 3) bounce += 1;
  }
  const slid = Math.hypot(last.x - first.x, last.z - first.z);
  runs.push({ slope: site.slope, dropStart, dPatch, peakVy, peakVh, tGrounded, bounceFrames: bounce, frames: tr.length, slid });
}

console.log('slope  startClear  render-collider  peakVy  peakVh  tGround  air/total  moved3s');
for (const r of runs) {
  console.log(`${f(r.slope, 2).padStart(5)}  ${f(r.dropStart, 2).padStart(10)}  ${f(r.dPatch, 3).padStart(15)}  ${f(r.peakVy, 2).padStart(6)}  ` +
    `${f(r.peakVh, 2).padStart(6)}  ${f(r.tGrounded, 2).padStart(7)}  ` +
    `${String(r.bounceFrames + '/' + r.frames).padStart(15)}  ${f(r.slid, 2).padStart(7)}`);
}
const med = (k) => { const a = runs.map((r) => r[k]).filter(Number.isFinite).sort((x, y) => x - y); return a[a.length >> 1]; };
console.log(`\nmedian: startClear ${f(med('dropStart'), 2)} m   render-collider ${f(med('dPatch'), 3)} m   peakVh ${f(med('peakVh'), 2)} m/s   moved ${f(med('slid'), 2)} m`);
console.log(`worst moved ${f(Math.max(...runs.map((r) => r.slid)), 2)} m`);

await browser.close();
release();

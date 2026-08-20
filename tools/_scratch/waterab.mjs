#!/usr/bin/env node
/**
 * Scratch: interleaved A/B of the frame cost of the Water system alone.
 *
 * dprtest measures the whole build, and three authors are editing the tree at
 * once, so a FAIL there cannot be attributed to anybody. This toggles
 * `Water.group.visible` inside ONE process, on a fixed cadence, and reports the
 * two populations separately — same GPU, same thermal state, same frame, so the
 * difference is the water and nothing else.
 *
 * Deliberately does NOT touch the working tree. Reverting a file to measure it
 * is how a peer's work gets destroyed.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1170'), 10);
const H = parseInt(arg('h', '870'), 10);
const DPR = parseFloat(arg('dpr', '2'));
const SECONDS = parseFloat(arg('seconds', '40'));
const PERIOD = parseFloat(arg('period', '1.5'));   // seconds per arm

await acquire('dprtest', { exclusive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

await page.evaluate(({ period }) => {
  const list = Array.isArray(window.__systems) ? window.__systems : Object.values(window.__systems || {});
  const water = list.find((s) => s?.name === 'Water');
  window.__ab = { on: [], off: [], water: !!water };
  let last = performance.now();
  const t0 = last;
  window.__engine.onLateUpdate(() => {
    const now = performance.now();
    const dt = now - last; last = now;
    const phase = Math.floor((now - t0) / (period * 1000)) % 2;
    if (water) water.group.visible = phase === 0;
    // Drop the first frame of each arm: the toggle itself costs a rebuild of
    // the render list and belongs to neither population.
    const local = ((now - t0) % (period * 1000)) / 1000;
    if (local > 0.25) (phase === 0 ? window.__ab.on : window.__ab.off).push(dt);
  });
  const input = window.__ctx?.input;
  if (input) {
    window.__drive = true;
    const tick = () => {
      if (!window.__drive) return;
      const t = (performance.now() - t0) / 1000;
      input.axes.throttle = 1;
      input.axes.steer = Math.sin(t * 0.42) * 0.7;
      requestAnimationFrame(tick);
    };
    tick();
  }
}, { period: PERIOD });

await page.waitForTimeout(SECONDS * 1000);
const out = await page.evaluate(() => {
  window.__drive = false;
  const list = Array.isArray(window.__systems) ? window.__systems : Object.values(window.__systems || {});
  const water = list.find((s) => s?.name === 'Water');
  if (water) water.group.visible = true;
  const stat = (a) => {
    const f = [...a].sort((x, y) => x - y);
    const p = (q) => +f[Math.min(f.length - 1, Math.floor(q * f.length))].toFixed(1);
    return { n: f.length, p50: p(0.5), p95: p(0.95), p99: p(0.99) };
  };
  return {
    foundWater: window.__ab.water,
    waterVisible: stat(window.__ab.on),
    waterHidden: stat(window.__ab.off),
    riverTriangles: water?.riverTriangles, lakeTriangles: water?.lakeTriangles,
  };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));

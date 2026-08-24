#!/usr/bin/env node
/**
 * Measure frame time at a real display's pixel ratio.
 *
 * Every capture in this project runs at deviceScaleFactor 1. A Retina Mac
 * reports devicePixelRatio 2, and the engine's quality caps can still ask for
 * far more pixels than a DPR-1 harness measures. Post
 * processing is fixed cost per pixel and was measured at 56-59% of the frame,
 * so this is the first thing to rule in or out when the player's frame rate and
 * the harness's disagree.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const W = parseInt(arg('w', '1728'), 10);
const H = parseInt(arg('h', '1000'), 10);
const DPR = parseFloat(arg('dpr', '2'));
// Bisecting a moving tree has failed twice on this project: authors commit while
// the measurement runs, so a number cannot be attributed to a commit. --port lets
// the gate target a git worktree checked out at a fixed commit, serving its own
// dev server, while the main tree keeps moving.
const PORT = arg('port', '5178');
const SECONDS = parseFloat(arg('seconds', '20'));
const QUALITY = arg('quality', null);
const SEED = arg('seed', '20261018');
const CAR = arg('car', 'camper');

// Exclusive: a timing run cannot share a GPU. See acquireExclusive in _lock.mjs.
await acquire('dprtest', { exclusive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

const q = QUALITY ? `&quality=${QUALITY}` : '';
await page.goto(
  `http://localhost:${PORT}/?res=1536&seed=${encodeURIComponent(SEED)}` +
  `&car=${encodeURIComponent(CAR)}${q}`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const info = await page.evaluate(() => {
  const r = window.__engine.renderer;
  const c = r.domElement;
  return {
    devicePixelRatio: window.devicePixelRatio,
    rendererPixelRatio: r.getPixelRatio(),
    cssSize: [c.clientWidth, c.clientHeight],
    drawingBuffer: [c.width, c.height],
    megapixels: +((c.width * c.height) / 1e6).toFixed(2),
    quality: window.__ctx?.quality,
  };
});

// Drive, and record frame times.
await page.evaluate((secs) => {
  const e = window.__engine;
  window.__dpr = { frames: [], t0: performance.now() };
  let last = performance.now();
  e.onLateUpdate(() => {
    const now = performance.now();
    window.__dpr.frames.push(now - last);
    last = now;
  });
  const input = window.__ctx?.input;
  if (input) {
    window.__drive = true;
    const tick = () => {
      if (!window.__drive) return;
      const t = (performance.now() - window.__dpr.t0) / 1000;
      input.axes.throttle = 1;
      input.axes.steer = Math.sin(t * 0.42) * 0.7;
      requestAnimationFrame(tick);
    };
    tick();
  }
  void secs;
}, SECONDS);

await page.waitForTimeout(SECONDS * 1000);
const stats = await page.evaluate(() => {
  window.__drive = false;
  const all = window.__dpr.frames.slice(40);
  const f = [...all].sort((a, b) => a - b);
  const pct = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
  // Last third, i.e. after adaptive resolution has had time to settle.
  const tail = all.slice(Math.floor(all.length * 0.66)).sort((a, b) => a - b);
  const tp = (p) => tail[Math.min(tail.length - 1, Math.floor(p * tail.length))];
  return {
    frames: f.length,
    p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), fps50: +(1000 / pct(0.5)).toFixed(1),
    settled_p50: +tp(0.5).toFixed(1), settled_fps: +(1000 / tp(0.5)).toFixed(1),
    resolution: window.__resolution ? window.__resolution() : null,
  };
});
await browser.close();

const report = { viewport: [W, H], requestedDPR: DPR, ...info, ...stats };
console.log(JSON.stringify(report, null, 1));

// ── budget gate ────────────────────────────────────────────────────────────
// The player ran at 4 fps for a day while every harness here reported 45+,
// because none of them measured a Retina display. This is the configuration
// that matters, so it is the one with a pass/fail.
const BUDGET = { settledFps: 50, p95Ms: 45, minEffectiveRatio: 0.90 };
const fails = [];
if (stats.settled_fps < BUDGET.settledFps)
  fails.push(`settled ${stats.settled_fps} fps < ${BUDGET.settledFps}`);
if (stats.p95 > BUDGET.p95Ms)
  fails.push(`p95 ${stats.p95} ms > ${BUDGET.p95Ms} — hitching is what a player feels`);
if (stats.resolution && stats.resolution.effective < BUDGET.minEffectiveRatio - 1e-6)
  fails.push(`effective pixel ratio ${stats.resolution.effective} is below the ${BUDGET.minEffectiveRatio.toFixed(2)} quality floor`);

if (process.argv.includes('--gate')) {
  if (fails.length) {
    console.error('\nFAIL');
    for (const f of fails) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('\nPASS — within the player-configuration budget');
}

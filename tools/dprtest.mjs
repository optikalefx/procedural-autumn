#!/usr/bin/env node
/**
 * Measure frame time at a real display's pixel ratio.
 *
 * Every capture in this project runs at deviceScaleFactor 1. A Retina Mac
 * reports devicePixelRatio 2, and the engine's ultra preset caps at 2.0 — so the
 * player renders FOUR TIMES the pixels the harness ever measures. Post
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
const SECONDS = parseFloat(arg('seconds', '20'));
const QUALITY = arg('quality', null);

await acquire('dprtest');
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
await page.goto(`http://localhost:5178/?res=1536${q}`, { waitUntil: 'domcontentloaded' });
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
  const f = window.__dpr.frames.slice(40).sort((a, b) => a - b);
  const pct = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))];
  return { frames: f.length, p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), fps50: +(1000 / pct(0.5)).toFixed(1) };
});
await browser.close();

console.log(JSON.stringify({ viewport: [W, H], requestedDPR: DPR, ...info, ...stats }, null, 1));

#!/usr/bin/env node
/**
 * Does pitching a camp hitch?
 *
 * There are two suspects and one of them is structural. The fire adds a
 * PointLight, and this scene has none — so three's NUM_POINT_LIGHTS define
 * goes 0 -> 1 and EVERY lit material in the world has to relink. That is the
 * same class of stall the tree author hit with occlusion (see the note about
 * gating a compile behind a trunk crossing in front of the camper), and it
 * would land at the exact moment the player is being shown something new.
 *
 * The second is the build itself: seven props of merged geometry, a dirt mesh
 * that samples the heightfield on a 48x48 grid, and the layout solver.
 *
 * Measures per-frame times across the pitch and reports the worst frames.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
// A system that throws is disabled by main.js and then measures beautifully,
// because it is no longer doing anything. Fail loudly instead.
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
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
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2500);

const r = await page.evaluate(async () => {
  const camp = window.__camp, v = window.__systems.vehicle, e = window.__engine;
  const frames = [];
  let last = performance.now();
  let pitchFrame = -1, programsBefore = 0, programsAfter = 0;
  const progCount = () => e.renderer.info.programs?.length ?? -1;

  const spin = (n) => new Promise((res) => {
    let i = 0;
    const tick = () => {
      const now = performance.now();
      frames.push(+(now - last).toFixed(2));
      last = now;
      if (++i >= n) res(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  camp.strike();
  await spin(60);                       // settle
  const baseline = frames.slice(20).sort((a, b) => a - b);
  const p50 = baseline[Math.floor(baseline.length / 2)];

  programsBefore = progCount();
  pitchFrame = frames.length;
  const t0 = performance.now();
  const site = camp.pitchNear(v.position.x, v.position.z, { instant: false, radius: 14 });
  const buildMs = performance.now() - t0;
  await spin(140);                      // through the raise
  programsAfter = progCount();

  const after = frames.slice(pitchFrame);
  const worst = after.slice().sort((a, b) => b - a).slice(0, 6);
  return {
    site: !!site, buildMs: +buildMs.toFixed(1),
    baselineP50: p50,
    worstAfterPitch: worst,
    firstSixAfterPitch: after.slice(0, 6),
    programsBefore, programsAfter,
    pointLights: e.scene.children.filter((o) => o.isPointLight).length,
  };
});
console.log(JSON.stringify(r, null, 1));
const real = errs.filter((e) => !/GL_INVALID|deprecated|cached bake/.test(e));
if (real.length) { console.log('PAGE ERRORS — the numbers above are not trustworthy:'); for (const e of real.slice(0, 5)) console.log('  ', e); }
const alive = await page.evaluate(() => ({ enabled: window.__camp?.enabled, props: window.__camp?.props?.length ?? -1 }));
console.log('camp still enabled:', JSON.stringify(alive));
await browser.close();

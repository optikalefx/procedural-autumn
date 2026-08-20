#!/usr/bin/env node
/**
 * Does the camp fire actually make a sound, and is it the right size?
 *
 * Measures the ambience bus with and without a camp, at three distances, and
 * counts the crackles. A fire layer that throws no exception and produces
 * silence is the failure mode this catches; so is one that is louder than the
 * rest of the valley put together.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('C:', m.text().slice(0, 400)); });
// Six peers are saving files all round; a Vite reload in the middle of a
// twelve-second measurement destroys the execution context and every number
// in it. Same stub audiotest.mjs uses.
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
// Audio only builds on a real *trusted* gesture. A synthetic click through
// CDP is trusted; a keypress is what audiotest.mjs uses and is known to work.
await page.keyboard.press('KeyM');
await page.waitForTimeout(900);
await page.evaluate(() => window.__audio?.setMuted(false));   // KeyM is also mute
console.log('audio:', JSON.stringify(await page.evaluate(() => ({
  exists: !!window.__audio, started: window.__audio?.started, failed: window.__audio?.failed,
  dbg: window.__audio?.debugState?.() ?? null, camp: !!window.__audio?.camp,
}))).slice(0, 900));
await page.waitForFunction(() => window.__audio?.started === true, null, { timeout: 20000 });
await page.waitForTimeout(600);

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2200);

/**
 * Measure the ambience bus at ONE camera position, with the fire lit and with
 * it struck. Comparing different positions is meaningless — the wind bed and
 * the water are functions of where you stand, and they swamp the fire.
 */
const at = (dist) => page.evaluate(async (dist) => {
  const A = window.__audio, camp = window.__camp, v = window.__systems.vehicle;
  camp.strike();
  const site = camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  if (!site) return null;
  const c = window.__engine.camera;
  window.__forceCamera = true;
  const place = () => {
    c.position.set(site.x + dist, site.y + 1.6, site.z);
    c.lookAt(site.x, site.y + 0.4, site.z);
    c.updateMatrixWorld(true);
  };
  const run = async (ms) => {
    let peak = 0, rms = 0, n = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      place();
      await new Promise(requestAnimationFrame);
      const m = A.measure('camp');
      if (m) { if (m.peak > peak) peak = m.peak; rms += m.rms; n++; }
    }
    return { peak, rms: n ? rms / n : 0 };
  };
  place();
  await new Promise((r) => setTimeout(r, 900));      // let the level settle
  const c0 = A.camp.state.crackles;
  const lit = await run(6000);
  const crackles = A.camp.state.crackles - c0;
  const level = A.camp.state.level;
  camp.strike();
  await new Promise((r) => setTimeout(r, 1400));     // let the level fall away
  const dark = await run(6000);
  return { dist, level: +level.toFixed(3), crackles,
    litRms: +lit.rms.toFixed(5), darkRms: +dark.rms.toFixed(5),
    litPeak: +lit.peak.toFixed(4), darkPeak: +dark.peak.toFixed(4),
    dB: +(20 * Math.log10(lit.rms / Math.max(dark.rms, 1e-9))).toFixed(2) };
}, dist);

for (const d of [2.5, 8, 16]) console.log(JSON.stringify(await at(d)));
await browser.close();

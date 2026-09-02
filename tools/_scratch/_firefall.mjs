#!/usr/bin/env node
/**
 * The two things a recording that replaces a synthesised layer has to prove.
 *
 *   1. **A missing asset is a worse fire, not a silent one.** The request for
 *      `/audio/campfire.mp3` is aborted at the network, which is the same thing
 *      a 404 or a dropped deploy looks like from inside the page, and the fire
 *      is then measured on its own tap. It has to sound.
 *   2. **Nothing clips.** The master peak with the listener sitting in the fire
 *      at the loudest hour the mix has.
 *
 *   node tools/_scratch/_firefall.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
const warnings = [];
page.on('console', (m) => { if (/camp:audio|audio\]/.test(m.text())) warnings.push(m.text().slice(0, 160)); });
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite/i.test(String(protocols))) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
// The asset, gone.
await page.route('**/audio/campfire.mp3', (r) => r.fulfill({ status: 404, body: 'gone' }));

await page.goto('http://localhost:5178?res=768&car=camper', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('KeyM');
await page.waitForTimeout(900);
await page.evaluate(() => window.__audio?.setMuted(false));
await page.waitForFunction(() => window.__audio?.started === true, null, { timeout: 20000 });
await page.evaluate(async () => { await window.__audio.camp.loadSamples(); });

const state = await page.evaluate(() => ({
  fire: window.__audio.camp._fire === null ? 'null (as it must be)' : 'DECODED — the 404 did not take',
  voices: window.__audio.camp._fireSrc.length,
  sampled: window.__audio.camp._sampled(),
}));
console.log('after a 404:', JSON.stringify(state));
console.log('console said:', warnings.length ? warnings[0] : '(nothing — it should have warned)');

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2200);

const r = await page.evaluate(async () => {
  const A = window.__audio, camp = window.__camp, v = window.__systems.vehicle, c = window.__engine.camera;
  const site = camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  window.__forceCamera = true;
  const place = () => {
    c.position.set(site.x + 1.6, site.y + 1.4, site.z);
    c.lookAt(site.x, site.y + 0.4, site.z);
    c.updateMatrixWorld(true);
  };
  place();
  await new Promise((res) => setTimeout(res, 1500));
  const c0 = A.camp.state.crackles;
  let camp_p = 0, camp_r = 0, m_p = 0, m_r = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 9000) {
    place();
    await new Promise(requestAnimationFrame);
    const a = A.measure('camp'), b = A.measure('master');
    if (a) { camp_p = Math.max(camp_p, a.peak); camp_r += a.rms; }
    if (b) { m_p = Math.max(m_p, b.peak); m_r += b.rms; }
    n++;
  }
  return { crackles: A.camp.state.crackles - c0, level: +A.camp.state.level.toFixed(3),
    campPeak: +camp_p.toFixed(4), campRms: +(camp_r / n).toFixed(5),
    masterPeak: +m_p.toFixed(4), masterRms: +(m_r / n).toFixed(5) };
});
console.log('fallback fire, listener 1.6 m from the flames:', JSON.stringify(r));

// And now the same seat WITH the recording, for the master headroom row.
await page.unroute('**/audio/campfire.mp3');
const r2 = await page.evaluate(async () => {
  const A = window.__audio;
  A.camp._sampleLoad = null; A.camp._fire = null; A.camp._fireSrc = [];
  await A.camp.loadSamples();
  await new Promise((res) => setTimeout(res, 1800));
  let camp_p = 0, camp_r = 0, m_p = 0, m_r = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 9000) {
    await new Promise(requestAnimationFrame);
    const a = A.measure('camp'), b = A.measure('master');
    if (a) { camp_p = Math.max(camp_p, a.peak); camp_r += a.rms; }
    if (b) { m_p = Math.max(m_p, b.peak); m_r += b.rms; }
    n++;
  }
  return { sampled: A.camp._sampled(), voices: A.camp._fireSrc.length,
    campPeak: +camp_p.toFixed(4), campRms: +(camp_r / n).toFixed(5),
    masterPeak: +m_p.toFixed(4), masterRms: +(m_r / n).toFixed(5) };
});
console.log('the recording, same seat:                   ', JSON.stringify(r2));
await browser.close();

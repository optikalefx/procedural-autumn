#!/usr/bin/env node
/** Does the new splashPatch route actually change the triggered one-shot? */
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
// Same HMR shim the real check tool uses: a peer saving a file mid-run
// reloads the page and destroys the execution context.
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
await page.goto('http://127.0.0.1:5178/sound.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__lab, null, { timeout: 20000 });
await page.click('#start');
await page.waitForTimeout(400);

const out = await page.evaluate(async () => {
  const lab = window.__lab;
  lab.select('vehicle.splash');
  await new Promise((r) => setTimeout(r, 150));
  const veh = window.__soundlab.audio.vehicle;

  const run = async (hz) => {
    lab.setParam('splashHz', hz);
    const patched = JSON.parse(JSON.stringify(veh.splashPatch ?? {}));
    window.__soundlab_meterReset?.();
    document.querySelector('#meterReset').click();
    await new Promise((r) => setTimeout(r, 60));
    lab.trigger();
    await new Promise((r) => setTimeout(r, 800));
    const st = lab.stats() ?? {};
    return { hz, patched, peakDb: +(20 * Math.log10(st.hold ?? 0)).toFixed(1),
             centroidHz: Math.round(st.centroid ?? 0), dBA: +(st.dBA ?? 0).toFixed(1) };
  };

  const lo = await run(400);
  await new Promise((r) => setTimeout(r, 500));
  const hi = await run(2800);
  return { lo, hi };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();

#!/usr/bin/env node
/**
 * Does the fire tick?
 *
 * `campfire.mp3` is 1.11 s long, so anything that plays it as one plain loop
 * repeats a level step and a two-crackle figure at 0.9 Hz. This measures that
 * directly: 20 s of the camp tap sampled every frame, then the autocorrelation
 * of the ENVELOPE at the loop period. A tick shows up as a spike at 1.110 s
 * (and at its multiples) and nowhere else.
 *
 *   node tools/_scratch/_fireloop.mjs
 *
 * Three configurations, in one page load so they share a mix and a listener:
 *   one    a single voice at rate 1 — what a naive `loop = true` sounds like
 *   two    the shipped pair, rates 1.0 / 0.87, started half a buffer apart
 *   synth  the fallback, which has no loop and is the floor for "not periodic"
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
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
await page.goto('http://localhost:5178?res=768&car=camper', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('KeyM');
await page.waitForTimeout(900);
await page.evaluate(() => window.__audio?.setMuted(false));
await page.waitForFunction(() => window.__audio?.started === true, null, { timeout: 20000 });
await page.evaluate(async () => { await window.__audio.camp.loadSamples(); });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(2200);
await page.evaluate(() => {
  const camp = window.__camp, v = window.__systems.vehicle;
  window.__site = camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  window.__forceCamera = true;
});

const trace = (mode) => page.evaluate(async (mode) => {
  const A = window.__audio, C = A.camp, site = window.__site, c = window.__engine.camera;
  C._noSample = mode === 'synth';
  // Rebuild the voices for the "one" case: stop what is running and start a
  // single rate-1 loop, which is the configuration this probe exists to reject.
  if (mode !== 'synth' && C._fire) {
    for (const s of C._fireSrc) { try { s.stop(); } catch {} try { s.disconnect(); } catch {} }
    C._fireSrc = [];
    const rates = mode === 'one' ? [1.0] : [1.0, 0.87];
    const offs = mode === 'one' ? [0.0] : [0.0, 0.5];
    for (let i = 0; i < rates.length; i++) {
      const s = A.actx.createBufferSource();
      s.buffer = C._fire; s.loop = true; s.playbackRate.value = rates[i];
      s.connect(C.fireLp); s.start(A.actx.currentTime, offs[i] * C._fire.duration);
      C._fireSrc.push(s);
    }
  }
  const place = () => {
    c.position.set(site.x + 2.5, site.y + 1.6, site.z);
    c.lookAt(site.x, site.y + 0.4, site.z);
    c.updateMatrixWorld(true);
  };
  place();
  await new Promise((r) => setTimeout(r, 1500));
  const env = [], t = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    place();
    await new Promise(requestAnimationFrame);
    // A short window — 4096 samples, 85 ms — so the envelope can actually see
    // a crackle. The tap's full 16384 is a third of a second and would smear
    // the very figure this is looking for.
    const m = A.measure('camp', 4096);
    if (m) { env.push(m.rms); t.push((performance.now() - t0) / 1000); }
  }
  return { env, t };
}, mode);

/** Circular autocorrelation of an unevenly-sampled envelope, resampled to 200 Hz. */
function acf(env, t, lags) {
  const SR = 200, N = Math.floor(t[t.length - 1] * SR);
  const y = new Float64Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const tt = i / SR;
    while (j < t.length - 2 && t[j + 1] < tt) j++;
    y[i] = env[j];
  }
  const mean = y.reduce((a, b) => a + b, 0) / N;
  const d = Array.from(y, (v) => v - mean);
  const norm = d.reduce((a, b) => a + b * b, 0);
  return lags.map((L) => {
    const k = Math.round(L * SR);
    let s = 0;
    for (let i = 0; i + k < N; i++) s += d[i] * d[i + k];
    return s / norm * (N / (N - k));
  });
}

const LAGS = [1.110, 2.220, 3.330, 1.276, 0.700, 1.900];
console.log('\nenvelope autocorrelation (r at lag, higher = more periodic)');
console.log('mode     1.110s   2.220s   3.330s  |  1.276s   0.700s   1.900s');
for (const mode of ['one', 'two', 'synth']) {
  const { env, t } = await trace(mode);
  const r = acf(env, t, LAGS);
  console.log(`${mode.padEnd(6)}  ${r.map((v) => v.toFixed(3).padStart(7)).join('  ').replace(/(\s+\S+\s+\S+\s+\S+)/, '$1  |')}`);
}
await browser.close();

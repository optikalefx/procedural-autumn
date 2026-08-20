#!/usr/bin/env node
/**
 * Is the ambience level set by its model, or by the LFOs wired into its gains?
 *
 * `AudioParam.value` reports only the *intrinsic* value — the part set by
 * `setTargetAtTime`. Anything connected into the param sums on top of it at
 * audio rate and is invisible to that getter, so reading the gain cannot tell
 * you what the gain is. This settles it by experiment instead: freeze the
 * model's contribution at zero and listen to what is left.
 *
 * If the bus falls silent, the LFOs are a modulation of the model.
 * If the bus keeps playing, the LFOs *are* the level and the model is a trim.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const release = await acquire('lfoprobe');
const b = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (pr === 'vite-hmr' || String(pr).includes('vite')) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
});
await p.goto('http://localhost:5178/?res=512', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await p.keyboard.press('KeyM');
await p.waitForTimeout(500);
await p.evaluate(() => window.__audio.setMuted(false));
await p.evaluate(() => {
  window.__lighting.hour = 13.0; window.__lighting.cycleSpeed = 0;
  const q = window.__poi.best('meadow');
  window.__vehicleTeleport?.(q.x, q.z, 0);
});
await p.waitForTimeout(2500);

const dB = (v) => (v > 1e-7 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
const watch = (ms) => p.evaluate((t) => new Promise((res) => {
  let lo = 1e9, hi = 0, sum = 0, n = 0;
  const t0 = performance.now();
  const tick = () => {
    const m = window.__audio.measure('ambience');
    if (m) { if (m.rms < lo) lo = m.rms; if (m.rms > hi) hi = m.rms; sum += m.rms; n++; }
    if (performance.now() - t0 < t) requestAnimationFrame(tick);
    else res({ lo, hi, mean: sum / n, n });
  };
  requestAnimationFrame(tick);
}), ms);

// A full cycle of the slowest gain LFO in the bed is ~35 s (0.029 Hz).
console.log('baseline, model driving the gains as normal …');
const base = await watch(45000);
console.log(`  ambience rms  min ${dB(base.lo)}  mean ${dB(base.mean)}  max ${dB(base.hi)} dBFS`);

console.log('\nfreezing every ambience gain\'s intrinsic value at 0 …');
await p.evaluate(() => {
  const a = window.__audio.ambience;
  a.update = () => {};                       // stop the model rewriting them
  const t = window.__audio.actx.currentTime;
  for (const g of [a.grassGain, a.coniferGain, a.hushGain, a.cricketGain]) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0, t);
  }
});
await p.waitForTimeout(1500);
const muted = await watch(45000);
console.log(`  ambience rms  min ${dB(muted.lo)}  mean ${dB(muted.hi === 0 ? 0 : muted.mean)}  max ${dB(muted.hi)} dBFS`);
console.log(`\n  → with the model at zero the bed is ${(20 * Math.log10(Math.max(muted.mean, 1e-9) / Math.max(base.mean, 1e-9))).toFixed(1)} dB ` +
            'relative to baseline.');
console.log('    Near 0 dB means the LFOs are the level. Far below means the model is.');

await b.close();
release();

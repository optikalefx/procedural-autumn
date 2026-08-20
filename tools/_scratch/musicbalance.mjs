#!/usr/bin/env node
/**
 * Where does the music bed sit against the world, and does the duck do anything?
 *
 *   node tools/_scratch/musicbalance.mjs
 *
 * Three questions, all answered by experiment rather than by reading the graph:
 *
 *  1. **The boom.** The listener is sampled from `ctx.camera`, and the chase
 *     camera is not where the player is. N1 measured it at 9-11 m behind and
 *     5-9 m above the camper and named audio falloff as a system that may be
 *     out by that much. This reports the offset under real driving.
 *
 *  2. **Does the duck reach the mix?** The bed is supposed to drop to 35 %
 *     while a generative phrase sounds. Comparing the music bus with a phrase
 *     against without cannot answer that, because the phrase itself is on the
 *     same bus and raises it either way. So this forces the duck gain to zero
 *     instead: if the node is in the signal path the bed must disappear, and if
 *     the level does not move the node is a dead end. Same shape of experiment
 *     as `lfoprobe.mjs`, for the same reason — you cannot read a routing bug
 *     off a parameter value.
 *
 *  3. **The balance.** Bed against ambience, parked, with the bed playing.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const release = await acquire('musicbalance');
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

const dB = (v) => (v > 1e-7 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
const meter = (bus, ms) => p.evaluate(({ bs, t }) => new Promise((res) => {
  let peak = 0, sum = 0, n = 0;
  const t0 = performance.now();
  const tick = () => {
    const m = window.__audio.measure(bs);
    if (m) { if (m.peak > peak) peak = m.peak; sum += m.rms; n++; }
    if (performance.now() - t0 < t) requestAnimationFrame(tick);
    else res({ peak, rms: n ? sum / n : 0 });
  };
  requestAnimationFrame(tick);
}), { bs: bus, t: ms });

// ── 1. the boom ────────────────────────────────────────────────────────────
await p.evaluate(() => {
  window.__lighting.hour = 13.0; window.__lighting.cycleSpeed = 0;
  const q = window.__poi.best('meadow');
  window.__vehicleTeleport?.(q.x, q.z, 0);
});
await p.waitForTimeout(1500);
await p.keyboard.down('KeyW');
await p.waitForTimeout(3500);
const boom = await p.evaluate(() => new Promise((res) => {
  // `window.__audio.L` is literally the listener the audio system built this
  // frame, so this compares what audio believes against where the camper is —
  // no guessing about which camera object the rig drives.
  const s = [];
  const t0 = performance.now();
  const tick = () => {
    const L = window.__audio.L;
    const v = window.__vehicleState();
    if (v && Number.isFinite(v.x)) {
      s.push({ back: Math.hypot(L.x - v.x, L.z - v.z), up: L.y - v.y,
               d: Math.hypot(L.x - v.x, L.y - v.y, L.z - v.z) });
    }
    if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
    else {
      const f = (k) => { const a = s.map((o) => o[k]).sort((x, y) => x - y);
                         return { lo: a[0], mid: a[a.length >> 1], hi: a[a.length - 1] }; };
      res(s.length ? { back: f('back'), up: f('up'), d: f('d'), n: s.length }
                   : { err: 'no samples' });
    }
  };
  requestAnimationFrame(tick);
}));
await p.keyboard.up('KeyW');
const q3 = (o) => `${o.lo.toFixed(1)} … ${o.mid.toFixed(1)} … ${o.hi.toFixed(1)} m`;
console.log('── 1. listener offset from the camper, while driving ──');
console.log(`  horizontal behind : ${q3(boom.back)}`);
console.log(`  vertical above    : ${q3(boom.up)}`);
console.log(`  slant range       : ${q3(boom.d)}   (${boom.n} samples)`);
console.log('  Every audio distance model measures from here, not from the camper.');

// ── 2. does the duck reach the mix? ────────────────────────────────────────
await p.evaluate(() => {
  const q = window.__poi.best('meadow');
  window.__vehicleTeleport?.(q.x, q.z, 0);
  // Force the bed on and hold it there, so the play/rest cycle cannot end the
  // stretch in the middle of the comparison.
  const s = window.__audio.soundtrack;
  s._t = 0; s._until = 1e6;
  if (!s.playing) s._start();
  // Silence the generative layer for the duration. It shares the music bus, so
  // a phrase firing inside either measurement window moves the number by more
  // than the effect being measured — which is exactly what happened on the
  // first run of this probe.
  const m = window.__audio.music;
  m.update = () => {}; m._queue.length = 0;
});
await p.waitForTimeout(8000);                       // clear the 6 s fade-in
console.log('\n── 2. is the duck node in the signal path? ──');
const bedOn = await meter('music', 6000);
console.log(`  bed playing, duck at 1.0 : rms ${dB(bedOn.rms)}  peak ${dB(bedOn.peak)} dBFS`);
const forced = await p.evaluate(() => {
  const s = window.__audio.soundtrack;
  s.update = () => {};                              // stop it rewriting the duck
  s.duck.gain.cancelScheduledValues(window.__audio.actx.currentTime);
  s.duck.gain.setValueAtTime(0, window.__audio.actx.currentTime);
  return { duckValue: s.duck.gain.value, outValue: s.out.gain.value, level: s.level };
});
await p.waitForTimeout(1500);
const bedCut = await meter('music', 6000);
console.log(`  duck forced to 0.0       : rms ${dB(bedCut.rms)}  peak ${dB(bedCut.peak)} dBFS`);
const delta = 20 * Math.log10(Math.max(bedCut.rms, 1e-9) / Math.max(bedOn.rms, 1e-9));
console.log(`  → ${delta.toFixed(1)} dB. Near 0 means the duck node is a dead end and the`);
console.log('    bed reaches the bus around it; a large drop means it is wired in.');
console.log(`  (duck.gain=${forced.duckValue}  out.gain=${forced.outValue.toFixed(3)}  level=${forced.level})`);

// ── 3. the balance, unducked and ducked ────────────────────────────────────
// The generative layer stays stubbed for all three windows: it shares the music
// bus, so a phrase firing inside one of them would move the number by more than
// the effect being measured.
await p.evaluate(() => {
  const a = window.__audio;
  a.soundtrack.duck.gain.cancelScheduledValues(a.actx.currentTime);
  a.soundtrack.duck.gain.setValueAtTime(1, a.actx.currentTime);
});
await p.waitForTimeout(2500);
console.log('\n── 3. bed against world, parked in open meadow ──');
const open = await meter('music', 9000);
// Hold the duck down the way a sounding phrase would. `Audio.update` reads
// `music.state.since < 9`, and music.update is stubbed, so this pins it.
await p.evaluate(() => {
  window.__audio.music.state.since = 0;
  window.__audio.soundtrack.update = Object.getPrototypeOf(window.__audio.soundtrack).update;
});
await p.waitForTimeout(3000);
const ducked = await meter('music', 9000);
const amb = await meter('ambience', 30000);       // long enough to cross a gust
console.log(`  bed, no phrase   rms ${dB(open.rms)}  peak ${dB(open.peak)}`);
console.log(`  bed, ducked      rms ${dB(ducked.rms)}  peak ${dB(ducked.peak)}`);
console.log(`  ambience (30 s)  rms ${dB(amb.rms)}  peak ${dB(amb.peak)}`);
console.log(`  → duck depth          ${(20 * Math.log10(ducked.rms / Math.max(open.rms, 1e-9))).toFixed(1)} dB`);
console.log(`  → bed over world      ${(20 * Math.log10(open.rms / Math.max(amb.rms, 1e-9))).toFixed(1)} dB`);
console.log(`  → ducked bed over world ${(20 * Math.log10(ducked.rms / Math.max(amb.rms, 1e-9))).toFixed(1)} dB`);
console.log('    The last line is the one that matters: below zero means a phrase');
console.log('    drops the bed under the valley, which is a hole rather than a duck.');

await b.close();
release();

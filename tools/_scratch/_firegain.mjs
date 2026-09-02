#!/usr/bin/env node
/**
 * The fire's synthesised bed and `public/audio/campfire.mp3`, rendered in ONE
 * OfflineAudioContext so the two are on one scale.
 *
 *   node tools/_scratch/_firegain.mjs
 *   node tools/_scratch/_firegain.mjs --gain 0.5
 *
 * Why a browser: `decodeAudioData` is the only mp3 decoder in the toolchain,
 * and the bed is a WebAudio graph. Rebuilding the bed here rather than driving
 * `CampAudio.update` is deliberate — an OfflineAudioContext's clock does not
 * advance between calls, so every `setTargetAtTime` in `update` would land at
 * t=0. What is measured is the bed's STEADY STATE at level 1 (the listener
 * inside NEAR), which is the loudest the fire is ever allowed to be.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const base = arg('base', 'http://localhost:5178');
const tryGain = Number(arg('gain', 1));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (/vite/i.test(String(protocols)) || /[?&]token=|vite-hmr/.test(String(url))) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 });

const out = await page.evaluate(async ({ tryGain }) => {
  const { noiseBuffer, noiseSource, filter, gain } = await import('/src/audio/synth.js');
  const SR = 48000, DUR = 6;

  const stats = (b) => {
    const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
    let pk = 0, s2 = 0, n = L.length;
    const M = new Float32Array(n);
    for (let i = 0; i < n; i++) { M[i] = (L[i] + R[i]) / 2; pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); s2 += M[i] * M[i]; }
    const rms = Math.sqrt(s2 / n);
    // band energies, 1024-point Goertzel-free: cheap cascaded one-poles
    const lp = (x, fc) => { const dt = 1 / SR, rc = 1 / (2 * Math.PI * fc), a = dt / (rc + dt);
      const y = new Float32Array(x.length); let p = 0; for (let i = 0; i < x.length; i++) { p += a * (x[i] - p); y[i] = p; } return y; };
    const hp = (x, fc) => { const dt = 1 / SR, rc = 1 / (2 * Math.PI * fc), a = rc / (rc + dt);
      const y = new Float32Array(x.length); let py = 0, px = 0; for (let i = 0; i < x.length; i++) { y[i] = a * (py + x[i] - px); py = y[i]; px = x[i]; } return y; };
    const r = (x) => { let t = 0; for (let i = 0; i < x.length; i++) t += x[i] * x[i]; return Math.sqrt(t / x.length); };
    const lo = r(lp(lp(M, 160), 160)), mid = r(hp(hp(lp(lp(M, 2000), 2000), 160), 160)), hi = r(hp(hp(M, 4000), 4000));
    return { peak: pk, rms, lo, mid, hi };
  };

  // ── the bed, steady state at level 1 ────────────────────────────────────
  const bedCtx = new OfflineAudioContext(2, SR * DUR, SR);
  {
    const noise = noiseBuffer(bedCtx, 3, 'pink', 0x77c1);
    const src = noiseSource(bedCtx, noise, 1);
    const bp = filter(bedCtx, 'bandpass', 780, 0.55);      // level 1 → 780 Hz
    const low = filter(bedCtx, 'lowpass', 240, 0.7);
    const g = gain(bedCtx, 0.055 * 0.82);                   // level 1 × mean breath
    const lowG = gain(bedCtx, 0.55);
    src.connect(bp).connect(g);
    src.connect(low).connect(lowG).connect(g);
    g.connect(bedCtx.destination);
  }
  const bed = stats(await bedCtx.startRendering());

  // ── the recording, at gain 1 and at the trial gain ──────────────────────
  const bytes = await (await fetch('/audio/campfire.mp3')).arrayBuffer();
  const decCtx = new OfflineAudioContext(2, SR, SR);
  const buf = await decCtx.decodeAudioData(bytes);
  const mk = async (gv) => {
    const c = new OfflineAudioContext(2, Math.round(SR * DUR), SR);
    const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
    const g = gain(c, gv); s.connect(g).connect(c.destination); s.start(0);
    return stats(await c.startRendering());
  };
  const raw = await mk(1), trial = await mk(tryGain);

  return {
    decoded: { dur: buf.duration, frames: buf.length, ch: buf.numberOfChannels, sr: buf.sampleRate },
    bed, raw, trial, tryGain,
    match: { rms: bed.rms / raw.rms, lo: bed.lo / raw.lo, mid: bed.mid / raw.mid, hi: bed.hi / raw.hi },
  };
}, { tryGain });

await browser.close();
const f = (n, d = 5) => Number(n).toFixed(d);
console.log(`decoded in browser: ${out.decoded.dur.toFixed(6)} s  ${out.decoded.frames} frames  ${out.decoded.ch}ch @${out.decoded.sr}`);
console.log('\n                 peak      rms       <160Hz    160-2k    >4k');
for (const [n, s] of [['synth bed  ', out.bed], ['campfire x1', out.raw], [`campfire x${out.tryGain}`, out.trial]])
  console.log(`${n}   ${f(s.peak, 4)}   ${f(s.rms)}   ${f(s.lo)}   ${f(s.mid)}   ${f(s.hi)}`);
console.log('\ngain that matches the bed on each column:');
for (const [k, v] of Object.entries(out.match)) console.log(`  ${k.padEnd(4)} ${f(v, 3)}`);

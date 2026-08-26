#!/usr/bin/env node
/**
 * The journal's four voices, rendered offline and measured the way
 * `src/audio/journal_audio.js`'s header defines the columns — plus the one
 * asset in the layer, `public/audio/page.mp3`, measured in exactly the same
 * pass so the ladder can be read across both.
 *
 *   node tools/_scratch/_jaudio.mjs
 *   node tools/_scratch/_jaudio.mjs --gain 0.42     # try a trim for the mp3
 *
 * Definitions, copied from that header rather than re-invented — a column with
 * no definition is not a measurement:
 *
 *   · peak      max |sample| over BOTH channels of the whole render
 *   · mono      (L + R) / 2, which is what the small-speaker block quotes
 *   · window    first to last sample whose mono clears 0.0015 (~ -56 dBFS)
 *   · rms       over THAT window, not over the buffer
 *   · hp200     mono peak through a 4th-order 200 Hz high-pass, i.e. TWO
 *               cascaded Q-0.707 RBJ biquads, 24 dB/oct. The header is
 *               emphatic that the order has to be quoted with the number.
 *
 * The first firing on a fresh `JournalAudio` is the reproducible draw (the rng
 * is `mulberry32(0x7a9e13)` and always starts there), so each voice gets its
 * own fresh instance — which is what makes these numbers comparable to the
 * ones already written down.
 *
 * Why a browser at all: `OfflineAudioContext` and `decodeAudioData` are the
 * only mp3 decoder in the toolchain, and rendering the synthesised voices in
 * the SAME context is the only way the two are on one scale.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const base = arg('base', 'http://127.0.0.1:5199');
const tryGain = arg('gain', null);

await acquire('jaudio');
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
// Vite's HMR client, neutered before any page script runs. Without it a peer
// saving a file — or this author saving the very module under test — reloads
// the page mid-run and every measurement dies with "Execution context was
// destroyed". Lifted from tools/shot.mjs, same as _jcritic.mjs.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return {
        readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
      };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120_000 });

const rows = await page.evaluate(async ({ tryGain }) => {
  const mod = await import('/src/audio/journal_audio.js');
  const SR = 48000;

  // ── the measurements ──────────────────────────────────────────────────────
  const measure = (buf) => {
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const n = buf.length;
    const mono = new Float32Array(n);
    let peak = 0, mpeak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
      const m = (L[i] + R[i]) * 0.5;
      mono[i] = m;
      const am = Math.abs(m);
      if (am > mpeak) mpeak = am;
    }
    // Window: first to last sample clearing the stated threshold.
    const TH = 0.0015;
    let i0 = 0, i1 = n - 1;
    while (i0 < n && Math.abs(mono[i0]) <= TH) i0++;
    while (i1 > i0 && Math.abs(mono[i1]) <= TH) i1--;
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += mono[i] * mono[i];
    const rms = i1 > i0 ? Math.sqrt(sum / (i1 - i0 + 1)) : 0;

    // 4th-order 200 Hz high-pass: two cascaded RBJ biquads at Q 0.707.
    const hp = (x) => {
      const w0 = 2 * Math.PI * 200 / SR, c = Math.cos(w0), s = Math.sin(w0);
      const al = s / (2 * Math.SQRT1_2);
      const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2;
      const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
      const y = new Float32Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2
                - (a1 / a0) * y1 - (a2 / a0) * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
      }
      return y;
    };
    const f = hp(hp(mono));
    let hpeak = 0;
    for (let i = 0; i < f.length; i++) if (Math.abs(f[i]) > hpeak) hpeak = Math.abs(f[i]);

    // Loudest 200 ms. `rms` over the whole window answers "how much energy is
    // in this cue"; it is NOT how loud a one-shot sounds, because it divides by
    // a length the ear does not integrate over — a 740 ms cue and a 370 ms one
    // at the same loudness score two to one on it. The sliding window is the
    // column to compare two cues of different lengths on.
    const WN = Math.round(0.200 * SR);
    let best = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      acc += mono[i] * mono[i];
      if (i >= WN) acc -= mono[i - WN] * mono[i - WN];
      if (i >= WN && acc > best) best = acc;
    }
    const rms200 = Math.sqrt(best / WN);

    return {
      peak: +peak.toFixed(4), mono: +mpeak.toFixed(4), rms: +rms.toFixed(4),
      rms200: +rms200.toFixed(4),
      ms: Math.round(((i1 - i0 + 1) / SR) * 1000),
      hp200: +hpeak.toFixed(4),
    };
  };

  const out = [];

  // ── the four synthesised voices, first firing on a fresh instance ─────────
  for (const name of mod.JOURNAL_CUES) {
    const ctx = new OfflineAudioContext(2, Math.round(SR * 1.5), SR);
    const ja = new mod.JournalAudio(ctx, ctx.destination);
    // Force the synthesised path even once the sample is wired: this row has
    // to keep meaning what it has always meant.
    ja._noSample = true;
    ja.cue(name);
    out.push({ name: `synth ${name}`, ...measure(await ctx.startRendering()) });
  }

  // ── the recording, raw ────────────────────────────────────────────────────
  const bytes = await (await fetch('/audio/page.mp3')).arrayBuffer();
  {
    const ctx = new OfflineAudioContext(2, Math.round(SR * 4), SR);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0);
    out.push({
      name: 'page.mp3 raw',
      ch: buf.numberOfChannels, sr: buf.sampleRate,
      len: +buf.duration.toFixed(3),
      ...measure(await ctx.startRendering()),
    });
  }

  // ── the recording through the real cue path ───────────────────────────────
  // Both takes. The cue draws one at random, so the fresh-instance draw only
  // ever shows one of them and the other would ship unmeasured. `cue()` pulls
  // three values (start jitter, pitch, length) before `_sampledPage` pulls the
  // take, so the fourth draw is pinned and every other jitter is left exactly
  // as the fresh instance produces it.
  for (let take = 0; take < 2; take++) {
    const ctx = new OfflineAudioContext(2, Math.round(SR * 4), SR);
    const ja = new mod.JournalAudio(ctx, ctx.destination);
    await ja.loadSamples('/audio/page.mp3');
    const real = ja.rnd;
    let n = 0;
    ja.rnd = () => (++n === 4 ? (take ? 0.9 : 0.1) : real());
    ja.cue('page');
    out.push({ name: `cue page take ${take}`, ...measure(await ctx.startRendering()) });
  }

  // Three turns — a player holding the key down. The header's synthesised rows
  // are 0.151 at 0.12 s apart and 0.194 fired simultaneously; ducking has to
  // hold on the sample path too or flicking through the book is a roar.
  //
  // `_crowd` and `cue` both read `actx.currentTime`, which in an offline
  // context is pinned at 0 until rendering starts — so without this the three
  // land inside 20 ms of each other and the "0.12 s apart" case cannot be
  // asked at all. Shadowing the getter on the instance is what moves the clock.
  for (const spacing of [0.12, 0]) {
    const ctx = new OfflineAudioContext(2, Math.round(SR * 4), SR);
    let now = 0;
    Object.defineProperty(ctx, 'currentTime', { get: () => now, configurable: true });
    const ja = new mod.JournalAudio(ctx, ctx.destination);
    await ja.loadSamples('/audio/page.mp3');
    for (let i = 0; i < 3; i++) { now = i * spacing; ja.cue('page'); }
    out.push({ name: `page x3 @${spacing}s`, ...measure(await ctx.startRendering()) });
  }

  // The fallback, and it has to be provoked at the FETCH: `loadSamples` caches
  // its promise, so calling it a second time with a bad URL joins the good load
  // that the constructor already started and measures nothing.
  {
    const ctx = new OfflineAudioContext(2, Math.round(SR * 4), SR);
    const realFetch = window.fetch;
    window.fetch = (u, ...r) => (String(u).endsWith('page.mp3')
      ? Promise.reject(new Error('harness: asset missing'))
      : realFetch(u, ...r));
    const ja = new mod.JournalAudio(ctx, ctx.destination);
    await ja.loadSamples();
    window.fetch = realFetch;
    ja.cue('page');
    out.push({ name: 'page, asset missing', ...measure(await ctx.startRendering()) });
  }

  return out;
}, { tryGain });

const cols = ['name', 'peak', 'mono', 'rms', 'rms200', 'ms', 'hp200', 'ch', 'sr', 'len'];
const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));

await browser.close();

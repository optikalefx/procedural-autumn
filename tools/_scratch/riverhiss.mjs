#!/usr/bin/env node
/**
 * Measure the river/creek voice in isolation, at a range of distances.
 *
 * The player's report is that the creek at close range is "an annoying loud
 * hissing sound", so the numbers that matter are spectral, not just level:
 * where the energy sits, and how much of it is above 3 kHz. Same rig as
 * bedmeasure.mjs — the real modules, concatenated into one blob so no dev
 * server is needed, rendered offline through the real WaterAudio graph.
 *
 *   node tools/_scratch/riverhiss.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const strip = (s) => s.replace(/^import .*$/gm, '');
const math = readFileSync('src/core/MathUtils.js', 'utf8');
const mul = math.slice(math.indexOf('export function mulberry32'));
const MODULE = [
  math.split('\n').slice(2, 5).join('\n'),               // clamp, clamp01, lerp
  mul.slice(0, mul.indexOf('\nexport function hash2i')),
  strip(readFileSync('src/audio/synth.js', 'utf8')),
  strip(readFileSync('src/audio/water.js', 'utf8')),
].join('\n');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

const rows = await page.evaluate(async (moduleSrc) => {
  const url = URL.createObjectURL(new Blob([moduleSrc], { type: 'text/javascript' }));
  const S = await import(url);

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  const aw = (f) => {
    const f2 = f * f;
    return 1.2589 * (12194 ** 2 * f2 * f2) /
      ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  };

  async function measure(d, flow, fall = false) {
    const sr = 48000, secs = 3;
    const actx = new OfflineAudioContext(2, sr * secs, sr);
    const bus = S.gain(actx, 1);
    bus.connect(actx.destination);
    const world = fall
      ? { waterfalls: [{ top: [0, 12, 0], bottom: [0, 0, 0], height: 12, discharge: flow }], riverPolylines: [] }  // one fall: exercises the -1 padding path too
      : { waterfalls: [], riverPolylines: [[{ x: 0, z: 0, flow }, { x: 0, z: 1, flow }]] };
    const w = new S.WaterAudio(actx, bus, world);
    const L = { x: 0, y: 0, z: -d, yaw: 0 };
    for (let i = 0; i < 8; i++) w.update(1 / 60, L);
    const buf = await actx.startRendering();
    const a = buf.getChannelData(0), b = buf.getChannelData(1);
    const off = sr;                                  // skip the smoothing glide
    let peak = 0, sum = 0, n = 0;
    for (let i = off; i < a.length; i++) {
      const x = (a[i] + b[i]) * 0.5;
      if (Math.abs(x) > peak) peak = Math.abs(x);
      sum += x * x; n++;
    }
    const N = 32768;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const wnd = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      re[i] = (((a[off + i] ?? 0) + (b[off + i] ?? 0)) * 0.5) * wnd;
    }
    fft(re, im);
    let num = 0, den = 0, tot = 0, aTot = 0, e3k = 0, e2k5k = 0, lo = 0;
    for (let k = 1; k < N / 2; k++) {
      const hz = k * sr / N, mag = Math.hypot(re[k], im[k]), p = mag * mag;
      num += hz * mag; den += mag; tot += p; aTot += p * aw(hz) ** 2;
      if (hz > 3000) e3k += p;
      if (hz >= 2000 && hz <= 5000) e2k5k += p;
      if (hz < 700) lo += p;
    }
    return {
      d, flow, kind: fall ? 'fall' : 'river',
      model: +((fall ? w.falls : w.rivers).find((v) => v.target === 0)?.level ?? 0).toFixed(4),
      rms: +(20 * Math.log10(Math.sqrt(sum / n) + 1e-12)).toFixed(1),
      dBA: +(10 * Math.log10(aTot / (N / 2) + 1e-12)).toFixed(1),
      peak: +peak.toFixed(4),
      centroidHz: Math.round(num / den),
      above3k: +(100 * e3k / tot).toFixed(1),
      sharp2k5k: +(100 * e2k5k / tot).toFixed(1),
      below700: +(100 * lo / tot).toFixed(1),
      airHz: Math.round((fall ? w.falls : w.rivers).find((v) => v.target === 0)?.air.frequency.value ?? 0),
    };
  }

  const out = [];
  for (const d of [1, 2, 4, 8, 15, 30, 60]) out.push(await measure(d, 0.5));
  out.push(await measure(1, 1.0));
  for (const d of [1, 15, 60]) out.push(await measure(d, 0.5, true));
  return out;
}, MODULE);

await browser.close();
const pad = (s, n) => String(s).padStart(n);
console.log('  kind   d(m) flow  model    rms   dBA   peak  centroid  >3kHz  2-5kHz  <700Hz   airHz');
for (const r of rows) {
  console.log([pad(r.kind, 7), pad(r.d, 6), pad(r.flow, 5), pad(r.model, 7), pad(r.rms, 6), pad(r.dBA, 6),
    pad(r.peak, 7), pad(r.centroidHz, 9), pad(r.above3k + '%', 7), pad(r.sharp2k5k + '%', 7),
    pad(r.below700 + '%', 7), pad(r.airHz, 8)].join(''));
}

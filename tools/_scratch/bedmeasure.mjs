#!/usr/bin/env node
/** Same rig as splashmeasure, for the continuous ford bed. */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const synth = readFileSync('src/audio/synth.js', 'utf8').replace(/^import .*$/m, '');
const math = readFileSync('src/core/MathUtils.js', 'utf8');
const mulberry = math.slice(math.indexOf('export function mulberry32'));
const MODULE = mulberry.slice(0, mulberry.indexOf('\nexport function hash2i')) + '\n' + synth;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

const out = await page.evaluate(async (moduleSrc) => {
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

  // depth 1.0, speed 4 m/s -> the conditions the lab config was captured at.
  const LEVEL = (a, b) => 1.0 * (a + (4 / 30) * b);

  async function measure(spec) {
    const sr = 48000;
    const actx = new OfflineAudioContext(1, sr * 2, sr);
    const n = S.noiseSource(actx, S.noiseBuffer(actx, 4, spec.noise, 0xb3e2), spec.rate);
    const bp = S.filter(actx, 'bandpass', spec.f0, spec.q);
    const g = S.gain(actx, LEVEL(spec.a, spec.b));
    n.connect(bp).connect(g).connect(actx.destination);
    const buf = await actx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { const x = Math.abs(d[i]); if (x > peak) peak = x; sum += d[i] * d[i]; }
    const N = 32768, off = sr;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      re[i] = (d[off + i] ?? 0) * w;
    }
    fft(re, im);
    let num = 0, den = 0, e2k = 0, tot = 0, aTot = 0;
    for (let k = 1; k < N / 2; k++) {
      const hz = k * sr / N, mag = Math.hypot(re[k], im[k]), p = mag * mag;
      num += hz * mag; den += mag; tot += p; aTot += p * aw(hz) ** 2;
      if (hz >= 2000 && hz <= 5000) e2k += p;
    }
    return {
      centroidHz: Math.round(num / den),
      sharpPct: +(100 * e2k / tot).toFixed(1),
      rms: +(20 * Math.log10(Math.sqrt(sum / d.length))).toFixed(1),
      dBA: +(10 * Math.log10(aTot / (N / 2))).toFixed(1),
    };
  }

  const CUR = { noise: 'white', f0: 1600, q: 0.5, rate: 1.07, a: 0.04, b: 0.12 };
  const rows = [
    ['BED before  white 1600 Q0.5', await measure(CUR)],
    ['BED  your lab attempt (650)', await measure({ ...CUR, f0: 650 })],
    ['BED after   pink 900 Q0.9', await measure({ noise: 'pink', f0: 900, q: 0.9, rate: 0.85, a: 0.06, b: 0.18 })],
  ];
  return rows;
}, MODULE);

console.log('\n  ford bed variant                     centroid   2-5kHz      rms      dBA');
console.log('  ' + '─'.repeat(74));
for (const [l, m] of out)
  console.log(`  ${l.padEnd(34)} ${String(m.centroidHz + ' Hz').padStart(8)} ${String(m.sharpPct + '%').padStart(8)} ${String(m.rms + ' dB').padStart(9)} ${String(m.dBA + ' dB').padStart(9)}`);
console.log('');
await browser.close();

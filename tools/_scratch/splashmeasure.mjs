#!/usr/bin/env node
/**
 * Offline measurement of the water-entry splash.
 *
 * The splash is a 0.5 s transient, so it barely moves the Sound Lab's RMS
 * window — which is why it can be the most annoying thing in the mix while
 * the ford bed is the thing that measures. This renders candidate splashes
 * into an OfflineAudioContext and reports the numbers that actually track
 * "sharp": spectral centroid, and the share of energy in the 2-5 kHz band
 * the ear is most sensitive to.
 *
 *   node tools/_scratch/splashmeasure.mjs
 */
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

  // Radix-2 FFT, magnitude only.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
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

  // Render one splash variant and measure it.
  async function measure(spec) {
    const sr = 48000;
    const actx = new OfflineAudioContext(1, sr * 1.5, sr);
    const bus = actx.createGain(); bus.gain.value = 1; bus.connect(actx.destination);
    const t = 0.01;
    const n = S.noiseSource(actx, S.noiseBuffer(actx, 1.2, spec.noise, 0x5a12));
    const bp = S.filter(actx, 'bandpass', spec.f0, spec.q);
    bp.frequency.setValueAtTime(spec.f0, t);
    bp.frequency.exponentialRampToValueAtTime(spec.f1, t + spec.sweep);
    const g = S.gain(actx, 0);
    n.connect(bp).connect(g).connect(bus);
    S.ping(actx, g, t, spec.peak, spec.attack, spec.decay);
    const buf = await actx.startRendering();
    const d = buf.getChannelData(0);

    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; }
    const rms = Math.sqrt(sum / d.length);

    // Spectrum over the loud part of the transient.
    const N = 32768, off = Math.floor(sr * 0.01);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      re[i] = (d[off + i] ?? 0) * w;
    }
    fft(re, im);
    // IEC 61672 A-weighting: "annoying" tracks A-weighted level far better
    // than flat RMS, because it is mostly about the 2-5 kHz ear peak.
    const aw = (f) => {
      const f2 = f * f;
      const r = (12194 ** 2 * f2 * f2) /
        ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
      return r * 1.2589;
    };
    let num = 0, den = 0, e2k = 0, tot = 0, aTot = 0;
    for (let k = 1; k < N / 2; k++) {
      const hz = k * sr / N;
      const mag = Math.hypot(re[k], im[k]);
      const p = mag * mag;
      num += hz * mag; den += mag;
      tot += p;
      aTot += p * aw(hz) ** 2;
      if (hz >= 2000 && hz <= 5000) e2k += p;
    }
    return {
      centroidHz: Math.round(num / den),
      sharpPct: +(100 * e2k / tot).toFixed(1),
      peak: +(20 * Math.log10(peak)).toFixed(1),
      rms: +(20 * Math.log10(rms)).toFixed(1),
      dBA: +(10 * Math.log10(aTot / (N / 2))).toFixed(1),
    };
  }

  const OLD_SPLASH = { noise: 'white', f0: 3000, f1: 700, q: 0.7, sweep: 0.42, peak: 0.22, attack: 0.012, decay: 0.45 };
  const NEW_SPLASH = { noise: 'pink', f0: 1400, f1: 380, q: 0.7, sweep: 0.5, peak: 0.4, attack: 0.022, decay: 0.5 };
  const rows = [
    ['SPLASH before  white 3000->700', await measure(OLD_SPLASH)],
    ['SPLASH after   pink 1400->380', await measure(NEW_SPLASH)],
  ];
  return rows;
}, MODULE);

console.log('\n  variant                              centroid   2-5kHz    peak      dBA');
console.log('  ' + '─'.repeat(74));
for (const [label, m] of out) {
  console.log(`  ${label.padEnd(34)} ${String(m.centroidHz + ' Hz').padStart(8)} ${String(m.sharpPct + '%').padStart(8)} ${String(m.peak + ' dB').padStart(9)} ${String(m.dBA + ' dB').padStart(9)}`);
}
console.log('');
await browser.close();

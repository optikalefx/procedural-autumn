// "Harsh" is a spectral word, not a level one. Compare the sampled cover with
// the synthesised voice it replaced, band by band, instead of guessing.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  // Naive DFT over a Hann window — slow, exact enough, no dependency.
  const bands = (mono, sr) => {
    const N = 8192;
    const start = Math.max(0, mono.findIndex((v) => Math.abs(v) > 0.02));
    const x = new Float32Array(N);
    for (let i = 0; i < N && start + i < mono.length; i++) {
      x[i] = mono[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    }
    const edges = [0, 200, 800, 2000, 5000, 10000, 24000];
    const p = new Array(edges.length - 1).fill(0);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      let re = 0, im = 0;
      for (let i = 0; i < N; i += 2) {          // decimate: half the bins, 4x faster
        const a = -2 * Math.PI * k * i / N;
        re += x[i] * Math.cos(a); im += x[i] * Math.sin(a);
      }
      const mag = re * re + im * im;
      for (let e = 0; e < p.length; e++) if (f >= edges[e] && f < edges[e + 1]) { p[e] += mag; break; }
    }
    const tot = p.reduce((a, v) => a + v, 0) || 1;
    return p.map((v) => +(100 * v / tot).toFixed(1));
  };
  const render = async (noSample) => {
    const oac = new OfflineAudioContext(2, 48000, 48000);
    const ja = new JournalAudio(oac, oac.destination);
    await ja.loadSamples().catch(() => {});
    if (noSample) ja._noSample = true;
    ja.cue('cover');
    const r = await oac.startRendering();
    const n = r.length, mono = new Float32Array(n);
    for (let c = 0; c < 2; c++) { const d = r.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / 2; }
    return bands(mono, 48000);
  };
  return { sampled: await render(false), synth: await render(true) };
});
const LBL = ['<200', '200-800', '0.8-2k', '2-5k', '5-10k', '>10k'];
console.log('band energy, % of total');
console.log('             ' + LBL.map((l) => l.padStart(8)).join(''));
console.log('journal.mp3  ' + out.sampled.map((v) => String(v).padStart(8)).join(''));
console.log('synth cover  ' + out.synth.map((v) => String(v).padStart(8)).join(''));
const hi = (a) => a[3] + a[4] + a[5];
console.log(`\nabove 2 kHz:  sample ${hi(out.sampled).toFixed(1)}%   synth ${hi(out.synth).toFixed(1)}%`);
await b.close();

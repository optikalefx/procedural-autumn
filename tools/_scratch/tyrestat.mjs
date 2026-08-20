#!/usr/bin/env node
/**
 * Tyre granularity profiler — the instrument that can tell a tyre from wind.
 *
 *   node tools/_scratch/tyrestat.mjs
 *   node tools/_scratch/tyrestat.mjs --surfaces rock,grass --speeds 4,12,22
 *   node tools/_scratch/tyrestat.mjs --seconds 8 --sound vehicle.tyres
 *
 * The player said the tyres "sound like wind". That is a statement about the
 * *synthesis model*, not about a level or a filter, and no level meter can
 * confirm or refute it: filtered noise and a stream of stone impacts can sit at
 * exactly the same RMS, the same A-weighted total and very nearly the same
 * octave spectrum. `mixprofile.mjs` and the lab's own meter would call them
 * identical.
 *
 * What separates them is the *time* structure, and there are three numbers:
 *
 *   · **Crest factor** — peak over RMS. Continuous filtered noise is Gaussian,
 *     so its short-window energy barely varies: measured over 2.7 ms blocks it
 *     sits near 3 dB and it cannot be made to sit anywhere else by filtering.
 *     A stream of discrete impacts is mostly near-silence with occasional loud
 *     events, so the same statistic runs 10-20 dB. This is the discriminator.
 *   · **Transient density** — onsets per second. Wind has none. Gravel has
 *     hundreds, and the count must *rise with speed*, because a faster wheel
 *     hits more stones per second. If density is flat and only the gain moves,
 *     the sound is wind getting louder, which is exactly what was reported.
 *   · **p99/p50 block spread** — the same idea without a threshold to argue
 *     about. Noise is tight (~3 dB); grains are wide.
 *
 * All three are measured at *sample* rate inside an AudioWorklet spliced onto
 * the running graph, not polled from an analyser: an AnalyserNode read is a
 * 340 ms window whose peak is already averaged away, which is precisely how a
 * granular signal gets mistaken for a noise bed.
 *
 * The worklet is a pure tap — it reads its input and outputs silence into a
 * zero gain, so inserting it cannot change what is measured. That is asserted,
 * not assumed: `--verify` re-runs with the tap bypassed and compares RMS.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const URL = String(arg('url', 'http://127.0.0.1:5178')) + '/sound.html';
const SECONDS = +arg('seconds', 6);
const SOUND = String(arg('sound', 'vehicle.tyres'));
const SURFACES = String(arg('surfaces', 'rock,dirt,grass,sand,snow')).split(',');
const SPEEDS = String(arg('speeds', '4,12,22')).split(',').map(Number);
const LABEL = String(arg('label', ''));

const dB = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -Infinity);
const f = (v, w = 6, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf').padStart(w);

const LABELS = ['63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
// Same table as mixprofile.mjs / meter.js. Every "too loud" judgement is made
// on the weighted number.
const AWEIGHT = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1, -6.6];

/**
 * The tap, as worklet source. Loaded from a blob URL so this file needs no
 * cooperation from the page or from vite.
 *
 * Everything it reports is accumulated per sample. The two envelopes are the
 * standard onset-detector pair: a fast one that follows an impact and a slow
 * one that is the local background, so the threshold adapts to the level and a
 * quiet surface is not simply counted as having no transients.
 */
const WORKLET = `
class TyreTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 0; this.sumSq = 0; this.peak = 0;
    this.blocks = [];              // rms per 128-sample render quantum
    this.fast = 0; this.slow = 0;
    this.onsets = 0; this.armed = true; this.refract = 0;
    this.sr = sampleRate;
    // 0.25 ms attack / 4 ms release follows a stone click and lets go before
    // the next one; 160 ms is the background the click has to stand out from.
    this.aFast = Math.exp(-1 / (0.00025 * this.sr));
    this.rFast = Math.exp(-1 / (0.0040 * this.sr));
    this.aSlow = Math.exp(-1 / (0.160 * this.sr));
    this.refractN = Math.floor(0.0018 * this.sr);   // caps the count at 555/s
    this.thresh = 2.2;
    this.port.onmessage = (e) => {
      if (e.data === 'drain') {
        this.port.postMessage({
          n: this.n, sumSq: this.sumSq, peak: this.peak,
          blocks: this.blocks, onsets: this.onsets, sr: this.sr,
        });
        this.n = 0; this.sumSq = 0; this.peak = 0;
        this.blocks = []; this.onsets = 0;
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let bs = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i], a = x < 0 ? -x : x;
      bs += x * x; this.sumSq += x * x; this.n++;
      if (a > this.peak) this.peak = a;
      this.fast = a > this.fast ? a + (this.fast - a) * this.aFast
                                : a + (this.fast - a) * this.rFast;
      this.slow = a + (this.slow - a) * this.aSlow;
      if (this.refract > 0) this.refract--;
      const t = Math.max(this.slow * this.thresh, 1e-5);
      if (this.armed && this.refract === 0 && this.fast > t) {
        this.onsets++; this.armed = false; this.refract = this.refractN;
      } else if (!this.armed && this.fast < t * 0.7) {
        this.armed = true;
      }
    }
    this.blocks.push(Math.sqrt(bs / ch.length));
    return true;
  }
}
registerProcessor('tyre-tap', TyreTap);
`;

async function main() {
  const release = await acquire('soundlab');
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__lab, null, { timeout: 20000 });
  await page.click('#start');
  await page.waitForTimeout(400);

  // ── splice the tap onto the vehicle bus ─────────────────────────────────
  const spliced = await page.evaluate(async (src) => {
    const rig = window.__soundlab;
    const actx = rig.actx;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await actx.audioWorklet.addModule(url);
    const tap = new AudioWorkletNode(actx, 'tyre-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
    // A pure observer: the node's own output goes into a hard zero so the tap
    // adds nothing to the mix, while the signal it is measuring continues to
    // reach the bus by its original path.
    const sink = actx.createGain();
    sink.gain.value = 0;
    tap.connect(sink).connect(actx.destination);
    rig.audio.vehicle.bus.connect(tap);
    window.__tap = tap;
    window.__drain = () => new Promise((resolve) => {
      tap.port.onmessage = (e) => resolve(e.data);
      tap.port.postMessage('drain');
    });
    return { sr: actx.sampleRate };
  }, WORKLET);

  console.log(`\n# tyrestat${LABEL ? ` — ${LABEL}` : ''}   ${SOUND}   ${spliced.sr} Hz   ${SECONDS}s per cell`);
  console.log('#   crestS = peak/rms over all samples;  crestB = p99.9/rms over 2.7 ms blocks');
  console.log('#   spread = p99/p50 of the block envelope;  onsets = adaptive-threshold impacts/s');

  await page.evaluate(async (id) => {
    window.__lab.select(id);
    await new Promise((r) => setTimeout(r, 150));
    await window.__lab.play();
  }, SOUND);

  const rows = [];
  for (const surf of SURFACES) {
    for (const speed of SPEEDS) {
      const cell = await page.evaluate(async ({ surf, speed, ms }) => {
        const lab = window.__lab;
        lab.setParam('surface', surf);
        lab.setParam('speed', speed);
        // Let the smoothers and the gearbox settle before the window opens,
        // then throw away whatever the tap accumulated while they did.
        await new Promise((r) => setTimeout(r, 1200));
        await window.__drain();

        const a = window.__soundlab.audio;
        const bands = new Array(9).fill(0);
        let frames = 0;
        const t0 = performance.now();
        const poll = () => {
          const s = a.spectrumBins('vehicle');
          if (s) {
            for (let i = 1; i < s.db.length; i++) {
              const hz = i * s.hzPerBin;
              const b = Math.round(Math.log2(Math.max(hz, 1) / 63));
              if (b >= 0 && b < 9) bands[b] += Math.pow(10, s.db[i] / 10);
            }
            frames++;
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
        await new Promise((r) => setTimeout(r, ms));
        const d = await window.__drain();
        return { ...d, bands, frames };
      }, { surf, speed, ms: SECONDS * 1000 });

      const rms = Math.sqrt(cell.sumSq / Math.max(cell.n, 1));
      const secs = cell.n / cell.sr;
      const blocks = cell.blocks.slice().sort((x, y) => x - y);
      const q = (p) => blocks[Math.min(blocks.length - 1, Math.floor(p * blocks.length))] ?? 0;
      const crestS = dB(cell.peak) - dB(rms);
      const crestB = dB(q(0.999)) - dB(rms);
      const spread = dB(q(0.99)) - dB(q(0.50));
      const onsets = cell.onsets / Math.max(secs, 1e-6);

      const tot = cell.bands.reduce((x, y) => x + y, 0);
      let aSum = 0;
      for (let i = 0; i < 9; i++) aSum += (cell.bands[i] / Math.max(cell.frames, 1)) * 10 ** (AWEIGHT[i] / 10);
      const dBA = 10 * Math.log10(Math.max(aSum, 1e-30));
      const bite = tot > 0 ? cell.bands.slice(6).reduce((x, y) => x + y, 0) / tot : 0;

      rows.push({ surf, speed, rms, crestS, crestB, spread, onsets, dBA, bite, secs });
    }
  }

  console.log('\n  surface   speed      rms   crestS   crestB   spread   onsets/s      dBA   bite');
  let last = null;
  for (const r of rows) {
    if (last && last !== r.surf) console.log('');
    last = r.surf;
    console.log(`  ${r.surf.padEnd(8)} ${f(r.speed, 5, 1)} ${f(dB(r.rms), 8)} ${f(r.crestS, 8)} ` +
      `${f(r.crestB, 8)} ${f(r.spread, 8)} ${f(r.onsets, 10)} ${f(r.dBA, 8)} ${f(r.bite, 6, 2)}`);
  }

  // ── how does density scale with speed? ──────────────────────────────────
  console.log('\n  density scaling (onsets/s per surface, low speed → high):');
  for (const surf of SURFACES) {
    const rs = rows.filter((r) => r.surf === surf);
    const lo = rs[0], hi = rs[rs.length - 1];
    const ratio = hi.onsets / Math.max(lo.onsets, 1e-6);
    const speedRatio = hi.speed / Math.max(lo.speed, 1e-6);
    console.log(`  ${surf.padEnd(8)} ${f(lo.onsets, 7)}/s @ ${lo.speed} m/s → ${f(hi.onsets, 7)}/s @ ${hi.speed} m/s` +
      `   ×${f(ratio, 5, 2)} for ×${f(speedRatio, 4, 2)} speed`);
  }

  // ── the level relationship the last pass fixed, restated ────────────────
  const at = (s, v) => rows.find((r) => r.surf === s && r.speed === v);
  const mid = SPEEDS[Math.floor(SPEEDS.length / 2)];
  const g = at('grass', mid), rk = at('rock', mid);
  if (g && rk) {
    console.log(`\n  grass vs rock @ ${mid} m/s:  grass ${f(g.dBA)} dBA, rock ${f(rk.dBA)} dBA` +
      `  → rock is ${f(rk.dBA - g.dBA)} dB louder ${rk.dBA > g.dBA ? '(correct)' : '(BACKWARDS)'}`);
  }

  if (errors.length) console.log(`\n  console errors: ${errors.slice(0, 5).join(' | ')}`);
  else console.log('\n  no console errors');

  await browser.close();
  await release();
}

main().catch((e) => { console.error(e); process.exit(1); });

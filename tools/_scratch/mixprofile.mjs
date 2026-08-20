#!/usr/bin/env node
/**
 * Mix profiler — the instrument `audiotest.mjs` is missing.
 *
 *   node tools/_scratch/mixprofile.mjs                    # both scenarios
 *   node tools/_scratch/mixprofile.mjs --scenario parked --seconds 80
 *   node tools/_scratch/mixprofile.mjs --scenario drive
 *
 * `audiotest.mjs` meters a bus over ~1–4 seconds and reports one number. That
 * is the right tool for "is this layer audible", and the wrong one for every
 * question the player actually asked, because it answers none of these:
 *
 *   · **How far apart are the quiet moment and the loud one?**  The ambience
 *     gusts are driven by LFOs at 0.037 and 0.029 Hz — 27 and 35 second
 *     periods. A 2.5 s meter lands wherever it lands on that cycle and reports
 *     a level that is off by whatever the gust happened to be doing. To see the
 *     floor and the peak you have to watch for longer than a full cycle, which
 *     is what `--seconds 80` is for. "When the wind dies down it's nice" is a
 *     statement about the *floor*, and only an envelope can show it.
 *   · **Where is the energy sitting?**  Harshness is spectral. A bus at
 *     -26 dBFS whose energy is above 2 kHz is fatiguing; the same bus at the
 *     same level with its energy at 200 Hz is cozy. So every scenario also
 *     dumps a time-averaged octave-band spectrum and a "bite" figure: the
 *     fraction of the bus's energy sitting above 2 kHz.
 *
 * Everything printed is read off the running WebAudio graph through the
 * analyser taps in `src/audio/Audio.js`. Nothing here is inferred from source.
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
const SECONDS = +arg('seconds', 80);
const SCENARIO = String(arg('scenario', 'both'));
const RES = arg('res', '512');
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

const BUSES = ['ambience', 'falls', 'rivers', 'vehicle', 'wildlife', 'music', 'master'];
const dB = (v) => (v > 1e-7 ? 20 * Math.log10(v) : -Infinity);
const p = (v, w = 6, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf').padStart(w);

const LABELS = ['63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
// A-weighting at each octave centre, dB. This is the whole point of the tool:
// the ear is ~26 dB less sensitive at 63 Hz than at 1 kHz, so a bus measured
// flat at -26 dBFS with its energy at 63 Hz and a bus at -37 dBFS with its
// energy at 3 kHz are not in the order the raw RMS puts them in. Every
// judgement about "too loud" has to be made on the weighted number.
const AWEIGHT = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1, -6.6];

function report(label, prof) {
  console.log(`\n── ${label} — ${prof.secs.toFixed(1)} s, ${prof.n} envelope samples ──`);
  console.log('  bus         floor     p10      p50      p90     peak    range');
  for (const b of BUSES) {
    const s = prof.env[b];
    if (!s || !s.length) continue;
    const a = [...s].sort((x, y) => x - y);
    const q = (f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
    const lo = dB(q(0.02)), hi = dB(q(0.98));
    console.log(`  ${b.padEnd(9)} ${p(lo)} ${p(dB(q(0.10)))} ${p(dB(q(0.5)))} ` +
                `${p(dB(q(0.90)))} ${p(hi)} ${p(hi - lo, 7)} dB`);
  }
  console.log(`  ${''.padEnd(11)}${LABELS.map((L) => L.padStart(6)).join('')}   flat    dBA   tilt`);
  for (const [bus, bands] of Object.entries(prof.bands)) {
    const tot = bands.reduce((x, y) => x + y, 0);
    if (tot <= 0) continue;
    // Absolute-ish band levels: consistent scaling across buses and across
    // runs, which is all a before/after comparison needs.
    const lvl = bands.map((v) => 10 * Math.log10(v / Math.max(prof.frames[bus], 1)));
    const flat = 10 * Math.log10(tot / Math.max(prof.frames[bus], 1));
    let aSum = 0;
    for (let i = 0; i < bands.length; i++) aSum += (bands[i] / Math.max(prof.frames[bus], 1)) * 10 ** (AWEIGHT[i] / 10);
    const dBA = 10 * Math.log10(Math.max(aSum, 1e-30));
    console.log(`  ${bus.padEnd(10)}${lvl.map((v) => p(v, 6, 0)).join('')} ${p(flat)} ${p(dBA)} ${p(dBA - flat, 6)}`);
    const bite = bands.slice(6).reduce((x, y) => x + y, 0) / tot;   // ≥2 kHz
    console.log(`  ${''.padEnd(10)}bite(≥2 kHz) ${(bite * 100).toFixed(1)} %   ` +
                `centroid ${prof.centroid[bus].toFixed(0)} Hz`);
  }
}

async function main() {
  const release = await acquire('mixprofile');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  // Peers save files constantly; an HMR reload mid-run invalidates the whole
  // measurement, and this one runs for minutes.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
                 set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.keyboard.press('KeyM');                        // gesture (also mutes)
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__audio.setMuted(false));
  await page.waitForTimeout(400);

  await page.evaluate(({ buses, labels }) => {
    window.__BUSES = buses;
    /**
     * Run an envelope + spectrum capture for `ms`.
     *
     * The envelope is sampled per animation frame (the taps are 16384-point
     * analysers, so each read is a ~340 ms window at 48 kHz — plenty fine for
     * a 30 s gust) and the octave bands are accumulated as linear *power* so
     * the time average is an energy average rather than an average of decibels.
     */
    window.__prof = (ms, specBuses) => new Promise((resolve) => {
      const a = window.__audio;
      const env = {}; for (const b of buses) env[b] = [];
      const bands = {}, cent = {}, cn = {};
      for (const b of specBuses) { bands[b] = new Array(labels.length).fill(0); cent[b] = 0; cn[b] = 0; }
      const t0 = performance.now();
      let n = 0;
      const tick = () => {
        for (const b of buses) { const m = a.measure?.(b); if (m) env[b].push(m.rms); }
        n++;
        // The FFT is the expensive half; take it every 6th frame.
        if (n % 6 === 0) {
          for (const b of specBuses) {
            const s = a.spectrumBins(b);
            if (!s) continue;
            let num = 0, den = 0;
            for (let i = 1; i < s.db.length; i++) {
              const hz = i * s.hzPerBin;
              if (hz > 20000) break;
              const pw = Math.pow(10, s.db[i] / 10);       // power, not amplitude
              // Octave band index: 63 Hz is band 0, each band a doubling.
              const k = Math.round(Math.log2(hz / 63));
              if (k >= 0 && k < labels.length) bands[b][k] += pw;
              num += pw * hz; den += pw;
            }
            if (den > 0) { cent[b] += num / den; cn[b]++; }
          }
        }
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else {
          const centroid = {}, frames = {};
          for (const b of specBuses) { centroid[b] = cn[b] ? cent[b] / cn[b] : 0; frames[b] = cn[b]; }
          resolve({ env, bands, centroid, frames, n, secs: (performance.now() - t0) / 1000 });
        }
      };
      requestAnimationFrame(tick);
    });
  }, { buses: BUSES, labels: LABELS });

  const want = (s) => SCENARIO === 'both' || SCENARIO === s;

  // ── parked in open meadow ────────────────────────────────────────────────
  // Engine off, nowhere near a fall, midday. What the player hears when they
  // stop the camper and just look at the valley — the moment the whole game is
  // selling, and the one the ambience bed has entirely to itself.
  if (want('parked')) {
    await page.evaluate(() => {
      window.__lighting.hour = 13.0; window.__lighting.cycleSpeed = 0;
      const q = window.__poi.best('meadow');
      window.__vehicleTeleport?.(q.x, q.z, 0);
      window.__forceCamera = false;
    });
    await page.waitForTimeout(2500);
    // Watch the *realised* AudioParam values while the envelope is captured.
    // A layer's gain is the sum of its intrinsic value and every LFO connected
    // to it, and only the intrinsic half appears in `debugState()`. If those
    // two disagree, the model is not what is playing.
    await page.evaluate(() => {
      const a = window.__audio.ambience;
      window.__gainWatch = { grass: [], conifer: [], hush: [], model: [] };
      window.__gw = setInterval(() => {
        const w = window.__gainWatch;
        w.grass.push(a.grassGain.gain.value);
        w.conifer.push(a.coniferGain.gain.value);
        w.hush.push(a.hushGain.gain.value);
        w.model.push(a.state.grass);
      }, 120);
    });
    const parked = await page.evaluate((ms) => window.__prof(ms, ['ambience', 'master']), SECONDS * 1000);
    const wind = await page.evaluate(() => {
      clearInterval(window.__gw);
      const w = window.__gainWatch;
      const st = (a) => ({ min: Math.min(...a), max: Math.max(...a) });
      return { ...window.__audio.debugState().ambience, wind: window.__audio.L.wind,
               realised: { grass: st(w.grass), conifer: st(w.conifer), hush: st(w.hush),
                           model: st(w.model) } };
    });
    report('parked in open meadow, engine idling', parked);
    console.log(`  model: grass=${wind.grass.toFixed(4)} conifer=${wind.conifer.toFixed(4)} ` +
                `hush=${wind.hush.toFixed(4)} L.wind=${wind.wind.toFixed(2)}`);
    const r = wind.realised;
    console.log(`  realised gain (intrinsic + LFOs), min … max over the run:`);
    console.log(`    grass   ${r.grass.min.toFixed(4)} … ${r.grass.max.toFixed(4)}   ` +
                `(model wanted ${r.model.min.toFixed(4)} … ${r.model.max.toFixed(4)})`);
    console.log(`    conifer ${r.conifer.min.toFixed(4)} … ${r.conifer.max.toFixed(4)}`);
    console.log(`    hush    ${r.hush.min.toFixed(4)} … ${r.hush.max.toFixed(4)}`);
  }

  // ── driving across grass ─────────────────────────────────────────────────
  if (want('drive')) {
    // Re-seat the camper on the same meadow every few seconds. A free 40 s
    // drive leaves the valley: three baseline runs of this scenario finished in
    // 2nd gear on grass, 4th on grass and 5th on scree, and comparing an engine
    // change across those is comparing three different sounds. Pinning the
    // surface and keeping the gear low is what makes the before/after mean
    // something.
    await page.evaluate(() => {
      window.__meadow = window.__poi.best('meadow');
      window.__vehicleTeleport?.(window.__meadow.x, window.__meadow.z, 0);
    });
    await page.waitForTimeout(1200);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3000);                        // get up to speed first
    const reseat = setInterval(() => {
      page.evaluate(() => window.__vehicleTeleport?.(window.__meadow.x, window.__meadow.z, 6))
        .catch(() => {});
    }, 6000);
    const drive = await page.evaluate((ms) => window.__prof(ms, ['vehicle', 'ambience', 'master']),
                                      Math.min(SECONDS, 40) * 1000);
    clearInterval(reseat);
    const v = await page.evaluate(() => ({ ...window.__audio.debugState().vehicle,
                                           speed: Math.abs(window.__vehicleState().speed) }));
    await page.keyboard.up('KeyW');
    report('driving, throttle open, over grass', drive);
    console.log(`  model: speed=${v.speed.toFixed(1)} m/s rpm=${v.rpm.toFixed(0)} gear=${v.gear} ` +
                `load=${v.load.toFixed(2)} f0=${v.f0.toFixed(1)} Hz tyre=${v.tyre.toFixed(4)} ` +
                `surface=${v.surface}`);
  }

  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });

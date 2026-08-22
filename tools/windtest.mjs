#!/usr/bin/env node
/**
 * Wind dynamics harness — how loud the wind gets, and how far it swings.
 *
 *   node tools/windtest.mjs --url http://127.0.0.1:5201 --label before
 *   node tools/windtest.mjs --seconds 260 --out /tmp/wind-after.json
 *
 * `audiotest.mjs` answers "is the ambience audible" with a single averaged RMS
 * over 2.5 s. That number cannot see the defect this tool exists for: the wind
 * bed is a *bed times an envelope*, and the complaint "the wind is too loud" is
 * about the top of that envelope, not its mean. A 2.5 s window is 3% of one
 * gust cycle — it lands wherever it lands, and two runs of it disagree by more
 * than the change you are trying to measure.
 *
 * What this does instead:
 *
 *   · Reads the per-layer taps (`windGrass`, `windConifer`, `windHush`) rather
 *     than the `ambience` bus. The bus also carries birds, crickets and the
 *     camp fire; a bird call and a gust move that number the same way.
 *   · Integrates for LONGER THAN THE GUST PERIOD. `WindField.update` sets
 *     `gust = 0.78 + 0.34·sin(0.083·t) + 0.14·sin(0.211·t)`, so the primary
 *     period is 2π/0.083 = 75.7 s and the secondary is 29.8 s. The audio adds
 *     its own multiplicative `swell()` LFOs at 0.037 Hz (27.0 s) and 0.029 Hz
 *     (34.5 s). The default 260 s covers 3.4 primary gust cycles and 9.6 grass
 *     swells, which is the minimum honest window.
 *   · Reports the ENVELOPE, not the mean: p5 / p50 / p95 / max of the running
 *     RMS, and the gust-peak-to-calm-floor ratio p95/p5 in dB. That ratio is
 *     the number the brief is actually about.
 *   · Asserts the layer is alive before believing any of it. A muted layer has
 *     a beautiful crest factor. Each arm fails loudly if the model gain, the
 *     AudioParam and the measured RMS are not all non-zero, and if the measured
 *     envelope does not correlate with `L.wind` (a bed that ignores the weather
 *     is the exact bug this file's ancestor was written to catch).
 *
 * ONE TRAP, and it produced a wrong number on this tool's first run. The
 * per-layer taps hang off `grassGain`/`coniferGain`/`hushGain`, which are
 * UPSTREAM of the ambience bus gain (0.55) and of the master gain (volume ×
 * 0.71). The `master` and `ambience` analysers are downstream of those. Compare
 * the two directly and the wind measures LOUDER THAN THE MASTER IT FEEDS —
 * the first run reported the wind bed 4.1 dB above the whole mix, which is not
 * a mix problem, it is 0.55 × 0.53 = -10.7 dB of gain the comparison skipped.
 * Everything below is therefore reported at the tap AND, where two points in
 * the chain are compared, referred forward through the gains between them.
 *
 * Each `measure()` call reads the tap's 16384-sample time-domain buffer, which
 * at 48 kHz is a 341 ms window. So every sample below is already a 341 ms
 * moving RMS; the percentiles are percentiles OF THAT, which is roughly the
 * integration time of the ear for loudness. Peak is the true sample peak inside
 * the same window.
 *
 * Exit code 0 = every liveness assertion passed. The levels are reported, not
 * gated: what "too loud" means is a judgement, and this tool's job is to make
 * it a judgement about numbers.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const RES = arg('res', '640');
const BASE = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
// `WorldConfig.SEED` and the worlds in `public/bakes/` currently disagree, and
// booting on the wrong one silently bakes a fresh world — minutes per run, and
// a different valley from the one every other harness is looking at. Pinned,
// and built through URL rather than string concatenation so `--url` may carry
// a path or a query of its own.
const SEED = String(arg('seed', '20261018'));
const target = new URL(BASE);
target.searchParams.set('res', RES);
if (SEED !== 'default') target.searchParams.set('seed', SEED);
const PAGE = target.toString();
const SECONDS = Number(arg('seconds', 260));
const FOREST_SECONDS = Number(arg('forestSeconds', 160));
const MIX_SECONDS = Number(arg('mixSeconds', 160));
const LABEL = String(arg('label', 'run'));
const OUT = arg('out', null);

const dB = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -Infinity);
const fdB = (v) => (Number.isFinite(dB(v)) ? dB(v).toFixed(1) : '-inf').padStart(7);
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Percentile of a sorted-on-demand copy. */
function pct(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db2 += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(Math.max(da * db2, 1e-18));
}

/** Envelope statistics for one tap's series of 341 ms RMS readings. */
function stats(rms, peak) {
  const meanSq = rms.reduce((s, v) => s + v * v, 0) / Math.max(rms.length, 1);
  const overallRms = Math.sqrt(meanSq);
  const truePeak = peak.reduce((s, v) => Math.max(s, v), 0);
  return {
    n: rms.length,
    rms: overallRms,
    peak: truePeak,
    crest_dB: dB(truePeak) - dB(overallRms),
    p5: pct(rms, 5),
    p50: pct(rms, 50),
    p95: pct(rms, 95),
    min: Math.min(...rms),
    max: Math.max(...rms),
    swing_dB: dB(pct(rms, 95)) - dB(pct(rms, 5)),
    fullSwing_dB: dB(Math.max(...rms)) - dB(Math.min(...rms)),
  };
}

function report(title, s) {
  console.log(`  ${title}`);
  console.log(`    rms ${fdB(s.rms)} dBFS   peak ${fdB(s.peak)} dBFS   crest ${f(s.crest_dB, 1)} dB   (${s.n} samples)`);
  console.log(`    envelope  p5 ${fdB(s.p5)}  p50 ${fdB(s.p50)}  p95 ${fdB(s.p95)}  max ${fdB(s.max)} dBFS`);
  console.log(`    gust-peak / calm-floor  p95/p5 = ${f(s.swing_dB, 1)} dB   max/min = ${f(s.fullSwing_dB, 1)} dB`);
}

async function main() {
  const release = await acquire('windtest');
  const browser = await chromium.launch({
    headless: !argv.includes('--headed'),
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

  // A peer saving a file mid-run reloads the page and invalidates a ten-minute
  // measurement. Same guard as audiotest.mjs.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return {
          readyState: 3, url, protocol: '',
          addEventListener() {}, removeEventListener() {}, send() {}, close() {},
          set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
        };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`booting ${PAGE} …  (label="${LABEL}")`);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    window.__place = (x, y, z) => {
      window.__forceCamera = true;
      const c = window.__engine.camera;
      c.position.set(x, y, z);
      c.updateMatrixWorld(true);
    };
    /**
     * Sample a set of taps on a fixed 120 ms timer, alongside the model state
     * that is supposed to be driving them. Recording the model next to the
     * signal is what makes it possible to say "this envelope IS the gust"
     * rather than "this envelope moved".
     *
     * Deliberately a `setInterval` and not `requestAnimationFrame`, and
     * deliberately started-then-polled rather than awaited as one long promise.
     * The first version was an rAF loop resolving a single promise after the
     * whole window; a 20 s smoke run returned in seconds and the 260 s run
     * never came back at all. Two causes, both avoided here: an rAF sampler is
     * hostage to the render loop it is trying to measure, and returning ~9000
     * frames × 15 arrays through one `evaluate` is a serialisation cliff. A
     * fixed 120 ms tick is ~1/3 of the analyser's own 341 ms window — the most
     * that can be learned from it anyway — and the samples never leave the page.
     */
    window.__windStart = (taps, ms) => {
      const a = window.__audio;
      const S = window.__windState = {
        taps, ms, done: false, t0: performance.now(),
        t: [], wind: [], model: { grass: [], conifer: [], hush: [] }, rms: {}, peak: {},
      };
      for (const k of taps) { S.rms[k] = []; S.peak[k] = []; }
      S.id = setInterval(() => {
        const st = a.debugState();
        const el = performance.now() - S.t0;
        S.t.push(el / 1000);
        S.wind.push(st.listener.wind);
        S.model.grass.push(st.ambience?.grass ?? 0);
        S.model.conifer.push(st.ambience?.conifer ?? 0);
        S.model.hush.push(st.ambience?.hush ?? 0);
        for (const k of taps) {
          const m = a.measure(k);
          S.rms[k].push(m ? m.rms : 0);
          S.peak[k].push(m ? m.peak : 0);
        }
        if (el >= ms) { clearInterval(S.id); S.done = true; }
      }, 120);
      return true;
    };
    window.__windProgress = () => {
      const S = window.__windState;
      return { done: S.done, n: S.t.length, elapsed: (performance.now() - S.t0) / 1000 };
    };
    /** Hand back the series only once, and only for the taps asked for. */
    window.__windTake = () => {
      const S = window.__windState;
      clearInterval(S.id);
      return { t: S.t, wind: S.wind, model: S.model, rms: S.rms, peak: S.peak };
    };
  });

  // ── gesture, unmute, freeze the sun ───────────────────────────────────────
  await page.keyboard.press('KeyM');            // trusted gesture; also toggles mute
  await page.waitForTimeout(900);
  await page.evaluate(() => { window.__audio.setMuted(false); window.__audio.setVolume(0.75); });
  await page.waitForTimeout(400);

  const boot = await page.evaluate(() => window.__audio.debugState());
  check('audio running', boot.state === 'running', `state=${boot.state} sr=${boot.sampleRate}`);
  const tapNames = await page.evaluate(() => Object.keys(window.__audio.taps ?? {}));
  check('per-layer wind taps present',
        ['windGrass', 'windConifer', 'windHush'].every((k) => tapNames.includes(k)),
        tapNames.join(','));
  if (boot.state !== 'running') { await browser.close(); release(); process.exit(1); }

  const results = { label: LABEL, url: BASE, sampleRate: boot.sampleRate, arms: {} };

  /** Start a sampling window, print progress while it runs, then take the series. */
  const run = async (taps, seconds) => {
    await page.evaluate(([tp, ms]) => window.__windStart(tp, ms), [taps, seconds * 1000]);
    for (;;) {
      await page.waitForTimeout(15000);
      const p = await page.evaluate(() => window.__windProgress());
      process.stdout.write(`    …${p.elapsed.toFixed(0)}/${seconds}s, ${p.n} samples\r`);
      if (p.done) break;
    }
    process.stdout.write('\n');
    return page.evaluate(() => window.__windTake());
  };

  // ── arm 1: open meadow, the grass bed ─────────────────────────────────────
  await page.evaluate(() => {
    window.__lighting.hour = 13.0; window.__lighting.cycleSpeed = 0;   // no chorus, no crickets
    const p = window.__poi.best('meadow');
    // Bring the camper too, not just the camera. Without it the idling engine
    // is a kilometre away and the "wind against everything else" figure below
    // is wind against birds — which is not the mix anybody is complaining
    // about. Parked and idling is the game's own quietest honest listening
    // condition, and it is the same one on every run.
    window.__vehicleTeleport?.(p.x, p.z, 0);
    window.__place(p.x, window.__world.getHeight(p.x, p.z) + 2, p.z);
  });
  await page.waitForTimeout(4000);              // let the Smooth() glides settle

  const live1 = await page.evaluate(() => {
    const a = window.__audio, s = a.debugState().ambience;
    return {
      model: s.grass,
      param: a.ambience.grassGain.gain.value,
      bus: a.buses.ambience.gain.value,
      master: a.master.gain.value,
      open: a.debugState().listener.open,
    };
  });
  check('grass bed is actually running', live1.model > 1e-4 && live1.param > 1e-4 &&
        live1.bus > 0 && live1.master > 0,
        `model=${f(live1.model, 4)} gainParam=${f(live1.param, 4)} bus=${f(live1.bus, 2)} ` +
        `master=${f(live1.master, 2)} L.open=${f(live1.open, 2)}`);

  console.log(`\n── meadow, ${SECONDS}s (${f(SECONDS / 75.7, 1)} gust cycles) ──`);
  const m1 = await run(['windGrass', 'windConifer', 'windHush', 'ambience', 'master'], SECONDS);
  const grass = stats(m1.rms.windGrass, m1.peak.windGrass);
  const ambMeadow = stats(m1.rms.ambience, m1.peak.ambience);
  report('wind / dry grass (tap windGrass)', grass);
  report('whole ambience bus', ambMeadow);
  console.log(`    L.wind over the window: ${f(Math.min(...m1.wind), 3)} … ${f(Math.max(...m1.wind), 3)}` +
              `  (model grass ${f(Math.min(...m1.model.grass), 4)} … ${f(Math.max(...m1.model.grass), 4)})`);
  // Two separate liveness questions, and conflating them is how a dead layer
  // passes. (a) does the SIGNAL follow the mixer — pearson(measured rms, model
  // gain); (b) does the MIXER follow the weather — pearson(model, L.wind). The
  // first can only be answered against the model, because the measured envelope
  // is the model times a swell LFO that knows nothing about the wind.
  const rModel = pearson(m1.rms.windGrass, m1.model.grass);
  const rWind = pearson(m1.model.grass, m1.wind);
  check('grass signal follows its mixer', grass.rms > 1e-4 && rModel > 0.3,
        `pearson(rms, model.grass) = ${f(rModel, 2)} over ${m1.t.length} samples`);
  check('grass mixer follows the weather', rWind > 0.9,
        `pearson(model.grass, L.wind) = ${f(rWind, 2)}`);
  check('meadow window covers >2 gust cycles', SECONDS > 152, `${f(SECONDS / 75.7, 1)} cycles of 75.7 s`);

  // Wind against everything else, at ONE FIXED POINT. This is the controlled
  // masking figure; the driving arm below is not one, because the camper takes
  // a different route on every run and a different route is a different
  // biome mix, a different engine load and a different set of birds. What is
  // comparable across runs is a parked listener at the same POI with the whole
  // graph running, so this is the number to quote when asking whether the wind
  // got quieter *relative to the rest of the game*.
  const gainsM = await page.evaluate(() => ({
    ambienceBus: window.__audio.buses.ambience.gain.value,
    master: window.__audio.master.gain.value,
  }));
  const refM = gainsM.ambienceBus * gainsM.master;
  const shareMeadow = m1.rms.windGrass.map((v, i) =>
    dB(v * refM) - dB(m1.rms.master[i] || 1e-9));
  const gi = m1.wind.indexOf(Math.max(...m1.wind));
  const masterMeadow = stats(m1.rms.master, m1.peak.master);
  console.log(`    master here ${fdB(masterMeadow.rms)} dBFS rms; grass referred forward ` +
              `(${f(dB(refM), 1)} dB) is ${f(pct(shareMeadow, 50), 1)} dB under it at the median, ` +
              `${f(shareMeadow[gi], 1)} dB at the gust peak, ${f(Math.max(...shareMeadow), 1)} dB at its worst`);
  results.arms.meadow = { seconds: SECONDS, grass, ambience: ambMeadow, master: masterMeadow,
                          rModel, rWind, refToMaster_dB: dB(refM),
                          shareMedian_dB: pct(shareMeadow, 50),
                          shareAtGustPeak_dB: shareMeadow[gi],
                          shareWorst_dB: Math.max(...shareMeadow),
                          modelMin: Math.min(...m1.model.grass), modelMax: Math.max(...m1.model.grass),
                          windMin: Math.min(...m1.wind), windMax: Math.max(...m1.wind) };

  // ── arm 2: forest interior, the conifer hiss ──────────────────────────────
  await page.evaluate(() => {
    const p = window.__poi.best('forest');
    window.__place(p.x, window.__world.getHeight(p.x, p.z) + 2, p.z);
  });
  await page.waitForTimeout(6000);

  const live2 = await page.evaluate(() => {
    const a = window.__audio, d = a.debugState();
    return { model: d.ambience.conifer, param: a.ambience.coniferGain.gain.value, forest: d.listener.forest };
  });
  check('conifer bed is actually running', live2.model > 1e-4 && live2.param > 1e-4,
        `model=${f(live2.model, 4)} gainParam=${f(live2.param, 4)} L.forest=${f(live2.forest, 2)}`);

  console.log(`\n── conifer forest, ${FOREST_SECONDS}s ──`);
  const m2 = await run(['windGrass', 'windConifer', 'ambience'], FOREST_SECONDS);
  const conifer = stats(m2.rms.windConifer, m2.peak.windConifer);
  report('wind / conifers (tap windConifer)', conifer);
  results.arms.forest = { seconds: FOREST_SECONDS, conifer,
                          grass: stats(m2.rms.windGrass, m2.peak.windGrass) };

  // ── arm 3: everything at once, driving ────────────────────────────────────
  // "Too loud" is usually "too loud relative to everything else", so this arm
  // measures the wind's share of the mix while the engine, the tyres, the
  // water and the wildlife are all present — and reports that share at the
  // moment the gust envelope peaks, not on average.
  await page.evaluate(() => {
    window.__forceCamera = false;
    window.__lighting.hour = 16.6;
    const p = window.__poi.best('road');
    window.__vehicleTeleport?.(p.x, p.z, 0);
  });
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);

  console.log(`\n── driving, everything on, ${MIX_SECONDS}s ──`);
  const m3 = await run(
    ['windGrass', 'windConifer', 'windHush', 'ambience', 'vehicle', 'water', 'wildlife', 'music', 'master'],
    MIX_SECONDS);
  await page.keyboard.up('KeyW');

  // Wind power is the sum of the three beds' power. The taps are pre-bus and
  // pre-master; `refToMaster` walks them forward through exactly the gains that
  // sit between the tap and the master analyser, so the share below compares
  // two readings of the same point in the chain. Without it the wind reads
  // 10.7 dB hotter than it is and appears to be louder than the whole mix.
  const gains = await page.evaluate(() => ({
    ambienceBus: window.__audio.buses.ambience.gain.value,
    master: window.__audio.master.gain.value,
  }));
  const refToMaster = gains.ambienceBus * gains.master;
  console.log(`  (taps are pre-bus: ambience bus ${f(gains.ambienceBus, 3)} × master ` +
              `${f(gains.master, 3)} = ${f(dB(refToMaster), 1)} dB referred forward)`);
  const n3 = m3.t.length;
  const windRms = [], shareDb = [];
  for (let i = 0; i < n3; i++) {
    const w = Math.sqrt(m3.rms.windGrass[i] ** 2 + m3.rms.windConifer[i] ** 2 + m3.rms.windHush[i] ** 2)
            * refToMaster;
    windRms.push(w);
    shareDb.push(dB(w) - dB(m3.rms.master[i] || 1e-9));
  }
  const gustIdx = m3.wind.indexOf(Math.max(...m3.wind));
  const windDrive = stats(windRms, windRms);
  console.log(`  wind (grass+conifer+hush, power sum, referred to master) rms ${fdB(windDrive.rms)} dBFS` +
              `   p50 ${fdB(windDrive.p50)}  p95 ${fdB(windDrive.p95)}  max ${fdB(windDrive.max)}`);
  console.log('  bus levels while driving (rms / peak, dBFS):');
  const perBus = {};
  for (const k of ['ambience', 'vehicle', 'water', 'wildlife', 'music', 'master']) {
    const s = stats(m3.rms[k], m3.peak[k]);
    perBus[k] = s;
    console.log(`    ${k.padEnd(9)} ${fdB(s.rms)} / ${fdB(s.peak)}   p95 ${fdB(s.p95)}`);
  }
  console.log('  (route-dependent: two runs drive to different ground, so read the WORST' +
              ' figure here and the parked meadow arm for a controlled comparison)');
  console.log(`  wind share of master:  median ${f(pct(shareDb, 50), 1)} dB   ` +
              `at gust peak (L.wind=${f(m3.wind[gustIdx], 3)}) ${f(shareDb[gustIdx], 1)} dB   ` +
              `worst ${f(Math.max(...shareDb), 1)} dB`);
  check('wind does not swamp the mix while driving', Math.max(...shareDb) < -3,
        `worst instantaneous wind-vs-master ${f(Math.max(...shareDb), 1)} dB`);
  results.arms.driving = {
    seconds: MIX_SECONDS, wind: windDrive, buses: perBus, refToMaster_dB: dB(refToMaster),
    shareMedian_dB: pct(shareDb, 50), shareAtGustPeak_dB: shareDb[gustIdx],
    shareWorst_dB: Math.max(...shareDb), windAtGustPeak: m3.wind[gustIdx],
  };

  const mine = errors.filter((e) => /src\/audio\//.test(e));
  check('no errors from audio', mine.length === 0, mine.slice(0, 2).join(' | ') || 'clean');

  if (OUT) { writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log(`\nwrote ${OUT}`); }
  await browser.close();
  release();
  console.log(`\n${failures ? `${failures} assertion(s) FAILED` : 'all liveness assertions passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

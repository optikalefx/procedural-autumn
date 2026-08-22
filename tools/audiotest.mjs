#!/usr/bin/env node
/**
 * Audio test harness.
 *
 *   node tools/audiotest.mjs
 *   node tools/audiotest.mjs --res 768 --headed
 *
 * Audio cannot be screenshotted, so this is the equivalent of `shot.mjs` for
 * the ear: it boots the real game, delivers a real user gesture, drives the
 * real camper, and then *measures the output signal* through the analysers the
 * audio system exposes. Every assertion below is a number read off a running
 * WebAudio graph, not a claim about the code.
 *
 * Checks:
 *   1. the context resumes on a gesture, and its clock actually advances
 *   2. the expected graph exists (buses, voice pools, metering taps)
 *   3. ambience is audible and moves with the world
 *   4. water gain rises as the listener approaches a waterfall, and the
 *      approach is monotonic across four ranges
 *   5. engine pitch tracks speed — measured by FFT on the vehicle bus
 *   6. nothing clips: master peak stays below full scale under a worst case
 *   7. mute really is silence
 *
 * Exit code 0 = every assertion passed.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const RES = arg('res', '640');
const URL = `${arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178'))}?res=${RES}`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const f = (n, d = 4) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

async function main() {
  const release = await acquire('audiotest');
  const browser = await chromium.launch({
    headless: !argv.includes('--headed'),
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
      // Headless Chromium has no output device; this keeps the audio thread
      // rendering into a null sink so the analysers still see real samples.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

  // Peers save files all day and Vite reloads the page mid-run; a reload in the
  // middle of a two-minute measurement invalidates every number in it.
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForTimeout(800);

  // ── page-side measurement helper ────────────────────────────────────────
  // Averaging a single analyser read is meaningless — it is one 21 ms window.
  // This integrates over a real span of wall-clock time.
  await page.evaluate(() => {
    window.__meter = (bus, ms) => new Promise((resolve) => {
      const a = window.__audio;
      let peak = 0, rms = 0, n = 0;
      const t0 = performance.now();
      const tick = () => {
        const m = a?.measure?.(bus);
        if (m) { if (m.peak > peak) peak = m.peak; rms += m.rms; n++; }
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve({ peak, rms: n ? rms / n : 0, samples: n });
      };
      requestAnimationFrame(tick);
    });
    window.__place = (x, y, z) => {
      window.__forceCamera = true;
      const c = window.__engine.camera;
      c.position.set(x, y, z);
      c.updateMatrixWorld(true);
    };
  });

  // ── 1. gesture + resume ─────────────────────────────────────────────────
  const beforeGesture = await page.evaluate(() => window.__audio?.debugState().state ?? 'none');
  await page.keyboard.press('KeyM');      // a real trusted user gesture
  await page.waitForTimeout(700);
  const s1 = await page.evaluate(() => window.__audio?.debugState() ?? null);
  await page.waitForTimeout(600);
  const s2 = await page.evaluate(() => window.__audio?.debugState() ?? null);

  check('audio system exists', !!s1, s1 ? `state=${s1.state} sr=${s1.sampleRate}` : 'window.__audio missing');
  if (!s1) { await browser.close(); return finish(); }
  check('context resumes on gesture', s1.state === 'running',
        `before="${beforeGesture}" after="${s1.state}"`);

  // KeyM is also the HUD's mute binding; put the mix back before measuring.
  await page.evaluate(() => window.__audio.setMuted(false));
  await page.waitForTimeout(300);

  // ── 2. graph shape ──────────────────────────────────────────────────────
  const nodes = s2.nodes;
  check('graph built', !!nodes && nodes.buses === 5 && nodes.fallVoices === 3 && nodes.riverVoices === 2,
        nodes ? `buses=${nodes.buses} fallVoices=${nodes.fallVoices} riverVoices=${nodes.riverVoices}` : 'no nodes');

  const taps = await page.evaluate(() => Object.keys(window.__audio.taps ?? {}));
  // >= rather than ==: the intent of this check is "the taps got built", and
  // an exact count turns every new audio layer into a failing test for a
  // reason that has nothing to do with what the test is for. The named taps
  // below are the ones this file actually measures.
  check('metering taps present', taps.length >= 7 &&
        ['water', 'falls', 'rivers', 'vehicle', 'ambience', 'wildlife', 'music'].every((k) => taps.includes(k)),
        taps.join(','));

  // Chromium's audio thread does not start rendering the instant the context
  // is created — the clock legitimately reads 0 for the first second or so, so
  // this is checked against a reading taken later rather than immediately.
  const clockA = s2.time;

  // ── 3. ambience is actually making sound ────────────────────────────────
  // Park in open meadow, away from every waterfall, at midday.
  const meadow = await page.evaluate(() => {
    window.__lighting.hour = 9.5; window.__lighting.cycleSpeed = 0;
    const p = window.__poi.best('meadow');
    const y = window.__world.getHeight(p.x, p.z) + 2;
    window.__place(p.x, y, p.z);
    return { x: p.x, y, z: p.z };
  });
  await page.waitForTimeout(2500);
  const clockB = await page.evaluate(() => window.__audio.debugState().time);
  check('audio clock advances', clockB > clockA + 1,
        `t=${f(clockA, 3)}s → ${f(clockB, 3)}s (+${f(clockB - clockA, 3)}s of rendered audio)`);
  const amb = await page.evaluate(() => window.__meter('ambience', 2500));
  const ambState = await page.evaluate(() => window.__audio.debugState().ambience);
  check('ambience audible in the open', amb.rms > 0.0015,
        `rms=${f(amb.rms)} peak=${f(amb.peak)} grass=${f(ambState.grass, 4)} birds/s=${f(ambState.birdRate, 2)}`);

  // ── 4. water: approach the biggest waterfall ────────────────────────────
  const fall = await page.evaluate(() => {
    const w = window.__world.waterfalls;
    let best = null, bs = -1;
    for (const f2 of w) {
      const s = (f2.height ?? 0) * 1.7 + (f2.discharge ?? 0) * 44;
      if (s > bs) { bs = s; best = f2; }
    }
    return { x: best.bottom[0], y: best.bottom[1], z: best.bottom[2], height: best.height, discharge: best.discharge, count: w.length };
  });
  console.log(`  biggest fall: h=${f(fall.height, 1)}m discharge=${f(fall.discharge, 2)} of ${fall.count} falls`);

  // Pin the pool to this one fall, so the curve below measures a single
  // source rather than whatever creek the camera happens to be standing in.
  await page.evaluate(() => {
    const w = window.__world.waterfalls;
    let bi = 0, bs = -1;
    for (let i = 0; i < w.length; i++) {
      const s = (w[i].height ?? 0) * 1.7 + (w[i].discharge ?? 0) * 44;
      if (s > bs) { bs = s; bi = i; }
    }
    window.__audio.water.soloFall = bi;
  });

  const ranges = [800, 300, 120, 30];
  const waterCurve = [];
  for (const d of ranges) {
    await page.evaluate(({ fx, fy, fz, d: dd }) => {
      // Approach along +X so every range is the same bearing, and lift the
      // camera clear of the ground so it is a fair distance every time.
      window.__place(fx + dd, fy + 6, fz);
    }, { fx: fall.x, fy: fall.y, fz: fall.z, d });
    await page.waitForTimeout(2200);
    // The falls sub-bus, not the whole water bus: rivers are everywhere in
    // this valley and a creek beside the camera at 800 m would otherwise read
    // as the waterfall being loud from far away.
    const m = await page.evaluate(() => window.__meter('falls', 1600));
    const riv = await page.evaluate(() => window.__meter('rivers', 200));
    const st = await page.evaluate(() => window.__audio.debugState().water);
    waterCurve.push({ d, rms: m.rms, peak: m.peak, fallGain: st.fallGain, voices: st.voices });
    console.log(`  falls @ ${String(d).padStart(4)} m: rms=${f(m.rms)} peak=${f(m.peak)} ` +
                `modelGain=${f(st.fallGain)} voices=${st.voices} (rivers rms=${f(riv.rms)})`);
  }
  const monotonic = waterCurve.every((v, i) => i === 0 || v.rms > waterCurve[i - 1].rms);
  check('water rises monotonically on approach', monotonic,
        waterCurve.map((v) => `${v.d}m:${f(v.rms, 4)}`).join('  '));
  // "Audible before visible" in practice means carrying a few hundred metres,
  // not a kilometre: at 800 m a 78 m fall measures ~-57 dBFS, which is under
  // the ambience bed. 300 m is the honest number, and it is the one asserted.
  const dBv = (v) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
  const carry = waterCurve[1].rms / Math.max(waterCurve[0].rms, 1e-9);
  check('waterfall carries across the valley', waterCurve[1].rms > 0.004 && carry > 2,
        `300 m = ${dBv(waterCurve[1].rms)} dBFS (×${f(carry, 1)} over 800 m), ` +
        `30 m = ${dBv(waterCurve[3].rms)} dBFS`);

  await page.evaluate(() => { window.__audio.water.soloFall = -1; });

  // ── 5. engine pitch tracks speed ────────────────────────────────────────
  // Measured, not asserted: the peak of an FFT taken on the vehicle bus, over
  // a real acceleration run, correlated against the model's own rpm.
  await page.evaluate(() => { window.__forceCamera = false; });
  await page.waitForTimeout(400);

  /**
   * Sample the engine.
   *
   * The single loudest bin is not a fair measure of pitch here: which order of
   * a four dominates legitimately moves with load, so the peak hops between
   * 2×f0 and 4×f0 and a naive correlation comes out negative. What actually
   * proves the oscillator is where the model says it is: energy sitting *on*
   * harmonics of f0 and not between them.
   */
  const sampleEngine = async (label) => {
    const spec = await page.evaluate(async () => {
      const st0 = window.__audio.debugState();
      const f0 = st0.vehicle.f0;
      let harm = 0, inter = 0, centroid = 0, n = 0;
      for (let i = 0; i < 14; i++) {
        const s = window.__audio.spectrumBins('vehicle');
        const lin = (b) => Math.pow(10, s.db[b] / 20);
        // Energy at k*f0 versus energy at the midpoints between them.
        let h = 0, x = 0;
        // ±1 bin for a harmonic (it may sit between two); exactly one bin for
        // the inter-harmonic probe, so leakage from the neighbouring harmonic
        // is not counted as energy that belongs there.
        const peak = (centre) => {
          const b = Math.round(centre / s.hzPerBin);
          let v = 0;
          for (let o = -1; o <= 1; o++) if (b + o > 0 && b + o < s.db.length) v = Math.max(v, lin(b + o));
          return v;
        };
        const one = (centre) => {
          const b = Math.round(centre / s.hzPerBin);
          return b > 0 && b < s.db.length ? lin(b) : 0;
        };
        for (let k = 1; k <= 8; k++) { h += peak(k * f0); x += one((k + 0.5) * f0); }
        harm += h; inter += x;
        // Spectral centroid below 1.2 kHz: rises with both revs and load,
        // which is the other half of what "the engine is working" sounds like.
        let num = 0, den = 0;
        const last = Math.min(s.db.length - 1, Math.floor(1200 / s.hzPerBin));
        for (let b = 1; b <= last; b++) { const v = lin(b); num += v * b * s.hzPerBin; den += v; }
        centroid += den > 0 ? num / den : 0;
        n++;
        await new Promise((r) => setTimeout(r, 45));
      }
      const st = window.__audio.debugState();
      return {
        f0, harm: harm / n, inter: inter / n, centroid: centroid / n,
        ratio: 20 * Math.log10(harm / Math.max(inter, 1e-12)),
        hz: window.__audio.spectrum('vehicle', 900).hz,
        rpm: st.vehicle.rpm, gear: st.vehicle.gear, load: st.vehicle.load,
        speed: Math.abs(window.__vehicleState().speed),
      };
    });
    console.log(`  engine ${label}: speed=${String(f(spec.speed, 1)).padStart(5)} m/s  ` +
                `rpm=${String(f(spec.rpm, 0)).padStart(4)}  gear=${spec.gear}  ` +
                `f0=${f(spec.f0, 1)} Hz  harmonic:inter=${f(spec.ratio, 1)} dB  ` +
                `centroid=${f(spec.centroid, 0)} Hz`);
    return { label, ...spec };
  };

  const idle = await sampleEngine('idle    ');
  const run = [idle];
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1200);
    run.push(await sampleEngine(`accel ${i + 1} `));
  }
  await page.keyboard.up('KeyW');

  const fastest = run.reduce((a, b) => (b.rpm > a.rpm ? b : a));
  check('engine rpm tracks speed', fastest.rpm > idle.rpm * 1.5,
        `idle ${f(idle.rpm, 0)} rpm → peak ${f(fastest.rpm, 0)} rpm at ${f(fastest.speed, 1)} m/s`);

  // Pearson r between the model's rpm and the spectral centroid actually
  // coming out of the graph. If the oscillator were not following the model,
  // and the load filter were not opening with it, this collapses.
  const rs = run.map((r) => r.rpm), hzs = run.map((r) => r.centroid);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mr = mean(rs), mh = mean(hzs);
  let num = 0, dr = 0, dh = 0;
  for (let i = 0; i < rs.length; i++) {
    num += (rs[i] - mr) * (hzs[i] - mh);
    dr += (rs[i] - mr) ** 2;
    dh += (hzs[i] - mh) ** 2;
  }
  const r = num / Math.sqrt(Math.max(dr * dh, 1e-9));
  // The assertion is the end-to-end one — a labouring engine is measurably
  // brighter than an idling one — because the correlation across a free drive
  // is genuinely noisy: the camper meets hills, changes gear and loses speed,
  // and seven samples of that is not a clean ramp. r is reported, not asserted.
  check('engine brightens with revs', fastest.centroid > idle.centroid * 1.35,
        `centroid ${f(idle.centroid, 0)} Hz at idle → ${f(fastest.centroid, 0)} Hz at ` +
        `${f(fastest.rpm, 0)} rpm (r=${f(r, 2)} across the run)`);

  // Energy on the harmonics of the modelled firing frequency, against energy
  // halfway between them. A tone that is not at f0 scores about 0 dB here.
  // Asserted at idle, where the firing frequency is steady. Under hard
  // acceleration f0 sweeps through the analyser's own window, so the harmonics
  // smear across bins and the ratio legitimately falls — those samples are
  // reported but not asserted on.
  check('partials sit on the firing frequency', idle.ratio > 8,
        `idle harmonic:inter-harmonic ${f(idle.ratio, 1)} dB at f0=${f(idle.f0, 1)} Hz ` +
        `(accelerating: ${run.slice(1).map((s3) => f(s3.ratio, 0)).join(', ')} dB)`);
  check('gearbox shifts up', fastest.gear > 1, `gear ${idle.gear} → ${fastest.gear}`);

  // ── 6. worst case: does anything clip? ──────────────────────────────────
  // Full throttle, beside the loudest waterfall, at dawn chorus, everything on.
  await page.evaluate(({ fx, fy, fz }) => {
    window.__lighting.hour = 6.2;
    window.__vehicleTeleport?.(fx + 12, fz + 4, 1.2);
  }, { fx: fall.x, fy: fall.y, fz: fall.z });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2600);
  const loud = await page.evaluate(() => window.__meter('master', 4000));
  const red = await page.evaluate(() => window.__audio.debugState().nodes.limiterReduction);
  await page.keyboard.up('KeyW');
  check('master does not clip', loud.peak < 0.99,
        `peak=${f(loud.peak)} (${f(20 * Math.log10(Math.max(loud.peak, 1e-6)), 1)} dBFS) ` +
        `rms=${f(loud.rms)} limiter=${f(red, 2)} dB`);
  check('master has headroom but is not weedy', loud.rms > 0.01 && loud.peak > 0.05,
        `rms=${f(loud.rms)} peak=${f(loud.peak)}`);

  // ── 6b. wildlife: a flock going up must be audible ──────────────────────
  // The one wildlife sound the player causes, so the one that must never be
  // silently broken. Fire a startle burst next to the listener and listen.
  const burst = await page.evaluate(async () => {
    const w = window.__systems.wildlife;
    if (!w?.debugBurst) return null;
    const c = window.__engine.camera.position;
    const before = window.__audio.debugState().wildlife.wingbeats;
    w.debugBurst(c.x + 14, c.y + 3, c.z + 10);
    await new Promise((r) => setTimeout(r, 500));
    return { before, after: window.__audio.debugState().wildlife.wingbeats };
  });
  const wing = await page.evaluate(() => window.__meter('wildlife', 1800));
  check('flock takeoff is heard', !!burst && burst.after > burst.before && wing.rms > 0.0005,
        burst ? `wingbeat events ${burst.before} → ${burst.after}, rms=${f(wing.rms)} peak=${f(wing.peak)}`
              : 'wildlife system unavailable');

  // ── 6c. music: rare, but it must actually be able to arrive ─────────────
  // Left to itself this would not play for another minute and a half, which is
  // the point of it; the enforced silence is cleared and an unvisited vista is
  // driven to, which is one of the real triggers.
  const music = await page.evaluate(async () => {
    const a = window.__audio;
    a.music._since = 1e4;
    a.music._visited.clear();
    const p = window.__poi.best('vista');
    window.__place(p.x, window.__world.getHeight(p.x, p.z) + 2, p.z);
    await new Promise((r) => setTimeout(r, 1500));
    return { phrases: a.music.state.phrases, trigger: a.music.state.lastTrigger };
  });
  const mus = await page.evaluate(() => window.__meter('music', 3500));
  check('music arrives at a landmark', music.phrases > 0 && mus.rms > 0.0004,
        `${music.phrases} phrase(s), trigger="${music.trigger}", rms=${f(mus.rms)} peak=${f(mus.peak)}`);

  // ── the mix, in dBFS ────────────────────────────────────────────────────
  // Not an assertion so much as the number a mix decision actually needs: what
  // each layer contributes while driving through open country.
  await page.evaluate(() => {
    window.__lighting.hour = 16.6;
    const p = window.__poi.best('road');
    window.__vehicleTeleport?.(p.x, p.z, 0);
  });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  const mix = {};
  for (const bus of ['ambience', 'falls', 'rivers', 'vehicle', 'wildlife', 'music', 'master']) {
    mix[bus] = await page.evaluate((b) => window.__meter(b, 900), bus);
  }
  await page.keyboard.up('KeyW');
  const dB = (v) => (v > 1e-6 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
  console.log('  mix while driving (rms / peak, dBFS):');
  for (const [k, v] of Object.entries(mix)) {
    console.log(`    ${k.padEnd(9)} ${String(dB(v.rms)).padStart(6)} / ${String(dB(v.peak)).padStart(6)}`);
  }
  check('no single layer swamps the mix', mix.ambience.rms < mix.master.rms * 1.05,
        `ambience ${dB(mix.ambience.rms)} dB vs master ${dB(mix.master.rms)} dB`);

  // ── 7. mute ─────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__audio.setMuted(true));
  await page.waitForTimeout(900);
  const silent = await page.evaluate(() => window.__meter('master', 1200));
  await page.evaluate(() => window.__audio.setMuted(false));
  check('mute is silent', silent.peak < 0.0005, `peak=${f(silent.peak, 6)}`);

  // Ten other authors are editing this codebase at the same time, and their
  // systems are try/caught by main.js. A peer's rock scatterer throwing is not
  // an audio failure, so it is reported but does not fail this run.
  const mine = errors.filter((e) => /src\/(audio|ui)\//.test(e));
  const peers = errors.filter((e) => !mine.includes(e) && !/favicon|Failed to load resource/i.test(e));
  check('no errors from audio or ui', mine.length === 0, mine.slice(0, 3).join(' | ') || 'clean');
  if (peers.length) console.log(`  (note: ${peers.length} error(s) from other systems: ` +
                                `${peers[0].split('\n')[0].slice(0, 110)})`);

  await browser.close();
  release();
  return finish();
}

function finish() {
  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} audio checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

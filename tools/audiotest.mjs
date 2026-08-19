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
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

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
  check('audio clock advances', s2.time > s1.time,
        `t=${f(s1.time, 3)}s → ${f(s2.time, 3)}s (+${f(s2.time - s1.time, 3)}s)`);

  // KeyM is also the HUD's mute binding; put the mix back before measuring.
  await page.evaluate(() => window.__audio.setMuted(false));
  await page.waitForTimeout(300);

  // ── 2. graph shape ──────────────────────────────────────────────────────
  const nodes = s2.nodes;
  check('graph built', !!nodes && nodes.buses === 5 && nodes.fallVoices === 3 && nodes.riverVoices === 2,
        nodes ? `buses=${nodes.buses} fallVoices=${nodes.fallVoices} riverVoices=${nodes.riverVoices}` : 'no nodes');

  const taps = await page.evaluate(() => Object.keys(window.__audio.taps ?? {}));
  check('metering taps present', taps.length === 4, taps.join(','));

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

  const ranges = [800, 300, 120, 30];
  const waterCurve = [];
  for (const d of ranges) {
    await page.evaluate(({ fx, fy, fz, d: dd }) => {
      // Approach along +X so every range is the same bearing, and lift the
      // camera clear of the ground so it is a fair distance every time.
      window.__place(fx + dd, fy + 6, fz);
    }, { fx: fall.x, fy: fall.y, fz: fall.z, d });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => window.__meter('water', 1600));
    const st = await page.evaluate(() => window.__audio.debugState().water);
    waterCurve.push({ d, rms: m.rms, peak: m.peak, fallGain: st.fallGain, voices: st.voices });
    console.log(`  water @ ${String(d).padStart(4)} m: rms=${f(m.rms)} peak=${f(m.peak)} modelGain=${f(st.fallGain)} voices=${st.voices}`);
  }
  const monotonic = waterCurve.every((v, i) => i === 0 || v.rms > waterCurve[i - 1].rms);
  check('water rises monotonically on approach', monotonic,
        waterCurve.map((v) => `${v.d}m:${f(v.rms, 4)}`).join('  '));
  const ratio = waterCurve[3].rms / Math.max(waterCurve[0].rms, 1e-9);
  check('waterfall is audible before it is visible', waterCurve[0].rms > 0.0008 && ratio > 4,
        `800 m rms=${f(waterCurve[0].rms)}, 30 m rms=${f(waterCurve[3].rms)}, ×${f(ratio, 1)}`);

  // ── 5. engine pitch tracks speed ────────────────────────────────────────
  await page.evaluate(() => { window.__forceCamera = false; });
  await page.waitForTimeout(400);
  const engine = [];
  const sampleEngine = async (label) => {
    const spec = await page.evaluate(async () => {
      // Average the FFT peak over a second so a single frame's noise cannot
      // decide the result.
      const out = [];
      for (let i = 0; i < 20; i++) {
        out.push(window.__audio.spectrum('vehicle', 900));
        await new Promise((r) => setTimeout(r, 50));
      }
      const hz = out.map((o) => o.hz).sort((a, b) => a - b)[10];
      const st = window.__audio.debugState();
      return { hz, rpm: st.vehicle.rpm, gear: st.vehicle.gear, f0: st.vehicle.f0, speed: window.__vehicleState().speed };
    });
    engine.push({ label, ...spec });
    console.log(`  engine ${label}: speed=${f(spec.speed, 1)} m/s rpm=${f(spec.rpm, 0)} gear=${spec.gear} ` +
                `model f0=${f(spec.f0, 1)} Hz  measured peak=${f(spec.hz, 1)} Hz`);
    return spec;
  };

  await sampleEngine('idle  ');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3500);
  await sampleEngine('moving');
  await page.waitForTimeout(6000);
  await sampleEngine('fast  ');

  const [idle, moving, fast] = engine;
  check('engine rpm tracks speed', fast.rpm > idle.rpm * 1.25 && moving.rpm >= idle.rpm,
        `idle ${f(idle.rpm, 0)} → moving ${f(moving.rpm, 0)} → fast ${f(fast.rpm, 0)} rpm`);
  check('measured engine pitch rises with speed', fast.hz > idle.hz * 1.15,
        `${f(idle.hz, 1)} Hz → ${f(fast.hz, 1)} Hz (model ${f(idle.f0, 1)} → ${f(fast.f0, 1)} Hz)`);
  check('gearbox shifts up', fast.gear > 1, `gear ${idle.gear} → ${fast.gear}`);

  // ── 6. worst case: does anything clip? ──────────────────────────────────
  // Full throttle, beside the loudest waterfall, at dawn chorus, everything on.
  await page.evaluate(({ fx, fy, fz }) => {
    window.__lighting.hour = 6.2;
    window.__vehicleTeleport?.(fx + 12, fz + 4, 1.2);
  }, { fx: fall.x, fy: fall.y, fz: fall.z });
  await page.waitForTimeout(2600);
  const loud = await page.evaluate(() => window.__meter('master', 4000));
  const red = await page.evaluate(() => window.__audio.debugState().nodes.limiterReduction);
  await page.keyboard.up('KeyW');
  check('master does not clip', loud.peak < 0.99,
        `peak=${f(loud.peak)} (${f(20 * Math.log10(Math.max(loud.peak, 1e-6)), 1)} dBFS) ` +
        `rms=${f(loud.rms)} limiter=${f(red, 2)} dB`);
  check('master has headroom but is not weedy', loud.rms > 0.01 && loud.peak > 0.05,
        `rms=${f(loud.rms)} peak=${f(loud.peak)}`);

  // ── 7. mute ─────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__audio.setMuted(true));
  await page.waitForTimeout(900);
  const silent = await page.evaluate(() => window.__meter('master', 1200));
  await page.evaluate(() => window.__audio.setMuted(false));
  check('mute is silent', silent.peak < 0.0005, `peak=${f(silent.peak, 6)}`);

  const fatal = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('no page errors', fatal.length === 0, fatal.slice(0, 3).join(' | ') || 'clean');

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

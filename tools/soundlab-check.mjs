#!/usr/bin/env node
/**
 * Sound Lab self-check.
 *
 *   node tools/soundlab-check.mjs
 *   node tools/soundlab-check.mjs --only water.waterfall --seconds 4
 *
 * A sound tool that looks right and outputs silence is the exact failure mode
 * this page exists to prevent, so it is not allowed to be verified by looking
 * at it. This drives the real page in a headless browser and asserts on the
 * *meter*, not on the absence of an error:
 *
 *   1. the gate really does start a running AudioContext
 *   2. every sound in the dropdown produces measurable signal on its own bus
 *   3. changing a parameter moves the measurement
 *   4. distance really attenuates the sounds that are levelled by distance
 *   5. a config round-trips out and back in with the state intact
 *   6. no console errors along the way
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
const URL = String(arg('url', 'http://127.0.0.1:5178')) + '/sound.html';
const SECONDS = +arg('seconds', 2.2);
const ONLY = arg('only', null);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};
const dB = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -Infinity);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf');

async function main() {
  const release = await acquire('soundlab');
  const browser = await chromium.launch({
    headless: true,
    // Headless Chromium has no output device; this keeps the audio thread
    // rendering into a null sink so the analysers still see real samples.
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // Peers save files all day and Vite reloads the page mid-run.
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

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__lab, null, { timeout: 20000 });
  check('page loads without the game', true, `${Date.now() - t0} ms to interactive`);

  // ── 1. the gate ─────────────────────────────────────────────────────────
  await page.click('#start');
  await page.waitForTimeout(500);
  const ctx = await page.evaluate(() => {
    const r = window.__soundlab;
    return r ? { started: r.audio.started, state: r.actx.state, sr: r.actx.sampleRate,
                 buses: Object.keys(r.audio.buses).length, taps: Object.keys(r.audio.taps).length,
                 trims: Object.keys(r.trims).length } : null;
  });
  check('gate starts a running context', !!ctx && ctx.started && ctx.state === 'running',
    ctx ? `${ctx.state} @ ${ctx.sr} Hz, ${ctx.buses} buses, ${ctx.taps} taps, ${ctx.trims} trims` : 'no rig');

  // Page-side integrator: peak of the rms envelope over a window. One analyser
  // read is a 340 ms slice and lands wherever it lands on a gust.
  await page.evaluate(() => {
    window.__peakRms = (bus, ms) => new Promise((resolve) => {
      const a = window.__soundlab.audio;
      let peak = 0, sum = 0, n = 0;
      const t0 = performance.now();
      const tick = () => {
        const m = a.measure(bus);
        if (m) { if (m.rms > peak) peak = m.rms; sum += m.rms; n++; }
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else resolve({ peak, mean: n ? sum / n : 0, n });
      };
      requestAnimationFrame(tick);
    });
  });

  const ids = await page.evaluate(() => window.__lab.sounds());
  check('catalogue enumerates every module', ids.length >= 20, `${ids.length} sounds`);

  // ── 2. every sound makes signal ─────────────────────────────────────────
  const list = ONLY ? ids.filter((i) => i.includes(ONLY)) : ids;
  const quiet = [];
  for (const id of list) {
    const info = await page.evaluate(async ({ id, ms }) => {
      const lab = window.__lab;
      lab.select(id);
      await new Promise((r) => setTimeout(r, 120));
      const sound = window.__soundlab;
      const bus = document.querySelector('#meterBus').value;
      const kind = document.querySelector('#kind').textContent;
      let m;
      if (kind === 'one-shot') {
        const p = window.__peakRms(bus, ms);
        lab.trigger();
        m = await p;
      } else {
        await lab.play();
        await new Promise((r) => setTimeout(r, 400));
        const p = window.__peakRms(bus, ms);
        // Birdsong is a bed whose events are *scheduled* at a modelled rate, so
        // a short window can legitimately contain no call. Nudge it rather than
        // measure a coin toss.
        if (!document.querySelector('#trigger').hidden) {
          for (const at of [50, ms * 0.4]) setTimeout(() => lab.trigger(), at);
        }
        m = await p;
        lab.stop();
      }
      void sound;
      return { bus, kind, ...m };
    }, { id, ms: SECONDS * 1000 });
    const db = dB(info.peak);
    const ok = db > -88;
    if (!ok) quiet.push(id);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${id.padEnd(22)} ${info.kind.padEnd(15)} ` +
      `bus ${info.bus.padEnd(10)} peak ${f(db).padStart(7)} dBFS   mean ${f(dB(info.mean)).padStart(7)}`);
    results.push({ name: `signal: ${id}`, pass: ok });
  }
  check('every sound produces signal', quiet.length === 0,
    quiet.length ? `silent: ${quiet.join(', ')}` : `${list.length} sounds, all audible`);

  // ── 3. a parameter change moves the meter ───────────────────────────────
  const moved = await page.evaluate(async () => {
    const lab = window.__lab;
    lab.select('ambience.grass');
    await new Promise((r) => setTimeout(r, 150));
    await lab.play();
    // The floor of the weather's real range, not the middle of the slider: the
    // breeze curve saturates at wind 1.26, so 1.0 → 2.2 is only the top 4 dB.
    lab.setParam('wind', 0.35);
    await new Promise((r) => setTimeout(r, 1600));
    const before = await window.__peakRms('ambience', 1600);
    lab.setParam('wind', 2.2);
    await new Promise((r) => setTimeout(r, 1600));
    const after = await window.__peakRms('ambience', 1600);
    lab.setParam('wind', 1.0);
    lab.stop();
    return { before: before.mean, after: after.mean };
  });
  const windDelta = dB(moved.after) - dB(moved.before);
  check('a parameter change is audible on the meter', windDelta > 6,
    `wind 0.35 → 2.2 moved the ambience bus ${f(windDelta)} dB`);

  // ── 4. distance attenuates ──────────────────────────────────────────────
  for (const [id, bus, near, far] of [['water.waterfall', 'falls', 10, 500], ['water.river', 'rivers', 3, 150]]) {
    const d = await page.evaluate(async ({ id, bus, near, far }) => {
      const lab = window.__lab;
      lab.select(id);
      await new Promise((r) => setTimeout(r, 150));
      await lab.play();
      lab.setParam('distance', near);
      await new Promise((r) => setTimeout(r, 1400));
      const a = await window.__peakRms(bus, 1400);
      lab.setParam('distance', far);
      await new Promise((r) => setTimeout(r, 1600));
      const b = await window.__peakRms(bus, 1400);
      lab.stop();
      return { near: a.mean, far: b.mean };
    }, { id, bus, near, far });
    const drop = dB(d.near) - dB(d.far);
    check(`${id}: distance attenuates`, drop > 10,
      `${near} m ${f(dB(d.near))} dBFS → ${far} m ${f(dB(d.far))} dBFS  (${f(drop)} dB)`);
  }

  // ── 4b. surface changes the tyre layer ──────────────────────────────────
  const tyres = await page.evaluate(async () => {
    const lab = window.__lab;
    lab.select('vehicle.tyres');
    await new Promise((r) => setTimeout(r, 150));
    await lab.play();
    const one = async (s) => {
      lab.setParam('surface', s);
      await new Promise((r) => setTimeout(r, 900));
      return (await window.__peakRms('vehicle', 1200)).mean;
    };
    const grass = await one('grass');
    const rock = await one('rock');
    lab.stop();
    return { grass, rock };
  });
  check('tyres: grass is quieter than bare rock', dB(tyres.rock) > dB(tyres.grass),
    `grass ${f(dB(tyres.grass))} dBFS, rock ${f(dB(tyres.rock))} dBFS ` +
    `(${f(dB(tyres.rock) - dB(tyres.grass))} dB)`);

  // ── 5. config round-trip ────────────────────────────────────────────────
  const trip = await page.evaluate(async () => {
    const lab = window.__lab;
    lab.select('water.waterfall');
    await new Promise((r) => setTimeout(r, 150));
    lab.setParam('distance', 137);
    lab.setParam('fallExp', 2.1);
    lab.setParam('bodyHz', 900);
    lab.setTrim('falls', -6);
    await new Promise((r) => setTimeout(r, 150));
    const json = lab.json();
    const saved = { ...lab.vals(), _trim: lab.trims().falls };
    // Wipe it, then restore from the config alone.
    document.querySelector('#resetAll').click();
    await new Promise((r) => setTimeout(r, 150));
    const wiped = { ...lab.vals(), _trim: lab.trims().falls };
    lab.setJson(json);
    lab.applyJson();
    await new Promise((r) => setTimeout(r, 250));
    const restored = { ...lab.vals(), _trim: lab.trims().falls };
    return { json, saved, wiped, restored };
  });
  const same = ['distance', 'fallExp', 'bodyHz', '_trim']
    .every((k) => Math.abs(trip.saved[k] - trip.restored[k]) < 1e-6);
  const wasWiped = trip.wiped.distance !== trip.saved.distance;
  check('config round-trips out and back in', same && wasWiped,
    `distance ${trip.saved.distance} → wiped ${trip.wiped.distance} → ${trip.restored.distance}, ` +
    `fallExp ${trip.restored.fallExp}, trim ${trip.restored._trim} dB`);

  const cfg = JSON.parse(trip.json);
  const isDiff = !('bodyQ' in (cfg.params ?? {})) && cfg.params?.fallExp === 2.1;
  check('the config is a diff, not a dump', isDiff,
    `${Object.keys(cfg.params ?? {}).length} params, ${Object.keys(cfg.conditions ?? {}).length} conditions`);
  console.log('\n── emitted config ───────────────────────────────────────────');
  console.log(trip.json);
  console.log('─────────────────────────────────────────────────────────────\n');

  // ── 6. clean console ────────────────────────────────────────────────────
  const real = errors.filter((e) => !/soundlab: deferred/.test(e));
  check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

  await browser.close();
  await release?.();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log(failed.map((x) => `  ✗ ${x.name}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

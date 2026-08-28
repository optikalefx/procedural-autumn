#!/usr/bin/env node
/**
 * roastopen — the three round-7 assertions a contact sheet cannot make.
 *
 *   node tools/_scratch/roastopen.mjs --hour 20.4
 *
 * `roastshot.mjs` pins the height, the doneness and the spin for every frame it
 * shoots, which is right — a judged frame has to be a frame of a state somebody
 * asked for. The consequence is that three things it can never see:
 *
 *  1. WHERE A PLAYER ACTUALLY OPENS. Nothing in the sheet is shot at H_START,
 *     because the sheet asks for H_REST. Writes `open.png` and reports the heat,
 *     the steam and where the subject lands.
 *  2. EAT AT ZERO. Round 7 took the doneness floor off `eat()`. This presses it
 *     on a marshmallow that has never been near the fire and checks the whole
 *     beat runs — phase `eat`, the result line, the counters, the step back —
 *     rather than the input being swallowed.
 *  3. `state().fire`. It published a scratch record that only `_stepToast`
 *     writes, so on any frame nobody had stepped it read (0, 0, 0) while
 *     `state().mallow` read a real world position, and a harness differencing
 *     the two got 1312 m. Measures the distance on a NON-STEPPED pose, which is
 *     the case that was broken.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOUR = parseFloat(arg('hour', '20.4'));
const DIR = arg('dir', 'shots/roast/r7-open');
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=1600&car=camper`;

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastopen');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
const report = {};
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  await page.evaluate(() => { const e = window.__engine; if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; } });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  await page.evaluate(({ at }) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, z: s.z } : null;
  }, { at: parkAt });
  await page.waitForTimeout(1200);

  // ── 3. state().fire on a pose nobody stepped ──────────────────────────────
  // Read FIRST, on the frame the view opens, before any `step()` has run.
  report.fire = await page.evaluate(() => {
    window.__roast.enter();
    const s = window.__roast.state();
    const dx = s.fire.x - s.mallow.x, dy = (s.fire.y + s.fire.top) - s.mallow.y, dz = s.fire.z - s.mallow.z;
    return {
      fire: { x: +s.fire.x.toFixed(2), y: +s.fire.y.toFixed(2), z: +s.fire.z.toFixed(2), top: s.fire.top },
      srcStepped: s.fire.src.stepped,
      src: { x: +s.fire.src.x.toFixed(2), y: +s.fire.src.y.toFixed(2), z: +s.fire.src.z.toFixed(2) },
      mallow: { x: +s.mallow.x.toFixed(2), y: +s.mallow.y.toFixed(2), z: +s.mallow.z.toFixed(2) },
      dist: +Math.hypot(dx, dy, dz).toFixed(3),
      power: +s.fire.power.toFixed(3),
    };
  });
  console.log('state().fire on an unstepped pose:', JSON.stringify(report.fire));

  // ── 1. where a player opens ───────────────────────────────────────────────
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999, null, { timeout: 20000, polling: 60 });
  await page.evaluate(() => { window.__roast.setOverlay(false); window.__roast.setClock(3.0); });
  await page.waitForTimeout(400);
  report.open = await page.evaluate(() => {
    const R = window.__roast, V = R.view, THREE = window.__THREE;
    const s = R.state();
    const q = V.mallow.getWorldPosition(new THREE.Vector3()).project(V.ctx.camera);
    return {
      height: +s.height.toFixed(4), heat: +s.heat.toFixed(3), heatTarget: +s.heatTarget.toFixed(3),
      steam: +s.steam.toFixed(3), doneness: +s.doneness.toFixed(4),
      xPct: +((q.x * 0.5 + 0.5) * 100).toFixed(1), yPct: +((0.5 - q.y * 0.5) * 100).toFixed(1),
      clear: s.clear,
    };
  });
  await page.screenshot({ path: `${DIR}/open.png` });
  console.log('opening frame:', JSON.stringify(report.open));

  // The tip line, as it is actually written into the DOM.
  report.tip = await page.evaluate(() => document.querySelector('.pa-roast-tip')?.textContent ?? null);
  console.log('tip:', JSON.stringify(report.tip));

  // ── 2. eat at zero ────────────────────────────────────────────────────────
  await page.evaluate(() => { window.__roast.setOverlay(true); window.__roast.setDoneness(0); });
  report.eat = await page.evaluate(() => {
    const R = window.__roast, V = R.view;
    const before = { roasted: V.roasted, perfect: V.perfect, burnt: V.burnt, doneness: R.state().doneness };
    // The player's own path: not `__roast.eat()`, the method `E` calls.
    V.eat();
    const after = R.state();
    return {
      before,
      phase: after.phase,
      result: after.result, label: after.resultLabel,
      roasted: after.roasted, perfect: after.perfect, burnt: after.burnt,
      line: document.querySelector('.pa-roast-result')?.textContent ?? null,
      lineOpacity: document.querySelector('.pa-roast-result')?.style.opacity ?? null,
    };
  });
  console.log('eat at doneness 0:', JSON.stringify(report.eat));

  // And the beat runs to the end rather than snapping: step it and watch.
  report.beat = await page.evaluate(() => {
    const R = window.__roast, V = R.view;
    const trail = [];
    for (let i = 0; i < 130; i++) {
      V._sim(1 / 60); if (V.prop) V._drive(1 / 60);
      if (i % 20 === 0) trail.push({ i, phase: R.state().phase, eating: +V.eating.toFixed(2), scale: +V._mallowScale.toFixed(3) });
    }
    trail.push({ i: 130, phase: R.state().phase, active: R.state().active });
    return trail;
  });
  console.log('the beat:', JSON.stringify(report.beat));

  writeFileSync(`${DIR}/OPEN.json`, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${DIR}/OPEN.json`);
} finally {
  await browser.close();
  await release();
}

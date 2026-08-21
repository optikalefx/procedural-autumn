#!/usr/bin/env node
/**
 * rollover — roll the camper on a mountainside and watch the auto-right land it.
 *
 * rightgeom.mjs says the auto-right's single centre height sample buries a
 * 4.5 m chassis box a median 1.9 m inside a 45-degree face. This is the same
 * claim with the physics attached: put the camper on a steep slope, put it on
 * its roof the way a tumble would, let `_recover` fire, and record where it
 * ends up and whether anything can still get it out.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const RUNS = parseInt(arg('runs', '16'), 10);
const URL = `http://localhost:5178?res=640`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const deg = (u) => (Math.acos(Math.max(-1, Math.min(1, u))) * 180) / Math.PI;

async function main() {
  const release = await acquire('rollover');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  // Seven authors share the dev server; a save from any of them reloads the
  // page mid-run. Same HMR stub drive.mjs and holdtest.mjs use.
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
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const W = window.__world;
    window.__steep = (n) => {
      const out = [];
      for (let i = 0; i < 200000 && out.length < n; i++) {
        const x = (Math.random() * 2 - 1) * 1400, z = (Math.random() * 2 - 1) * 1400;
        if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.02) continue;
        const d = 2.0;
        const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
        const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
        const g = Math.hypot(gx, gz);
        if (g < 0.7 || g > 1.5) continue;          // a face you can drive onto and lose
        out.push({ x, z, g });
      }
      return out;
    };
    /** Put it on its roof, the way the end of a tumble does. */
    window.__flip = () => {
      const T = window.__THREE, P = window.__vehicle.phys;
      const q = new T.Quaternion().setFromEuler(new T.Euler(0.3, Math.random() * 6.28, Math.PI * 0.92, 'YXZ'));
      P.holdRelease();
      P.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      P.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      P.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    };
    window.__rec = (ms) => new Promise((res) => {
      const out = []; const t0 = performance.now();
      const tick = () => {
        const s = window.__vehicleState(); const P = window.__vehicle.phys;
        out.push({ t: (performance.now() - t0) / 1000, x: s.x, y: s.y, z: s.z, speed: s.speed,
                   up: s.up, grounded: s.grounded, rec: s.recoveries, ground: s.ground, air: P.airborne });
        if (performance.now() - t0 >= ms) res(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    window.__sunk = () => {
      const T = window.__THREE, W2 = window.__world, V = window.__vehicle;
      let deepest = 0;
      for (const x of [-0.95, 0.95]) for (const y of [-0.30, 1.16]) for (const z of [-2.32, 2.34]) {
        const v = new T.Vector3(x, y, z).applyQuaternion(V.rig.quaternion).add(V.rig.position);
        deepest = Math.max(deepest, W2.getHeight(v.x, v.z) - v.y);
      }
      return deepest;
    };
  });

  const sites = await page.evaluate((n) => window.__steep(n), RUNS);
  console.log(`\n${sites.length} roll-overs on faces of gradient 0.7–1.5 (35–56 degrees)\n`);
  console.log('  site         grad | recov  tilt°  wheels  air  sunk m | throttle 4 s | outcome');

  const tally = { wedged: 0, stuck: 0, ok: 0, moving: 0 };
  for (const s of sites) {
    await page.evaluate(([x, z]) => window.__vehicleTeleport(x, z, Math.random() * 6.28), [s.x, s.z]);
    await page.waitForTimeout(900);
    const rec0 = (await page.evaluate(() => window.__vehicleState())).recoveries;
    await page.evaluate(() => window.__flip());
    const rows = await page.evaluate(() => window.__rec(14000));   // recover, then settle
    const last = rows[rows.length - 1];
    const tail = rows.filter((r) => r.t > last.t - 4);
    const span = Math.max(...tail.map((r) => Math.hypot(r.x - last.x, r.y - last.y, r.z - last.z)));
    const sunk = await page.evaluate(() => window.__sunk());
    await page.keyboard.down('KeyW');
    const drv = await page.evaluate(() => window.__rec(4000));
    await page.keyboard.up('KeyW');
    const end = drv[drv.length - 1];
    const moved = Math.hypot(end.x - last.x, end.y - last.y, end.z - last.z);
    const tilt = deg(last.up);

    // Stuck is stuck: four seconds of open throttle that moved it less than its
    // own length. The split that matters is whether the game can *tell* — the
    // stuck detector is gated on `!airborne`, so a camper resting on its chassis
    // box with no wheel down never counts up and never offers the rescue key.
    let outcome;
    if (span > 0.5) { outcome = 'still sliding'; tally.moving++; }
    else if (moved < 1.0 && last.grounded === 0) {
      outcome = 'WEDGED — no wheel, throttle dead, no "Press R"'; tally.wedged++;
    } else if (moved < 1.0) {
      outcome = `stuck at ${f(tilt, 0)}°, but the detector can see it`; tally.stuck++;
    } else { outcome = 'righted and drivable'; tally.ok++; }
    console.log(`  ${f(s.x, 0).padStart(6)},${f(s.z, 0).padStart(6)}  ${f(s.g)} |`
      + ` ${String(last.rec - rec0).padStart(5)}  ${f(tilt, 0).padStart(4)}  ${String(last.grounded).padStart(4)}`
      + `  ${String(last.air).padStart(5)}  ${f(sunk).padStart(5)} | ${f(moved).padStart(9)} m | ${outcome}`);
  }
  console.log(`\n  wedged and silent ${tally.wedged}   stuck but detectable ${tally.stuck}`
    + `   righted ${tally.ok}   still sliding ${tally.moving}`);
  await browser.close();
  release();
}
main().catch((e) => { console.error(e); process.exit(1); });

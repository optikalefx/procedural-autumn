#!/usr/bin/env node
/**
 * revtest — measures the two *feel* changes the player asked for.
 *
 *   node tools/_scratch/revtest.mjs                 # both scenarios
 *   node tools/_scratch/revtest.mjs --only reverse
 *   node tools/_scratch/revtest.mjs --only camera
 *
 * 1. reverse → forward.  Reverse to a target speed, then press forward and
 *    time how long until the camper is actually going forwards.  Sampling is
 *    done by a rAF loop *inside the page* so the resolution is one frame, not
 *    one Playwright round-trip.
 *
 * 2. camera lead.  Drive straight, then hold a steady turn, and record how far
 *    the aim point moves sideways off the camper's own axis.  That lateral
 *    offset is the "panning thing" the player is describing.
 *
 * Every trial starts from the same teleported pose so the two arms of a
 * before/after comparison are measured on the same piece of ground.
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
const RES = arg('res', '640');
const ONLY = arg('only', null);
const TRIALS = parseInt(arg('trials', '5'), 10);
const FROM = parseFloat(arg('from', '-5'));      // reverse speed to start from
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const release = await acquire('revtest');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  // Immune to another author saving a file mid-run.
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

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ── in-page per-frame trace ────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__trace = [];
    window.__traceOn = false;
    const loop = () => {
      requestAnimationFrame(loop);
      if (!window.__traceOn) return;
      const v = window.__vehicle;
      if (!v?.phys?.ready) return;
      const ax = v.ctx.input.axes;
      const cam = window.__cameraState?.();
      window.__trace.push({
        t: performance.now(), sp: v.speed, th: ax.throttle, br: ax.brake, st: ax.steer,
        // Lateral offset of the aim point from the camper's own forward axis.
        lat: (() => {
          const rig = v.ctx.systems.cameraRig ?? window.__rig;
          if (!rig) return 0;
          const dx = rig.lookAt.x - v.position.x, dz = rig.lookAt.z - v.position.z;
          return dx * v.right.x + dz * v.right.z;
        })(),
        camYaw: cam ? Math.atan2(cam.x - v.position.x, cam.z - v.position.z) : 0,
      });
    };
    requestAnimationFrame(loop);
  });

  // A fixed, flat, dry launch pad so every trial is on the same ground.
  const pad = await page.evaluate(() => {
    const W = window.__world, v = window.__vehicle;
    let best = null;
    const p = v.position;
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2 * 7;
      const r = 4 + (i / 400) * 90;
      const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > 0.02) continue;
      const s = W.getSlope(x, z);
      if (s > 0.16) continue;
      // want the surroundings flat too, so a reverse run does not go downhill
      let bad = 0;
      for (let k = 0; k < 8; k++) {
        const b = (k / 8) * Math.PI * 2;
        const sx = x + Math.sin(b) * 14, sz = z + Math.cos(b) * 14;
        if (!W.isInBounds(sx, sz)) { bad = 9; break; }
        bad += Math.abs(W.getHeight(sx, sz) - W.getHeight(x, z));
        if (W.getWaterDepth(sx, sz) > 0.02) bad += 5;
      }
      if (!best || bad < best.bad) best = { x, z, bad };
      if (best.bad < 1.5) break;
    }
    return best;
  });
  console.log(`pad at ${f(pad.x, 1)}, ${f(pad.z, 1)} (flatness ${f(pad.bad)})`);

  const held = new Set();
  const setKeys = async (want) => {
    for (const k of held) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };
  const reset = async (heading = 0) => {
    await setKeys(new Set());
    await page.evaluate(([x, z, h]) => window.__vehicleTeleport(x, z, h), [pad.x, pad.z, heading]);
    await page.waitForTimeout(700);
  };
  const speed = () => page.evaluate(() => window.__vehicle.speed);

  const out = {};

  // ── 1. reverse → forward ──────────────────────────────────────────────────
  if (!ONLY || ONLY === 'reverse') {
    const rows = [];
    for (let trial = 0; trial < TRIALS; trial++) {
      await reset(0);
      // back up until we are travelling at FROM m/s
      await setKeys(new Set(['KeyS']));
      const t0 = Date.now();
      let sp = 0;
      while (Date.now() - t0 < 12000) {
        sp = await speed();
        if (sp <= FROM) break;
        await page.waitForTimeout(50);
      }
      if (sp > FROM) { console.log(`  trial ${trial}: never reached ${FROM} m/s (got ${f(sp)})`); continue; }

      await page.evaluate(() => { window.__trace.length = 0; window.__traceOn = true; });
      await page.keyboard.up('KeyS'); held.delete('KeyS');
      await page.keyboard.down('KeyW'); held.add('KeyW');
      // 6 s is far longer than any plausible transition; the trace tells us
      // where it actually crossed.
      await page.waitForTimeout(6000);
      await page.evaluate(() => { window.__traceOn = false; });
      await setKeys(new Set());
      const tr = await page.evaluate(() => window.__trace);

      const i0 = tr.findIndex((r) => r.th > 0.5);
      if (i0 < 0) { console.log(`  trial ${trial}: throttle never registered`); continue; }
      const t = tr[i0].t;
      const at = (pred) => {
        const i = tr.findIndex((r, k) => k >= i0 && pred(r));
        return i < 0 ? NaN : (tr[i].t - t) / 1000;
      };
      const row = {
        start: tr[i0].sp,
        toZero: at((r) => r.sp > 0),
        toHalf: at((r) => r.sp > 0.5),
        toTwo: at((r) => r.sp > 2.0),
        peakDecel: (() => {
          let worst = 0;
          for (let k = i0 + 1; k < tr.length; k++) {
            const dt = (tr[k].t - tr[k - 1].t) / 1000;
            if (dt <= 0 || dt > 0.2) continue;
            const a = (tr[k].sp - tr[k - 1].sp) / dt;
            if (a > worst) worst = a;
            if (tr[k].sp > 0) break;
          }
          return worst;
        })(),
      };
      rows.push(row);
      console.log(`  trial ${trial}: from ${f(row.start)} m/s  →0 ${f(row.toZero)}s  →0.5 ${f(row.toHalf)}s  →2 ${f(row.toTwo)}s  peak accel ${f(row.peakDecel)} m/s²`);
    }
    out.reverse = {
      n: rows.length,
      toZero: median(rows.map((r) => r.toZero)),
      toHalf: median(rows.map((r) => r.toHalf)),
      toTwo: median(rows.map((r) => r.toTwo)),
      peak: median(rows.map((r) => r.peakDecel)),
    };
    console.log(`\nREVERSE→FORWARD from ${FROM} m/s (median of ${rows.length}):`);
    console.log(`  to any forward motion   ${f(out.reverse.toZero)} s`);
    console.log(`  to 0.5 m/s              ${f(out.reverse.toHalf)} s`);
    console.log(`  to 2.0 m/s              ${f(out.reverse.toTwo)} s`);
    console.log(`  peak forward accel      ${f(out.reverse.peak)} m/s²`);
  }

  // ── 2. camera lead on steering ────────────────────────────────────────────
  if (!ONLY || ONLY === 'camera') {
    await reset(0);
    await setKeys(new Set(['KeyW']));
    await page.waitForTimeout(3500);                    // get up to a steady speed
    await page.evaluate(() => { window.__trace.length = 0; window.__traceOn = true; });
    await page.waitForTimeout(900);                     // straight-line reference
    await setKeys(new Set(['KeyW', 'KeyA']));           // steady left
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__traceOn = false; });
    await setKeys(new Set());
    const tr = await page.evaluate(() => window.__trace);
    const i0 = tr.findIndex((r) => r.st > 0.5);
    if (i0 < 0) console.log('camera: steering never registered');
    else {
      const straight = tr.slice(0, i0).map((r) => r.lat);
      const base = straight.length ? straight.reduce((a, b) => a + b, 0) / straight.length : 0;
      // The first 0.35 s after the wheel moves: this is "the pan that happens
      // first", before the camper has meaningfully changed heading.
      const t = tr[i0].t;
      const early = tr.filter((r) => r.t >= t && r.t < t + 350).map((r) => r.lat - base);
      const late = tr.filter((r) => r.t >= t + 350).map((r) => r.lat - base);
      const ext = (a) => (a.length ? a.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0) : NaN);
      out.camera = { base, early: ext(early), late: ext(late) };
      console.log('\nCAMERA aim-point lateral offset (m, +right of the camper):');
      console.log(`  straight-line mean       ${f(base)}`);
      console.log(`  peak in first 0.35 s     ${f(out.camera.early)}`);
      console.log(`  peak thereafter          ${f(out.camera.late)}`);
    }
  }

  if (errors.length) console.log('\npage errors:\n  ' + errors.join('\n  '));
  console.log('\nJSON ' + JSON.stringify(out));
  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });

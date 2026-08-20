#!/usr/bin/env node
/**
 * Drive the camper into a lake and measure what the camera actually does.
 *
 * CRITIC_FINDINGS D1 reads the frame as "the camera submerges". CameraRig
 * already floors every boom sample at `max(terrain, waterHeight)`, so before
 * anything is changed the claim has to be measured: this logs, every sample,
 * the camera height, the water surface under it, the resulting clearance, and
 * how much of the frame is water-blue.
 *
 *   node tools/_scratch/waterdrive.mjs --dir shots/d1-before
 *   node tools/_scratch/waterdrive.mjs --dir shots/d1-after --eval "…"
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/d1');
const N = parseInt(arg('n', '18'), 10);
const GAP = parseFloat(arg('gap', '600'));
const EVAL = arg('eval', null);

mkdirSync(DIR, { recursive: true });
await acquire('waterdrive');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  window.__hudForce = true;
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(900);
if (EVAL) await p.evaluate((s) => { (0, eval)(s); }, EVAL);

// ── find a lake and a shore to drive in from ────────────────────────────────
const site = await p.evaluate(() => {
  const W = window.__world;
  let best = null;
  for (let z = -1400; z <= 1400; z += 24) {
    for (let x = -1400; x <= 1400; x += 24) {
      const d = W.getWaterDepth(x, z);
      if (d < 5) continue;
      // Want a shore within ~60 m so the camper can drive in under power.
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const sx = x + Math.sin(ang) * 60, sz = z + Math.cos(ang) * 60;
        if (W.getWaterDepth(sx, sz) > 0.05) continue;
        if (W.getSlope(sx, sz) > 0.45) continue;
        const score = d - Math.hypot(x, z) * 0.002;
        if (!best || score > best.score) {
          best = { score, lx: x, lz: z, sx, sz, depth: +d.toFixed(1),
                   heading: Math.atan2(x - sx, z - sz) };
        }
      }
    }
  }
  return best;
});
console.log('lake site', JSON.stringify(site));

await p.evaluate((s) => {
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  window.__vehicleTeleport(s.sx, s.sz, s.heading);
}, site);
await p.waitForTimeout(1400);

await p.evaluate(() => {
  const inp = window.__ctx.input; window.__drive = true;
  const tick = () => { if (!window.__drive) return; inp.axes.throttle = 1; inp.axes.steer = 0; requestAnimationFrame(tick); };
  tick();
});

const rows = [];
for (let i = 0; i < N; i++) {
  const st = await p.evaluate(() => {
    const W = window.__world, c = window.__engine.camera, v = window.__systems.vehicle;
    const wh = W.getWaterHeight(c.position.x, c.position.z);
    const th = W.getHeight(c.position.x, c.position.z);
    const vwh = W.getWaterHeight(v.position.x, v.position.z);
    return {
      camY: +c.position.y.toFixed(2),
      water: wh === null ? null : +wh.toFixed(2),
      terr: +th.toFixed(2),
      clear: wh === null ? null : +(c.position.y - wh).toFixed(2),
      vehY: +v.position.y.toFixed(2),
      vehWater: vwh === null ? null : +vwh.toFixed(2),
      vehSubmerged: vwh === null ? null : +(vwh - v.position.y).toFixed(2),
      speed: +Math.abs(v.speed).toFixed(1),
    };
  });
  writeFileSync(`${DIR}/f${String(i).padStart(2, '0')}.png`, await p.screenshot());
  rows.push(st);
  console.log(`f${i} camY=${st.camY} water=${st.water} clear=${st.clear} vehY=${st.vehY} vehSub=${st.vehSubmerged} spd=${st.speed}`);
  await p.waitForTimeout(GAP);
}
await p.evaluate(() => { window.__drive = false; });
writeFileSync(`${DIR}/log.json`, JSON.stringify({ site, rows }, null, 1));
await b.close();

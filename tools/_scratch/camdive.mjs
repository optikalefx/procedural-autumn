#!/usr/bin/env node
/**
 * D1 by driving: the same shore, the same throttle, the same page load, twice —
 * once with `getWaterHeight` as it ships, once with the P1-reply patch shimmed
 * in at runtime.
 *
 * waterdrive.mjs picks its lake with `getWaterDepth`, so patching the query
 * moves the site and the two runs are no longer comparable. Here the site is
 * chosen once, before anything is patched, and both passes start from it. One
 * page load, because two captures minutes apart are two different worlds (P3).
 *
 *   node tools/_scratch/camdive.mjs --dir shots/p1-dive
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/p1-dive');
const N = parseInt(arg('n', '14'), 10);
const GAP = parseFloat(arg('gap', '500'));

mkdirSync(DIR, { recursive: true });
await acquire('camdive');
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

// Site chosen once, with the SHIPPING query, so both passes drive the same water.
//
// Not "the deepest lake" — waterdrive.mjs picks that and the camper simply
// beaches on its shore, which is a fine test of the shore and no test at all of
// D1. What D1 needs under the boom is the defect itself: drawn water standing
// well above the terrain that `getWaterHeight` answers null for. So score every
// dry, drivable, low-slope spot by how much of that lies within 40 m of it, and
// drive at the worst one.
const site = await p.evaluate(() => {
  const W = window.__world, f = window.__systems.water.lakeField;
  const holes = [];
  for (let z = -1400; z <= 1400; z += 8) for (let x = -1400; x <= 1400; x += 8) {
    const surf = f.levelAt(x, z);
    if (surf === null) continue;
    if (surf - W.getHeight(x, z) < 2) continue;        // not standing water
    if (W.getWaterHeight(x, z) !== null) continue;     // the query already knows
    holes.push({ x, z, depth: surf - W.getHeight(x, z) });
  }
  let best = null;
  for (const h of holes) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const sx = h.x + Math.sin(ang) * 36, sz = h.z + Math.cos(ang) * 36;
      if (!W.isInBounds(sx, sz)) continue;
      if (W.getWaterDepth(sx, sz) > 0.05 || W.getSlope(sx, sz) > 0.40) continue;
      if (f.levelAt(sx, sz) !== null && f.levelAt(sx, sz) - W.getHeight(sx, sz) > 0) continue;
      let near = 0;
      for (const g of holes) if (Math.abs(g.x - h.x) < 40 && Math.abs(g.z - h.z) < 40) near++;
      const score = near + h.depth;
      if (!best || score > best.score) best = { score: +score.toFixed(1), lx: h.x, lz: h.z, sx, sz,
                                                depth: +h.depth.toFixed(1), nullHolesNearby: near,
                                                heading: Math.atan2(h.x - sx, h.z - sz) };
    }
  }
  return { ...best, totalNullHoles: holes.length };
});
console.log('lake site', JSON.stringify(site));

await p.evaluate(() => { window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0; });

// The exact body filed as the WorldData patch, shimmed on at runtime.
const PATCH = () => {
  const W = window.__world;
  W._lake = window.__systems.water.lakeField;
  const point = (x, z) => {
    const gx = Math.max(0, Math.min(W.res - 1, Math.round((x + W.half) * W.invTexel)));
    const gz = Math.max(0, Math.min(W.res - 1, Math.round((z + W.half) * W.invTexel)));
    const w = W.water[gz * W.res + gx];
    return w < -9000 ? null : w;
  };
  W.getWaterHeight = function (x, z) {
    const w = point(x, z);
    const m = this._lake ? this._lake.levelAt(x, z) : null;
    if (w === null) return m;
    if (m === null) return w;
    return w > m ? w : m;
  };
};

const passes = {};
for (const pass of ['before', 'after']) {
  if (pass === 'after') await p.evaluate(PATCH);
  await p.evaluate((s) => { window.__drive = false; window.__vehicleTeleport(s.sx, s.sz, s.heading); }, site);
  await p.waitForTimeout(1600);
  await p.evaluate(() => {
    const inp = window.__ctx.input; window.__drive = true;
    const tick = () => { if (!window.__drive) return; inp.axes.throttle = 1; inp.axes.steer = 0; requestAnimationFrame(tick); };
    tick();
  });
  const rows = [];
  for (let i = 0; i < N; i++) {
    const st = await p.evaluate(() => {
      const W = window.__world, c = window.__engine.camera, v = window.__systems.vehicle;
      const f = window.__systems.water.lakeField;
      // What the camera rig actually floors on, and what the player actually sees.
      const q = W.getWaterHeight(c.position.x, c.position.z);
      const boomFloor = Math.max(W.getHeight(c.position.x, c.position.z), q === null ? -1e9 : q);
      const drawn = f.levelAt(c.position.x, c.position.z);
      return { camY: +c.position.y.toFixed(2),
               query: q === null ? null : +q.toFixed(2),
               boomFloor: +boomFloor.toFixed(2),
               drawnSurface: drawn === null ? null : +drawn.toFixed(2),
               // negative ⇒ the camera is INSIDE water the player can see
               clearOfDrawn: drawn === null ? null : +(c.position.y - drawn).toFixed(2),
               vehY: +v.position.y.toFixed(2), speed: +Math.abs(v.speed).toFixed(1) };
    });
    writeFileSync(`${DIR}/${pass}-f${String(i).padStart(2, '0')}.png`, await p.screenshot());
    rows.push(st);
    console.log(`${pass} f${i} camY=${st.camY} query=${st.query} drawn=${st.drawnSurface} clearOfDrawn=${st.clearOfDrawn} vehY=${st.vehY} spd=${st.speed}`);
    await p.waitForTimeout(GAP);
  }
  await p.evaluate(() => { window.__drive = false; });
  const over = rows.filter((r) => r.drawnSurface !== null);
  passes[pass] = { rows,
    framesOverDrawnWater: over.length,
    framesQueryNull: over.filter((r) => r.query === null).length,
    framesCameraSubmerged: over.filter((r) => r.clearOfDrawn < 0).length,
    worstSubmergence: over.length ? +Math.min(0, ...over.map((r) => r.clearOfDrawn)).toFixed(2) : 0 };
  console.log(`  ${pass}: overWater=${passes[pass].framesOverDrawnWater} queryNull=${passes[pass].framesQueryNull} submerged=${passes[pass].framesCameraSubmerged} worst=${passes[pass].worstSubmergence}`);
}
writeFileSync(`${DIR}/log.json`, JSON.stringify({ site, passes }, null, 1));
console.log(DIR);
await b.close();

#!/usr/bin/env node
/**
 * OCCLUDE — the rock half. Same idea as occnear.mjs: drive, stop the clock,
 * pose the camera a metre off one boulder with the camper beyond it, and shoot
 * the pair. Proves the second rock program links and that the fade it carries
 * is the whole instance's rather than a bite out of the middle of the stone.
 *
 *   node tools/_scratch/occrock.mjs --dir shots/occrock
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occrock');
const DISTS = (arg('dists', '0.8,2.0,3.4,6.0')).split(',').map(Number);

mkdirSync(DIR, { recursive: true });
await acquire('occrock');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
p.on('console', (m) => { const t = m.text(); if (/ERROR|GL_|shader|link/i.test(t)) console.log('CONSOLE', t.slice(0, 400)); });
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(700);

await p.evaluate(() => {
  window.__lighting.hour = 13.5; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.21) * 0.3; requestAnimationFrame(tick); };
  tick();
});
await p.waitForTimeout(14000);

const info = await p.evaluate(() => {
  window.__drive = false;
  const e = window.__engine; e.stop(); window.__forceCamera = true;
  const veh = window.__systems.vehicle;
  const rocks = [];
  for (const c of window.__systems.rocks.cells.values()) {
    for (const i of c.instances) {
      const d = Math.hypot(i.x - veh.position.x, i.z - veh.position.z);
      if (d < 60 && i.size > 1.0) rocks.push({ x: i.x, y: i.y, z: i.z, size: i.size, d });
    }
  }
  rocks.sort((a, b) => a.d - b.d);
  window.__rock = rocks[0];
  window.__pose = (dist) => new Promise((res) => requestAnimationFrame(() => {
    const t = window.__rock, c = e.camera, v = veh.position;
    const ax = t.x - v.x, az = t.z - v.z, L = Math.hypot(ax, az) || 1;
    c.position.set(t.x + (ax / L) * (dist + t.size * 0.5), t.y + t.size * 0.35, t.z + (az / L) * (dist + t.size * 0.5));
    c.lookAt(v.x, v.y + 1.0, v.z);
    c.updateMatrixWorld(true);
    window.__occlusion.setSubject(c, veh.position);
    window.__systems.trees.lateUpdate(0, e.elapsed);
    window.__systems.rocks.lateUpdate(0, e.elapsed);
    e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
    requestAnimationFrame(() => res());
  }));
  return { found: rocks.length, nearest: window.__rock };
});
console.log('frozen:', JSON.stringify(info));

for (const d of DISTS) {
  await p.evaluate(() => Object.assign(window.__occlusion.params, { enabled: true }));
  await p.evaluate((x) => window.__pose(x), d);
  writeFileSync(`${DIR}/r${d}-on.png`, await p.screenshot());
  await p.evaluate(() => Object.assign(window.__occlusion.params, { enabled: false }));
  await p.evaluate((x) => window.__pose(x), d);
  writeFileSync(`${DIR}/r${d}-off.png`, await p.screenshot());
  console.log(`  ${d} m: r${d}-on.png / r${d}-off.png`);
}
await b.close();

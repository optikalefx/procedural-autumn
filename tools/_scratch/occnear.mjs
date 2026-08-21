#!/usr/bin/env node
/**
 * OCCLUDE — what the near-camera volume does to a tree the camera is inside.
 *
 * Drives into wood, stops the clock, then POSES the camera by hand at a set of
 * distances from one chosen trunk, with the camper on the far side of it. One
 * PNG per distance, plus the same pose with the feature off, so the pair says
 * both "does the tree go" and "does anything else in the frame move".
 *
 *   node tools/_scratch/occnear.mjs --dir shots/occnear
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occnear');
const WARM = parseFloat(arg('warm', '14000'));
const W = parseInt(arg('w', '1200'), 10);
const H = parseInt(arg('h', '720'), 10);
const DISTS = (arg('dists', '1.0,2.4,3.6,5.0,9.0')).split(',').map(Number);

mkdirSync(DIR, { recursive: true });
await acquire('occnear');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
p.on('console', (m) => { const t = m.text(); if (/ERROR|error|WARNING: |GL_|shader/i.test(t)) console.log('CONSOLE', t.slice(0, 400)); });
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(700);

// Drive until the camper is actually IN wood — a random heading through this
// world spends a good deal of its time on open hillside, and an open hillside
// has nothing to say about a feature that hides trees.
await p.evaluate(() => {
  window.__lighting.hour = 13.5; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.19) * 0.28 + Math.sin(t * 0.07) * 0.2;
    requestAnimationFrame(tick); };
  tick();
});
const density = () => p.evaluate(() => {
  const veh = window.__systems.vehicle.position;
  let n = 0;
  window.__engine.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.geometry.getAttribute('aBark')) return;
    const m = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++) {
      if (Math.hypot(m[i * 16 + 12] - veh.x, m[i * 16 + 14] - veh.z) < 50) n++;
    }
  });
  return n;
});
let trunks = 0;
for (let i = 0; i < 20; i++) {
  await p.waitForTimeout(i === 0 ? WARM : 3500);
  trunks = await density();
  console.log(`  driving… ${trunks} trunks within 50 m`);
  if (trunks >= 30) break;
}

// ── the live chase view, in wood, which is the frame the player sees ───────
for (let i = 0; i < 5; i++) {
  writeFileSync(`${DIR}/live${i}.png`, await p.screenshot());
  await p.waitForTimeout(900);
}
console.log('  wrote live0..4.png');

// ── freeze, and take the camera off the rig ────────────────────────────────
const info = await p.evaluate(() => {
  window.__drive = false;
  const e = window.__engine;
  e.stop();
  window.__forceCamera = true;                 // the rig hands the camera over
  const T = window.__THREE;
  const veh = window.__systems.vehicle;

  // Every trunk within 40 m of the camper, straight out of the instance blocks.
  const trees = [];
  e.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.geometry.getAttribute('aBark')) return;
    const m = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++) {
      const x = m[i * 16 + 12], y = m[i * 16 + 13], z = m[i * 16 + 14];
      const d = Math.hypot(x - veh.position.x, z - veh.position.z);
      if (d < 45) trees.push({ x, y, z, d, scale: m[i * 16 + 5] });
    }
  });
  // The tree with the most company inside 12 m, i.e. one standing in a stand —
  // a lone snag on a bald slope proves nothing about a forest.
  for (const t of trees) t.n = trees.filter((o) => Math.hypot(o.x - t.x, o.z - t.z) < 12).length;
  trees.sort((a, b) => (b.n - a.n) || (a.d - b.d));
  window.__tree = trees[0];

  window.__pose = (dist) => new Promise((res) => requestAnimationFrame(() => {
    const t = window.__tree, c = e.camera, v = veh.position;
    // Behind the trunk as seen from the camper, so the trunk is squarely
    // between the lens and the thing the player is looking at.
    const ax = t.x - v.x, az = t.z - v.z;
    const L = Math.hypot(ax, az) || 1;
    c.position.set(t.x + (ax / L) * dist, t.y + 2.6, t.z + (az / L) * dist);
    c.lookAt(v.x, v.y + 1.0, v.z);
    c.updateMatrixWorld(true);
    window.__occlusion.setSubject(c, veh.position);
    // The engine's lateUpdate is what swaps bark and rock onto the discarding
    // program, and the clock is stopped — so run the two gates by hand or the
    // trunk in front of the lens is drawn by a program that cannot fade.
    window.__systems.trees.lateUpdate(0, e.elapsed);
    window.__systems.rocks.lateUpdate(0, e.elapsed);
    e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
    requestAnimationFrame(() => res());
  }));
  return { trees: trees.length, nearest: window.__tree, veh: [veh.position.x, veh.position.y, veh.position.z].map((n) => +n.toFixed(1)) };
});
console.log('frozen:', JSON.stringify(info));

const shot = async (dist) => { await p.evaluate((d) => window.__pose(d), dist); return p.screenshot(); };

for (const d of DISTS) {
  await p.evaluate(() => Object.assign(window.__occlusion.params, { enabled: true }));
  writeFileSync(`${DIR}/d${d}-on.png`, await shot(d));
  await p.evaluate(() => Object.assign(window.__occlusion.params, { enabled: false }));
  writeFileSync(`${DIR}/d${d}-off.png`, await shot(d));
  console.log(`  ${d} m: wrote d${d}-on.png / d${d}-off.png`);
}

await b.close();

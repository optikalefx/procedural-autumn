// Drive the camera across the meadow at speed and watch the grass field for the
// two failure modes a still frame cannot show:
//
//   1. a pop — a tile recycled while its blades still have area, which appears
//      as a row of grass springing into existence at the LOD edge;
//   2. a rebuild stall — the amortised tile fill blowing its millisecond budget
//      and hitching the frame.
//
// Reports per-step visible instance counts (a pop shows up as a step change in
// a *near* ring, not the far one) and the worst update() cost seen, and writes
// a strip of frames so the fade can also be judged by eye.
//
//   node tools/grass_dev/motion.mjs [dir] [speed m/s] [steps]
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir   = process.argv[2] || 'shots/grass/motion';
const speed = Number(process.argv[3] || 22);
const steps = Number(process.argv[4] || 10);

mkdirSync(resolve(dir), { recursive: true });
await acquire('grass-motion');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5178?res=768');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

// Instrument update() so the rebuild cost is measured, not guessed.
await p.evaluate(() => {
  const g = window.__systems.grass;
  window.__gWorst = 0;
  const orig = g.update.bind(g);
  g.update = (dt, t) => { const a = performance.now(); orig(dt, t); window.__gWorst = Math.max(window.__gWorst, performance.now() - a); };
  window.__lighting.hour = 17.2; window.__lighting.cycleSpeed = 0;
});

const rows = [];
for (let i = 0; i < steps; i++) {
  const r = await p.evaluate(async ({ i, speed }) => {
    const e = window.__engine, wd = window.__world;
    const a = window.__cameraAnchors.meadow();
    const yaw = a.yaw ?? 0;
    // Advance along the look direction, as the camper would.
    const d = i * speed * 0.5;                       // 0.5 s of travel per step
    const x = a.x + Math.sin(yaw) * d, z = a.z + Math.cos(yaw) * d;
    const gy = wd.getHeight(x, z) + 1.6;
    e.camera.fov = 58; e.camera.updateProjectionMatrix();
    e.camera.position.set(x, gy, z);
    e.camera.lookAt(x + Math.sin(yaw) * 8, gy - 0.4, z + Math.cos(yaw) * 8);
    window.__forceCamera = true;
    await window.__settle(24);
    const g = window.__systems.grass;
    const per = g.rings.map((r) => r.tiles.reduce((s, t) => s + (t.mesh.visible ? t.geo.instanceCount : 0), 0));
    const dirty = g.rings.reduce((s, r) => s + r.tiles.filter((t) => t.dirty).length, 0);
    return { i, d: Math.round(d), r0: per[0], r1: per[1], r2: per[2], dirty, worst: +window.__gWorst.toFixed(2) };
  }, { i, speed });
  rows.push(r);
  await p.screenshot({ path: resolve(dir, `m${String(i).padStart(2, '0')}.png`) });
}
console.log(rows.map((r) => JSON.stringify(r)).join('\n'));
// Step-to-step change in the *near* ring is the pop metric: the near ring is
// never faded, so its population should drift with terrain, not jump.
const jumps = rows.slice(1).map((r, k) => Math.abs(r.r0 - rows[k].r0) / Math.max(1, rows[k].r0));
console.log('near-ring max step change: ' + (Math.max(...jumps) * 100).toFixed(1) + '%');
await b.close();

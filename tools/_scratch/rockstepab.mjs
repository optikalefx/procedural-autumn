#!/usr/bin/env node
/**
 * A/B the rock face-step resolve inside ONE page load.
 *
 *   node tools/_scratch/rockstepab.mjs river shots/rocks/step
 *
 * Writes <out>-off.png and <out>-on.png from a single boot, flipping only
 * RockMaterial's uStepMix between the two frames.
 *
 * This exists because a before/after taken as two separate runs is worthless
 * on this repo right now: two `river` frames captured 34 minutes apart, with
 * only src/rocks changed by me, differed in 50.1% of pixels with a max channel
 * delta of 187 — the vegetation, cover, atmosphere and terrain authors all
 * saved in between. Holding the page fixed and flipping a uniform is the only
 * way to measure my own change instead of the hour.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  river:     { anchor: 'river',    height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58, pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12, pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
};

const view = process.argv[2] || 'river';
const outBase = process.argv[3] || 'shots/rocks/step';
const W = 1600, H = 900;
mkdirSync(dirname(outBase), { recursive: true });

const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('rock-step-ab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('ROCK')) console.log(t); });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

await page.evaluate(async ({ v, frozen }) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const anchor = frozen[v.anchor];
  const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back;
  const gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  const ray0 = new THREE.Raycaster(); ray0.far = 6;
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 6; attempt++) {
    dir.copy(look).sub(pos).normalize();
    ray0.set(pos, dir);
    const hits = ray0.intersectObjects(e.scene.children, true)
      .filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4;
  if (pos.y < g) pos.y = g;
  e.camera.fov = v.fov;
  e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos);
  e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  if (window.__settle) await window.__settle(120);
  // Where are the big near rocks on screen? A crop aimed by eye kept landing
  // on a patch of boulder that a moving dappled tree shadow also crossed.
  const rk = window.__systems.rocks;
  const m = new THREE.Matrix4(), q = new THREE.Vector3();
  const rows = [];
  for (const mesh of rk.meshes) {
    const at = mesh.geometry.attributes.aRockA;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); q.setFromMatrixPosition(m);
      const d = q.distanceTo(e.camera.position);
      const size = at.array[i * 4 + 3];
      if (d > 120 || size < 2.5) continue;
      const pr = q.clone().project(e.camera);
      if (Math.abs(pr.x) > 1 || Math.abs(pr.y) > 1) continue;
      rows.push({ a: mesh.userData.arch, size, d, fx: (pr.x + 1) / 2, fy: (1 - pr.y) / 2 });
    }
  }
  rows.sort((x, y) => y.size / y.d - x.size / x.d);
  for (const r of rows.slice(0, 8))
    console.log(`ROCK ${r.a} size ${r.size.toFixed(1)} d ${r.d.toFixed(0)}m  screen ${(r.fx * 100).toFixed(1)}% , ${(r.fy * 100).toFixed(1)}%`);
}, { v: VIEWS[view], frozen });

const setUniforms = async (mix, step) => {
  await page.evaluate(async ({ mix, step }) => {
    const u = window.__systems.rocks?.material?.userData?.uniforms;
    if (!u || !u.uStepMix || !u.uStepSize) throw new Error('step uniforms not found on rock material');
    u.uStepMix.value = mix;
    u.uStepSize.value = step;
    if (window.__settle) await window.__settle(30);
  }, { mix, step });
};

// Sweep in ONE load. Every frame here sees the same tree sway, the same
// dappled shadow and the same water phase, which is the entire point: the
// first attempt at this comparison mistook a moving leaf shadow on the
// boulder for the effect of the change.
const steps = (process.env.STEPS || '0.055,1.0').split(',').map(Number);
for (const [mix, step, tag] of [[0, 0.055, 'off'], ...steps.map((s) => [1, s, `s${String(s).replace('.', 'p')}`])]) {
  await setUniforms(mix, step);
  await page.screenshot({ path: `${outBase}-${tag}.png` });
  console.log(`wrote ${outBase}-${tag}.png  (uStepMix=${mix} uStepSize=${step})`);
}

await browser.close();

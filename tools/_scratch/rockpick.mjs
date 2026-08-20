#!/usr/bin/env node
/**
 * "What is that thing?" — pose a canonical view exactly as shot.mjs does, then
 * raycast a point given in *fractions of the frame* (the same coordinates the
 * critic writes findings in: "68% across, 38% down") and report every object
 * along the ray, nearest first, with its system, instance id and world point.
 *
 *   node tools/_scratch/rockpick.mjs river 0.68 0.38
 *   node tools/_scratch/rockpick.mjs peaks 0.50 0.30 0.46 0.28 0.55 0.32
 *
 * Four visual defects on this project turned out to be structural after being
 * argued about as shading, and two of them belonged to a different author than
 * the one who spent the day on them. Identify the object before touching code.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

// Inlined from shot.mjs — importing it would run a capture.
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
};

const view = process.argv[2] || 'river';
const pts = process.argv.slice(3).map(Number);
const W = 1280, H = 720;

const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('rock-pick');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('PICK')) console.log(t); });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

await page.evaluate(async ({ v, frozen, pts }) => {
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

  // shot.mjs's near-field clearance pass, copied so the pose matches.
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
  if (window.__settle) await window.__settle(90);
  e.camera.updateMatrixWorld(true);

  console.log(`PICK cam ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`);

  // InstancedMesh caches a bounding sphere computed from instanceMatrix, and
  // Rocks repacks instances without invalidating it — so a raycast silently
  // misses every rock and the frame's most conspicuous object comes back as
  // "Terrain". Recompute before asking.
  const rk = window.__systems.rocks;
  if (rk) for (const m of rk.meshes) { m.boundingSphere = null; m.computeBoundingSphere?.(); }

  const rc = new THREE.Raycaster();
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const fx = pts[i], fy = pts[i + 1];
    rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, 1 - fy * 2), e.camera);
    const hits = rc.intersectObjects(e.scene.children, true)
      .filter((h) => h.object.visible && h.object.name !== 'Sky');
    const seen = [];
    for (const h of hits) {
      let root = h.object, chain = [];
      while (root) { if (root.name) chain.push(root.name); root = root.parent; }
      seen.push(`${chain.slice(0, 3).join('<') || h.object.type}`
        + `${h.object.userData?.arch ? `[${h.object.userData.arch}]` : ''}`
        + `${h.instanceId !== undefined ? `#${h.instanceId}` : ''}`
        + `@${h.distance.toFixed(1)}m `
        + `(${h.point.x.toFixed(0)},${h.point.y.toFixed(0)},${h.point.z.toFixed(0)})`);
      if (seen.length >= 6) break;
    }
    console.log(`PICK ${fx},${fy} -> ${seen.join('  |  ') || '(nothing)'}`);
  }
}, { v: VIEWS[view], frozen, pts });

await browser.close();

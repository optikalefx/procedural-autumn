#!/usr/bin/env node
/**
 * Scratch: attribute a pixel to a system by hiding one, in a single page load.
 *
 *   node tools/_scratch/hideab.mjs water mouth
 *
 * Poses a canonical framing exactly the way tools/shot.mjs does — same anchor
 * cache, same yaw, same pitch-from-tangent look target — then screenshots
 * twice with one system's group hidden on the second pass. Same bake, same
 * camera, same frame, so any difference between the two PNGs is that system.
 *
 * Getting the camera *nearly* right is worthless here: a first attempt used a
 * different look distance and no pitch, framed a patch of forest a hundred
 * metres away, and would have "proved" whatever was read into it.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

const VIEWS = {
  mouth:     { anchor: 'mouth',     height: 5.0, dist: 26, pitch: -0.16, fov: 54, hour: 16.9 },
  river:     { anchor: 'river',     height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall', height: 11,  dist: 58, pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
};
const hide = process.argv[2] || 'water';
const name = process.argv[3] || 'mouth';
const V = VIEWS[name];
if (!V) { console.error(`unknown view: ${name}`); process.exit(1); }

let frozen = {};
try { frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8')); } catch { /* resolve live */ }

await acquire('shot');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.error('ERR', e.message));
await p.goto('http://localhost:5178', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

await p.evaluate(async ({ v, cached }) => {
  const THREE = window.__THREE, wd = window.__world;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const api = window.__cameraAnchors || {};
  const anchor = cached ?? ((v.index && window.__anchorAt)
    ? window.__anchorAt(v.anchor, v.index)
    : (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))());
  const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  const gx = anchor.x, gz = anchor.z;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(
    gx + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist,
    gz + Math.cos(yaw) * v.dist);
  window.__forceCamera = true;
  const c = window.__engine.camera;
  c.fov = v.fov; c.updateProjectionMatrix();
  c.position.copy(pos); c.lookAt(look);
  await window.__settleStable(1500, 30);
}, { v: V, cached: frozen[V.anchor] ?? null });

mkdirSync('shots/hideab', { recursive: true });
await p.screenshot({ path: `shots/hideab/${name}-with.png` });
await p.evaluate(async (h) => {
  // 'river' and 'lake' are not systems — they are the two mesh families
  // inside Water.group, and telling them apart is the whole point when a
  // defect survives every colour change made to one of them.
  if (h === 'river' || h === 'lake') {
    const g = window.__systems.water.group;
    let n = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const isRiver = /River/i.test(o.name);
      if ((h === 'river') === isRiver) { o.visible = false; n++; }
    });
    console.log('hid ' + n + ' ' + h + ' meshes');
  } else {
    const s = window.__systems[h];
    if (!s?.group) throw new Error('no system group named ' + h);
    s.group.visible = false;
  }
  await window.__settle(40);
}, hide);
await p.screenshot({ path: `shots/hideab/${name}-no-${hide}.png` });
await b.close();
console.log(`shots/hideab/${name}-with.png  vs  ${name}-no-${hide}.png`);

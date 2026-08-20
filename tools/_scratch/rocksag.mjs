#!/usr/bin/env node
/**
 * Does the DRAWN terrain agree with the analytic heightfield under a rock?
 *
 * Every offline float audit in this tree (`rockfloat.mjs`, `rockview.mjs`)
 * measures rock vertices against `world.getHeight`. Both currently report zero
 * floaters in `meadow` while the captured frame plainly shows a dozen tan
 * blocks hanging in clear air. So one of the two is measuring the wrong
 * surface, and this tool decides which by raycasting the mesh that is actually
 * in the scene graph.
 *
 * Two probes per rock instance, both from the live page:
 *
 *   sag    a vertical ray dropped onto `__terrain.group` at the rock's (x,z),
 *          minus `world.getHeight(x,z)`. Negative = the drawn LOD mesh sits
 *          BELOW the field the rock was planted against, which is exactly how
 *          a correctly-planted rock ends up in the air.
 *   los    along the camera's line of sight to the rock: distance to the first
 *          terrain hit minus distance to the first rock hit. Large positive
 *          means there is no ground behind the rock anywhere near it — the
 *          "sky visible underneath" read.
 *
 *   node tools/_scratch/rocksag.mjs meadow
 *   node tools/_scratch/rocksag.mjs peaks
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const view = process.argv[2] || 'meadow';
const VIEWS = {
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46 },
  peaks:  { anchor: 'peak',   height: 120, dist: 420, pitch: -0.10, fov: 42 },
  dawn:   { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58 },
};
const v = VIEWS[view];
const anchors = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));
const a = anchors[v.anchor];

await acquire('rocksag');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
        set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto('http://localhost:5178');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await p.evaluate(async ({ a, v }) => {
  const THREE = window.__THREE;
  const cam = window.__engine.camera;
  window.__forceCamera = true;
  const yaw = a.yaw ?? 0;
  const gx = a.x, gz = a.z;
  const w = window.__world;
  cam.fov = v.fov; cam.aspect = 1280 / 720;
  cam.position.set(gx, w.getHeight(gx, gz) + v.height, gz);
  cam.lookAt(gx + Math.sin(yaw) * v.dist,
    cam.position.y + Math.tan(v.pitch) * v.dist,
    gz + Math.cos(yaw) * v.dist);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  await window.__settleStable(1500, 30);

  const terrain = window.__terrain.group;
  const rocks = window.__systems.rocks?.group;
  const rc = new THREE.Raycaster();
  rc.far = 8000;

  // Collect every drawn rock instance in the frustum by reading the packed
  // instance matrices straight off the InstancedMeshes — that is what is on
  // screen, whatever the scatter thinks it emitted.
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const rows = [];
  rocks.traverse((o) => {
    if (!o.isInstancedMesh || !o.count) return;
    o.geometry.computeBoundingSphere();
    const br = o.geometry.boundingSphere.radius;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.decompose(pos, q, sc);
      if (!frustum.containsPoint(pos)) continue;
      const d = pos.distanceTo(cam.position);
      if (d > 1400) continue;
      const radius = br * Math.max(sc.x, sc.y, sc.z);
      if (radius < 2) continue;                     // ignore ground texture
      const ndc = pos.clone().project(cam);
      rows.push({ name: o.name || o.userData.arch || 'rock', i,
        x: pos.x, y: pos.y, z: pos.z, r: radius, d,
        px: Math.round((ndc.x * 0.5 + 0.5) * 1280),
        py: Math.round((0.5 - ndc.y * 0.5) * 720) });
    }
  });

  // sag: vertical ray onto the DRAWN terrain
  const down = new THREE.Vector3(0, -1, 0);
  for (const r of rows) {
    rc.set(new THREE.Vector3(r.x, 4000, r.z), down);
    const h = rc.intersectObject(terrain, true)[0];
    r.drawnH = h ? h.point.y : null;
    r.fieldH = w.getHeight(r.x, r.z);
    r.sag = h ? h.point.y - r.fieldH : null;
  }

  // los: how far behind the rock the terrain is, along the eye ray
  const dir = new THREE.Vector3();
  for (const r of rows) {
    dir.set(r.x - cam.position.x, r.y - cam.position.y, r.z - cam.position.z).normalize();
    rc.set(cam.position.clone(), dir);
    const th = rc.intersectObject(terrain, true)[0];
    const rh = rc.intersectObject(rocks, true)[0];
    r.tDist = th ? th.distance : null;
    r.rDist = rh ? rh.distance : null;
    r.los = th && rh ? th.distance - rh.distance : null;
  }
  return { cam: cam.position.toArray().map((n) => Math.round(n)), rows };
}, { a, v });

const rows = out.rows;
console.log(`view ${view}  cam ${out.cam}  instances ${rows.length}`);
const sags = rows.filter((r) => r.sag !== null).map((r) => r.sag).sort((x, y) => x - y);
const qt = (arr, f) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))].toFixed(1) : 'n/a';
console.log(`drawn-minus-field sag: p05 ${qt(sags, 0.05)}  median ${qt(sags, 0.5)}  p95 ${qt(sags, 0.95)}  min ${qt(sags, 0)}`);
const los = rows.filter((r) => r.los !== null).map((r) => r.los).sort((x, y) => x - y);
console.log(`terrain-behind-rock along eye ray: median ${qt(los, 0.5)}  p90 ${qt(los, 0.9)}  max ${qt(los, 0.999)}`);
const noT = rows.filter((r) => r.tDist === null);
console.log(`rocks with NO terrain behind them at all: ${noT.length} / ${rows.length}`);
const far = rows.filter((r) => r.los !== null && r.los > r.r * 3).sort((x, y) => y.los - x.los);
console.log(`rocks with terrain more than 3 radii behind (detached read): ${far.length}`);
for (const r of far.slice(0, 15)) {
  console.log(`  ${r.name} px${r.px},${r.py} d${r.d | 0} r${r.r.toFixed(1)} los+${r.los.toFixed(0)} sag ${r.sag === null ? 'none' : r.sag.toFixed(1)} @${r.x | 0},${r.z | 0}`);
}
for (const r of noT.slice(0, 15)) {
  console.log(`  NOTERRAIN ${r.name} px${r.px},${r.py} d${r.d | 0} r${r.r.toFixed(1)} sag ${r.sag === null ? 'none' : r.sag.toFixed(1)} @${r.x | 0},${r.z | 0}`);
}
await b.close();

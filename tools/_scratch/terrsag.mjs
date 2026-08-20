#!/usr/bin/env node
/**
 * Drawn terrain vs the analytic heightfield, at a list of world (x,z) points.
 *
 * Placement asks `world.getHeight`; the player sees `Terrain`'s LOD mesh. Every
 * float audit in this tree assumes those two agree — the standing claim is
 * "mean sag 0.2-0.6 m, worst 6.4 m at 800 m" — and the `meadow` frame shows
 * blocks the offline audit calls 20-70 m BURIED standing in clear air, so one
 * of the two numbers is wrong. This measures it at the camera and range the
 * defect is seen at, from inside the live page.
 *
 *   node tools/_scratch/terrsag.mjs meadow
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const view = process.argv[2] || 'meadow';
const VIEWS = {
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  peaks:  { anchor: 'peak',   height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  dawn:   { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
};
const v = VIEWS[view];
const anchors = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));
const a = anchors[v.anchor];

await acquire('terrsag');
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
  const w = window.__world;
  window.__forceCamera = true;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const yaw = a.yaw ?? 0;
  const gy = w.getHeight(a.x, a.z) + v.height;
  cam.fov = v.fov; cam.updateProjectionMatrix();
  cam.position.set(a.x, gy, a.z);
  cam.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
  window.dispatchEvent(new Event('resize'));
  await window.__settleStable(1500, 30);

  const terrain = window.__terrain.group;
  const rc = new THREE.Raycaster(); rc.far = 9000;
  const down = new THREE.Vector3(0, -1, 0);
  const bands = [];
  // Radial fan out along the view direction, so each sample's range is known.
  for (const dist of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    const sags = [];
    for (let k = -6; k <= 6; k++) {
      const th = yaw + k * 0.055;
      const x = a.x + Math.sin(th) * dist, z = a.z + Math.cos(th) * dist;
      if (Math.abs(x) > w.half || Math.abs(z) > w.half) continue;
      rc.set(new THREE.Vector3(x, 5000, z), down);
      const h = rc.intersectObject(terrain, true)[0];
      if (!h) continue;
      sags.push({ x, z, drawn: h.point.y, field: w.getHeight(x, z) });
    }
    if (!sags.length) continue;
    const d = sags.map((s) => s.drawn - s.field);
    d.sort((m, n) => m - n);
    bands.push({ dist, n: d.length, min: d[0], med: d[d.length >> 1], max: d[d.length - 1],
      mean: d.reduce((m, n) => m + n, 0) / d.length });
  }

  // And at the exact instance origins the offline audit calls deeply buried.
  const pts = window.__probePoints || [];
  const spot = [];
  for (const [x, z] of pts) {
    rc.set(new THREE.Vector3(x, 5000, z), down);
    const h = rc.intersectObject(terrain, true)[0];
    spot.push({ x, z, drawn: h ? h.point.y : null, field: w.getHeight(x, z),
      d: Math.hypot(x - cam.position.x, z - cam.position.z) });
  }
  return { cam: [cam.position.x, cam.position.y, cam.position.z].map(Math.round), bands, spot,
    lod: window.__terrain.stats ?? null };
}, { a, v });

console.log(`view ${view} cam ${out.cam}`);
console.log('range   n   drawn-minus-field  (metres; negative = drawn mesh below the field)');
for (const b of out.bands) {
  console.log(`${String(b.dist).padStart(5)}  ${String(b.n).padStart(2)}   min ${b.min.toFixed(1).padStart(7)}  med ${b.med.toFixed(1).padStart(7)}  mean ${b.mean.toFixed(1).padStart(7)}  max ${b.max.toFixed(1).padStart(7)}`);
}
for (const s of out.spot) {
  console.log(`  @${s.x | 0},${s.z | 0} d${s.d | 0}  drawn ${s.drawn === null ? 'MISS' : s.drawn.toFixed(1)}  field ${s.field.toFixed(1)}  sag ${s.drawn === null ? '-' : (s.drawn - s.field).toFixed(1)}`);
}
await b.close();

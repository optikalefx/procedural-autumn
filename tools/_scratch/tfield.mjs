// Follow-up to tsun.mjs. Two questions:
//  (a) are the sun rays exiting the world boundary before they can reach a
//      distant massif -- i.e. is "no long-range caster" an artifact?
//  (b) is there a LANDFORM-SCALE (100-300 m) value event in the ground fan at
//      all, measured as N.L over a heavily smoothed heightfield?
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync, existsSync } from 'node:fs';
await acquire('tfield');

const VIEWS = {
  hero:    { anchor: 'vista',  height: 62,  hour: 16.7 },
  drive:   { anchor: 'road',   height: 4.2, hour: 16.7, standOff: 16 },
  meadow:  { anchor: 'meadow', height: 1.6, hour: 17.2 },
  vehicle: { anchor: 'vehicle',height: 2.6, hour: 17.0 },
  backlit: { anchor: 'meadow', height: 2.4, hour: 17.9, faceSun: true },
};
let frozen = {};
for (const p of ['shots/_views.json', 'shots/_anchors.json'])
  if (existsSync(p)) { try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...frozen }; } catch {} }

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await p.evaluate(({ VIEWS, frozen }) => {
  const wd = window.__world, L = window.__lighting, T = window.__THREE;
  const api = window.__cameraAnchors || {};
  // Coarse height: box-average getBaseHeight over a radius R. Landform scale.
  const coarseH = (x, z, R) => {
    let s = 0, n = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      s += wd.getBaseHeight(x + i * R * 0.5, z + j * R * 0.5); n++;
    }
    return s / n;
  };
  const coarseNdL = (x, z, R, sd) => {
    const e = R;
    const hL = coarseH(x - e, z, R), hR = coarseH(x + e, z, R);
    const hD = coarseH(x, z - e, R), hU = coarseH(x, z + e, R);
    const n = new T.Vector3(hL - hR, 2 * e, hD - hU).normalize();
    return n.dot(sd);
  };
  const lines = [];
  for (const [name, v] of Object.entries(VIEWS)) {
    L.hour = v.hour; L.cycleSpeed = 0;
    if (L.update) try { L.update(1 / 60, window.__engine.camera.position); } catch {}
    const sd = L.sunDir.clone().normalize();
    const az = Math.atan2(sd.x, sd.z) * 180 / Math.PI;
    const anchor = frozen[v.anchor] || (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))();
    let yaw = anchor.yaw ?? 0;
    if (v.faceSun) yaw = Math.atan2(sd.x, sd.z);
    const back = v.standOff ?? 0;
    const cx = anchor.x - Math.sin(yaw) * back, cz = anchor.z - Math.cos(yaw) * back;

    // (a) how far can a sun ray from the fan centre travel inside the world?
    let reach = 0;
    for (let d = 6; d < 3000; d += 6) {
      if (Math.abs(cx + sd.x * d) > 1530 || Math.abs(cz + sd.z * d) > 1530) break;
      reach = d;
    }
    // tallest thing anywhere along that ray, and its height over the fan
    const y0 = wd.getHeight(cx, cz);
    let best = -1e9, bestD = 0;
    for (let d = 20; d <= reach; d += 8) {
      const h = wd.getBaseHeight(cx + sd.x * d, cz + sd.z * d);
      const need = y0 + sd.y * d;      // height the ray is at
      if (h - need > best) { best = h - need; bestD = d; }
    }

    // (b) landform-scale N.L across the fan, at three smoothing radii
    const stats = [];
    for (const R of [40, 90, 180]) {
      let mn = 9, mx = -9, s = 0, s2 = 0, n = 0;
      for (let r = 8; r <= 220; r += 8) for (let t = -0.5; t <= 0.5; t += 0.06) {
        const a = yaw + t;
        const g = coarseNdL(cx + Math.sin(a) * r, cz + Math.cos(a) * r, R, sd);
        mn = Math.min(mn, g); mx = Math.max(mx, g); s += g; s2 += g * g; n++;
      }
      const mean = s / n, sdv = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      stats.push(`R${String(R).padStart(3)}: mean ${mean.toFixed(3)} sd ${sdv.toFixed(3)} range ${mn.toFixed(2)}..${mx.toFixed(2)}`);
    }
    lines.push(`${name.padEnd(8)} az ${az.toFixed(0).padStart(5)}deg  ray reach ${String(reach).padStart(4)}m  best occluder margin ${best.toFixed(1)}m @ ${bestD}m`);
    lines.push(`         ${stats.join('   ')}`);
  }
  return lines;
}, { VIEWS, frozen });
console.log(out.join('\n'));
await b.close();

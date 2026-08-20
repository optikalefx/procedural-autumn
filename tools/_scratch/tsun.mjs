// X2 / L6 follow-up: does the TERRAIN itself geometrically shadow the ground
// each eye-level camera sees, and where are the occluders relative to the sun
// shadow frustum? Pure CPU ray-march of the baked heightfield -- no renderer.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { readFileSync, existsSync } from 'node:fs';
await acquire('tsun');

const VIEWS = {
  hero:    { anchor: 'vista',  height: 62,  dist: 150, hour: 16.7 },
  drive:   { anchor: 'road',   height: 4.2, dist: 12,  hour: 16.7, standOff: 16 },
  meadow:  { anchor: 'meadow', height: 1.6, dist: 6,   hour: 17.2 },
  vehicle: { anchor: 'vehicle',height: 2.6, dist: 11,  hour: 17.0 },
  backlit: { anchor: 'meadow', height: 2.4, dist: 10,  hour: 17.9, faceSun: true },
  dawn:    { anchor: 'vista',  height: 48,  dist: 130, hour: 7.4 },
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
  const wd = window.__world, L = window.__lighting;
  const api = window.__cameraAnchors || {};
  const lines = [];
  for (const [name, v] of Object.entries(VIEWS)) {
    L.hour = v.hour; L.cycleSpeed = 0;
    // force one lighting update so sunDir matches the hour
    if (L.update) try { L.update(1 / 60, window.__engine.camera.position); } catch {}
    const sd = L.sunDir.clone().normalize();
    const elev = Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180 / Math.PI;
    const anchor = frozen[v.anchor] || (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))();
    let yaw = anchor.yaw ?? 0;
    if (v.faceSun) yaw = Math.atan2(sd.x, sd.z);
    const back = v.standOff ?? 0;
    const cx = anchor.x - Math.sin(yaw) * back, cz = anchor.z - Math.cos(yaw) * back;
    const cy = wd.getHeight(cx, cz) + v.height;

    // Shadow extent the current formula picks for this camera.
    const above = cy - wd.getHeight(cx, cz);
    const extent = Math.max(150, Math.min(900, 150 + Math.max(above, 0) * 12.0));

    // Ground fan the camera sees: radius 8..220 m, +/- 0.5 rad about yaw.
    let n = 0, shaded = 0, sunFacing = 0, castShade = 0, backFace = 0;
    const bins = [0, 0, 0, 0, 0];   // occluder dist <extent | <300 | <600 | <1000 | >=1000
    let sumOcc = 0;
    const STEP = 6, MAXD = 1600;
    for (let r = 8; r <= 220; r += 6) {
      for (let t = -0.5; t <= 0.5; t += 0.05) {
        const a = yaw + t;
        const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
        const y0 = wd.getHeight(x, z);
        n++;
        const nrm = wd.getNormal(x, z, new window.__THREE.Vector3(), 2.0);
        const ndl = nrm.dot(sd);
        const facing = ndl > 0.05;
        if (facing) sunFacing++; else backFace++;
        // march toward the sun
        let hit = -1;
        for (let d = STEP; d < MAXD; d += STEP) {
          const px = x + sd.x * d, pz = z + sd.z * d;
          if (Math.abs(px) > 1530 || Math.abs(pz) > 1530) break;
          const ry = y0 + 0.6 + sd.y * d;
          if (ry > 360) break;                      // above every peak
          if (wd.getHeight(px, pz) > ry) { hit = d; break; }
        }
        if (hit > 0) {
          shaded++;
          if (facing) {
            castShade++; sumOcc += hit;
            bins[hit < extent ? 0 : hit < 300 ? 1 : hit < 600 ? 2 : hit < 1000 ? 3 : 4]++;
          }
        }
      }
    }
    const pc = (x) => (100 * x / n).toFixed(1).padStart(5);
    lines.push(
      `${name.padEnd(8)} sun ${elev.toFixed(1).padStart(5)}deg  cam(${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)})` +
      `  ext ${extent.toFixed(0).padStart(3)}m  backface ${pc(backFace)}%  CAST ${pc(castShade)}%` +
      `   occl: <ext ${pc(bins[0])} ext-300 ${pc(bins[1])} 300-600 ${pc(bins[2])} 600-1k ${pc(bins[3])} >1k ${pc(bins[4])}` +
      `   meanOcc ${castShade ? (sumOcc / castShade).toFixed(0) : '-'}m`
    );
  }
  return lines;
}, { VIEWS, frozen });
console.log(out.join('\n'));
await b.close();

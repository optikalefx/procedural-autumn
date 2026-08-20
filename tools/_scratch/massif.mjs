// X2 — does long-range terrain self-shadowing reach the valley floor at eye level?
//
// Not a picture question. For each canonical eye-level view, take the ground
// points the camera actually sees, march each one toward the sun across the
// baked heightfield, and record whether it is terrain-shadowed and HOW FAR
// AWAY its occluder is. Compare that distance against the sun shadow camera's
// half-extent, which is what decides whether the occluder was ever rendered
// into the shadow map at all.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const VIEWNAMES = (arg('views', 'drive,meadow,vehicle,hero')).split(',');

const VIEWS = {
  hero:    { anchor: 'vista',   height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:  { anchor: 'meadow',  height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  vehicle: { anchor: 'vehicle', height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0 },
  backlit: { anchor: 'meadow',  height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  noon:    { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 12.0, standOff: 16 },
  d1400:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 14.0, standOff: 16, far: 900 },
  d1530:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 15.5, standOff: 16, far: 900 },
  d1640:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16, far: 900 },
  d1730:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 17.5, standOff: 16, far: 900 },
  d1830:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 18.3, standOff: 16, far: 900 },
  d0900:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 9.0,  standOff: 16, far: 900 },
  d1200:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 12.0, standOff: 16, far: 900 },
  d0724:   { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 7.4,  standOff: 16, far: 900 },
  mfar:    { anchor: 'meadow',  height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2, far: 900 },
  morning: { anchor: 'road',    height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 9.0,  standOff: 16 },
  dawn:    { anchor: 'vista',   height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};
await acquire('massif');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

for (const name of VIEWNAMES) {
  const v = VIEWS[name]; if (!v) continue;
  const out = await page.evaluate(async ({ v, frozen }) => {
    const e = window.__engine, wd = window.__world, api = window.__cameraAnchors || {};
    const L = window.__lighting;
    L.hour = v.hour; L.cycleSpeed = 0;
    const anchor = frozen[v.anchor] ?? (api[v.anchor] || api.vista)();
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = L.computeSunDir(v.hour); yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    const camX = gx - Math.sin(yaw) * v.dist, camZ = gz - Math.cos(yaw) * v.dist;
    const camY = wd.getHeight(camX, camZ) + v.height;
    // Drive the real shadow-extent path with this camera position.
    L.update(0.016, { x: camX, y: camY, z: camZ });
    const sd = L.sunDir;
    const horiz = Math.hypot(sd.x, sd.z) || 1e-6;
    const tanElev = sd.y / horiz;
    const ux = sd.x / horiz, uz = sd.z / horiz;

    // Sample the ground fan the camera sees: fov wide, out to 240 m.
    const half = (v.fov * Math.PI / 180) * 0.5 * (16 / 9) * 0.9;
    const pts = [];
    for (let a = -half; a <= half; a += half / 12) {
      for (let d = 8; d <= (v.far ?? 240); d += 4) {
        const px = camX + Math.sin(yaw + a) * d, pz = camZ + Math.cos(yaw + a) * d;
        pts.push([px, pz, d]);
      }
    }
    // March each toward the sun. Step 4 m out to 1400 m.
    let shadowed = 0, lit = 0;
    const occD = [];
    const BINS = [50, 100, 200, 400, 700, 1200];
    const binN = BINS.map(() => 0), binS = BINS.map(() => 0);
    let beyondExtent = 0, withinExtent = 0;
    const ext = L.shadowExtent;
    for (const [px, pz, d] of pts) {
      const h0 = wd.getBaseHeight(px, pz);
      let hit = -1;
      for (let t = 6; t <= 1400; t += (t < 200 ? 3 : 8)) {
        const sx = px + ux * t, sz = pz + uz * t;
        if (Math.abs(sx) > wd.half || Math.abs(sz) > wd.half) break;
        const hs = wd.getBaseHeight(sx, sz);
        if (hs > h0 + tanElev * t + 0.4) { hit = t; break; }
      }
      let bi = BINS.findIndex((b) => d <= b); if (bi < 0) bi = BINS.length - 1;
      binN[bi]++;
      if (hit > 0) {
        shadowed++; occD.push(hit); binS[bi]++;
        // The occluder is only in the sun's shadow frustum if it is inside the
        // ortho half-extent measured from the CAMERA, not from the receiver.
        const ox = px + ux * hit, oz = pz + uz * hit;
        if (Math.hypot(ox - camX, oz - camZ) > ext) beyondExtent++; else withinExtent++;
      } else lit++;
    }
    occD.sort((a, b) => a - b);
    const q = (f) => occD.length ? occD[Math.min(occD.length - 1, Math.floor(occD.length * f))] : NaN;
    return {
      n: pts.length, sunElevDeg: +(Math.asin(sd.y) * 180 / Math.PI).toFixed(1),
      shadowExtent: +ext.toFixed(0), camAboveGround: +(camY - wd.getHeight(camX, camZ)).toFixed(1),
      shadowedPct: +(100 * shadowed / pts.length).toFixed(1),
      occMedian: +q(0.5).toFixed(0), occP10: +q(0.1).toFixed(0), occP90: +q(0.9).toFixed(0),
      occBeyondExtentPct: shadowed ? +(100 * beyondExtent / shadowed).toFixed(1) : 0,
      reachablePct: +(100 * withinExtent / pts.length).toFixed(1),
      byRange: BINS.map((b, i) => `${b}m:${binN[i] ? (100 * binS[i] / binN[i]).toFixed(0) : '-'}%`).join(' '),
    };
  }, { v, frozen });
  console.log(name.padEnd(9), JSON.stringify(out));
}
await browser.close();

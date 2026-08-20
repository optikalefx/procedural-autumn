// Verify the massif field is built, has content, and that the drive fan sees it.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const VIEWNAMES = (arg('views', 'drive,meadow,vehicle,hero')).split(',');
const VIEWS = {
  hero:    { anchor: 'vista',   height: 62,  dist: 150, fov: 46, hour: 16.7 },
  drive:   { anchor: 'road',    height: 4.2, dist: 12,  fov: 55, hour: 16.7, standOff: 16 },
  meadow:  { anchor: 'meadow',  height: 1.6, dist: 6,   fov: 58, hour: 17.2 },
  vehicle: { anchor: 'vehicle', height: 2.6, dist: 11,  fov: 44, hour: 17.0 },
  backlit: { anchor: 'meadow',  height: 2.4, dist: 10,  fov: 52, hour: 17.9, faceSun: true },
  noon:    { anchor: 'road',    height: 4.2, dist: 12,  fov: 55, hour: 12.0, standOff: 16 },
  morning: { anchor: 'road',    height: 4.2, dist: 12,  fov: 55, hour: 9.0,  standOff: 16 },
  evening: { anchor: 'road',    height: 4.2, dist: 12,  fov: 55, hour: 18.6, standOff: 16 },
  dawn:    { anchor: 'vista',   height: 48,  dist: 130, fov: 46, hour: 7.4 },
};
const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};
await acquire('massifprobe');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
console.log(await page.evaluate(() => {
  const a = window.__atmosphere, ms = a?.massif;
  if (!ms) return 'NO MASSIF';
  const b = ms._bytes; let nz = 0, sum = 0, mx = 0;
  for (let i = 0; i < b.length; i++) { if (b[i] > 6) nz++; sum += b[i]; if (b[i] > mx) mx = b[i]; }
  return { ready: ms.ready, rebuilds: ms.rebuilds, costMs: +ms.lastCostMs.toFixed(2),
           worldSize: ms.worldSize, coveragePct: +(100 * nz / b.length).toFixed(1),
           meanByte: +(sum / b.length).toFixed(1), maxByte: mx, strength: a.params.massifShadow };
}));
for (const name of VIEWNAMES) {
  const v = VIEWS[name]; if (!v) continue;
  console.log(name.padEnd(9), JSON.stringify(await page.evaluate(({ v, frozen }) => {
    const e = window.__engine, wd = window.__world, api = window.__cameraAnchors || {}, L = window.__lighting;
    const a = window.__atmosphere, ms = a.massif;
    L.hour = v.hour; L.cycleSpeed = 0;
    const anchor = frozen[v.anchor] ?? (api[v.anchor] || api.vista)();
    let yaw = anchor.yaw ?? 0;
    if (v.faceSun) { const sd = L.computeSunDir(v.hour); yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const camX = gx - Math.sin(yaw) * v.dist, camZ = gz - Math.cos(yaw) * v.dist;
    const camY = wd.getHeight(camX, camZ) + v.height;
    L.update(0.016, { x: camX, y: camY, z: camZ });
    ms._lastBuild = -1e9; ms.update(L.sunDir, 1e9);
    const N = 256, half = wd.worldSize / 2;
    const at = (x, z) => {
      const u = (x + half) / wd.worldSize * N, w = (z + half) / wd.worldSize * N;
      const i = Math.max(0, Math.min(N - 1, Math.round(u - 0.5))), j = Math.max(0, Math.min(N - 1, Math.round(w - 0.5)));
      return ms._bytes[i + j * N] / 255;
    };
    // The fan the camera sees, out to 400 m.
    const halfA = (v.fov * Math.PI / 180) * 0.5 * (16 / 9) * 0.9;
    let n = 0, shaded = 0, sum = 0, edge = 0, mn = 2, mx = -1;
    for (let ang = -halfA; ang <= halfA; ang += halfA / 14) {
      for (let d = 8; d <= 400; d += 6) {
        const px = camX + Math.sin(yaw + ang) * d, pz = camZ + Math.cos(yaw + ang) * d;
        const m = at(px, pz); n++; sum += m; if (m > 0.5) shaded++;
        if (m > 0.15 && m < 0.85) edge++;
        if (m < mn) mn = m; if (m > mx) mx = m;
      }
    }
    return { sunElev: +(Math.asin(L.sunDir.y) * 180 / Math.PI).toFixed(1),
             maskMean: +(sum / n).toFixed(3), shadedPct: +(100 * shaded / n).toFixed(1),
             penumbraPct: +(100 * edge / n).toFixed(1), min: +mn.toFixed(2), max: +mx.toFixed(2),
             costMs: +ms.lastCostMs.toFixed(2) };
  }, { v, frozen })));
}
await browser.close();

// Capture one grass view through every uDebug channel in a single session.
//
//   node tools/grass_dev/dbg.mjs low shots/grass/dbg
//
// Channels: 0 beauty, 1 albedo, 2 vT, 3 shadow mask, 4 (tone,dry,shade), 5 normal.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const VIEWS = {
  low:      { anchor: 'meadow', height: 1.2,  dist: 8,  pitch: -0.02, fov: 60, hour: 17.2 },
  lowsun:   { anchor: 'meadow', height: 1.15, dist: 8,  pitch: 0.02,  fov: 60, hour: 17.9, faceSun: true },
  meadow:   { anchor: 'meadow', height: 1.6,  dist: 6,  pitch: -0.05, fov: 58, hour: 17.2 },
  riverlow: { anchor: 'river',  height: 1.4,  dist: 12, pitch: -0.02, fov: 58, hour: 16.9 },
};

const view = process.argv[2] || 'low';
const dir  = process.argv[3] || 'shots/grass/dbg';
const channels = (process.argv[4] || '0,1,3,4').split(',').map(Number);

mkdirSync(resolve(dir), { recursive: true });
await acquire('grass-dbg');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5178?res=768');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

await p.evaluate(async (v) => {
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const a = (window.__cameraAnchors[v.anchor] || window.__cameraAnchors.vista)();
  let yaw = a.yaw ?? 0;
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const gy = wd.getHeight(a.x, a.z) + v.height;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x, gy, a.z);
  e.camera.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
  window.__forceCamera = true;
  await window.__settle(70);
}, VIEWS[view]);

for (const ch of channels) {
  await p.evaluate((ch) => { window.__systems.grass.uniforms.uDebug.value = ch; }, ch);
  await p.waitForTimeout(500);
  await p.screenshot({ path: resolve(dir, `${view}_d${ch}.png`) });
  console.log('ok', view, 'debug', ch);
}
await p.evaluate(() => { window.__systems.grass.uniforms.uDebug.value = 0; });
await b.close();

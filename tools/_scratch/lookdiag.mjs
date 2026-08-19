// Pose a canonical view, then run arbitrary JS and/or capture. Look author scratch.
//   node tools/_scratch/lookdiag.mjs --view river --js "JSON.stringify(...)" --out shots/look/x.png
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  vehicle:   { anchor: 'vehicle',  height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0, subject: true },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const RES = arg('res', null);
const VIEW = arg('view', 'river');
const HOUR = arg('hour', null);
const PRE = arg('pre', null);   // JS run before settle
const JS = arg('js', null);     // JS run after settle, result printed
const OUT = arg('out', null);

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto('http://localhost:5178' + (RES ? `?res=${RES}` : ''), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

let frozen = {};
if (existsSync('review/anchors.json')) frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8'));

await page.evaluate(async ({ v, frozen, hourArg }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  const api = window.__cameraAnchors || {};
  window.__lighting.hour = hourArg ? parseFloat(hourArg) : v.hour;
  window.__lighting.cycleSpeed = 0;
  const cached = frozen[v.anchor];
  const anchor = cached ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index) : (api[v.anchor] || api.vista)());
  let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  let pos, look;
  if (v.subject) {
    const gx = anchor.x - Math.sin(yaw) * v.dist, gz = anchor.z - Math.cos(yaw) * v.dist;
    pos = new THREE.Vector3(gx, wd.getHeight(gx, gz) + v.height, gz);
    look = new THREE.Vector3(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
  } else {
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    pos = new THREE.Vector3(gx, gy, gz);
    look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  }
  const ray = new THREE.Raycaster(); ray.far = 6;
  const dir = new THREE.Vector3();
  for (let a = 0; a < 6; a++) {
    dir.copy(look).sub(pos).normalize(); ray.set(pos, dir);
    const hits = ray.intersectObjects(e.scene.children, true).filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos); e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
}, { v: VIEWS[VIEW], frozen, hourArg: HOUR });

if (PRE) await page.evaluate((s) => eval(s), PRE);
await page.evaluate(() => window.__settle?.(60));
await page.waitForTimeout(1200);
if (JS) console.log(await page.evaluate((s) => eval(s), JS));
if (OUT) {
  if (!existsSync(dirname(resolve(OUT)))) mkdirSync(dirname(resolve(OUT)), { recursive: true });
  await page.screenshot({ path: resolve(OUT) });
  console.log('shot:', OUT);
}
// --variants '[["name","js"],...]' : apply js, settle, capture into --dir
const VAR = arg('variants', null), DIR = arg('dir', 'shots/look/diag');
if (VAR) {
  mkdirSync(resolve(DIR), { recursive: true });
  for (const [name, js] of JSON.parse(VAR)) {
    await page.evaluate((s) => eval(s), js);
    await page.evaluate(() => window.__settle?.(30));
    await page.waitForTimeout(900);
    await page.screenshot({ path: resolve(DIR, name + '.png') });
    console.log('shot:', name);
  }
}
await browser.close();

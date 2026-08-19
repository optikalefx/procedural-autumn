// Sun/shade separation on IDENTICAL terrain albedo, frame-wide.
//
// Captures the posed view twice: once normally, once with the terrain material's
// uDebugMask=6 (its finished albedo, unlit) and the whole post chain bypassed.
// Every pixel then has (albedo, lit). Bucketing by albedo and reading the
// spread of `lit` inside one bucket is the terrain author's patch measurement
// done over the whole frame instead of over two hand-picked squares, so it
// cannot be gamed by where the squares were put.
//
//   node tools/_scratch/albedosep.mjs --view drive --band 0.55,1.0
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  drive:  { anchor: 'road',   height: 4.2, dist: 12, pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,  pitch: -0.05, fov: 58, hour: 17.2 },
  river:  { anchor: 'river',  height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  hero:   { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const NAMES = (arg('views', 'drive,river,meadow')).split(',');
// Vertical band of the frame to analyse, as a fraction of height.
const BAND = (arg('band', '0.55,1.0')).split(',').map(Number);

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto('http://localhost:5178', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const pose = async (v) => {
  await page.evaluate(async ({ v, frozen }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour;
    window.__lighting.cycleSpeed = 0;
    window.__atmosphere.params.cloudShadow = 0;
    const anchor = frozen[v.anchor] ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index) : (api[v.anchor] || api.vista)());
    const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    const pos = new THREE.Vector3(gx, gy, gz);
    const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
    const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { v, frozen });
  await page.evaluate(() => window.__settle?.(60));
  await page.waitForTimeout(1000);
};

const setDebug = (on) => page.evaluate((on) => {
  const p = window.__postfx;
  [p.bloom, p.tone, p.vignette, p.grade, p.dof].forEach((e) => { try { e.blendMode.opacity.value = on ? 0 : 1; } catch (_) {} });
  window.__terrain.material.userData.uniforms.uDebugMask.value = on ? 6 : 0;
}, on);

const analyse = async (lit, alb) => page.evaluate(async ({ lit, alb, BAND }) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const ia = await load(lit), ib = await load(alb);
  const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
  g.drawImage(ia, 0, 0); const dl = g.getImageData(0, 0, ia.width, ia.height).data;
  g.clearRect(0, 0, ia.width, ia.height);
  g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
  const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const y0 = Math.floor(ia.height * BAND[0]), y1 = Math.floor(ia.height * BAND[1]);
  // Bucket by albedo luma in 0.02 steps; keep the fullest bucket.
  const buckets = new Map();
  for (let y = y0; y < y1; y++) for (let x = 0; x < ia.width; x += 2) {
    const i = (y * ia.width + x) * 4;
    const a = L(db, i);
    if (a < 0.25) continue;                       // dark = not the gold ground
    const k = Math.round(a / 0.02);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([L(dl, i), i]);
  }
  const keys = [...buckets.keys()].sort((p, q) => buckets.get(q).length - buckets.get(p).length);
  const out = [];
  for (const k of keys.slice(0, 3)) {
    const arr = buckets.get(k); arr.sort((p, q) => p[0] - q[0]);
    const at = (f) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
    const px = (e) => { const i = e[1]; return '#' + [dl[i], dl[i+1], dl[i+2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); };
    // Mean of the darkest 12% and of the brightest 12% inside the bucket.
    const n = Math.max(1, Math.floor(arr.length * 0.12));
    let lo = 0, hi = 0, lr = 0, lg = 0, lb = 0;
    for (let j = 0; j < n; j++) { lo += arr[j][0]; const i = arr[j][1]; lr += dl[i]; lg += dl[i+1]; lb += dl[i+2]; }
    for (let j = arr.length - n; j < arr.length; j++) hi += arr[j][0];
    lo /= n; hi /= n; lr /= n; lg /= n; lb /= n;
    const mx = Math.max(lr, lg, lb), mn = Math.min(lr, lg, lb);
    out.push({ albedo: +(k * 0.02).toFixed(2), px: arr.length,
      shaded: +lo.toFixed(3), sunlit: +hi.toFixed(3), sep: +(hi - lo).toFixed(3),
      shadedHex: '#' + [lr, lg, lb].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
      shadedChroma: +((mx - mn) / 255).toFixed(3),
      p50: +at(0.5)[0].toFixed(3), sunlitHex: px(at(0.97)) });
  }
  return out;
}, { lit, alb, BAND });

for (const name of NAMES) {
  const v = VIEWS[name]; if (!v) continue;
  await pose(v);
  const lit = (await page.screenshot()).toString('base64');
  await setDebug(true);
  await page.waitForTimeout(400);
  const alb = (await page.screenshot()).toString('base64');
  await setDebug(false);
  const rows = await analyse(lit, alb);
  console.log(`\n${name}   (albedo bucket : shaded -> sunlit = separation)`);
  for (const r of rows) {
    console.log(`  albedo ${r.albedo}  n=${String(r.px).padEnd(7)} shaded ${r.shaded} ${r.shadedHex} chroma ${r.shadedChroma}   sunlit ${r.sunlit} ${r.sunlitHex}   SEP ${r.sep}`);
  }
}
await browser.close();

// X2 — sweep the Atmosphere cloud-shadow knobs across the canonical views in
// ONE page load, and report what the term is actually worth at each view.
//
// Two shot.mjs runs ten minutes apart are not an A/B of this change: a dozen
// authors are editing the tree and the world rebakes between them. Posing each
// view once and photographing it under every variant in the same session is the
// only way to attribute a difference to one setting. Derived from
// _scratch/looksweep.mjs; the addition is the numeric block, because the
// question "is the term even reaching the ground here" is answered by the
// coverage under the camera and not by looking at a PNG.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/look/sweep');
const VIEWNAMES = (arg('views', 'drive,meadow')).split(',');
const VARIANTS = (arg('variants', 'base=()=>{}')).split('::').map((x) => {
  const i = x.indexOf('='); return { label: x.slice(0, i), on: x.slice(i + 1) };
});

const VIEWS = {
  hero:      { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest', height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  backlit:   { anchor: 'meadow', height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  vehicle:   { anchor: 'vehicle',height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0 },
  dawn:      { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
  river:     { anchor: 'river',  height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42 },
  waterfall: { anchor: 'waterfall', height: 11, dist: 58, pitch: 0.08, fov: 50, hour: 16.2, yawOffset: -0.55 },
  noon:      { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 12.0, standOff: 16 },
  morning:   { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 9.0,  standOff: 16 },
  evening:   { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 18.6, standOff: 16 },
};

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};
await acquire('x2sweep');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
for (const va of VARIANTS) mkdirSync(`${DIR}/${va.label}`, { recursive: true });

for (const name of VIEWNAMES) {
  const v = VIEWS[name]; if (!v) continue;
  const info = await page.evaluate(async ({ v, frozen }) => {
    const e = window.__engine, wd = window.__world, api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
    const anchor = frozen[v.anchor] ?? (api[v.anchor] || api.vista)();
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx, gy, gz);
    e.camera.lookAt(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
    window.__forceCamera = true; window.dispatchEvent(new Event('resize'));
    if (window.__settle) await window.__settle(90);

    // What the fog chunk is actually being handed at this view, and what the
    // baked silhouette reads over the ground fan the camera can see.
    const p = window.__atmosphere.params;
    const c = window.__systems.clouds;
    const img = c.shadowMap.image, d = img.data, W = img.width;
    const at = (u, vv) => {
      const x = (((u % 1) + 1) % 1) * W - 0.5, y = (((vv % 1) + 1) % 1) * W - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const g = (i, j) => d[((((j % W) + W) % W) * W + (((i % W) + W) % W))] / 255;
      return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy)
           + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
    };
    const ss = (x, lo, hi) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
    const sc = p.cloudScale * p.cloudScaleMul, s2 = p.cloudScale2;
    const off = p.cloudOffset;
    const sd = window.__lighting.sunDir;
    const sy = Math.max(sd.y, 0.16);
    let acc = 0, n = 0, lit = 0, deep = 0;
    // Histogram of the raw two-tap coverage, which is the quantity the critic
    // claims is pinned at >=0.90. The bake writes 0.38 + 0.52 * h, so 0.38 is
    // "no cloud" and 0.90 is "solid": bin against that, not against 0..1.
    const covBins = [0, 0, 0, 0, 0]; // <=.40 | .40-.55 | .55-.70 | .70-.88 | >.88
    for (let r = 8; r < 220; r += 6) for (let t = -0.55; t <= 0.55; t += 0.05) {
      const wx = gx + Math.sin(yaw + t) * r, wz = gz + Math.cos(yaw + t) * r;
      const wy = wd.getHeight(wx, wz);
      const climb = Math.min(4200, Math.max(0, (p.cloudAltitude - wy) / sy));
      const u = (wx + sd.x * climb) * sc + off.x * p.cloudScaleMul;
      const vv = (wz + sd.z * climb) * sc + off.y * p.cloudScaleMul;
      const a = 0.8 * u + 0.6 * vv, b2 = -0.6 * u + 0.8 * vv;
      const cov = Math.max(at(u, vv), at(a * s2 + 0.421, b2 * s2 + 0.137));
      const m = ss(cov, p.cloudSoftLo, p.cloudSoftHi);
      acc += m; n++; if (m < 0.05) lit++; if (m > 0.6) deep++;
      covBins[cov <= 0.40 ? 0 : cov < 0.55 ? 1 : cov < 0.70 ? 2 : cov < 0.88 ? 3 : 4]++;
    }
    return {
      hour: v.hour, sunElev: +sd.y.toFixed(3),
      cloudShadow: +p.cloudShadow.toFixed(3),
      effStrength: +(p.cloudShadow * p.cloudShadowGain).toFixed(3),
      meanMask: +(acc / n).toFixed(3),
      litPct: +(100 * lit / n).toFixed(1),
      shadedPct: +(100 * deep / n).toFixed(1),
      cov: covBins.map((c) => +(100 * c / n).toFixed(1)).join('/'),
    };
  }, { v, frozen });
  console.log(name, JSON.stringify(info));

  for (const va of VARIANTS) {
    await page.evaluate((src) => eval(src)(), va.on);
    await page.evaluate(async () => { if (window.__settle) await window.__settle(8); });
    await page.waitForTimeout(250);
    writeFileSync(`${DIR}/${va.label}/${name}.png`, await page.screenshot());
  }
  process.stderr.write(`[x2sweep] ${name}\n`);
}
await browser.close();

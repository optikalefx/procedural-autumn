// X2 / L5 — the hue-separation ladder, in ONE page load.
//
// The colour half of X2 is open (L5, X6-reply): the shadow tint meets the
// critic's target in LINEAR and the target was measured in sRGB, so on screen
// we are a third of the way there. X6 declined to spend it because the setting
// that lands on target puts the WATER wrong. This measures both at once —
// warm ground pixels and blue-led pixels are separated automatically and
// reported separately, so "the ground got better and the river went olive" is
// a number rather than an impression.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/look/tintlad');
const VIEWNAMES = (arg('views', 'drive,meadow,river')).split(',');
const VARIANTS = (arg('variants', 'base=()=>{}')).split('::').map((x) => {
  const i = x.indexOf('='); return { label: x.slice(0, i), on: x.slice(i + 1) };
});

const VIEWS = {
  hero:      { anchor: 'vista',  height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow', height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  river:     { anchor: 'river',  height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42 },
  backlit:   { anchor: 'meadow', height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  vehicle:   { anchor: 'vehicle',height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0 },
  dawn:      { anchor: 'vista',  height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
  noon:      { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 12.0, standOff: 16 },
  morning:   { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 9.0,  standOff: 16 },
  evening:   { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 18.6, standOff: 16 },
  late:      { anchor: 'road',   height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 17.5, standOff: 16 },
};

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};
await acquire('tintlad');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
for (const va of VARIANTS) mkdirSync(`${DIR}/${va.label}`, { recursive: true });

// Warm ground vs blue-led water, separated in the captured frame itself.
async function measure() {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const W = 480, H = Math.round(img.height / img.width * W);
    const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const acc = { gnd: [0, 0, 0, 0], wat: [0, 0, 0, 0] };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
        // Ground: warm, in the lower half, and not sky.
        if (y > H * 0.5 && r > gg && gg > b) { const a = acc.gnd; a[0] += r; a[1] += gg; a[2] += b; a[3]++; }
        // Water / anything blue-led, anywhere in frame below the skyline.
        else if (y > H * 0.35 && b >= r && b >= gg) { const a = acc.wat; a[0] += r; a[1] += gg; a[2] += b; a[3]++; }
      }
    }
    const fmt = (a) => a[3] ? { srgb: `${Math.round(a[0] / a[3])},${Math.round(a[1] / a[3])},${Math.round(a[2] / a[3])}`,
      pct: +(100 * a[3] / (W * H)).toFixed(1) } : { srgb: '-', pct: 0 };
    return { gnd: fmt(acc.gnd), wat: fmt(acc.wat) };
  }, b64);
}

for (const name of VIEWNAMES) {
  const v = VIEWS[name]; if (!v) continue;
  await page.evaluate(async ({ v, frozen }) => {
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
  }, { v, frozen });

  for (const va of VARIANTS) {
    await page.evaluate((src) => eval(src)(), va.on);
    await page.evaluate(async () => { if (window.__settle) await window.__settle(8); });
    await page.waitForTimeout(250);
    writeFileSync(`${DIR}/${va.label}/${name}.png`, await page.screenshot());
    const m = await measure();
    console.log(`${name.padEnd(8)} ${va.label.padEnd(12)} ground srgb(${m.gnd.srgb}) ${String(m.gnd.pct).padStart(5)}%   blueLed srgb(${m.wat.srgb}) ${String(m.wat.pct).padStart(5)}%`);
  }
}
await browser.close();

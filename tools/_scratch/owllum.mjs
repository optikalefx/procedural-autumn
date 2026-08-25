#!/usr/bin/env node
/**
 * How bright is the bird, actually?
 *
 * Frames a forced perch, screenshots it twice — birds visible, birds hidden —
 * and reports the luminance of the pixels that changed. That difference is the
 * only honest way to say "the owl renders at 0.06 and the sky behind it at
 * 0.21"; eyeballing a night frame is exactly how a black cut-out gets shipped.
 *
 *   AUTUMN_URL=http://127.0.0.1:5193 node tools/_scratch/owllum.mjs [hour] [key]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const HOUR = parseFloat(process.argv[2] ?? '22');
const KEY = process.argv[3] ?? 'owl';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5193') + '/?car=camper';

await acquire('shot');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(u, p);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate((h) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false;
  window.__lighting.hour = h; window.__lighting.cycleSpeed = 0;
}, HOUR);

const info = await page.evaluate(async (key) => {
  await window.__settle(60);
  const tb = window.__systems.wildlife.treeBirds;
  const cam = window.__engine.camera.position;
  let p = null;
  for (const [dx, dz] of [[40, 0], [0, 40], [-40, 0], [0, -40], [70, 70]]) {
    p = tb.debugPerchNear(cam.x + dx, cam.z + dz, key);
    if (p) break;
  }
  return p;
}, KEY);
if (!info) { console.error('no perch'); process.exit(1); }

const shoot = async (az, hide) => {
  await page.evaluate(async (v) => {
    const THREE = window.__THREE, e = window.__engine;
    const g = e.scene.getObjectByName('TreeBirds');
    if (g) g.visible = !v.hide;
    window.__forceCamera = true;
    e.camera.fov = 26;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(v.x + Math.sin(v.az) * 18, v.y + 1, v.z + Math.cos(v.az) * 18);
    e.camera.lookAt(new THREE.Vector3(v.x, v.y, v.z));
    await window.__settle?.(12);
  }, { ...info, az, hide });
  await page.waitForTimeout(300);
  return (await page.screenshot()).toString('base64');
};

for (const az of [0, 1.6, 3.1, 4.7]) {
  const on = await shoot(az, false);
  const off = await shoot(az, true);
  const r = await page.evaluate(async ({ on: a, off: b }) => {
    const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
    const ia = await load(a), ib = await load(b);
    const W = ia.width, H = ia.height;
    const ca = new OffscreenCanvas(W, H), cb = new OffscreenCanvas(W, H);
    const ga = ca.getContext('2d'), gb = cb.getContext('2d');
    ga.drawImage(ia, 0, 0); gb.drawImage(ib, 0, 0);
    const da = ga.getImageData(0, 0, W, H).data, db = gb.getImageData(0, 0, W, H).data;
    const lum = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let n = 0, sum = 0, max = 0, min = 1, bgSum = 0;
    for (let i = 0; i < da.length; i += 4) {
      // 40, not 8: this scene has grain, and at 8 the "changed" set was every
      // pixel in the frame — which is how two different birds measured to
      // within a thousandth of each other and nearly got believed.
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) < 40) continue;
      const l = lum(da, i);
      n++; sum += l; if (l > max) max = l; if (l < min) min = l;
      bgSum += lum(db, i);
    }
    return n ? { px: n, mean: sum / n, max, min, behind: bgSum / n } : { px: 0 };
  }, { on, off });
  console.log(`az ${az.toFixed(1)}  birdpx ${r.px}  mean ${r.mean?.toFixed(3)}  max ${r.max?.toFixed(3)}  min ${r.min?.toFixed(3)}  behind ${r.behind?.toFixed(3)}`);
}
await browser.close();

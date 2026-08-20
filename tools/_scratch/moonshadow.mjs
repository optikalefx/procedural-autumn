#!/usr/bin/env node
/**
 * Does the moon cast a shadow, and does it point the right way?
 *
 * "It looks like there might be a shadow there" is not a measurement. This
 * captures the identical posed frame twice — once normally, once with
 * `lighting.moon.castShadow` forced off — and reports the pixels that changed:
 * how many, how much darker they are, and where their centroid sits relative
 * to the caster. A shadow that is real shows up as a few percent of the frame
 * moving by a measurable amount; a shadow that is pointing the wrong way shows
 * up as a centroid on the moon's side of the caster instead of away from it.
 *
 *   node tools/_scratch/moonshadow.mjs --hours 0,21,5.2 --views camp,vehicle
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const HOURS = String(arg('hours', '0')).split(',').map(Number);
const DIR = resolve(arg('dir', 'shots/moonshadow'));
const URL = (arg('url', 'http://localhost:5180')) + '?res=' + arg('res', '640');
const EXTRA = { camp: { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 } };
const ALL = { ...VIEWS, ...EXTRA };
const NAMES = String(arg('views', 'camp')).split(',');

await acquire('moonshadow');
mkdirSync(DIR, { recursive: true });
let frozen = {};
for (const p of ['review/anchors.json', 'shots/_anchors.json'])
  if (existsSync(p)) { try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...frozen }; } catch { /* */ } }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', String(e)));
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const settle = async () => {
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(40);
  });
  await page.waitForTimeout(500);
};

for (const name of NAMES) {
  const v = ALL[name];
  if (!v) { console.error('unknown view', name); continue; }
  for (const hour of HOURS) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: ['vehicle'] });
    const state = await page.evaluate(() => {
      const L = window.__lighting, c = window.__engine.camera;
      const md = L.computeMoonDir(L.hour).clone();
      // Screen-space direction the shadow should fall: away from the moon.
      const p = c.position.clone();
      const a = p.clone().add(md.clone().multiplyScalar(-40)).project(c);
      const b = p.clone().add(md.clone().multiplyScalar(40)).project(c);
      return { moonElev: md.y, moonI: window.__SKY_MOON_I ?? null,
        moonLight: L.moon.intensity, casts: L.moon.castShadow,
        shadowScreenDir: [a.x - b.x, -(a.y - b.y)] };
    });

    const grab = async (tag) => {
      await settle();
      const p = `${DIR}/${name}-h${String(hour).replace('.', 'p')}-${tag}.png`;
      await page.screenshot({ path: p });
      return readFileSync(p).toString('base64');
    };

    const on = await grab('moonshadow-on');
    await page.evaluate(() => {
      const L = window.__lighting;
      L.__origMoonUpdate = L.update.bind(L);
      L.update = (dt, focus) => { L.__origMoonUpdate(dt, focus); L.moon.castShadow = false; };
    });
    const off = await grab('moonshadow-off');
    await page.evaluate(() => { if (window.__lighting.__origMoonUpdate) window.__lighting.update = window.__lighting.__origMoonUpdate; });

    const d = await page.evaluate(async ({ on, off }) => {
      const load = async (b64) => { const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode(); return im; };
      const [A, B] = await Promise.all([load(on), load(off)]);
      const W = A.width, H = A.height;
      const c1 = new OffscreenCanvas(W, H), c2 = new OffscreenCanvas(W, H);
      const g1 = c1.getContext('2d', { willReadFrequently: true });
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g1.drawImage(A, 0, 0); g2.drawImage(B, 0, 0);
      const a = g1.getImageData(0, 0, W, H).data, b = g2.getImageData(0, 0, W, H).data;
      let n = 0, sum = 0, sx = 0, sy = 0, worst = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const la = (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
        const lb = (0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]) / 255;
        const dd = lb - la;                 // positive => shadow darkened it
        if (dd > 0.004) { n++; sum += dd; sx += x; sy += y; if (dd > worst) worst = dd; }
      }
      return { pct: (100 * n) / (W * H), meanDrop: n ? sum / n : 0, maxDrop: worst,
        centroid: n ? [sx / n / W, sy / n / H] : null };
    }, { on, off });

    console.log(`${name} h${hour}  moonElev ${state.moonElev.toFixed(3)}  light ${state.moonLight.toFixed(3)}` +
      `  casts ${state.casts}\n   shadowed pixels ${d.pct.toFixed(2)}%  mean drop ${d.meanDrop.toFixed(4)}` +
      `  max ${d.maxDrop.toFixed(4)}  centroid ${d.centroid ? d.centroid.map((q) => q.toFixed(2)).join(',') : '—'}` +
      `\n   screen dir the shadow should fall: ${state.shadowScreenDir.map((q) => q.toFixed(2)).join(', ')} (x,y; +y = down)`);
  }
}
await browser.close();

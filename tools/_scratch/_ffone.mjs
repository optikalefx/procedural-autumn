#!/usr/bin/env node
/** Scratch: one settled firefly pose, filmed with the swarm on and off. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPNG } from '../_pngread.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = resolve(arg('dir', '/tmp/ffone'));
const HOUR = parseFloat(arg('hour', '21.5'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
});
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const info = await page.evaluate(async ({ hour }) => {
  const e = window.__engine;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const hudRoot = window.__systems.hud?.root;
  if (hudRoot) hudRoot.style.display = 'none';
  const a = window.__cameraAnchors.meadow ? window.__cameraAnchors.meadow() : window.__anchorAt('meadow', 0);
  const cam = window.__ctx.camera;
  const g = window.__world.getHeight(a.x, a.z);
  cam.position.set(a.x, g + 1.7, a.z);
  cam.fov = 55; cam.updateProjectionMatrix();
  cam.lookAt(a.x + Math.sin(a.yaw ?? 0) * 100, g + 1.7 - 6, a.z + Math.cos(a.yaw ?? 0) * 100);
  cam.updateMatrixWorld(true);
  if (window.__settleStable) await window.__settleStable();
  await window.__settle(300);
  const { _internals } = await import('/src/game/hunt_detect.js');
  const ff = window.__systems.wildlife.fireflies;
  window.__ctx.worldPaused = true;
  return { n: ff.n, visible: ff.points.visible,
           opacity: ff.uniforms.uOpacity.value, density: ff.uniforms.uDensity.value,
           pixelScale: ff.uniforms.uPixelScale.value,
           est: _internals.ffCount(_internals.frameOf(window.__ctx), ff),
           cam: cam.position.toArray().map((v) => +v.toFixed(1)) };
}, { hour: HOUR });
console.log(JSON.stringify(info, null, 1));

await page.screenshot({ path: resolve(OUT, 'on.png') });
await page.evaluate(async () => {
  window.__systems.wildlife.fireflies.points.visible = false;
  await window.__settle(6);
});
await page.screenshot({ path: resolve(OUT, 'off.png') });

const a = readPNG(resolve(OUT, 'on.png')), b = readPNG(resolve(OUT, 'off.png'));
let max = 0, over = 0;
for (let i = 0, p = 0; i < a.w * a.h; i++, p += 3) {
  const d = Math.abs(a.px[p] - b.px[p]) + Math.abs(a.px[p + 1] - b.px[p + 1]) + Math.abs(a.px[p + 2] - b.px[p + 2]);
  if (d > max) max = d;
  if (d > 60) over++;
}
console.log('max channel-sum diff', max, ' pixels over 60:', over);
await browser.close();

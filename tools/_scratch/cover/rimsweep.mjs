// rimsweep — capture the backlit anchor at several cover-rim settings in ONE
// browser session, and report the measured pixel values on a shrub silhouette
// so "is the rim doing anything" is a number rather than an impression.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/cover/rim');
const SET = JSON.parse(arg('set', '[[0,2.8],[0.95,2.8],[2.5,2.8],[2.5,1.6]]'));
mkdirSync(DIR, { recursive: true });

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 300)));
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// Pose to the canonical `backlit` framing: meadow anchor, facing the sun.
const info = await page.evaluate(async () => {
  const e = window.__engine, wd = window.__world, L = window.__lighting;
  L.hour = 17.9; L.cycleSpeed = 0;
  const A = await (await fetch('/review/anchors.json')).json();
  const a = A.meadow;
  const gy = wd.getHeight(a.x, a.z);
  // faceSun: yaw toward the sun's azimuth.
  const d = L.sunDir;
  const yaw = Math.atan2(d.x, d.z);
  e.camera.fov = 52; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x, gy + 2.4, a.z);
  e.camera.lookAt(a.x + Math.sin(yaw) * 10, gy + 2.4 + 0.04 * 10, a.z + Math.cos(yaw) * 10);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(500);
  const u = window.__systems.groundCover.uniforms;
  return { sunDir: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)], yaw: +yaw.toFixed(3),
    uRim: u.uRim.value, uRimPow: u.uRimPow.value, uRimBack: u.uRimBack.value,
    uTransmit: u.uTransmit.value };
});
console.log('pose', JSON.stringify(info));

for (const [rim, pow] of SET) {
  await page.evaluate(async ({ rim, pow }) => {
    const u = window.__systems.groundCover.uniforms;
    u.uRim.value = rim; u.uRimPow.value = pow;
    await window.__settle(60);
  }, { rim, pow });
  const buf = await page.screenshot({ type: 'png' });
  const name = `${DIR}/rim-${String(rim).replace('.', 'p')}-pow${String(pow).replace('.', 'p')}.png`;
  writeFileSync(name, buf);
  console.log('shot', name);
}
await browser.close();

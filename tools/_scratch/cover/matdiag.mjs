// Sample the world along the river anchor's view and report why mats are or are
// not being placed, plus live groundMat instance counts.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const X = Number(arg('x', '-720.96')), Z = Number(arg('z', '95.04'));
const YAW = Number(arg('yaw', '3.141592653589793'));

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
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const out = await page.evaluate(async ({ X, Z, YAW }) => {
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = 16.9; window.__lighting.cycleSpeed = 0;
  const gy = wd.getHeight(X, Z);
  e.camera.position.set(X, gy + 6.0, Z);
  e.camera.lookAt(X + Math.sin(YAW) * 30, gy, Z + Math.cos(YAW) * 30);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(400);
  const rows = [];
  for (let d = 6; d <= 120; d += 8) {
    const x = X + Math.sin(YAW) * d, z = Z + Math.cos(YAW) * d;
    const w = wd.getSurfaceWeights(x, z, {});
    rows.push({ d, slope: +wd.getSlope(x, z).toFixed(2), moist: +wd.getMoisture(x, z).toFixed(2),
      grass: +w.grass.toFixed(2), dry: +w.dry.toFixed(2), rock: +w.rock.toFixed(2),
      dirt: +w.dirt.toFixed(2), litter: +(w.litter ?? 0).toFixed(2), snow: +w.snow.toFixed(2) });
  }
  const gc = window.__systems.groundCover;
  const arch = gc.slots.filter(s => /groundMat|deadTuft|pebble|scrubDry|shrubDark/.test(s.mesh.name))
    .map(s => `${s.mesh.name} ${s.mesh.count}/${s.mesh.instanceMatrix.count}`);
  return { rows, arch, tris: e.renderer.info.render.triangles, calls: e.renderer.info.render.calls, stats: gc.stats };
}, { X, Z, YAW });
console.log(JSON.stringify(out, null, 1));
await browser.close();

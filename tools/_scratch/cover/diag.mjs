// One slot: pose to a 2 m ground close-up, dump cover density diagnostics, shoot.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const OUT = resolve(arg('out', 'shots/cover/diag/diag.png'));
const X = Number(arg('x', '1329.8529666835984'));
const Z = Number(arg('z', '1031.6716535573803'));
const YAW = Number(arg('yaw', '1.3640704496667366'));
const HOUR = Number(arg('hour', '16.7'));

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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
await page.goto('http://localhost:5178/?res=' + RES, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const info = await page.evaluate(async ({ X, Z, YAW, HOUR }) => {
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = HOUR; window.__lighting.cycleSpeed = 0;
  if (window.__atmosphere?.params) window.__atmosphere.params.cloudShadow = 0;
  const gy = wd.getHeight(X, Z);
  e.camera.fov = 55; e.camera.updateProjectionMatrix();
  e.camera.position.set(X, gy + 1.55, Z);
  e.camera.lookAt(X + Math.sin(YAW) * 2.0, gy + 0.15, Z + Math.cos(YAW) * 2.0);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(200);

  const gc = window.__systems.groundCover;
  const arch = [];
  for (const s of gc.slots) {
    arch.push({ n: s.mesh.name, count: s.mesh.count, cap: s.mesh.instanceMatrix.count, tris: s.mesh.userData.tris * s.mesh.count });
  }
  const cells = [];
  for (const c of gc.cells.values()) cells.push({ n: c.count, band: c.band, d: Math.round(c.d) });
  cells.sort((a, b) => a.d - b.d);
  return {
    mul: gc.mul,
    stats: gc.stats,
    preset: window.__engine.preset ?? null,
    arch: arch.filter((a) => a.count > 0),
    capped: arch.filter((a) => a.count >= a.cap).map((a) => a.n),
    nearCells: cells.slice(0, 12),
    maxCell: Math.max(...cells.map((c) => c.n)),
    clipped: cells.filter((c) => c.n >= 5600).length,
    render: { calls: e.renderer.info.render.calls, tris: e.renderer.info.render.triangles },
    fps: window.__fps,
  };
}, { X, Z, YAW, HOUR });

console.log(JSON.stringify(info, null, 1));
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT });
console.log('shot:', OUT);
await browser.close();

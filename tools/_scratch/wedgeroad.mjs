#!/usr/bin/env node
/**
 * Photograph hudshot's `drive` pose at EVERY road anchor, not just the first.
 *
 * `poi.anchor('road')` does not come back the same across page loads — two runs
 * of tools/hudshot.mjs minutes apart put the camera on two different massifs —
 * so the evidence frame (shots/ui/map7/full.png) is one member of a family of
 * poses rather than a reproducible one. window.__anchorAt('road', i) enumerates
 * the family; this walks it.
 *
 * At each pose it also raycasts a grid over the upper third of the frame and
 * names whatever it hits, so a frame with something large and near above the
 * horizon identifies itself rather than being argued about from colour.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/wedge-road');
const KIND = arg('kind', 'road');
const N = parseInt(arg('n', '24'), 10);
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);

mkdirSync(DIR, { recursive: true });
await acquire('wedgeroad');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(800);

await p.evaluate(() => {
  const T = window.__THREE;
  const rc = new T.Raycaster(); rc.far = 20000;
  // Sky and Clouds ride with the camera and are always the nearest hit, so they
  // answer nothing; instanced vegetation is never one flat wedge and is very
  // slow to raycast without a BVH.
  const SKIP = /^(Sky|Clouds|Grass|GroundCover|Trees|Wildlife|Birds|Rocks|Weather|vehicle|tyreTracks|camperContact)/;
  window.__probeUpper = (nx, ny) => {
    const cam = window.__engine.camera, scene = window.__engine.scene;
    const targets = scene.children.filter((o) => o.visible && !SKIP.test(o.name || ''));
    const tally = {}; let near = Infinity, nearName = null;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = ((i + 0.5) / nx) * 2 - 1;
      const y = 1 - ((j + 0.5) / (ny * 3)) * 2;      // upper third only
      rc.setFromCamera(new T.Vector2(x, y), cam);
      const h = rc.intersectObjects(targets, true)[0];
      if (!h) { tally.sky = (tally.sky || 0) + 1; continue; }
      let o = h.object, path = [];
      while (o && o !== scene) { path.unshift(o.name || o.type); o = o.parent; }
      const nm = path.join('/');
      tally[nm] = (tally[nm] || 0) + 1;
      if (h.distance < near) { near = h.distance; nearName = nm; }
    }
    return { tally, near: isFinite(near) ? +near.toFixed(1) : null, nearName };
  };
});

const count = await p.evaluate((k) => (window.__poi.list[k] || []).length, KIND);
console.log(`${KIND} anchors: ${count}`);

for (let i = 0; i < Math.min(N, count); i++) {
  const info = await p.evaluate(async ({ kind, i }) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
    const a = window.__anchorAt(kind, i);
    const yaw = a.yaw ?? 0;
    const gx = a.x - Math.sin(yaw) * 16, gz = a.z - Math.cos(yaw) * 16;
    const gy = window.__world.getHeight(gx, gz) + 4.2;
    e.camera.fov = 55; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx, gy, gz);
    e.camera.lookAt(new THREE.Vector3(gx + Math.sin(yaw) * 12, gy + Math.tan(-0.10) * 12, gz + Math.cos(yaw) * 12));
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
    await window.__settle(45);
    return { x: +gx.toFixed(0), y: +gy.toFixed(0), z: +gz.toFixed(0), yaw: +yaw.toFixed(2) };
  }, { kind: KIND, i });
  await p.waitForTimeout(450);
  const pr = await p.evaluate(() => window.__probeUpper(16, 4));
  writeFileSync(`${DIR}/${KIND}${String(i).padStart(2, '0')}.png`, await p.screenshot());
  console.log(`${i} ${JSON.stringify(info)} near=${pr.near} ${pr.nearName} :: ${JSON.stringify(pr.tally)}`);
}
await b.close();

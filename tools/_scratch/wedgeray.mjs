#!/usr/bin/env node
/**
 * Name the object under any part of the frame, by raycasting rather than by
 * arguing about colour.
 *
 * D3 (the giant flat grey wedge) is an identification problem, and every
 * colour-space heuristic for "large flat region" also matches sky, a fogged
 * range and a cliff in shadow. A raycast does not have that problem: it returns
 * the object. So this fires a grid of rays through the frame and tallies what
 * each one hit, which turns "what is that wedge" into a name and a distance.
 *
 *   node tools/_scratch/wedgeray.mjs --mode yaw     # sweep heading at the road anchor
 *   node tools/_scratch/wedgeray.mjs --mode drive   # drive, sampling as it goes
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const MODE = arg('mode', 'yaw');
const DIR = arg('dir', `shots/wedge-${MODE}`);
const N = parseInt(arg('n', MODE === 'yaw' ? '16' : '24'), 10);
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const RES = arg('res', '768');
const GAP = parseFloat(arg('gap', '900'));

mkdirSync(DIR, { recursive: true });
await acquire('wedgeray');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  window.__hudForce = true;
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
await p.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(800);

// ── the probe ───────────────────────────────────────────────────────────────
// A grid of rays. Instanced vegetation is excluded: it is never a single flat
// wedge, it is very slow to raycast, and including it would bury the answer.
await p.evaluate(() => {
  const T = window.__THREE;
  const rc = new T.Raycaster();
  rc.far = 20000;
  window.__probe = (nx, ny) => {
    const cam = window.__engine.camera;
    const scene = window.__engine.scene;
    const skip = /^(Grass|GroundCover|Trees|Wildlife|Birds|Rocks|Weather|vehicle|tyreTracks|camperContact)/;
    const targets = scene.children.filter((o) => o.visible && !skip.test(o.name || ''));
    const rows = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) / nx) * 2 - 1;
        const y = 1 - ((j + 0.5) / ny) * 2;
        rc.setFromCamera(new T.Vector2(x, y), cam);
        const hits = rc.intersectObjects(targets, true);
        let name = 'sky', dist = Infinity, top = null;
        for (const h of hits) {
          if (!h.object.visible) continue;
          top = h.object;
          // Walk up to the named ancestor, which is the system.
          let o = h.object, path = [];
          while (o && o !== scene) { path.unshift(o.name || o.type); o = o.parent; }
          name = path.join('/');
          dist = h.distance;
          break;
        }
        rows.push({ i, j, name, dist: isFinite(dist) ? +dist.toFixed(1) : null });
      }
    }
    return rows;
  };
});

const NX = 16, NY = 9;
async function probe(label) {
  const rows = await p.evaluate(({ nx, ny }) => window.__probe(nx, ny), { nx: NX, ny: NY });
  // Upper third of the frame: what has any business being there is sky, cloud
  // and distant range.
  const upper = rows.filter((r) => r.j < 3);
  const tally = {};
  for (const r of upper) tally[r.name] = (tally[r.name] || 0) + 1;
  const all = {};
  for (const r of rows) all[r.name] = (all[r.name] || 0) + 1;
  const near = upper.filter((r) => r.dist !== null && r.dist < 6000);
  const minD = near.length ? Math.min(...near.map((r) => r.dist)) : null;
  return { label, upper: tally, whole: all, upperNonSky: upper.length - (tally.sky || 0), minUpperDist: minD, rows };
}

const results = [];
if (MODE === 'yaw') {
  // The evidence frame (shots/ui/map7/full.png) came from hudshot's `drive`
  // view; its compass puts the heading about 45 deg clockwise of what the same
  // view gives today, so sweep the whole circle at that anchor rather than
  // guessing which build wrote it.
  await p.keyboard.down('KeyW');
  await p.waitForTimeout(4500);
  await p.keyboard.up('KeyW');
  await p.waitForTimeout(400);
  for (let k = 0; k < N; k++) {
    const info = await p.evaluate(async ({ k, n }) => {
      const THREE = window.__THREE, e = window.__engine;
      window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
      const a = window.__cameraAnchors.road();
      const yaw = (k / n) * Math.PI * 2;
      const gx = a.x - Math.sin(yaw) * 16, gz = a.z - Math.cos(yaw) * 16;
      const gy = window.__world.getHeight(gx, gz) + 4.2;
      e.camera.fov = 55; e.camera.updateProjectionMatrix();
      e.camera.position.set(gx, gy, gz);
      e.camera.lookAt(new THREE.Vector3(gx + Math.sin(yaw) * 12, gy + Math.tan(-0.10) * 12, gz + Math.cos(yaw) * 12));
      window.__forceCamera = true;
      window.dispatchEvent(new Event('resize'));
      await window.__settle(40);
      return { yaw: +yaw.toFixed(2), x: +gx.toFixed(0), y: +gy.toFixed(0), z: +gz.toFixed(0) };
    }, { k, n: N });
    await p.waitForTimeout(500);
    const r = await probe(`yaw${k}`);
    r.pose = info;
    results.push(r);
    writeFileSync(`${DIR}/y${String(k).padStart(2, '0')}.png`, await p.screenshot());
    console.log(`y${k} yaw=${info.yaw} upperNonSky=${r.upperNonSky}/48 minUpperDist=${r.minUpperDist} ${JSON.stringify(r.upper)}`);
  }
} else {
  await p.evaluate(() => {
    const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
    const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
      inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.17) * 0.3; requestAnimationFrame(tick); };
    tick();
  });
  await p.waitForTimeout(9000);
  for (let k = 0; k < N; k++) {
    const r = await probe(`f${k}`);
    r.pose = await p.evaluate(() => {
      const c = window.__engine.camera;
      return { x: +c.position.x.toFixed(0), y: +c.position.y.toFixed(0), z: +c.position.z.toFixed(0) };
    });
    results.push(r);
    writeFileSync(`${DIR}/f${String(k).padStart(2, '0')}.png`, await p.screenshot());
    console.log(`f${k} ${JSON.stringify(r.pose)} upperNonSky=${r.upperNonSky}/48 minUpperDist=${r.minUpperDist} ${JSON.stringify(r.upper)}`);
    await p.waitForTimeout(GAP);
  }
  await p.evaluate(() => { window.__drive = false; });
}

writeFileSync(`${DIR}/probe.json`, JSON.stringify(results, null, 1));
console.log('\nwrote', `${DIR}/probe.json`);
await b.close();

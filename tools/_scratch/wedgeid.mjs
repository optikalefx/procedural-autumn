#!/usr/bin/env node
/**
 * Name the wedge at a specific road anchor, and measure it.
 *
 *   node tools/_scratch/wedgeid.mjs --idx 12
 *
 * Raycasts EVERYTHING (instanced vegetation and rocks included), reports the
 * nearest hit per ray with its instanceId, then hides each system in turn and
 * screenshots, which is the elimination recipe from INTEGRATION_REQUESTS §1.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const IDXS = String(arg('idx', '12')).split(',').map(Number);
const DIR = arg('dir', 'shots/wedge-id');
const KIND = arg('kind', 'road');

mkdirSync(DIR, { recursive: true });
await acquire('wedgeid');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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

for (const IDX of IDXS) {
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
  }, { kind: KIND, i: IDX });
  await p.waitForTimeout(450);
  writeFileSync(`${DIR}/${IDX}-base.png`, await p.screenshot());

  const hits = await p.evaluate(() => {
    const T = window.__THREE, rc = new T.Raycaster(); rc.far = 20000;
    const cam = window.__engine.camera, scene = window.__engine.scene;
    const SKIP = /^(Sky|Clouds|Grass|GroundCover|Weather)/;
    const targets = scene.children.filter((o) => o.visible && !SKIP.test(o.name || ''));
    const tally = {};
    for (let j = 0; j < 6; j++) for (let i = 0; i < 12; i++) {
      const x = ((i + 0.5) / 12) * 2 - 1, y = 1 - ((j + 0.5) / 6) * 2;
      rc.setFromCamera(new T.Vector2(x, y), cam);
      const h = rc.intersectObjects(targets, true)[0];
      if (!h) { tally.sky = (tally.sky || 0) + 1; continue; }
      let o = h.object, path = [];
      while (o && o !== scene) { path.unshift(o.name || o.type); o = o.parent; }
      const key = path.join('/') + (h.instanceId !== undefined ? `#${h.instanceId}` : '');
      (tally[key] ||= { n: 0, near: Infinity });
      tally[key].n++;
      tally[key].near = Math.min(tally[key].near, +h.distance.toFixed(1));
    }
    return tally;
  });
  console.log(`\n=== ${KIND}[${IDX}] ${JSON.stringify(info)}`);
  const rows = Object.entries(hits).filter(([k]) => k !== 'sky')
    .sort((a, b) => b[1].n - a[1].n);
  console.log(`  sky ${hits.sky ?? 0}/72`);
  for (const [k, v] of rows.slice(0, 10)) console.log(`  ${k.padEnd(46)} rays ${v.n} nearest ${v.near} m`);

  // Elimination: hide one system at a time and photograph.
  const names = await p.evaluate(() => Object.keys(window.__systems));
  for (const n of names) {
    const ok = await p.evaluate(async (n) => {
      const s = window.__systems[n];
      const g = s?.group ?? (s?.mesh ? { get visible() { return s.mesh.visible; }, set visible(v) { s.mesh.visible = v; } } : null);
      if (!g) return false;
      g.visible = false; await window.__settle(4); return true;
    }, n);
    if (!ok) continue;
    writeFileSync(`${DIR}/${IDX}-no-${n}.png`, await p.screenshot());
    await p.evaluate((n) => {
      const s = window.__systems[n];
      const g = s?.group ?? (s?.mesh ? s.mesh : null);
      if (g) g.visible = true;
    }, n);
  }
  console.log(`  wrote ${DIR}/${IDX}-*.png (${names.length} systems)`);

  // The biggest rock instance, since that is the leading suspect.
  const rocks = await p.evaluate(() => {
    const T = window.__THREE, out = [];
    const g = window.__engine.scene.getObjectByName('Rocks');
    if (!g) return out;
    const cam = window.__engine.camera;
    const m = new T.Matrix4(), pos = new T.Vector3(), sc = new T.Vector3(), q = new T.Quaternion();
    g.traverse((o) => {
      if (!o.isInstancedMesh) return;
      o.geometry.computeBoundingSphere();
      const r0 = o.geometry.boundingSphere.radius;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m); m.decompose(pos, q, sc);
        pos.applyMatrix4(o.matrixWorld);
        const s = Math.max(sc.x, sc.y, sc.z);
        out.push({ mesh: o.name || o.geometry.name || 'rock', i, r: +(r0 * s).toFixed(1),
                   d: +pos.distanceTo(cam.position).toFixed(1),
                   sub: +(r0 * s / Math.max(1, pos.distanceTo(cam.position))).toFixed(3) });
      }
    });
    out.sort((a, b) => b.sub - a.sub);
    return out.slice(0, 8);
  });
  console.log('  biggest rocks by angular size (radius/distance):');
  for (const r of rocks) console.log(`    ${r.mesh}#${r.i} radius ${r.r} m at ${r.d} m -> ${r.sub}`);
}
await b.close();

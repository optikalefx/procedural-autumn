// hillprobe — raycast a grid of screen points at the river anchor onto the
// terrain, and report the world inputs the cover scatter sees at each hit,
// plus what ground-cover instances actually exist near those hits.
//
// The point is to read the ACTUAL inputs at the pixels that look bare, rather
// than assume which gate is closing.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');
const RES = arg('res', '1536');
const HOUR = Number(arg('hour', '16.7'));

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
await page.goto('http://localhost:5178/?res=' + RES, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const out = await page.evaluate(async ({ VIEW, HOUR }) => {
  const THREE = window.THREE ?? window.__THREE;
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = HOUR; window.__lighting.cycleSpeed = 0;
  const A = await (await fetch('/review/anchors.json')).json().catch(() => null);
  const a = (A && A[VIEW]) || { x: -720.96, z: 95.04, yaw: Math.PI, lookY: 1.4 };
  const gy = wd.getHeight(a.x, a.z);
  e.camera.fov = 55; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x, gy + 1.75, a.z);
  e.camera.lookAt(a.x + Math.sin(a.yaw) * 50, gy + (a.lookY ?? 1.4), a.z + Math.cos(a.yaw) * 50);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(600);

  // Ray-march against world.getHeight instead of raycasting the mesh: the
  // terrain mesh name is not stable and a miss teaches nothing.
  const rows = [];
  const scratch = {};
  const dir = new THREE.Vector3();
  const sc = window.__systems.groundCover.scatter;
  for (let gy2 = 0; gy2 < 6; gy2++) {
    for (let gx = 0; gx < 7; gx++) {
      const ndcx = -1 + (gx + 0.5) * 2 / 7, ndcy = 1 - (gy2 + 0.5) * 2 / 6;
      dir.set(ndcx, ndcy, 0.5).unproject(e.camera).sub(e.camera.position).normalize();
      let t = 0.5, hit = null;
      for (let k = 0; k < 4000 && t < 600; k++) {
        const px = e.camera.position.x + dir.x * t;
        const py = e.camera.position.y + dir.y * t;
        const pz = e.camera.position.z + dir.z * t;
        if (py <= wd.getHeight(px, pz)) { hit = { x: px, y: py, z: pz, t }; break; }
        t += Math.max(0.35, t * 0.012);
      }
      if (!hit) { rows.push({ px: [Math.round((ndcx + 1) * 640), Math.round((1 - ndcy) * 360)], miss: 1 }); continue; }
      const w = wd.getSurfaceWeights(hit.x, hit.z, scratch);
      rows.push({
        px: [Math.round((ndcx + 1) * 640), Math.round((1 - ndcy) * 360)],
        d: +hit.t.toFixed(1), x: +hit.x.toFixed(1), z: +hit.z.toFixed(1),
        slope: +wd.getSlope(hit.x, hit.z).toFixed(2),
        moist: +wd.getMoisture(hit.x, hit.z).toFixed(2),
        grass: +w.grass.toFixed(2), dry: +w.dry.toFixed(2), rock: +w.rock.toFixed(2),
        dirt: +w.dirt.toFixed(2), litter: +(w.litter ?? 0).toFixed(2),
        sand: +(w.sand ?? 0).toFixed(2), snow: +w.snow.toFixed(2),
        river: +wd.getRiver(hit.x, hit.z).toFixed(2),
        wdep: +(wd.getWaterDepth(hit.x, hit.z) ?? 0).toFixed(2),
        road: +sc.roads.sample(hit.x, hit.z).toFixed(2),
        gr: +sc._ground(hit.x, hit.z, 1.6).toFixed(2),
        gt: +sc._groundTiny(hit.x, hit.z).toFixed(2),
      });
    }
  }

  const gc = window.__systems.groundCover;
  const arch = gc.slots.map((s) => ({ n: s.mesh.name, c: s.mesh.count, cap: s.mesh.instanceMatrix.count }))
    .filter((s) => s.c > 0);

  // Distance histogram of live groundMat instances from the camera.
  const hist = {};
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const s of gc.slots) {
    if (!/groundMat/.test(s.mesh.name)) continue;
    for (let i = 0; i < s.mesh.count; i++) {
      s.mesh.getMatrixAt(i, m);
      v.setFromMatrixPosition(m);
      const d = v.distanceTo(e.camera.position);
      const b = Math.min(9, Math.floor(d / 20));
      hist[b * 20] = (hist[b * 20] || 0) + 1;
    }
  }

  return { anchor: a, camY: +(gy + 1.75).toFixed(1), rows, arch, matHist: hist,
    tris: e.renderer.info.render.triangles, calls: e.renderer.info.render.calls };
}, { VIEW, HOUR });
console.log(JSON.stringify(out, null, 1));
await browser.close();

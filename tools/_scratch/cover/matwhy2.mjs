// matwhy2.mjs — why does `groundMat` read as loose chips on brown?
//
// One page load, several controlled states at the frozen `river` framing:
//   -all          the frame as shipped
//   -mat          only groundMat drawn
//   -mat-noterr   only groundMat, terrain hidden — shows how much of each mat
//                 the ground is eating. If the mats look like whole dense
//                 discs here and like confetti in `-mat`, the form is fine and
//                 the burial is the bug.
//   -mat-lift     only groundMat, every instance raised 0.6 m clear
//   -norocks / -nowater  who owns the grey slab on the far bank
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { VIEWS } from '/Users/sean/htdocs/procedural-fall/tools/shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');
const DIR = arg('dir', 'shots/cover/why');
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));

mkdirSync(DIR, { recursive: true });
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)));
await page.goto('http://localhost:5178', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* ignore */ }
}
const v = VIEWS[VIEW];
await page.evaluate(async ({ v, frozen }) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  const api = window.__cameraAnchors || {};
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const cached = frozen ? frozen[v.anchor] : null;
  const anchor = cached ?? ((v.index && window.__anchorAt)
    ? window.__anchorAt(v.anchor, v.index)
    : (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))());
  let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
                                 gy + Math.tan(v.pitch) * v.dist,
                                 gz + Math.cos(yaw) * v.dist);
  const ray = new THREE.Raycaster(); ray.far = 6;
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 6; attempt++) {
    dir.copy(look).sub(pos).normalize();
    ray.set(pos, dir);
    const hits = ray.intersectObjects(e.scene.children, true)
      .filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4;
  if (pos.y < g) pos.y = g;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos); e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  if (window.__settle) await window.__settle(60);
  window.__camReport = { pos: pos.toArray(), look: look.toArray() };
}, { v, frozen });
await page.waitForTimeout(1400);
console.log('camera', JSON.stringify(await page.evaluate(() => window.__camReport)));

const shot = (n) => page.screenshot({ path: `${DIR}/${VIEW}-${n}.png` });
await shot('all');

// Who owns the grey slab on the far bank?
for (const [label, sys] of [['norocks', 'rocks'], ['nowater', 'water'], ['nofalls', 'waterfalls']]) {
  const ok = await page.evaluate((s) => {
    const y = window.__systems[s]; if (!y) return false;
    const grp = y.group ?? y.mesh ?? null; if (!grp) return false;
    grp.visible = false; return true;
  }, sys);
  if (ok) { await shot(label); await page.evaluate((s) => { const y = window.__systems[s]; (y.group ?? y.mesh).visible = true; }, sys); }
  else console.log('no group for', sys, Object.keys(await page.evaluate(() => Object.keys(window.__systems))));
}
console.log('systems:', JSON.stringify(await page.evaluate(() => Object.keys(window.__systems))));

// Only groundMat.
await page.evaluate(() => {
  const gc = window.__systems.groundCover;
  for (const s of gc.slots) s.mesh.visible = s.mesh.name.split('_')[1] === 'groundMat' && s.mesh.count > 0;
});
await shot('mat');

// …with the terrain out of the way.
const terrOff = await page.evaluate(() => {
  const t = window.__systems.terrain; const grp = t?.group ?? t?.root ?? null;
  if (!grp) return false; grp.visible = false; return true;
});
if (terrOff) { await shot('mat-noterr'); }

// …and lifted clear of it.
await page.evaluate(() => {
  const t = window.__systems.terrain; const grp = t?.group ?? t?.root; if (grp) grp.visible = true;
  const gc = window.__systems.groundCover;
  const m = new window.__THREE.Matrix4();
  for (const s of gc.slots) {
    if (s.mesh.name.split('_')[1] !== 'groundMat') continue;
    for (let i = 0; i < s.mesh.count; i++) {
      s.mesh.getMatrixAt(i, m); m.elements[13] += 0.6; s.mesh.setMatrixAt(i, m);
    }
    s.mesh.instanceMatrix.needsUpdate = true;
  }
});
await shot('mat-lift');
console.log(`wrote ${DIR}/`);
await browser.close();

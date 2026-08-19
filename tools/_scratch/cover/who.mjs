// who.mjs — one page load, many captures: the whole scene, the scene with
// GroundCover off entirely, and then one frame per archetype with ONLY that
// archetype's meshes visible. Answers "which of my forms is that thing?"
// without spending a browser boot per question.
//
// The camera block is a copy of `tools/shot.mjs`'s, deliberately: an earlier
// version of this file used the framing from `matonly.mjs` (subject framing,
// standing back from the anchor along its yaw) and photographed a different
// place, which is worse than useless for an A/B.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { VIEWS } from '/Users/sean/htdocs/procedural-fall/tools/shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');
const DIR = arg('dir', 'shots/cover/who');
const KEYS = (arg('keys', 'groundMat,deadTuft,leafScatter,leafDrift,pebble,cobble,scrubDry,branch,moss') || '').split(',').filter(Boolean);
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));
const RES = arg('res', null);

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
await page.goto('http://localhost:5178' + (RES ? `?res=${RES}` : ''), { waitUntil: 'domcontentloaded' });
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
  let pos, look;
  if (v.subject) {
    const gx = anchor.x - Math.sin(yaw) * v.dist, gz = anchor.z - Math.cos(yaw) * v.dist;
    const gy = wd.getHeight(gx, gz) + v.height;
    pos = new THREE.Vector3(gx, gy, gz);
    look = new THREE.Vector3(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
  } else {
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    pos = new THREE.Vector3(gx, gy, gz);
    look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
                             gy + Math.tan(v.pitch) * v.dist,
                             gz + Math.cos(yaw) * v.dist);
  }
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
}, { v, frozen });
await page.waitForTimeout(1400);

await page.screenshot({ path: `${DIR}/${VIEW}-all.png` });

// Whole system off — the only honest test of "is this artifact mine".
await page.evaluate(() => { window.__systems.groundCover.group.visible = false; });
await page.screenshot({ path: `${DIR}/${VIEW}-nocover.png` });
await page.evaluate(() => { window.__systems.groundCover.group.visible = true; });

const report = {};
for (const key of KEYS) {
  report[key] = await page.evaluate((k) => {
    const gc = window.__systems.groundCover;
    const kept = [];
    for (const s of gc.slots) {
      const on = s.mesh.name.split('_')[1] === k;
      s.mesh.visible = on && s.mesh.count > 0;
      if (on) kept.push(`${s.mesh.name}:${s.mesh.count}`);
    }
    return kept;
  }, key);
  await page.screenshot({ path: `${DIR}/${VIEW}-only-${key}.png` });
}
console.log(JSON.stringify(report, null, 1));
console.log(`wrote ${DIR}/`);
await browser.close();

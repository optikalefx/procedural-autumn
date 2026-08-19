// matwhy — for a grid of world points around an anchor, evaluate the ground-mat
// acceptance chain stage by stage and report where candidates die, plus the
// live instance positions so "placed" and "visible" can be told apart.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');

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

const out = await page.evaluate(async ({ VIEW }) => {
  const THREE = window.THREE ?? window.__THREE;
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
  const A = await (await fetch('/review/anchors.json')).json().catch(() => null);
  const a = (A && A[VIEW]) || { x: -720.96, z: 95.04, yaw: Math.PI };
  const gy = wd.getHeight(a.x, a.z);
  e.camera.fov = 55; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x, gy + 1.75, a.z);
  e.camera.lookAt(a.x + Math.sin(a.yaw) * 50, gy + 1.4, a.z + Math.cos(a.yaw) * 50);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(600);

  const gc = window.__systems.groundCover;
  const sc = gc.scatter;

  // Stage-by-stage rejection census over the visible half-disc.
  const tally = { total: 0, slope: 0, roll: 0, ground: 0, pass: 0 };
  const scratch = {};
  for (let i = 0; i < 6000; i++) {
    const ang = a.yaw - 0.9 + (i % 60) / 60 * 1.8;
    const d = 12 + Math.floor(i / 60) * 1.1;
    const x = a.x + Math.sin(ang) * d, z = a.z + Math.cos(ang) * d;
    tally.total++;
    if (wd.getSlope(x, z) > 1.95) { tally.slope++; continue; }
    const w = wd.getSurfaceWeights(x, z, scratch);
    // acceptance roll uses the layer's own noise; approximate with expectation
    if (sc._ground(x, z, 1.6) < 0.20) { tally.ground++; continue; }
    tally.pass++;
  }

  // Where the live mats actually are, in camera space.
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const inFront = [];
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(e.camera.quaternion);
  for (const s of gc.slots) {
    if (!/groundMat/.test(s.mesh.name)) continue;
    for (let i = 0; i < s.mesh.count; i++) {
      s.mesh.getMatrixAt(i, m);
      v.setFromMatrixPosition(m);
      const rel = v.clone().sub(e.camera.position);
      const along = rel.dot(fwd);
      if (along > 0) inFront.push({ d: +rel.length().toFixed(1), sx: +m.elements[0].toFixed(2) });
    }
  }
  inFront.sort((p, q) => p.d - q.d);
  const bands = {};
  for (const p of inFront) { const b = Math.floor(p.d / 15) * 15; bands[b] = (bands[b] || 0) + 1; }
  // Instances whose vertex fade has collapsed them: the shader shrinks
  // `transformed` by coverFade, so a mat outside 11-67 m draws at zero size.
  const shrunk = inFront.filter((p) => p.d < 11.4 || p.d > 66.9).length;

  // How many cells are live, at what band, and how many mats each holds.
  const cellStats = [];
  for (const c of gc.cells.values()) cellStats.push({ d: Math.round(c.d), band: c.band, n: c.count });
  cellStats.sort((p, q) => p.d - q.d);

  return {
    anchor: a, tally,
    matsInFront: inFront.length, matBands: bands, matsOutsideFadeWindow: shrunk,
    nearCells: cellStats.slice(0, 10),
    mul: gc.mul,
    counts: gc.slots.filter((s) => /groundMat/.test(s.mesh.name))
      .map((s) => `${s.mesh.name} ${s.mesh.count}/${s.mesh.instanceMatrix.count}`),
  };
}, { VIEW });
console.log(JSON.stringify(out, null, 1));
await browser.close();

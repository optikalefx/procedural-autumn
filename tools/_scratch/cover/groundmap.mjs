// groundmap — ASCII maps of the ground-cover gate terms over the ground in
// front of an anchor, so it is visible WHICH term is closing where.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
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
  const wd = window.__world;
  const A = await (await fetch('/review/anchors.json')).json().catch(() => null);
  const a = (A && A[VIEW]) || { x: -720.96, z: 95.04, yaw: Math.PI };
  const sc = window.__systems.groundCover.scatter;
  const N = 34, SPAN = 160;
  const grids = { ground: [], road: [], slope: [], grass: [], alpine: [], height: [] };
  const scratch = {};
  for (let j = 0; j < N; j++) {
    const rowG = [], rowR = [], rowS = [], rowGr = [], rowA = [], rowH = [];
    for (let i = 0; i < N; i++) {
      const x = a.x - SPAN / 2 + (i + 0.5) * SPAN / N;
      const z = a.z - SPAN + 10 + (j + 0.5) * SPAN / N;
      rowG.push(sc._ground(x, z, 1.6));
      rowR.push(sc.roads.sample(x, z));
      rowS.push(wd.getSlope(x, z));
      rowGr.push(wd.getSurfaceWeights(x, z, scratch).grass);
      rowA.push(wd.getHeight(x, z));
      rowH.push(wd.getWaterDepth(x, z) ?? 0);
    }
    grids.ground.push(rowG); grids.road.push(rowR); grids.slope.push(rowS);
    grids.grass.push(rowGr); grids.alpine.push(rowA); grids.height.push(rowH);
  }
  // Where the live ground-mat instances actually are, binned onto the same grid.
  const THREE = window.THREE ?? window.__THREE;
  const gc = window.__systems.groundCover;
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const mats = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const s of gc.slots) {
    if (!/groundMat/.test(s.mesh.name)) continue;
    for (let k = 0; k < s.mesh.count; k++) {
      s.mesh.getMatrixAt(k, m); v.setFromMatrixPosition(m);
      const i = Math.floor((v.x - (a.x - SPAN / 2)) / (SPAN / N));
      const j = Math.floor((v.z - (a.z - SPAN + 10)) / (SPAN / N));
      if (i >= 0 && i < N && j >= 0 && j < N) mats[j][i]++;
    }
  }
  return { a, grids, mats, span: SPAN, n: N };
}, { VIEW });

const ramp = ' .:-=+*#%@';
function draw(name, g, lo, hi) {
  console.log(`\n== ${name}  (${lo} … ${hi}) — rows are z, +z is toward the camera`);
  for (const row of g) {
    console.log(row.map((v) => ramp[Math.max(0, Math.min(9, Math.round((v - lo) / (hi - lo) * 9)))]).join(''));
  }
}
console.log('anchor', JSON.stringify(out.a), 'span', out.span, 'm');
draw('_ground (0 rejected, 1 full)', out.grids.ground, 0, 1);
draw('roads.sample', out.grids.road, 0, 1);
draw('slope', out.grids.slope, 0, 2);
draw('grass weight', out.grids.grass, 0, 1);
draw('height (m)', out.grids.alpine, 0, 120);
draw('water depth', out.grids.height, 0, 2);
draw('LIVE groundMat instances per 4.7 m cell', out.mats, 0, 4);
await browser.close();

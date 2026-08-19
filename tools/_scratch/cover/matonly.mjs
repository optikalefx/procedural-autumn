// Frame the canonical `river` view and capture (a) the whole scene and (b) the
// scene with every cover archetype except groundMat hidden, so the mats can be
// seen rather than inferred.
import { chromium } from 'playwright';
import { acquire } from '/Users/sean/htdocs/procedural-fall/tools/_lock.mjs';
import { mkdirSync } from 'node:fs';
import { VIEWS } from '/Users/sean/htdocs/procedural-fall/tools/shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const VIEW = arg('view', 'river');
const DIR = arg('dir', 'shots/cover/matonly');
const ONLY = arg('only', 'groundMat');

mkdirSync(DIR, { recursive: true });
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
page.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)));
await page.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

const anchors = JSON.parse((await import('node:fs')).readFileSync('review/anchors.json', 'utf8'));
const v = VIEWS[VIEW];
await page.evaluate(async ({ v, anc }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
  const yaw = anc.yaw + (v.yawOffset ?? 0);
  const cx = anc.x - Math.sin(yaw) * v.dist, cz = anc.z - Math.cos(yaw) * v.dist;
  const cy = wd.getHeight(cx, cz) + v.height;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(cx, cy, cz);
  e.camera.lookAt(anc.x, wd.getHeight(anc.x, anc.z) + (anc.lookY ?? 1.4) + v.dist * Math.tan(v.pitch), anc.z);
  e.camera.updateMatrixWorld(true);
  window.__forceCamera = true;
  await window.__settle(600);
}, { v, anc: anchors[v.anchor] });
await page.screenshot({ path: `${DIR}/${VIEW}-all.png` });

const info = await page.evaluate(({ ONLY }) => {
  const gc = window.__systems.groundCover;
  const kept = [];
  for (const s of gc.slots) {
    if (!s.mesh.name.includes(ONLY)) { s.mesh.userData._wasVis = s.mesh.visible; s.mesh.visible = false; }
    else kept.push(`${s.mesh.name} ${s.mesh.count}`);
  }
  return kept;
}, { ONLY });
await page.screenshot({ path: `${DIR}/${VIEW}-only.png` });
console.log(JSON.stringify(info));
console.log(`${DIR}/${VIEW}-all.png  ${DIR}/${VIEW}-only.png`);
await browser.close();

// What does the margin layer actually DRAW at a shoreline pose? Instance counts
// and triangles per cover archetype, read off the live InstancedMeshes after the
// streamer has settled at the `mouth` anchor — the number the perf argument has
// to be made against, rather than a per-cell scatter count.
import { chromium } from 'playwright';
import { VIEWS } from '../../shot.mjs';
import { readFileSync } from 'node:fs';

const view = process.argv[2] || 'mouth';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto('http://localhost:5178/');
await p.waitForFunction(() => window.__ready, null, { timeout: 300000 });

const frozen = JSON.parse(readFileSync(new URL('../../../review/anchors.json', import.meta.url), 'utf8'));
const out = await p.evaluate(async ({ v, name, frozen }) => {
  const a = frozen?.[name] ?? window.__anchorAt(v.anchor, v.index ?? 0);
  window.__lighting.hour = v.hour;
  const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  const cam = window.__engine.camera;
  cam.fov = v.fov; cam.updateProjectionMatrix();
  cam.position.set(a.x - Math.sin(yaw) * v.dist, window.__world.getHeight(a.x, a.z) + v.height,
                   a.z - Math.cos(yaw) * v.dist);
  cam.lookAt(a.x, window.__world.getHeight(a.x, a.z) + v.height + Math.sin(v.pitch) * v.dist, a.z);
  window.__forceCamera = true;
  await window.__settleStable(1500, 40);

  const rows = [];
  let total = 0, tris = 0, mine = 0, mineTris = 0;
  for (const slot of window.__systems.groundCover.slots) {
    const n = slot.mesh.count | 0;
    if (!n) continue;
    const t = n * (slot.mesh.geometry.userData.tris || slot.mesh.geometry.index.count / 3);
    total += n; tris += t;
    if (/^cover_(reed|sedge)_/.test(slot.mesh.name)) { mine += n; mineTris += t; }
    rows.push({ name: slot.mesh.name, n, tris: t | 0 });
  }
  rows.sort((x, y) => y.tris - x.tris);
  return { anchor: [a.x | 0, a.z | 0], rows, total, tris, mine, mineTris };
}, { v: VIEWS[view], name: view, frozen: frozen?.[VIEWS[view].anchor] ? null : null });

console.log(`pose ${view} @ ${out.anchor}`);
for (const r of out.rows) console.log(`  ${r.name.padEnd(26)} ${String(r.n).padStart(6)}  ${String(r.tris).padStart(8)} tris`);
console.log(`  ---`);
console.log(`  all ground cover           ${String(out.total).padStart(6)}  ${String(out.tris | 0).padStart(8)} tris`);
console.log(`  reed + sedge               ${String(out.mine).padStart(6)}  ${String(out.mineTris | 0).padStart(8)} tris` +
            `  (${(out.mineTris / Math.max(1, out.tris) * 100).toFixed(1)}% of the layer)`);
await b.close();

// Drive, then check no tyre-track vertex is anywhere near the world origin
// while the camper is far from it — the signature of the leading-quad bug.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('trackcheck');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
               set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

await p.evaluate(() => {
  const i = window.__ctx.input;
  window.__d = true;
  const t = () => { if (!window.__d) return; i.axes.throttle = 1; i.axes.steer = Math.sin(performance.now()/1400)*0.6; requestAnimationFrame(t); };
  t();
});
await p.waitForTimeout(14000);

const out = await p.evaluate(() => {
  window.__d = false;
  const v = window.__systems.vehicle.position;
  const res = { vehicle: { x: +v.x.toFixed(1), z: +v.z.toFixed(1) }, meshes: 0, worst: 0, nearOrigin: 0, total: 0 };
  window.__engine.scene.traverse((o) => {
    if (o.name !== 'tyreTracks') return;
    res.meshes++;
    const pos = o.geometry.attributes.position;
    const fade = o.geometry.attributes.aFade;
    for (let i = 0; i < pos.count; i++) {
      if (fade.getX(i) <= 0.001) continue;     // collapsed/aged vertices don't draw
      const x = pos.getX(i), z = pos.getZ(i);
      res.total++;
      const dOrigin = Math.hypot(x, z);
      if (dOrigin < 5) res.nearOrigin++;
      const dVeh = Math.hypot(x - v.x, z - v.z);
      if (dVeh > res.worst) res.worst = +dVeh.toFixed(1);
    }
  });
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
process.exit(out.nearOrigin > 0 ? 1 : 0);

// One clean look at a naturally-spawned heron, framed from over open water so
// the camera cannot end up inside a boulder (which is what a naive offset did).
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const OUT = process.argv[2] ?? '/tmp/waders';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await p.goto(process.env.AUTUMN_URL || 'http://localhost:5199');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

for (const [name, dist] of [['heron-close', 14], ['heron-at-range', 70]]) {
  const r = await p.evaluate(async ([nm, D]) => {
    const ctx = window.__ctx, W = ctx.world;
    const tb = ctx.systems.wildlife.treeBirds;
    window.__vehicleTeleport(1321, 912, 0);
    await new Promise((res) => setTimeout(res, 2500));
    for (const slots of tb.slots) for (const s of slots) { if (s.active) tb._park(s); s.cool = 0; }
    for (let i = 0; i < 400; i++) tb.update(1.0, ctx.camera, null);

    let t = null;
    for (const slots of tb.slots) {
      for (const s of slots) {
        if (s.active && s.spec.key === 'heron' && s.state === 0) { t = s; break; }
      }
      if (t) break;
    }
    if (!t) return { none: true };

    // Sweep azimuths and keep the one whose camera sits over the deepest water
    // — open water means nothing solid between the lens and the bird.
    let bestA = 0, bestScore = -1e9;
    for (let a = 0; a < 32; a++) {
      const th = (a / 32) * Math.PI * 2;
      const cx = t.x + Math.sin(th) * D, cz = t.z + Math.cos(th) * D;
      if (!W.isInBounds(cx, cz)) continue;
      const score = W.getWaterDepth(cx, cz);
      if (score > bestScore) { bestScore = score; bestA = th; }
    }
    window.__forceCamera = true;
    const cam = ctx.camera;
    cam.position.set(t.x + Math.sin(bestA) * D, t.y + D * 0.22, t.z + Math.cos(bestA) * D);
    cam.lookAt(t.x, t.y + 0.2, t.z);
    cam.updateMatrixWorld(true);
    return { nm, bird: [Math.round(t.x), Math.round(t.z)], camWaterDepth: +bestScore.toFixed(2) };
  }, [name, dist]);

  if (r.none) { console.log(`${name}: no settled heron`); continue; }
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name}: bird at (${r.bird}) camera over ${r.camWaterDepth} m water -> ${OUT}/${name}.png`);
}
await b.close();

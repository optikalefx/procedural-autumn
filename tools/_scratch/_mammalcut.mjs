// The mammal branch, end to end, after the planar rewrite: plant a real animal,
// binary-search the stand-off at which `detectSubjects` lets go, and compare
// against the cut table in hunt_detect's header (deer 14.0 m, moose 25.2 m).
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.addInitScript(() => {
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
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

console.log(await page.evaluate(async () => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  const j = window.__hud?.journal;
  if (j?._visible) { j.close(); for (let i = 0; i < 300 && j._visible; i++) j.update(0.05); }
  window.__lighting.hour = 11.0; window.__lighting.cycleSpeed = 0;
  const wl = c.systems.wildlife;
  // A meadow, so the species' own habitat sites exist to be reused — debugSpawn
  // returns null rather than inventing one, which is what an unstreamed spot
  // looks like from here.
  const q = window.__poi?.best?.('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport(q.x, q.z, q.yaw ?? 0.9);
  await new Promise((r) => setTimeout(r, 3500));
  window.__forceCamera = true;
  const out = ['  species   half-height   old rule   new rule   delta   header'];
  for (const [key, want] of [['deer', 14.0], ['rabbit', 4.0], ['fox', 5.4]]) {
    let rec = null;
    for (let t = 0; t < 6 && !rec; t++) rec = wl.debugSpawn(key, { dist: 14 + t * 6, clear: 6, state: 0 });
    if (!rec) { out.push(`  ${key.padEnd(8)}  no free site near the meadow`); continue; }
    for (let i = 0; i < 90; i++) wl.update(1 / 30, e.camera, null);
    e.camera.fov = 50; e.camera.updateProjectionMatrix();
    // The detector's own handle on this animal: `meshHeight`'s half-height, and
    // the mid-height point it pairs with — reconstructed here exactly as
    // `meshHeight` computes it, so this is the radius `mammals()` would use.
    let a = null;
    for (const per of wl.pool[key] ?? []) for (const x of per) if (x.active && x.mesh) {
      if (!a || Math.hypot(x.mesh.position.x - rec.x, x.mesh.position.z - rec.z)
             < Math.hypot(a.mesh.position.x - rec.x, a.mesh.position.z - rec.z)) a = x;
    }
    if (!a) { out.push(`  ${key.padEnd(8)}  spawned but not in the pool`); continue; }
    // `meshHeight` first, and then READ its cache — never recompute. Calling
    // `computeBoundingBox()` on one of these pooled meshes replaces a valid
    // cached box with an empty one (min +Inf, max -Inf), which put a NaN into
    // this harness's centre and made `share` return 0 at every stand-off. The
    // detector never recomputes, so this was self-inflicted; it is written down
    // because it looked exactly like a broken gate.
    const r = I.meshHeight(a.mesh);
    const g = a.mesh.geometry;
    const sc = Math.abs(a.mesh.scale?.y) || 1;
    if (!g.boundingBox || !Number.isFinite(g.boundingBox.min.y)) {
      out.push(`  ${key.padEnd(8)}  no usable bounding box`); continue;
    }
    const P = new T.Vector3(a.mesh.position.x,
      a.mesh.position.y + (g.boundingBox.min.y + g.boundingBox.max.y) * 0.5 * sc,
      a.mesh.position.z);
    const vfov = 50 * Math.PI / 180;
    const cut = (test) => {
      let lo = 0.5, hi = 200;
      for (let i = 0; i < 50; i++) {
        const d = (lo + hi) / 2;
        e.camera.position.set(P.x + d * 0.6, P.y, P.z + d * 0.8);
        e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
        if (test(d)) lo = d; else hi = d;
      }
      return lo;
    };
    const dNew = cut(() => I.share(I.frameOf(c), P, r, I.MIN_SHARE, Infinity) > 0);
    const dOld = cut((d) => (2 * Math.atan(r / Math.hypot(d * 0.6, d * 0.8))) / vfov >= 0.149);
    out.push(`  ${key.padEnd(8)}  r ${r.toFixed(3)} m   old ${dOld.toFixed(2)} m   new ${dNew.toFixed(2)} m   `
      + `${((dNew / dOld - 1) * 100).toFixed(3)}%   header ${want} m`);
  }
  return out.join('\n');
}));
await browser.close();

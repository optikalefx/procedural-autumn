// The honest test: arrive from far out, let the streamer seed the colony, then
// close in the way a player drives — without re-parking anything. Proves the
// birds are there when you get to the island, and screenshots the payoff.
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

const isl = await p.evaluate(() => {
  const tb = window.__ctx.systems.wildlife.treeBirds;
  const I = tb._ensureIslands();
  const k = [...I.colony.get('flamingo')][0];
  return { x: I.list[k].x, z: I.list[k].z, rad: I.list[k].rad };
});
console.log(`colony island at (${Math.round(isl.x)}, ${Math.round(isl.z)}) radius ${Math.round(isl.rad)} m`);

// Arrive from 240 m out, seed, then close in step by step. Nothing is parked
// after the first stop — this is one continuous approach.
const rings = [240, 180, 130, 95];
for (let i = 0; i < rings.length; i++) {
  const r = await p.evaluate(async ([ix, iz, rad, dist, first]) => {
    const ctx = window.__ctx, tb = ctx.systems.wildlife.treeBirds;
    const th = Math.PI * 0.25;
    const x = ix + Math.sin(th) * (rad + dist), z = iz + Math.cos(th) * (rad + dist);
    const veh = ctx.systems.vehicle;
    veh.heading = Math.atan2(ix - x, iz - z);
    veh.warpTo(x, z);
    await new Promise((res) => setTimeout(res, 2200));
    // Park ONLY on arrival, then hand-step at every stop: under a headless
    // harness the sim clock barely advances on wall time, so a plain wait runs
    // no scans and reports an empty valley whatever the code does.
    if (first) for (const slots of tb.slots) for (const s of slots) { if (s.active) tb._park(s); s.cool = 0; }
    for (let k = 0; k < 400; k++) tb.update(1.0, ctx.camera, null);
    const cam = ctx.camera.position;
    const fl = tb.debugList().filter((v) => v.key === 'flamingo')
      .map((v) => Math.round(Math.hypot(v.x - cam.x, v.z - cam.z))).sort((a, c) => a - c);
    return { fl, cam: [Math.round(cam.x), Math.round(cam.z)] };
  }, [isl.x, isl.z, isl.rad, rings[i], i === 0]);
  console.log(`  ${String(rings[i]).padStart(3)} m off the rim: ${r.fl.length} flamingos @ ${r.fl.join(', ')} m`);
  if (i === rings.length - 1) {
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${OUT}/island-flamingos.png` });
    console.log(`  -> ${OUT}/island-flamingos.png`);
  }
}
await b.close();

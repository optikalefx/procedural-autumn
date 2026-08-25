// The payoff shot: seed the colony island, then look at it from over the lake.
// The camera is placed directly rather than by warping the camper, because the
// island sits in open water and driving there puts the chase camera under it.
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

for (const [name, D, H] of [['island-flock', 34, 7], ['island-wide', 120, 34]]) {
  const r = await p.evaluate(async ([nm, dist, hgt]) => {
    const ctx = window.__ctx, tb = ctx.systems.wildlife.treeBirds;
    const W2 = ctx.world;
    const I = tb._ensureIslands();
    const k = [...I.colony.get('flamingo')][0];
    const isl = I.list[k];

    // Stand the camper off the rim so the streamer seeds the island, then
    // hand-step: wall time does not advance the sim under a harness.
    const th = Math.PI * 0.25;
    ctx.systems.vehicle.warpTo(isl.x + Math.sin(th) * (isl.rad + 120), isl.z + Math.cos(th) * (isl.rad + 120));
    await new Promise((res) => setTimeout(res, 2200));
    for (const slots of tb.slots) for (const s of slots) { if (s.active) tb._park(s); s.cool = 0; }
    for (let i = 0; i < 500; i++) tb.update(1.0, ctx.camera, null);

    // Settled only: debugList includes birds mid-hop, and aiming at one
    // puts the camera 30 m from a patch of empty sky.
    const birds = tb.debugList().filter((v) => v.key === 'flamingo' && v.state === 0);
    if (!birds.length) return { none: true };
    // aim at the tightest knot of them
    const t = birds.reduce((best, v) => {
      const n = birds.filter((q) => Math.hypot(q.x - v.x, q.z - v.z) < 30).length;
      return n > best.n ? { n, v } : best;
    }, { n: -1, v: birds[0] }).v;

    // Frame the whole knot, not one bird.
    const near = birds.filter((q) => Math.hypot(q.x - t.x, q.z - t.z) < 30);
    const c = near.reduce((a, q) => ({ x: a.x + q.x / near.length, y: a.y + q.y / near.length, z: a.z + q.z / near.length }),
      { x: 0, y: 0, z: 0 });

    // Sweep azimuths and keep the one standing in the deepest water: over the
    // lake means nothing of the island is between the lens and the flock.
    // Aiming straight outward from the island centre was tried first and put
    // the camera on the island looking into its own trees.
    let bestA = 0, bestD = -1e9;
    for (let a = 0; a < 48; a++) {
      const th = (a / 48) * Math.PI * 2;
      const cx2 = c.x + Math.sin(th) * dist, cz2 = c.z + Math.cos(th) * dist;
      if (!W2.isInBounds(cx2, cz2)) continue;
      const d = W2.getWaterDepth(cx2, cz2);
      if (d > bestD) { bestD = d; bestA = th; }
    }
    window.__forceCamera = true;
    const cam = ctx.camera;
    cam.position.set(c.x + Math.sin(bestA) * dist, c.y + hgt, c.z + Math.cos(bestA) * dist);
    cam.lookAt(c.x, c.y, c.z);
    cam.updateMatrixWorld(true);
    return { nm, count: birds.length, framed: near.length, camWater: +bestD.toFixed(2),
      island: [Math.round(isl.x), Math.round(isl.z)] };
  }, [name, D, H]);

  if (r.none) { console.log(`${name}: no flamingos seeded`); continue; }
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name}: ${r.count} flamingos on island (${r.island}) -> ${OUT}/${name}.png`);
}
await b.close();

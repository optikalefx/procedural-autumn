// In-world captures of naturally-spawned waders: proves they are drawn, sits
// the camera at a real viewing distance, and reports each bird's height
// against the local water surface so "it is standing correctly" is measured.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const OUT = process.argv[2] ?? '/tmp/waders';
const SPOTS = [
  ['se-start', 1321, 912],
  ['nw-shelf', -1224, -1416],
];

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

for (const [name, sx, sz] of SPOTS) {
  // Stage: teleport, repopulate, then aim the camera at the biggest cluster.
  const info = await p.evaluate(async ([x, z]) => {
    const ctx = window.__ctx;
    const tb = ctx.systems.wildlife.treeBirds;
    window.__vehicleTeleport(x, z, 0);
    await new Promise((r) => setTimeout(r, 2500));
    for (const slots of tb.slots) for (const s of slots) { if (s.active) tb._park(s); s.cool = 0; }
    for (let i = 0; i < 400; i++) tb.update(1.0, ctx.camera, null);

    const W = ctx.world;
    const birds = [];
    for (const slots of tb.slots) {
      for (const s of slots) {
        if (!s.active || s.spec.habitat !== 'water' || s.state !== 0) continue;
        const wy = W.getWaterHeight(s.x, s.z);
        const gy = W.getHeight(s.x, s.z);
        birds.push({
          key: s.spec.key, x: s.x, y: s.y, z: s.z, sc: s.sc,
          waterY: +wy.toFixed(2), bedY: +gy.toFixed(2),
          depth: +(wy - gy).toFixed(2),
          bodyAboveWater: +(s.y - wy).toFixed(2),
          feetVsBed: +(s.y + s.spec.footY * s.sc - gy).toFixed(3),
        });
      }
    }
    if (!birds.length) return { none: true };
    // aim at the tightest group
    birds.sort((a, c) => a.key.localeCompare(c.key));
    const t = birds[0];
    window.__forceCamera = true;
    const cam = ctx.camera;
    const D = 26, H = 7;
    const ang = Math.atan2(t.x - x, t.z - z);
    cam.position.set(t.x - Math.sin(ang) * D, t.y + H, t.z - Math.cos(ang) * D);
    cam.lookAt(t.x, t.y, t.z);
    cam.updateMatrixWorld(true);
    return { birds, aimed: t };
  }, [sx, sz]);

  if (info.none) { console.log(`${name}: no settled waders`); continue; }
  console.log(`\n=== ${name} (${sx}, ${sz})`);
  for (const t of info.birds) {
    console.log(`  ${t.key.padEnd(9)} depth ${t.depth}m  body ${t.bodyAboveWater}m above surface  feet-vs-bed ${t.feetVsBed}m`);
  }
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/field-${name}.png` });
  console.log(`  -> ${OUT}/field-${name}.png`);
}
await b.close();

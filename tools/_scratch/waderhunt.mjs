// Teleport to candidate spots and count what the wader streamer actually
// places nearby, so "go here" is a measured claim rather than a guess.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

const SPOTS = [
  ['SE start (where you are)', 1321, 912],
  ['NW shelf A', -1136, -1328],
  ['NW shelf B', -1224, -1416],
  ['NW shelf C', -1088, -1248],
  ['mid-map pond', -464, 144],
  ['south pond', -32, -912],
];

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
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

for (const [name, x, z] of SPOTS) {
  const r = await p.evaluate(async ([nm, sx, sz]) => {
    const ctx = window.__ctx;
    const tb = ctx.systems.wildlife.treeBirds;
    window.__vehicleTeleport(sx, sz, 0);
    // let the world stream in around the new spot
    await new Promise((res) => setTimeout(res, 2500));
    // park every bird so the count is what THIS spot produces
    for (const slots of tb.slots) for (const s of slots) if (s.active) tb._park(s);
    for (const slots of tb.slots) for (const s of slots) s.cool = 0;
    for (let i = 0; i < 400; i++) tb.update(1.0, ctx.camera, null);
    const cam = ctx.camera.position;
    const live = tb.debugList().map((v) => ({
      key: v.key, d: Math.round(Math.hypot(v.x - cam.x, v.z - cam.z)),
    }));
    const by = {};
    for (const v of live) (by[v.key] ??= []).push(v.d);
    return { nm, at: [sx, sz], counts: Object.fromEntries(
      Object.entries(by).map(([k, ds]) => [k, `${ds.length} @ ${ds.sort((a, c) => a - c).join(',')} m`])) };
  }, [name, x, z]);
  console.log(`${r.nm.padEnd(26)} (${r.at[0]}, ${r.at[1]})  ${JSON.stringify(r.counts)}`);
}
await b.close();

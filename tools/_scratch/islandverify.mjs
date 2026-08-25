// Which islands does the colony land on, and do flamingos honour the "these
// two and nowhere else" rule? Teleports around the map and checks every bird
// the streamer places against the chosen island set.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('probe');

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

const info = await p.evaluate(() => {
  const tb = window.__ctx.systems.wildlife.treeBirds;
  const I = tb._ensureIslands();
  if (!I) return { none: true };
  const fl = [...(I.colony.get('flamingo') ?? [])];
  return {
    islands: I.list.length,
    totalShorePoints: I.list.reduce((s, i) => s + i.sites.length, 0),
    flamingoIslands: fl.map((k) => ({
      idx: k, x: Math.round(I.list[k].x), z: Math.round(I.list[k].z),
      radius: Math.round(I.list[k].rad), open: +I.list[k].open.toFixed(1),
      shorePoints: I.list[k].sites.length,
    })),
  };
});
console.log(JSON.stringify(info, null, 1));
if (info.none) { await b.close(); process.exit(0); }

// Drive the streamer from several places, including right on top of each
// colony island, and see where flamingos actually turn up.
const TOURS = [
  ['spawn (SE)', 1321, 912],
  ...info.flamingoIslands.map((i, n) => [`colony island ${n + 1}`, i.x, i.z + i.radius + 90]),
  ['mainland lake NW', -1224, -1416],
  ['mid map', -464, 144],
];

for (const [name, x, z] of TOURS) {
  const r = await p.evaluate(async ([sx, sz]) => {
    const ctx = window.__ctx, tb = ctx.systems.wildlife.treeBirds;
    const I = tb._ensureIslands();
    window.__vehicleTeleport(sx, sz, 0);
    await new Promise((res) => setTimeout(res, 2200));
    for (const slots of tb.slots) for (const s of slots) { if (s.active) tb._park(s); s.cool = 0; }
    for (let i = 0; i < 500; i++) tb.update(1.0, ctx.camera, null);
    const cam = ctx.camera.position;
    const out = {};
    const allowed = I.colony.get('flamingo');
    let offColony = 0;
    for (const v of tb.debugList()) {
      if (v.key === 'baldEagle') continue;
      (out[v.key] ??= []).push(Math.round(Math.hypot(v.x - cam.x, v.z - cam.z)));
      if (v.key === 'flamingo') {
        // nearest island to this bird, and is it one of the colony's?
        let bi = -1, bd = 1e9;
        I.list.forEach((isl, k) => {
          const d = Math.hypot(isl.x - v.x, isl.z - v.z) - isl.rad;
          if (d < bd) { bd = d; bi = k; }
        });
        if (!allowed.has(bi) || bd > 25) offColony++;
      }
    }
    return { out, offColony };
  }, [x, z]);
  const counts = Object.entries(r.out).map(([k, ds]) => `${k} ${ds.length} @ ${ds.sort((a, c) => a - c).slice(0, 4).join(',')}m`);
  console.log(`${name.padEnd(20)} ${counts.join('  |  ') || '(none)'}${r.offColony ? `   !! ${r.offColony} flamingo off-colony` : ''}`);
}
await b.close();

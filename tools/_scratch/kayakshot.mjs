/**
 * Kayak-on-a-river captures. Spawns a kayak mid-channel on a sustained reach,
 * boards it, paddles downstream and shoots at intervals — the view the player
 * gets, from the seat, plus an over-the-shoulder framing to judge how the hull
 * sits in the channel.
 *
 *   node tools/_scratch/kayakshot.mjs --out shots/kayak --shots 4
 *
 * Sim time is NOT wall time headless, so every wait here is state-based: it
 * polls the boat's own published position until it has actually travelled the
 * requested distance, never a sleep.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('out', 'shots/kayak');
const SHOTS = +arg('shots', 4);
const EVERY = +arg('every', 25);          // metres of travel between frames
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';
const W = +arg('w', 1280), H = +arg('h', 720);

mkdirSync(dirname(OUT + '-0.png'), { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState:3, url, close(){}, send(){}, addEventListener(){}, removeEventListener(){},
        set onopen(_){}, set onclose(_){}, set onerror(_){}, set onmessage(_){} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// Find a sustained reach and put a kayak in the middle of it.
const site = await p.evaluate(() => {
  const w = window.__world;
  const fdir = (x, z) => { const f = w.getFlow(x, z, {}); const m = Math.hypot(f.vx, f.vz);
    return m > 1e-4 ? { x: f.vx / m, z: f.vz / m, m } : null; };
  const reachLen = (x, z) => {
    let px = x, pz = z, len = 0;
    for (let i = 0; i < 60; i++) {
      const f = fdir(px, pz); if (!f || f.m < 0.15) break;
      px += f.x * 4; pz += f.z * 4;
      if (!w.isInBounds(px, pz)) break;
      if (w.getRiver(px, pz) < 0.20) break;
      const lv = w._water?.levelAt?.(px, pz);
      if (lv == null || lv - w.getHeight(px, pz) < 0.26) break;
      len += 4;
    }
    return len;
  };
  let best = null;
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    if (w.getRiver(x, z) < 0.5) continue;
    const h = w.getHydro(x, z); if (h.sdf < 2) continue;
    const f = fdir(x, z); if (!f || f.m < 0.4) continue;
    const rl = reachLen(x, z);
    if (!best || rl > best.reach) best = { x, z, reach: rl, sdf: h.sdf };
  }
  return best;
});
console.log('reach:', JSON.stringify(site));

await p.evaluate(({ x, z }) => {
  const bt = window.__boat;
  bt.spawnAt(x, z, { kind: 'kayak' });
  bt.board();
  // Steer to the current every frame, the way an attentive paddler does.
  // `drive(speed, turn)` is the scripted-input hook; without a steering term
  // the boat runs dead straight out of the first bend and the capture stops
  // being a picture of a river.
  const w = window.__world;
  const tick = () => {
    const st = window.__boat?.state?.().boats?.[0];
    if (st) {
      const f = w.getFlow(st.x, st.z, {});
      const m = Math.hypot(f.vx, f.vz);
      let turn = 0;
      if (m > 0.12) {
        let d = Math.atan2(f.vx, f.vz) - st.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        turn = Math.max(-1, Math.min(1, d * 1.6));
      }
      window.__boat.drive(1, turn);
    }
    requestAnimationFrame(tick);
  };
  tick();
}, site);

const shots = [];
for (let i = 0; i < SHOTS; i++) {
  const target = i * EVERY;
  await p.waitForFunction((t) => {
    const s = window.__boat?.state?.();
    const b0 = s?.boats?.[0]; if (!b0) return false;
    window.__kx ??= { x: b0.x, z: b0.z, d: 0 };
    window.__kx.d += Math.hypot(b0.x - window.__kx.x, b0.z - window.__kx.z);
    window.__kx.x = b0.x; window.__kx.z = b0.z;
    return window.__kx.d >= t;
  }, target, { timeout: 240000, polling: 50 });
  const st = await p.evaluate(() => {
    const b0 = window.__boat.state().boats[0];
    return { x: +b0.x.toFixed(1), z: +b0.z.toFixed(1), speed: +b0.speed.toFixed(2),
      riverness: +(b0.riverness ?? 0).toFixed(2), current: +(b0.current ?? 0).toFixed(2),
      depth: +b0.depth.toFixed(2), beached: b0.beached,
      pitchDeg: +(b0.pitch * 180 / Math.PI).toFixed(1),
      rollDeg: +(b0.roll * 180 / Math.PI).toFixed(1) };
  });
  const png = await p.screenshot();
  writeFileSync(`${OUT}-${i}.png`, png);
  shots.push({ file: `${OUT}-${i}.png`, ...st });
  console.log(`${i}:`, JSON.stringify(st));
}
console.log(JSON.stringify(shots, null, 1));
await b.close();

/**
 * Does the dash speedo report the craft the player is actually riding?
 *
 * Boots the game, finds open water, spawns a kayak (or --kind canoe), boards
 * it, paddles, and then reads THREE numbers at the same instant: the boat's
 * own published speed, the camper's speed, and the digits the HUD is showing.
 * Before the fix the third tracked the second; after it, the first.
 *
 *   AUTUMN_URL=http://127.0.0.1:5264 node tools/_scratch/hudboatspeed.mjs
 *
 * Sim time is NOT wall time headless, so every wait is state-based — it polls
 * the boat's published speed, never sleeps.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('out', '/tmp/hudboat');
const KIND = arg('kind', 'kayak');
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5264';
const SEED = process.env.SEED || '20261018';

mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
});
console.log('booting…');
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

// Open water with room to paddle: a lake cell (river mask near zero) at least
// a metre deep and well inside the waterline.
const site = await p.evaluate(() => {
  const w = window.__world;
  let best = null;
  for (let x = -900; x <= 900; x += 12) for (let z = -900; z <= 900; z += 12) {
    if (!w.isInBounds(x, z)) continue;
    if (w.getRiver(x, z) > 0.05) continue;
    const lv = w._water?.levelAt?.(x, z);
    if (lv == null) continue;
    const d = lv - w.getHeight(x, z);
    if (d < 1.2) continue;
    const h = w.getHydro(x, z);
    if (!(h.sdf > 14)) continue;
    if (!best || h.sdf > best.sdf) best = { x, z, sdf: h.sdf, depth: d };
  }
  return best;
});
console.log('site:', JSON.stringify(site));

await p.evaluate(({ x, z, kind }) => {
  window.__boat.spawnAt(x, z, { kind });
  window.__boat.board();
  window.__boat.drive(1, 0);
}, { ...site, kind: KIND });

// Wait for a real cruise, not the first surge: the stroke cycle is a 1.5 s
// impulse and the drag equilibrium takes a while to arrive, so wait on
// *distance travelled* — 80 m, roughly half a minute of sim — and record the
// peak speed seen along the way.
await p.waitForFunction(() => {
  const s = window.__boat?.state?.().boats?.[0];
  if (!s) return false;
  window.__kx ??= { x: s.x, z: s.z, d: 0, pk: 0 };
  window.__kx.d += Math.hypot(s.x - window.__kx.x, s.z - window.__kx.z);
  window.__kx.x = s.x; window.__kx.z = s.z;
  window.__kx.pk = Math.max(window.__kx.pk, s.speed);
  return window.__kx.d >= 80;
}, null, { timeout: 240000, polling: 50 });
console.log('peak m/s:', await p.evaluate(() => +window.__kx.pk.toFixed(2)));

const read = () => p.evaluate(() => {
  const b0 = window.__boat.state().boats[0];
  const num = document.querySelector('.pa-speed-num');
  const needle = document.querySelector('.pa-needle');
  const hold = document.querySelector('.pa-hold');
  return {
    boatMs: +b0.speed.toFixed(2),
    boatKmh: +(Math.abs(b0.speed) * 3.6).toFixed(1),
    vehicleMs: +(window.__vehicleState?.().speed ?? 0).toFixed(2),
    vehicleBrakeHold: !!window.__vehicle?.brakeHold,
    dashText: num?.textContent?.trim() ?? null,
    needle: needle?.style?.transform ?? null,
    holdLampOn: !!hold?.classList.contains('pa-on'),
    aboard: window.__boat.state().active,
  };
});

// The HOLD lamp. In the real flow the camper is always parked with the hold
// armed when you board (Boat gates the prompt on it), but a harness that
// teleports a boat across the valley leaves the camper unparked — so pin
// `brakeHold` true to stand in for the parked camper the player left behind.
await p.evaluate(() => {
  // Getter AND a swallowing setter: Vehicle.update assigns brakeHold every
  // frame, and a getter-only property would throw under module strict mode.
  Object.defineProperty(window.__vehicle, 'brakeHold',
    { get: () => true, set: () => {}, configurable: true });
});

const samples = [];
for (let i = 0; i < 3; i++) {
  samples.push(await read());
  await p.waitForFunction((n) => (window.__strokeN = (window.__strokeN ?? 0) + 1) > n * 90,
    i + 1, { timeout: 60000, polling: 30 });
}
// Shot while still aboard — everything below steps ashore.
const png = await p.screenshot();

// Stepping ashore has to put the camper's dial back, ticks and all: the boat
// scale is 20 km/h with 11 marks, the camper's 120 with 13.
const swap = await p.evaluate(async () => {
  const ticks = () => document.querySelectorAll('.pa-ticks path').length;
  const before = { ticks: ticks(), aboard: window.__boat.state().active };
  window.__boat.drive(null);
  window.__boat.exit();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { aboard: before, ashore: { ticks: ticks(), aboard: window.__boat.state().active,
    dashText: document.querySelector('.pa-speed-num')?.textContent?.trim(),
    holdLampOn: !!document.querySelector('.pa-hold')?.classList.contains('pa-on') } };
});

for (const s of samples) console.log(JSON.stringify(s));
console.log('swap:', JSON.stringify(swap));
writeFileSync(`${OUT}/readings-${KIND}.json`, JSON.stringify(samples, null, 1));
writeFileSync(`${OUT}/hud-${KIND}.png`, png);
console.log('shot ->', `${OUT}/hud-${KIND}.png`);
await b.close();

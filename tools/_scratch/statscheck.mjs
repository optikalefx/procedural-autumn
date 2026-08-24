#!/usr/bin/env node
/**
 * statscheck — exercise the logbook and read it back.
 *
 *   node tools/_scratch/statscheck.mjs            # numbers only
 *   SHOT=out.png node tools/_scratch/statscheck.mjs
 *
 * Every counter in src/game/Stats.js is derived by watching another system, so
 * the only way to know a counter works is to make the thing happen and look.
 * This drives, pitches camps until one comes with a telescope, launches and
 * paddles a boat, poses the camera at a waterfall, and sweeps the eyepiece
 * across every sky target — then prints the whole ledger.
 *
 * NOTE on the numbers: headless, simulated time runs far behind wall time (a
 * six second key press buys about a second of drive time). The figures below
 * are for checking that a counter MOVES and that it moves in the right units,
 * never for judging how long anything takes.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('statscheck');
const URL = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await p.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {},
        set onmessage(_) {} };
    }
    return new RealWS(u, pr);
  };
  window.WebSocket.prototype = RealWS.prototype; Object.assign(window.WebSocket, RealWS);
  // A fresh logbook, or every run inherits the last one's totals.
  try { localStorage.removeItem('pa.stats'); } catch { /* private mode */ }
});
await p.goto(`${URL}/?seed=20261018&res=512&car=camper&quality=low`);
await p.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 300 });

// Frames, not milliseconds. Simulated time is what every counter here is
// integrated against, and it is not wall time — see the header.
const frames = (n) => p.evaluate((k) => new Promise((r) => {
  let i = 0;
  const tick = () => (++i >= k ? r() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);
const get = (fn, arg) => p.evaluate(fn, arg);
const show = (label, o) => console.log(label.padEnd(12), JSON.stringify(o));
const mark = (s2) => console.log(`… ${s2}`);

// ── driving ─────────────────────────────────────────────────────────────────
await p.keyboard.down('w');
await frames(200);
await p.keyboard.up('w');
await frames(60);
show('drive', await get(() => ({
  time: +window.__stats.get('drive.time').toFixed(1),
  dist: +window.__stats.get('drive.dist').toFixed(1),
  camper: +window.__stats.get('drive.dist.camper').toFixed(1),
  top: +window.__stats.getHi('speed.top').toFixed(1),
  range: +window.__stats.getHi('range.far').toFixed(1),
  air: +window.__stats.get('air.time').toFixed(2),
  jumps: window.__stats.get('air.jumps'),
})));

// ── rescue, which must NOT be counted as a drive or a jump ──────────────────
const before = await get(() => ({ d: window.__stats.get('drive.dist'), a: window.__stats.get('air.time') }));
await get(() => window.__systems.vehicle.rescue());
await frames(120);
show('rescue', await get((b0) => ({
  rescues: window.__stats.get('drive.rescues'),
  distAdded: +(window.__stats.get('drive.dist') - b0.d).toFixed(1),
  airAdded: +(window.__stats.get('air.time') - b0.a).toFixed(2),
}), before));

// ── camps, until one comes with a telescope ─────────────────────────────────
const camp = await get(async () => {
  const c = window.__systems.camp;
  const v = window.__systems.vehicle;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  let scope = null;
  for (let i = 0; i < 10 && !scope; i++) {
    c.pitchNear(v.position.x + i * 3, v.position.z + i * 3, {});
    for (let f = 0; f < 30; f++) await frame();
    scope = c.camps.flatMap((cc) => cc.props)
      .find((pp) => pp.item?.kind === 'telescope' && pp.obj?.userData?.telescope) ?? null;
  }
  window.__scopeProp = scope?.obj ?? null;
  return {
    made: window.__stats.get('camp.made'),
    struck: window.__stats.get('camp.struck'),
    dogs: window.__stats.get('camp.dogs'),
    atCamp: +window.__stats.get('camp.time').toFixed(1),
    telescope: !!scope,
  };
});
show('camp', camp);

// ── packing up ──────────────────────────────────────────────────────────────
await get(async () => {
  const c = window.__systems.camp;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  c.strike();
  for (let f = 0; f < 40; f++) await frame();
});
show('strike', await get(() => ({ struck: window.__stats.get('camp.struck') })));

// ── the boat ────────────────────────────────────────────────────────────────
//
// On real water, and one of each hull. `boat.demo()` is not enough: it drops a
// canoe wherever the camper happens to be standing, which beaches it, and a
// beached hull paddles nowhere — the first run of this tool reported zero
// distance and zero strokes and the boat was simply aground.
show('boat', await get(async () => {
  const W = window.__world, boat = window.__systems.boat;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  let site = null;
  for (let i = 0; i < 40000 && !site; i++) {
    const x = (Math.random() - 0.5) * 1800, z = (Math.random() - 0.5) * 1800;
    if ((W.getWaterDepth(x, z) ?? 0) < 2.5) continue;
    const v = boat.validate(x, z);
    // Everything but the distance-to-camper gate, which is about where the
    // player parked rather than about the water.
    if (v.ok || v.reason === 'too far from the camper') site = { x: v.x, z: v.z };
  }
  if (!site) return { error: 'no launchable water in this valley' };

  const hulls = [];
  for (const kind of ['canoe', 'kayak']) {
    // spawnAt answers with state(), not the hull; the record is the newest.
    if (!boat.spawnAt(site.x, site.z, { kind })) return { error: 'spawn refused', kind };
    const bb = boat.boats[boat.boats.length - 1];
    boat.board();
    boat.drive(1, 0.1);
    const p0 = { x: bb.phys.x, z: bb.phys.z };
    for (let f = 0; f < 130; f++) await frame();
    hulls.push({ kind: bb.kind, moved: +Math.hypot(bb.phys.x - p0.x, bb.phys.z - p0.z).toFixed(1) });
    boat.drive(null);
    boat.exit();
    for (let f = 0; f < 10; f++) await frame();
  }
  return {
    hulls,
    launched: window.__stats.get('boat.launch'),
    canoe: window.__stats.get('boat.launch.canoe'),
    kayak: window.__stats.get('boat.launch.kayak'),
    boarded: window.__stats.get('boat.boarded'),
    time: +window.__stats.get('water.time').toFixed(1),
    canoeTime: +window.__stats.get('water.time.canoe').toFixed(1),
    kayakTime: +window.__stats.get('water.time.kayak').toFixed(1),
    // Logged distance runs a little OVER straight-line displacement, and
    // should: a turning hull travels further than it ends up from where it
    // started. Wildly over means the per-frame delta is picking up a respawn.
    dist: +window.__stats.get('water.dist').toFixed(1),
    strokes: window.__stats.get('water.strokes'),
  };
}));

// ── a waterfall, looked at ──────────────────────────────────────────────────
show('waterfall', await get(async () => {
  const list = window.__world.waterfalls ?? [];
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const cam = window.__engine.camera;
  // Take the camera off the rig the way every capture does, so a pose survives
  // the frame it is set on.
  window.__forceCamera = true;
  let looked = 0;
  for (const wf of list.slice(0, 4)) {
    const mx = (wf.top[0] + wf.bottom[0]) / 2;
    const my = (wf.top[1] + wf.bottom[1]) / 2;
    const mz = (wf.top[2] + wf.bottom[2]) / 2;
    cam.position.set(mx + 90, my + 30, mz + 90);
    cam.lookAt(mx, my, mz);
    cam.updateMatrixWorld(true);
    looked++;
    for (let f = 0; f < 14; f++) await frame();
  }
  window.__forceCamera = false;
  return { lookedAt: looked, found: window.__stats.count('falls'),
           ids: window.__stats.set('falls') };
}));

// ── the eyepiece ────────────────────────────────────────────────────────────
show('telescope', await get(async () => {
  const scope = window.__systems.camp.scope;
  const prop = window.__scopeProp;
  if (!prop) return { error: 'no camp rolled a telescope in 10 pitches' };
  const { SKY_OBJECTS } = await import('/src/game/sky_objects.js');
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  window.__lighting.hour = 23;                 // night, so the moon is up
  scope.enter(prop);
  for (let i = 0; i < 60; i++) await frame();  // past the lean-in
  for (const o of SKY_OBJECTS) {
    const d = o.dir;
    if (!d) continue;                          // the moon moves; swept below
    scope.yaw = Math.atan2(-d.x, -d.z);
    scope.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    for (let i = 0; i < 16; i++) await frame();
  }
  scope.leave();
  for (let i = 0; i < 40; i++) await frame();
  return {
    uses: window.__stats.get('scope.uses'),
    time: +window.__stats.get('scope.time').toFixed(1),
    found: window.__stats.set('sky'),
  };
}));

console.log('\nledger:', JSON.stringify(await get(() => window.__stats.data), null, 1));

if (process.env.SHOT) {
  await get(() => { window.__hud.toggleSettings(); window.__hud.settings._showPage('stats'); });
  await frames(30);
  await p.screenshot({ path: process.env.SHOT });
  // The sheet is taller than any window, and the half worth checking by eye —
  // the sky catalogue and the reset control — is the half below the fold.
  const bottom = process.env.SHOT.replace(/\.png$/, '-bottom.png');
  await get(() => { const n = window.__hud.settings.bodyStats; n.scrollTop = n.scrollHeight; });
  await frames(10);
  await p.screenshot({ path: bottom });
  console.log('\nwrote', process.env.SHOT, 'and', bottom);
}
await b.close();

/**
 * Does the parked camper stay put while the player is off in a boat?
 *
 * ── ANSWERED: YES. THERE IS NO BUG HERE ─────────────────────────────────────
 *
 * Kept because getting to that answer took two false alarms, and both are the
 * kind this harness exists to stop the next person repeating.
 *
 * What started it: two independent observers saw the HUD speedo read 89-120
 * km/h for a camper nobody was driving while the player was aboard a boat.
 * The first theory was heightfield streaming — VehiclePhysics streams a 176 m
 * patch (PATCH_SIZE) and if it followed the CAMERA rather than the camper,
 * paddling away would take the collider out from under the parked camper.
 * That is wrong: the camper's height above terrain held at ~0.8 m for the
 * whole run. It had a floor the entire time. It was rolling, not falling.
 *
 * The second theory was that the park brake releases while the boat holds the
 * controls. Also wrong, and wrong because of THIS HARNESS rather than because
 * of the game — see the note over the arming code below. `veh.brakeHold` is a
 * read-only mirror that Vehicle reassigns from `phys.holdArmed` every frame,
 * so arming it from a probe arms nothing. The runs that "proved" a park-brake
 * bug were measuring an unbraked camper on a 0.408 slope, which is simply
 * correct physics.
 *
 * Armed properly (`--hold`, which sets the internal `_brakeHold`), measured
 * over 600 frames with the player 2.5 km away in a kayak:
 *
 *              moved      dropped    max speed
 *   armed      0.20 m     0.34 m     0.58 m/s   <- suspension settling
 *   unarmed  154.56 m   131.13 m    38.21 m/s   <- a camper rolling downhill
 *
 * The mechanism is sound by construction and worth knowing: every arm AND
 * release branch in `Vehicle.update`'s brake-hold block is gated on `!held`,
 * so while a boat holds the controls `_brakeHold` is frozen exactly as it was
 * at boarding and cannot release. The player path cannot board without the
 * camper parked, so it is armed by construction too.
 *
 * Boards a boat as far from the camper as the map allows and watches the
 * camper's own position, height above terrain, and speed.
 *
 *   node tools/_scratch/camperdrift.mjs [--frames 600] [--hold]
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const FRAMES = +arg('frames', 600);
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5263';
const SEED = process.env.SEED || '20261018';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
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
console.log('booting…', SEED);
await p.goto(`${URL}/?seed=${SEED}&car=camper&res=768`, { timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
if (argv.includes('--hold')) await p.evaluate(() => { window.__ARM_HOLD = true; });

// Install a per-frame watcher on the camper, then board a boat far away.
const out = await p.evaluate(async (FRAMES) => {
  const w = window.__world;
  const veh = window.__systems?.vehicle ?? window.__vehicle;
  if (!veh) return { error: 'no vehicle handle', keys: Object.keys(window).filter(k => k.startsWith('__')) };
  const start = { x: veh.position.x, y: veh.position.y, z: veh.position.z };

  // A launchable water site as far from the camper as we can find.
  const { validateLaunch } = await import('/src/boat/boat_site.js');
  let best = null;
  for (let x = -1100; x <= 1100; x += 40) for (let z = -1100; z <= 1100; z += 40) {
    if (!w.isInBounds(x, z)) continue;
    const v = validateLaunch(w, x, z, null, 'kayak', 0.26);
    if (!v.ok) continue;
    const d = Math.hypot(v.x - start.x, v.z - start.z);
    if (!best || d > best.d) best = { x: v.x, z: v.z, d };
  }
  if (!best) return { error: 'no launch site found' };

  // Arm the park brake first when asked. The PLAYER path cannot board without
  // it — `Boat.update` gates boarding on the camper being parked — but
  // `board()` called straight from a harness skips that gate, so a probe that
  // does not arm it is measuring an unbraked camper on a hillside and calling
  // the result a bug.
  // Arm the INTERNAL flag. `veh.brakeHold` is a read-only mirror — Vehicle.js
  // reassigns it from `this.phys.holdArmed` every single frame (line ~466) —
  // so setting it from a harness arms nothing and is silently clobbered on the
  // next step. The first cut of this probe did exactly that, watched the mirror
  // read false at the end, and nearly reported a park-brake bug that was its
  // own measurement. `_brakeHold` is what reaches `phys.step({hold})`.
  const armed = !!window.__ARM_HOLD;
  if (armed) { veh._brakeHold = true; veh._rescueHold = true; }
  const holdAtStart = veh._brakeHold;
  window.__boat.spawnAt(best.x, best.z, { kind: 'kayak' });
  window.__boat.board();

  // Watch the camper for FRAMES frames of real rAF.
  const trace = [];
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const gy = w.getHeight(veh.position.x, veh.position.z);
      trace.push({ n, x: +veh.position.x.toFixed(1), y: +veh.position.y.toFixed(2),
        z: +veh.position.z.toFixed(1), above: +(veh.position.y - gy).toFixed(2),
        speed: +(veh.speed ?? 0).toFixed(2),
        hold: veh._brakeHold ? 1 : 0, armed: veh.brakeHold ? 1 : 0 });
      if (++n >= FRAMES) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
  const sp = trace.map(t => t.speed);
  const ab = trace.map(t => t.above);
  const last = trace[trace.length - 1];
  return {
    holdArmedByHarness: armed, holdAtStart, holdAtEnd: veh._brakeHold,
    internalHoldEveryFrame: trace.every(t => t.hold === 1),
    physHoldArmedEveryFrame: trace.every(t => t.armed === 1),
    controlsHeldBy: veh.controlsHeldBy,
    slopeAtCamper: +w.getSlope(start.x, start.z).toFixed(3),
    boardedAt: { x: Math.round(best.x), z: Math.round(best.z) },
    distanceFromCamper: Math.round(best.d),
    camperStart: { x: +start.x.toFixed(1), y: +start.y.toFixed(2), z: +start.z.toFixed(1) },
    camperEnd: { x: last.x, y: last.y, z: last.z },
    movedMetres: +Math.hypot(last.x - start.x, last.z - start.z).toFixed(2),
    fellMetres: +(start.y - last.y).toFixed(2),
    speed: { max: +Math.max(...sp).toFixed(2), last: last.speed },
    heightAboveTerrain: { min: +Math.min(...ab).toFixed(2), max: +Math.max(...ab).toFixed(2), last: last.above },
    firstFrames: trace.slice(0, 3),
    lastFrames: trace.slice(-3),
  };
}, FRAMES);
console.log(JSON.stringify(out, null, 1));
await b.close();

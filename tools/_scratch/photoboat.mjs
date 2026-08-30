/**
 * Photo mode aboard a boat: does the free camera actually get the camera?
 *
 * Boards a kayak, opens photo mode and checks the three controls the player
 * reported dead (2026-08-29) — the zoom ring, middle-drag pan, and the shot
 * staying where it is put — then re-runs the whole thing with `Boat.handOff`
 * stubbed out, which is exactly the code that shipped before the fix.
 *
 *   node tools/_scratch/photoboat.mjs
 *
 * Sim time is not wall time headless, so the "does it drift" test is the one
 * place a real sleep is correct: the camera rig is exempt from the world pause
 * and runs on the wall clock (main.js LIVE_WHILE_PAUSED), and the drift being
 * measured is a 2.0 s timer on that same clock.
 */
import { chromium } from 'playwright';

const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5178';
const SEED = process.env.SEED || '20261018';
const W = 1280, H = 720;

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

const pose = () => p.evaluate(() => {
  const c = window.__ctx.camera, r = window.__systems.cameraRig, bt = window.__systems.boat;
  return {
    pos: c.position.toArray(), quat: c.quaternion.toArray(), fov: c.fov,
    mode: r.mode, takeover: !!r._takeover, rigFov: r.fov, freeDist: r.freeDist,
    handedOff: !!bt._handedOff, aboard: !!bt._aboard,
  };
});
const dist = (a, c) => Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]);
const qdist = (a, c) => Math.max(...a.map((v, i) => Math.abs(v - c[i])));

// Put a kayak on the best sustained reach and get in it.
const site = await p.evaluate(() => {
  const w = window.__world;
  let best = null;
  for (let x = -1200; x <= 1200; x += 16) for (let z = -1200; z <= 1200; z += 16) {
    if (!w.isInBounds(x, z)) continue;
    if (w.getRiver(x, z) < 0.5) continue;
    const h = w.getHydro(x, z); if (h.sdf < 3) continue;
    if (!best || h.sdf > best.sdf) best = { x, z, sdf: h.sdf };
  }
  return best;
});
console.log('site:', JSON.stringify(site));

async function run(label, { stubHandOff }) {
  await p.evaluate(({ x, z, stub }) => {
    const bt = window.__boat;
    if (window.__systems.hud.photo.active) window.__systems.hud.togglePhoto();
    bt.exit();
    bt.spawnAt(x, z, { kind: 'kayak' });
    bt.board();
    // The pre-fix code path: photo mode asks, the boat refuses to let go.
    if (stub) { bt.__realHandOff = bt.handOff; bt.handOff = () => null; }
    else if (bt.__realHandOff) { bt.handOff = bt.__realHandOff; bt.__realHandOff = null; }
  }, { ...site, stub: stubHandOff });
  await p.waitForTimeout(600);
  // Under way BEFORE the shutter opens. `_readLook`'s ease home is gated on the
  // hull actually moving, and photo mode freezes the world — so the speed the
  // player pressed F at is the speed that gate sees for the whole visit. A
  // kayak sitting still would never have shown the drift they reported.
  await p.evaluate(() => window.__boat.drive(1, 0));
  await p.waitForFunction(() => (window.__systems.boat._aboard?.phys.speed ?? 0) > 1.2,
                          null, { timeout: 60000, polling: 100 });
  const speed = await p.evaluate(() => window.__systems.boat._aboard.phys.speed);
  // A head turn off the bow line, so there is something for the recentre to
  // pull back — the player's composed shot.
  await p.evaluate(() => { const bt = window.__systems.boat; bt._lookYaw = 0.9; bt._lookPitch = -0.25; });
  await p.waitForTimeout(400);

  const before = await pose();
  await p.evaluate(() => window.__systems.hud.togglePhoto());
  await p.waitForTimeout(400);
  const entry = await pose();

  // ── 1. does the shot stay put with nobody touching it ────────────────────
  const t0 = await pose();
  await p.waitForTimeout(4000);                       // > the 2.0 s recentre
  const t1 = await pose();

  // ── 2. the zoom ring ─────────────────────────────────────────────────────
  const zoom = await p.evaluate(() => {
    const ph = window.__systems.hud.photo, c = window.__ctx.camera;
    const was = { camFov: c.fov, rigFov: window.__systems.cameraRig.fov };
    const el = ph.zoomEl.input;
    el.value = String(Math.min(+el.max, +el.value + 0.45));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { was, asked: window.__systems.cameraRig.fov };
  });
  await p.waitForTimeout(300);
  const zoomed = await pose();

  // ── 3. middle-drag pan ───────────────────────────────────────────────────
  //
  // Dispatched by hand rather than through `page.mouse`: headless Chrome over
  // CDP delivers only `pointerdown`/`pointermove` once a button is held, and
  // core/Input listens on `mousedown`/`mousemove` for the look and the pan
  // (measured — see `_dragprobe2`). The events below hit the identical
  // listeners with the identical fields; only `isTrusted` differs.
  const preDrag = await pose();
  await p.evaluate(() => {
    const cv = document.getElementById('gl');
    const mk = (n, o) => cv.dispatchEvent(new MouseEvent(n, { bubbles: true, ...o }));
    mk('mousedown', { button: 1, clientX: 640, clientY: 360 });
    mk('mousemove', { movementX: 300, movementY: 0, clientX: 940, clientY: 360 });
  });
  await p.waitForTimeout(300);
  const panned = await pose();
  await p.evaluate(() => document.getElementById('gl')
    .dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1, clientX: 940, clientY: 360 })));

  // ── 4. a tap must not eject the photographer ─────────────────────────────
  //
  // Aboard, a plain click that ray-hits the camper is "go back to the camper"
  // (`_paddle`, the leaving block). Photo mode composes with the mouse, and
  // `Input.suppressed` does NOT reliably void a press: it voids one that is
  // still down at the END of a frame, and entering photo mode costs a
  // 450-2500 ms drawing-buffer reallocation, so a whole click can land inside
  // one frame gap and resolve to a tap. Aim the free camera at the camper,
  // leave a resolved tap on `input.press` — which is exactly the state a real
  // click leaves for `ClickTracker.poll` to read — and see who survives.
  const tap = await p.evaluate(async () => {
    const rig = window.__systems.cameraRig, bt = window.__systems.boat;
    const veh = window.__systems.vehicle, cam = window.__ctx.camera;
    const inp = window.__ctx.input, T = window.__THREE, w = window.__world;
    const frame = () => new Promise((r) => requestAnimationFrame(r));

    // Put the camper on the bank beside the boat.
    const a = bt._aboard.phys;
    let site = null;
    for (let r = 10; r <= 90 && !site; r += 4)
      for (let i = 0; i < 24 && !site; i++) {
        const t = (i / 24) * Math.PI * 2;
        const x = a.x + Math.cos(t) * r, z = a.z + Math.sin(t) * r;
        if (w.isInBounds(x, z) && w.getHydro(x, z, {}).sdf < -3 && w.getSlope(x, z) < 0.3) site = { x, z };
      }
    if (site) veh._land(site.x, site.z, veh.heading);
    await frame(); await frame();

    // Look straight at it, keeping the eye where it is (the `enterFree` decomposition).
    const eye = cam.position.clone();
    const d = veh.position.clone().setY(veh.position.y + 1.1).sub(eye);
    const dist = d.length(); d.normalize();
    rig.freeDist = dist;
    rig.freePivot.copy(eye).addScaledVector(d, dist);
    rig.freePitch = Math.asin(Math.max(-1, Math.min(1, -d.y)));
    rig.freeYaw = Math.atan2(-d.x, -d.z);
    inp.mouse.x = 0; inp.mouse.y = 0;              // crosshair, where the rail's grid is
    await frame();

    // Is the camper genuinely under the ray? (`pointerRay` + `objectHit`, reproduced.)
    const o = cam.position.clone();
    const dir = new T.Vector3(0, 0, 0.5).unproject(cam).sub(o).normalize();
    const rc = new T.Raycaster(o, dir); rc.far = 300;
    const hits = veh.rig ? rc.intersectObject(veh.rig, true) : [];
    const hit = hits.length ? hits[0].distance : Infinity;

    const clickOnce = async () => { inp.press.tap = true; await frame(); await frame(); };
    await clickOnce();
    const guarded = { aboard: !!bt._aboard, photo: window.__systems.hud.photo.active, dist, hit };

    // The same tap with the guard lifted for the frame it is read on.
    const was = bt._handedOff;
    bt._handedOff = false;
    await clickOnce();
    const bare = { aboard: !!bt._aboard };
    // Put the photographer back in the boat the unguarded tap just threw them
    // out of, so the exit test below has a seat to return to. `board` reinstalls
    // the takeover, so hand it straight back again.
    if (!bt._aboard) { bt.board(); bt.handOff(); }
    bt._handedOff = was;
    await frame();
    return { guarded, bare };
  });

  // ── 5. and the seat comes back ───────────────────────────────────────────
  await p.evaluate(() => window.__systems.hud.togglePhoto());
  await p.waitForTimeout(600);
  const out = await pose();
  const seat = await p.evaluate(() => {
    const bt = window.__systems.boat, c = window.__ctx.camera;
    const a = bt._aboard;
    if (!a) return NaN;
    return Math.hypot(c.position.x - a.phys.x, c.position.z - a.phys.z);
  });

  console.log(`\n── ${label} ──`);
  console.log(`  aboard:     kayak making ${speed.toFixed(2)} m/s, head turned off the bow`);
  console.log(`  entry:      mode=${entry.mode} takeover=${entry.takeover} handedOff=${entry.handedOff}`);
  console.log(`              pose kept: ${dist(before.pos, entry.pos).toExponential(1)} m, `
            + `${qdist(before.quat, entry.quat).toExponential(1)} quat   freeDist=${entry.freeDist?.toFixed(2)} m`);
  console.log(`  4 s still:  moved ${dist(t0.pos, t1.pos).toFixed(4)} m, turned ${qdist(t0.quat, t1.quat).toExponential(1)}`);
  console.log(`  zoom ring:  cam fov ${zoom.was.camFov.toFixed(2)} -> ${zoomed.fov.toFixed(2)}   `
            + `(rig asked for ${zoom.asked.toFixed(2)})`);
  console.log(`  middle pan: camera moved ${dist(preDrag.pos, panned.pos).toFixed(3)} m, `
            + `turned ${qdist(preDrag.quat, panned.quat).toExponential(1)}`);
  console.log(`  camper tap: guard on -> aboard=${tap.guarded.aboard}, `
            + `guard off -> aboard=${tap.bare.aboard}   `
            + `(camper ${tap.guarded.dist.toFixed(0)} m off the bow, ray hits it at ${tap.guarded.hit.toFixed(1)} m)`);
  console.log(`  on exit:    takeover=${out.takeover} handedOff=${out.handedOff} aboard=${out.aboard}`
            + `   eye ${seat.toFixed(2)} m from the hull`);
  return {
    still: dist(t0.pos, t1.pos), turned: qdist(t0.quat, t1.quat),
    zoomDelta: Math.abs(zoomed.fov - zoom.was.camFov),
    pan: dist(preDrag.pos, panned.pos), panTurn: qdist(preDrag.quat, panned.quat),
    entry, out, seat, kept: dist(before.pos, entry.pos), tap,
  };
}

const fixed = await run('WITH the fix (Boat.handOff)', { stubHandOff: false });
const old   = await run('WITHOUT it (the code that shipped)', { stubHandOff: true });

console.log('\n── verdict ──');
const ok = (n, c) => console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`);
ok('photo mode reaches free mode aboard', fixed.entry.mode === 'free' && !fixed.entry.takeover);
// The decompose/rebuild round trip in `enterFree`/`_free` is float, not exact —
// microns, against a camera that can be a kilometre from the origin.
ok('the frame you pressed F on is the frame you compose from', fixed.kept < 1e-3);
ok('shot holds still for 4 s (was: recentred at 2.0 s)', fixed.still < 1e-3 && fixed.turned < 1e-6);
ok('zoom ring moves the camera fov', fixed.zoomDelta > 1);
ok('middle drag translates without rotating', fixed.pan > 0.5 && fixed.panTurn < 1e-6);
ok('old: the shot could not be composed', old.entry.takeover);
ok('a click on the camper cannot eject you mid-photograph',
   fixed.tap.guarded.aboard && !fixed.tap.bare.aboard);
ok('the seat comes back on exit', fixed.out.takeover && !fixed.out.handedOff && fixed.seat < 6);
console.log('  --- and the same checks against the old path, which must fail ---');
ok('old: free mode never ran', old.entry.mode === 'free' && old.entry.takeover);
ok('old: shot drifted back', old.still > 1e-3 || old.turned > 1e-6);
ok('old: zoom ring did nothing', old.zoomDelta < 1e-6);
ok('old: middle drag did nothing', old.pan < 1e-3);

await b.close();

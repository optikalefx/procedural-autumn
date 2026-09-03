#!/usr/bin/env node
/**
 * The 15-second trailer — a seven-beat vertical cut, one page load.
 *
 *   node tools/trailer.mjs --url http://127.0.0.1:5193 --stills   # ~4 min, framing
 *   node tools/trailer.mjs --url http://127.0.0.1:5193 --fps 24 --ss 1 --out shots/trailer/look.mp4
 *   node tools/trailer.mjs --url http://127.0.0.1:5193 --fps 60 --ss 2 --out shots/trailer/cut.mp4
 *
 * `reel.mjs` films ONE choreography — drive, stop, make camp, orbit — and it
 * films it beautifully. A trailer has a different job: it has to say what is in
 * the game, and what is in this game is a camper, a kayak, a mountain bike, a
 * camera, a fire with a marshmallow over it, and a valley full of animals. None
 * of those fit in reel's one shot, so this tool films SEVEN and cuts them.
 *
 * ── what is borrowed and what is new ────────────────────────────────────────
 *
 * The clock is reel.mjs's and the reasoning behind it is in that file's header:
 * `engine.clock.getDelta` is replaced by a budget granted one frame at a time,
 * so a frame may cost a second of wall clock and still be exactly 1/fps of
 * screen time. Every system hangs off that one dt and physics is a 1/120
 * accumulator, so the motion is exact and reproducible, and a heavy frame costs
 * wall clock rather than quality. That is also why this is ONE page load: seven
 * separate tool runs would be seven bakes and seven worlds.
 *
 * What is new is that each beat has to SET THE WORLD UP first — put a kayak on
 * a river and get in it, park a bike and mount it, sit down at a fire, spawn a
 * deer and raise a camera at it — and each of those is a published harness API
 * that already exists because some other author needed it:
 *
 *   `__boat.spawnAt/board/drive`   tools/_scratch/kayakshot.mjs
 *   `__bike.parkAt/mount/drive`    Bike.js "harness API" section
 *   `__roast.enter`                camp_roast_view.js `_publishDebug`
 *   `wildlife.debugSpawn`          tools/wstrip.mjs
 *   `__camp.pitchNear`             tools/campshot.mjs
 *   `POSE_SRC`                     tools/_pose.mjs, shared with shot.mjs
 *
 * Nothing here synthesises input the game does not already accept from a
 * harness, and nothing pokes at internals a tool is not invited to poke at.
 *
 * ── who holds the camera ────────────────────────────────────────────────────
 *
 * This is the one thing to keep straight while reading the beats. THREE of them
 * (kayak, bike, roast) are filmed off the camera the GAME poses — the shared
 * `RideCamera` for the two rideables, the fireside pose for the roast — because
 * those views are composed, and a trailer that re-composes them is showing
 * something the player never sees. The other four are posed HERE, and those set
 * `__forceCamera` so `CameraRig.update` stands down at its capture check.
 *
 * `fov` follows the same split. three.js fov is VERTICAL, so at 9:16 the game's
 * own 50-62 deg reads as about 31 deg horizontal — a telephoto (reel.mjs's
 * header has the arithmetic). Beats posed here, and the two rideables, are
 * pinned to 70. The roast is NOT: it is an authored macro of a marshmallow at a
 * fire, and widening it would be re-composing the one beat whose composition is
 * the point.
 *
 * ── the light is an arc, not a montage ──────────────────────────────────────
 *
 * The hours run 17.4 -> 15.0 -> 16.0 -> 16.8 -> 17.6 -> 20.4 -> 19.8: the hook
 * keeps golden hour because it has half a second to hold a thumb and golden
 * hour is this game's best face, and everything after it slides forward into
 * dusk so the cut reads as one long afternoon rather than seven unrelated
 * postcards. The two beats that step back an hour (kayak, bike) step back
 * inside the same afternoon light, which is invisible; a jump to dawn would not
 * be.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { acquire } from './_lock.mjs';
import { POSE_SRC } from './_pose.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const OUT    = resolve(String(arg('out', 'shots/trailer/cut.mp4')));
const FPS    = Math.max(12, parseInt(arg('fps', '60'), 10) || 60);
const W      = parseInt(arg('w', '1080'), 10);
const H      = parseInt(arg('h', '1920'), 10);
const SS     = Math.max(1, parseFloat(arg('ss', '1')) || 1);
const SEED   = String(arg('seed', '20261018'));
const CAR    = String(arg('car', 'camper'));
const CRF    = String(arg('crf', '19'));
const BASE   = String(arg('url', process.env.AUTUMN_URL || 'http://localhost:5178'));
const STILLS = has('stills');
const EXT    = has('png') ? 'png' : 'jpg';
const ONLY   = arg('only', null);
const TMP    = resolve(String(arg('frames', `${OUT.replace(/\.[^.]+$/, '')}-frames`)));
const TRACE  = resolve(OUT.replace(/\.[^.]+$/, '.json'));

// ── the cut ─────────────────────────────────────────────────────────────────
//
// Seven beats, 15.0 s. The hook gets three seconds because a vertical short has
// about half a second to hold a thumb and one beat has to do that work; the
// four middle beats are two seconds each, which is long enough to read one verb
// and no longer; the fireside and the vista get two each because they are where
// the clip stops moving and lets you look.
const BEATS = [
  // THE HOOK. A night camp on high ground with the dog in it, orbited.
  //
  // It used to be the drive beat, and the drive beat was the wrong hook: the
  // back of a camper receding from a camera that is itself pulling away, so the
  // subject shrinks from both ends and the first frame is a rectangle with two
  // tail lights. This one opens on firelight against a dark ridge with an
  // animal moving in it — warm against cold, motion, and a dog, which is the
  // fastest emotional read available in two and a half seconds.
  { name: 'ridge', secs: 2.8, hour: 21.6, fov: 70, pose: true  },
  { name: 'kayak', secs: 2.0, hour: 15.0, fov: 70, pose: false },
  { name: 'bike',  secs: 2.0, hour: 16.0, fov: 70, pose: false },
  { name: 'photo', secs: 1.8, hour: 16.8, fov: 62, pose: true  },
  // The raise is RAISE_TIME 1.15 s and the build queue drains one prop per
  // frame, so a two-second camp beat is all raise and no camp. 2.4 leaves most
  // of a second of finished camp to land on.
  { name: 'camp',  secs: 2.4, hour: 17.6, fov: 70, pose: true  },
  { name: 'roast', secs: 2.0, hour: 20.4, fov: null, pose: false },
  // 19.8 filmed the massif as black cut-outs against lavender — atmospheric,
  // and the wrong last word for a game whose brief opens with "cozy".
  { name: 'vista', secs: 2.0, hour: 17.6, fov: 58, pose: true  },
];

/** Refuse to film a tree that does not parse — reel.mjs's gate, same reason. */
function assertTreeParses() {
  try {
    execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('[trailer] refusing to film because the source tree does not parse');
    console.error(((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim());
    process.exit(2);
  }
}

async function main() {
  assertTreeParses();
  const release = await acquire('trailer');
  mkdirSync(TMP, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });
  for (const f of readdirSync(TMP)) if (/\.(png|jpg)$/.test(f)) rmSync(`${TMP}/${f}`);

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: SS,
  });

  await page.addInitScript(() => {
    // A fresh headless context is a brand-new player, so HUD.maybeShowIntro
    // opens the first-run journal 400 ms after boot on a REAL setTimeout and the
    // open book takes the keys. This cost reel.mjs a whole scout — eight
    // candidates all reporting `drive IMPACT -0`, which is not eight collisions
    // but a camper that never moved.
    try {
      const k = 'pa.hud';
      const st = JSON.parse(localStorage.getItem(k) ?? '{}') || {};
      st.introSeen = true; st.seenHint = true; st.escSeen = true;
      localStorage.setItem(k, JSON.stringify(st));
    } catch { /* storage unavailable; still worth attempting */ }
    // Six checkouts share this machine; a peer saving a file mid-film reloads
    // the page and throws out the run.
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
                 send() {}, close() {}, set onopen(_) {}, set onmessage(_) {},
                 set onclose(_) {}, set onerror(_) {} };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `${BASE}/?seed=${SEED}&car=${CAR}&quality=high&pixelratio=native&iscale=1`;
  console.log(`[trailer] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle,
    null, { timeout: 30000 });

  // ── take the clock (reel.mjs's mechanism; see its header) ─────────────────
  await page.evaluate((fps) => {
    const e = window.__engine;
    e.adaptive = false;
    e.autoQuality = false;
    const DT = 1 / fps;
    let budget = 0;
    window.__reelGrant = () => { budget += DT; };
    e.clock.getDelta = () => {
      if (budget <= 1e-9) return 0;
      budget -= DT;
      return DT;
    };
  }, FPS);

  const step = async () => page.evaluate(() => new Promise((res) => {
    window.__reelGrant();
    // Two frames: the first consumes the grant, the second guarantees the
    // result is composited before the screenshot reads the surface.
    requestAnimationFrame(() => requestAnimationFrame(() => res(1)));
  }));
  /** Advance n frames of world time without photographing any of them. */
  const grant = async (n) => { for (let i = 0; i < n; i++) await step(); };
  /**
   * Let the world catch up after a teleport. Streaming and async asset loads
   * are on WALL time, not the granted clock, so this needs both kinds of wait —
   * a sleep alone advances nothing and a grant alone outruns the loader.
   */
  const settle = async (secs = 1.6) => {
    await grant(Math.round(FPS * secs));
    await page.waitForTimeout(900);
    await grant(Math.round(FPS * 0.5));
  };

  const held = new Set();
  const hold = async (code, on) => {
    if (on && !held.has(code)) { await page.keyboard.down(code); held.add(code); }
    if (!on && held.has(code)) { await page.keyboard.up(code); held.delete(code); }
  };

  // ── take the HUD off, and give the fov a switch ───────────────────────────
  //
  // `pa-capture-hidden` is normally driven by `__forceCamera`, but that flag
  // also hands the camera to the harness and three of these beats want the
  // game's own camera. So hide the root directly. `.pa-camp-prompt` is appended
  // to document.body rather than to `#pa-hud`, so hiding the root alone leaves
  // "E pitch a camp here" sitting in an otherwise clean frame.
  await page.evaluate(() => {
    const css = document.createElement('style');
    css.id = 'pa-trailer-hide';
    // `.pa-roast-tip` ("drag or A/D to turn it · S down into the heat…") is the
    // roast view's own bar and lives outside #pa-hud, exactly like
    // `.pa-camp-prompt`; the vignette and glow beside it are part of the
    // composed fireside look and stay.
    window.__tHide = '.pa-camp-prompt, .pa-toast, .pa-hint, .pa-roast-tip, ' +
      '.pa-roast-result { display: none !important; }';
    css.textContent = `#pa-hud { display: none !important; } ${window.__tHide}`;
    document.head.appendChild(css);
    // Pinned from a late updater registered LAST, so it lands after CameraRig
    // (Engine runs _lateUpdaters in registration order) — but only when a beat
    // has asked for a pin. `null` leaves whatever composed the view alone.
    window.__tFov = null;
    window.__engine.onLateUpdate(() => {
      const cam = window.__engine.camera;
      if (window.__tFov && Math.abs(cam.fov - window.__tFov) > 0.001) {
        cam.fov = window.__tFov;
        cam.updateProjectionMatrix();
      }
    });
  });

  // ── beat setups ───────────────────────────────────────────────────────────
  //
  // `world` is what one beat leaves for another. Only the drive writes to it,
  // and only the camp reads it — see the note in `setups.camp`.
  const world = {};
  const setups = {};

  /**
   * Choose an orbit arc around a pitched camp, and write it to `__tOrbit` for
   * the per-frame camera to fly.
   *
   * Shared by the camp beat and the night-ridge hook, which want the same shot
   * of the same subject at different radii — extracted the moment the second
   * one existed rather than copied, because every hard-won line below would
   * otherwise have to be re-learned in one of the two copies.
   */
  const surveyOrbit = ({ cx, cz, r0 = 9.5, r1 = 7.0, sweep = 0.40, lift = 0 }) =>
    page.evaluate(({ cx, cz, R0, R1, SWEEP, LIFT }) => {
      const THREE = window.__THREE, wd = window.__world, e = window.__engine;
      const v = window.__systems.vehicle;
      // Stand OPPOSITE the camper and orbit the camp: in 9:16 the composition
      // that works is the camp in the near third with the camper reading behind
      // it and trees and ridge above, which is exactly the bearing 180 deg from
      // the camper. Derive it rather than inheriting the chase camera's.
      const azVeh = Math.atan2(v.position.x - cx, v.position.z - cz);
      // Aim just off the fire toward the camper, biased by a fraction of the
      // ORBIT RADIUS rather than of the separation: a bias tuned as a fraction
      // of separation put the aim 6 m past a camp that was only 7.5 m away.
      const sep = Math.hypot(v.position.x - cx, v.position.z - cz) || 1;
      const bias = Math.min(0.20 * R0, 0.25 * sep);
      const lx = cx + (v.position.x - cx) / sep * bias;
      const lz = cz + (v.position.z - cz) / sep * bias;
      const look = new THREE.Vector3(lx, wd.getHeight(lx, lz) + 1.5 + LIFT, lz);

      // Survey the whole circle ONCE and orbit on the clearest arc. Clearance
      // is a property of the SITE; a per-frame raycast decision makes the
      // camera jitter whenever the answer flips between frames, and stepping
      // the camera outward to escape an obstacle shrinks the subject.
      const ray = new THREE.Raycaster(); ray.far = 30;
      const N = 72, STEP = Math.PI * 2 / N;
      const blocked = new Array(N).fill(0);
      const camY = (rr, ax) => wd.getHeight(cx + Math.sin(ax) * rr, cz + Math.cos(ax) * rr)
                               + 1.9 + rr * 0.055 + LIFT;
      for (let i = 0; i < N; i++) {
        const ax = i * STEP;
        for (const rr of [R0, R1]) {
          const px = cx + Math.sin(ax) * rr, pz = cz + Math.cos(ax) * rr;
          const pos = new THREE.Vector3(px, camY(rr, ax), pz);
          // Three rays, not one: a trunk two metres off the optical axis fills
          // a 9:16 frame just as completely as one dead centre.
          for (const off of [-2.2, 0, 2.2]) {
            const aim = look.clone();
            aim.x += Math.cos(ax) * off; aim.z -= Math.sin(ax) * off;
            ray.set(pos, aim.sub(pos).normalize());
            const hits = ray.intersectObjects(e.scene.children, true)
              .filter((h) => h.distance > 0.05 && h.object.visible &&
                             h.object.name !== 'Sky' && !h.object.isPoints);
            if (hits.length && hits[0].distance < rr - 3.0) blocked[i]++;
          }
        }
      }
      // Both terms have to be on the same scale or one stops mattering: a raw
      // blocked-ray count (0-30) added to radians made the composition term
      // noise and sent the orbit 55 deg off-axis to save two rays.
      const wN = Math.max(2, Math.round(SWEEP / STEP));
      let bestAz = azVeh + Math.PI - SWEEP / 2, bestCost = Infinity;
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = 0; j < wN; j++) sum += blocked[(i + j) % N];
        const mid = (i + wN / 2) * STEP;
        const d = Math.abs(((mid - (azVeh + Math.PI)) % (Math.PI * 2) + Math.PI * 3)
                           % (Math.PI * 2) - Math.PI);
        const cost = (sum / (wN * 3)) * 3 + d;
        if (cost < bestCost) { bestCost = cost; bestAz = i * STEP; }
      }
      window.__tOrbit = { cx, cz, lx, lz, az0: bestAz, sweep: SWEEP, r0: R0, r1: R1, lift: LIFT };
      return { clear: blocked.filter((b) => b === 0).length, cost: +bestCost.toFixed(2) };
    }, { cx, cz, R0: r0, R1: r1, SWEEP: sweep, LIFT: lift });

  /**
   * Drive: find a meadow the camper can actually get out of, and open at speed.
   *
   * The scoring is reel.mjs's and so is the rule it encodes — REHEARSE, DO NOT
   * PREDICT. Four rounds went into picking a drivable start from proxies there
   * (slope, run-out drop, a downward raycast, a water query) and every proxy
   * passed a corridor the camper then failed: a raycast cannot see a river,
   * because a river is a cut in the ground with nothing standing proud of it,
   * and a water query cannot see a boulder. Driving it costs two seconds.
   */
  /**
   * Find a meadow the camper can actually get out of, and leave it rolling.
   *
   * Shared, because TWO beats need the answer and only one of them is always in
   * the cut: the drive beat films the corridor, and the camp beat pitches at its
   * run-out. When the drive beat was the hook this ran as its setup and left the
   * result in `world`; the hook is now the night ridge, so the camp beat has to
   * be able to ask for it directly or it falls back to picking a meadow by slope
   * — which is exactly what put a camp behind a tree trunk.
   *
   * Cached: with both beats in the cut, the rehearsal is paid for once.
   */
  const proveMeadow = async ({ roll = false } = {}) => {
    if (world.drive && !roll) return world.drive;
    const shortlist = await page.evaluate(({ look }) => {
      const w = window.__world, poi = window.__poi;
      const out = [];
      for (let i = 0; i < 12; i++) {
        const q = poi.best('meadow', i);
        if (!q) break;
        let sl = 0, n = 0;
        for (let a = 0; a < 8; a++) {
          for (let d = 6; d <= 24; d += 6) {
            sl += w.getSlope(q.x + Math.cos(a * 0.785) * d, q.z + Math.sin(a * 0.785) * d);
            n++;
          }
        }
        // Meadows carry no bearing of their own — `poi.best` returns the raw
        // record and only `poi.anchor` derives a yaw, aiming it at scenery for
        // a camera rather than at ground a camper can use. So pick the flattest
        // run out of it.
        let yaw = q.yaw, flattest = Infinity;
        if (yaw === undefined) {
          for (let a = 0; a < 16; a++) {
            const ang = a * (Math.PI / 8);
            let lo = Infinity, hi = -Infinity;
            for (let d = 0; d <= look; d += 5) {
              const h = w.getHeight(q.x + Math.sin(ang) * d, q.z + Math.cos(ang) * d);
              lo = Math.min(lo, h); hi = Math.max(hi, h);
            }
            if (hi - lo < flattest) { flattest = hi - lo; yaw = ang; }
          }
        }
        let wet = 0;
        for (let d = 3; d <= look; d += 2) {
          for (const off of [-3, 0, 3]) {
            const px = q.x + Math.sin(yaw) * d + Math.cos(yaw) * off;
            const pz = q.z + Math.cos(yaw) * d - Math.sin(yaw) * off;
            if (w.getWaterContactDepth(px, pz) > 0.05) wet++;
          }
        }
        out.push({ i, x: q.x, z: q.z, yaw, wet, slope: sl / n,
                   score: sl / n + (Number.isFinite(flattest) ? flattest : 0) / look + wet * 1.5 });
      }
      out.sort((a, b) => a.score - b.score);
      return out.slice(0, 8);
    }, { look: 54 });

    for (const cand of shortlist) {
      await page.evaluate((c) => {
        window.__camp?.strike?.();
        window.__vehicleTeleport?.(c.x, c.z, c.yaw);
      }, cand);
      await settle(1.5);
      // Rehearse: hold the throttle for the length of the beat plus its preroll
      // and read the speed trace. Deceleration under throttle is the test —
      // nothing but an impact does that, and a "did it stop" check passes a
      // camper that hit a boulder at 20.8 m/s and carried on at 14.5.
      const speeds = [];
      await hold('KeyW', true);
      for (let i = 0; i < Math.round(FPS * 4.6); i++) {
        await step();
        speeds.push(await page.evaluate(() => Math.abs(window.__systems.vehicle.speed ?? 0)));
      }
      await hold('KeyW', false);
      const win = Math.max(1, Math.round(FPS * 0.2));
      let worst = 0;
      for (let i = win; i < speeds.length; i++) {
        if (speeds[i - win] < 5) continue;
        worst = Math.max(worst, speeds[i - win] - speeds[i]);
      }
      const top = speeds.reduce((m, v) => Math.max(m, v), 0);
      const ok = worst <= 3 && top > 8;
      console.log(`[trailer]   meadow[${cand.i}] slope ${cand.slope.toFixed(3)} water ${cand.wet}` +
                  `  drive ${ok ? 'clean' : `IMPACT -${worst.toFixed(1)}`} (top ${top.toFixed(1)})`);
      if (ok) {
        world.drive = cand;
        if (roll) {
          // Put it back at the start and open already rolling: a short has no
          // room for the first half second of a standing start.
          await page.evaluate((c) => window.__vehicleTeleport?.(c.x, c.z, c.yaw), cand);
          await settle(1.2);
          await hold('KeyW', true);
          await grant(Math.round(FPS * 1.4));
        }
        return cand;
      }
    }
    throw new Error('no drivable meadow');
  };

  /** The drive beat, if the cut still has one: rehearse, then open at speed. */
  setups.drive = async () => proveMeadow({ roll: true });

  /**
   * Kayak: find the longest sustained reach in the world and put a boat in it.
   *
   * The reach search is kayakshot.mjs's, coarsened to a 24 m grid — it is
   * looking for a river long enough to paddle down, and a river is much wider
   * than 24 m of search resolution. `reachLen` walks the flow field forward and
   * stops at the first point that is not river, not deep enough, or out of
   * bounds, which is the only honest way to ask "can this be paddled" of a
   * procedural drainage network.
   */
  setups.kayak = async () => {
    const site = await page.evaluate(() => {
      const w = window.__world;
      const fdir = (x, z) => {
        const f = w.getFlow(x, z, {}); const m = Math.hypot(f.vx, f.vz);
        return m > 1e-4 ? { x: f.vx / m, z: f.vz / m, m } : null;
      };
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
      for (let x = -1200; x <= 1200; x += 24) {
        for (let z = -1200; z <= 1200; z += 24) {
          if (!w.isInBounds(x, z)) continue;
          if (w.getRiver(x, z) < 0.5) continue;
          const h = w.getHydro(x, z); if (h.sdf < 2) continue;
          const f = fdir(x, z); if (!f || f.m < 0.4) continue;
          const rl = reachLen(x, z);
          if (!best || rl > best.reach) best = { x, z, reach: rl };
        }
      }
      return best;
    });
    if (!site) throw new Error('no paddleable reach');
    console.log(`[trailer]   reach (${site.x}, ${site.z}) ${site.reach} m`);
    // Stand the camper on the bank so streaming has a reason to build the
    // river's neighbourhood; the boat's camera is what actually films it.
    await page.evaluate(({ x, z }) => window.__vehicleTeleport?.(x + 26, z + 26, 0), site);
    await settle(1.8);
    await page.evaluate(({ x, z }) => {
      window.__boat.spawnAt(x, z, { kind: 'kayak' });
      window.__boat.board();
    }, site);
    // Paddle into the channel BEFORE the beat starts, not on frame one.
    //
    // Granting still frames does not fix this and 1.8 s of them did not: the
    // problem is not the ride camera easing onto the deck, it is that a kayak
    // dropped at the head of a reach is not yet going anywhere. It takes a
    // second of paddling for the hull to find the current, and the mounted eye
    // rolls with the hull, so filming from the first stroke opens the beat on a
    // banked horizon and a bank sliding past at 30 degrees. Spend that second
    // off camera — same granted clock, no frames written — and the cut lands on
    // a boat already running straight downstream.
    for (let i = 0; i < Math.round(FPS * 3.0); i++) { await drivers.kayak(); await step(); }
    return site;
  };

  /** Bike: park one on open meadow ground and ride a gentle arc out of it. */
  setups.bike = async (taken = []) => {
    const spot = await page.evaluate((skip) => {
      const poi = window.__poi, w = window.__world;
      // Not the same meadow the drive used: two beats of the same clearing is
      // one location pretending to be two, and the drive picks its meadow by
      // rehearsal, so which one it took is only known at run time.
      for (let i = 0; i < 12; i++) {
        if (skip.includes(i)) continue;
        const q = poi.best('meadow', i);
        if (!q) break;
        let sl = 0, n = 0;
        for (let a = 0; a < 8; a++) {
          sl += w.getSlope(q.x + Math.cos(a * 0.785) * 12, q.z + Math.sin(a * 0.785) * 12); n++;
        }
        if (sl / n < 0.18) return { x: q.x, z: q.z, i };
      }
      return null;
    }, taken);
    if (!spot) throw new Error('no meadow for the bike');
    console.log(`[trailer]   bike meadow[${spot.i}] (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)})`);
    await page.evaluate(({ x, z }) => window.__vehicleTeleport?.(x, z, 0), spot);
    await settle(1.8);
    await page.evaluate(({ x, z }) => {
      window.__bike.parkAt(x + 4, z + 4, {});
      window.__bike.mount();
      window.__bike.drive(1, 0.10);
    }, spot);
    await grant(Math.round(FPS * 1.0));
    return spot;
  };

  /**
   * Wildlife photography: spawn an animal in front of the camera, then raise
   * the camera at it.
   *
   * Order matters. Photo mode is CameraRig's free mode and "takes over from
   * wherever the camera already is — the frame the player pressed F on is the
   * frame they get to compose from" (hud_photo.setActive), so the composition
   * has to be written BEFORE it is entered, not after.
   */
  setups.photo = async () => {
    const at = await page.evaluate(() => {
      const a = window.__anchorAt('meadow', 1) ?? window.__cameraAnchors.meadow();   // spent below
      window.__vehicleTeleport?.(a.x, a.z, a.yaw ?? 0);
      return a;
    });
    await settle(2.0);
    const shot = await page.evaluate(({ species, a }) => {
      // `debugSpawn` walks out from THE CAMERA — `cam.position + forward*dist`
      // — not from the camper, and this beat inherits whatever camera the bike
      // ride left behind, most of a valley away. Stand the camera where the
      // shot is before asking for an animal in front of it.
      const e = window.__engine, wd = window.__world;
      const yaw = a.yaw ?? 0;
      e.camera.position.set(a.x, wd.getHeight(a.x, a.z) + 1.6, a.z);
      e.camera.lookAt(a.x + Math.sin(yaw) * 20, wd.getHeight(a.x, a.z) + 1.2,
                      a.z + Math.cos(yaw) * 20);
      e.camera.updateMatrixWorld(true);
      const wl = window.__systems.wildlife;
      const sp = wl.debugSpawn(species, { dist: 14, clear: 9 });
      if (!sp) return null;
      return { x: sp.x, y: sp.y, z: sp.z, n: sp.n };
    }, { species: String(arg('species', 'deer')), a: at });
    // Spend the meadow so the camp beat does not pitch a tent in the clearing
    // this one just photographed a deer in. Two beats of one clearing is one
    // location pretending to be two, and on the first pass it was exactly that.
    if (shot) shot.i = 1;
    if (!shot) throw new Error('wildlife would not spawn');
    await grant(Math.round(FPS * 0.6));
    // Compose on the animal from a low three-quarter stand-off, then hand the
    // frame to photo mode so the viewfinder is what the beat is shot through.
    await page.evaluate((s) => {
      const THREE = window.__THREE, e = window.__engine, wd = window.__world;
      const az = 2.1;
      const R = 9.5;
      const px = s.x + Math.sin(az) * R, pz = s.z + Math.cos(az) * R;
      e.camera.position.set(px, wd.getHeight(px, pz) + 1.55, pz);
      e.camera.lookAt(s.x, wd.getHeight(s.x, s.z) + 0.95, s.z);
      window.__tSubject = s;
      window.__tAz = az;
      window.__systems.hud.photo.setActive(true);
      // Show the viewfinder, and ONLY the viewfinder.
      //
      // Photo mode's UI is two things: four corner brackets and a "camera back"
      // rail of dials and captions. The brackets are what makes this beat read
      // as photographing an animal rather than as one more pretty frame of a
      // deer; the rail is a control panel and belongs in the game, not in a
      // 1.8-second cut. `#pa-hud` also hides itself whenever `__forceCamera` is
      // up (HUD.js: `!!window.__forceCamera && !window.__hudForce`) — which
      // this beat needs up, because it poses its own camera — so the override
      // is what lets the brackets through at all.
      window.__hudForce = true;
      // The photo UI lives inside #pa-hud, which every other beat wants gone.
      document.getElementById('pa-trailer-hide').textContent = window.__tHide +
        '#pa-hud > *:not(.pa-photo-frame) { display: none !important; }' +
        '.pa-photo-frame .pa-rail, .pa-photo-frame .pa-cam-desk { display: none !important; }';
    }, shot);
    await grant(Math.round(FPS * 0.5));
    return shot;
  };

  /** Camp: pitch one beside the camper and orbit it. reel.mjs's beat. */
  setups.camp = async () => {
    await page.evaluate(() => {
      window.__systems.hud.photo.setActive(false);
      window.__hudForce = false;
      document.getElementById('pa-trailer-hide').textContent =
        `#pa-hud { display: none !important; } ${window.__tHide}`;
      window.__bike?.dismount?.();
      window.__boat?.exit?.();
    });
    // Pitch on the ground the drive already proved, not on another meadow.
    //
    // The first version picked the best unspent meadow by slope, and slope is
    // not what a camp beat needs: it landed a full, correct, 10-prop camp in a
    // wooded clearing, behind a trunk, 20 m from the lens, and the survey
    // called the arc 69/72 clear because the sight line to the fire genuinely
    // was — a canopy overhead and a trunk beside the camera are not on any ray
    // between the camera and the subject. Meanwhile the drive beat has already
    // rehearsed a corridor for real, and its run-out is open low-slope ground
    // with no water in it, which is exactly what a camp wants. Use that.
    const site = await page.evaluate((d) => {
      const w = window.__world;
      const x = d ? d.x + Math.sin(d.yaw) * 45 : window.__poi.best('meadow', 0).x;
      const z = d ? d.z + Math.cos(d.yaw) * 45 : window.__poi.best('meadow', 0).z;
      window.__camp?.strike?.();
      window.__vehicleTeleport?.(x, z, d ? d.yaw : 0);
      return { x, z, y: w.getHeight(x, z) };
    }, await proveMeadow());
    await settle(2.0);
    // Latch the park brake with a REAL keypress. Not decoration: at dusk the
    // headlights flood the camp from 8-18 m away and latching the brake is what
    // dips them. campshot.mjs learned this the expensive way.
    await hold('Space', true);
    await grant(Math.round(FPS * 0.8));
    await hold('Space', false);
    const camp = await page.evaluate(() => {
      const v = window.__systems.vehicle;
      // `pitchNear`'s radius is the whole control over full-vs-compact, and a
      // compact site is 3 props where a full one is 6-11. Probe with
      // `instant: true`, strike each probe, then pitch for real at the radius
      // that won — pitching for real each time and striking the loser leaves an
      // empty clearing when every radius comes back compact.
      let radius = 0, small = true;
      // Tighter than reel.mjs's 20/30/40. That ladder is looking for a full
      // camp anywhere in reach; this beat also has to hold the CAMPER in the
      // same 9:16 frame, and a camp pitched 40 m away puts the thing the clip
      // has been following into the far background.
      for (const r of [14, 22, 30]) {
        const probe = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: r });
        if (!probe) continue;
        window.__camp.strike();
        radius = r; small = !!probe.small;
        if (!small) break;
      }
      if (!radius) return null;
      const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: false, radius });
      if (!s) return null;

      return { x: +s.x.toFixed(1), z: +s.z.toFixed(1), small: !!s.small };
    });
    if (camp) Object.assign(camp, await surveyOrbit({ cx: camp.x, cz: camp.z, r0: 9.5, r1: 7.0 }));
    if (!camp) throw new Error('pitchNear found no site');
    console.log(`[trailer]   camp (${camp.x}, ${camp.z})${camp.small ? ' [compact]' : ''}` +
                `  arc ${camp.clear}/72 clear, cost ${camp.cost}`);
    return camp;
  };

  /**
   * Roast: sit down at the fire the camp beat just built.
   *
   * `__roast.enter()` with no arguments finds the first camp in the world that
   * has a roasting stick in it, which is exactly the camp still standing from
   * the previous beat — so this beat is the same place, later. The step-in runs
   * for real; wait it out rather than snapping `t` to 1, then film the composed
   * frame.
   */
  setups.roast = async () => {
    const ok = await page.evaluate(() => window.__roast?.enter?.() ?? false);
    if (!ok) throw new Error('no roasting stick to sit at');
    // Widen the lens, and only the lens.
    //
    // POSE.fov is 24 — an authored macro, and correct on the screen it was
    // authored for. But three.js fov is VERTICAL: 24 deg vertical is a 41 deg
    // HORIZONTAL view at 16:9 and a 13.6 deg one at 9:16, so the portrait frame
    // is not the composition the author struck, it is a narrow crop out of the
    // middle of it, and what it crops to is the fire's bloom column with the
    // marshmallow pushed into a corner. 46 restores about 26 deg horizontal.
    // The seat, the aim and the hold are the author's and are not touched.
    // 34, not 46 and not the authored 24. At 24 the 9:16 crop is 13.6 deg of
    // horizontal view and the frame is the fire's bloom column with the
    // marshmallow in a corner; at 46 the whole fireside fits and the
    // marshmallow is a speck. 34 is the one that holds both.
    await page.evaluate(() => window.__roast.pose({ fov: 34 }));
    for (let i = 0; i < FPS * 3 && await page.evaluate(
      () => (window.__roast.state()?.t ?? 1) < 0.999); i++) await step();
    await grant(Math.round(FPS * 0.3));
    return { entered: true };
  };

  /** Vista: the shared anchor posing every other capture tool uses. */
  setups.vista = async () => {
    await page.evaluate(() => { window.__roast?.leave?.(); }).catch(() => {});
    // Flag-driven because this is the one beat whose framing is pure taste and
    // the only way to settle taste is to look at three of them. `index` picks a
    // different vista POI: index 0 on this seed stands at 356 m, well above the
    // treeline, and films grey rock — true to the world and the wrong last word
    // for a game whose signature is gold meadow under orange canopy.
    const v = {
      anchor: 'vista', dist: 150, standOff: 0,
      index:  parseInt(arg('vista-index', '1'), 10),
      height: parseFloat(arg('vista-height', '30')),
      pitch:  parseFloat(arg('vista-pitch', '-0.06')),
      fov:    parseFloat(arg('vista-fov', '62')),
    };
    const pose = await page.evaluate(
      new Function('P', POSE_SRC), { v, frozen: null, dynamic: [] });
    await settle(2.2);
    await page.evaluate((p) => { window.__tVista = p; }, pose);
    console.log(`[trailer]   vista (${pose.x.toFixed(0)}, ${pose.z.toFixed(0)}) yaw ${pose.yaw.toFixed(2)}`);
    return pose;
  };

  // ── per-frame cameras, for the beats this tool poses ──────────────────────
  const cameras = {
    drive: (u) => page.evaluate((k) => {
      const v = window.__systems.vehicle, e = window.__engine, wd = window.__world;
      const yaw = v.heading ?? 0;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      // A hook is texture then scale: start low and close enough that the grass
      // is rushing past, ease back and up into the valley behind it.
      const s = k * k * (3 - 2 * k);
      // Three-quarter rear, not dead astern. Straight behind, a camper is a
      // rectangle with two tail lights; a couple of metres off the axis shows
      // the flank and the wheels and reads as a vehicle in half the time.
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const d = 5.6 + 4.2 * s, lat = 1.15 + 1.45 * s, h = 1.35 + 1.25 * s;
      const px = v.position.x - fx * d + rx * lat;
      const pz = v.position.z - fz * d + rz * lat;
      const gy = wd.getHeight(px, pz) + 1.15;
      e.camera.position.set(px, Math.max(gy, v.position.y + h), pz);
      // Aim near the camper with a short lead, not 5 m up the road: a distant
      // aim point in 9:16 pushes the subject into the bottom third and hands
      // the top half of the frame to empty sky.
      e.camera.lookAt(v.position.x + fx * 2.0, v.position.y + 1.05, v.position.z + fz * 2.0);
    }, u),
    photo: (u) => page.evaluate((k) => {
      const e = window.__engine, wd = window.__world;
      const s = window.__tSubject, az = window.__tAz;
      // A slow push-in on the animal. The viewfinder is the frame; the move is
      // what makes it read as photographing rather than as a still.
      const R = 9.8 - 1.6 * (k * k * (3 - 2 * k));
      const px = s.x + Math.sin(az) * R, pz = s.z + Math.cos(az) * R;
      e.camera.position.set(px, wd.getHeight(px, pz) + 1.55, pz);
      e.camera.lookAt(s.x, wd.getHeight(s.x, s.z) + 0.95, s.z);
    }, u),
    camp: (u) => orbitCam(u),
    ridge: (u) => orbitCam(u),
  };

  /** The orbit both camp beats fly. `__tOrbit` is written by `surveyOrbit`. */
  const orbitCam = (u) => page.evaluate((k) => {
      const o = window.__tOrbit, e = window.__engine, wd = window.__world;
      const s = k * k * (3 - 2 * k);
      // Smoothstep the push-in: a linear dolly reads as a jump cut at both ends.
      const R = o.r0 + (o.r1 - o.r0) * s;
      const az = o.az0 + k * o.sweep;
      const x = o.cx + Math.sin(az) * R, z = o.cz + Math.cos(az) * R;
      // Near eye level. A camp seen from above is the artifact this project
      // already keeps a note about, and the ground between lens and fire is
      // dead frame in 9:16.
      e.camera.position.set(x, wd.getHeight(x, z) + 1.9 + R * 0.055 + (o.lift ?? 0), z);
      e.camera.lookAt(o.lx, wd.getHeight(o.lx, o.lz) + 1.5 + (o.lift ?? 0), o.lz);
    }, u);
    vista: (u) => page.evaluate((k) => {
      const p = window.__tVista, e = window.__engine, wd = window.__world;
      // A slow lateral drift with a touch of rise. Nothing in a vista moves, so
      // the camera has to, or the beat reads as a freeze frame at the end of a
      // cut that has been moving for thirteen seconds.
      const s = k * k * (3 - 2 * k);
      const side = (s - 0.5) * 16.0;
      const x = p.x + Math.cos(p.yaw) * side, z = p.z - Math.sin(p.yaw) * side;
      e.camera.position.set(x, p.y + s * 2.4, z);
      e.camera.lookAt(x + Math.sin(p.yaw) * 150, p.y + s * 2.4 - 19.5, z + Math.cos(p.yaw) * 150);
    }, u),
  };

  /** Per-frame world driving that has to happen on the granted clock. */
  const drivers = {
    kayak: () => page.evaluate(() => {
      const w = window.__world, st = window.__boat?.state?.().boats?.[0];
      if (!st) return;
      // Steer to the current every frame, the way an attentive paddler does.
      // Without a steering term the boat runs dead straight out of the first
      // bend and the shot stops being a picture of a river.
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
    }),
  };

  // ── film ──────────────────────────────────────────────────────────────────
  const wanted = ONLY ? String(ONLY).split(',') : null;
  const list = BEATS.filter((b) => !wanted || wanted.includes(b.name));
  let f = 0;
  const t0 = Date.now();
  const report = [];
  const taken = [];        // POI indices already spent, so two beats never share one

  for (const beat of list) {
    console.log(`[trailer] beat ${beat.name} — ${beat.secs}s @ hour ${beat.hour}`);
    await page.evaluate(({ hour, fov, pose }) => {
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;    // the sun must not drift mid-beat
      window.__tFov = fov;
      window.__forceCamera = !!pose;
    }, beat);

    let info = null;
    try {
      info = await setups[beat.name](taken);
      if (Number.isFinite(info?.i)) taken.push(info.i);
    } catch (e) {
      console.warn(`[trailer] beat ${beat.name} FAILED to set up: ${e.message}`);
      report.push({ beat: beat.name, error: e.message });
      continue;
    }
    // A setup may have handed the camera to a view (roast, kayak, bike) or
    // taken it back; re-assert this beat's answer after it has run.
    await page.evaluate(({ fov, pose }) => {
      window.__tFov = fov;
      window.__forceCamera = !!pose;
    }, beat);

    // A still has to be taken at the same point in the beat the eye will judge
    // it at, which means RUNNING the beat and photographing the end of it — not
    // photographing frame one. The camp beat is the proof: `pitchNear` builds
    // over RAISE_TIME with the queue draining one prop per frame, so the
    // single-frame still was a correctly-composed orbit around a clearing where
    // a camp had not appeared yet, and read as a framing bug that was not one.
    const full = Math.round(beat.secs * FPS);
    const n = STILLS ? Math.max(1, Math.round(full * 0.6)) : full;
    for (let i = 0; i < n; i++) {
      const u = full > 1 ? i / (full - 1) : 0;
      if (drivers[beat.name]) await drivers[beat.name]();
      if (cameras[beat.name]) await cameras[beat.name](u);
      await step();
      if (STILLS && i < n - 1) continue;
      const name = STILLS ? `${TMP}/${beat.name}.${EXT}`
                          : `${TMP}/f${String(f).padStart(5, '0')}.${EXT}`;
      await page.screenshot({
        path: name, animations: 'disabled',
        ...(EXT === 'jpg' ? { type: 'jpeg', quality: 96 } : {}),
      });
      f++;
      if (!STILLS && f % 60 === 0) {
        const el = (Date.now() - t0) / 1000, rate = f / el;
        console.log(`[trailer]   f${f}  ${rate.toFixed(2)} fps capture`);
      }
    }
    report.push({ beat: beat.name, frames: n, info });
    // Stop driving anything before the next beat sets up.
    for (const c of held) await page.keyboard.up(c);
    held.clear();
    await page.evaluate(() => { window.__bike?.drive?.(null); window.__boat?.drive?.(null); });
  }

  if (errors.length) console.warn(`[trailer] ${errors.length} page error(s): ${errors[0]}`);
  writeFileSync(TRACE, JSON.stringify({ seed: SEED, fps: FPS, beats: report }, null, 1));
  await browser.close();
  release();

  if (STILLS) { console.log(`[trailer] stills in ${TMP}`); return; }

  // yuv420p and +faststart because everything downstream wants both; the rate
  // cap because this world is high-frequency detail in almost every frame and
  // an uncapped crf 16 encoded 10 s to 80 MB, which no upload pipeline keeps.
  const vf = SS > 1 ? `scale=${W}:${H}:flags=lanczos` : 'null';
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-i', `${TMP}/f%05d.${EXT}`,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
    '-maxrate', '24M', '-bufsize', '48M',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    OUT,
  ], { stdio: 'inherit' });
  if (!has('keep-frames')) rmSync(TMP, { recursive: true, force: true });
  console.log(`[trailer] wrote ${OUT} (${f} frames, ${(f / FPS).toFixed(2)}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

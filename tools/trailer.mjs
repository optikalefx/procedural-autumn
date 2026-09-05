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
// Authored one-off shots live one-per-file under tools/shots/ so a later clip
// can read how an earlier one was done. They are registered ONLY when --only
// names them, so adding a shot never changes the length of the standard cut.
import { makeCliffShot } from './clips/cliff.mjs';
import { makeMooseShot } from './clips/moose.mjs';

const SHOT_MODULES = { cliff: makeCliffShot, moose: makeMooseShot };

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
// Per-clip length override. The marketing backlog specifies a duration per row
// ("`ridge` 10 s", "`drive` 60 s") and those are single-beat clips, so the
// BEATS table's own `secs` — tuned for the eight-beat trailer — is the wrong
// number for them. Applies to every beat rendered, so use it with `--only`.
const SECS   = arg('secs', null) ? parseFloat(String(arg('secs'))) : null;
// A cozy loop gets replayed, so it should return to where it started. Makes the
// orbit a there-and-back — sin on the bearing, raised cosine on the radius — so
// the last frame lands on the first and there is no seam.
const LOOP   = has('loop');
// `--hour-ramp "12,25.5"` — start and end hour for a time-lapse beat. The end
// may exceed 24 so a ramp can cross midnight monotonically.
const HOUR_RAMP = arg('hour-ramp', null)
  ? String(arg('hour-ramp')).split(',').map(Number)
  : null;
const HOUR_RAMP_BEAT = String(arg('hour-ramp-beat', 'campwide'));
// `--at "x,z"` or `--at "x,z,heading"` pins a clip to a spot somebody found by
// PLAYING, instead of searching for one. The search beats (meadow rehearsal,
// bluff plateau scan) are there because a tool cannot see a good place; when a
// human has already stood somewhere and said "here", the search is only a way
// to end up somewhere else.
const AT = arg('at', null)
  ? String(arg('at')).split(',').map(Number)
  : null;
// Per-beat overrides: `--beat-secs camp=3,roast=2.2` and `--beat-hours camp=21.6`.
// The backlog specifies clips as "`drive` 2 s -> `camp` 4 s hold, hour 17.6",
// which `--secs` (one length for every beat) cannot express.
const kv = (spec) => Object.fromEntries(String(spec || '').split(',').filter(Boolean)
  .map((pair) => { const [k, v] = pair.split('='); return [k.trim(), parseFloat(v)]; }));
const BEAT_SECS  = kv(arg('beat-secs', ''));
const BEAT_HOURS = kv(arg('beat-hours', ''));
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
  { name: 'ridge', secs: 2.6, hour: 21.6, fov: 70, pose: true  },
  // Second, not first. The drive is the game's core verb — its own subtitle
  // says "a cozy drive" — and a trailer that never shows the camper moving is
  // arguing with the box copy. It is a poor HOOK, though, for the reason above:
  // a vehicle receding from a camera that is itself pulling back shrinks from
  // both ends. Behind the night camp it plays as morning: you wake up and go.
  { name: 'drive', secs: 1.9, hour: 8.2,  fov: 70, pose: true  },
  { name: 'kayak', secs: 1.7, hour: 15.0, fov: 70, pose: false },
  { name: 'bike',  secs: 1.5, hour: 16.0, fov: 70, pose: false },
  { name: 'photo', secs: 1.5, hour: 16.8, fov: 62, pose: true  },
  // The raise is RAISE_TIME 1.15 s and the build queue drains one prop per
  // frame, so a two-second camp beat is all raise and no camp. 2.4 leaves most
  // of a second of finished camp to land on.
  { name: 'camp',  secs: 2.2, hour: 17.6, fov: 70, pose: true  },
  { name: 'roast', secs: 1.7, hour: 20.4, fov: null, pose: false },
  // 19.8 filmed the massif as black cut-outs against lavender — atmospheric,
  // and the wrong last word for a game whose brief opens with "cozy".
  { name: 'vista', secs: 1.9, hour: 17.6, fov: 58, pose: true  },
  // `optional` beats are never in the default cut — they exist for the clips in
  // marketing/video-ideas.md and only render when `--only` names them.
  // `campwide` reuses the camp the `camp` beat already pitched rather than
  // pitching its own, so the two are the same place from two distances.
  { name: 'campwide', secs: 4.8, hour: 21.6, fov: 70, pose: true, optional: true },
  { name: 'firelight', secs: 3.0, hour: 21.6, fov: 70, pose: true, optional: true },
  { name: 'scope', secs: 3.5, hour: 22.0, fov: null, pose: false, optional: true },
  { name: 'scopeprop', secs: 2.2, hour: 22.0, fov: 70, pose: true, optional: true },
  { name: 'skylook', secs: 3.0, hour: 2.0, fov: 70, pose: true, optional: true },
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

  // QUALITY TIER, and it is a FLAG rather than a constant because it was
  // hardcoded to `high` for a long time without anybody deciding that.
  //
  // A plain load on this machine picks `ultra` — pixelRatioCap 2 against high's
  // 1.35, 4 shadow cascades against 3, full grass and tree density — so the
  // capture had quietly been shipping a lower preset than a player sees. Worth
  // knowing; not worth paying for. Measured on the seed-5 camp clip, ultra
  // captures at ~0.55 fps against high's ~0.67, about 20% more wall clock for a
  // difference nobody watching a 9:16 phone video will find. Sean's call
  // (2026-09-03): stay on `high`, and pass `--quality ultra` for a still or a
  // hero frame where the shadows and the grass density actually get looked at.
  const QUALITY = String(arg('quality', 'high'));
  const url = `${BASE}/?seed=${SEED}&car=${CAR}&quality=${QUALITY}&pixelratio=native&iscale=1`;
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
      '.pa-roast-result, .pa-scope-tip { display: none !important; }';
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
  const surveyOrbit = ({ cx, cz, r0 = 9.5, r1 = 7.0, sweep = 0.40, lift = 0, margin = 3.0,
                        bias = null }) =>
    page.evaluate(({ cx, cz, R0, R1, SWEEP, LIFT, MARGIN, BIAS }) => {
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
      // `BIAS` pins the aim instead of deriving it. The derived value leans the
      // look-at toward the camper by up to a fifth of the orbit radius, which
      // is right for a wide shot holding both — and wrong for a move that has
      // to ARRIVE somewhere: at a 5.5 m finish a 2.6 m offset puts the fire off
      // centre exactly when it should be the subject.
      const bias = BIAS === null ? Math.min(0.20 * R0, 0.25 * sep) : BIAS;
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

      /**
       * Does the LANDFORM stand between the camera and the camp?
       *
       * The raycast below cannot answer this and reported 72/72 bearings clear
       * for a ridge camp whose every frame was two thirds hillside — the same
       * shape of failure as "a raycast cannot see a river". It tests OBJECTS:
       * trunks, rocks, tents. A hill is not an object in its path, it is the
       * ground, and on flat valley floor the ground is never in the way so the
       * omission never showed until a camp went up at 245 m.
       *
       * `getHeight` answers it directly and needs no scene and no streaming:
       * walk the segment from eye to aim and compare the terrain under each
       * sample against the straight line's own height there.
       */
      const brow = (rr, ax) => {
        const px = cx + Math.sin(ax) * rr, pz = cz + Math.cos(ax) * rr;
        const ey = camY(rr, ax);
        const ty = wd.getHeight(lx, lz) + 1.2 + LIFT;
        let worst = 0;
        for (let t = 0.06; t < 0.97; t += 0.045) {
          const sx = px + (lx - px) * t, sz = pz + (lz - pz) * t;
          const line = ey + (ty - ey) * t;
          worst = Math.max(worst, wd.getHeight(sx, sz) - line);
        }
        return worst;
      };
      // Terrain first — it is cheap, and a bearing the hillside owns is not
      // worth raycasting. Weighted at 3 per end so a buried bearing scores as
      // badly as a fully obstructed one.
      const buried = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        const ax = i * STEP;
        for (const rr of [R0, R1]) if (brow(rr, ax) > 0.3) buried[i] += 3;
      }
      for (let i = 0; i < N; i++) {
        const ax = i * STEP;
        blocked[i] += buried[i];
        if (buried[i] >= 6) continue;          // the ground has it; skip the rays
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
            // MARGIN is how much nearer than the subject a hit has to be to
            // count as blocking. 3 m is right for a 9-11 m standing orbit and
            // far too permissive at 6 m: a cooler two metres off the lens sat
            // at 4.2 m, the test wanted under 3.2, and the hook was filmed
            // through a cool box. Scale it with the radius.
            if (hits.length && hits[0].distance < rr - MARGIN) blocked[i]++;
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
      return { clear: blocked.filter((b) => b === 0).length, cost: +bestCost.toFixed(2),
               buriedArc: buried.filter((b) => b > 0).length };
    }, { cx, cz, R0: r0, R1: r1, SWEEP: sweep, LIFT: lift, MARGIN: margin, BIAS: bias });

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

  /**
   * THE HOOK — a night camp on high ground, with the dog in it.
   *
   * Three things have to be true at once and each is its own small fight:
   *
   *  · **High ground that a camp will still accept.** `poi.best('vista')` is
   *    scored as "near ground falls away, far ground rises", which is the
   *    definition of a ridge, and is also ground `pitchNear` may refuse as too
   *    steep. So walk the vista list, prefer altitude, and let `pitchNear`
   *    itself be the gate — it knows what a camp can stand on and no proxy for
   *    it here would.
   *
   *  · **The camp already up.** `instant: true`, unlike the camp beat later in
   *    the cut. This is the first two and a half seconds of the video; a camp
   *    assembling itself is a payoff and payoffs do not belong in a hook.
   *
   *  · **The dog, which is an 80% roll.** `hasDog` is set on the record
   *    `pitchNear` returns and the dog is constructed a frame or two later
   *    (Camp.js builds it in its own update), so this waits on the dog existing
   *    rather than assuming it. `dogvideo.mjs` found this first and its comment
   *    says the same thing: a harness must never spend a page load recording
   *    the other 20%.
   */
  setups.ridge = async () => {
    // `--ridge-allow-compact` takes whatever the world offers; without it a
    // bluff that cannot hold a full camp is skipped.
    const FULL_OK = has('ridge-allow-compact');
    // Found and pitched already? Re-use it. A clip that cuts between two
    // distances of the same fire has to be the SAME fire, and re-running the
    // search would pitch a second camp somewhere else entirely.
    if (world.ridge) {
      await page.evaluate(() => { window.__roast?.leave?.(); });
      await grant(Math.round(FPS * 0.3));
      return world.ridge;
    }
    const cands = await page.evaluate(({ MAX_SLOPE, MIN_Y, MAX_Y, MIN_DROP, FLAT_SPREAD, STEP }) => {
      const w = window.__world;
      // SCAN THE WORLD, do not ask the POI list.
      //
      // The POI tables hold about a dozen entries per kind in a 2400 m world,
      // and on seed 20261018 not one of them is the landform this shot needs:
      // every `vista` that has a real drop sits at 188-291 m, which is at or
      // above the altitude where `Trees.js` fades the canopy out
      // (`smoothstep(196, 258, h)`), so it is bare rock; every `meadow` low
      // enough to be forested is on the valley floor with nothing to look down
      // into. A bluff is a specific SHAPE — flat enough to camp, low enough to
      // have trees, with the ground falling away hard on one side — and the
      // honest way to find a shape is to look for it, which is what
      // kayakshot.mjs does for a paddleable reach.
      //
      // Two stages, because the drop test is the expensive one: sweep the grid
      // for flat ground in the right altitude band, then measure the fall line
      // only where a camp could actually stand.
      const flat = [];
      for (let x = -1150; x <= 1150; x += STEP) {
        for (let z = -1150; z <= 1150; z += STEP) {
          if (!w.isInBounds(x, z)) continue;
          const y = w.getHeight(x, z);
          if (y < MIN_Y || y > MAX_Y) continue;
          // A PLATEAU, not one flat sample. `pitchNear` needs room for a full
          // camp — tent, fire, chairs, cooler, log pile and the roasting stick
          // the marshmallow shot depends on — and the first version tested a
          // single ring at 10 m, passed a shelf, and got a 2-prop compact camp
          // with no stick on it at radius 30. Sample three rings and take the
          // WORST, plus the height spread across the disc.
          let sl = 0, n = 0, lo = y, hi = y;
          for (const r of [6, 12, 18]) {
            for (let a = 0; a < 12; a++) {
              const px = x + Math.cos(a * 0.524) * r, pz = z + Math.sin(a * 0.524) * r;
              sl += w.getSlope(px, pz); n++;
              const h = w.getHeight(px, pz);
              lo = Math.min(lo, h); hi = Math.max(hi, h);
            }
          }
          if (sl / n < MAX_SLOPE && hi - lo < FLAT_SPREAD) {
            flat.push({ x, z, y, slope: sl / n, spread: hi - lo });
          }
        }
      }
      const out = [];
      for (const c of flat) {
        let drop = 0, viewAz = 0;
        for (let a = 0; a < 16; a++) {
          const ang = a * (Math.PI / 8);
          let lo = c.y;
          for (let d = 25; d <= 160; d += 18) {
            lo = Math.min(lo, w.getHeight(c.x + Math.sin(ang) * d, c.z + Math.cos(ang) * d));
          }
          if (c.y - lo > drop) { drop = c.y - lo; viewAz = ang; }
        }
        if (drop > MIN_DROP) out.push({ ...c, drop, viewAz, kind: 'bluff', i: out.length });
      }
      // Deepest valley behind the camp wins, but keep them spread out — twenty
      // samples off one plateau are one location, and if its camp fails they
      // all fail together.
      out.sort((a, b) => b.drop - a.drop);
      const spread = [];
      for (const c of out) {
        if (spread.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 120)) spread.push(c);
        if (spread.length >= 8) break;
      }
      return spread;
    }, { MAX_SLOPE: parseFloat(arg('ridge-slope', '0.25')),
         MIN_Y: parseFloat(arg('ridge-min-y', '40')),
         MAX_Y: parseFloat(arg('ridge-max-y', '190')),
         MIN_DROP: parseFloat(arg('ridge-drop', '55')),
         // Metres of height variation allowed across a 36 m disc. This is what
         // separates "a flat spot on a slope" from "a plateau you can put a
         // whole camp on".
         FLAT_SPREAD: parseFloat(arg('ridge-flat', '3.5')),
         STEP: parseFloat(arg('ridge-step', '24')) });
    console.log(`[trailer]   ${cands.length} bluff candidate(s)` +
                (cands.length ? `, best drop ${cands[0].drop.toFixed(0)}m at ` +
                                `y+${cands[0].y.toFixed(0)}m` : ''));
    if (!cands.length) throw new Error('no forested bluff — try --ridge-max-y or --seed');

    for (const c of cands) {
      await page.evaluate((q) => {
        window.__camp?.strike?.();
        window.__vehicleTeleport?.(q.x, q.z, q.yaw ?? 0.9);
      }, c);
      await settle(2.0);
      // Park brake before the camp goes up: at night the headlights flood the
      // camp from 8-18 m away and latching the brake is what dips them.
      await hold('Space', true);
      await grant(Math.round(FPS * 0.8));
      await hold('Space', false);
      const camp = await page.evaluate(() => {
        const v = window.__systems.vehicle;
        // Prefer a FULL camp. A compact site is three props and may not include
        // the roasting stick, and `__roast.enter()` finds its fire by looking
        // for a camp that has one — so a compact ridge camp makes a marshmallow
        // shot at this location impossible. Probe wide first, keep the best.
        let best = null;
        for (const r of [30, 24, 18, 14]) {
          const c = window.__camp.pitchNear(v.position.x, v.position.z,
            { instant: true, radius: r });
          if (!c) continue;
          if (!c.small) { c.hasDog = true; return { x: +c.x.toFixed(1), z: +c.z.toFixed(1),
                                                    small: false, radius: r,
                                                    props: window.__camp.camps.at(-1)?.props?.length ?? 0 }; }
          if (!best) best = { c, r };
          window.__camp.strike();
        }
        if (!best) return null;
        const c = window.__camp.pitchNear(v.position.x, v.position.z,
          { instant: true, radius: best.r });
        if (!c) return null;
        c.hasDog = true;
        return { x: +c.x.toFixed(1), z: +c.z.toFixed(1), small: !!c.small, radius: best.r,
                 props: window.__camp.camps.at(-1)?.props?.length ?? 0 };
      });
      if (!camp) {
        console.log(`[trailer]   ${c.kind}[${c.i}] y+${c.y.toFixed(0)}m ` +
                    `slope ${c.slope.toFixed(2)}  no camp site — next`);
        continue;
      }
      // A compact camp is a REJECTED bluff, not a smaller one. Three props and
      // no roasting stick, which is what `__roast.enter()` looks for — so a
      // clip that cuts to a marshmallow cannot be filmed here. Walk on unless
      // this is the last candidate.
      if (camp.small && !FULL_OK) {
        console.log(`[trailer]   ${c.kind}[${c.i}] y+${c.y.toFixed(0)}m ` +
                    `compact (${camp.props} props) — next`);
        await page.evaluate(() => window.__camp?.strike?.());
        continue;
      }
      // Wait for the dog to be built rather than assuming it, then let it walk
      // a beat: a dog standing still on frame one is a prop, not an animal.
      let dog = false;
      for (let i = 0; i < FPS * 3; i++) {
        await step();
        if (await page.evaluate(() => !!window.__camp?.camps?.at(-1)?.dog)) { dog = true; break; }
      }
      await grant(Math.round(FPS * 1.2));
      // Not the shared orbit. That one circles a camp at eye level on the
      // bearing opposite the camper, which is right for a clearing on the
      // valley floor and wrong here: this shot's whole subject is the camp WITH
      // the valley behind it, so the camera has to stand on the uphill side and
      // look out THROUGH the camp along the fall line, slightly above it and
      // tilted down. The drop direction is the composition.
      const arc = await page.evaluate(({ cx, cz, viewAz, D, EYE, AIM, AIMY, SWEEP, SWING }) => {
        const wd = window.__world;
        const g = wd.getHeight(cx, cz);
        window.__tRidge = { cx, cz, g, camAz: viewAz + Math.PI, viewAz,
                            d0: D, d1: D - 1.6, eye: EYE, aim: AIM, aimY: AIMY, sweep: SWEEP,
                            swingDir: SWING };
        // How much valley is actually behind the camp along that line?
        let lo = g;
        for (let d = 20; d <= 160; d += 10) {
          lo = Math.min(lo, wd.getHeight(cx + Math.sin(viewAz) * d, cz + Math.cos(viewAz) * d));
        }
        return { viewDrop: +(g - lo).toFixed(0) };
      }, { cx: camp.x, cz: camp.z, viewAz: c.viewAz,
           // Aim NEAR the camp, not far down the fall line. Aiming 26 m out
           // flattened the tilt to 3.5 deg, and with the camp only 13 m away
           // and 3.4 m below the lens that put it at two thirds frame height
           // with the bottom third dead grass — in a 9:16 frame the cost of a
           // level axis is paid entirely in foreground. A short aim tilts the
           // camera down onto the camp and lets the 70 deg lens keep the valley
           // and the sky above it, which is where they belong.
           D: parseFloat(arg('ridge-dist', '12')), EYE: parseFloat(arg('ridge-eye', '3.4')),
           AIM: parseFloat(arg('ridge-aim', '5')), AIMY: parseFloat(arg('ridge-aimy', '1.3')),
           SWEEP: parseFloat(arg('ridge-sweep', '0.22')),
           SWING: parseFloat(arg('ridge-swing', '-1')) });
      console.log(`[trailer]   ${c.kind}[${c.i}] y+${c.y.toFixed(0)}m slope ${c.slope.toFixed(2)}` +
                  `  drop ${c.drop.toFixed(0)}m  camp (${camp.x}, ${camp.z})` +
                  `${camp.small ? ' [compact]' : ''} ${camp.props} props  dog ${dog ? 'yes' : 'NO'}` +
                  `  valley behind the camp ${arc.viewDrop}m`);
      if (!dog) console.warn('[trailer]   the dog never appeared — the hook is meant to have one');
      world.ridge = { ...camp, ...arc, dog, y: c.y, from: `${c.kind}[${c.i}]` };
      world.camp = { x: camp.x, z: camp.z };
      return world.ridge;
    }
    throw new Error('no high ground would take a camp');
  };

  /**
   * The hook for a fireside clip: close and low on the FIRE, not on the camp.
   *
   * The camp beat's fall-line camera aims past the site along the drop, which
   * is the right framing for a wide — it holds the tent, the bike, the valley
   * and the stars — and the wrong one for a first frame, because at this site
   * the fire ended up behind the tent and the hook had no fire in it at all.
   *
   * A camp's firepit is a prop with its own position, so orbit THAT: small
   * radius, and `lift` negative so the eye drops to roughly a sitting height
   * rather than the standing 1.9 m the orbit normally uses.
   */
  setups.firelight = async () => {
    // Whatever camp already exists. `camp` pitches one in a meadow and `ridge`
    // on a bluff; this beat frames whichever ran, so a clip can be all one
    // place. Only falls back to finding a bluff if nothing has pitched yet.
    if (!world.camp) await setups.ridge();
    const fire = await page.evaluate(() => {
      const c = window.__camp?.camps?.at(-1);
      const g = c?.fire?.group ?? c?.fire?.mesh ?? c?.fire;
      const pos = g?.position;
      if (pos && Number.isFinite(pos.x)) return { x: pos.x, z: pos.z, found: true };
      return { x: c?.x ?? 0, z: c?.z ?? 0, found: false };
    });
    if (!fire.found) {
      console.warn('[trailer]   no firepit position — orbiting the camp centre instead');
    }
    const arc = await surveyOrbit({
      cx: fire.x, cz: fire.z,
      // Standing height, not fire height. `lift: -0.6` drops the lens to a
      // sitting eye, which is lovely on an open bluff and puts a TENT between
      // camera and fire in a full meadow camp — a camp packs its props around
      // the fire, so at knee level something is always in front of it. The camp
      // beat's own orbit frames this same camp cleanly; match it.
      r0: parseFloat(arg('fire-r0', '9.5')), r1: parseFloat(arg('fire-r1', '7.6')),
      sweep: parseFloat(arg('fire-sweep', '0.24')), lift: parseFloat(arg('fire-lift', '0.2')),
      // 2.5, not 1.5: at the meadow camp a TENT sat between lens and fire and
      // the shot was a dark blob with a vehicle behind it. A tent is 2 m of
      // solid nothing and has to count as blocking from further out.
      margin: parseFloat(arg('fire-margin', '3.0')),
    });
    console.log(`[trailer]   firelight on (${fire.x.toFixed(1)}, ${fire.z.toFixed(1)})` +
                `  arc ${arc.clear}/72 clear, cost ${arc.cost}`);
    return { ...fire, ...arc };
  };

  /**
   * The telescope. Camp props carry `userData.telescope` and `ScopeView.enter`
   * takes the object itself, so this is the same shape as the roast beat: find
   * the prop in whatever camp is standing, step into the eyepiece, and let the
   * view pose its own camera. Nothing here composes the shot — the eyepiece is
   * the composition, and re-framing it would be showing the player something
   * they never see.
   */
  /**
   * The telescope as an OBJECT, before the eyepiece.
   *
   * Cutting straight to a circle of sky asks the viewer to work out what they
   * are looking through. This shot answers that first: push in on the tube
   * standing on the flank of the camp, with the camp behind it, and then cut
   * inside. The camera stands on the far side of the scope from the camp centre
   * so the camp reads BEHIND the instrument rather than the instrument floating
   * in a field.
   */
  setups.scopeprop = async () => {
    if (!world.camp && !world.ridge) await setups.camp();
    // LET GO OF THE FIRESIDE FIRST.
    //
    // This beat follows `roast`, and a roast view holds `CameraRig`'s takeover
    // — which outranks `__forceCamera`, so posing a camera here does nothing at
    // all while it is up. The symptom is not an error: the beat renders, the
    // frames are fine, and they are two more seconds of the marshmallow. It
    // shipped in a preview looking like the telescope shot had been dropped.
    // Exactly the failure the photo beat had with the bike still mounted.
    await page.evaluate(() => {
      window.__roast?.leave?.();
      window.__systems?.camp?.scope?.leave?.();
    });
    await grant(Math.round(FPS * 0.4));
    const found = await page.evaluate(() => {
      const THREE = window.__THREE;
      for (const camp of window.__camp?.camps ?? []) {
        for (const pr of camp.props ?? []) {
          if (!pr.obj?.userData?.telescope) continue;
          const w = pr.obj.getWorldPosition(new THREE.Vector3());
          return { x: w.x, y: w.y, z: w.z, cx: camp.x ?? w.x, cz: camp.z ?? w.z };
        }
      }
      return null;
    });
    if (!found) throw new Error('no telescope to push in on');
    await page.evaluate((t) => {
      const wd = window.__world;
      // Away from the camp centre, so the camp sits behind the tube.
      let dx = t.x - t.cx, dz = t.z - t.cz;
      const m = Math.hypot(dx, dz) || 1;
      dx /= m; dz /= m;
      // `fx/fz` is the fire — where the shot STARTS looking, before the aim
      // sweeps across to the tube.
      window.__tScopeProp = { x: t.x, y: t.y, z: t.z, dx, dz, g: wd.getHeight(t.x, t.z),
                              fx: t.cx, fz: t.cz };
    }, found);
    console.log(`[trailer]   telescope prop at (${found.x.toFixed(1)}, ${found.z.toFixed(1)})`);
    return found;
  };

  /**
   * The sky itself, from beside the camp, tilted up.
   *
   * Not the eyepiece. `camp_scope_view` renders a sparse field that does not
   * change between hour 1 and hour 2 even though `Lighting` ramps `milkyWay`
   * from 1.10 to 2.90 — so the band the sky HAS never reaches the circle. This
   * beat points an ordinary camera at the same sky instead, which is where the
   * stars actually are, and pans a little so they read as a field rather than
   * a photograph.
   */
  setups.skylook = async () => {
    if (!world.camp && !world.ridge) await setups.camp();
    const at = await page.evaluate(({ EL0, EL1, PAN, AIM }) => {
      const c = window.__camp?.camps?.[window.__camp.camps.length - 1];
      const L = window.__lighting;
      const md = L?.computeMoonDir ? L.computeMoonDir(L.hour) : L?.moonDir;
      const wd = window.__world;
      const x = c?.x ?? 0, z = c?.z ?? 0;
      window.__tSky = {
        x, z, g: wd.getHeight(x, z),
        // `--sky-aim moon` points AT it instead of away. The eyepiece will not
        // draw the moon or the galaxy sprites — verified against a normal
        // camera at the same direction and hour, which shows a crescent moon
        // and two galaxies where the scope shows bare stars — so a clip whose
        // premise is "point it at the moon" has to be filmed with a camera
        // rather than through the instrument.
        az: (AIM === 'moon' ? Math.atan2(md?.x ?? 0, md?.z ?? 1)
                            : (md ? Math.atan2(-md.x, -md.z) : 0)),
        el0: AIM === 'moon' && md ? Math.asin(md.y) - 0.12 : EL0,
        el1: AIM === 'moon' && md ? Math.asin(md.y) + 0.10 : EL1,
        pan: PAN,
        milky: +(L?.state?.milkyWay ?? L?.milkyWay ?? -1),
      };
      return window.__tSky;
    }, { EL0: parseFloat(arg('sky-el0', '0.30')), EL1: parseFloat(arg('sky-el1', '0.62')),
         PAN: parseFloat(arg('sky-pan', '0.40')),
         AIM: arg('sky-aim', null) ? String(arg('sky-aim')) : null });
    console.log(`[trailer]   skylook over the camp, milkyWay = ${at.milky}`);
    return at;
  };

  setups.scope = async () => {
    if (!world.camp && !world.ridge) await setups.camp();
    const ok = await page.evaluate(() => {
      window.__roast?.leave?.();
      const scope = window.__systems?.camp?.scope;
      if (!scope) return 'no scope view';
      for (const camp of window.__camp?.camps ?? []) {
        for (const pr of camp.props ?? []) {
          if (pr.obj?.userData?.telescope) { scope.enter(pr.obj); return true; }
        }
      }
      return 'no telescope in this camp';
    });
    if (ok !== true) throw new Error(String(ok));
    // Point it at the moon if there is one.
    //
    // A telescope aimed at empty sky is a black circle with four stars in it —
    // true to the instrument and a poor two seconds of video. `camp_scope_view`
    // keeps the bottom of its magnification range "for the moon, which IS worth
    // 6 degrees", so this is the shot the view was built for. `Lighting`
    // computes the moon's direction for any hour, so ask, and only re-aim when
    // it is actually above the horizon.
    // KEEP THE TUBE'S OWN AIM.
    //
    // Two earlier versions overrode `_aim` — first at the moon, then anti-moon
    // at 52 degrees — and both produced a sparse field, while simply walking up
    // to the scope in game and looking gives stars, planets and a galaxy. The
    // prop publishes `userData.telescope.aim` and `enter()` carries it into
    // world space precisely so this file never has to guess (camp_scope_view's
    // own header says so). Where the tube points is authored; pointing it
    // somewhere else is how you end up looking at an empty patch.
    //
    // So: read the aim it settled on, use that as the centre of the pan, and
    // only touch the magnification.
    const aimed = await page.evaluate(({ FOV, RANGE, RISE, AIM }) => {
      const scope = window.__systems?.camp?.scope;
      if (!scope) return null;
      // `--scope-aim x,y,z` overrides with a direction somebody found by
      // dragging in game. Everything this file guessed about where to point a
      // telescope — at the moon, anti-moon, at 52 degrees — was worse than the
      // tube's own aim, and the tube's own aim is worse than a person who
      // looked around. Paste `__systems.camp.scope._aim` and use it.
      // `--scope-aim moon` asks Lighting where the moon actually is. The shot
      // list names it that way because "point it at the moon" is the premise,
      // and the tube's authored aim is somewhere else entirely.
      if (AIM === 'moon') {
        const L = window.__lighting;
        const md = L?.computeMoonDir ? L.computeMoonDir(L.hour) : L?.moonDir;
        if (md) scope._aim.set(md.x, md.y, md.z).normalize();
      } else if (Array.isArray(AIM)) {
        scope._aim.set(AIM[0], AIM[1], AIM[2]).normalize();
      }
      const a = scope._aim;
      const az = Math.atan2(a.x, a.z);
      const el = Math.asin(Math.max(-1, Math.min(1, a.y)));
      scope.fov = scope.fovTarget = FOV;
      window.__tScopePan = { az, el, range: RANGE, rise: RISE };
      return { az: +az.toFixed(2), el: +(el * 180 / Math.PI).toFixed(1) };
      // DEFAULT 62, NOT 34.
      //
      // three.js fov is VERTICAL, and the eyepiece inherits that. FOV_MAX is 34,
      // which at a 16:9 window is about 57 degrees of sky ACROSS the circle —
      // and at 9:16 the same number is 19. Filming portrait at the view's own
      // maximum therefore shows a third of the sky a player sees, which is why
      // five separate theories about missing stars all came up empty: the
      // bright ones were simply outside the slice. 62 vertical restores roughly
      // the horizontal field the view was composed for. Same trap reel.mjs
      // documents for the chase camera, one file over.
    }, { FOV: parseFloat(arg('scope-fov', '62')),
         RANGE: parseFloat(arg('scope-pan', '0.75')),
         RISE: parseFloat(arg('scope-rise', '0.10')),
         AIM: arg('scope-aim', null)
           ? (String(arg('scope-aim')) === 'moon' ? 'moon'
              : String(arg('scope-aim')).split(',').map(Number))
           : null });
    console.log(`[trailer]   eyepiece on the tube's own aim: ` +
                `az ${aimed?.az}, ${aimed?.el} deg up, fov ${arg('scope-fov', '20')}`);
    // Let the step-in run rather than snapping: the move to the eyepiece is
    // part of what the beat shows.
    await grant(Math.round(FPS * 1.2));
    const st = await page.evaluate(() => !!window.__systems?.camp?.scope?.active);
    console.log(`[trailer]   telescope entered, view ${st ? 'active' : 'INACTIVE'}`);
    return { active: st };
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

  /**
   * Bike: park one on open ground, get on, and actually go somewhere.
   *
   * Four passes went into this and every wrong theory fit the evidence, so the
   * order they were eliminated in is worth keeping:
   *
   *  · **Still aboard the kayak.** `Bike.mount()` is guarded only by "is there
   *    a bike and am I already riding" and takes `controlsHeldBy`
   *    unconditionally, so mounting from the water succeeds and hands the
   *    camera to the saddle — the shot looks right and the boat is still the
   *    thing being paddled. Real, fixed, and NOT the cause.
   *  · **Nothing re-asserted the throttle.** `drive()` sets `_script` once; it
   *    is not a held key, and `Boat.exit()` can decline (a kayak mid-channel
   *    has no bank to step onto) leaving the pedals with the boat. Real, fixed,
   *    and not the cause either.
   *  · **The camp spawns its own bike**, and the ridge beat pitches a camp.
   *    Plausible, instrumented, and false: `had null` every time.
   *  · **The actual cause: the spawn point was against an obstacle, and the
   *    scrub penalty is per-STEP.** `_advance` refuses, `bike_physics` slides
   *    along the obstacle normal, the slide succeeds — so `blocked` stays FALSE
   *    — and `speed *= 0.90` is applied per step rather than per unit time. At
   *    60 fps that bleeds speed about two and a half times faster per second
   *    than at 24, so the SAME spawn rode away cleanly in a 24 fps look pass
   *    and sat still in the 60 fps delivery. Three renders were spent on a bug
   *    that only exists at delivery frame rate.
   *
   * The tell was `made === 0` while `speed` was 2.2 — the bike reporting a
   * speed it was not travelling at. So `made` is the acceptance test here, not
   * `speed`, and the heading is rehearsed rather than predicted, which is the
   * same rule the camper beat already carries.
   */
  setups.bike = async (taken = []) => {
    await page.evaluate(() => {
      window.__boat?.drive?.(null);
      window.__boat?.exit?.();
      const v = window.__systems?.vehicle;
      if (v) v.controlsHeldBy = null;
    });
    await grant(Math.round(FPS * 0.4));
    const spot = await page.evaluate((skip) => {
      const poi = window.__poi, w = window.__world;
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
    await page.evaluate(({ x, z }) => window.__vehicleTeleport?.(x, z, 0), spot);
    await settle(1.8);

    let start = null;
    const attempts = [];
    for (let rank = 0; rank < 8 && !start; rank++) {
      const cand = await page.evaluate(({ x, z, rank }) => {
        const w = window.__world;
        // Rank headings by the flattest 70 m run out of the clearing, then walk
        // that ranking one at a time.
        const scored = [];
        for (let a = 0; a < 16; a++) {
          const ang = a * (Math.PI / 8);
          let lo = Infinity, hi = -Infinity;
          for (let d = 0; d <= 70; d += 7) {
            const h = w.getHeight(x + Math.sin(ang) * d, z + Math.cos(ang) * d);
            lo = Math.min(lo, h); hi = Math.max(hi, h);
          }
          scored.push({ ang, run: hi - lo });
        }
        scored.sort((p, q) => p.run - q.run);
        const az = scored[Math.min(rank, scored.length - 1)].ang;
        // Eight metres down the chosen run, pointing away — the camper is about
        // five long and parking beside it boxes the bike in.
        const bx = x + Math.sin(az) * 8, bz = z + Math.cos(az) * 8;
        if (window.__bike.state().riding) window.__bike.dismount();
        window.__tBike = { tx: x + Math.sin(az) * 90, tz: z + Math.cos(az) * 90 };
        window.__bike.parkAt(bx, bz, { yaw: az });
        window.__bike.mount();
        return { az: +az.toFixed(2), riding: !!window.__bike.state().riding };
      }, { x: spot.x, z: spot.z, rank });
      if (!cand.riding) continue;
      // Measure DISPLACEMENT, not `made`.
      //
      // `bike_physics` publishes a `made` field documented as ground covered
      // per second, and it reads 0 on every heading including ones genuinely
      // travelling at 3.9 m/s — so it cannot be used as an acceptance test.
      // Sampling the position either side of a real pedal cannot be wrong
      // about this, and it is two lines.
      const p0 = await page.evaluate(() => {
        const b = window.__bike.state().bike; return b ? [b.x, b.z] : null;
      });
      for (let i = 0; i < Math.round(FPS * 1.0); i++) { await drivers.bike(); await step(); }
      const m = await page.evaluate((p) => {
        const b = window.__bike.state().bike;
        if (!b) return null;
        return { speed: +Math.abs(b.speed).toFixed(2),
                 moved: +Math.hypot(b.x - p[0], b.z - p[1]).toFixed(2) };
      }, p0);
      attempts.push(`${cand.az}rad ${m?.speed}m/s moved ${m?.moved}m`);
      // Ground actually covered in a second of pedalling. A bike scrubbing a
      // boulder reports a speed it is not travelling at, and `blocked` stays
      // false while it happens.
      if ((m?.moved ?? 0) > 1.5 && (m?.speed ?? 0) > 1.5) start = { ...cand, ...m };
    }
    if (!start) {
      console.warn(`[trailer]   no clear run: ${attempts.join(' | ')}`);
      throw new Error('the bike cannot get out of this meadow');
    }
    console.log(`[trailer]   bike rehearsal: ${attempts.join(' | ')}`);

    // Finish accelerating on the heading that proved out.
    for (let i = 0; i < Math.round(FPS * 1.5); i++) { await drivers.bike(); await step(); }
    const st = await page.evaluate(() => {
      const b = window.__bike.state().bike;
      if (!b) return null;
      return { speed: +Math.abs(b.speed ?? 0).toFixed(2), made: +(b.made ?? 0).toFixed(2),
               blocked: !!b.blocked, effort: +(b.effort ?? 0).toFixed(2), wading: !!b.wading,
               held: window.__systems?.vehicle?.controlsHeldBy ?? null,
               afloat: !!window.__boat?.state?.().active };
    });
    const sp = st?.speed ?? 0;
    console.log(`[trailer]   bike meadow[${spot.i}] (${spot.x.toFixed(0)}, ${spot.z.toFixed(0)})` +
                `  heading ${start.az} rad  speed ${sp} m/s  made ${st?.made}` +
                `  blocked ${st?.blocked}  pedals held by ${st?.held}` +
                `${st?.afloat ? '  STILL AFLOAT' : ''}${st?.wading ? '  WADING' : ''}`);
    // NB: `made` is printed above for the record and is always 0 — do not gate
    // on it. The rehearsal above already proved displacement; this is a floor
    // on the speed the beat is filmed at.
    if (sp < 1.5) {
      console.warn('[trailer]   this beat will look PARKED.');
    }
    return { ...spot, ...st };
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
    // Hand the camera back BEFORE composing anything.
    //
    // This beat poses its own camera and then asks `debugSpawn` for an animal
    // in front of it — and `debugSpawn` reads `cam.position`. The bike beat
    // runs immediately before and leaves the bike MOUNTED, and a mounted
    // rideable holds `CameraRig`'s takeover, which outranks `__forceCamera`:
    // the pose written here was overwritten by the saddle on the next frame, so
    // the spawn searched wherever the bike had ridden to and came back null.
    // The whole beat was dropped from the cut — 810 frames instead of 900 —
    // and the only reason it was noticed is that the frame count did not match.
    await page.evaluate(() => {
      window.__bike?.drive?.(null);
      window.__bike?.dismount?.();
      window.__boat?.drive?.(null);
      window.__boat?.exit?.();
      const v = window.__systems?.vehicle;
      if (v) v.controlsHeldBy = null;
    });
    await grant(Math.round(FPS * 0.5));
    const at = await page.evaluate((pin) => {
      // `--at` wins. The meadow anchor is a guess at open ground and on seed 5
      // it lands inside dense autumn woods — a moose spawned there is behind
      // three trunks and the shot has no subject. A spot somebody stood on
      // beats an anchor scored for something else.
      if (pin) return { x: pin[0], z: pin[1], yaw: pin[2] ?? 0, pinned: true };
      const a = window.__anchorAt('meadow', 1) ?? window.__cameraAnchors.meadow();   // spent below
      window.__vehicleTeleport?.(a.x, a.z, a.yaw ?? 0);
      return a;
    }, AT);
    if (at.pinned) await page.evaluate((a) => window.__vehicleTeleport?.(a.x, a.z, a.yaw), at);
    await settle(2.0);
    let shot = await page.evaluate(({ species, a, DIST, ST }) => {
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
      // Try a LIST, and say what happened.
      //
      // `debugSpawn` returns a bare null for several different reasons — the
      // species has no SLEEPING site left (every one already streamed in and
      // live), or `_activate` refused — and one null taught nothing. The photo
      // beat died on `deer` mid-sequence while working in isolation, and the
      // whole beat was silently dropped from the cut. So walk the fallbacks and
      // report the roll call; a trailer wants a photogenic animal, not
      // specifically a deer.
      const tried = [];
      const S = wl.sites, ki = wl.keys.indexOf(String(species));
      let live = 0, asleep = 0;
      for (let i = 0; i < S.n; i++) {
        if (S.spec[i] !== ki) continue;
        if (S.live[i]) live++; else asleep++;
      }
      // Ordered by whether the animal READS at eight metres in knee-high
      // meadow grass, not by preference. The first fallback list was
      // fox-first and filmed a fox: correct, spawned, in frame, and about
      // fifteen pixels of ear above the grass. A deer stands above the sward
      // and a rabbit never will, so big-bodied species come first and the
      // camera closes in for the small ones (see SMALL below).
      for (const k of [species, 'bear', 'ram', 'goat', 'raccoon', 'fox', 'rabbit']) {
        if (tried.includes(k)) continue;
        // `--photo-state 6` is WATCH: animal_brain.js describes it as the
        // animal stopping feeding, swinging broadside, watching you and
        // drifting a few steps across your line — "the only one of the six
        // that is here for the player's eyes rather than the animal's". That
        // is both the motion a static spawn lacks and the beat the card names.
        const sp = ST === null ? wl.debugSpawn(k, { dist: DIST, clear: 9 })
                               : wl.debugSpawn(k, { dist: DIST, clear: 9, state: ST });
        tried.push(k);
        if (sp) return { x: sp.x, y: sp.y, z: sp.z, n: sp.n, species: k, tried };
      }
      return { failed: true, tried, firstChoice: String(species), live, asleep };
    }, { species: String(arg('species', 'deer')), a: at,
         DIST: parseFloat(arg('photo-dist', '14')) ,
         ST: arg('photo-state', null) === null ? null : parseInt(arg('photo-state'), 10) });
    if (shot?.failed) {
      console.warn(`[trailer]   nothing would spawn. tried ${shot.tried.join(', ')}; ` +
                   `${shot.firstChoice} sites: ${shot.live} live, ${shot.asleep} asleep`);
    } else if (shot) {
      console.log(`[trailer]   ${shot.species} x${shot.n}` +
                  (shot.tried.length > 1 ? ` (after ${shot.tried.slice(0, -1).join(', ')})` : ''));
    }
    if (shot?.failed) shot = null;
    // Spend the meadow so the camp beat does not pitch a tent in the clearing
    // this one just photographed a deer in. Two beats of one clearing is one
    // location pretending to be two, and on the first pass it was exactly that.
    if (shot) shot.i = 1;
    if (!shot) throw new Error('wildlife would not spawn — is a rideable still ' +
      'holding the camera rig? `debugSpawn` searches out from `cam.position`');
    await grant(Math.round(FPS * 0.6));
    // How close to stand depends on the animal. A deer at 9.5 m fills a third
    // of a 9:16 frame; a fox at 9.5 m is lost in the grass.
    const SMALL = ['fox', 'rabbit', 'raccoon', 'squirrel'];
    const near = SMALL.includes(shot.species);
    // Overridable: a clip ABOUT photographing an animal needs it big enough to
    // fill a phone frame, which is closer than the trailer's stand-off.
    shot.r0 = parseFloat(arg('photo-r0', near ? '6.0' : '9.8'));
    shot.r1 = parseFloat(arg('photo-r1', near ? '4.6' : '8.2'));
    shot.aimY = parseFloat(arg('photo-aimy', near ? '0.45' : '0.95'));

    // Compose on the animal from a low three-quarter stand-off, then hand the
    // frame to photo mode so the viewfinder is what the beat is shot through.
    await page.evaluate(({ NOVF, RAIL, ...s }) => {
      const THREE = window.__THREE, e = window.__engine, wd = window.__world;
      const az = 2.1;
      const R = s.r0;
      const px = s.x + Math.sin(az) * R, pz = s.z + Math.cos(az) * R;
      e.camera.position.set(px, wd.getHeight(px, pz) + (s.aimY < 0.6 ? 1.05 : 1.55), pz);
      e.camera.lookAt(s.x, wd.getHeight(s.x, s.z) + s.aimY, s.z);
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
      // `--no-viewfinder` for clips that only borrow this beat to put an animal
      // in front of a camera (moose, how-many); `--photo-rail` keeps the camera
      // BACK — the dials and the desk — for the clip that is about the camera.
      window.__hudForce = !NOVF;
      if (NOVF) {
        window.__systems.hud.photo.setActive(false);
        document.getElementById('pa-trailer-hide').textContent =
          `#pa-hud { display: none !important; } ${window.__tHide}`;
      } else {
        document.getElementById('pa-trailer-hide').textContent = window.__tHide +
          '#pa-hud > *:not(.pa-photo-frame) { display: none !important; }' +
          (RAIL ? '' : '.pa-photo-frame .pa-rail, .pa-photo-frame .pa-cam-desk ' +
                       '{ display: none !important; }');
      }
    }, { ...shot, NOVF: has('no-viewfinder'), RAIL: has('photo-rail') });
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
      // `at` is an exact spot; `d` is the rehearsed meadow's run-out.
      const x = d.at ? d.at[0] : (d.drive ? d.drive.x + Math.sin(d.drive.yaw) * 45
                                          : window.__poi.best('meadow', 0).x);
      const z = d.at ? d.at[1] : (d.drive ? d.drive.z + Math.cos(d.drive.yaw) * 45
                                          : window.__poi.best('meadow', 0).z);
      const yaw = d.at ? (d.at[2] ?? 0) : (d.drive ? d.drive.yaw : 0);
      window.__camp?.strike?.();
      window.__vehicleTeleport?.(x, z, yaw);
      return { x, z, y: w.getHeight(x, z), slope: w.getSlope(x, z) };
    }, { at: AT, drive: AT ? null : await proveMeadow() });
    console.log(`[trailer]   camp ground (${site.x.toFixed(1)}, ${site.z.toFixed(1)}) ` +
                `y+${site.y.toFixed(0)}m slope ${site.slope.toFixed(3)}` +
                `${AT ? '  [pinned with --at]' : ''}`);
    await settle(2.0);
    // Latch the park brake with a REAL keypress. Not decoration: at dusk the
    // headlights flood the camp from 8-18 m away and latching the brake is what
    // dips them. campshot.mjs learned this the expensive way.
    await hold('Space', true);
    await grant(Math.round(FPS * 0.8));
    await hold('Space', false);
    const camp = await page.evaluate(({ DELAY, NEEDS }) => {
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

      // `--camp-needs telescope`: pitch until the camp HAS one.
      //
      // The telescope is a 0.40 roll per camp (camp_site.js: "somebody's hobby
      // rather than their kit"), and the roll is seeded by the SITE — so the
      // way to get one is to try other sites, not to ask again at the same one.
      // Jitter the origin, probe instantly, strike, and keep the offset that
      // won. Doing it here rather than in the scope beat is what keeps all the
      // shots in one clip pointed at the SAME camp.
      let ox = v.position.x, oz = v.position.z;
      if (NEEDS === 'telescope') {
        let found = false;
        for (let i = 0; i < 28 && !found; i++) {
          const a = i * 0.9, r = (i % 7) * 3.0;
          const tx = v.position.x + Math.cos(a) * r, tz = v.position.z + Math.sin(a) * r;
          const probe = window.__camp.pitchNear(tx, tz, { instant: true, radius });
          if (probe) {
            const c = window.__camp.camps[window.__camp.camps.length - 1];
            found = (c?.props ?? []).some((pr) => pr.obj?.userData?.telescope);
            if (found) { ox = tx; oz = tz; }
          }
          window.__camp.strike();
        }
        if (!found) return { noTelescope: true };
      }
      // `--camp-delay` leaves the ground BARE and hands the pitch to the
      // per-frame driver instead.
      //
      // The whole claim of this clip is that bare dirt becomes a camp, and a
      // CUT between the two states does not prove it — a viewer can fairly
      // assume they are two different places. One continuous shot in which the
      // same ground visibly changes is the proof. So probe for the site, strike
      // the probe, survey an orbit around where the camp WILL be, and film the
      // empty clearing until the driver fires.
      if (DELAY > 0) {
        const probe = window.__camp.pitchNear(ox, oz, { instant: true, radius });
        const at = probe ? { x: probe.x, z: probe.z } : { x: ox, z: oz };
        window.__camp.strike();
        window.__tPitch = { x: ox, z: oz, radius, at: DELAY, done: false };
        return { x: +at.x.toFixed(1), z: +at.z.toFixed(1), small: false, deferred: true };
      }
      const s = window.__camp.pitchNear(ox, oz, { instant: false, radius });
      if (!s) return null;

      return { x: +s.x.toFixed(1), z: +s.z.toFixed(1), small: !!s.small };
    }, { DELAY: parseFloat(arg('camp-delay', '0')), NEEDS: String(arg('camp-needs', '')) });
    if (camp) Object.assign(camp, await surveyOrbit({
      cx: camp.x, cz: camp.z,
      r0: parseFloat(arg('camp-r0', '9.5')), r1: parseFloat(arg('camp-r1', '7.0')),
      sweep: parseFloat(arg('camp-sweep', '0.40')),
      bias: arg('camp-bias', null) === null ? null : parseFloat(arg('camp-bias')),
    }));
    if (camp?.noTelescope) {
      throw new Error('no camp near here rolls a telescope — try another meadow, ' +
                      'or drop --camp-needs');
    }
    if (!camp) throw new Error('pitchNear found no site');
    world.camp = { x: camp.x, z: camp.z };   // `campwide` re-frames this camp
    console.log(`[trailer]   camp (${camp.x}, ${camp.z})${camp.small ? ' [compact]' : ''}` +
                `  arc ${camp.clear}/72 clear, cost ${camp.cost}`);
    return camp;
  };

  /**
   * The same camp, from further out. No pitching: it re-surveys an orbit around
   * whatever `camp` already built, at a wider radius, so a clip can cut from
   * close on the fire to the whole camp under the stars and have them be one
   * place. Also stands the fireside view down, since the roast beat usually
   * runs between the two.
   */
  setups.campwide = async () => {
    // Pitch its own camp if nothing has. A clip whose hook IS this shot cannot
    // afford a half-second establishing beat in front of it just to satisfy a
    // dependency — that cut is what made the first `one-day` break its hook
    // inside a second.
    if (!world.camp) await setups.camp();
    await page.evaluate(() => { window.__roast?.leave?.(); });
    await grant(Math.round(FPS * 0.4));
    const arc = await surveyOrbit({
      cx: world.camp.x, cz: world.camp.z,
      r0: parseFloat(arg('wide-r0', '9')), r1: parseFloat(arg('wide-r1', '19')),
      sweep: parseFloat(arg('wide-sweep', '0.30')), lift: parseFloat(arg('wide-lift', '1.2')),
    });
    console.log(`[trailer]   campwide arc ${arc.clear}/72 clear, cost ${arc.cost}`);
    return arc;
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
    // A marshmallow is the warmest, most specific frame this game owns, so it
    // is often the HOOK rather than a middle beat — which means it can be the
    // first thing rendered and cannot assume a camp already exists.
    if (!world.ridge && !world.camp) await setups.ridge();
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
    // The trailer wants the whole fireside at 34; a clip ABOUT the marshmallow
    // wants the marshmallow. `right` is where the hold sits across the frame
    // (authored at 0.142, off to one side) and naming it PINS the hold, which
    // is what centring requires.
    await page.evaluate(({ FOV, RIGHT }) => {
      const p = { fov: FOV };
      if (RIGHT !== null) p.right = RIGHT;
      window.__roast.pose(p);
    }, { FOV: parseFloat(arg('roast-fov', '34')),
         RIGHT: arg('roast-right', null) === null ? null : parseFloat(arg('roast-right')) });
    for (let i = 0; i < FPS * 3 && await page.evaluate(
      () => (window.__roast.state()?.t ?? 1) < 0.999); i++) await step();
    // `--roast-lower` holds the marshmallow DOWN in the heat for the beat.
    //
    // `marshmallow_toast.js` runs the cook as 1/r^2 about the flame's hot
    // point, and the authored resting hold is a comfortable 0.8 m above it —
    // safe, and essentially raw. Filmed for eight and a half seconds at that
    // height the mallow does not visibly change colour at all, which is fatal
    // for a clip whose entire premise is watching it go gold, then brown, then
    // catch. S is the game's own "down into the heat"; nothing here fakes a
    // doneness value.
    // `--roast-precook <doneness>` cooks it off camera first.
    //
    // Measured (tools/_scratch/mallowcook.mjs): doneness runs 0..1 — gold at
    // 0.35, brown 0.55, black 0.80 — and advances at 0.0141/s at the authored
    // resting height, 0.0247/s held down in the heat with S. A full cook is
    // therefore about forty seconds, and a ten-second clip can show a QUARTER
    // of it. Filmed from raw, the marshmallow visibly does not change, which is
    // fatal for a clip whose whole premise is watching it turn.
    //
    // Sim time is free here — the granted clock advances the world with no
    // frames written — so spend thirty seconds of it before the first frame and
    // film the part worth watching: brown, black, and catching.
    const PRE = parseFloat(arg('roast-precook', '0')) || 0;
    if (PRE > 0) {
      let d = 0;
      for (let i = 0; i < FPS * 90; i++) {
        await step();
        if (i % 6 === 0) {
          d = await page.evaluate(() => window.__roast.state()?.doneness ?? 1);
          if (d >= PRE) break;
        }
      }
      const st = await page.evaluate(() => window.__roast.state() ?? {});
      console.log(`[trailer]   pre-cooked to doneness ${d.toFixed(2)} (target ${PRE}) ` +
                  `alight=${st.alight} ruined=${st.ruined} result=${st.result}`);
    }

    // LOWER IT ONLY ONCE FILMING STARTS.
    //
    // Order matters and the first version had it backwards. Held down in the
    // heat the marshmallow goes ALIGHT at doneness 0.60 — well before the 0.80
    // the toast scale calls black — so pre-cooking with S burns it, the view
    // plays its result and hands the camera back, and the beat cuts to an
    // exterior shot of the camper mid-clip. Pre-cook at the authored resting
    // height, which is slow and safe, and lower it on camera: the fire is the
    // punchline and it should happen where the audience can see it.
    if (has('roast-lower')) await hold('KeyS', true);
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

  /**
   * The orbit both camp beats fly — the daytime camp and the night-ridge hook.
   * `__tOrbit` is written by `surveyOrbit`; `lift` raises eye and aim together,
   * which is how the ridge shot buys sky without tipping into a top-down view.
   */
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
      // A short move, held wide of the axis.
      //
      // Two failures tuned this. The 2.8 s version dollied 5.6 -> 9.8 m, which
      // at 1.9 s in the middle of a cut just reads as the camper leaving. Then
      // pulling the dolly in without widening the offset put the lens 5.4 m
      // dead astern, and a rear elevation of a van filling half a 9:16 frame
      // reads as PARKED — there is no ground in shot moving past to say
      // otherwise. So: a short push, but far enough off the axis to hold the
      // flank and the wheels, and low enough that the meadow streams by.
      const d = 6.8 + 1.7 * s, lat = 2.8 + 1.0 * s, h = 1.5 + 0.55 * s;
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
      const R = s.r0 + (s.r1 - s.r0) * (k * k * (3 - 2 * k));
      const px = s.x + Math.sin(az) * R, pz = s.z + Math.cos(az) * R;
      e.camera.position.set(px, wd.getHeight(px, pz) + (s.aimY < 0.6 ? 1.05 : 1.55), pz);
      e.camera.lookAt(s.x, wd.getHeight(s.x, s.z) + s.aimY, s.z);
    }, u),
    camp:  (u) => orbitCam(u),
    campwide: (u) => orbitCam(u),
    skylook: (u) => page.evaluate((k) => {
      const t = window.__tSky, e = window.__engine;
      // Stand at the camp and look up. A small drift across the field, not a
      // sweep — the stars are the subject and a fast pan smears them.
      // Start low enough to hold the treeline, then climb. Context first: a
      // circle of bare sky says nothing about where you are, and the tops of
      // the conifers are what make it a sky ABOVE A CAMP.
      const el = t.el0 + (t.el1 - t.el0) * (k * k * (3 - 2 * k));
      const az = t.az + (k - 0.5) * t.pan;
      e.camera.position.set(t.x, t.g + 1.6, t.z);
      e.camera.lookAt(t.x + Math.sin(az) * Math.cos(el) * 100,
                      t.g + 1.6 + Math.sin(el) * 100,
                      t.z + Math.cos(az) * Math.cos(el) * 100);
    }, u),
    scopeprop: (u) => page.evaluate(({ k, A }) => {
      const t = window.__tScopeProp, e = window.__engine;
      // FIND IT, THEN GO TO IT — two moves in one shot.
      //
      // A straight push-in on the tube asks the viewer to already know what
      // they are looking at. Sweeping the AIM from the fire across the site
      // discovers the telescope the way a person would, and only then does the
      // camera close on it. Cutting to the eyepiece after that is motivated;
      // cutting to it from the fire is a non sequitur, which is exactly how the
      // first version played.
      const pan  = Math.min(1, k / A);
      const push = Math.max(0, (k - A) / (1 - A));
      const sp = pan * pan * (3 - 2 * pan);
      const sq = push * push * (3 - 2 * push);
      const d = 8.8 + (2.7 - 8.8) * sq;
      const x = t.x + t.dx * d, z = t.z + t.dz * d;
      e.camera.position.set(x, t.g + 1.75 - 0.40 * sq, z);
      const ax = t.fx + (t.x - t.fx) * sp;
      const az = t.fz + (t.z - t.fz) * sp;
      const ay = (t.g + 0.85) + ((t.y + 0.15) - (t.g + 0.85)) * sp;
      e.camera.lookAt(ax, ay, az);
    }, { k: u, A: parseFloat(arg('scope-find', '0.55')) }),
    firelight: (u) => orbitCam(u),
    ridge: (u) => page.evaluate(({ k, loop }) => {
      const r = window.__tRidge, e = window.__engine, wd = window.__world;
      const s = k * k * (3 - 2 * k);
      // A slow arc across the fall line with a touch of push-in. Small on
      // purpose: the composition IS the shot, and a wide orbit would swing the
      // valley out of frame in under a second.
      // `loop` makes it a there-and-back so the clip replays with no seam: the
      // bearing rides a sine and the radius a raised cosine, both exactly back
      // where they began at k = 1. k = 0 is the CLOSE end on purpose — frame
      // one is the thumbnail on every platform, so the shot opens on its best
      // frame instead of easing into it.
      // Swing ONE WAY, not both. A sine takes the bearing +sweep and then
      // -sweep, so it visits both sides of the composition and only one of them
      // has to be clear — at +0.22 rad this shot passed behind a conifer and
      // put a trunk through the middle of the frame at the quarter point. A
      // raised cosine on the bearing too keeps it on the side that was framed,
      // and is still exactly back at the start on k = 1.
      const swing = (1 - Math.cos(k * Math.PI * 2)) / 2;
      const az = loop ? r.camAz + r.swingDir * swing * r.sweep
                      : r.camAz + (s - 0.5) * r.sweep;
      const d = loop ? r.d1 + (r.d0 - r.d1) * swing
                     : r.d0 + (r.d1 - r.d0) * s;
      const x = r.cx + Math.sin(az) * d, z = r.cz + Math.cos(az) * d;
      // Above the camp, never inside the hill it stands on.
      const y = Math.max(r.g + r.eye, wd.getHeight(x, z) + 1.6);
      e.camera.position.set(x, y, z);
      // Aim PAST the camp down the fall line, not at it. Aiming at the camp
      // centres it and hands the top half of a 9:16 frame to empty sky; aiming
      // out over the valley drops the camp into the lower third and fills the
      // middle with what the bluff is for.
      e.camera.lookAt(r.cx + Math.sin(r.viewAz) * r.aim, r.g + r.aimY,
                      r.cz + Math.cos(r.viewAz) * r.aim);
    }, { k: u, loop: LOOP }),
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
    // `--hour-ramp "from,to"` steps `__lighting.hour` every frame, which is
    // what a day-in-N-seconds clip is: one fixed camera and the sun moving.
    // Beat hours set a single frozen hour; this overrides it per frame. Runs
    // for whichever beat is named by `--hour-ramp-beat` (default `campwide`).
    __ramp: (u) => page.evaluate(({ k, a, b }) => {
      const L = window.__lighting;
      L.cycleSpeed = 0;                       // we are the clock, not the cycle
      let h = a + (b - a) * k;
      while (h >= 24) h -= 24;
      while (h < 0) h += 24;
      L.hour = h;
    }, { k: u, a: HOUR_RAMP[0], b: HOUR_RAMP[1] }),
    // Sweep the eyepiece slowly. A fixed star field reads as a photograph; a
    // little drift reads as somebody looking. The view damps `fov` toward
    // `fovTarget` every frame, so the aim is what moves, not the zoom.
    scope: (u) => page.evaluate(({ k }) => {
      const p = window.__tScopePan, scope = window.__systems?.camp?.scope;
      if (!p || !scope) return;
      // A monotonic sweep that STARTS at the given aim rather than centring on
      // it. Anchoring the start is what lets the shot open with the treeline in
      // the bottom of the circle — context for what you are looking through —
      // and then climb off it into open sky. Centred, half the move is spent
      // below the horizon.
      const az = p.az + k * p.range;
      const el = p.el + k * p.rise;
      scope._aim.set(Math.sin(az) * Math.cos(el), Math.sin(el),
                     Math.cos(az) * Math.cos(el)).normalize();
    }, { k: u }),
    // Fires the deferred pitch once, mid-shot. See the note in `setups.camp`.
    camp: (u, secs) => page.evaluate(({ t }) => {
      const p = window.__tPitch;
      if (!p || p.done || t < p.at) return;
      p.done = true;
      window.__camp.pitchNear(p.x, p.z, { instant: false, radius: p.radius });
    }, { t: u * secs }),
    bike: () => page.evaluate(() => {
      const t = window.__tBike, st = window.__bike?.state?.().bike;
      if (!st || !t) return;
      // Steer toward the run picked at setup, and re-assert the throttle every
      // frame. `drive()` is not a held key — one call before the beat is one
      // call, and anything that runs `dismount()` clears it silently.
      let d = Math.atan2(t.tx - st.x, t.tz - st.z) - (st.heading ?? 0);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      window.__bike.drive(1, Math.max(-1, Math.min(1, d * 1.4)));
      // Hold the pedals every frame. `controlsHeldBy` is the game's system of
      // record for who is driving what, and `Boat.exit()` can decline to give
      // it up — a kayak mid-channel has no bank to step onto. When that happens
      // the bike mounts, the camera moves to the saddle, and `Bike._pedal`
      // never runs, so the shot is a perfectly framed stationary bicycle
      // reporting `blocked false, effort 1, speed 0`. Filmed exactly that.
      const v = window.__systems?.vehicle;
      if (v && v.controlsHeldBy !== 'bike') v.controlsHeldBy = 'bike';
    }),
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
  // Register authored shots the run actually asked for. Gated on `wanted`
  // deliberately: an unrequested shot must not join BEATS, or it would lengthen
  // the standard fifteen-second cut and quietly break the length assertion at
  // the bottom of this file.
  for (const [name, make] of Object.entries(SHOT_MODULES)) {
    if (!wanted?.includes(name)) continue;
    const shot = make({ page, arg, hold, step, grant, settle, FPS });
    BEATS.push(shot.beat);
    setups[name] = shot.setup;
    if (shot.camera) cameras[name] = shot.camera;
    if (shot.driver) drivers[name] = shot.driver;
    console.log(`[trailer] registered shot '${name}' (${shot.beat.secs}s @ hour ${shot.beat.hour})`);
  }
  const list = BEATS
    .filter((b) => (wanted ? wanted.includes(b.name) : !b.optional))
    .map((b) => ({
      ...b,
      secs: BEAT_SECS[b.name] ?? SECS ?? b.secs,
      hour: BEAT_HOURS[b.name] ?? b.hour,
    }));
  if (wanted) {
    // Render in the order the caller asked for, not the table's.
    list.sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name));
  }
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
    // A view holding the rig outranks `__forceCamera`, so a beat that poses its
    // own camera and does not own the rig will film whatever the view is
    // showing — silently, with no error and a full frame count.
    if (beat.pose) {
      const held = await page.evaluate(() => ({
        roast: !!window.__systems?.camp?.roast?.active,
        scope: !!window.__systems?.camp?.scope?.active,
        bike:  !!window.__bike?.state?.().riding,
        boat:  !!window.__boat?.state?.().active,
      }));
      const who = Object.entries(held).filter(([, v]) => v).map(([k]) => k);
      if (who.length) {
        console.warn(`[trailer]   WARNING: ${who.join(', ')} still holds the camera — ` +
                     `beat "${beat.name}" poses its own and will be overridden`);
      }
    }

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
      if (HOUR_RAMP && beat.name === HOUR_RAMP_BEAT) await drivers.__ramp(u);
      if (drivers[beat.name]) await drivers[beat.name](u, beat.secs);
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

  // A DROPPED BEAT MUST NOT BE QUIET.
  //
  // The photo beat failed to set up once and the tool did what it was written
  // to do: warned on one line, skipped it, and encoded a perfectly valid
  // 13.5-second video where 15 was asked for. Nothing downstream objected, and
  // the only reason it was caught is that 810 did not look like 900. Say it in
  // a block, put it in the trace, and exit non-zero so a script cannot treat a
  // short cut as a finished one.
  const failed = report.filter((r) => r.error);
  const want = list.reduce((n, b) => n + Math.round(b.secs * FPS), 0);
  if (failed.length || (!STILLS && f !== want)) {
    console.error('\n[trailer] ── INCOMPLETE CUT ──────────────────────────────');
    for (const r of failed) console.error(`[trailer]   ${r.beat}: ${r.error}`);
    console.error(`[trailer]   ${f} frames of ${want} — ${(f / FPS).toFixed(2)}s ` +
                  `instead of ${(want / FPS).toFixed(2)}s`);
    console.error('[trailer] ────────────────────────────────────────────────\n');
  }
  if (errors.length) console.warn(`[trailer] ${errors.length} page error(s): ${errors[0]}`);
  writeFileSync(TRACE, JSON.stringify({ seed: SEED, fps: FPS, frames: f, wantFrames: want,
                                        incomplete: failed.length > 0 || f !== want,
                                        beats: report }, null, 1));
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
  if (failed.length) process.exitCode = 4;      // the file exists; it is not finished
}

main().catch((e) => { console.error(e); process.exit(1); });

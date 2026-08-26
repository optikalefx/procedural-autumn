#!/usr/bin/env node
/**
 * Vertical short-form reel — offline, frame-by-frame, 9:16.
 *
 * THE WORKFLOW — scout, look, ship:
 *
 *   1. node tools/reel.mjs --scout                     # ~90 s, films nothing
 *   2. node tools/reel.mjs --site 0 --hour 17.4 \      # ~3 min, check framing
 *        --fps 24 --ss 1 --out shots/reel/look.mp4
 *   3. node tools/reel.mjs --site 0 --hour 17.4 \      # ~15 min, the delivery
 *        --fps 60 --ss 2 --out shots/reel/clip.mp4
 *
 * Do not skip step 1. Every gate this tool applies is knowable before a frame
 * is captured — whether the camper can get down the corridor, whether the camp
 * comes out full or compact, how far the clearest orbit arc sits from the
 * composition, whether there is water in the way — and `--scout` reports all of
 * them for every candidate in about ninety seconds. Discovering the same things
 * by rendering costs fifteen minutes a guess, which is how this tool shipped a
 * clip of the camper driving into a river.
 *
 * Do not skip step 2 either. The scout's gates are MECHANICAL. Seed 20261018
 * site 2 passes every one of them — clean drive, 8-prop camp, an orbit arc
 * 0.01 rad off ideal — and films a chase camera hanging over a flat blue lake.
 * Three minutes at 24 fps answers "does this look like anything" for a tenth of
 * the cost of finding out at delivery quality.
 *
 * The two free axes within one world are `--site` (which clean candidate) and
 * `--hour` (7.5 dawn, 12 midday, 17.4 golden, 19.6 dusk, 1 night). Changing
 * `--seed` changes the world and costs a bake.
 *
 * Other flags: --seconds (max 10), --park meadow|road|river, --car, --fov,
 * --crf, --hud to keep the HUD, --png for lossless frames, --keep-frames.
 *
 * Costs about 0.8 captured frames per second of wall clock at --ss 2. Start
 * your own vite server first: port 5178 serves the MAIN checkout, so from a
 * worktree every frame would be of main's code (AGENTS.md).
 *
 * A screen recorder films whatever the machine managed to draw. This films
 * what the game WOULD draw if the machine were infinitely fast: the engine's
 * clock is replaced by a budget the harness grants one frame at a time, so a
 * frame may take a second of wall clock and still be exactly 1/fps of screen
 * time. Physics is a 1/120 accumulator (VehiclePhysics), so at 60 fps every
 * frame is exactly two steps and the motion is reproducible.
 *
 * The shot is a three-beat clip that needs no editing: drive, stop and make
 * camp, then a slow orbit while the camp raises. See SHOT below.
 *
 * Why the pieces are here:
 *   · `--ss 2` renders at twice the output size and lets ffmpeg downsample.
 *     A starfield, grass and distant canopy all alias at 1080 wide, and TikTok's
 *     encoder turns that shimmer to mush. Supersampling is the only fix that
 *     does not cost the player anything, because the player never renders it.
 *   · `?iscale=1&pixelratio=native` pins the internal render scale AND freezes
 *     the adaptive scaler, so a heavy frame cannot be rescued by drawing fewer
 *     pixels mid-clip (AGENTS.md, "the internal-resolution pipeline").
 *   · The park brake is latched with a REAL keypress before the camp goes up.
 *     Not decoration: at dusk the headlights flood the camp from 8-18 m away
 *     and latching the brake is what dips them. campshot.mjs learned this the
 *     expensive way; its comment has the measurements.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const OUT     = resolve(String(arg('out', 'shots/reel/camp.mp4')));
const FPS     = Math.max(24, parseInt(arg('fps', '60'), 10) || 60);
const SECONDS = Math.min(10, Math.max(2, parseFloat(arg('seconds', '10')) || 10));
const W       = parseInt(arg('w', '1080'), 10);
const H       = parseInt(arg('h', '1920'), 10);
const SS      = Math.max(1, parseFloat(arg('ss', '1')) || 1);
const SEED    = String(arg('seed', '20261018'));
const CAR     = String(arg('car', 'camper'));
const HOUR    = parseFloat(arg('hour', '17.4'));
// Where the drive starts. Meadows, measured on seed 20261018: 6 good sites out
// of 8 candidates, orbit arcs 0-0.04 rad off ideal. Roads: 1 good site out of
// 8, best arc 0.55. The reason is in PointsOfInterest — a meadow is scored as
// open, dry, low-slope ground ("the clearing, not the wood"), which is exactly
// what a drive and a full camp both want, while roads climb hillsides and ford
// rivers. `--park road` still gives the dirt-track look when that is wanted.
const PARK    = String(arg('park', 'meadow'));
const FOV     = parseFloat(arg('fov', '70'));
const CRF     = String(arg('crf', '19'));
// Which clean site to film. The seed fixes the world, so the site index and the
// hour are the two ways to get a different clip out of it without re-baking.
const SITE    = Math.max(0, parseInt(arg('site', '0'), 10) || 0);
// Preflight. Every gate this tool applies — the rehearsal, whether the camp
// comes out full, how far the clear orbit arc sits from the composition — is
// knowable before a single frame is captured. Scouting takes about a minute;
// discovering the same thing by rendering takes twelve.
const SCOUT   = has('scout');
// Intermediate frames are JPEG unless asked otherwise. At --ss 2 a 2160x3840
// PNG is ~8 MB and encoding it, not rendering the frame, is what sets the
// capture rate — the first 60 fps take was writing 8.5 MB per frame and running
// at 0.14 fps, a 70-minute clip. The frames are downsampled 2:1 and then run
// through x264 at crf 19, so quality-96 JPEG is not distinguishable in the
// output; `--png` is there for the case where it has to be provably lossless.
const EXT     = has('png') ? 'png' : 'jpg';
const BASE    = String(arg('url', process.env.AUTUMN_URL || 'http://localhost:5178'));
const PREROLL = Math.max(0, parseFloat(arg('preroll', '1.4')) || 0);
// How far ahead the drive corridor is checked. Measured from the trace: the
// camper tops out near 21 m/s and coasts through the braking beat, covering
// ~51 m start to stop. 40 m let it hit a boulder at 46 m during the coast; 65 m
// went too far the other way and rejected every flat road in the world for
// obstructions well past anything it reaches, leaving a 0.29-slope hillside as
// the best remaining candidate. Check the ground it actually drives on.
const CORRIDOR = Math.max(20, parseFloat(arg('corridor', '54')) || 54);
const FRAMES  = Math.round(SECONDS * FPS);
const TMP     = resolve(String(arg('frames', `${OUT.replace(/\.[^.]+$/, '')}-frames`)));
const TRACE   = resolve(String(arg('trace', OUT.replace(/\.[^.]+$/, '.json'))));

// ── the shot, in seconds ────────────────────────────────────────────────────
//
// Vertical shorts have no room for an establishing beat: the subject has to be
// doing something by the time the thumb decides. So the clip opens already
// rolling and the camp is up before the halfway mark.
const SHOT = {
  drive:  [0.00, 2.40],   // throttle held, chase camera
  brake:  [2.40, 3.40],   // off throttle, on the brake
  latch:  [3.40, 4.00],   // park brake down — also what dips the headlights
  pitch:   4.00,          // camp begins to raise (RAISE_TIME 1.15 s)
};

function assertTreeParses() {
  try {
    execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.error('[reel] refusing to film because the source tree does not parse');
    console.error(out.trim());
    process.exit(2);
  }
}

async function main() {
  assertTreeParses();
  const release = await acquire('reel');
  mkdirSync(TMP, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });
  for (const f of readdirSync(TMP)) if (/\.(png|jpg)$/.test(f)) rmSync(`${TMP}/${f}`);

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  // CSS viewport is the output size; deviceScaleFactor does the supersampling,
  // so the HUD and every CSS-sized element keep their intended proportions and
  // only the pixel count goes up.
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: SS,
  });

  // Six checkouts share one machine; a save mid-film reloads the page and
  // throws out the run. Same stub campshot uses.
  await page.addInitScript(() => {
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
  console.log(`[reel] ${url}`);
  console.log(`[reel] ${W}x${H} @ ${FPS}fps x ${SECONDS}s = ${FRAMES} frames, ss=${SS}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle,
    null, { timeout: 30000 });

  // ── take the clock ────────────────────────────────────────────────────────
  //
  // Every system in the game is driven by the one dt at Engine._loop. Replace
  // its source with a budget: the world advances exactly 1/fps when the harness
  // grants it and is frozen (dt 0) otherwise, which is what makes a slow frame
  // cost wall clock instead of screen time. `worldPaused` would not do — it
  // exempts the camera rig and audio, which have to be on the same clock here.
  await page.evaluate((fps) => {
    const e = window.__engine;
    e.adaptive = false;
    e.autoQuality = false;
    const DT = 1 / fps;
    let budget = 0;
    window.__reelBudget = () => budget;
    window.__reelGrant = () => { budget += DT; };
    e.clock.getDelta = () => {
      if (budget <= 1e-9) return 0;
      budget -= DT;
      return DT;
    };
  }, FPS);

  /**
   * Advance the world exactly one frame, wait for it to be drawn, and report
   * what the camper was doing while it happened.
   *
   * The telemetry is not decoration. The first delivered take drove into a
   * boulder and stopped dead, and the contact sheets sampled at one frame per
   * second stepped straight over it — the repo's own debug-visual-video note
   * says to log telemetry with every frame for exactly this reason, and this
   * tool shipped once without it.
   */
  const step = async () => page.evaluate(() => new Promise((res) => {
    window.__reelGrant();
    // Two frames: the first consumes the grant, the second guarantees the
    // result has been composited before the screenshot reads the surface.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = window.__systems.vehicle;
      res({
        x: +v.position.x.toFixed(2), z: +v.position.z.toFixed(2),
        speed: +Math.abs(v.speed ?? 0).toFixed(2), brake: !!v.brakeHold,
      });
    }));
  }));

  const held = new Set();
  const hold = async (code, on) => {
    if (on && !held.has(code)) { await page.keyboard.down(code); held.add(code); }
    if (!on && held.has(code)) { await page.keyboard.up(code); held.delete(code); }
  };

  // Park on the FLATTEST CLEAR road, not the "best" one.
  //
  // Two separate lessons, in the order they were learned.
  //
  // `poi.best('road')` ranks by its own score, which has nothing to do with
  // drivability: measured on seed 20261018 the top-ranked road sits at slope
  // 1.12 and index 3 at 1.15 — mountain switchbacks cut into a hillside. The
  // first take filmed the camper sliding sideways down a scree face for three
  // seconds. Roads on the valley floor exist in the same list; they just do
  // not score highest.
  //
  // Flat is necessary and not sufficient. The take after that drove down a
  // beautifully flat road straight into a boulder and lost a third of its
  // speed at full throttle. So the corridor has to be checked too — and it has
  // to be checked FROM the candidate, after teleporting there. The first
  // attempt at this raycast the candidates from wherever the camper happened
  // to be standing, which is to say it tested un-streamed empty space and
  // reported every corridor clear. Rocks and trunks only exist in the scene
  // graph near the camera.
  //
  // So: score cheaply on terrain functions (which need no scene), then walk
  // the shortlist for real.
  const shortlist = await page.evaluate(({ kind, look }) => {
    const w = window.__world, poi = window.__poi;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const q = poi.best(kind, i);
      if (!q) break;
      let sl = 0, n = 0;
      for (let a = 0; a < 8; a++) {
        for (let d = 6; d <= 24; d += 6) {
          sl += w.getSlope(q.x + Math.cos(a * 0.785) * d, q.z + Math.sin(a * 0.785) * d);
          n++;
        }
      }
      // Which way does the camper set off?
      //
      // Road POIs carry the road's own bearing, which is what a drive wants.
      // Meadows, forests and peaks carry none — `poi.best` returns the raw
      // record and only `poi.anchor` derives a yaw, aiming it at scenery for a
      // camera rather than at drivable ground. Falling back to `?? 0` sent
      // every meadow candidate due north regardless of terrain. So where the
      // POI has no opinion, pick the flattest run out of it.
      let yaw = q.yaw;
      if (yaw === undefined) {
        let flattest = Infinity;
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
      let lo = Infinity, hi = -Infinity;
      for (let d = 0; d <= look; d += 5) {
        const h = w.getHeight(q.x + Math.sin(yaw) * d, q.z + Math.cos(yaw) * d);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      // `pitchNear` falls back to a COMPACT site (3 props instead of 6-9) when
      // no full one is in reach, and a compact camp is a thin payoff for the
      // beat the clip builds to. Meadows are the open dry ground full camps
      // want ("a meadow is the clearing, not the wood", PointsOfInterest), so
      // score each road on how close its run-out lands to one.
      const ex = q.x + Math.sin(yaw) * look, ez = q.z + Math.cos(yaw) * look;
      let toMeadow = Infinity;
      for (let m = 0; m < 10; m++) {
        const md = poi.best('meadow', m);
        if (!md) break;
        toMeadow = Math.min(toMeadow, Math.hypot(md.x - ex, md.z - ez));
      }
      // Does the corridor cross water?
      //
      // This is the one the downward raycast can never see, and it is what was
      // actually stopping the camper: a river is a CUT in the terrain with its
      // surface at ground level, so nothing stands proud of `getHeight` for a
      // ray to hit, and the probe called the corridor clear every time. The
      // trace said the camper lost 4.6 m/s in a single frame at 37.8 m dead
      // centre; the frames at that moment show it nose-down in the river.
      //
      // `getWaterContactDepth` is pure world data — it needs no scene and no
      // streaming — so unlike the obstacle test this one can run in the cheap
      // pass, before any teleport.
      let wet = 0, firstWet = Infinity;
      for (let d = 3; d <= look; d += 2) {
        for (const off of [-3, 0, 3]) {
          const px = q.x + Math.sin(yaw) * d + Math.cos(yaw) * off;
          const pz = q.z + Math.cos(yaw) * d - Math.sin(yaw) * off;
          if (w.getWaterContactDepth(px, pz) > 0.05) { wet++; firstWet = Math.min(firstWet, d); }
        }
      }

      out.push({ i, x: q.x, z: q.z, yaw, y: w.getHeight(q.x, q.z), slope: sl / n, drop: hi - lo, toMeadow,
                 wet, firstWet: Number.isFinite(firstWet) ? firstWet : 0,
                 // Water is close to a hard reject: a drive beat that ends in a
                 // river is not a drive beat.
                 score: sl / n + (hi - lo) / look + Math.min(toMeadow, 400) / 120 + wet * 1.5 });
    }
    out.sort((p, r) => p.score - r.score);
    return out.slice(0, 8);   // the rehearsal is the real filter; give it room
  }, { kind: PARK, hour: HOUR, look: CORRIDOR });
  if (!shortlist.length) { console.error(`[reel] no ${PARK} POI in this world`); process.exit(3); }

  /**
   * Settle the camper at a candidate. The world is on the granted clock now, so
   * "wait for the springs and the streaming" means granting frames, not sleeping
   * — a wall-clock wait advances nothing at all.
   */
  const settle = async (cand) => {
    await page.evaluate((c) => {
      window.__camp?.strike?.();
      window.__vehicleTeleport?.(c.x, c.z, c.yaw);
    }, cand);
    for (let i = 0; i < Math.round(FPS * 1.5); i++) await step();
    await page.waitForTimeout(700);          // async asset loads are on wall time
    for (let i = 0; i < Math.round(FPS * 0.5); i++) await step();
  };

  /**
   * Drive the candidate for real and read the speed trace. No screenshots.
   *
   * Three rounds were spent trying to PREDICT whether a corridor was drivable —
   * slope, run-out drop, a downward raycast for solid obstacles, a water query
   * — and each proxy passed a corridor the camper then failed to get down. The
   * raycast could not see the river because a river is a cut in the ground with
   * nothing standing proud of it; the water query could not see the boulder.
   * The physics already knows the answer, and rehearsing costs a couple of
   * seconds because nothing is being photographed. So stop predicting.
   */
  const rehearse = async () => {
    const speeds = [];
    await hold('KeyW', true);
    const nDrive = Math.round((PREROLL + SHOT.drive[1]) * FPS);
    for (let i = 0; i < nDrive; i++) speeds.push((await step()).speed);
    await hold('KeyW', false);
    return verdict(speeds);
  };

  /** Deceleration under throttle: nothing but an impact does that. */
  const verdict = (speeds) => {
    const top = speeds.reduce((m, v) => Math.max(m, v), 0);
    const win = Math.max(1, Math.round(FPS * 0.2));
    let worst = 0, at = -1;
    for (let i = win; i < speeds.length; i++) {
      if (speeds[i - win] < 5) continue;
      const lost = speeds[i - win] - speeds[i];
      if (lost > worst) { worst = lost; at = i; }
    }
    return { top: +top.toFixed(1), lost: +worst.toFixed(1), at, ok: worst <= 3 && top > 8 };
  };

  /**
   * Pitch the camp and choose the orbit arc. Extracted so `--scout` can ask
   * whether a site will produce a good CLIP without filming one: whether the
   * camp comes out full or compact, and how far the clearest arc sits from
   * the composition, are both known long before the first frame is written.
   */
  const pitchAndSurvey = () => page.evaluate(({ span }) => {

        const v = window.__systems.vehicle;
        // `instant: false` is the whole point of this beat — the staged build
        // and the 1.15 s raise are the "setting up camp" the clip is about.
        // Widen before settling: pitchNear prefers a full site inside its own
        // radius, so the radius is the whole control over full-vs-compact.
        //
        // Probe with `instant: true` and strike each probe, THEN pitch for real
        // at the radius that won. The first version pitched for real each time
        // and struck the loser — which meant that when every radius returned a
        // compact site, it struck the last one and returned its record anyway,
        // leaving a clip that films an empty clearing. The scout caught it:
        // two sites reported a camp of zero props.
        let radius = 0, small = true;
        for (const r of [20, 30, 40]) {
          const probe = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: r });
          if (!probe) continue;
          window.__camp.strike();
          radius = r; small = !!probe.small;
          if (!small) break;
        }
        if (!radius) return null;
        const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: false, radius });
        if (!s) return null;

        // Orbit the MIDPOINT of the camp and the camper, not the camp.
        //
        // The first take orbited the camp at a fixed radius and the camper —
        // the thing the clip has spent three seconds teaching you to follow —
        // was outside the frame for the entire second half. A camp is pitched
        // 8-18 m from the vehicle, so the pair has to be treated as one
        // subject: stand off far enough to hold both, and let the radius
        // shrink as the orbit goes so the shot pushes in rather than idling.
        // Stand OPPOSITE the camper and orbit the camp.
        //
        // Take two orbited the midpoint of the pair, which held both but made
        // each of them small and put the camera through a stand of ferns. The
        // composition that actually works in 9:16 is the obvious one: the camp
        // in the near third, the camper reading behind it, trees and ridge
        // above. That is exactly the camera bearing 180 deg from the camper,
        // so derive it rather than inheriting the chase camera's.
        const azVeh = Math.atan2(v.position.x - s.x, v.position.z - s.z);
        const THREE = window.__THREE, wd = window.__world, e = window.__engine;
        const R0 = 11.5, R1 = 7.5, SWEEP = 0.86;   // radians covered by the orbit
        const SPAN = span;                         // seconds the orbit has to run

        // Survey the whole circle ONCE and orbit on the clearest arc.
        //
        // Take three raycast per frame and stepped the camera outward when it
        // found something. That was wrong twice over: outward shrinks the
        // subject, which is how the camp ended up a speck, and a per-frame
        // decision makes the camera jitter whenever the answer flips between
        // frames. Clearance is a property of the SITE, so pay for it once and
        // hand the orbit an arc it can fly smoothly.
        // Near-level camera. Take four sat at 2.4 + R*0.075 and spent the
        // bottom third of a 1920-tall frame on grass between the lens and the
        // fire; dropping the eye and lifting the aim tilts that ground out of
        // frame without tipping into the top-down look.
        const camY = (rr, ax) => wd.getHeight(s.x + Math.sin(ax) * rr, s.z + Math.cos(ax) * rr)
                                 + 1.9 + rr * 0.055;
        // Aim just off the fire, toward the camper — but by a fraction of the
        // ORBIT RADIUS, not of the separation. Biasing by 32% of the separation
        // was tuned at one camp and put the aim 6 m past a camp only 7.5 m away
        // at the end of the push-in, which is how the delivered take ended up
        // pointed at bare ground with the tent clipped off the frame edge.
        const sep = Math.hypot(v.position.x - s.x, v.position.z - s.z) || 1;
        const bias = Math.min(0.20 * R0, 0.25 * sep);
        const lx = s.x + (v.position.x - s.x) / sep * bias;
        const lz = s.z + (v.position.z - s.z) / sep * bias;
        const look = new THREE.Vector3(lx, wd.getHeight(lx, lz) + 1.5, lz);
        const ray = new THREE.Raycaster();
        ray.far = 30;
        const N = 72, STEP = Math.PI * 2 / N;
        const blocked = new Array(N).fill(0);
        for (let i = 0; i < N; i++) {
          const ax = i * STEP;
          // Both ends of the dolly. Take five surveyed at R0 only and the
          // push-in then walked the last second of the orbit into a trunk that
          // simply was not on the outer circle.
          for (const rr of [R0, R1]) {
          const px = s.x + Math.sin(ax) * rr, pz = s.z + Math.cos(ax) * rr;
          const pos = new THREE.Vector3(px, camY(rr, ax), pz);
          // Three rays, not one: a trunk two metres off the optical axis fills
          // a 9:16 frame just as completely as one dead centre, and the single
          // centre ray in take three walked the camera straight into a conifer.
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

        // Slide the sweep window around the circle, trading clearance against
        // bearing. Both terms have to be on the same scale or one of them stops
        // mattering: the first version added a RAW blocked-ray count (which can
        // reach 30 across a window) to `radians * 0.9`, so the bearing
        // preference was noise and the orbit wandered 55 deg off to gain a
        // couple of rays. The delivered take aimed across the camp at empty
        // ground because of it. Normalise the blockage to 0..1 first, then a
        // fully blocked arc is worth about three radians of swing and nothing
        // less will move the camera far off the composition.
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
        const clear = blocked.filter((b) => b === 0).length;
        window.__reelOrbit = {
          cx: s.x, cz: s.z, lx, lz, bias,
          az0: bestAz, rate: SWEEP / SPAN, span: SPAN, r0: R0, r1: R1,
        };
        window.__reelSurvey = { clear, of: N, cost: +bestCost.toFixed(2) };
        window.__forceCamera = true;         // the rig stands down; fov is pinned
        return { x: +s.x.toFixed(1), z: +s.z.toFixed(1), small: !!s.small };
  }, { span: SECONDS - SHOT.pitch });

  // Walk the shortlist until enough clean sites have been found. `--site N`
  // takes the Nth of them, which is how you get a different location out of the
  // same world without re-baking: the seed fixes the terrain, the site index
  // and `--hour` are the two free axes.
  let chosen = null, fallback = null, cleanSeen = -1;
  const table = [];
  for (const cand of shortlist) {
    await settle(cand);
    const v = await rehearse();
    let camp = null;
    if (v.ok) {
      cleanSeen++;
      // Only worth pitching a camp where the drive works, but where it does,
      // the camp and the arc are the rest of the answer — and in SCOUT mode
      // they are the whole point, so pay for them there.
      if (SCOUT || cleanSeen === SITE) {
        await hold('KeyS', true);
        for (let i = 0; i < Math.round(FPS * 1.2); i++) await step();
        await hold('KeyS', false);
        await hold('Space', true);
        for (let i = 0; i < Math.round(FPS * 0.8); i++) await step();
        await hold('Space', false);
        const p = await pitchAndSurvey();
        if (p) {
          // Let the camp finish raising before counting it. The build queue
          // drains ONE prop per frame and the raise takes RAISE_TIME (1.15 s),
          // so reading `props` straight after the pitch reports 2 where the
          // finished camp has 6 — which is exactly the compact-vs-full
          // distinction this scout exists to report.
          for (let i = 0; i < Math.round(FPS * 1.4); i++) await step();
          const sv = await page.evaluate(() => window.__reelSurvey);
          camp = { ...p, arc: sv?.cost ?? 99,
                   props: await page.evaluate(() => window.__camp?.props?.length ?? 0) };
        }
        await page.evaluate(() => window.__camp?.strike?.());
      }
    }
    const row = { site: v.ok ? cleanSeen : null, poi: cand.i, x: cand.x, z: cand.z,
                  slope: cand.slope, y: cand.y, wet: cand.wet, v, camp };
    table.push(row);
    const campNote = !v.ok ? ''
      : camp ? `  camp ${camp.props} props${camp.small ? ' COMPACT' : ''}  ` +
               `arc ${camp.arc}${camp.arc > 0.6 ? ' (off-axis)' : ''}`
      : '  camp NONE (no site in reach)';
    console.log(`[reel]   ${v.ok ? `site ${cleanSeen}` : '  —   '} ` +
                `${PARK}[${String(cand.i).padStart(2)}] slope ${cand.slope.toFixed(3)} ` +
                `y${cand.y >= 0 ? '+' : ''}${cand.y.toFixed(0)}m water ${cand.wet}  ` +
                `drive ${v.ok ? 'clean' : `IMPACT -${v.lost}`}${campNote}`);

    // The requested site wins outright. Otherwise remember the least-bad
    // candidate, so a world with no clean run still films something and says
    // loudly that it did.
    if (v.ok && cleanSeen === SITE) chosen = { ...cand, v };
    if (!fallback || v.lost < fallback.v.lost) fallback = { ...cand, v };
    if (!SCOUT && chosen) break;
  }

  if (SCOUT) {
    // Water in the corridor is a gate, not a note. Site 2 of this world passed
    // every mechanical check — clean drive, 8-prop camp, an orbit arc 0.01 rad
    // off ideal — and filmed a chase camera hanging over a flat blue lake for
    // three seconds. Nothing about the physics objects to driving along a lake;
    // the picture does.
    //
    // Elevation is NOT the test, though it looks like one: the site that
    // produced the good clip also sits below zero (y -1 m, valley floor beside
    // a river) and films beautifully. What separates them is whether water is
    // in the corridor, which is exactly what `wet` already measures.
    const good = table.filter((r) => r.site !== null && r.camp && !r.camp.small &&
                                     r.camp.arc <= 0.6 && r.wet === 0);
    console.log(`\n[reel] scout: ${good.length} good site(s) for seed ${SEED}` +
                (good.length ? `: --site ${good.map((r) => r.site).join(', --site ')}` : ''));
    console.log('[reel] a good site is: clean drive, full camp (not compact), orbit arc ' +
                'within 0.6 rad of the composition, and no water in the corridor.');
    console.log('[reel] vary the mood with --hour: 7.5 dawn, 12 midday, 17.4 golden, ' +
                '20.4 dusk, 1 night.');
    await browser.close();
    release();
    return;
  }

  const start = chosen ?? fallback;
  if (!start) { console.error(`[reel] no ${PARK} candidate survived`); process.exit(3); }
  await settle(start);
  await page.evaluate((hour) => {
    window.__lighting.hour = hour;
    window.__lighting.cycleSpeed = 0;        // the sun must not drift mid-clip
  }, HOUR);
  console.log(`[reel] start ${PARK}[${start.i}] (${start.x.toFixed(0)}, ${start.z.toFixed(0)}) ` +
              `slope ${start.slope.toFixed(3)}  worst loss ${start.v.lost} m/s`);
  if (!chosen) {
    console.warn(`[reel] no clean run at --site ${SITE} — filming the least-bad candidate, ` +
                 `which loses ${start.v.lost} m/s to an impact. Run --scout to see what ` +
                 'this world actually offers, or try another --seed.');
  }

  // ── frame the shot for 9:16 ───────────────────────────────────────────────
  //
  // Two things have to be taken off the game before it will film vertically.
  //
  // The HUD: `pa-capture-hidden` is normally driven by `__forceCamera`
  // (HUD.js), but that flag also hands the camera to the harness, and the
  // driving beat wants the game's own chase camera. So hide the root directly
  // and leave the rig alone.
  //
  // The fov: CameraRig damps it between 50 and 62 depending on speed, and
  // three.js fov is VERTICAL. At 16:9 a 52 deg vertical fov is a 78 deg
  // horizontal one; at 9:16 the same number is 31 deg — a telephoto, which is
  // why the first take felt like looking down a tube. Pin it instead, from a
  // late updater registered last so it lands after the rig has written its own
  // (Engine runs _lateUpdaters in registration order). 70 deg vertical is
  // about 47 horizontal here, which reads as a normal lens in portrait.
  await page.evaluate(({ fov, hud }) => {
    if (!hud) {
      const root = document.getElementById('pa-hud');
      if (root) root.style.display = 'none';
      // The camp prompt is NOT inside #pa-hud — camp_ui appends it straight to
      // document.body, so hiding the HUD root leaves "E pitch a camp here"
      // sitting in the corner of an otherwise clean frame. Style rather than
      // remove: the element is re-shown by its own update every frame.
      const css = document.createElement('style');
      css.textContent = '.pa-camp-prompt, .pa-toast, .pa-hint { display: none !important; }';
      document.head.appendChild(css);
    }
    window.__reelFov = fov;
    window.__engine.onLateUpdate(() => {
      const cam = window.__engine.camera;
      if (Math.abs(cam.fov - window.__reelFov) > 0.001) {
        cam.fov = window.__reelFov;
        cam.updateProjectionMatrix();
      }
    });
  }, { fov: FOV, hud: has('hud') });

  // Open already moving. A short has about half a second to hold a thumb, and
  // the first half second of a standing start is a stationary vehicle. Spend
  // the acceleration off-camera instead: same fixed clock, no frames written.
  // This is the same run the rehearsal just proved is clean.
  if (PREROLL > 0) {
    await hold('KeyW', true);
    for (let i = 0; i < Math.round(PREROLL * FPS); i++) await step();
  }

  let pitched = null;
  const trace = [];
  const t0 = Date.now();

  for (let f = 0; f < FRAMES; f++) {
    const t = f / FPS;

    await hold('KeyW', t >= SHOT.drive[0] && t < SHOT.drive[1]);
    await hold('KeyS', t >= SHOT.brake[0] && t < SHOT.brake[1]);
    await hold('Space', t >= SHOT.latch[0] && t < SHOT.latch[1]);

    if (pitched === null && t >= SHOT.pitch) {
      pitched = await pitchAndSurvey();
      if (!pitched) {
        console.error('[reel] pitchNear found no site near the camper — try --park meadow');
        await browser.close(); release(); process.exit(3);
      }
      const sv = await page.evaluate(() => window.__reelSurvey);
      console.log(`[reel] camp at (${pitched.x}, ${pitched.z})${pitched.small ? ' [compact]' : ''}` +
                  `  orbit arc: ${sv.clear}/${sv.of} bearings clear, cost ${sv.cost}`);
    }

    if (pitched) {
      await page.evaluate(({ t, t0 }) => {
        const o = window.__reelOrbit, cam = window.__engine.camera, wd = window.__world;
        const u = (t - t0);
        const k = Math.min(1, u / o.span);
        const az = o.az0 + u * o.rate;
        // Smoothstep the push-in so it starts and ends without a visible
        // change of rate — a linear dolly reads as a jump cut at both ends.
        const R = o.r0 + (o.r1 - o.r0) * (k * k * (3 - 2 * k));
        const x = o.cx + Math.sin(az) * R;
        const z = o.cz + Math.cos(az) * R;
        // Height rides the radius, and stays near eye level: a camp seen from
        // above is the exact artifact this project already keeps a note about,
        // and the ground between lens and fire is dead frame in 9:16.
        cam.position.set(x, wd.getHeight(x, z) + 1.9 + R * 0.055, z);
        cam.lookAt(o.lx, wd.getHeight(o.lx, o.lz) + 1.5, o.lz);
      }, { t, t0: SHOT.pitch });
    }

    const tel = await step();
    trace.push({ f, t: +t.toFixed(3), throttle: held.has('KeyW'), ...tel });
    await page.screenshot({
      path: `${TMP}/f${String(f).padStart(5, '0')}.${EXT}`,
      animations: 'disabled',
      ...(EXT === 'jpg' ? { type: 'jpeg', quality: 96 } : {}),
    });

    if (f % 60 === 0 || f === FRAMES - 1) {
      const el = (Date.now() - t0) / 1000;
      const rate = (f + 1) / el;
      console.log(`[reel] f${f}/${FRAMES}  ${rate.toFixed(1)} fps capture  ` +
                  `eta ${((FRAMES - f - 1) / rate / 60).toFixed(1)} min`);
    }
  }

  for (const c of held) await page.keyboard.up(c);

  // Did the drive actually work? A camper under throttle that was moving and
  // is now not moving has hit something — and that is the one failure this
  // clip cannot survive, because the whole first beat is the drive.
  //
  // The test is DECELERATION under throttle, not a speed floor. The first
  // detector only flagged a camper that had stopped, and the take that
  // prompted all of this never stopped — it hit a boulder at 20.8 m/s, came
  // out the other side at 14.5, and carried on. Nothing but an impact takes
  // 6 m/s off a vehicle in a quarter of a second with the throttle down.
  const driving = trace.filter((r) => r.throttle);
  const topSpeed = driving.reduce((m, r) => Math.max(m, r.speed), 0);
  const WINDOW = Math.max(1, Math.round(FPS * 0.2));
  let stall = null;
  for (let i = WINDOW; i < driving.length && !stall; i++) {
    const a = driving[i - WINDOW], r = driving[i];
    if (r.t < 0.3 || a.speed < 5) continue;
    const lost = a.speed - r.speed;
    if (lost > 3) stall = { ...r, lostFrom: a.speed, lost: +lost.toFixed(2) };
  }
  const distance = trace.length
    ? Math.hypot(trace.at(-1).x - trace[0].x, trace.at(-1).z - trace[0].z) : 0;
  console.log(`[reel] drive: top ${topSpeed.toFixed(1)} m/s, ` +
              `${distance.toFixed(0)} m covered`);
  if (stall) {
    console.warn(`[reel] IMPACT at t=${stall.t}s (frame ${stall.f}): ` +
                 `${stall.lostFrom.toFixed(1)} -> ${stall.speed.toFixed(1)} m/s ` +
                 `(-${stall.lost}) with the throttle down. The camper hit something and ` +
                 'the drive beat is not usable — try another --seed or --park.');
  } else {
    console.log('[reel] drive is clean: no deceleration under throttle');
  }
  writeFileSync(TRACE, JSON.stringify({
    seed: SEED, fps: FPS, seconds: SECONDS, start, camp: pitched,
    topSpeed: +topSpeed.toFixed(2), distance: +distance.toFixed(1),
    stall, trace,
  }, null, 1));
  const end = await page.evaluate(() => ({
    brakeHold: !!window.__systems.vehicle?.brakeHold,
    raise: +(window.__camp?.raise ?? 0).toFixed(2),
    props: window.__camp?.props?.length ?? 0,
  }));
  console.log(`[reel] brake=${end.brakeHold} raise=${end.raise} props=${end.props}`);
  if (errors.length) console.warn(`[reel] ${errors.length} page error(s): ${errors[0]}`);

  await browser.close();
  release();

  // ── encode ────────────────────────────────────────────────────────────────
  //
  // yuv420p and +faststart because everything downstream of here (TikTok, the
  // preview in Finder, QuickTime) wants both.
  //
  // The rate cap is not optional. This world is meadow grass and autumn canopy
  // in almost every frame — high-frequency detail across the whole picture —
  // and at crf 16 with no ceiling a 10 s 1080x1920 take encoded to 80 MB, i.e.
  // 64 Mbit/s. TikTok re-encodes the upload to roughly 10-20 Mbit/s regardless,
  // so those bits buy nothing and only make the file awkward to move. crf 19
  // under a 24 Mbit/s ceiling is still a visually lossless source for a
  // re-encode and lands about a quarter of the size.
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
  console.log(`[reel] wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

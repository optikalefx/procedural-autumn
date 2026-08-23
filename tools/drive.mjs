#!/usr/bin/env node
/**
 * Drive test harness.
 *
 *   node tools/drive.mjs                       # all scenarios, low bake res
 *   node tools/drive.mjs --scenario free --seconds 60
 *   node tools/drive.mjs --scenario camera --shots shots/vehicle/cam1
 *   node tools/drive.mjs --res 1536            # final judgement
 *
 * Boots the game in Playwright, presses real keys (so it exercises the same
 * Input path the player does), and reports the camper's trajectory plus every
 * way a driving game can fail: NaN, falling through the world, flipping,
 * getting stuck, or simply not moving.
 *
 * Exit code 0 = all asserted scenarios passed.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const RES = arg('res', '640');
const SECONDS = parseFloat(arg('seconds', '60'));
const ONLY = arg('scenario', null);
const HEADED = argv.includes('--headed');
const CAMDIR = arg('shots', 'shots/vehicle/cam');
// Pin the car: the page picks at random when nothing does, and a capture
// that changed vehicle between runs would not be comparable. --car roamer
// for the other one. See AGENTS.md.
const CAR = arg('car', 'camper');
const URL = `${arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178'))}?res=${RES}&car=${CAR}`;

const KEYS = { throttle: 'KeyW', brake: 'KeyS', left: 'KeyA', right: 'KeyD', handbrake: 'Space' };

function fmt(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : String(n); }

async function main() {
  // One of the two machine-wide capture slots; a drive test is expensive.
  const release = await acquire('drive');
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

  // Seven authors share this dev server. Every time one of them saves, Vite
  // reloads the page, which resets the camper, the camera and the world bake in
  // the middle of a two-minute run — the drive test then reports on whatever
  // state the reload left behind. Stub out the HMR socket so a run is immune to
  // other people working. Pass --hmr to keep the live-reload behaviour.
  if (!argv.includes('--hmr')) {
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
          return {
            readyState: 3, url, protocol: '',
            addEventListener() {}, removeEventListener() {}, send() {}, close() {},
            set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
          };
        }
        return new Real(url, protocols);
      };
      window.WebSocket.prototype = Real.prototype;
    });
  }
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('crash', () => errors.push('PAGE CRASHED'));

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1200);

  const held = new Set();
  const setKeys = async (want) => {
    for (const k of held) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };
  const releaseKeys = async () => setKeys(new Set());

  /**
   * Vite hot-reloads when a peer saves a file, and a reload throws out of every
   * in-flight evaluate. Ride it out rather than dying: wait for the world to
   * finish rebaking, then carry on. Reloads are counted and reported, because a
   * scenario that reloaded halfway through is not evidence of anything.
   */
  let reloads = 0;
  const settle = async () => {
    held.clear();
    await page.waitForFunction(
      () => window.__ready === true && typeof window.__vehicleState === 'function',
      null, { timeout: 240000, polling: 300 },
    ).catch(() => {});
    await page.waitForTimeout(1000);
  };

  /**
   * Every read goes through here. A reload throws out of the in-flight
   * evaluate; worse, a *finished* reload quietly returns undefined because the
   * debug hooks have not been installed yet, so a null result has to be
   * retried exactly like a throw.
   */
  const evalRetry = async (fn, label) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const v = await page.evaluate(fn);
        if (v != null) return v;
      } catch { /* fall through to the settle below */ }
      if (attempt === 0) { reloads++; console.log(`  (page reloaded during ${label}; waiting for the rebake)`); }
      await settle();
    }
    return null;
  };

  const readState = () => evalRetry(() => window.__vehicleState?.() ?? null, 'drive');
  const readCam = () => evalRetry(() => window.__cameraState?.() ?? null, 'camera');

  // ── one sampled run ───────────────────────────────────────────────────────
  async function run(name, seconds, planner) {
    const t0 = Date.now();
    const samples = [];
    let inverted = 0, buried = 0, airborne = 0;
    let last = await readState();
    let dist = 0, maxSpeed = 0, minY = Infinity, maxY = -Infinity, maxWater = 0;

    while ((Date.now() - t0) / 1000 < seconds) {
      const t = (Date.now() - t0) / 1000;
      await setKeys(new Set(planner(t)));
      await page.waitForTimeout(120);
      const s = await readState();
      if (!s) { return { name, fail: 'lost the page (dev-server reload?)', samples }; }
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.speed)) {
        samples.push({ ...s, t }); return { name, fail: 'NaN state', samples };
      }
      // A reload or a teleport shows up as one enormous step; that is not
      // distance travelled, so drop it rather than reporting 3 km of driving.
      const step = Math.hypot(s.x - last.x, s.z - last.z);
      if (step < 25) dist += step;
      maxSpeed = Math.max(maxSpeed, Math.abs(s.speed));
      minY = Math.min(minY, s.y - s.ground);
      maxY = Math.max(maxY, s.y - s.ground);
      maxWater = Math.max(maxWater, s.water);
      if (s.up < 0.25) inverted += 0.12;
      if (s.y < s.ground - 1.4) buried += 0.12;
      if (s.grounded === 0) airborne += 0.12;
      samples.push({ ...s, t });
      last = s;
    }
    await releaseKeys();
    const end = await readState();
    return {
      name, samples, dist, maxSpeed, inverted, buried, airborne, maxWater,
      minClearance: minY, maxClearance: maxY,
      recoveries: end.recoveries, nan: end.nan, end,
    };
  }

  const report = (r) => {
    console.log(`\n── ${r.name} ──`);
    if (r.fail) { console.log(`  FAIL: ${r.fail}`); return; }
    console.log(`  distance ${fmt(r.dist, 1)} m   max speed ${fmt(r.maxSpeed, 1)} m/s (${fmt(r.maxSpeed * 3.6, 0)} km/h)`);
    console.log(`  ride height above ground  min ${fmt(r.minClearance)}  max ${fmt(r.maxClearance)}`);
    console.log(`  inverted ${fmt(r.inverted, 1)} s   airborne ${fmt(r.airborne, 1)} s   buried ${fmt(r.buried, 1)} s`);
    console.log(`  auto-recoveries ${r.recoveries}   NaN events ${r.nan}   max water ${fmt(r.maxWater)} m`);
  };

  const results = {};
  const want = (s) => !ONLY || ONLY === s;

  // ── 1. free drive ────────────────────────────────────────────────────────
  if (want('free')) {
    const plan = (t) => {
      const k = [KEYS.throttle];
      const p = t % 22;
      if (p > 5 && p < 9) k.push(KEYS.left);
      else if (p > 12 && p < 16) k.push(KEYS.right);
      else if (p > 19 && p < 20) { k.length = 0; k.push(KEYS.brake); }
      if (p > 20.4 && p < 21.2) k.push(KEYS.handbrake, KEYS.left);
      return k;
    };
    results.free = await run(`free drive ${SECONDS}s`, SECONDS, plan);
    report(results.free);
  }

  // ── 2. hill climb ────────────────────────────────────────────────────────
  if (want('hill')) {
    const setup = await page.evaluate(() => {
      const W = window.__world, poi = window.__poi;
      const peak = poi.best('peak') ?? { x: 0, z: 0 };
      // Stand back from the peak on drivable ground and aim straight at it.
      let best = null;
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        for (const d of [70, 100, 130, 160, 200]) {
          const x = peak.x + Math.cos(ang) * d, z = peak.z + Math.sin(ang) * d;
          if (!W.isInBounds(x, z)) continue;
          if (W.getWaterDepth(x, z) > 0.05) continue;
          if (W.getSlope(x, z) > 0.45) continue;
          const rise = W.getHeight(peak.x, peak.z) - W.getHeight(x, z);
          const score = rise - Math.abs(d - 130) * 0.05;
          if (!best || score > best.score) best = { x, z, score, rise };
        }
      }
      if (!best) return null;
      const h = Math.atan2(peak.x - best.x, peak.z - best.z);
      window.__vehicleTeleport(best.x, best.z, h);
      return { start: W.getHeight(best.x, best.z), peak: W.getHeight(peak.x, peak.z), rise: best.rise };
    });
    if (setup) {
      await page.waitForTimeout(800);
      results.hill = await run('hill climb 25s', 25, () => [KEYS.throttle]);
      report(results.hill);
      if (!results.hill.fail) {
        results.hill.gain = results.hill.end.ground - setup.start;
        results.hill.rise = setup.rise;
        console.log(`  altitude gain ${fmt(results.hill.gain, 1)} m (target hill rises ${fmt(setup.rise, 1)} m)`);
      }
    } else {
      console.log('\n── hill climb ──\n  skipped: no suitable slope found');
    }
  }

  // ── 3. river crossing ────────────────────────────────────────────────────
  if (want('river')) {
    const setup = await page.evaluate(() => {
      const W = window.__world, poi = window.__poi;
      for (let i = 0; i < 12; i++) {
        const p = poi.best('river', i);
        if (!p) break;
        // aim at the wettest direction, from ~22 m back
        let bestAng = 0, bestR = -1;
        for (let a = 0; a < 32; a++) {
          const ang = (a / 32) * Math.PI * 2;
          let r = 0;
          for (let d = 6; d <= 30; d += 6) r += W.getRiver(p.x + Math.sin(ang) * d, p.z + Math.cos(ang) * d);
          if (r > bestR) { bestR = r; bestAng = ang; }
        }
        const sx = p.x - Math.sin(bestAng) * 18, sz = p.z - Math.cos(bestAng) * 18;
        if (!W.isInBounds(sx, sz) || W.getWaterDepth(sx, sz) > 0.05) continue;
        window.__vehicleTeleport(sx, sz, bestAng);
        return { x: sx, z: sz, ang: bestAng };
      }
      return null;
    });
    if (setup) {
      await page.waitForTimeout(800);
      results.river = await run('river crossing 30s', 30, () => [KEYS.throttle]);
      report(results.river);
    } else {
      console.log('\n── river crossing ──\n  skipped: no river bank found');
    }
  }

  // ── 4. camera: free-look orbit, wheel zoom, and never inside a hill ──────
  // Driven with *real* Playwright mouse input so it exercises the same Input
  // path a player does — calling into CameraRig directly would prove nothing
  // about whether the events ever arrive.
  //
  // The whole scenario is retried if the dev server reloads the page part way
  // through, because a rig that was reset to its defaults mid-sweep will fail
  // assertions that have nothing to do with the camera.
  if (want('camera')) {
    mkdirSync(resolve(CAMDIR), { recursive: true });
    const CX = 450, CY = 260;

    const drag = async (dx, dy, steps = 10) => {
      await page.mouse.move(CX - dx / 2, CY - dy / 2);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(CX - dx / 2 + (dx * i) / steps, CY - dy / 2 + (dy * i) / steps);
      }
      await page.mouse.up();
      await page.waitForTimeout(80);
    };
    const wheel = async (n, delta) => {
      for (let i = 0; i < n; i++) { await page.mouse.wheel(0, delta); await page.waitForTimeout(30); }
      await page.waitForTimeout(500);          // let the damped boom catch up
    };

    async function cameraScenario() {
      const cam = { problems: [], minClearance: Infinity, shots: [], reloaded: false };
      const epoch = await page.evaluate(() => performance.timeOrigin);
      const fresh = async () => (await page.evaluate(() => performance.timeOrigin).catch(() => -1)) === epoch;

      const camState = readCam;
      const grab = async (name) => {
        await page.waitForTimeout(350);
        const s = await camState();
        await page.screenshot({ path: resolve(CAMDIR, `${name}.png`) });
        cam.shots.push(`${name}  zoom ${fmt(s.zoom, 1)}  yaw ${fmt(s.yaw, 2)}  pitch ${fmt(s.pitch, 2)}  clearance ${fmt(s.clearance, 1)}`);
        return s;
      };

      const base = await camState();
      if (!base) { cam.problems.push('camera: no __cameraState hook'); return cam; }
      const LIM = base.limits;

      // 0. what the player actually sees on booting the game and driving off:
      //    the default framing, untouched.
      await setKeys(new Set([KEYS.throttle]));
      await page.waitForTimeout(2600);
      await grab('chase-default');
      await releaseKeys();

      // 1. zoom out to the stop, then back in to the stop
      await wheel(22, 120);
      const out = await grab('zoom-far');
      if (out.zoom < LIM.zoomMax * 0.9) cam.problems.push(`camera: wheel out only reached ${fmt(out.zoom, 1)} m of ${LIM.zoomMax}`);
      await wheel(30, -120);
      const inn = await grab('zoom-near');
      if (inn.zoom > LIM.zoomMin * 1.15) cam.problems.push(`camera: wheel in only reached ${fmt(inn.zoom, 1)} m of ${LIM.zoomMin}`);
      await wheel(9, 120);                    // back to a mid boom

      // 2. yaw orbit
      const y0 = (await camState()).yaw;
      await drag(600, 0);
      const y1 = (await camState()).yaw;
      const dyaw = Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0)));
      if (dyaw < 1.5) cam.problems.push(`camera: 600 px drag only yawed ${fmt(dyaw, 2)} rad`);

      // 3. pitch limits — straight down, then up into the treetops
      await drag(0, 420); await drag(0, 420);
      const top = await grab('pitch-down-from-above');
      if (top.pitch < LIM.pitchMax - 0.02) cam.problems.push(`camera: could not pitch to the top stop (${fmt(top.pitch, 2)})`);
      await drag(0, -700); await drag(0, -700);
      const low = await grab('pitch-up-at-treetops');
      if (low.pitch > LIM.pitchMin + 0.02) cam.problems.push(`camera: could not pitch to the bottom stop (${fmt(low.pitch, 2)})`);
      if (low.pitch < LIM.pitchMin - 1e-6 || top.pitch > LIM.pitchMax + 1e-6) cam.problems.push('camera: pitch escaped its clamp');
      await drag(0, -300);                    // back to something sane

      // 4. drive a full circle of orbit angles at three zoom levels, watching
      //    the gap between the camera and the ground the whole time
      const sunk = [];
      for (const [tag, notches] of [['near', -14], ['mid', 7], ['far', 9]]) {
        await wheel(Math.abs(notches), Math.sign(notches) * 120);
        for (let q = 0; q < 6; q++) {
          await setKeys(new Set([KEYS.throttle]));
          await drag(360, q === 3 ? 120 : 0, 6);
          for (let i = 0; i < 5; i++) {
            await page.waitForTimeout(110);
            const s = await camState();
            if (!s) break;
            cam.minClearance = Math.min(cam.minClearance, s.clearance);
            if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) cam.problems.push('camera: NaN position');
            if (s.clearance < 0.5) sunk.push(`${tag} q${q} clearance ${fmt(s.clearance, 2)}`);
          }
        }
        await grab(`orbit-${tag}`);
      }
      await releaseKeys();
      if (sunk.length) cam.problems.push(`camera: sank into terrain — ${sunk.slice(0, 4).join('; ')}`);

      // 5. recentre while driving...
      // Drag the orbit to a known large offset first, wherever the sweep left
      // it — 0.0042 rad per pixel, and the window is only 900 px wide, so this
      // may take more than one pull.
      const orbitTo = async (target) => {
        for (let i = 0; i < 5; i++) {
          const y = (await camState()).yaw;
          const err = Math.atan2(Math.sin(target - y), Math.cos(target - y));
          if (Math.abs(err) < 0.12) return true;
          await drag(Math.max(-700, Math.min(700, -err / 0.0042)), 0, 8);
        }
        return Math.abs(Math.atan2(Math.sin(target - (await camState()).yaw),
          Math.cos(target - (await camState()).yaw))) < 0.2;
      };
      // Ninety seconds of throttle through the orbit sweep tends to end with the
      // camper nose-first in a bank; put it back on a road so "while driving"
      // means something.
      await page.evaluate(() => {
        const p = window.__poi?.best('road') ?? window.__poi?.best('meadow');
        if (p) window.__vehicleTeleport(p.x, p.z, p.yaw ?? 0);
      });
      await page.waitForTimeout(1000);
      if (!await orbitTo(2.0)) cam.problems.push('camera: could not drag the orbit to a known angle');
      const beforeDrive = (await camState()).yaw;
      await setKeys(new Set([KEYS.throttle]));
      let droveAt = 0;
      for (let i = 0; i < 24; i++) {
        await page.waitForTimeout(200);
        droveAt = Math.max(droveAt, Math.abs((await readState())?.speed ?? 0));
      }
      const afterDrive = (await camState()).yaw;
      if (droveAt < 5) cam.problems.push(`camera: could not get moving for the recentre test (${fmt(droveAt, 1)} m/s)`);
      else if (Math.abs(afterDrive) > 0.3) {
        cam.problems.push(`camera: did not recentre while driving (${fmt(beforeDrive, 2)} -> ${fmt(afterDrive, 2)} rad at ${fmt(droveAt, 1)} m/s)`);
      }

      // ...but hold the framing when the player has actually stopped. Handbrake
      // on, because a camper rolling downhill at walking pace is *moving* and is
      // supposed to recentre.
      await setKeys(new Set([KEYS.brake, KEYS.handbrake]));
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(200);
        const vs = await readState();
        if (vs && Math.abs(vs.speed) < 0.4) break;
      }
      await setKeys(new Set([KEYS.handbrake]));
      await page.waitForTimeout(400);
      await drag(500, 0);
      const parked0 = (await camState()).yaw;
      await page.waitForTimeout(4500);
      const parked1 = (await camState()).yaw;
      const parkedSpeed = Math.abs((await readState())?.speed ?? 9);
      await releaseKeys();
      if (parkedSpeed > 0.6) cam.problems.push(`camera: could not park for the parked test (${fmt(parkedSpeed, 2)} m/s)`);
      else if (Math.abs(parked1 - parked0) > 0.05) {
        cam.problems.push(`camera: parked orbit drifted ${fmt(parked1 - parked0, 3)} rad`);
      }

      // 6. the other camera mode exists and does not throw. Nothing else in the
      //    suite ever presses C, so a broken photo mode would ship silently.
      for (const mode of ['orbit', 'chase']) {
        await page.keyboard.press('KeyC');
        await page.waitForTimeout(900);
        const s2 = await camState();
        if (!s2 || s2.mode !== mode) cam.problems.push(`camera: KeyC did not reach ${mode} mode (got ${s2?.mode})`);
        else if (!Number.isFinite(s2.y) || s2.clearance < -1.5) {
          cam.problems.push(`camera: ${mode} mode put the camera at clearance ${fmt(s2?.clearance, 2)}`);
        }
        if (mode !== 'chase') await grab(`mode-${mode}`);
      }

      cam.report = [
        `  min clearance over the sweep ${fmt(cam.minClearance, 2)} m`,
        `  recentre while driving ${fmt(beforeDrive, 2)} -> ${fmt(afterDrive, 2)} rad at ${fmt(droveAt, 1)} m/s` +
        `   parked ${fmt(parked0, 2)} -> ${fmt(parked1, 2)} rad at ${fmt(parkedSpeed, 2)} m/s`,
        ...cam.shots.map((s) => '  ' + s),
        `  frames in ${CAMDIR}`,
      ];
      cam.reloaded = !(await fresh());
      return cam;
    }

    console.log('\n── camera ──');
    let cam = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      cam = await cameraScenario();
      if (!cam.reloaded) break;
      console.log(`  (the page reloaded during the sweep — starting the camera scenario again)`);
      await settle();
    }
    for (const line of cam.report ?? []) console.log(line);
    if (cam.reloaded) cam.problems.push('camera: could not complete a sweep without the page reloading');
    results.camera = cam;
  }

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    calls: window.__engine?.renderer?.info?.render?.calls ?? null,
    tris: window.__engine?.renderer?.info?.render?.triangles ?? null,
  }));
  if (reloads) console.log(`\nNOTE: the page reloaded ${reloads}x mid-test (a peer saved a file?)`);
  console.log(`\nfps ${stats.fps}  drawCalls ${stats.calls}  triangles ${stats.tris}`);
  if (errors.length) console.log('page-errors:\n ' + errors.slice(0, 10).join('\n '));

  // ── assertions ───────────────────────────────────────────────────────────
  const problems = [];
  const R = results;
  if (R.free) {
    if (R.free.fail) problems.push('free: ' + R.free.fail);
    else {
      if (R.free.dist < 220) problems.push(`free: only travelled ${fmt(R.free.dist, 0)} m in ${SECONDS}s`);
      if (R.free.nan) problems.push(`free: ${R.free.nan} NaN events`);
      if (R.free.buried > 0.5) problems.push(`free: fell through terrain for ${fmt(R.free.buried, 1)} s`);
      if (R.free.inverted > 3) problems.push(`free: inverted for ${fmt(R.free.inverted, 1)} s`);
      if (R.free.recoveries > 2) problems.push(`free: ${R.free.recoveries} auto-recoveries`);
      if (R.free.maxSpeed < 8) problems.push(`free: top speed only ${fmt(R.free.maxSpeed, 1)} m/s`);
    }
  }
  if (R.hill?.fail) problems.push('hill: ' + R.hill.fail);
  // Judge the climb against the hill that was actually found, not a fixed
  // number: some seeds simply have no 100 m mountain within reach of a road.
  else if (R.hill && R.hill.gain < Math.min(8, R.hill.rise * 0.6)) {
    problems.push(`hill: climbed only ${fmt(R.hill.gain, 1)} m of an available ${fmt(R.hill.rise, 1)} m`);
  }
  if (R.river?.fail) problems.push('river: ' + R.river.fail);
  if (R.river && !R.river.fail) {
    if (R.river.maxWater < 0.2) problems.push('river: never entered water');
    if (R.river.nan) problems.push('river: NaN events');
    if (R.river.buried > 0.6) problems.push('river: fell through the river bed');
  }
  if (R.camera) problems.push(...R.camera.problems);
  if (errors.length) problems.push(`${errors.length} console errors`);

  console.log('\n' + (problems.length ? 'PROBLEMS:\n  - ' + problems.join('\n  - ') : 'ALL CLEAR'));
  await browser.close();
  release();
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

#!/usr/bin/env node
/**
 * holdtest — does the brake hold actually hold, on a hill?
 *
 *   node tools/_scratch/holdtest.mjs                 # slope sweep + release tests
 *   node tools/_scratch/holdtest.mjs --seconds 10
 *   node tools/_scratch/holdtest.mjs --only release
 *
 * The player's spec has one clause a screenshot cannot check and a feel test
 * cannot check either: "don't allow the vehicle to move at all. Even if it's on
 * a hill." So this parks the camper on a measured gradient, engages the hold,
 * lets go of every key, and measures how far it moves over ten seconds. Then it
 * repeats that across the whole range of gradients the valley has, including
 * ones far beyond anything drivable.
 *
 * The gradient is measured here rather than taken from `world.getSlope`, whose
 * units are the terrain system's business: it is rise over run across a 4 m
 * span of `getHeight`, so 0.36 is a 20-degree slope and 1.00 is 45 degrees, and
 * the number in the report means the same thing to everybody.
 *
 * The three release assertions matter as much as the displacement:
 *   · throttle releases the hold and the camper drives away;
 *   · steering does NOT release it — the player said *moving* the car does,
 *     and lining up a photograph is not moving it;
 *   · the release does not jolt. Measured as the largest single-frame step in
 *     the half second after release, against the same measure while driving
 *     normally: a body that was pinned and let go with stored energy in it
 *     shows up as one frame of several times the normal step.
 *
 * Exit 0 = every assertion passed.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const HOLD_SECONDS = parseFloat(arg('seconds', '10'));
const RES = arg('res', '640');
const ONLY = arg('only', null);
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;
const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const deg = (g) => (Math.atan(g) * 180) / Math.PI;

// Gradients to sweep, rise/run. 0.65 is the steepest the rescue button will
// park you on; 0.70 is the 35-degree slope the grade assist was tuned for;
// 1.00 is 45 degrees and 1.30 is 52, both well past anything a camper drives.
const TARGETS = [0.00, 0.10, 0.20, 0.30, 0.40, 0.50, 0.65, 0.80, 1.00, 1.30];

const problems = [];
const fail = (m) => { problems.push(m); console.log(`  FAIL  ${m}`); };

async function main() {
  const release = await acquire('holdtest');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  // Seven authors share the dev server; a save from any of them reloads the
  // page mid-run and resets the camper. Same stub drive.mjs uses.
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleState === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ── in-page helpers ───────────────────────────────────────────────────────
  await page.evaluate(() => {
    const W = window.__world;

    /** Rise over run across a 4 m span, which is a bit over the wheelbase. */
    const grad = (x, z) => {
      const d = 2.0;
      const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
      const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
      return Math.hypot(gx, gz);
    };
    window.__grad = grad;

    /**
     * One site per requested gradient: dry, in bounds, and a *continuous*
     * surface. The last one is not fussiness — a camper teleported onto a ledge
     * lands half inside a cliff and gets auto-recovered, and the test would
     * then be measuring the recovery rather than the hold.
     */
    window.__holdSites = (targets) => {
      const cands = [];
      const R = 1400;
      for (let i = 0; i < 60000; i++) {
        const x = (Math.random() * 2 - 1) * R, z = (Math.random() * 2 - 1) * R;
        if (!W.isInBounds(x, z)) continue;
        if (W.getWaterDepth(x, z) > 0.02) continue;
        // The footprint has to be a *plane*, not merely a place with the right
        // average slope. Residual from the local tangent plane, not absolute
        // height change: a 2.2 m reach on a 1.3 gradient is a legitimate 2.9 m
        // of rise, so any absolute tolerance either rejects every steep site or
        // (measured, and it cost a whole confusing sweep) admits cliff edges the
        // camper lands *inside* — where it wedges in the heightfield with no
        // wheel in contact, and what gets measured is the wedge, not the hold.
        const h0 = W.getHeight(x, z);
        const d = 2.0;
        const gx = (W.getHeight(x + d, z) - W.getHeight(x - d, z)) / (2 * d);
        const gz = (W.getHeight(x, z + d) - W.getHeight(x, z - d)) / (2 * d);
        let resid = 0, bad = false;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const dx = Math.cos(ang) * 2.2, dz = Math.sin(ang) * 2.2;
          const px = x + dx, pz = z + dz;
          if (!W.isInBounds(px, pz) || W.getWaterDepth(px, pz) > 0.02) { bad = true; break; }
          resid = Math.max(resid, Math.abs(W.getHeight(px, pz) - (h0 + gx * dx + gz * dz)));
        }
        if (bad || resid > 0.45) continue;
        cands.push({ x, z, g: Math.hypot(gx, gz), resid });
      }
      return targets.map((t) => {
        let best = null;
        for (const c of cands) {
          const d = Math.abs(c.g - t);
          if (!best || d < best.d) best = { ...c, d, target: t };
        }
        return best;
      });
    };

    /** Per-frame trajectory recorder — finer than a Playwright round trip. */
    // `until` names a state field that ends the recording early once it goes
    // truthy — plus a few frames after, so the transition itself is captured.
    window.__holdRec = (ms, until = null) => new Promise((res) => {
      const out = [];
      const t0 = performance.now();
      let tail = -1;
      const tick = () => {
        const s = window.__vehicleState();
        out.push({
          t: (performance.now() - t0) / 1000,
          x: s.x, y: s.y, z: s.z, speed: s.speed,
          hold: s.hold, held: s.held, drift: s.holdDrift, armedFor: s.holdArmedFor,
          up: s.up, grounded: s.grounded, rec: s.recoveries, nan: s.nan,
        });
        if (until && s[until] && tail < 0) tail = 4;
        if (tail > 0) tail--;
        const done = (performance.now() - t0 >= ms) || tail === 0;
        if (done) res(out); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  const state = () => page.evaluate(() => window.__vehicleState());
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  /** Largest single-frame step in a window of samples — the jolt measure. */
  const maxStep = (rows) => {
    let m = 0;
    for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.hypot(
      rows[i].x - rows[i - 1].x, rows[i].y - rows[i - 1].y, rows[i].z - rows[i - 1].z));
    return m;
  };

  const sites = await page.evaluate((t) => window.__holdSites(t), TARGETS);

  // ── 1. slope sweep ────────────────────────────────────────────────────────
  //
  // The protocol is the player's own gesture: arrive somewhere, let the camper
  // come to rest, tap Space once, take your hands off the keyboard.
  //
  // Letting it rest first is not letting the feature off the hook — it is the
  // difference between a hold and a catch. A camper teleported onto a steep
  // face arrives falling and bounces down it; engaging the lock mid-bounce is
  // the one thing the design must not do. So a site the camper cannot come to
  // rest on in REST_WAIT is reported as unrestable and the hold is not asserted
  // there: nothing can be parked somewhere nothing can be parked.
  //
  // Two phases are then measured separately, because they are two different
  // promises:
  //   ARM → LATCH.  Still rolling. The brake gain brings it to rest and the
  //     lock closes. Distance travelled here is a stopping distance.
  //   LATCHED.  Every key released. This is the clause under test — "don't
  //     allow the vehicle to move at all" — and anything but exactly zero is a
  //     failure, on any gradient.
  const REST_WAIT = 8;
  const sweep = [];
  if (!ONLY || ONLY === 'sweep') {
    console.log(`\n── slope sweep: settle, tap Space, ${HOLD_SECONDS}s hands off ──`);
    console.log('  grade   deg   rest(s)  arm→latch  creep(m)  latch(m/s)  drift(m)  moved(m)  verdict');
    for (const site of sites) {
      if (!site) continue;
      await page.evaluate((s) => window.__vehicleTeleport(s.x, s.z, Math.random() * 6.28), site);

      // Come to rest on its own, with nothing pressed.
      let rest = null, restT = NaN;
      for (let w = 0; w < REST_WAIT * 10; w++) {
        await page.waitForTimeout(100);
        const st = await state();
        if (st.grounded >= 3 && Math.abs(st.speed) < 0.35) { rest = st; restT = w / 10; break; }
      }
      if (!rest) {
        const st = await state();
        console.log(`  ${f(site.g, 2).padStart(5)}  ${f(deg(site.g), 1).padStart(5)}` +
          `        —   no rest in ${REST_WAIT}s: grounded ${st.grounded}, ${f(st.speed)} m/s, ` +
          `up ${f(st.up)}, ${f(st.y - st.ground, 2)} m above ground, water ${f(st.water, 2)}, ` +
          `slid ${f(Math.hypot(st.x - site.x, st.z - site.z), 1)} m`);
        sweep.push({ site, unrestable: true, moved: 0, creep: 0, latchT: 0 });
        continue;
      }

      // One tap, the way a player does it.
      const armRec = page.evaluate(() => window.__holdRec(4000, 'held'));
      await page.keyboard.down('Space');
      await page.waitForTimeout(70);
      await page.keyboard.up('Space');
      const armRows = await armRec;

      const iArm = armRows.findIndex((r) => r.hold);
      const iLatch = armRows.findIndex((r) => r.held);
      const latchT = iLatch < 0 ? NaN : armRows[iLatch].t - armRows[Math.max(iArm, 0)].t;
      const creep = iLatch < 0 ? NaN : dist(armRows[Math.max(iArm, 0)], armRows[iLatch]);

      const afterKey = await state();
      if (!afterKey.hold) fail(`grade ${f(site.g, 2)}: a tap of Space at rest did not arm the hold`);
      if (!afterKey.held) fail(`grade ${f(site.g, 2)}: armed but never latched in 4 s`);

      // The assertion: latched, every key up, ten seconds.
      const rows = await page.evaluate((ms) => window.__holdRec(ms), HOLD_SECONDS * 1000);
      const moved = dist(rows[0], rows[rows.length - 1]);
      let maxSpeed = 0, maxDrift = 0, brokeAt = -1;
      for (const r of rows) {
        maxSpeed = Math.max(maxSpeed, Math.abs(r.speed));
        maxDrift = Math.max(maxDrift, r.drift ?? 0);
        if (!r.held && brokeAt < 0) brokeAt = r.t;
      }
      const ok = moved === 0 && maxSpeed === 0 && brokeAt < 0 && afterKey.held;
      sweep.push({ site, moved, maxSpeed, maxDrift, creep, latchT });
      console.log(`  ${f(site.g, 2).padStart(5)}  ${f(deg(site.g), 1).padStart(5)}  ` +
        `${f(restT, 1).padStart(6)}   ${f(latchT, 2).padStart(8)}s ${f(creep, 4).padStart(9)}  ` +
        `${f(afterKey.holdLatchV ?? 0).padStart(9)}  ${f(maxDrift, 6).padStart(8)}  ` +
        `${f(moved, 6).padStart(8)}  ${ok ? 'held' : 'MOVED'}`);
      if (moved !== 0) fail(`grade ${f(site.g, 2)} (${f(deg(site.g), 1)}°): moved ${f(moved, 6)} m in ${HOLD_SECONDS}s latched — the spec is zero`);
      if (brokeAt >= 0) fail(`grade ${f(site.g, 2)}: hold let go on its own at t=${f(brokeAt, 1)}s`);
    }
  }

  // ── 1b. engaged while still rolling ───────────────────────────────────────
  // The other half of the gesture: Space pressed on the move, below the
  // threshold, on the steepest ground the camper will rest on. This is where
  // the arm→latch stopping distance actually gets spent, so it is measured
  // rather than assumed.
  if (!ONLY || ONLY === 'sweep' || ONLY === 'rolling') {
    const site = [...sites].reverse().find((s) => s && s.g <= 0.72) ?? sites[0];
    console.log(`\n── engaged while rolling, ${f(site.g, 2)} gradient (${f(deg(site.g), 1)}°) ──`);
    await page.evaluate((s) => window.__vehicleTeleport(s.x, s.z, 0), site);
    await page.waitForTimeout(2500);
    // Drive off, then brake down to under the threshold and tap Space while
    // still rolling. Coasting is not enough: released on a hill the camper
    // simply keeps accelerating, which is the whole reason this feature exists.
    // The brake is released before Space, because a pedal is a release.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2200);
    await page.keyboard.up('KeyW');
    await page.keyboard.down('KeyS');
    let st = await state(), spun = 0;
    while (Math.abs(st.speed) > 1.8 && spun < 10000) {
      await page.waitForTimeout(60); spun += 60; st = await state();
    }
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(60);
    st = await state();
    const atPress = Math.abs(st.speed);
    if (atPress > 2.36) fail(`rolling probe could not get under the threshold (${f(atPress)} m/s)`);
    const rec = page.evaluate(() => window.__holdRec(5000, 'held'));
    await page.keyboard.down('Space');
    await page.waitForTimeout(70);
    await page.keyboard.up('Space');
    const rows = await rec;
    const iA = rows.findIndex((r) => r.hold), iL = rows.findIndex((r) => r.held);
    if (iL < 0) fail(`rolling engage at ${f(atPress)} m/s never latched`);
    else {
      const after = await state();
      console.log(`  pressed at ${f(atPress)} m/s (${f(atPress * 3.6, 1)} km/h)` +
        `   latched ${f(rows[iL].t - rows[Math.max(iA, 0)].t, 2)}s later` +
        ` at ${f(after.holdLatchV ?? 0)} m/s   stopping distance ${f(dist(rows[Math.max(iA, 0)], rows[iL]), 3)} m`);
      if ((after.holdLatchV ?? 0) > 2.36) fail(`latched at ${f(after.holdLatchV)} m/s, above the arming threshold — that is a wall, not a brake`);
      const post = await page.evaluate((ms) => window.__holdRec(ms), 4000);
      const moved2 = dist(post[0], post[post.length - 1]);
      console.log(`  then 4s hands off: moved ${f(moved2, 6)} m`);
      if (moved2 !== 0) fail(`after a rolling engage the camper moved ${f(moved2, 6)} m`);
    }
  }

  // ── 2. release behaviour ──────────────────────────────────────────────────
  if (!ONLY || ONLY === 'release') {
    // A moderate hill, so a failure to hold shows up as motion rather than as
    // nothing happening on the flat.
    const site = sites.find((s) => s && s.g > 0.25) ?? sites[sites.length - 1];
    console.log(`\n── release, on a ${f(site.g, 2)} gradient (${f(deg(site.g), 1)}°) ──`);

    const engage = async () => {
      await page.evaluate((s) => window.__vehicleTeleport(s.x, s.z, 0), site);
      await page.waitForTimeout(300);
      await page.keyboard.down('Space');
      await page.waitForTimeout(1800);
      await page.keyboard.up('Space');
      await page.waitForTimeout(200);
      const s = await state();
      if (!s.held) fail('release setup: could not engage the hold');
      return s;
    };

    // ── 2a. steering does not release it ────────────────────────────────────
    let s0 = await engage();
    const steerRec = page.evaluate((ms) => window.__holdRec(ms), 2600);
    await page.waitForTimeout(300);
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyA');
    await page.waitForTimeout(200);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyD');
    const steerRows = await steerRec;
    const steerMoved = dist(steerRows[0], steerRows[steerRows.length - 1]);
    const steerHeld = steerRows.every((r) => r.held);
    console.log(`  steering:  held throughout ${steerHeld}   moved ${f(steerMoved, 6)} m`);
    if (!steerHeld) fail('steering released the brake hold — steering a parked camper is not moving it');
    if (steerMoved !== 0) fail(`steering moved the held camper ${f(steerMoved, 6)} m`);

    // ── 2b. throttle releases it, and does not jolt ─────────────────────────
    s0 = await engage();
    const thrRec = page.evaluate((ms) => window.__holdRec(ms), 3000);
    await page.waitForTimeout(600);
    await page.keyboard.down('KeyW');
    const thrRows = await thrRec;
    await page.keyboard.up('KeyW');
    const iRel = thrRows.findIndex((r) => !r.held);
    const iReq = thrRows.findIndex((r) => !r.hold);
    if (iRel < 0) { fail('throttle did not release the brake hold'); }
    else {
      const relT = thrRows[iRel].t, reqT = thrRows[Math.max(iReq, 0)].t;
      // The half second on either side of the release. A pinned body letting go
      // with stored energy shows up here and nowhere else.
      const before = thrRows.filter((r) => r.t >= relT - 0.5 && r.t <= relT);
      const burst = thrRows.filter((r) => r.t >= relT && r.t <= relT + 0.5);
      const cruise = thrRows.filter((r) => r.t >= relT + 1.2);
      const jolt = maxStep(burst), normal = maxStep(cruise);
      const drove = dist(thrRows[iRel], thrRows[thrRows.length - 1]);
      console.log(`  throttle:  released ${f(relT - reqT, 3)}s after the request` +
        `   drove ${f(drove, 2)} m`);
      console.log(`  jolt:      held ${f(maxStep(before), 6)} m/frame` +
        `   release burst ${f(jolt, 5)}   cruising ${f(normal, 5)} m/frame`);
      if (drove < 1.0) fail(`throttle released the hold but the camper only moved ${f(drove, 2)} m`);
      // A jolt is a single frame that outruns steady driving. Anything at or
      // below the cruising step is the camper simply setting off.
      if (jolt > normal * 1.35 + 0.02) {
        fail(`release jolted: ${f(jolt, 4)} m in one frame against ${f(normal, 4)} m cruising`);
      }
      if (thrRows[iRel].speed !== 0 && Math.abs(thrRows[iRel].speed) > 0.05) {
        fail(`released with ${f(thrRows[iRel].speed)} m/s already on the clock — that is stored energy`);
      }
    }

    // ── 2c. the threshold ───────────────────────────────────────────────────
    // Space at speed must still be a handbrake and must not latch. Driven with
    // real keys down a slope so there is genuine speed to arm at.
    // Above it: a tap must still be nothing but a handbrake.
    await page.evaluate((s) => window.__vehicleTeleport(s.x, s.z, 0), site);
    await page.waitForTimeout(600);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(3500);
    await page.keyboard.up('KeyW');
    const fast = await state();
    await page.keyboard.down('Space');
    await page.waitForTimeout(60);
    const tappedFast = await state();
    await page.keyboard.up('Space');
    const fastKmh = Math.abs(fast.speed) * 3.6;
    console.log(`  threshold: tapped Space at ${f(fastKmh, 1)} km/h → hold ${tappedFast.hold}`);
    if (fastKmh <= 8.5) fail(`the above-threshold probe only reached ${f(fastKmh, 1)} km/h — it proves nothing`);
    else if (tappedFast.hold) fail(`hold armed at ${f(fastKmh, 1)} km/h, above the 8.5 km/h threshold`);
    await page.waitForTimeout(600);

    // Below it: coast down to a crawl and tap once. This is the player's own
    // gesture — roll to a stop at a viewpoint and touch the handbrake — and it
    // has to latch from a *tap*, not from the key being held.
    await page.evaluate((s) => window.__vehicleTeleport(s.x, s.z, 0), site);
    await page.waitForTimeout(1400);
    let slow = await state(), waited = 0;
    while (Math.abs(slow.speed) * 3.6 > 8.0 && waited < 6000) {
      await page.waitForTimeout(100); waited += 100; slow = await state();
    }
    const slowKmh = Math.abs(slow.speed) * 3.6;
    await page.keyboard.down('Space');
    await page.waitForTimeout(60);
    await page.keyboard.up('Space');
    await page.waitForTimeout(1400);
    const latched = await state();
    console.log(`  threshold: tapped Space at ${f(slowKmh, 1)} km/h → hold ${latched.hold}, latched ${latched.held}`);
    if (slowKmh > 8.5) fail(`the below-threshold probe never got under 8.5 km/h (${f(slowKmh, 1)})`);
    else {
      if (!latched.hold) fail(`a tap at ${f(slowKmh, 1)} km/h did not arm the hold`);
      if (!latched.held) fail(`a tap at ${f(slowKmh, 1)} km/h armed but never latched`);
    }
    await page.waitForTimeout(300);
  }

  // ── report ────────────────────────────────────────────────────────────────
  const end = await state();
  console.log(`\n  auto-recoveries ${end.recoveries}   NaN events ${end.nan}`);
  if (errors.length) {
    console.log(`\n  page errors (${errors.length}):`);
    for (const e of errors.slice(0, 8)) console.log(`    ${e}`);
  }
  const held = sweep.filter((r) => !r.unrestable);
  for (const r of sweep.filter((x) => x.unrestable)) {
    console.log(`  note: grade ${f(r.site.g, 2)} (${f(deg(r.site.g), 1)}°) — the camper will not rest there at all`);
  }
  if (held.length) {
    const worst = held.reduce((a, b) => (b.moved > a.moved ? b : a));
    console.log(`  worst displacement while latched: ${f(worst.moved, 6)} m ` +
      `at grade ${f(worst.site.g, 2)} (${f(deg(worst.site.g), 1)}°)`);
    const wc = held.reduce((a, b) => ((b.creep > a.creep) ? b : a));
    console.log(`  worst arm→latch creep:           ${f(wc.creep, 4)} m in ${f(wc.latchT, 2)}s ` +
      `at grade ${f(wc.site.g, 2)} (${f(deg(wc.site.g), 1)}°)`);
  }
  console.log(problems.length ? `\n${problems.length} FAILURE(S)` : '\nall assertions passed');

  await browser.close();
  release();
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

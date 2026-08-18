#!/usr/bin/env node
/**
 * Drive test harness.
 *
 *   node tools/drive.mjs                       # all scenarios, low bake res
 *   node tools/drive.mjs --scenario free --seconds 60
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
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;

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
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

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

  /** Vite hot-reloads when a peer saves a file; ride it out rather than dying. */
  const readState = async (pg) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await pg.evaluate(() => window.__vehicleState?.() ?? null); }
      catch { await pg.waitForFunction(() => typeof window.__vehicleState === 'function',
        null, { timeout: 240000, polling: 300 }).catch(() => {}); held.clear(); }
    }
    return null;
  };

  // ── one sampled run ───────────────────────────────────────────────────────
  async function run(name, seconds, planner) {
    const t0 = Date.now();
    const samples = [];
    let inverted = 0, buried = 0, airborne = 0;
    let last = await readState(page);
    let dist = 0, maxSpeed = 0, minY = Infinity, maxY = -Infinity, maxWater = 0;

    while ((Date.now() - t0) / 1000 < seconds) {
      const t = (Date.now() - t0) / 1000;
      await setKeys(new Set(planner(t)));
      await page.waitForTimeout(120);
      const s = await readState(page);
      if (!s) { return { name, fail: 'lost the page (dev-server reload?)', samples }; }
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.speed)) {
        samples.push({ ...s, t }); return { name, fail: 'NaN state', samples };
      }
      dist += Math.hypot(s.x - last.x, s.z - last.z);
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
    const end = await readState(page);
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
        for (const d of [110, 140, 170]) {
          const x = peak.x + Math.cos(ang) * d, z = peak.z + Math.sin(ang) * d;
          if (!W.isInBounds(x, z)) continue;
          if (W.getWaterDepth(x, z) > 0.05) continue;
          if (W.getSlope(x, z) > 0.45) continue;
          const rise = W.getHeight(peak.x, peak.z) - W.getHeight(x, z);
          const score = rise - Math.abs(d - 140) * 0.1;
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
      const gain = results.hill.end.ground - setup.start;
      results.hill.gain = gain;
      report(results.hill);
      console.log(`  altitude gain ${fmt(gain, 1)} m (target hill rises ${fmt(setup.rise, 1)} m)`);
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

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    calls: window.__engine?.renderer?.info?.render?.calls ?? null,
    tris: window.__engine?.renderer?.info?.render?.triangles ?? null,
  }));
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
  if (R.hill && !R.hill.fail && R.hill.gain < 8) problems.push(`hill: climbed only ${fmt(R.hill.gain, 1)} m`);
  if (R.river && !R.river.fail) {
    if (R.river.maxWater < 0.2) problems.push('river: never entered water');
    if (R.river.nan) problems.push('river: NaN events');
    if (R.river.buried > 0.6) problems.push('river: fell through the river bed');
  }
  if (errors.length) problems.push(`${errors.length} console errors`);

  console.log('\n' + (problems.length ? 'PROBLEMS:\n  - ' + problems.join('\n  - ') : 'ALL CLEAR'));
  await browser.close();
  release();
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

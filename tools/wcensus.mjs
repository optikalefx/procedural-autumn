#!/usr/bin/env node
/**
 * Wildlife density census.
 *
 * "Something visible within a minute of driving, never a zoo" is a number, not
 * an opinion, and a screenshot cannot measure it. This drives the camera along
 * the world's dirt roads in fixed steps and, at each step, counts how many
 * animals are alive, how many are actually inside the view cone, and how far
 * the nearest one is — then reports the fraction of the drive with an animal in
 * sight and the mean gap between sightings in seconds at a typical 13 m/s.
 *
 *   node tools/wcensus.mjs --step 30 --seed 20261018
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const STEP = parseFloat(arg('step', '25'));
const RES = arg('res', '768');
const SEED = arg('seed', null);
const SPEED = parseFloat(arg('speed', '13'));
// Time of day. Left alone by default — the drive is scored in daylight, which
// is what it has always meant. Nocturnal species (the raccoon) do not exist at
// all at the default hour, so scoring them needs `--hour 23`.
const HOUR = arg('hour', null);

await acquire('wcensus');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${process.env.AUTUMN_URL || 'http://localhost:5178'}?res=${RES}${SEED ? `&seed=${SEED}` : ''}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await page.evaluate(async (P) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  window.__forceCamera = true;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  if (P.HOUR !== null) { window.__lighting.hour = +P.HOUR; window.__lighting.cycleSpeed = 0; }

  const roads = W.roads ?? [];
  const cam = e.camera;
  cam.fov = 55; cam.updateProjectionMatrix();
  const fr = new T.Frustum(), pm = new T.Matrix4(), sp = new T.Sphere();

  const samples = [];
  // From the live pool, not a hardcoded list — the hardcoded version silently
  // reported `null` for any species added after it was written.
  const perSpecies = Object.fromEntries(Object.keys(wl.pool).map((k) => [k, 0]));
  let steps = 0, seen = 0, seenClose = 0, seenNoticeable = 0, birdsSeen = 0;
  // Nothing may ever stand in standing water. Measured, not assumed.
  let maxDepth = 0, wetSamples = 0, maxSlope = 0;

  const best = { inView: -1, x: 0, z: 0, yaw: 0 };
  for (const road of roads) {
    samples.push(null);          // road boundary: dry spells do not span roads
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i], b = road[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.round(len / P.STEP));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const yaw = Math.atan2(b.x - a.x, b.z - a.z);
        cam.position.set(x, W.getHeight(x, z) + 2.2, z);
        cam.lookAt(x + Math.sin(yaw) * 20, W.getHeight(x, z) + 2.0, z + Math.cos(yaw) * 20);
        // Two frames: one to let the 0.3 s scan fire, one to settle.
        e._loop(); e._loop();

        pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        fr.setFromProjectionMatrix(pm);
        let inView = 0, nearest = 1e9, close = 0, mid = 0;
        for (const key of Object.keys(wl.pool)) {
          for (const per of wl.pool[key]) {
            for (const A of per) {
              if (!A.active) continue;
              const dep = W.getWaterDepth(A.brain.pos.x, A.brain.pos.z);
              if (dep > maxDepth) maxDepth = dep;
              if (dep > 0.15) wetSamples++;
              maxSlope = Math.max(maxSlope, W.getSlope(A.brain.pos.x, A.brain.pos.z));
              const d = Math.hypot(A.brain.pos.x - x, A.brain.pos.z - z);
              sp.center.set(A.brain.pos.x, A.brain.pos.y + 0.8, A.brain.pos.z);
              sp.radius = 1.5;
              // Under 220 m a deer is still a readable speck; past that it is fog.
              if (d < 220 && fr.intersectsSphere(sp)) {
                inView++; perSpecies[key]++; nearest = Math.min(nearest, d);
                // Bucket by apparent size, because "intersects the frustum at
                // 220 m" is not a sighting. At the player's 870 px viewport and
                // a 55 deg vertical fov, a 1.5 m deer subtends 870*1.5/(2*d*
                // tan(27.5)) px: 21 px at 60 m, 12 px at 100 m, 7 px at 172 m —
                // and the far end of that is a fog-coloured speck against gold
                // grass. The old headline number counted all three the same,
                // which is how this tool reported an animal in view 45% of the
                // time while the player drove the valley and found nothing.
                if (d < 70) close++; else if (d < 140) mid++;
              }
            }
          }
        }
        for (const F of wl.birds.flocks) {
          sp.center.set(F.cx, F.cy, F.cz); sp.radius = 40;
          if (fr.intersectsSphere(sp)) { birdsSeen++; break; }
        }
        steps++;
        if (inView > 0) seen++;
        if (close > 0) seenClose++;
        if (close + mid > 0) seenNoticeable++;
        samples.push({ inView, close, mid, nearest: nearest > 1e8 ? -1 : Math.round(nearest), live: wl.stats.live });
        if (inView > best.inView) { best.inView = inView; best.x = x; best.z = z; best.yaw = yaw; }
      }
    }
  }

  // Longest run of consecutive samples with nothing in sight. Computed over a
  // chosen sighting test, so the same drive can be scored strictly or loosely.
  const gapStats = (hit) => {
    let gap = 0, worst = 0;
    const gaps = [];
    for (const s of samples) {
      if (s === null) { if (gap) gaps.push(gap); gap = 0; continue; }
      if (!hit(s)) { gap++; worst = Math.max(worst, gap); }
      else { if (gap) gaps.push(gap); gap = 0; }
    }
    if (gap) gaps.push(gap);
    gaps.sort((a, b) => a - b);
    const q = (f) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))] : 0);
    const sec = (n) => +((n * P.STEP) / P.SPEED).toFixed(1);
    return { median: sec(q(0.5)), p90: sec(q(0.9)), worst: sec(worst) };
  };
  const gapAny        = gapStats((s) => s.inView > 0);
  const gapNoticeable = gapStats((s) => s.close + s.mid > 0);
  const gapClose      = gapStats((s) => s.close > 0);

  const real = samples.filter(Boolean);
  const liveMax = real.reduce((m, s) => Math.max(m, s.live), 0);
  const inViewMax = real.reduce((m, s) => Math.max(m, s.inView), 0);
  const meanLive = real.reduce((m, s) => m + s.live, 0) / Math.max(1, real.length);

  // ── what wildlife actually costs, measured at the busiest point on the map ──
  cam.position.set(best.x, W.getHeight(best.x, best.z) + 2.2, best.z);
  cam.lookAt(best.x + Math.sin(best.yaw) * 20, W.getHeight(best.x, best.z) + 2.0, best.z + Math.cos(best.yaw) * 20);
  // Long enough for the 0.3 s streaming scan to fire and the terrain LOD to
  // settle, or the "with wildlife" and "without" frames are not comparable.
  for (let i = 0; i < 60; i++) e._loop();
  const info = e.renderer.info.render;
  e._loop();
  const withW = { calls: info.calls, tris: info.triangles };
  wl.group.visible = false; wl.birds.group.visible = false;
  e._loop();
  const without = { calls: info.calls, tris: info.triangles };
  wl.group.visible = true; wl.birds.group.visible = true;
  e.start();
  return {
    roadSamples: steps,
    fractionWithAnimalInView: +(seen / Math.max(1, steps)).toFixed(3),
    // The two numbers that describe what a player experiences.
    fractionNoticeable: +(seenNoticeable / Math.max(1, steps)).toFixed(3),   // inside 140 m
    fractionClose: +(seenClose / Math.max(1, steps)).toFixed(3),             // inside 70 m
    gapSecondsAny: gapAny,
    gapSecondsNoticeable: gapNoticeable,
    gapSecondsClose: gapClose,
    meanLive: +meanLive.toFixed(2), liveMax, inViewMax,
    perSpeciesSightings: perSpecies,
    birdFlockInViewPct: +(100 * birdsSeen / Math.max(1, steps)).toFixed(1),
    hour: window.__lighting.hour,
    sites: wl.stats.sites,
    // Per-species home sites. The cap in `_placeSites` truncates in key order
    // and the river bears place last, so "how many sites" is not the question
    // that catches a saturated table — "did the bears survive it" is.
    sitesBySpecies: Object.fromEntries(wl.keys.map((k, i) => [
      k, wl.sites.spec.reduce((n, v) => n + (v === i ? 1 : 0), 0)])),
    maxWaterDepthUnderAnimal: +maxDepth.toFixed(3),
    animalsInWaterSamples: wetSamples,
    maxSlopeUnderAnimal: +maxSlope.toFixed(2),
    busiestInView: best.inView,
    costAtBusiest: {
      calls: withW.calls - without.calls,
      triangles: withW.tris - without.tris,
      totalCalls: withW.calls, totalTris: withW.tris,
    },
  };
}, { STEP, SPEED, HOUR });

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('errors', errs.slice(0, 5));
await browser.close();

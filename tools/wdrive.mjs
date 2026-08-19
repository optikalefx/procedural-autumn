#!/usr/bin/env node
/**
 * Wildlife encounter census, driven rather than teleported.
 *
 * `tools/wcensus.mjs` samples the road network by teleporting the camera to a
 * point and counting one frame later. That measures where animals *live*, and
 * it cannot measure what a player experiences, because every deer it counts has
 * had zero time to react. In play the sequence is: a deer wakes 141-172 m ahead,
 * you close at 13 m/s, it goes ALERT around 77 m, and it bolts around 43 m
 * (`dEff = d - speed * 1.15`, so driving fast makes them leave earlier) and runs
 * for 3.5-7 s at sprint. The teleporting census sees none of that and reported
 * an animal in view 40% of the time while the player drove the valley and asked
 * whether wildlife was in the build at all.
 *
 * This drives a threat along the roads in continuous time with the brains
 * running, and scores a sighting the way an eye would: by apparent size.
 *
 *   node tools/wdrive.mjs --km 6 --speed 13
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const KM = parseFloat(arg('km', '6'));
const SPEED = parseFloat(arg('speed', '13'));
const HZ = parseFloat(arg('hz', '30'));
const RES = arg('res', '768');
// Roads are not where a player necessarily drives, and habitat correlates with
// them, so the road number is the optimistic case. --offroad drives straight
// chords across the map instead: the pessimistic case, and the one the player
// was describing when they asked whether wildlife was in the build.
const OFFROAD = argv.includes('--offroad');

await acquire('wdrive');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://localhost:5178?res=${RES}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await page.evaluate(async (P) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  const dt = 1 / P.HZ;
  window.__forceCamera = true;
  e.stop();
  e.clock.getDelta = () => dt;

  const cam = e.camera;
  cam.fov = 55; cam.updateProjectionMatrix();
  const fr = new T.Frustum(), pm = new T.Matrix4(), sp = new T.Sphere();

  // Flatten the road network into one polyline budget, longest roads first so a
  // short --km still samples real driving rather than a stub spur.
  let roads = (W.roads ?? []).slice().sort((a, b) => b.length - a.length);
  if (P.OFFROAD) {
    // Straight chords through the world, on a fixed lattice of bearings and
    // offsets so the run is repeatable. Anything that leaves drivable ground is
    // still counted — a player who drives into a lake sees no deer either, and
    // pretending otherwise is how the last instrument flattered itself.
    const half = (W.half ?? 1024) * 0.86;
    roads = [];
    for (let b = 0; b < 8; b++) {
      const th = (b / 8) * Math.PI * 2 + 0.19;
      const ox = Math.cos(th + Math.PI / 2) * half * ((b % 3) - 1) * 0.42;
      const oz = Math.sin(th + Math.PI / 2) * half * ((b % 3) - 1) * 0.42;
      const pts = [];
      for (let t = -1; t <= 1.0001; t += 0.02) {
        pts.push({ x: ox + Math.cos(th) * half * t, z: oz + Math.sin(th) * half * t });
      }
      roads.push(pts);
    }
  }
  const budget = P.KM * 1000;

  const frames = [];
  let driven = 0, boundary = true;

  outer:
  for (const road of roads) {
    if (driven >= budget) break;
    boundary = true;
    for (let i = 0; i < road.length - 1; i++) {
      const a = road[i], b = road[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen < 1e-3) continue;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.round(segLen / (P.SPEED * dt)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const gy = W.getHeight(x, z);
        cam.position.set(x, gy + 2.2, z);
        cam.lookAt(x + Math.sin(yaw) * 20, gy + 2.0, z + Math.cos(yaw) * 20);
        // The brains take their threat from the camper, which the harness is
        // not driving. Override it with the same point the camera is at, moving
        // at the same speed, so `dEff` and the flee radius are what they would
        // be under a player.
        wl.debugThreat(x, z, P.SPEED);
        e._loop();

        pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        fr.setFromProjectionMatrix(pm);
        let close = 0, mid = 0, far = 0, nearest = 1e9, fleeing = 0;
        for (const key of Object.keys(wl.pool)) {
          for (const per of wl.pool[key]) {
            for (const A of per) {
              if (!A.active) continue;
              const d = Math.hypot(A.brain.pos.x - x, A.brain.pos.z - z);
              sp.center.set(A.brain.pos.x, A.brain.pos.y + 0.8, A.brain.pos.z);
              sp.radius = 1.5;
              if (d >= 220 || !fr.intersectsSphere(sp)) continue;
              nearest = Math.min(nearest, d);
              if (d < 70) close++; else if (d < 140) mid++; else far++;
              if (A.brain.state === 4 /* ST.FLEE */) fleeing++;
            }
          }
        }
        frames.push({ close, mid, far, fleeing, boundary,
                      nearest: nearest > 1e8 ? -1 : Math.round(nearest) });
        boundary = false;
        driven += P.SPEED * dt;
        if (driven >= budget) break outer;
      }
    }
  }

  const gapStats = (hit) => {
    let gap = 0, worst = 0; const gaps = [];
    for (const f of frames) {
      if (f.boundary) { if (gap) gaps.push(gap); gap = 0; }
      if (!hit(f)) { gap++; worst = Math.max(worst, gap); }
      else { if (gap) gaps.push(gap); gap = 0; }
    }
    if (gap) gaps.push(gap);
    gaps.sort((a, b) => a - b);
    const q = (f) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))] : 0);
    const sec = (n) => +(n / P.HZ).toFixed(1);
    return { median: sec(q(0.5)), p90: sec(q(0.9)), worst: sec(worst), count: gaps.length };
  };

  const n = Math.max(1, frames.length);
  const frac = (hit) => +(frames.filter(hit).length / n).toFixed(3);
  const nearestSeen = frames.map((f) => f.nearest).filter((d) => d > 0).sort((a, b) => a - b);

  e.start();
  wl.debugThreat(null);
  return {
    mode: P.OFFROAD ? 'offroad chords' : 'road network',
    kmDriven: +(driven / 1000).toFixed(2),
    simSeconds: +(frames.length / P.HZ).toFixed(1),
    frames: frames.length,
    fractionClose:      frac((f) => f.close > 0),                 // inside 70 m
    fractionNoticeable: frac((f) => f.close + f.mid > 0),          // inside 140 m
    fractionAnyInView:  frac((f) => f.close + f.mid + f.far > 0),
    fractionFleeingInView: frac((f) => f.fleeing > 0),
    gapSecondsClose:      gapStats((f) => f.close > 0),
    gapSecondsNoticeable: gapStats((f) => f.close + f.mid > 0),
    closestApproachMedian: nearestSeen.length ? nearestSeen[Math.floor(nearestSeen.length / 2)] : -1,
    closestApproachP05: nearestSeen.length ? nearestSeen[Math.floor(nearestSeen.length * 0.05)] : -1,
    sites: wl.stats.sites,
  };
}, { KM, SPEED, HZ, OFFROAD });

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.error('page errors:', errs.slice(0, 5));
await browser.close();

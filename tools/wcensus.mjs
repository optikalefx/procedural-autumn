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

await acquire('wcensus');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://localhost:5178?res=${RES}${SEED ? `&seed=${SEED}` : ''}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await page.evaluate(async (P) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  window.__forceCamera = true;
  e.stop(); e.clock.getDelta = () => 1 / 30;

  const roads = W.roads ?? [];
  const cam = e.camera;
  cam.fov = 55; cam.updateProjectionMatrix();
  const fr = new T.Frustum(), pm = new T.Matrix4(), sp = new T.Sphere();

  const samples = [];
  const perSpecies = { deer: 0, bear: 0, rabbit: 0 };
  let steps = 0, seen = 0, birdsSeen = 0;

  for (const road of roads) {
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
        let inView = 0, nearest = 1e9;
        for (const key of Object.keys(wl.pool)) {
          for (const per of wl.pool[key]) {
            for (const A of per) {
              if (!A.active) continue;
              const d = Math.hypot(A.brain.pos.x - x, A.brain.pos.z - z);
              sp.center.set(A.brain.pos.x, A.brain.pos.y + 0.8, A.brain.pos.z);
              sp.radius = 1.5;
              // Under 220 m a deer is still a readable speck; past that it is fog.
              if (d < 220 && fr.intersectsSphere(sp)) { inView++; perSpecies[key]++; nearest = Math.min(nearest, d); }
            }
          }
        }
        for (const F of wl.birds.flocks) {
          sp.center.set(F.cx, F.cy, F.cz); sp.radius = 40;
          if (fr.intersectsSphere(sp)) { birdsSeen++; break; }
        }
        steps++;
        if (inView > 0) seen++;
        samples.push({ inView, nearest: nearest > 1e8 ? -1 : Math.round(nearest), live: wl.stats.live });
      }
    }
  }

  // Longest run of consecutive samples with nothing in sight.
  let gap = 0, worst = 0;
  for (const s of samples) { if (s.inView === 0) { gap++; worst = Math.max(worst, gap); } else gap = 0; }

  const liveMax = samples.reduce((m, s) => Math.max(m, s.live), 0);
  const inViewMax = samples.reduce((m, s) => Math.max(m, s.inView), 0);
  const meanLive = samples.reduce((m, s) => m + s.live, 0) / Math.max(1, samples.length);
  e.start();
  return {
    roadSamples: steps,
    fractionWithAnimalInView: +(seen / Math.max(1, steps)).toFixed(3),
    worstDrySpellSeconds: +((worst * P.STEP) / P.SPEED).toFixed(1),
    meanLive: +meanLive.toFixed(2), liveMax, inViewMax,
    perSpeciesSightings: perSpecies,
    birdFlockInViewPct: +(100 * birdsSeen / Math.max(1, steps)).toFixed(1),
    sites: wl.stats.sites,
  };
}, { STEP, SPEED });

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('errors', errs.slice(0, 5));
await browser.close();

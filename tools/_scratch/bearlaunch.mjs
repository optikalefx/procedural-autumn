/**
 * Body-track instrument — finds pops in the ballistic suspension.
 *
 * Drives one animal's rig by hand at a fixed speed over *flat* synthetic ground
 * (the heightfield is stubbed out, so any step in the track is the animator's
 * and not the terrain's) and reports the worst frame-to-frame change in the
 * root bone's height. A smooth gait steps a few thousandths of a unit per
 * frame; the "he jumps down at the top of his gallop" report measured 0.31.
 *
 *   node tools/_scratch/bearlaunch.mjs bear 5.5      # gallop
 *   node tools/_scratch/bearlaunch.mjs deer 10.5     # bound
 *   node tools/_scratch/bearlaunch.mjs rabbit 7.0    # hop
 *
 * Watch `stanceN` alongside `rootY`: the arc must start and end on frames with
 * a foot still down, or the body launches off a planted leg.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('bearlaunch');
const SPECIES = process.argv[2] || 'bear';
const SPEED = parseFloat(process.argv[3] || '5.5');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
const out = await page.evaluate(async ([SPECIES, SPEED]) => {
  const THREE = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  // Stand the camera in a meadow first, or the spawn search has nowhere to work.
  window.__forceCamera = true;
  const anchor = window.__cameraAnchors.meadow();
  e.camera.position.set(anchor.x, W.getHeight(anchor.x, anchor.z) + 2, anchor.z);
  e.camera.rotation.set(0, anchor.yaw ?? 0, 0, 'YXZ');
  wl.debugClear(); wl.debugThreat(null);
  if (!wl.debugSpawn(SPECIES, { dist: 16, clear: 9, count: 1 })) return { error: 'no spawn' };
  let A = null;
  for (const per of wl.pool[SPECIES]) for (const a of per) if (a.active) A = A ?? a;
  const rig = A.rig;
  // Flat synthetic ground removes terrain from the picture entirely, so any
  // step in the body track is the animator's and not the heightfield's.
  const realH = W.getHeight.bind(W);
  const pos = new THREE.Vector3(A.brain.pos.x, 0, A.brain.pos.z);
  const heading = 0.6, dt = 1 / 60;
  const drive = { pos, heading, speed: SPEED, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };
  const rows = [];
  for (const flat of [true, false]) {
    W.getHeight = flat ? (() => 0) : realH;
    rig.reset(pos, heading, W);
    for (let f = 0; f < 260; f++) {
      pos.x += Math.sin(heading) * SPEED * dt;
      pos.z += Math.cos(heading) * SPEED * dt;
      pos.y = W.getHeight(pos.x, pos.z);
      rig.update(dt, drive, W);
      if (f < 120) continue;
      let stanceN = 0;
      for (const lg of rig.legs) if (lg.p < rig.gait.duty) stanceN++;
      rows.push({
        flat, f, phase: +rig.phase.toFixed(4), gait: rig.gaitName, stanceN,
        rootY: +rig.root.position.y.toFixed(4),
        bodyY: +rig.bodyY.toFixed(4),
        // what the eye actually tracks: the withers in world space
        meshY: +rig.mesh.position.y.toFixed(4),
        pitch: +rig.root.rotation.x.toFixed(4),
      });
    }
  }
  W.getHeight = realH;
  return { scale: A.scale, rows };
}, [SPECIES, SPEED]);
console.log(JSON.stringify(out));
await browser.close();

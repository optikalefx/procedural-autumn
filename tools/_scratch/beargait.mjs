/**
 * Bear leg-reach instrument.
 *
 * Drives one animal's rig by hand along a straight line at a fixed speed and
 * reports, per leg per frame, how far the IK is being asked to reach against
 * what the chain can actually cover (`over` = need / max, >1 means the solver
 * clamped and the leg went dead straight). This is the instrument the
 * "front legs disappear" report was diagnosed with: a leg clamped through most
 * of stance stops bending, rakes back under the barrel and vanishes into the
 * body's own silhouette.
 *
 *   node tools/_scratch/beargait.mjs bear 1.0    # walk
 *   node tools/_scratch/beargait.mjs bear 2.8    # trot
 *   node tools/_scratch/beargait.mjs deer 10.5   # bound
 *
 * Split the result by stance vs swing: swing-side clamping is a leg extended
 * in mid-air and is fine; stance-side clamping is the paw sliding off its own
 * contact point and is not.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('beargait');
const SPECIES = process.argv[2] || 'bear';
const SPEED = parseFloat(process.argv[3] || '1.0');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
const out = await page.evaluate(async ([SPECIES, SPEED]) => {
  const THREE = window.__THREE, e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  wl.debugClear(); wl.debugThreat(null);
  const spawn = wl.debugSpawn(SPECIES, { dist: 16, clear: 9, count: 1 });
  if (!spawn) return { error: 'no spawn' };
  let A = null;
  for (const per of wl.pool[SPECIES]) for (const a of per) if (a.active) A = A ?? a;
  const rig = A.rig;
  // Drive the rig by hand along a straight line at a fixed speed.
  const pos = new THREE.Vector3(A.brain.pos.x, 0, A.brain.pos.z);
  const heading = 0.6;
  const dt = 1/60;
  const drive = { pos, heading, speed: SPEED, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };
  rig.reset(pos, heading, W);
  const rows = [];
  const inv = new THREE.Matrix4(), v = new THREE.Vector3();
  for (let f = 0; f < 200; f++) {
    pos.x += Math.sin(heading) * SPEED * dt;
    pos.z += Math.cos(heading) * SPEED * dt;
    pos.y = W.getHeight(pos.x, pos.z);
    rig.update(dt, drive, W);
    if (f < 60) continue;
    inv.copy(rig.mesh.matrixWorld).invert();
    const P = (b) => { v.setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv); return [ +v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3) ]; };
    const rec = { f, gait: rig.gaitName, phase: +rig.phase.toFixed(3), legs: {} };
    for (const lg of rig.legs) {
      // reproduce the hock target in the leg parent's space
      const a = new THREE.Vector3(
        lg.foot.x - lg.footWZ * Math.sin(heading),
        lg.foot.y - lg.footWY,
        lg.foot.z - lg.footWZ * Math.cos(heading));
      const m = new THREE.Matrix4().copy(lg.upper.parent.matrixWorld).invert();
      a.applyMatrix4(m);
      const d = Math.hypot(a.y - lg.upper.position.y, a.z - lg.upper.position.z);
      rec.legs[lg.L.name] = {
        p: +lg.p.toFixed(3),
        need: +d.toFixed(3), max: +((lg.l1 + lg.l2) * 0.998).toFixed(3),
        over: +(d / ((lg.l1 + lg.l2) * 0.998)).toFixed(3),
        hip: P(lg.upper), knee: P(lg.lower), hock: P(lg.cannon),
        rU: +lg.upper.rotation.x.toFixed(3), rL: +lg.lower.rotation.x.toFixed(3), rC: +lg.cannon.rotation.x.toFixed(3),
      };
    }
    rows.push(rec);
  }
  return { scale: A.scale, rows };
}, [SPECIES, SPEED]);
console.log(JSON.stringify(out));
await browser.close();

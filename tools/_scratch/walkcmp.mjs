#!/usr/bin/env node
/**
 * Is the walk on screen the walk in the .blend?
 *
 *   AUTUMN_URL=http://127.0.0.1:5202 node tools/_scratch/walkcmp.mjs shots/walkcmp
 *
 * Pairs with tools/_scratch/blender_walk.py, which renders the same six phases
 * of the Walk action straight out of Blender. Same clip times, same broadside
 * angle, so the two strips are directly comparable frame for frame.
 *
 * The mixer is driven to an exact time rather than left to run: comparing two
 * animations that are each free-running at their own rate compares phase noise,
 * not the pose.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper&quality=high';
const OUT = process.argv[2] || 'shots/walkcmp';
const GAIN = process.argv[3] ? `&foxstride=${process.argv[3]}` : '';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 420 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'info') console.log('  [page]', m.text()); });

await page.goto(URL + GAIN, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 180000 });
await page.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

const stage = await page.evaluate(() => {
  const e = window.__engine, W = window.__world, S = window.__systems;
  S.hud?.journal?.close();
  window.__lighting.hour = 16.4; window.__lighting.cycleSpeed = 0;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  const v = S.vehicle?.position ?? e.camera.position;
  let best = null;
  for (let r = 12; r < 90 && !best; r += 4) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = v.x + Math.sin(a) * r, z = v.z + Math.cos(a) * r;
      if (!W.isInBounds(x, z) || W.getWaterDepth(x, z) > 0.05) continue;
      if (W.getSlope(x, z) > 0.08) continue;                 // flat, to match Blender
      if (S.wildlife?._treeNear?.(x, z, 8)) continue;
      best = { x, z }; break;
    }
  }
  best ??= { x: v.x + 20, z: v.z };

  // The camper is parked well inside a fox's fleeDist, so move the threat off
  // the map before spawning or the subject bolts before the shutter.
  const wl = S.wildlife;
  wl.debugThreat(best.x + 5000, best.z + 5000, 0);
  wl.debugClear();
  wl.debugSpawn('fox', { x: best.x, z: best.z, count: 1, state: 0 });
  // Point it along +Z to match the Blender camera, then freeze the world so
  // nothing re-blends or walks it out of frame between shots.
  // Put it exactly on the stage and point it along +Z. `debugSpawn` scatters
  // members around the stand point, and framing the stage rather than the
  // animal is how the first run of this photographed a fox's shoulder.
  let subject = null;
  for (const per of wl.pool.fox) for (const a of per) if (a.active) subject ??= a;
  subject.brain.pos.set(best.x, W.getHeight(best.x, best.z), best.z);
  subject.brain.heading = 0;
  subject.rig._warm = false;
  subject.rig.reset(subject.brain.pos, 0, W);
  wl.debugFreeze(true);
  return { ...best, y: W.getHeight(best.x, best.z), dur: wl.protos.fox[0].clips.walk.duration };
});
console.log('stage', JSON.stringify(stage));

// Broadside at the fox's own height, matching the Blender camera's framing.
await page.evaluate(({ stage }) => {
  const T = window.__THREE, e = window.__engine, W = window.__world;
  const cx = stage.x + 2.05, cz = stage.z + 0.05;
  e.camera.fov = 34;
  e.camera.updateProjectionMatrix();
  e.camera.position.set(cx, W.getHeight(cx, cz) + 0.34, cz);
  e.camera.lookAt(new T.Vector3(stage.x, stage.y + 0.30, stage.z));
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
}, { stage });
await page.waitForTimeout(900);

// Freeze the system so update() cannot re-blend or advance past the pose we set.
for (let i = 0; i < 6; i++) {
  const t = (i / 6) * stage.dur;
  await page.evaluate(({ t }) => {
    const wl = window.__systems.wildlife;
    let a = null;
    for (const per of wl.pool.fox) for (const m of per) if (m.active) a ??= m;
    const r = a.rig;
    // Drive the mixer to an exact clip time rather than letting it run: two
    // animations each free-running at their own rate compare phase noise, not
    // the pose. `debugFreeze` has already stopped the Brain, and zeroing every
    // other weight stops `update` re-blending underneath the screenshot.
    for (const k of Object.keys(r.act)) r.act[k].setEffectiveWeight(k === 'walk' ? 1 : 0);
    r.act.walk.timeScale = 1;
    r.mixer.setTime(t);
    a.mesh.updateMatrixWorld(true);
  }, { t });
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${OUT}/game_${i}.png` });
  console.log('  wrote', `${OUT}/game_${i}.png  (t=${t.toFixed(3)}s)`);
}

await browser.close();

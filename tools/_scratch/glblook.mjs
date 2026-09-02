#!/usr/bin/env node
/**
 * Look test for a hand-authored animal — see src/wildlife/glb_rig.js.
 *
 *   AUTUMN_URL=http://127.0.0.1:5203 node tools/_scratch/glblook.mjs shots/foxlook [species] [scale]
 *
 * `shot.mjs` frames the landscape; this frames one animal. It boots the game
 * once, finds a flat open patch, puts a group of the named species on it, and
 * writes a strip per gait from broadside, a stand pose, the two authored pose
 * clips, and the same animal at the ranges the player actually sees one.
 *
 * Species-agnostic on purpose: everything here goes through `Wildlife`'s own
 * debug surface (`debugSpawn`, `debugGait`, `debugThreat`, `debugState`), which
 * both backends answer. The second hand-authored animal should need no new
 * tool — only `node ... glblook.mjs shots/<name> <species>`.
 *
 * One page load for every frame on purpose: re-booting per shot pays the bake
 * each time and, worse, would re-roll the animal's position between shots.
 *
 * `scale` multiplies every camera distance and height below, and it exists
 * because the numbers were derived on a 0.62 m fox and are a framing rather
 * than a formula. They hold from the raccoon to the deer and they do not hold
 * on a 3 m moose, which came back as six photographs of a shoulder. It defaults
 * to 1 rather than being derived from `glb.height` on purpose: deriving it
 * would silently re-frame every animal already captured through this tool, and
 * a look test whose output moves under you is not a look test. Pass roughly
 * `height / 0.62` — 2.2 for the moose.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper&quality=high';
const OUT = process.argv[2] || 'shots/glblook';
const KEY = process.argv[3] || 'fox';
const Z = Number(process.argv[4] || 1);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text().slice(0, 160)); });

console.log('booting', URL);
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 180000 });
await page.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

// ── stage ───────────────────────────────────────────────────────────────────
// A flat, dry, tree-free patch near the camper: an animal lost in shin-high
// grass under a spruce is not a look test of the animal.
const stage = await page.evaluate(() => {
  const e = window.__engine, W = window.__world, S = window.__systems;
  S.hud?.journal?.close();
  window.__lighting.hour = 16.4;
  window.__lighting.cycleSpeed = 0;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;
  const v = S.vehicle?.position ?? e.camera.position;
  let best = null;
  for (let r = 12; r < 90 && !best; r += 4) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = v.x + Math.sin(a) * r, z = v.z + Math.cos(a) * r;
      if (!W.isInBounds(x, z)) continue;
      if (W.getWaterDepth(x, z) > 0.05) continue;
      if (W.getSlope(x, z) > 0.18) continue;
      if (S.wildlife?._treeNear?.(x, z, 7)) continue;
      best = { x, z }; break;
    }
  }
  best ??= { x: v.x + 20, z: v.z };
  return { x: best.x, z: best.z, y: W.getHeight(best.x, best.z) };
});
console.log('stage', JSON.stringify(stage));

/** Put the group on the stage, with the camper's threat moved off the map. */
async function place({ count = 1, state = null } = {}) {
  return page.evaluate(({ stage, KEY, count, state }) => {
    const S = window.__systems;
    // The camper is parked well inside a fox's fleeDist, so an animal spawned
    // here bolts before the shutter. Move the threat off the map first.
    S.wildlife.debugThreat(stage.x + 5000, stage.z + 5000, 0);
    S.wildlife.debugClear();
    const opts = { x: stage.x, z: stage.z, count };
    if (state !== null) opts.state = state;
    return S.wildlife.debugSpawn(KEY, opts);
  }, { stage, KEY, count, state });
}

/** Pose the camera at an offset from the stage and hold it there. */
async function frame(name, { dist, height, yaw, lookY = 0.34, fov = 42, wait = 260 }) {
  await page.evaluate(({ stage, dist, height, yaw, lookY, fov }) => {
    const T = window.__THREE, e = window.__engine, W = window.__world;
    const cx = stage.x - Math.sin(yaw) * dist;
    const cz = stage.z - Math.cos(yaw) * dist;
    e.camera.fov = fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(cx, W.getHeight(cx, cz) + height, cz);
    e.camera.lookAt(new T.Vector3(stage.x, stage.y + lookY, stage.z));
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { stage, dist, height, yaw, lookY, fov });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  wrote', `${OUT}/${name}.png`);
}

/**
 * Pose the camera broadside to animal 0 and hold. A moving animal walks out of
 * a fixed frame in three shots, which is how the first run of this produced six
 * pictures of grass — so the camera is re-derived from the animal every time.
 */
async function trackShot(name, { dist = 4.6, height = 0.7, lookY = 0.32, fov = 40, side = 1,
                                 wait = 300, clearSight = false } = {}) {
  await page.waitForTimeout(wait);
  await page.evaluate(({ KEY, dist, height, lookY, fov, side, clearSight }) => {
    const T = window.__THREE, e = window.__engine, W = window.__world, S = window.__systems;
    let a = null;
    for (const per of S.wildlife.pool[KEY]) for (const m of per) if (m.active) a ??= m;
    if (!a) return;
    const B = a.brain;
    let yaw = B.heading + side * Math.PI / 2;
    let cx = B.pos.x - Math.sin(yaw) * dist;
    let cz = B.pos.z - Math.cos(yaw) * dist;
    // At the ranges this animal is actually read at, broadside is very often
    // through a spruce — the stage picker only clears trees around the ANIMAL,
    // and at 45 m the camera is a long way outside that. So walk the bearing
    // until both ends and the middle of the sightline are clear. The first cut
    // of this skipped the check and wrote three photographs of a canopy.
    if (clearSight) {
      // Two ways a long shot of a small animal comes back empty, and the first
      // cut of this hit both in turn: a spruce in the way, and a ridge in the
      // way. So a bearing has to clear BOTH — no trunk near the camera or along
      // the line, and an unbroken line of sight over the heightfield to the
      // animal's middle. Sixteen bearings, and the best partial one if none is
      // perfect, because a poor frame beats no frame at all.
      const near = (x, z, r) => S.wildlife._treeNear(x, z, r);
      const eyeY = (x, z) => W.getHeight(x, z) + height;
      const target = B.pos.y + lookY;
      let bestYaw = yaw, bestScore = -1;
      for (let i = 0; i < 16; i++) {
        const y2 = B.heading + side * Math.PI / 2 + (i / 16) * Math.PI * 2;
        const tx = B.pos.x - Math.sin(y2) * dist, tz = B.pos.z - Math.cos(y2) * dist;
        if (!W.isInBounds(tx, tz) || W.getWaterDepth(tx, tz) > 0.05) continue;
        let score = 1;
        if (near(tx, tz, 5)) score -= 0.5;
        const ey = eyeY(tx, tz);
        for (let s = 0.08; s < 0.98; s += 0.06) {
          const mx = tx + (B.pos.x - tx) * s, mz = tz + (B.pos.z - tz) * s;
          // Where the sightline is at this step, against where the ground is.
          const lineY = ey + (target - ey) * s;
          if (W.getHeight(mx, mz) > lineY - 0.15) { score -= 0.35; break; }
          if (s > 0.15 && near(mx, mz, 2.5)) { score -= 0.25; break; }
        }
        if (score > bestScore) { bestScore = score; bestYaw = y2; }
        if (score >= 1) break;
      }
      yaw = bestYaw;
      cx = B.pos.x - Math.sin(yaw) * dist;
      cz = B.pos.z - Math.cos(yaw) * dist;
    }
    e.camera.fov = fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(cx, W.getHeight(cx, cz) + height, cz);
    e.camera.lookAt(new T.Vector3(B.pos.x, B.pos.y + lookY, B.pos.z));
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { KEY, dist, height, lookY, fov, side, clearSight });
  await page.waitForTimeout(90);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  wrote', `${OUT}/${name}.png`);
}

/** What the mixer is actually doing, per animal of this species. */
async function weights(label) {
  const w = await page.evaluate(({ KEY }) => {
    const S = window.__systems;
    const out = [];
    for (const per of S.wildlife.pool[KEY]) for (const a of per) {
      if (!a.active || !a.rig.act) continue;
      const o = { gait: a.rig.gaitName, speed: +a.brain.speed.toFixed(3), w: {} };
      let sum = 0;
      for (const k of Object.keys(a.rig.act)) {
        const v = a.rig.act[k].getEffectiveWeight();
        sum += v;
        if (v > 0.005) o.w[k] = +v.toFixed(3);
      }
      o.sum = +sum.toFixed(3);
      o.rate = +a.rig.act[a.rig.gaitName]?.timeScale?.toFixed?.(2);
      out.push(o);
    }
    return out;
  }, { KEY });
  console.log(`  ${label}:`, JSON.stringify(w[0] ?? null));
  // The invariant worth failing on: an unnormalised set makes the mixer average
  // toward the rest pose and the animal visibly sinks as it changes gait.
  for (const o of w) {
    if (Math.abs(o.sum - 1) > 0.02) console.error(`  !! weights sum to ${o.sum}, not 1`);
  }
  return w;
}

// ── 1. a strip per locomotion gait, from broadside ──────────────────────────
// Broadside is the only angle a gait can actually be judged from. Each gait is
// pinned at its own cruising speed so the mixer sits on that clip alone rather
// than part-way through a crossfade.
await place({ count: 1, state: 2 });                       // ST.WANDER
for (const gait of ['walk', 'trot', 'run']) {
  await page.evaluate(({ KEY, gait }) => window.__systems.wildlife.debugGait(KEY, gait), { KEY, gait });
  await page.waitForTimeout(700);
  await weights(gait);
  for (let i = 0; i < 6; i++) await trackShot(`${gait}_${i}`, { dist: 4.2 * Z, height: 0.66 * Z, lookY: 0.32 * Z, wait: 240 });
}
await page.evaluate(() => window.__systems.wildlife.debugGait(null));

// ── 2. the pose clips ───────────────────────────────────────────────────────
// The two the locomotion ladder cannot reach. Held by state rather than speed,
// because that is how the game reaches them — `Brain` ramps `graze` and `alert`
// as smoothed channels and the rig reads those, so this checks the whole path.
for (const [name, st] of [['graze', 1], ['alert', 3]]) {
  await page.evaluate(({ KEY, st }) => {
    const S = window.__systems;
    for (const per of S.wildlife.pool[KEY]) for (const a of per) {
      if (!a.active) continue;
      a.brain.state = st; a.brain.timer = 1e4; a.brain.headUp = false;
    }
  }, { KEY, st });
  await page.waitForTimeout(1400);
  await weights(name);
  await trackShot(`pose_${name}`, { dist: 3.0 * Z, height: 0.52 * Z, lookY: 0.28 * Z, fov: 38, wait: 300 });
}

// ── 3. the stand clip, front and side ───────────────────────────────────────
await place({ count: 1, state: 0 });                       // ST.IDLE
await page.evaluate(() => window.__systems.wildlife.debugFreeze(true));
await page.waitForTimeout(700);
await frame('stand_front', { dist: 3.4 * Z, height: 0.62 * Z, yaw: 0, lookY: 0.34 * Z, fov: 38, wait: 500 });
await frame('stand_side', { dist: 3.4 * Z, height: 0.48 * Z, yaw: Math.PI / 2, lookY: 0.32 * Z, fov: 38, wait: 400 });
await page.evaluate(() => window.__systems.wildlife.debugFreeze(false));

// ── 4. the coats, side by side ──────────────────────────────────────────────
// One frame per morph is not the test; the test is whether they read as the
// same animal in different coats rather than as different animals.
await place({ count: 3, state: 0 });
await page.evaluate(() => window.__systems.wildlife.debugFreeze(true));
await page.waitForTimeout(800);
await frame('coats', { dist: 6.0 * Z, height: 1.0 * Z, yaw: 0, lookY: 0.30 * Z, fov: 44, wait: 500 });
await page.evaluate(() => window.__systems.wildlife.debugFreeze(false));

// ── 5. at the range the player actually sees one ────────────────────────────
// `mammals/<species>.js` sets the bar — a fox is read at 30-60 m, where the
// whole animal is a dozen pixels and the silhouette is the only thing carrying
// it. The camera tracks the animal so these are the same animal, not the same
// patch of meadow: the first run of this framed a fixed point it had left.
await place({ count: 1, state: 0 });
// Camera at a standing player's eye height, not scaled with distance: an
// animal read from above is a different legibility question from the one the
// player asks.
for (const d of [12, 25, 45]) {
  await trackShot(`range_${d}m`, { dist: d, height: 1.5 * Z, lookY: 0.3 * Z, fov: 50, side: 1,
                                   wait: 260, clearSight: true });
}

// ── the numbers ─────────────────────────────────────────────────────────────
const report = await page.evaluate(({ KEY }) => {
  const S = window.__systems, wl = S.wildlife;
  const p = wl.protos[KEY][0];
  const r = wl.ctx.renderer;
  const live = [];
  for (const per of wl.pool[KEY]) for (const a of per) if (a.active) live.push(a);
  // Draw-call and triangle cost of this species, shown against hidden. The
  // renderer's info does not auto-reset in this app, so it is reset by hand —
  // reading it without that is how a capture reports a growing total.
  const read = () => { r.info.autoReset = false; r.info.reset(); r.render(wl.ctx.scene, wl.ctx.camera);
                       return { c: r.info.render.calls, t: r.info.render.triangles }; };
  const on = read();
  for (const a of live) a.mesh.visible = false;
  const off = read();
  for (const a of live) a.mesh.visible = true;
  return {
    stride: p.stride, speed: p.speed, coats: wl.protos[KEY].length,
    live: live.length,
    perAnimalCalls: live.length ? +((on.c - off.c) / live.length).toFixed(1) : null,
    perAnimalTris: live.length ? Math.round((on.t - off.t) / live.length) : null,
  };
}, { KEY });
console.log('\n' + KEY, JSON.stringify(report, null, 2));

await browser.close();
console.log('done ->', OUT);

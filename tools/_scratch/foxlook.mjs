#!/usr/bin/env node
/**
 * Look test for the Blender fox — see src/wildlife/glb_fox.js.
 *
 *   AUTUMN_URL=http://127.0.0.1:5202 node tools/_scratch/foxlook.mjs
 *
 * shot.mjs frames the landscape; this frames one animal. It boots the game
 * once, finds a flat open patch, pins a GLB fox walking a straight line across
 * it with a procedural fox alongside for scale, and writes a strip of the walk
 * cycle plus a stand pose and a side-by-side.
 *
 * One page load for every frame on purpose: re-booting per shot pays the bake
 * each time and, worse, would re-roll the fox's position between comparisons.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper&quality=high';
const OUT = process.argv[2] || 'shots/foxlook';
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
const stage = await page.evaluate(() => {
  const e = window.__engine, W = window.__world, S = window.__systems;
  S.hud?.journal?.close();
  window.__lighting.hour = 16.4;
  window.__lighting.cycleSpeed = 0;
  e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1;

  // A flat, dry, tree-free patch near the camper: a fox lost in shin-high grass
  // under a spruce is not a look test of the fox.
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

const G = 'window.__systems.glbFoxes';

/**
 * Pose the camera broadside to fox 0 and hold. A creeping animal walks out of a
 * fixed frame in three shots, which is how the first run of this produced six
 * pictures of grass.
 */
async function frameFox(name, { dist = 4.6, height = 0.7, lookY = 0.32, fov = 40, side = 1, wait = 300 } = {}) {
  await page.waitForTimeout(wait);
  await page.evaluate(({ G, dist, height, lookY, fov, side }) => {
    const T = window.__THREE, e = window.__engine, W = window.__world;
    const B = eval(G).foxes[0].brain;
    const yaw = B.heading + side * Math.PI / 2;
    const cx = B.pos.x - Math.sin(yaw) * dist;
    const cz = B.pos.z - Math.cos(yaw) * dist;
    e.camera.fov = fov;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(cx, W.getHeight(cx, cz) + height, cz);
    e.camera.lookAt(new T.Vector3(B.pos.x, B.pos.y + lookY, B.pos.z));
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { G, dist, height, lookY, fov, side });
  await page.waitForTimeout(90);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  wrote', `${OUT}/${name}.png`);
}

// ── 1. the walk cycle, from the side ────────────────────────────────────────
// The fox walks across the frame on a fixed bearing; the camera watches from
// broadside, which is the only angle a gait can actually be judged from.
await page.evaluate(({ stage, G }) => {
  const g = eval(G);
  g.debugCalm(true);
  // Start it upwind of the stage so it walks INTO frame rather than out of it.
  g.debugWalk(0, stage.x - 3.2, stage.z, Math.PI / 2);
  // Park the rest of the pack out of shot.
  for (let i = 1; i < g.foxes.length; i++) g.debugWalk(i, stage.x + 300 + i * 4, stage.z + 300, 0);
}, { stage, G });
await page.waitForTimeout(500);

for (let i = 0; i < 6; i++) await frameFox(`walk_${i}`, { dist: 4.2, height: 0.66, wait: 340 });

// ── 1a. the trot, from the same angle ───────────────────────────────────────
// Held at the trot clip's own cruising speed so the mixer sits on Trot alone
// rather than part-way through the Walk->Trot crossfade. Same broadside camera
// as the walk strip, so the two gaits can be compared frame for frame.
await page.evaluate(({ stage, G }) => {
  const g = eval(G);
  g.debugCalm(true);
  g.debugWalk(0, stage.x - 3.2, stage.z, Math.PI / 2);
  g.forceGait = 'trot';
}, { stage, G });
await page.waitForTimeout(700);
for (let i = 0; i < 8; i++) await frameFox(`trot_${i}`, { dist: 4.2, height: 0.66, wait: 200 });
const trotState = await page.evaluate(({ G }) => eval(G).debugState(), { G });
console.log('  trot weights', JSON.stringify(trotState.foxes[0]));
await page.evaluate(({ G }) => { eval(G).forceGait = null; }, { G });

// ── 1b. the same clip, at a real fox's walking pace ─────────────────────────
// 0.85 m/s is what `mammals/fox.js` gives the procedural cast. The clip cannot
// carry it: the rate clamp pins the cycle at RATE[1] and the paws skate. This
// strip is the evidence for the stride note in glb_fox.js's header.
await page.evaluate(({ G }) => {
  const g = eval(G);
  g.proto.species.gait.walk = 0.85;      // Brain holds this object by reference
  g.proto.species.gait.trot = 1.3;
  g.proto.species.gait.run = 2.0;
}, { G });
await page.waitForTimeout(600);
for (let i = 0; i < 4; i++) await frameFox(`slide_${i}`, { dist: 4.2, height: 0.66, wait: 240 });
await page.evaluate(({ G }) => {
  const g = eval(G);
  g.proto.species.gait.walk = g.walkSpeed;
  g.proto.species.gait.trot = g.trotSpeed;
  g.proto.species.gait.run = g.trotSpeed * 1.25;
}, { G });

// ── 2. the stand clip, three-quarter front ──────────────────────────────────
await page.evaluate(({ stage, G }) => {
  const g = eval(G);
  const f = g.foxes[0];
  g.debugWalk(0, stage.x, stage.z, Math.PI * 0.75);
  f.brain.state = 0;          // ST.IDLE
  f.brain.wantSpeed = 0;
  f.brain.speed = 0;
  f.brain.timer = 1e4;
}, { stage, G });
await page.waitForTimeout(900);
await frame('stand_front', { dist: 3.4, height: 0.62, yaw: 0, lookY: 0.34, fov: 38, wait: 500 });
await frame('stand_side', { dist: 3.4, height: 0.48, yaw: Math.PI / 2, lookY: 0.32, fov: 38, wait: 400 });

// ── 3. beside the procedural fox ────────────────────────────────────────────
// The whole question in one frame: same species, same light, two pipelines.
const pair = await page.evaluate(({ stage, G }) => {
  const g = eval(G);
  const S = window.__systems;
  g.debugWalk(0, stage.x - 1.1, stage.z, Math.PI * 0.85);
  g.foxes[0].brain.state = 0; g.foxes[0].brain.speed = 0; g.foxes[0].brain.wantSpeed = 0;
  g.foxes[0].brain.timer = 1e4;
  // The camper is parked well inside a fox's fleeDist, so a procedural fox
  // spawned here bolts before the shutter. Move the threat off the map and
  // freeze the cast where it stands.
  S.wildlife?.debugThreat?.(stage.x + 5000, stage.z + 5000, 0);
  const r = S.wildlife?.debugSpawn?.('fox', { x: stage.x + 1.1, z: stage.z, count: 1, state: 0 });
  S.wildlife?.debugFreeze?.(true);
  return r;
}, { stage, G });
console.log('procedural fox:', JSON.stringify(pair));
await page.waitForTimeout(1200);
await frame('pair', { dist: 4.6, height: 0.66, yaw: 0, lookY: 0.32, fov: 40, wait: 600 });
await frame('pair_side', { dist: 4.4, height: 0.55, yaw: Math.PI / 2, lookY: 0.30, fov: 40, wait: 400 });

// ── 4. at the range the player actually sees one ────────────────────────────
// `mammals/fox.js` sets the bar: a fox is read at 30-60 m, where the whole
// animal is a dozen pixels and the silhouette is the only thing carrying it.
// The camera tracks the animal so these are the same fox, not the same patch
// of meadow — the first run of this framed a fixed point the fox had left.
for (const d of [12, 25, 45]) {
  await frameFox(`range_${d}m`, { dist: d, height: 1.6 + d * 0.03, lookY: 0.3, fov: 50, side: 0.7, wait: 260 });
}

const state = await page.evaluate(({ G }) => eval(G).debugState(), { G });
console.log('state', JSON.stringify(state.foxes[0]));
console.log(`walk ${state.strideCm}cm -> ${state.walkSpeed} m/s | trot ${state.trotStrideCm}cm -> ${state.trotSpeed} m/s`);

await browser.close();
console.log('done ->', OUT);

#!/usr/bin/env node
/**
 * Interleaved A/B for the rock CHROMA dials, inside ONE page load.
 *
 *   node tools/_scratch/rockhueab.mjs waterfall shots/rocks/hue
 *   VARIANTS='[{"tag":"base"},{"tag":"c2","cast":[1.02,0.96,1.03]}]' \
 *     node tools/_scratch/rockhueab.mjs hero shots/rocks/hue --cloud 0
 *
 * Successor to rockstepab.mjs, which drives uStepMix/uStepSize — uniforms that
 * no longer exist, because the value-step experiment they measured was a dead
 * end and was reverted. Same discipline, different dials: this one flips
 * uRockCast / uRockDesat / uRockRamp.
 *
 * Why one page load. Two `river` frames captured 34 minutes apart, with only
 * src/rocks changed, differed in 50.1% of pixels — five other authors were
 * saving in between. A before/after taken as two runs measures the hour, not
 * the change. Every frame here sees the same sway, the same dappled shadow and
 * the same water phase.
 *
 * --cloud <gain> forces Atmosphere's cloudShadowGain for every variant. The
 * lighting author is live on that term and rock is one of the surfaces it hits
 * hardest, so every reading is taken twice: at the shipped gain and at 0.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  river:     { anchor: 'river',    height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58, pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12, pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
};

const argv = process.argv.slice(2);
const view = argv[0] || 'waterfall';
const outBase = argv[1] || 'shots/rocks/hue';
const ci = argv.indexOf('--cloud');
const cloudGain = ci >= 0 ? Number(argv[ci + 1]) : null;

const variants = JSON.parse(process.env.VARIANTS || '[{"tag":"base"}]');
const W = 1600, H = 900;
mkdirSync(dirname(outBase), { recursive: true });

const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('rock-hue-ab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('ROCK')) console.log(t); });
page.on('pageerror', (e) => console.error('page error:', String(e)));
// Vite HMR: another author saving mid-run reloads the page and silently splits
// the sweep across two page loads, which is the exact failure this rig exists
// to avoid. Stamp the load and re-check it before every screenshot.
let reloaded = false;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloaded = true; });
const assertOneLoad = (tag) => {
  if (reloaded) throw new Error(`RELOAD during "${tag}"`);
};

// The whole sweep is retried from a fresh load rather than salvaged, because a
// sweep split across two loads is worthless — that is the entire premise here.
const ATTEMPTS = Number(process.env.ATTEMPTS || 6);
let ok = false;
for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
try {
await page.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
reloaded = false;

await page.evaluate(async ({ v, frozen, cloudGain }) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  if (cloudGain !== null && window.__atmosphere) {
    window.__atmosphere.params.cloudShadowGain = cloudGain;
    window.__rockAbCloudPin = cloudGain;
  }
  const anchor = frozen[v.anchor];
  const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back;
  const gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  const ray0 = new THREE.Raycaster(); ray0.far = 6;
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 6; attempt++) {
    dir.copy(look).sub(pos).normalize();
    ray0.set(pos, dir);
    const hits = ray0.intersectObjects(e.scene.children, true)
      .filter((h) => h.distance > 0.05 && h.object.visible && h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4;
  if (pos.y < g) pos.y = g;
  e.camera.fov = v.fov;
  e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos);
  e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  if (window.__settle) await window.__settle(120);
}, { v: VIEWS[view], frozen, cloudGain });

// Snapshot the shipped values once, so every variant is applied to the same
// baseline rather than to whatever the previous variant left behind.
const base = await page.evaluate(() => {
  const u = window.__systems.rocks?.material?.userData?.uniforms;
  if (!u) throw new Error('rock material uniforms not found');
  return {
    cast: [u.uRockCast.value.x, u.uRockCast.value.y, u.uRockCast.value.z],
    desat: u.uRockDesat.value,
    ramp: [u.uRockRamp.value.x, u.uRockRamp.value.y, u.uRockRamp.value.z, u.uRockRamp.value.w],
  };
});
console.log('shipped:', JSON.stringify(base));

// A rocks-hidden frame from this same load. Every rock number below is taken
// on a difference mask against it (tools/_scratch/rockmaskmap.mjs --diff), so
// it is rock pixels against exactly the host pixels each rock covers, rather
// than a rect drawn by eye that also contains the terrain massif behind it.
if (argv.includes('--hidden')) {
  assertOneLoad('hidden');
  await page.evaluate(async () => {
    for (const m of window.__systems.rocks.meshes) m.visible = false;
    if (window.__settle) await window.__settle(40);
  });
  await page.screenshot({ path: `${outBase}-hidden.png` });
  console.log(`wrote ${outBase}-hidden.png  (rock meshes hidden)`);
  await page.evaluate(async () => {
    for (const m of window.__systems.rocks.meshes) m.visible = true;
    if (window.__settle) await window.__settle(40);
  });
}

for (const v of variants) {
  assertOneLoad(v.tag);
  await page.evaluate(async ({ v, base, cloudGain }) => {
    const u = window.__systems.rocks.material.userData.uniforms;
    const c = v.cast || base.cast, r = v.ramp || base.ramp;
    u.uRockCast.value.set(c[0], c[1], c[2]);
    u.uRockDesat.value = v.desat ?? base.desat;
    u.uRockRamp.value.set(r[0], r[1], r[2], r[3]);
    // Re-pin every frame: Atmosphere's update rewrites params each tick.
    if (cloudGain !== null && window.__atmosphere) window.__atmosphere.params.cloudShadowGain = cloudGain;
    if (window.__settle) await window.__settle(40);
  }, { v, base, cloudGain });
  const path = `${outBase}-${v.tag}.png`;
  assertOneLoad(v.tag);
  await page.screenshot({ path });
  console.log(`wrote ${path}  cast=${JSON.stringify(v.cast || base.cast)} desat=${v.desat ?? base.desat} ramp=${JSON.stringify(v.ramp || base.ramp)}`);
}
assertOneLoad('final');
ok = true;
} catch (err) {
  if (!/RELOAD|Execution context was destroyed|Target closed/.test(String(err))) throw err;
  console.error(`attempt ${attempt}/${ATTEMPTS} discarded: the page reloaded mid-sweep (Vite HMR - another author saved). Retrying from a fresh load.`);
}
}
if (!ok) { await browser.close(); console.error(`no clean single-load sweep in ${ATTEMPTS} attempts`); process.exit(2); }
console.log('sweep completed inside ONE page load');

await browser.close();

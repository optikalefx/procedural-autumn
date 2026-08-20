#!/usr/bin/env node
/**
 * How often does the chase camera end up inside a rock?
 *
 * Headless, no browser, no GPU, ~20 s, deterministic — the same instrument the
 * rocks author used for the placement half (`rockroad.mjs`), pointed at the
 * other half. A browser sweep can show *whether* one anchor still shows the
 * wedge; this measures the fit itself over thousands of poses, and `poi.anchor`
 * is not stable enough across page loads (P3) to do that with screenshots.
 *
 * It is an A/B of the camera code, not a re-derivation of it:
 *
 *   · the boom is posed by `chaseDesired` and fitted by `boomFree`, both
 *     imported from `src/vehicle/CameraRig.js`. The tool supplies nothing but
 *     the `floorAt(x, z)` callback, and the two arms differ *only* in whether
 *     that callback includes the rock term.
 *   · the rock term is `RockBoom.lift` — the same object the rig runs.
 *   · the score is `RockBoom.insideAny`, the exact oriented bounding box, which
 *     the dome deliberately is not. Scoring the approximation against itself
 *     would prove nothing.
 *
 * Poses: every road centreline point (thinned), plus off-road points on ground
 * a camper could actually be on — because the road corridor is exactly the case
 * the placement rule already covers, and the residual is off it. At each pose,
 * six orbit yaws and three zooms (5.5 / 19 / 68), pitch at its rest value for
 * that zoom, which is where the rig leaves it.
 *
 * Two knowing approximations, both identical in both arms:
 *   · cells are generated at minSize 0, where the game drops sub-0.8 m rock
 *     past ~40 m. That gives the audit slightly *more* rock than the player
 *     sees, which is the safe direction for a defect count.
 *   · `fast` is 0 (a stationary camper). Speed only lengthens the boom by 10%.
 *
 *   node tools/_scratch/camrock.mjs                 # the A/B
 *   node tools/_scratch/camrock.mjs --dome          # sweep the dome exponent
 *   node tools/_scratch/camrock.mjs --poses 200     # quicker
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';
import { RockField } from '../../src/vehicle/BoomClearance.js';
import { chaseDesired, boomFree, camClearance, restPitch } from '../../src/vehicle/CameraRig.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DOME = argv.includes('--dome');
const WHY = argv.includes('--why');
const NPOSE = parseInt(arg('poses', '600'), 10);
const res = arg('res', '768');

const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
const buf = readFileSync(new URL(file, dir));
const data = decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const world = new WorldData(data, SEED);
const library = buildRockLibrary(SEED);

const CELL = 64;
const scatter = new RockScatter(world, SEED);
scatter.setFootprints(archFootprints(library));

// ── the rocks stand-in ───────────────────────────────────────────────────────
// `RockBoom.prime` wants `{ cells: Map<any, {cx, cz, instances}>, library }`,
// which is the shape `Rocks` publishes (Rocks.js:64). Cells are generated once
// and cached, so a pose costs a Map build and nothing else.
const cache = new Map();
function cell(cx, cz) {
  const key = cx * 100003 + cz;
  let c = cache.get(key);
  if (!c) {
    const instances = [];
    scatter.generateCell(cx, cz, CELL, 0, instances);
    for (const inst of instances) {
      const n = library[inst.arch].length;
      inst.variant = Math.min(n - 1, Math.max(0, inst.variant | 0));
    }
    c = { cx, cz, instances };
    cache.set(key, c);
  }
  return c;
}
const rocksAt = (x, z, radius) => {
  const cells = new Map();
  const r = Math.ceil((radius + 46) / CELL);
  const ccx = Math.floor(x / CELL), ccz = Math.floor(z / CELL);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const c = cell(ccx + dx, ccz + dz);
      if (c.instances.length) cells.set(c.cx * 100003 + c.cz, c);
    }
  }
  return { cells, library };
};

// ── poses ────────────────────────────────────────────────────────────────────
const terrainFloor = (x, z) => Math.max(world.getHeight(x, z), world.getWaterHeight(x, z) ?? -1e9);

/** Deterministic off-road poses on ground a camper could be parked on. */
function offRoadPoses(n) {
  const out = [];
  const half = world.half;
  let s = 0x9e3779b9;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  let guard = 0;
  while (out.length < n && guard++ < n * 200) {
    const x = (rnd() * 2 - 1) * half * 0.94;
    const z = (rnd() * 2 - 1) * half * 0.94;
    const h = world.getHeight(x, z);
    if (world.getWaterDepth(x, z) > 0.3) continue;
    // Drivable: a camper does not park on a 40 degree face.
    const gx = (world.getHeight(x + 2, z) - world.getHeight(x - 2, z)) / 4;
    const gz = (world.getHeight(x, z + 2) - world.getHeight(x, z - 2)) / 4;
    if (Math.hypot(gx, gz) > 0.62) continue;
    out.push({ x, y: h + 0.9, z, kind: 'off' });
  }
  return out;
}

function roadPoses(n) {
  const pts = [];
  for (const line of world.roads) for (const p of line) pts.push(p);
  const step = Math.max(1, Math.floor(pts.length / n));
  const out = [];
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    out.push({ x: p.x, y: world.getHeight(p.x, p.z) + 0.9, z: p.z, kind: 'road' });
  }
  return out;
}

const poses = [...roadPoses(NPOSE), ...offRoadPoses(NPOSE)];
const YAWS = [0, 1.05, 2.09, Math.PI, -2.09, -1.05];
const ZOOMS = [5.5, 19, 68];

// ── the run ──────────────────────────────────────────────────────────────────
const anchor = new THREE.Vector3();
const desired = new THREE.Vector3();

/**
 * Fit one boom and report where the camera ended up. `useRock` is the whole
 * A/B: it is the only thing that differs between the two arms.
 */
function shoot(rb, pose, yaw, zoom, useRock) {
  const floorAt = useRock
    ? (x, z) => rb.lift(x, z, terrainFloor(x, z))
    : (x, z) => terrainFloor(x, z);

  chaseDesired(anchor, desired, {
    x: pose.x, y: pose.y, z: pose.z, yaw, zoom, pitch: restPitch(zoom), fast: 0,
  });
  const frac = boomFree(anchor, desired, zoom, floorAt);
  desired.lerpVectors(anchor, desired, frac);
  // `_liftEnd`, then the rig's own undamped hard floor (`_clearGround` at 0.7
  // of the clearance). Both go through the same `floorAt`.
  const clr = camClearance(zoom);
  desired.y = Math.max(desired.y, floorAt(desired.x, desired.z) + clr);
  desired.y = Math.max(desired.y, floorAt(desired.x, desired.z) + clr * 0.7);
  return { frac, x: desired.x, y: desired.y, z: desired.z };
}

const residual = [];

function run(domeP) {
  residual.length = 0;
  const rb = new RockField();
  rb.domeP = domeP;
  const tally = () => ({ shots: 0, inside: 0, graze: 0, wedge: 0, worstSub: 0, lift: 0, frac: 0, worst: null });
  const off = tally(), on = tally();

  for (const pose of poses) {
    rb.attach(rocksAt(pose.x, pose.z, 90));
    rb.prime(pose.x, pose.z, 82);
    if (!rb.n) continue;
    for (const zoom of ZOOMS) {
      for (const yaw of YAWS) {
        for (const [arm, useRock] of [[off, false], [on, true]]) {
          const c = shoot(rb, pose, yaw, zoom, useRock);
          arm.shots++;
          arm.frac += c.frac;
          const hit = rb.insideAny(c.x, c.y, c.z, 0);
          const near = hit ?? rb.insideAny(c.x, c.y, c.z, 1.5);
          if (hit) arm.inside++;
          if (near) arm.graze++;
          const { sub } = rb.worstSubtend(c.x, c.y, c.z);
          // The D3 read: a rock whose own radius exceeds its distance from the
          // lens cannot be anything but a flat plane across the frame.
          if (sub > 1) arm.wedge++;
          if (hit && WHY && useRock) {
            // What is left, and why. `u` is where in the rock's own footprint
            // the camera sits (1 = the plan edge), `depth` how far below its
            // top — the two numbers that say whether the dome leaked or the
            // boom simply had nowhere to go.
            const dx = c.x - hit.x, dz = c.z - hit.z;
            const lx = hit.r00 * dx + hit.r20 * dz, lz = hit.r02 * dx + hit.r22 * dz;
            residual.push({
              kind: pose.kind, zoom, frac: c.frac,
              arch: hit.arch, size: hit.size,
              u: Math.max(Math.abs(lx) / hit.ax, Math.abs(lz) / hit.az),
              depth: hit.top - c.y,
              rise: hit.top - world.getHeight(hit.x, hit.z),
            });
          }
          if (sub > arm.worstSub) {
            arm.worstSub = sub;
            arm.worst = { pose, zoom, yaw, sub, inside: !!hit, arch: hit?.arch, size: hit?.size };
          }
          arm.lift += c.y - terrainFloor(c.x, c.z);
        }
      }
    }
  }
  return { off, on };
}

const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;
const row = (tag, t) => console.log(
  `${tag.padEnd(16)} shots ${String(t.shots).padStart(6)}   inside a rock ${String(t.inside).padStart(5)} (${pct(t.inside, t.shots).padStart(6)})`
  + `   within 1.5 m ${String(t.graze).padStart(5)} (${pct(t.graze, t.shots).padStart(6)})`
  + `   sub>1 ${String(t.wedge).padStart(5)}   worst sub ${t.worstSub.toFixed(2)}`
  + `   mean boom ${(t.frac / Math.max(1, t.shots)).toFixed(3)}   mean air ${(t.lift / Math.max(1, t.shots)).toFixed(2)} m`,
);

console.log(`bake ${file}   poses ${poses.length} (road + off-road)   ${YAWS.length} yaws x ${ZOOMS.length} zooms`);

if (!DOME) {
  const { off, on } = run(6);
  console.log('');
  row('rock fit OFF', off);
  row('rock fit ON', on);
  console.log('');
  const w = off.worst;
  if (w) {
    console.log(`worst arm-off pose: (${w.pose.x.toFixed(0)}, ${w.pose.z.toFixed(0)}) ${w.pose.kind}`
      + `  zoom ${w.zoom}  yaw ${w.yaw.toFixed(2)}  sub ${w.sub.toFixed(2)}`
      + `  ${w.inside ? `camera INSIDE ${w.arch} size ${w.size.toFixed(1)}` : 'camera clear'}`);
  }
  if (WHY) {
    console.log(`\nwhat is left in the ON arm (${residual.length}):`);
    for (const r of residual) {
      console.log(`  ${r.kind.padEnd(4)} zoom ${String(r.zoom).padStart(4)}  boom ${r.frac.toFixed(2)}`
        + `  ${r.arch}/${r.size.toFixed(1)} m  rise ${r.rise.toFixed(1)} m`
        + `  u ${r.u.toFixed(2)}  ${r.depth.toFixed(1)} m below its top`);
    }
  }
} else {
  console.log('\ndome exponent sweep — how square the floor is over a rock footprint');
  for (const p of [2, 3, 4, 6, 8, 12]) {
    const { on } = run(p);
    row(`DOME_P ${p}`, on);
  }
}

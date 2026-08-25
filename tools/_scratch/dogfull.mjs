#!/usr/bin/env node
/**
 * dogfull — the whole dog, not just the rig.
 *
 * dogneck.mjs drives AnimRig with constant inputs and proves the solver is
 * smooth in isolation. Every remaining head snap therefore lives in what
 * CampDog feeds it — state transitions, recovery manoeuvres, pose blending —
 * so this runs the real CampDog against camp-shaped obstacle fields for
 * sim-minutes and measures:
 *
 *   · head world angular velocity, per frame, with the dog's full state
 *     recorded at every spike so the cause is readable from the report;
 *   · stuck episodes: a moving-state dog whose displacement over a rolling
 *     window is a body length or less.
 *
 *   node tools/_scratch/dogfull.mjs [--minutes 20] [--seeds 6] [--jitter]
 */
import * as THREE from 'three';
import { CampDog } from '../../src/camp/camp_dog.js';
import { layoutCamp } from '../../src/camp/camp_site.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const MINUTES = parseFloat(arg('minutes', '20'));
const SEEDS = parseInt(arg('seeds', '6'), 10);
const JITTER = argv.includes('--jitter');

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const world = {
  getHeight: (x, z) => 0.06 * Math.sin(x * 0.9) * Math.cos(z * 0.7),
  getSlope: () => 0,
  getWaterDepth: () => 0,
  isInBounds: () => true,
};

// Real prop fields: the actual camp layout, with each kind's measured
// half-extent-plus-half-a-dog radius (the numbers Camp._makeDog derives from
// the built meshes' bounding boxes).
const KIND_R = { tent: 1.85, telescope: 0.77, chair: 0.55, cooler: 0.60, table: 0.80, woodpile: 0.70 };
function makeObstacles(rnd) {
  const items = layoutCamp(rnd, world, 0, 0, {});
  return items.map((it) => ({ x: it.x, z: it.z, r: KIND_R[it.kind] ?? 0.6 }));
}

const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
let totalFrames = 0, totalSpikes = 0, totalStuck = 0, totalRespawn = 0;
const worstSpikes = [];
const stuckReports = [];
const respawnEvents = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const rnd = mulberry32(seed * 7919);
  const parent = new THREE.Group();
  const site = { x: 0, y: 0, z: 0 };
  const dog = new CampDog(parent, site, rnd, world, { obstacles: makeObstacles(rnd) });
  const camPos = new THREE.Vector3(4, 1.6, 4);

  const head = dog.inst.byName['head'];
  let warm = 0;
  const trail = [];             // rolling window of {t, x, z} for stuck detection
  let stuckT = -1;              // start of the current stuck episode, or -1
  let prevState = dog.stateName;
  let prevBlend = 0, prevSpeed = 0;
  let simT = 0;
  const respawns0 = dog.respawns ?? 0;

  const frames = Math.round(MINUTES * 60 * 60);
  for (let i = 0; i < frames; i++) {
    const dt = JITTER ? (1 / 60) * (0.5 + rnd() * 1.6) : 1 / 60;
    simT += dt;
    const st0 = dog.stateName, bl0 = dog.blend, sp0 = dog.speed;
    const respawns = dog.respawns;
    const preClear = dog.nearestClearance, preRecovering = dog.recovering,
      preRecoverCount = dog.recoverCount;
    dog.update(dt, camPos);
    parent.updateMatrixWorld(true);
    head.getWorldQuaternion(q);
    if (dog.respawns !== respawns) {
      // The teleport frame is a deliberate pop, not an animation defect —
      // exclude it from the jerk metric but keep the event visible.
      warm = 0;
      trail.length = 0;
      respawnEvents.push({
        seed, t: +simT.toFixed(0), from: st0,
        clear: +preClear.toFixed(2), recovering: preRecovering, recovers: preRecoverCount,
      });
      if (stuckT >= 0) { stuckReports.push({ seed, at: +stuckT.toFixed(0), dur: +(simT - stuckT).toFixed(1), ended: 'respawn' }); totalStuck++; stuckT = -1; }
    }
    if (warm++ > 120) {
      const w = 2 * Math.acos(Math.min(1, Math.abs(q.dot(qp)))) / dt;
      totalFrames++;
      if (w > 4.5) {
        totalSpikes++;
        worstSpikes.push({
          seed, t: +simT.toFixed(1), w: +w.toFixed(1),
          state: `${st0}->${dog.stateName}`,
          blend: `${bl0.toFixed(2)}->${dog.blend.toFixed(2)}`,
          speed: `${sp0.toFixed(2)}->${dog.speed.toFixed(2)}`,
          recovering: dog.recovering, clear: +dog.nearestClearance.toFixed(2),
        });
      }
    }
    qp.copy(q);

    // Stuck: in a moving state, yet the last 6 s of trail spans < 0.30 m.
    trail.push({ t: simT, x: dog.pos.x, z: dog.pos.z });
    while (trail.length && trail[0].t < simT - 6) trail.shift();
    const moving = dog.stateName === 'wander' || dog.stateName === 'approach';
    if (moving && trail.length > 60 && simT - trail[0].t > 5.5) {
      const d = Math.hypot(dog.pos.x - trail[0].x, dog.pos.z - trail[0].z);
      if (d < 0.30) {
        if (stuckT < 0) { stuckT = simT; }
      } else if (stuckT >= 0) {
        stuckReports.push({ seed, at: +stuckT.toFixed(0), dur: +(simT - stuckT).toFixed(1), clear: +dog.nearestClearance.toFixed(2) });
        totalStuck++; stuckT = -1;
      }
    } else if (stuckT >= 0) {
      stuckReports.push({ seed, at: +stuckT.toFixed(0), dur: +(simT - stuckT).toFixed(1), clear: +dog.nearestClearance.toFixed(2), ended: dog.stateName });
      totalStuck++; stuckT = -1;
    }
    prevState = dog.stateName; prevBlend = dog.blend; prevSpeed = dog.speed;
  }
  if (stuckT >= 0) { stuckReports.push({ seed, at: +stuckT.toFixed(0), dur: +(simT - stuckT).toFixed(1), openEnded: true }); totalStuck++; }
  totalRespawn += (dog.respawns ?? 0) - respawns0;
}

worstSpikes.sort((a, b) => b.w - a.w);
console.log(`${SEEDS} seeds x ${MINUTES} sim-min  (${totalFrames} measured frames${JITTER ? ', dt jitter' : ''})`);
console.log(`head ang-vel spikes >4.5 rad/s: ${totalSpikes}`);
for (const s of worstSpikes.slice(0, 12)) console.log('  ', JSON.stringify(s));
console.log(`stuck episodes (>5.5 s under 0.30 m in a moving state): ${totalStuck}`);
for (const s of stuckReports.slice(0, 12)) console.log('  ', JSON.stringify(s));
console.log(`respawns: ${totalRespawn}`);
for (const r of respawnEvents.slice(0, 20)) console.log('  ', JSON.stringify(r));

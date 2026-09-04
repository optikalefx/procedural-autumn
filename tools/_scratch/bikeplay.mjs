#!/usr/bin/env node
/**
 * What does a PLAYER get, as opposed to a rider hunting the fall line?
 *
 * bikefly.mjs answers "can this valley launch a bike" and does it with a rider
 * that seeks the steepest descent and holds full pedal — which is the right
 * rider for that question and the wrong one for "am I getting air while I
 * play". The user's report is the second question.
 *
 * Three riders, so the difference is visible rather than assumed:
 *
 *   cruise   pedal, wander gently. Somebody riding around looking at the trees.
 *   explore  pedal, prefer downhill but do not hunt it. Somebody going places.
 *   seeker   bikefly.mjs's rider: the fall line, at full effort, always.
 *
 *   node tools/_scratch/bikeplay.mjs            # current constants
 *   AIR_G=6.5 node tools/_scratch/bikeplay.mjs  # patched copy, see loadPhysics
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';

// src/ must not read env vars (`process` does not exist in a browser), so a
// sweep patches a copy of the module with its imports rewritten to reach back
// out of the scratch directory. Same trick as bikefly.mjs.
async function loadPhysics() {
  const over = ['AIR_G', 'AIR_POP', 'LAUNCH_MARGIN', 'CURVE_SPAN'].filter((k) => process.env[k]);
  let url = new URL('../../src/bike/bike_physics.js', import.meta.url);
  if (over.length) {
    let src = readFileSync(url, 'utf8');
    for (const k of over) {
      const re = new RegExp(`const ${k} = [\\d.]+;`);
      if (!re.test(src)) throw new Error(`no constant ${k} to override`);
      src = src.replace(re, `const ${k} = ${Number(process.env[k])};`);
    }
    src = src.replace("'../core/MathUtils.js'", "'../../src/core/MathUtils.js'")
             .replace("'../vegetation/grass_scatter.js'", "'../../src/vegetation/grass_scatter.js'");
    url = new URL(`./_bp_${over.map((k) => `${k}_${process.env[k]}`).join('_').replace(/\./g, '_')}.js`, import.meta.url);
    writeFileSync(url, src);
  }
  return (await import(url.href)).BikePhysics;
}
const BikePhysics = await loadPhysics();

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const SIZE = W.worldSize ?? W.size;
const DIM = { wheelbase: 1.1, wheelR: 0.35 };
const DT = 1 / 60, RIDES = 50, SECONDS = 60;

const fallAt = (x, z, h, D = 16) => W.getHeight(x, z) - W.getHeight(x + Math.sin(h) * D, z + Math.cos(h) * D);

const RIDERS = {
  // Wander: a slow sine on the bars, no idea where the hills are.
  cruise: (p, t) => Math.sin(t * 0.45) * 0.5 + Math.sin(t * 0.17) * 0.3,
  // Prefer downhill, weakly — a rider going somewhere, not hunting a jump.
  explore: (p, t) => {
    const d = (fallAt(p.x, p.z, p.heading + 0.4) - fallAt(p.x, p.z, p.heading - 0.4)) * 0.35;
    return Math.max(-1, Math.min(1, d + Math.sin(t * 0.3) * 0.35));
  },
  // The fall line, always.
  seeker: (p, t) => {
    const d = (fallAt(p.x, p.z, p.heading + 0.35) - fallAt(p.x, p.z, p.heading - 0.35)) * 1.2;
    return Math.max(-1, Math.min(1, d));
  },
};

function run(steer) {
  let rng = 424242;
  const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
  const R = SIZE * 0.5 - 90;
  const flights = [], speeds = [];
  let simT = 0, airT = 0;
  for (let r = 0; r < RIDES; r++) {
    let x, z, tries = 0;
    do { x = (rnd() * 2 - 1) * R; z = (rnd() * 2 - 1) * R; }
    while (++tries < 200 && (W.getSlope(x, z) > 0.55 || W.getWaterDepth(x, z) > 0.2));
    const p = new BikePhysics(W, DIM).place(x, z, rnd() * Math.PI * 2);
    let air = 0, peak = 0;
    for (let i = 0; i < SECONDS / DT; i++) {
      const t = i * DT;
      p.step(DT, t, { fwd: 1, turn: steer(p, t) });
      if (!Number.isFinite(p.x)) break;
      simT += DT; speeds.push(Math.abs(p.speed));
      if (p.airborne) { airT += DT; air += DT; peak = Math.max(peak, p.airPeak); }
      else if (air > 0) { if (air >= 0.18) flights.push({ air, peak }); air = 0; peak = 0; }
    }
  }
  return { flights, speeds, simT, airT };
}

const q = (a, pc) => (a.length ? a.slice().sort((u, v) => u - v)[Math.floor(pc * (a.length - 1))] : 0);
const label = ['AIR_G', 'AIR_POP', 'LAUNCH_MARGIN', 'CURVE_SPAN']
  .filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join(' ') || 'shipped constants';
console.log(`${label} — ${RIDES} rides x ${SECONDS}s each\n`);
console.log('rider     speed p50/p90   jumps   per minute   hang p50/max   height p50/max');
for (const [name, steer] of Object.entries(RIDERS)) {
  const { flights, speeds, simT } = run(steer);
  const airs = flights.map((f) => f.air), peaks = flights.map((f) => f.peak);
  console.log(
    `${name.padEnd(9)} ${q(speeds, 0.5).toFixed(1)} / ${q(speeds, 0.9).toFixed(1)} m/s` +
    `   ${String(flights.length).padStart(4)}` +
    `   ${(flights.length / (simT / 60)).toFixed(2).padStart(6)}` +
    `      ${q(airs, 0.5).toFixed(2)} / ${q(airs, 1).toFixed(2)} s` +
    `   ${q(peaks, 0.5).toFixed(2)} / ${q(peaks, 1).toFixed(2)} m`);
}

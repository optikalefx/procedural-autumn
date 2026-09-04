#!/usr/bin/env node
/**
 * Does the bike actually get air now, and does it get it in the right places?
 *
 * Runs BikePhysics against the shipping bake at a fixed 60 Hz, riding straight
 * lines from random starts with the pedals down, and reports every flight.
 *
 * The three things that would make this feature a bug rather than a feature,
 * each of which this is looking for:
 *
 *   · flights on FLAT ground — the launch test firing on bilinear seams
 *   · flights that never end — a landing test that cannot be satisfied
 *   · a bike that spends most of its life airborne — a washboard, not a jump
 *
 *   node tools/_scratch/bikefly.mjs
 */
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';
// The span under test is a constant in the physics, not a parameter — src/ must
// not read env vars, because `process` does not exist in a browser and the one
// version of this that did would have thrown on page load. So a sweep patches a
// COPY of the module, with its two relative imports rewritten to reach back out
// of the scratch directory.
const SPAN = process.env.CURVE_SPAN;
let modUrl = new URL('../../src/bike/bike_physics.js', import.meta.url);
if (SPAN) {
  const { writeFileSync, readFileSync: rf } = await import('node:fs');
  const src = rf(modUrl, 'utf8')
    .replace(/const CURVE_SPAN = [\d.]+;/, `const CURVE_SPAN = ${Number(SPAN)};`)
    .replace("'../core/MathUtils.js'", "'../../src/core/MathUtils.js'")
    .replace("'../vegetation/grass_scatter.js'", "'../../src/vegetation/grass_scatter.js'");
  modUrl = new URL(`./_bp_span_${String(SPAN).replace('.', '_')}.js`, import.meta.url);
  writeFileSync(modUrl, src);
}
const { BikePhysics } = await import(modUrl.href);

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const SIZE = W.worldSize ?? W.size;
const DIM = { wheelbase: 1.1, wheelR: 0.35 };
const HZ = Number(process.env.HZ ?? 60);
const DT = 1 / HZ;
const SECONDS = 40;

let rng = 987654321;
const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;

const flights = [];          // { air, peak, drop, speed, ground }
let simT = 0, airT = 0, frames = 0, stuckAir = 0, rides = 0;
const speeds = [];
const R = SIZE * 0.5 - 90;

// What a player does is find a hill and point down it, and the first version of
// this harness did not: it steered by a weak left/right height compare and the
// bike spent the run crawling — p50 speed 2.3 m/s against the ~10 m/s the crest
// census says a launch needs. A rider that never goes fast cannot answer a
// question about going fast.
//
// So: start high, and steer down the fall line every frame.
const dropAhead = (x, z, hd) => {
  const D = 14;
  return W.getHeight(x, z) - W.getHeight(x + Math.sin(hd) * D, z + Math.cos(hd) * D);
};

for (let r = 0; r < 60; r++) {
  // Start somewhere with real height above its surroundings — the top of a run.
  let x = 0, z = 0, best = -Infinity;
  for (let c = 0; c < 220; c++) {
    const cx = (rnd() * 2 - 1) * R, cz = (rnd() * 2 - 1) * R;
    if (W.getSlope(cx, cz) > 0.55 || W.getWaterDepth(cx, cz) > 0.2) continue;
    // How much fall is available in the best direction from here.
    let fall = -Infinity;
    for (let a = 0; a < 8; a++) fall = Math.max(fall, dropAhead(cx, cz, a / 8 * Math.PI * 2));
    if (fall > best) { best = fall; x = cx; z = cz; }
  }
  let h0 = 0, hb = -Infinity;
  for (let a = 0; a < 24; a++) {
    const hd = a / 24 * Math.PI * 2, d = dropAhead(x, z, hd);
    if (d > hb) { hb = d; h0 = hd; }
  }
  const p = new BikePhysics(W, DIM).place(x, z, h0);
  rides++;
  let t = 0, wasAir = false, runAir = 0, peak = 0;
  for (let i = 0; i < SECONDS / DT; i++) {
    // Pedal, and hold the fall line: compare the drop 20° either side and turn
    // toward the steeper one. That is a rider looking for speed, which is the
    // rider this question is about.
    const dL = dropAhead(p.x, p.z, p.heading + 0.35);
    const dR = dropAhead(p.x, p.z, p.heading - 0.35);
    const turn = Math.max(-1, Math.min(1, (dL - dR) * 1.2));
    p.step(DT, t, { fwd: 1, turn });
    t += DT; simT += DT; frames++;
    speeds.push(Math.abs(p.speed));
    if (p.airborne) { airT += DT; runAir += DT; peak = Math.max(peak, p.airPeak); }
    if (p.airborne && runAir > 6) stuckAir++;
    if (!p.airborne && wasAir) {
      const g = W.getSlope(p.x, p.z);
      flights.push({ air: runAir, peak, drop: p.landImpact, speed: Math.abs(p.speed), ground: g });
      runAir = 0; peak = 0;
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { console.log('NaN at ride', r, 'frame', i); break; }
    wasAir = p.airborne;
  }
}

const q = (a, pc) => a.length ? a.slice().sort((u, v) => u - v)[Math.floor(pc * (a.length - 1))] : 0;
const air = flights.map(f => f.air);
const long = flights.filter(f => f.air >= 0.18);
console.log(`${rides} rides x ${SECONDS}s at ${HZ} Hz  —  ${simT.toFixed(0)}s simulated`);
console.log(`flights            ${flights.length}   (${long.length} over the 0.18 s report threshold)`);
console.log(`speed              p50 ${q(speeds,0.5).toFixed(1)}  p90 ${q(speeds,0.9).toFixed(1)}  p99 ${q(speeds,0.99).toFixed(1)}  max ${q(speeds,1).toFixed(1)} m/s`);
console.log(`airborne fraction  ${(100 * airT / simT).toFixed(2)}% of ride time`);
console.log(`flight duration    p50 ${q(air,0.5).toFixed(3)}s  p90 ${q(air,0.9).toFixed(3)}s  max ${q(air,1).toFixed(3)}`);
console.log(`landing drop       p50 ${q(flights.map(f=>f.drop),0.5).toFixed(2)}  max ${q(flights.map(f=>f.drop),1).toFixed(2)} m/s`);
console.log(`never-landed runs  ${stuckAir === 0 ? 'none' : stuckAir + ' frames over 6 s aloft'}`);
console.log(`\nthe long ones (what a player would call a jump):`);
for (const f of long.sort((a, b) => b.air - a.air).slice(0, 8)) {
  console.log(`  ${f.air.toFixed(2)}s aloft, ${f.peak.toFixed(2)} m up, landed at ${f.drop.toFixed(1)} m/s onto slope ${f.ground.toFixed(2)}, rolling away at ${f.speed.toFixed(1)} m/s`);
}

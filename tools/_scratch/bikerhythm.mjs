#!/usr/bin/env node
/**
 * What the bike's rhythm bonus is actually worth, against the real valley.
 *
 * The boat's equivalent (rhythm_test.mjs) runs on a flat synthetic lake, which
 * is fine for a hull. A bike lives on the terrain — rolling resistance depends
 * on what it is riding over and the grade dominates everything — so this rides
 * real ground and reports the three cases that matter:
 *
 *   hold      W down the whole time: the floor the bonus stacks on
 *   on-beat   tapped to RHYTHM.target — the game played well
 *   off-beat  mashed at half the interval — the game played badly, which must
 *             be WORSE than holding or the meter is just a tapping tax
 *
 *   node tools/_scratch/bikerhythm.mjs
 */
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';
import { BikePhysics } from '../../src/bike/bike_physics.js';

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const SIZE = W.worldSize ?? W.size;
const DIM = { wheelbase: 1.1, wheelR: 0.35 };
const DT = 1 / 60, SECONDS = 40;

// Flat-ish ground, so the grade term does not drown the thing being measured.
let rng = 5150;
const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
const R = SIZE * 0.5 - 120;
const flats = [];
for (let i = 0; i < 40000 && flats.length < 24; i++) {
  const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
  if (W.getWaterDepth(x, z) > 0.05) continue;
  if (W.getSlope(x, z) > 0.12) continue;
  flats.push({ x, z, h: rnd() * Math.PI * 2 });
}

const HOLD_MS = 0.10;                      // how long a keyboard tap is down
const PATTERNS = {
  hold:     () => 1,
  onBeat:   (t, gap) => ((t % gap) < HOLD_MS ? 1 : 0),
  offBeat:  (t, gap) => ((t % (gap * 0.5)) < HOLD_MS ? 1 : 0),
};

function run(pattern, gap) {
  const speeds = [], meters = [];
  for (const s of flats) {
    const p = new BikePhysics(W, DIM).place(s.x, s.z, s.h);
    for (let i = 0; i < SECONDS / DT; i++) {
      const t = i * DT;
      p.step(DT, t, { fwd: pattern(t, gap) });
      if (!Number.isFinite(p.x)) break;
      if (t > 8 && !p.airborne) { speeds.push(Math.abs(p.speed)); meters.push(p.rhythm); }
    }
  }
  return { speeds, meters };
}

const q = (a, pc) => (a.length ? a.slice().sort((u, v) => u - v)[Math.floor(pc * (a.length - 1))] : 0);
const GAP = 0.5;                                    // the bike's beat
console.log(`${flats.length} flat starts x ${SECONDS}s, sampled after the first 8 s\n`);
console.log('pattern     speed p50    p90    max      meter p50   vs hold');
const base = run(PATTERNS.hold, GAP);
const hold = q(base.speeds, 0.5);
for (const [name, fn] of Object.entries(PATTERNS)) {
  const { speeds, meters } = name === 'hold' ? base : run(fn, GAP);
  const m = q(speeds, 0.5);
  console.log(`${name.padEnd(11)} ${m.toFixed(2).padStart(6)} ${q(speeds, 0.9).toFixed(2).padStart(6)} ` +
    `${q(speeds, 1).toFixed(2).padStart(6)} m/s   ${q(meters, 0.5).toFixed(2).padStart(8)}` +
    `   ${((m / hold - 1) * 100).toFixed(0).padStart(5)}%`);
}

// And the tempo itself: which gaps actually build a meter.
console.log('\ntap gap    meter p50   speed p50   (target 0.50 s, tol 0.11)');
for (const gap of [0.25, 0.35, 0.42, 0.5, 0.58, 0.7, 1.0]) {
  const { speeds, meters } = run(PATTERNS.onBeat, gap);
  console.log(`  ${gap.toFixed(2)} s     ${q(meters, 0.5).toFixed(2).padStart(6)}      ${q(speeds, 0.5).toFixed(2).padStart(6)} m/s`);
}

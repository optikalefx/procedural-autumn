#!/usr/bin/env node
/**
 * Could a bike get air off this valley's terrain?
 *
 * A wheel leaves the ground when the path it is asked to follow needs more
 * centripetal acceleration than gravity can supply:  v²·κ > g·cos θ.
 *
 * κ is measured on the surface the BIKE rides, which is not `getHeight`: it is
 * the two-contact average `(yFront + yRear)/2` at half = wheelbase/2, because
 * that average is what `_settle` puts the frame on. The 1.1 m wheelbase is a
 * low-pass filter and the whole question is how much survives it.
 *
 * Two things this has to be careful about:
 *  · `getHeight` is piecewise-BILINEAR over a 1.33 m texel, so it has creases,
 *    not curves. A crease's second derivative is a delta — it reads as infinite
 *    curvature at small DS and vanishes at large DS. Hence the DS sweep: a real
 *    crest keeps its launch speed as DS changes, a crease does not.
 *  · Every sample inside one crest is convex, so counting samples counts one
 *    hill hundreds of times. Crests are grouped into contiguous convex runs and
 *    each run contributes its EASIEST launch speed, once.
 */
import { readFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';

const dir = new URL('../../public/bakes/', import.meta.url);
const buf = readFileSync(new URL(`world-${SEED}-1536-a2d45edb.pab`, dir));
const W = new WorldData(decodeBake(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), SEED);
const SIZE = W.worldSize ?? W.size;
console.log(`seed ${SEED}  res ${W.res}  world ${SIZE} m  texel ${(SIZE / W.res).toFixed(2)} m`);

const HALF = 0.55, G = 9.81, CAP = 13;
const rideY = (x, z, fx, fz) =>
  (W.getHeight(x + fx * HALF, z + fz * HALF) + W.getHeight(x - fx * HALF, z - fz * HALF)) * 0.5;
const baseY = (x, z, fx, fz) =>
  (W.getBaseHeight(x + fx * HALF, z + fz * HALF) + W.getBaseHeight(x - fx * HALF, z - fz * HALF)) * 0.5;

function scan(sample, DS, lines = 300, steps = 900) {
  const crests = []; let metres = 0;
  let rng = 12345; const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
  const R = SIZE * 0.5 - 80;
  for (let line = 0; line < lines; line++) {
    const hx = rnd() * Math.PI * 2, fx = Math.sin(hx), fz = Math.cos(hx);
    let x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
    let ym1 = sample(x - fx * DS, z - fz * DS, fx, fz), y0 = sample(x, z, fx, fz);
    let run = Infinity;                       // easiest launch speed in the current convex run
    for (let s = 0; s < steps; s++) {
      const nx = x + fx * DS, nz = z + fz * DS;
      const y1 = sample(nx, nz, fx, fz);
      if (!Number.isFinite(y1)) break;
      metres += DS;
      const d2 = (y1 - 2 * y0 + ym1) / (DS * DS);
      const sl = (y1 - ym1) / (2 * DS);
      if (d2 < 0) {
        const k = -d2 / Math.pow(1 + sl * sl, 1.5);
        const v = Math.sqrt(G / Math.sqrt(1 + sl * sl) / k);
        if (v < run) run = v;
      } else if (run < Infinity) { crests.push(run); run = Infinity; }
      ym1 = y0; y0 = y1; x = nx; z = nz;
    }
    if (run < Infinity) crests.push(run);
  }
  crests.sort((a, b) => a - b);
  return { crests, metres };
}

const q = (a, p) => a[Math.floor(p * (a.length - 1))];
for (const [label, fn] of [['ride surface (getHeight)', rideY], ['bake only (no micro-detail)', baseY]]) {
  console.log(`\n── ${label} ──`);
  console.log('   DS   crests   p1    p5   p25   p50   |  at 8 m/s        at 13 m/s (coast cap)');
  for (const DS of [0.1, 0.25, 0.5, 1.0]) {
    const { crests: v, metres } = scan(fn, DS);
    const rate = (sp) => {
      const n = v.filter(s => s <= sp).length;
      return n ? `1 per ${(metres / n).toFixed(0).padStart(4)} m` : '     never';
    };
    console.log(`  ${DS.toFixed(2)}  ${String(v.length).padStart(6)}  ${q(v,0.01).toFixed(1).padStart(4)}  ${q(v,0.05).toFixed(1).padStart(4)}  ${q(v,0.25).toFixed(1).padStart(4)}  ${q(v,0.5).toFixed(1).padStart(4)}  |  ${rate(8)}   ${rate(13)}`);
  }
}

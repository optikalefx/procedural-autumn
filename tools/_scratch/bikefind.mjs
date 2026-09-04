#!/usr/bin/env node
/**
 * Find a jump worth filming, by riding to it — headless, no browser.
 *
 * The video tool spent four takes picking runs on terrain statistics and then
 * discovering the bike arrived at 5 m/s, or 18 m wide of the lip, or not at
 * all. The statistics cannot answer "will a bike get there fast enough"; only
 * riding it can, and riding it is cheap here — a whole run is a few thousand
 * `step` calls with no renderer attached.
 *
 * So: shortlist lips by curvature, ride to each one in the unit sim, and rank
 * by the flight actually achieved. Prints the run-in point and heading for
 * tools/_scratch/bikeair_video.mjs --at.
 *
 * The unit sim has no trees and no boulders (BikePhysics without a ctx), so a
 * winner here can still be caged in the game — which is why it prints several.
 *
 *   node tools/_scratch/bikefind.mjs [count]
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
const WANT = Number(process.argv[2] ?? 6);
const DIM = { wheelbase: 1.1, wheelR: 0.35 };
const DT = 1 / 60, SPAN = 2.2, G = 9.81, HALF = 0.55;

let rng = 20260903;
const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;

const contactY = (x, z, fx, fz) =>
  (W.getHeight(x + fx * HALF, z + fz * HALF) + W.getHeight(x - fx * HALF, z - fz * HALF)) * 0.5;

// ── shortlist: ground convex enough to launch a bike arriving at 11 m/s ──────
const lips = [];
const R = SIZE * 0.5 - 120;
for (let i = 0; i < 120000; i++) {
  const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
  if (W.getWaterDepth(x, z) > 0.1) continue;
  let bh = 0, bd = -1e9;
  for (let a = 0; a < 16; a++) {
    const h = a / 16 * Math.PI * 2;
    const d = W.getHeight(x, z) - W.getHeight(x + Math.sin(h) * 12, z + Math.cos(h) * 12);
    if (d > bd) { bd = d; bh = h; }
  }
  if (bd < 3) continue;
  const fx = Math.sin(bh), fz = Math.cos(bh), hh = SPAN * 0.5;
  const at = (k) => contactY(x + fx * k * hh, z + fz * k * hh, fx, fz);
  const ypp = (2 * at(-2) - at(-1) - 2 * at(0) - at(1) + 2 * at(2)) / (7 * hh * hh);
  if (11 * 11 * ypp > -(G + 2.5)) continue;
  const sx = x - fx * 60, sz = z - fz * 60;
  if (W.getSlope(sx, sz) > 0.5 || W.getWaterDepth(sx, sz) > 0.1) continue;
  const runIn = W.getHeight(sx, sz) - W.getHeight(x, z);
  if (runIn < 10) continue;
  lips.push({ x, z, h: bh, sx, sz, ypp, runIn });
}
console.log(`[find] ${lips.length} candidate lips`);

/** Ride from the run-in point, aiming at the lip. Report the best flight. */
function ride(c, seconds = 14) {
  const p = new BikePhysics(W, DIM).place(c.sx, c.sz, c.h);
  let best = null, air = 0, peak = 0, launch = null, top = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const dx = c.x - p.x, dz = c.z - p.z;
    const dist = Math.hypot(dx, dz);
    let want;
    if (dist > 4) want = Math.atan2(dx, dz);
    else {
      const fall = (h) => W.getHeight(p.x, p.z) - W.getHeight(p.x + Math.sin(h) * 16, p.z + Math.cos(h) * 16);
      want = p.heading + (fall(p.heading + 0.35) - fall(p.heading - 0.35)) * 0.5;
    }
    let err = want - p.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    p.step(DT, i * DT, { fwd: 1, turn: Math.max(-1, Math.min(1, err * 2.2)) });
    if (!Number.isFinite(p.x)) return null;
    top = Math.max(top, Math.abs(p.speed));
    if (p.airborne) { if (!air) launch = { t: i * DT, v: Math.abs(p.speed) }; air += DT; peak = Math.max(peak, p.airPeak); }
    else if (air > 0) {
      if (!best || air > best.air) best = { air, peak, at: launch.t, v: launch.v };
      air = 0; peak = 0;
    }
  }
  return best ? { ...c, ...best, top } : null;
}

const runs = [];
for (const c of lips) { const r = ride(c); if (r && r.air >= 0.25) runs.push(r); }
runs.sort((a, b) => b.air - a.air);
console.log(`[find] ${runs.length} of them produced a flight of 0.25 s or more\n`);
for (const r of runs.slice(0, WANT)) {
  console.log(`  ${r.air.toFixed(2)}s aloft, ${r.peak.toFixed(2)} m up, launching at ${r.v.toFixed(1)} m/s ` +
              `${r.at.toFixed(1)}s in (top ${r.top.toFixed(1)} m/s)`);
  console.log(`      --at ${r.sx.toFixed(2)},${r.sz.toFixed(2)},${r.h.toFixed(4)} --lip ${r.x.toFixed(1)},${r.z.toFixed(1)}`);
}

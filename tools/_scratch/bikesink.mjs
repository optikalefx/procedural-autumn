#!/usr/bin/env node
/**
 * "Going UP a hill the wheels clip into the ground; backwards DOWN a hill they
 * are fine." That asymmetry is the whole diagnosis: a symmetric cause — the
 * wheelbase chord cutting a convex crest, the wheel's radius under a pitched
 * frame — cannot care which way the bike is pointed. A LAG can, and does: a
 * filtered height always trails the ground, which reads as sinking when the
 * ground is rising under you and as a harmless float when it is falling.
 *
 * So measure the lag directly. For a bike ridden along a constant slope, how
 * far does the frame's published `y` sit below the true two-contact height it
 * is supposed to be sitting on?
 *
 *   node tools/_scratch/bikesink.mjs
 *
 * Anything approaching the 0.35 m wheel radius is a wheel buried to its axle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { SEED } from '../../src/world/WorldConfig.js';

async function loadPhysics() {
  const over = ['CONTACT_SMOOTH', 'WHEEL_GRIP'].filter((k) => process.env[k]);
  let url = new URL('../../src/bike/bike_physics.js', import.meta.url);
  if (over.length) {
    let src = readFileSync(url, 'utf8');
    for (const k of over) {
      const re = new RegExp(`const ${k} = [\\d.]+;`);
      if (!re.test(src)) throw new Error(`no constant ${k}`);
      src = src.replace(re, `const ${k} = ${Number(process.env[k])};`);
    }
    src = src.replace("'../core/MathUtils.js'", "'../../src/core/MathUtils.js'")
             .replace("'../vegetation/grass_scatter.js'", "'../../src/vegetation/grass_scatter.js'");
    url = new URL(`./_bp_sink_${over.map((k) => `${k}${process.env[k]}`).join('_').replace(/\./g, '_')}.js`, import.meta.url);
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
const HALF = 0.55, DT = 1 / 60;

const contactY = (x, z, fx, fz) =>
  (W.getHeight(x + fx * HALF, z + fz * HALF) + W.getHeight(x - fx * HALF, z - fz * HALF)) * 0.5;

/**
 * Ride from a start along a heading and report the steady-state error between
 * the frame's `y` and the ground it should be on. Positive = sunk into the hill.
 */
function sink(x0, z0, h, back) {
  const p = new BikePhysics(W, DIM).place(x0, z0, h);
  const errs = [], grades = [], jerk = [];
  let py = null, pv = null;
  for (let i = 0; i < 8 / DT; i++) {
    p.step(DT, i * DT, back ? { back: 1 } : { fwd: 1 });
    if (!Number.isFinite(p.x) || p.airborne) { py = pv = null; continue; }
    if (i < 2 / DT) continue;                       // let the filters settle
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    errs.push(contactY(p.x, p.z, fx, fz) - p.y);
    grades.push(p.grade);
    // What the CAMERA would feel: the frame-to-frame change in vertical speed.
    // Removing a filter from the height cannot be judged on the sink alone —
    // the filter is there to keep the eye steady, and this is what it buys.
    if (py !== null) {
      const v = (p.y - py) / DT;
      if (pv !== null) jerk.push(Math.abs(v - pv));
      pv = v;
    }
    py = p.y;
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const max = (a) => (a.length ? Math.max(...a) : 0);
  return { sink: mean(errs), worst: max(errs), grade: mean(grades),
           jerk: mean(jerk), jerkMax: max(jerk), n: errs.length };
}

// Find honest sustained slopes and ride each one up and down.
let rng = 77777;
const rnd = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
const R = SIZE * 0.5 - 120;
const runs = [];
for (let i = 0; i < 4000 && runs.length < 30; i++) {
  const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
  if (W.getWaterDepth(x, z) > 0.1) continue;
  const s = W.getSlope(x, z);
  if (s < 0.35 || s > 0.9) continue;               // a real hill, still rideable
  // Uphill heading: the steepest RISE.
  let bh = 0, bd = -1e9;
  for (let a = 0; a < 24; a++) {
    const hh = a / 24 * Math.PI * 2;
    const d = W.getHeight(x + Math.sin(hh) * 14, z + Math.cos(hh) * 14) - W.getHeight(x, z);
    if (d > bd) { bd = d; bh = hh; }
  }
  runs.push({ x, z, up: bh, down: bh + Math.PI });
}

const label = ['CONTACT_SMOOTH', 'WHEEL_GRIP'].filter((k) => process.env[k])
  .map((k) => `${k}=${process.env[k]}`).join(' ') || 'shipped constants';
console.log(`${label} — ${runs.length} hills, 8 s each, wheel radius ${DIM.wheelR} m\n`);
console.log('direction              grade   sink mean   sink worst   % of a wheel   eye jerk mean/max');
for (const [name, pick, back] of [
  ['riding UP',            (r) => r.up,   false],
  ['riding DOWN',          (r) => r.down, false],
  ['reversing DOWN', (r) => r.up,   true],
]) {
  const out = runs.map((r) => sink(r.x, r.z, pick(r), back)).filter((o) => o.n > 30);
  const mean = (f) => out.reduce((s, o) => s + f(o), 0) / Math.max(1, out.length);
  const m = mean((o) => o.sink), w = mean((o) => o.worst);
  console.log(`${name.padEnd(20)} ${mean((o) => o.grade).toFixed(2).padStart(6)}` +
    `   ${m.toFixed(3).padStart(8)} m   ${w.toFixed(3).padStart(8)} m   ${(100 * m / DIM.wheelR).toFixed(0).padStart(6)}%` +
    `   ${mean((o) => o.jerk).toFixed(2).padStart(7)} / ${mean((o) => o.jerkMax).toFixed(1)} m/s²`);
}

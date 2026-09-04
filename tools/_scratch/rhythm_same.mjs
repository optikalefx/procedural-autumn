#!/usr/bin/env node
/**
 * The kayak's rhythm game moved into src/core/rhythm.js so the bike could share
 * it. That refactor is only correct if the boat comes out bit-identical, so
 * this runs the same schedules through HEAD's boat_physics and the working
 * tree's and diffs the speed traces.
 *
 *   node tools/_scratch/rhythm_same.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const world = {
  getRiver: () => 0,
  getFlow: (x, z, out) => { out.vx = 0; out.vz = 0; out.q = 0; out.turb = 0; return out; },
  getHeight: () => 0,
  getWaterHeight: () => 5,
  getHydro: () => ({ sdf: 100, span: 100, wet: 1 }),
  _water: null,
};

// HEAD's version, with its relative imports rewritten to reach back out.
const old = execFileSync('git', ['show', 'HEAD:src/boat/boat_physics.js'], { encoding: 'utf8' })
  .replace("'../core/MathUtils.js'", `'${new URL('../../src/core/MathUtils.js', import.meta.url).href}'`)
  .replace("'./boat_site.js'", `'${new URL('../../src/boat/boat_site.js', import.meta.url).href}'`);
const dir = mkdtempSync(join(tmpdir(), 'rhythm-'));
const oldPath = join(dir, 'boat_physics_head.mjs');
writeFileSync(oldPath, old);

const { BoatPhysics: Old } = await import(`file://${oldPath}`);
const { BoatPhysics: New } = await import('../../src/boat/boat_physics.js');

const trace = (Cls, sched, maxSpeed, duration = 20, dt = 1 / 60) => {
  const p = new Cls(world, { length: 4, beam: 0.8, draft: 0.15 }, { maxSpeed });
  p.place(0, 0, 0);
  const out = [];
  for (let t = 0; t < duration; t += dt) {
    let fwd = 0;
    for (const [a, b] of sched) if (t >= a && t < b) { fwd = 1; break; }
    p.step(dt, t, { fwd, back: 0, turn: 0 });
    out.push([p.speed, p.rhythm]);
  }
  return out;
};

const every = (gap, hold = 0.15) => {
  const s = [];
  for (let i = 0; i < 30; i++) s.push([i * gap, i * gap + hold]);
  return s;
};

const CASES = [
  ['hold', [[0, 999]], 3.8],
  ['on-beat 1.0s', every(1.0), 3.8],
  ['too fast 0.4s', every(0.4), 3.8],
  ['too slow 2.2s', every(2.2), 3.8],
  ['canoe on-beat', every(1.0), 3.2],
];

let worst = 0;
for (const [name, sched, ms] of CASES) {
  const a = trace(Old, sched, ms), b = trace(New, sched, ms);
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d = Math.max(d, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
  }
  worst = Math.max(worst, d);
  console.log(`${name.padEnd(16)} HEAD ${a.at(-1)[0].toFixed(3)} m/s   now ${b.at(-1)[0].toFixed(3)} m/s   max |diff| over the run ${d.toExponential(1)}`);
}
console.log(worst === 0 ? '\nIDENTICAL — the refactor changed nothing on the water.'
                        : `\nDIFFERS by up to ${worst}`);

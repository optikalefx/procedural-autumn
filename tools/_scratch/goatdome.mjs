#!/usr/bin/env node
/**
 * How wrong is the goat's invisible dome, against the rock it is standing on?
 *
 * `Brain._groundY` does not know what a rock looks like. It gets `{x, z, top,
 * r}` out of `Wildlife._findPerches` and models the boulder as a dome — flat to
 * half the plan radius, falling to the hillside by 1.18 of it. This measures
 * that model against the actual polytope, so "the goat climbs an invisible
 * dome" stops being a description and becomes a number.
 *
 * Headless, no browser, no GPU, ~10 s, deterministic — the shape of
 * `rockroad.mjs`, which builds the same world the same way.
 *
 *   node tools/_scratch/goatdome.mjs [--res 768] [--n 40]
 *
 * Three questions, and they want different answers:
 *
 *   summit error   how far the dome is from the rock across the flat top. This
 *                  is the goat visibly floating or sunk while it is PERCHed.
 *   flank error    the same across the ramp, where the dome is doing its other
 *                  job — being the slope the animal walks up.
 *   real flank     the steepest true grade on the way in, per approach bearing.
 *                  THIS is the number that says how hard the fix is: a dome
 *                  flank is walkable by construction and a real facet is not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as THREE from 'three';
import { decodeBake } from '../../src/world/bakeFormat.js';
import { WorldData } from '../../src/world/WorldData.js';
import { RockScatter } from '../../src/rocks/RockScatter.js';
import { buildRockLibrary, archFootprints } from '../../src/rocks/RockForms.js';
import { SEED } from '../../src/world/WorldConfig.js';
import { bakePerchField, samplePerchField } from '../../src/rocks/Rocks.js';
import { GOAT } from '../../src/wildlife/mammals/goat.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const res = arg('res', '768');
const WANT = Number(arg('n', 40));

const dir = new URL('../../public/bakes/', import.meta.url);
const file = readdirSync(dir).find((f) => f.startsWith(`world-${SEED}-${res}-`));
if (!file) throw new Error(`no bake for seed ${SEED} at ${res}; run node tools/bake.mjs`);
const buf = readFileSync(new URL(file, dir));
const world = new WorldData(data_of(buf), SEED);
function data_of(b) {
  return decodeBake(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const library = buildRockLibrary(SEED);
const foot = archFootprints(library);
const scat = new RockScatter(world, SEED);
scat.setFootprints(foot);

const R = GOAT.brain.rock;
const CFG = R ?? { minSize: 1.1, maxR: 4.5, rise: [0.9, 4.0], steep: 0.42 };

// ── the same arithmetic Rocks.topOf / reachOf do ─────────────────────────────
const footOf = (inst) => {
  const list = foot[inst.arch];
  if (!list || !list.length) return null;
  return list[Math.min(list.length - 1, Math.max(0, inst.variant | 0))];
};
const topOf = (i) => { const f = footOf(i); return f ? i.y + f.hi * i.sy : i.y; };
const reachOf = (i) => { const f = footOf(i); return f ? Math.max(f.rx * i.sx, f.rz * i.sz) : i.size * 0.5; };

// ── the truth: a vertical ray against the placed geometry ────────────────────
// The instance carries a full quaternion (crags are tilted toward the local
// dip), so the world ray is NOT a vertical ray in the rock's own space. Casting
// in world space after transforming the mesh is the honest way to do it.
const meshCache = new Map();
function placedMesh(inst) {
  const key = `${inst.arch}:${inst.variant}:${inst.sx}:${inst.sy}:${inst.sz}:${inst.qx}:${inst.qy}:${inst.qz}:${inst.qw}`;
  let m = meshCache.get(key);
  if (!m) {
    const geoms = library[inst.arch];
    const g = geoms[Math.min(geoms.length - 1, Math.max(0, inst.variant | 0))];
    m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    meshCache.set(key, m);
    if (meshCache.size > 400) meshCache.clear();
  }
  m.position.set(inst.x, inst.y, inst.z);
  m.quaternion.set(inst.qx, inst.qy, inst.qz, inst.qw);
  m.scale.set(inst.sx, inst.sy, inst.sz);
  m.updateMatrixWorld(true);
  return m;
}

const ray = new THREE.Raycaster();
ray.firstHitOnly = false;
const DOWN = new THREE.Vector3(0, -1, 0);
/** World Y of the rock's real top surface at (x, z), or null for a miss. */
function surfaceY(mesh, inst, x, z) {
  ray.set(new THREE.Vector3(x, inst.y + 400, z), DOWN);
  const hits = ray.intersectObject(mesh, false);
  return hits.length ? hits[0].point.y : null;
}

const smoothstep = (a, b, t) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const lerp = (a, b, t) => a + (b - a) * t;
/** `Brain._groundY` as it was: the bounding-box top, held flat to 0.5r. */
const domeY = (rock, gy, d) => {
  const y = lerp(rock.top, gy, smoothstep(rock.r * 0.50, rock.r * 1.18, d));
  return y > gy ? y : gy;
};

/**
 * `Brain._groundY` as it is now. The sample point is clamped into the standing
 * disc, so inside it the animal is on the real rock and outside the ramp starts
 * from the height it was just standing on.
 *
 * This calls the SHIPPED sampler rather than restating it; the bake it reads
 * comes from the shipped baker. Only the six lines of `_groundY` are mirrored,
 * and they are mirrored because importing `Brain` would drag in three.
 */
const fieldY = (rock, gy, x, z, d) => {
  let top = rock.top;
  if (rock.field) {
    const k = d > 1e-4 ? Math.min(d, rock.r * 0.50) / d : 0;
    const sv = samplePerchField(rock.field, rock.x + (x - rock.x) * k,
                                rock.z + (z - rock.z) * k);
    if (!Number.isNaN(sv)) top = sv;
  }
  const y = lerp(top, gy, smoothstep(rock.r * 0.50, rock.r * 1.18, d));
  return y > gy ? y : gy;
};

// ── find real goat perches, by the rule Wildlife._findPerches uses ───────────
const CELL = 64;
const NC = Math.ceil(world.half / CELL);
const perches = [];
outer:
for (let cz = -NC; cz <= NC; cz++) {
  for (let cx = -NC; cx <= NC; cx++) {
    const cell = [];
    scat.generateCell(cx, cz, CELL, 0, cell);
    for (const inst of cell) {
      if (inst.size < CFG.minSize) continue;
      const r = reachOf(inst);
      if (r > CFG.maxR) continue;
      const top = topOf(inst);
      const gy = world.getHeight(inst.x, inst.z);
      const rise = top - gy;
      if (rise < CFG.rise[0] || rise > CFG.rise[1]) continue;
      if (rise < r * CFG.steep) continue;
      // Goat country, so the sample is the rock a goat could actually reach.
      const alt = gy;
      if (alt < R.altBand[0] || alt > R.altBand[1]) continue;
      const geoms = library[inst.arch];
      const field = bakePerchField(
        geoms[Math.min(geoms.length - 1, Math.max(0, inst.variant | 0))], inst, r);
      perches.push({ inst, x: inst.x, z: inst.z, top, r, rise, gy, field });
      if (perches.length >= WANT) break outer;
    }
  }
}

console.log(`bake ${file}`);
console.log(`goat perches sampled: ${perches.length} `
  + `(minSize ${CFG.minSize}, maxR ${CFG.maxR}, rise ${CFG.rise}, steep ${CFG.steep})\n`);

const summit = [], flank = [], grades = [];
const summitNew = [], flankNew = [];
let missTop = 0, nTop = 0;
for (const p of perches) {
  const mesh = placedMesh(p.inst);
  // A grid across the rock, in the plan the animal walks over.
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const x = p.x + (i / 6) * p.r * 1.18;
      const z = p.z + (j / 6) * p.r * 1.18;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d > p.r * 1.18) continue;
      const gy = world.getHeight(x, z);
      const dome = domeY(p, gy, d);
      const real = surfaceY(mesh, p.inst, x, z);
      const truth = real === null ? gy : Math.max(real, gy);
      const err = dome - truth;                    // + is the goat floating
      const errNew = fieldY(p, gy, x, z, d) - truth;
      if (d <= p.r * 0.50) {
        nTop++;
        if (real === null) missTop++;
        summit.push(err); summitNew.push(errNew);
      } else { flank.push(err); flankNew.push(errNew); }
    }
  }
  // The real grade on the way in: worst rise per metre along 16 bearings,
  // sampled from the foot of the rock to its centre.
  for (let a = 0; a < 16; a++) {
    const th = (a / 16) * Math.PI * 2;
    let worst = 0, prev = null, prevD = null;
    for (let s = 0; s <= 20; s++) {
      const d = p.r * 1.5 * (1 - s / 20);
      const x = p.x + Math.sin(th) * d, z = p.z + Math.cos(th) * d;
      const gy = world.getHeight(x, z);
      const real = surfaceY(mesh, p.inst, x, z);
      const y = real === null ? gy : Math.max(real, gy);
      if (prev !== null && prevD !== d) {
        const g = Math.abs(y - prev) / Math.max(1e-3, Math.abs(prevD - d));
        if (g > worst) worst = g;
      }
      prev = y; prevD = d;
    }
    grades.push(worst);
  }
}

const stat = (a, name) => {
  if (!a.length) return console.log(`${name}: no samples`);
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((t, v) => t + v, 0) / s.length;
  console.log(`${name.padEnd(22)} n=${String(s.length).padEnd(6)} `
    + `mean ${mean.toFixed(3)}  p50 ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  `
    + `min ${s[0].toFixed(3)}  max ${s[s.length - 1].toFixed(3)}`);
};

console.log('BEFORE — flat bbox top, minus real surface (+ = the goat floats):');
stat(summit, '  across the summit');
stat(flank, '  across the flank');
console.log('\nAFTER — real field on top, dome ramp outside:');
stat(summitNew, '  across the summit');
stat(flankNew, '  across the flank');
console.log(`  summit samples that miss the rock entirely: ${missTop}/${nTop} `
  + `(${(100 * missTop / Math.max(1, nTop)).toFixed(0)}%) — the dome`
  + ` says "rock" where there is only hillside\n`);

console.log('the real grade an animal would have to walk up (rise per metre):');
stat(grades, '  worst per bearing');
const walkable = grades.filter((g) => g <= (R.slopeMax ?? 0.85)).length;
console.log(`  bearings within the goat's own slopeMax (${R.slopeMax ?? 0.85}): `
  + `${walkable}/${grades.length} (${(100 * walkable / grades.length).toFixed(0)}%)`);
console.log(`  the dome's flank grade, for comparison: `
  + `rise/(0.68*r) — always walkable by construction`);

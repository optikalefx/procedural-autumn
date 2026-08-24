#!/usr/bin/env node
/**
 * skytargets — does src/game/sky_objects.js still agree with the sky shader?
 *
 *   node tools/_scratch/skytargets.mjs
 *
 * The telescope's discovery feature needs to know where the planets and the
 * galaxies are, and they live as literals inside PLANET_GLSL and GALAXY_GLSL.
 * `src/game/sky_objects.js` mirrors those literals, its header says so, and
 * this is the check that keeps the copy honest: it re-parses the constants out
 * of the shader source and compares them against what the JS table computes.
 *
 * No browser and no GPU — this is a text-and-arithmetic check, so it is cheap
 * enough to run on every touch of either file. `tools/_scratch/planetshot.mjs`
 * is the visual counterpart: it aims the real ScopeView at each planet and
 * photographs what is actually drawn there.
 *
 * Exit status is 1 if anything drifted, so it can gate.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { SKY_OBJECTS } from '../../src/game/sky_objects.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const DEG = Math.PI / 180;

// How far apart the two sides may be before it matters. The discovery
// tolerance is a fraction of the eyepiece's field and never tighter than
// 0.55 deg, so a hundredth of a degree is three orders of magnitude inside
// anything a player could notice — which makes it a good tripwire.
const TOL_DEG = 0.01;

// ── the shader's own numbers ────────────────────────────────────────────────
const planetSrc = read('src/sky/planets.js');
const galaxySrc = read('src/sky/galaxies.js');

const pole = planetSrc.match(/#define PL_POLE normalize\(vec3\(([^)]*)\)\)/);
if (!pole) throw new Error('PL_POLE not found in src/sky/planets.js');
const POLE = new THREE.Vector3(...pole[1].split(',').map(Number)).normalize();

const plDir = (lon, lat) => {
  const u = new THREE.Vector3().crossVectors(POLE, new THREE.Vector3(0, 1, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(POLE, u);
  return new THREE.Vector3()
    .addScaledVector(u, Math.cos(lon) * Math.cos(lat))
    .addScaledVector(v, Math.sin(lon) * Math.cos(lat))
    .addScaledVector(POLE, Math.sin(lat))
    .normalize();
};

// plSystem(dir, lon, lat, rad * PL_DEG, ...) — the four calls in plPlanets.
const planets = [...planetSrc.matchAll(
  /plSystem\(dir,\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\s*\*\s*PL_DEG/g)]
  .map((m) => ({ dir: plDir(+m[1], +m[2]), rad: +m[3] }));

// GX_DIR_A/B/C, paired with the semi-major axis of the matching gxSpiral call.
const gdirs = Object.fromEntries([...galaxySrc.matchAll(
  /#define GX_DIR_(\w) normalize\(vec3\(([^)]*)\)\)/g)]
  .map((m) => [m[1], new THREE.Vector3(...m[2].split(',').map(Number)).normalize()]));
const galaxies = [...galaxySrc.matchAll(
  /gxSpiral\(dir,\s*GX_DIR_(\w),\s*([\d.]+)\s*\*\s*GX_DEG/g)]
  .map((m) => ({ key: m[1], dir: gdirs[m[1]], rad: +m[2] }));

const shader = [...planets, ...galaxies];

// ── compare ─────────────────────────────────────────────────────────────────
const table = SKY_OBJECTS.filter((o) => o.dir);       // the moon is a uniform
let bad = 0;

if (table.length !== shader.length) {
  console.error(`✗ count: the shader draws ${shader.length} fixed bodies, ` +
                `sky_objects.js lists ${table.length}`);
  bad++;
}

const el = (d) => (Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)) / DEG);
const az = (d) => (((Math.atan2(d.x, d.z) / DEG) + 360) % 360);

console.log('object            az     el    radius   drift');
for (let i = 0; i < Math.min(table.length, shader.length); i++) {
  const t = table[i], s = shader[i];
  const drift = Math.acos(THREE.MathUtils.clamp(t.dir.dot(s.dir), -1, 1)) / DEG;
  const radOff = Math.abs(t.rad - s.rad);
  const ok = drift <= TOL_DEG && radOff <= 1e-6;
  if (!ok) bad++;
  console.log(
    `${t.label.padEnd(17)} ${az(s.dir).toFixed(0).padStart(3)}  ` +
    `${el(s.dir).toFixed(1).padStart(5)}  ${s.rad.toFixed(3).padStart(6)}   ` +
    `${ok ? 'ok' : `${drift.toFixed(3)} deg / radius ${t.rad} vs ${s.rad}`}`);
}

// The telescope's own reach, from src/camp/camp_scope_view.js. A body outside
// it is a body no player can ever centre, which is the other way this feature
// can silently stop working.
const view = read('src/camp/camp_scope_view.js');
const pmax = +view.match(/const PITCH_MAX = ([\d.]+)/)[1] / DEG;
const pmin = +view.match(/const PITCH_MIN = ([-\d.]+)/)[1] / DEG;
for (let i = 0; i < shader.length; i++) {
  const e = el(shader[i].dir);
  if (e > pmax || e < pmin) {
    console.error(`✗ ${table[i]?.label ?? i} is at ${e.toFixed(1)} deg, outside ` +
                  `the telescope's ${pmin.toFixed(1)}..${pmax.toFixed(1)} deg reach`);
    bad++;
  }
}

console.log(bad ? `\n${bad} problem(s)` : '\nall targets agree with the shader');
process.exit(bad ? 1 : 0);

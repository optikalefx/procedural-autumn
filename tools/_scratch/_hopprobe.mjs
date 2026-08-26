#!/usr/bin/env node
/**
 * How high does the rabbit get?
 *
 * The reported bug is a single frame of a rabbit at altitude, and a screenshot
 * cannot catch a single frame. This drives a REAL `AnimRig` at a fixed 60 Hz
 * through the speed profiles a rabbit actually uses — the graze shuffle, which
 * starts and stops every few seconds, and the stand-then-bolt — and reports the
 * highest the root bone ever gets, in world metres above the body's base.
 *
 *   node tools/_scratch/_hopprobe.mjs
 *   node tools/_scratch/_hopprobe.mjs --species squirrel --trace
 */
import * as THREE from 'three';
import { SPECIES, buildSpecies } from '../../src/wildlife/animal_species.js';
import { createHideMaterial } from '../../src/wildlife/mammals/hide.js';
import { instantiate } from '../../src/wildlife/animal_rig.js';
import { AnimRig } from '../../src/wildlife/animal_anim.js';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const KEY = arg('species', 'rabbit');
const TRACE = argv.includes('--trace');
// Drop the rate limit only, keeping the apex cap, to see what it costs a
// legitimate arc: a parabola of apex h leaves the ground at sqrt(2·g·h), so
// it should cost an uncapped hop exactly nothing.
const NORATE = argv.includes('--norate');

const sp = SPECIES[KEY];
const v = sp.variants[0];
const proto = buildSpecies(KEY, 20261018)[0];
const inst = instantiate(proto, createHideMaterial(v.col), 0);
const holder = new THREE.Group();
holder.add(inst.mesh);
const rig = new AnimRig(proto, inst, v.scale, sp.gait, KEY);
const S = v.scale;
if (NORATE) rig.riseMax = Infinity;

const world = { getHeight: () => 0 };
const pos = new THREE.Vector3(0, 0, 0);
const drive = { pos, heading: 0, speed: 0, graze: 0, alert: 0, flag: 0, look: null, lod: 0 };

// The brain's own integrator, reduced to the two numbers that matter here.
const toward = (a, b, r) => (a < b ? Math.min(a + r, b) : Math.max(a - r, b));
const DT = 1 / 60;

function run(label, wantAt, seconds) {
  let speed = 0, worst = 0, worstT = 0, worstV = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const t = i * DT;
    const want = wantAt(t);
    // FLEE accel is the explosive one; the shuffle uses the ambient rate.
    const accel = (want > sp.gait.walk * S ? 18 : 3.2) * S, decel = 7 * S;
    speed = toward(speed, want, (want > speed ? accel : decel) * DT);
    if (speed < 0.02) speed = 0;
    pos.z += speed * DT;
    drive.speed = speed;
    rig.update(DT, drive, world);
    const y = rig.root.position.y * S;      // model units -> world metres
    if (y > worst) { worst = y; worstT = t; worstV = speed; }
    if (TRACE) console.log(`  t=${t.toFixed(3)} speed=${speed.toFixed(3)} y=${y.toFixed(4)}`);
  }
  console.log(`${label.padEnd(26)} peak ${worst.toFixed(3)} m  at t=${worstT.toFixed(2)}s, speed ${worstV.toFixed(3)} m/s`);
  return worst;
}

const shuffle = (t) => (t % 3 < 1.4 ? sp.gait.walk * 0.30 * S : 0);   // graze crop-to-crop
const walk = () => sp.gait.walk * S;
const bolt = (t) => (t < 2 ? 0 : sp.gait.run * S * 0.9);
const jitter = (t) => (Math.sin(t * 11) * 0.5 + 0.5) * sp.gait.walk * 0.30 * S;

console.log(`${KEY} ×${S}  hip ${(rig.apexMax ?? 0).toFixed(3)} model / ` +
  `${((rig.apexMax ?? 0) * S).toFixed(3)} m`);
run('graze shuffle (stop/start)', shuffle, 30);
run('steady walk', walk, 20);
run('stand then bolt', bolt, 12);
run('speed jitter', jitter, 30);

#!/usr/bin/env node
/**
 * toastband — the cook curve across the WHOLE height band, offline, at the
 * pose the game actually holds.
 *
 * toastsim.mjs synthesises an on-axis pose and is the right instrument for the
 * RATIOS the mechanic is built on. It is the wrong instrument for "how long
 * until it is golden", because the view holds the marshmallow ~0.32 m off the
 * fire's axis and the distance — and therefore every rate — is dominated by
 * that offset rather than by the height the player is controlling.
 *
 * So this replays the real ToastMap against the real world matrices, dumped
 * from the live game by tools/_scratch/roastmat.mjs. The spin is reconstructed
 * exactly: the stick turns about its own long axis through the marshmallow's
 * centre, so M(spin) = T(p) R(axis, spin) T(-p) M(0), and the axis and the
 * pivot both come out of the dumped matrix.
 *
 *   node tools/_scratch/roastmat.mjs                 (once, needs the game up)
 *   node tools/_scratch/toastband.mjs
 *   node tools/_scratch/toastband.mjs --spin 0       (the never-turn case)
 *   node tools/_scratch/toastband.mjs --where        (which texel is `peak`)
 *
 * `--where` answers the question the round-10 brief asks: under steady
 * rotation every barrel texel sees the same time-averaged heat, so `peak` and
 * `doneness` ought to track. They do not, and this prints the (u, v) of the
 * texel that is running away.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ToastMap } from '../../src/camp/marshmallow_toast.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const has = (n) => process.argv.includes(`--${n}`);
const BANK = arg('bank', 'tools/_scratch/banks/roastpose.json');
const SPIN = parseFloat(arg('spin', '2.0'));
const SECONDS = parseFloat(arg('seconds', '180'));
const HZ = parseFloat(arg('hz', '60'));
const WHERE = has('where');
const DT = 1 / HZ;

const bank = JSON.parse(readFileSync(BANK, 'utf8'));
const FIRE = {
  pos: new THREE.Vector3(bank.fire.x, bank.fire.y, bank.fire.z),
  top: bank.fire.top,
  power: 1,
};

/** Rebuild the marshmallow's world matrix at an arbitrary spin. */
function poser(rec) {
  const M0 = new THREE.Matrix4().fromArray(rec.m0);
  const M90 = new THREE.Matrix4().fromArray(rec.m90);
  const p = new THREE.Vector3().setFromMatrixPosition(M0);
  // The relative rotation between the two dumped poses is a quarter turn about
  // the stick. Its axis is what the spin turns about, and taking it from the
  // matrices rather than assuming local +Z means this keeps working if the
  // geometry author re-lathes the marshmallow.
  const R = new THREE.Matrix4().extractRotation(M90)
    .multiply(new THREE.Matrix4().extractRotation(M0).invert());
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  const axis = new THREE.Vector3(q.x, q.y, q.z);
  if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0); else axis.normalize();
  const obj = new THREE.Object3D();
  obj.matrixAutoUpdate = false;
  const tmp = new THREE.Matrix4();
  const back = new THREE.Matrix4();
  return {
    axis, pos: p,
    at(spin) {
      tmp.makeRotationAxis(axis, spin);
      back.makeTranslation(-p.x, -p.y, -p.z);
      obj.matrixWorld.copy(M0).premultiply(back).premultiply(tmp)
        .premultiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      return obj;
    },
  };
}

const hot = new THREE.Vector3(FIRE.pos.x, FIRE.pos.y + FIRE.top, FIRE.pos.z);
const f3 = (v) => v.toFixed(3);
const heights = Object.keys(bank.heights).map(Number).sort((a, b) => a - b);

console.log(`spin ${SPIN} rad/s   ${SECONDS} s   fire power ${FIRE.power}\n`);
console.log('  h     dist   above     rho | gold(.55)  past(.80)  eat(.15)   black    charred    alight | d@60  d@120');
console.log('─'.repeat(118));
const rows = [];
for (const h of heights) {
  const rec = bank.heights[h];
  const P = poser(rec);
  const d = new THREE.Vector3(rec.pos.x, rec.pos.y, rec.pos.z).sub(hot);
  const map = new ToastMap(bank.mallow?.radius ? {
    radius: bank.mallow.radius, half: bank.mallow.half, edge: bank.mallow.edge,
  } : {});
  const marks = {};
  let t = 0, d60 = 0, d120 = 0;
  while (t <= SECONDS + 1e-9) {
    if (marks.eat === undefined && map.doneness >= 0.15) marks.eat = t;
    if (marks.gold === undefined && map.doneness >= 0.55) marks.gold = t;
    if (marks.past === undefined && map.doneness > 0.80) marks.past = t;
    if (marks.black === undefined && map.peak >= 0.995) {
      marks.black = t;
      // What the BODY was doing when the first texel went black. Under steady
      // rotation these two ought to track; the round-10 brief asks how far
      // apart they are, and this is the number.
      marks.dAtBlack = map.doneness;
      marks.blackWhere = (() => {
        let b = 0, bi = 0;
        for (let i = 0; i < map.count; i++) if (map.toast[i] > b) { b = map.toast[i]; bi = i; }
        const j = (bi / map.rings) | 0;
        return (j === 0 || j === map.bands - 1) ? 'cap' : 'barrel';
      })();
    }
    if (marks.gold !== undefined && marks.peakAtGold === undefined) { marks.peakAtGold = map.peak; marks.evenAtGold = map.evenness; marks.gradeAtGold = map.grade().key; }
    if (marks.charred === undefined && map.ruined >= 0.16) marks.charred = t;
    if (marks.alight === undefined && map.burning) marks.alight = t;
    if (Math.abs(t - 60) < DT / 2) d60 = map.doneness;
    if (Math.abs(t - 120) < DT / 2) d120 = map.doneness;
    map.update(DT, P.at(t * SPIN), FIRE);
    t += DT;
  }
  const fm = (v) => (v === undefined ? '  never' : (v.toFixed(1) + ' s').padStart(7));
  console.log(
    f3(h) + '  ' + f3(d.length()) + '  ' + f3(d.y) + '  ' + f3(Math.hypot(d.x, d.z)) + ' |' +
    fm(marks.gold) + '   ' + fm(marks.past) + '   ' + fm(marks.eat) + '  ' + fm(marks.black) + '   ' +
    fm(marks.charred) + '   ' + fm(marks.alight) + ' | ' + f3(d60) + ' ' + f3(d120));
  rows.push({ h, marks, map });
  if (marks.gold !== undefined) {
    console.log('        at golden: peak ' + (marks.peakAtGold ?? 0).toFixed(3) +
      '  evenness ' + (marks.evenAtGold ?? 0).toFixed(3) + '  grade ' + (marks.gradeAtGold ?? '-') +
      (marks.dAtBlack !== undefined
        ? '   |  first black texel at doneness ' + marks.dAtBlack.toFixed(3) + ' (' + marks.blackWhere + ')'
        : ''));
  }
  if (WHERE) {
    // Which texel is `peak`, and how far ahead of the map's mean it is.
    let best = 0, bi = 0;
    for (let i = 0; i < map.count; i++) if (map.toast[i] > best) { best = map.toast[i]; bi = i; }
    const i = bi % map.rings, j = (bi / map.rings) | 0;
    const isCap = j === 0 || j === map.bands - 1;
    // Ring means, so the axial gradient is visible.
    const ringMean = [];
    for (let b = 0; b < map.bands; b++) {
      let s = 0; for (let a = 0; a < map.rings; a++) s += map.toast[b * map.rings + a];
      ringMean.push(s / map.rings);
    }
    console.log('        peak texel u=' + (((i + 0.5) / map.rings).toFixed(3)) +
      ' v=' + (((j + 0.5) / map.bands).toFixed(3)) + (isCap ? '  <-- CAP ROW' : '  (barrel)') +
      '  toast ' + f3(best) + '  mean ' + f3(map.doneness) +
      '\n        band means ' + ringMean.map((v) => v.toFixed(2)).join(' '));
  }
}

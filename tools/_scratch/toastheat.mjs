#!/usr/bin/env node
/**
 * toastheat — the incident heat field, decomposed, at the pose the game holds.
 *
 * The rates in src/camp/marshmallow_toast.js are derived from three numbers:
 * the heat a texel sees averaged over a steady turn, the heat the hot side of
 * an unturned marshmallow sees, and the heat its top face sees. All three are
 * quoted in the file's header at an ON-AXIS pose the view does not use. This
 * prints them at the real pose, off the bank tools/_scratch/roastmat.mjs
 * dumps, so a rate can be derived rather than guessed.
 *
 * It also prints the CAP rows separately, because they do not turn: the
 * marshmallow's axis has a large component along the direction to the fire, so
 * one cap faces it permanently and is the texel `peak` actually reports.
 *
 *   node tools/_scratch/toastheat.mjs
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ToastMap } from '../../src/camp/marshmallow_toast.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const BANK = arg('bank', 'tools/_scratch/banks/roastpose.json');
const TURNS = 64;   // samples of one full turn, for the turn average

// The heat model, copied from marshmallow_toast.js's update(). Copied rather
// than imported because the point of this tool is to see the terms separately,
// and the file computes them fused into one accumulator.
const REF_D = 0.26, SOFT_D = 0.09;
const RAD_GAIN = parseFloat(arg('rad', '0.70'));
const SRC_R = parseFloat(arg('srcr', '0'));   // 0 = the point-source model
const PLUME_R = 0.42;
const PLUME_H = parseFloat(arg('plumeh', '0.34'));
const CONV_GAIN = parseFloat(arg('conv', '0.46'));
const CONV_ISO = parseFloat(arg('iso', '0.55'));
const CONV_DOWN = parseFloat(arg('down', '1.60'));
const PLUME_P = parseFloat(arg('plumep', '0'));

const bank = JSON.parse(readFileSync(BANK, 'utf8'));
const hot = new THREE.Vector3(bank.fire.x, bank.fire.y + bank.fire.top, bank.fire.z);

function heatAt(wp, wn) {
  const dx = hot.x - wp.x, dy = hot.y - wp.y, dz = hot.z - wp.z;
  const dist2 = dx * dx + dy * dy + dz * dz;
  const dist = Math.sqrt(dist2);
  const ndl = (wn.x * dx + wn.y * dy + wn.z * dz) / dist;
  const w = SRC_R > 0 ? Math.min(SRC_R / dist, 1) : 0;
  const nds = (ndl + w) / (1 + w);
  const rad = nds > 0 ? RAD_GAIN * nds * REF_D * REF_D / (dist2 + SOFT_D * SOFT_D) : 0;
  const rho2 = (wp.x - hot.x) ** 2 + (wp.z - hot.z) ** 2;
  let pm = PLUME_R ** 2 / (PLUME_R ** 2 + rho2); pm *= pm;
  const above = wp.y - hot.y;
  let vert;
  if (above <= 0) vert = 1;
  else if (PLUME_P > 0) { const q = PLUME_H / (PLUME_H + above); vert = Math.pow(q, PLUME_P); }
  else vert = PLUME_H ** 2 / (PLUME_H ** 2 + above * above);
  const down = wn.y < 0 ? -wn.y : 0;
  const conv = CONV_GAIN * pm * vert * (CONV_ISO + CONV_DOWN * down);
  return { rad, conv, h: rad + conv };
}

const map = new ToastMap(bank.mallow?.radius ? {
  radius: bank.mallow.radius, half: bank.mallow.half, edge: bank.mallow.edge } : {});
const heights = Object.keys(bank.heights).map(Number).sort((a, b) => a - b);
const wp = new THREE.Vector3(), wn = new THREE.Vector3();

console.log('  h    dist |  turn-avg barrel   unturned hot   unturned top | cap-far  cap-near | axis.toFire');
console.log('─'.repeat(108));
for (const h of heights) {
  const rec = bank.heights[h];
  const M0 = new THREE.Matrix4().fromArray(rec.m0);
  const M90 = new THREE.Matrix4().fromArray(rec.m90);
  const p = new THREE.Vector3().setFromMatrixPosition(M0);
  const R = new THREE.Matrix4().extractRotation(M90)
    .multiply(new THREE.Matrix4().extractRotation(M0).invert());
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  const axis = new THREE.Vector3(q.x, q.y, q.z).normalize();
  const toFire = hot.clone().sub(p).normalize();

  const mid = (map.bands >> 1);
  let sum = 0, n = 0, hotSide = 0, topFace = 1e9;
  const M = new THREE.Matrix4(), n3 = new THREE.Matrix3();
  for (let s = 0; s < TURNS; s++) {
    const spin = (s / TURNS) * Math.PI * 2;
    M.copy(M0)
      .premultiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z))
      .premultiply(new THREE.Matrix4().makeRotationAxis(axis, spin))
      .premultiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    n3.setFromMatrix4(M);
    // One barrel texel, followed round a full turn: its time average is what
    // every barrel texel sees once the marshmallow has turned a few times.
    const k = (mid * map.rings + 0) * 3;
    wp.set(map.lp[k], map.lp[k + 1], map.lp[k + 2]).applyMatrix4(M);
    wn.set(map.ln[k], map.ln[k + 1], map.ln[k + 2]).applyMatrix3(n3).normalize();
    const e = heatAt(wp, wn);
    sum += e.h; n++;
    if (e.h > hotSide) hotSide = e.h;
    if (e.h < topFace) topFace = e.h;
  }
  // The two cap rows, at spin 0 — they do not turn, so one sample is the whole
  // story for them.
  n3.setFromMatrix4(M0);
  const capH = [0, map.bands - 1].map((j) => {
    let best = 0;
    for (let i = 0; i < map.rings; i++) {
      const k = (j * map.rings + i) * 3;
      wp.set(map.lp[k], map.lp[k + 1], map.lp[k + 2]).applyMatrix4(M0);
      wn.set(map.ln[k], map.ln[k + 1], map.ln[k + 2]).applyMatrix3(n3).normalize();
      const e = heatAt(wp, wn);
      if (e.h > best) best = e.h;
    }
    return best;
  });
  const d = p.clone().sub(hot).length();
  const f = (v) => v.toFixed(3).padStart(7);
  console.log(h.toFixed(3) + '  ' + f(d) + ' |' + f(sum / n) + '        ' + f(hotSide) +
    '        ' + f(topFace) + ' |' + f(capH[1]) + ' ' + f(capH[0]) + ' | ' +
    Math.abs(axis.dot(toFire)).toFixed(3));
}

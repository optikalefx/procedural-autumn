#!/usr/bin/env node
/**
 * toasttune — solve the caramelisation constants against the pose the game
 * holds, instead of guessing them and re-running a two-minute capture.
 *
 * The integrator is separable and that is what makes this possible. Once the
 * marshmallow has turned a few times every texel is on a fixed time-averaged
 * drive D_i, and
 *
 *     dT/dt = K D_i (1 + A T^2)     =>     T_i(t) = tan( sqrt(A) K D_i t ) / sqrt(A)
 *
 * so `doneness` at any time is a mean of tangents and every acceptance number
 * in the file's tuning table — time to golden, time to a black side, time past
 * gold — is a root of a one-line function rather than a simulation. This
 * sweeps (BROWN_T, BROWN_P, CONV_ISO, CONV_DOWN) over that closed form, picks
 * TOAST_K to pin the default height at its contract time, and prints the whole
 * band. tools/_scratch/toastband.mjs then confirms the winner against the real
 * ToastMap, which is the instrument that counts.
 *
 *   node tools/_scratch/toasttune.mjs
 *   node tools/_scratch/toasttune.mjs --gold 42 --srcr 0.236 --sweep
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ToastMap } from '../../src/camp/marshmallow_toast.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const has = (n) => process.argv.includes(`--${n}`);
const bank = JSON.parse(readFileSync(arg('bank', 'tools/_scratch/banks/roastpose.json'), 'utf8'));
const GOLD = parseFloat(arg('gold', '42'));      // the time-to-golden to pin H_REST at
const H_REST = parseFloat(arg('rest', '0.24'));
const TURNS = 96;
const ACC = parseFloat(arg('acc', '1.60'));

const REF_D = 0.26, SOFT_D = 0.09, RAD_GAIN = 0.70;
const PLUME_R = 0.42, PLUME_H = 0.34, CONV_GAIN = 0.46;
const hot = new THREE.Vector3(bank.fire.x, bank.fire.y + bank.fire.top, bank.fire.z);

/** Every texel's heat, at `n` evenly spaced spins. [spin][texel] */
function heatField(rec, map, P, n) {
  const M0 = new THREE.Matrix4().fromArray(rec.m0);
  const M90 = new THREE.Matrix4().fromArray(rec.m90);
  const p = new THREE.Vector3().setFromMatrixPosition(M0);
  const R = new THREE.Matrix4().extractRotation(M90)
    .multiply(new THREE.Matrix4().extractRotation(M0).invert());
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  const axis = new THREE.Vector3(q.x, q.y, q.z).normalize();
  const out = [];
  const M = new THREE.Matrix4(), n3 = new THREE.Matrix3();
  const wp = new THREE.Vector3(), wn = new THREE.Vector3();
  for (let s = 0; s < n; s++) {
    M.copy(M0)
      .premultiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z))
      .premultiply(new THREE.Matrix4().makeRotationAxis(axis, (s / n) * Math.PI * 2))
      .premultiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
    n3.setFromMatrix4(M);
    const row = { rad: new Float64Array(map.count), cc: new Float64Array(map.count), dn: new Float64Array(map.count) };
    for (let i = 0; i < map.count; i++) {
      const k = i * 3;
      wp.set(map.lp[k], map.lp[k + 1], map.lp[k + 2]).applyMatrix4(M);
      wn.set(map.ln[k], map.ln[k + 1], map.ln[k + 2]).applyMatrix3(n3).normalize();
      const dx = hot.x - wp.x, dy = hot.y - wp.y, dz = hot.z - wp.z;
      const dist2 = dx * dx + dy * dy + dz * dz, dist = Math.sqrt(dist2);
      const ndl = (wn.x * dx + wn.y * dy + wn.z * dz) / dist;
      const w = P.srcr > 0 ? Math.min(P.srcr / dist, 1) : 0;
      const nds = (ndl + w) / (1 + w);
      const rad = nds > 0 ? RAD_GAIN * nds * REF_D * REF_D / (dist2 + SOFT_D * SOFT_D) : 0;
      const rho2 = (wp.x - hot.x) ** 2 + (wp.z - hot.z) ** 2;
      let pm = PLUME_R ** 2 / (PLUME_R ** 2 + rho2); pm *= pm;
      const above = wp.y - hot.y;
      const vert = above <= 0 ? 1 : PLUME_H ** 2 / (PLUME_H ** 2 + above * above);
      row.rad[i] = rad;
      row.cc[i] = CONV_GAIN * pm * vert;
      row.dn[i] = wn.y < 0 ? -wn.y : 0;
    }
    out.push(row);
  }
  return out;
}

const drive = (h, P) => (h > P.T ? Math.pow(h - P.T, P.p) : 0);
const sA = Math.sqrt(ACC);
/** T_i(t) for a texel on a constant drive D. */
const toastAt = (D, K, t) => {
  const x = sA * K * D * t;
  return x >= Math.atan(sA) ? 1 : Math.tan(x) / sA;
};
/** First t at which f(t) >= target, by bisection. `never` past `hi`. */
function cross(f, target, hi) {
  if (f(hi) < target) return undefined;
  let lo = 0;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) >= target) hi = m; else lo = m; }
  return hi;
}

const map = new ToastMap(bank.mallow?.radius ? {
  radius: bank.mallow.radius, half: bank.mallow.half, edge: bank.mallow.edge } : {});
const heights = Object.keys(bank.heights).map(Number).sort((a, b) => a - b);
const fields = {};
const SRCR = parseFloat(arg('srcr', '0.236'));

function evaluate(P) {
  // Turn-averaged drive per texel, and the static (never-turned) drive, at
  // every height. Averaging the DRIVE rather than the heat is the point: the
  // curve is nonlinear and the two are not the same number.
  const per = {};
  for (const h of heights) {
    const f = fields[h] ?? (fields[h] = heatField(bank.heights[h], map, { srcr: SRCR }, TURNS));
    // The field is stored as (radiative, convective coefficient, downwardness)
    // so the sweep can reweight the convective split without recomputing any
    // geometry — it is a linear combination of the last two.
    const heat = (row, i) => row.rad[i] + row.cc[i] * (P.iso + P.down * row.dn[i]);
    const turnD = new Float64Array(map.count);
    for (const row of f) for (let i = 0; i < map.count; i++) turnD[i] += drive(heat(row, i), P) / f.length;
    const stillD = new Float64Array(map.count);
    for (let i = 0; i < map.count; i++) stillD[i] = drive(heat(f[0], i), P);
    per[h] = { turnD, stillD };
  }
  return per;
}

function report(P, K, per) {
  const HI = 600;
  console.log(`\nBROWN_T ${P.T}  BROWN_P ${P.p}  CONV_ISO ${P.iso}  CONV_DOWN ${P.down}  TOAST_K ${K.toFixed(5)}  SRC_R ${SRCR}`);
  console.log('  h   | gold(.55)  past(.80)  eat(.15) | never-turn black side | d@60s  d@120s');
  console.log('  ' + '─'.repeat(88));
  for (const h of heights) {
    const { turnD, stillD } = per[h];
    const mean = (t, D) => { let s = 0; for (let i = 0; i < map.count; i++) s += toastAt(D[i], K, t) * map.area[i]; return s; };
    const fTurn = (t) => mean(t, turnD);
    let hotD = 0; for (let i = 0; i < map.count; i++) if (stillD[i] > hotD) hotD = stillD[i];
    const black = cross((t) => toastAt(hotD, K, t), 0.995, HI);
    const fm = (v) => (v === undefined ? '  never' : (v.toFixed(1) + ' s').padStart(7));
    console.log('  ' + h.toFixed(2) + ' |' + fm(cross(fTurn, 0.55, HI)) + '   ' + fm(cross(fTurn, 0.80, HI)) +
      '   ' + fm(cross(fTurn, 0.15, HI)) + ' |' + fm(black) + '               ' +
      fTurn(60).toFixed(3) + '  ' + fTurn(120).toFixed(3));
  }
}

/** TOAST_K that puts H_REST's turned policy at `GOLD` seconds. */
function solveK(per) {
  const { turnD } = per[H_REST];
  const f = (K) => { let s = 0; for (let i = 0; i < map.count; i++) s += toastAt(turnD[i], K, GOLD) * map.area[i]; return s; };
  let lo = 1e-5, hi = 5;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) >= 0.55) hi = m; else lo = m; }
  return hi;
}

if (has('sweep')) {
  console.log('  T      p    iso   down |  gold@REST  gold@MIN  gold@MAX  MAX/REST  MIN/REST | black@REST black@MIN');
  console.log('─'.repeat(112));
  for (const T of [0, 0.02, 0.04]) {
    for (const p of [0.70, 0.75, 0.80, 0.85, 0.90]) {
      for (const [iso, down] of [[0.55, 1.60], [0.30, 2.40], [0.20, 2.75], [0.12, 3.05]]) {
        const P = { T, p, iso, down };
        const per = evaluate(P);
        const K = solveK(per);
        const HI = 900;
        const gold = (h) => {
          const { turnD } = per[h];
          return cross((t) => { let s = 0; for (let i = 0; i < map.count; i++) s += toastAt(turnD[i], K, t) * map.area[i]; return s; }, 0.55, HI);
        };
        const black = (h) => {
          let hotD = 0; for (const d of per[h].stillD) if (d > hotD) hotD = d;
          return cross((t) => toastAt(hotD, K, t), 0.995, HI);
        };
        const g0 = gold(0.10), gR = gold(H_REST), g5 = gold(0.50);
        const fm = (v) => (v === undefined ? ' never' : v.toFixed(1).padStart(6));
        console.log(`${T.toFixed(2)}  ${p.toFixed(2)}  ${iso.toFixed(2)}  ${down.toFixed(2)} |  ` +
          fm(gR) + '   ' + fm(g0) + '   ' + fm(g5) + '   ' +
          (g5 && gR ? (g5 / gR).toFixed(2) : ' -- ').padStart(6) + '   ' +
          (g0 && gR ? (gR / g0).toFixed(2) : ' -- ').padStart(6) + '  |' +
          fm(black(H_REST)) + '   ' + fm(black(0.10)));
      }
    }
  }
} else {
  const P = {
    T: parseFloat(arg('T', '0.02')), p: parseFloat(arg('p', '0.80')),
    iso: parseFloat(arg('iso', '0.55')), down: parseFloat(arg('down', '1.60')),
  };
  const per = evaluate(P);
  report(P, solveK(per), per);
}

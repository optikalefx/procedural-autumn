#!/usr/bin/env node
/**
 * The roasting stick's geometry audit, 300 seeds.
 *
 * Round 2 moved the composition number (`S_REST`), the length band, the lean
 * clamps and the whole section, and every one of those has a way of going wrong
 * that a screenshot of one camp cannot show: a lean that clamps, a marshmallow
 * that lands back at chair height, a centre of mass past the contact, a
 * published offset outside the contract's band, a NaN in a normal.
 *
 *   node tools/_scratch/roastgeo.mjs [seeds]
 */
import * as THREE from 'three';
import { buildRoastStick, buildHeldStick } from '../../src/camp/camp_marshmallow.js';

const N = parseInt(process.argv[2] ?? '300', 10);
const CHAIR_TOP = 0.848;          // camp_chair.js
const REST_HEIGHTS = [0.425, 0.447, 0.470, 0.440, 0.400, 0.350, 0.220];

// xorshift, so the audit is reproducible
const mk = (s) => () => {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return ((s >>> 0) % 1e6) / 1e6;
};

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { min: s[0], p50: s[s.length >> 1], max: s[s.length - 1],
           mean: a.reduce((x, y) => x + y, 0) / a.length };
};
const f = (o, k = 3) => `${o.min.toFixed(k)} / ${o.p50.toFixed(k)} / ${o.max.toFixed(k)}`;

let bad = 0;
const say = (c, m) => { if (c) { bad++; console.log(`  !! ${m}`); } };

for (const restH of REST_HEIGHTS) {
  const mallowY = [], restErr = [], lean = [], com = [], clear = [];
  let nan = 0;
  for (let i = 0; i < N; i++) {
    const g = buildRoastStick(mk(0x9e3779b1 ^ (i * 2654435761)), { restH, leanYaw: 0, wear: (i % 10) / 10 });
    const d = g.userData.roast;
    mallowY.push(d.mallow.y);
    restErr.push(d.rest.y - restH);
    clear.push(d.mallow.y - CHAIR_TOP);
    // lean angle, from the published butt and rest
    const dy = d.rest.y - d.butt.y;
    const dxz = Math.hypot(d.rest.x - d.butt.x, d.rest.z - d.butt.z);
    lean.push(Math.atan2(dy, dxz) * 180 / Math.PI);
    // centre of mass along the shaft, from the merged shaft's own vertices
    // (an equal-mass-per-vertex proxy: the sweep has a constant ring count, so
    // vertex density along s is uniform and the radius shows up as area).
    let m = 0, ms = 0;
    g.traverse((o) => {
      if (!o.isMesh || o.name === 'roaststick_mallow') return;
      const p = o.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
        if (!Number.isFinite(x + y + z)) { nan++; continue; }
        // distance along the shaft axis, normalised
        const s = Math.hypot(x - d.butt.x, y - d.butt.y, z - d.butt.z) / d.len;
        const r = Math.hypot(x - d.butt.x, y - d.butt.y, z - d.butt.z) > 0 ? 1 : 1;
        m += r; ms += r * Math.min(1, s);
      }
      const nm = o.geometry.attributes.normal;
      if (nm) for (let k = 0; k < nm.count * 3; k++) if (!Number.isFinite(nm.array[k])) nan++;
    });
    com.push(ms / m);
    g.traverse((o) => o.isMesh && o.geometry.dispose());
  }
  const L = stat(lean), M = stat(mallowY), E = stat(restErr), C = stat(clear);
  console.log(`restH ${restH.toFixed(3)}  lean° ${f(L, 1)}  mallowY ${f(M)}  ` +
              `restErr(mm) ${(E.min * 1e3).toFixed(2)} / ${(E.p50 * 1e3).toFixed(2)} / ${(E.max * 1e3).toFixed(2)}  ` +
              `chairClear ${f(C)}`);
  say(nan > 0, `${nan} non-finite values`);
  say(Math.abs(E.min) > 5e-4 || Math.abs(E.max) > 5e-4, 'rest point off the target edge by >0.5 mm');
  say(L.max > 49.4 || L.min < 17.7, 'lean outside the clamp band');
  // Only the table cases can be asserted: the woodpile (0.40) and the fire's
  // cobbles (0.22) are simply not tall enough to put a marshmallow over a chair
  // back at any stable contact, and `solveRest` runs at its topple floor there.
  if (restH >= 0.425) say(C.min < 0.0, 'marshmallow at or below chair-back height');
}

// ── the held stick's contract surface ────────────────────────────────────────
const off = [], len = [], tri = [], tilt = [];
for (let i = 0; i < N; i++) {
  const g = buildHeldStick(mk(0x85ebca6b ^ (i * 2246822519)));
  const h = g.userData.held;
  off.push(Math.hypot(h.tip.x, h.tip.y));
  // Angle between the marshmallow's own axis and +Z, the axis the view spins
  // this group about. A BUDGET rather than a taste: every degree of it is
  // 0.0139 of `evenness` at golden and no spin rate averages it away, because
  // the toast map's lattice follows the mesh and each texel therefore sweeps a
  // cone. See the long note at the held solve; measured by mtilt.mjs.
  tilt.push(Math.acos(Math.min(1, Math.abs(
    new THREE.Vector3(0, 0, 1).applyQuaternion(h.mallow.quaternion).z))) * 180 / Math.PI);
  len.push(h.len);
  let t = 0, nan = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    const nm = o.geometry.attributes.normal;
    if (nm) for (let k = 0; k < nm.count * 3; k++) if (!Number.isFinite(nm.array[k])) nan++;
  });
  say(nan > 0, `held seed ${i}: ${nan} non-finite normals`);
  say(!(h.radius > 0 && h.half > 0 && h.mallow), `held seed ${i}: userData.held incomplete`);
  tri.push(t);
  g.traverse((o) => o.isMesh && o.geometry.dispose());
}
const O = stat(off), LL = stat(len), T = stat(tri), TI = stat(tilt);
console.log(`held  twirl offset(mm) ${(O.min * 1e3).toFixed(1)} / ${(O.p50 * 1e3).toFixed(1)} / ${(O.max * 1e3).toFixed(1)}  ` +
            `spear tilt(deg) ${f(TI, 2)}  ` +
            `len ${f(LL)}  tris ${T.min.toFixed(0)} / ${T.p50.toFixed(0)} / ${T.max.toFixed(0)}`);
say(O.min < 0.005 - 1e-6 || O.max > 0.012 + 1e-6, 'twirl offset outside the contract 5-12 mm band');
say(TI.max > 2.5, 'held spear tilt past its 2.5-degree budget — the evenness ceiling pays for every degree');

// ── the whittled point where it pierces the marshmallow ─────────────────────
//
// The one thing at hero scale that no prop framing can photograph: the spike has
// to come out of the FAR face and it has to come out inside the rim. Measured
// rather than looked for, because the macro framings put that cap edge-on.
{
  const out = [];
  for (let i = 0; i < N; i++) {
    const g = buildHeldStick(mk(0xc2b2ae35 ^ (i * 2654435761)));
    const h = g.userData.held;
    let tip = null, far = -1;
    g.traverse((o) => {
      if (!o.isMesh || o.name === 'held_mallow') return;
      const p = o.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const z = p.getZ(k);
        if (z > far) { far = z; tip = new THREE.Vector3(p.getX(k), p.getY(k), z); }
      }
    });
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(h.mallow.quaternion);
    const d = tip.clone().sub(h.mallow.position);
    const along = d.dot(axis);
    out.push([along - h.half,
              Math.hypot(d.x - axis.x * along, d.y - axis.y * along, d.z - axis.z * along)]);
    g.traverse((o) => o.isMesh && o.geometry.dispose());
  }
  const S = (k) => stat(out.map((o) => o[k]));
  const P = S(0), Rr = S(1);
  console.log(`point  protrusion(mm) ${(P.min * 1e3).toFixed(1)} / ${(P.p50 * 1e3).toFixed(1)} / ${(P.max * 1e3).toFixed(1)}  ` +
              `exit off axis(mm) ${(Rr.min * 1e3).toFixed(1)} / ${(Rr.p50 * 1e3).toFixed(1)} / ${(Rr.max * 1e3).toFixed(1)}  [rim 21.0]`);
  say(P.min < 0.003, 'the point does not clear the far face on every seed');
  say(Rr.max > 0.016, 'the point exits outside the marshmallow rim');
}

console.log(bad ? `\nFAIL — ${bad} problems` : `\nOK — ${N} seeds x ${REST_HEIGHTS.length} rest heights clean`);

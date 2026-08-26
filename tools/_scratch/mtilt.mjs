#!/usr/bin/env node
/**
 * mtilt — the evenness ceiling as a function of the marshmallow's SPEAR TILT,
 * with its lateral offset held constant (and the other way round).
 *
 * The toast author measured a hard cap on `evenness` (~0.81) and traced it to
 * the marshmallow being mounted 13.9 degrees off the stick's roll axis. The
 * contract asks for the off-axis mounting, but it asks for two different things
 * in one sentence — "5-12 mm of offset AND a few degrees of tilt" — and this
 * instrument is here to find out which of the two costs the mechanic its
 * margin:
 *
 *   · a LATERAL OFFSET orbits the marshmallow about the roll axis. Every texel
 *     traces a circle of the same radius, so the distance to the fire varies
 *     through a turn and averages out over one.
 *   · an ANGULAR TILT makes each texel sweep a CONE. A texel on the up side of
 *     the cone is permanently further from the fire than one on the down side
 *     and no rate of spin averages that away.
 *
 * It replays the real ToastMap against the real dumped pose bank, the same way
 * toastband.mjs does, but rebuilds the spin from the rigid motion between the
 * two dumped poses so the marshmallow ORBITS rather than turning in place —
 * which is the whole point when the offset is the variable.
 *
 *   node tools/_scratch/mtilt.mjs                    (the tilt sweep)
 *   node tools/_scratch/mtilt.mjs --what offset      (the offset sweep)
 *   node tools/_scratch/mtilt.mjs --spin 9.5 --h 0.24
 *   node tools/_scratch/mtilt.mjs --what geom        (what the mesh actually is)
 *   node tools/_scratch/mtilt.mjs --what mesh --seeds 60 --spin 9.5
 *                                                    (the real mesh, per seed,
 *                                                     hung on the real line)
 *
 * `--acc450` answers the toast author's question — what the grade does if
 * TOAST_ACC goes to the 4.50 their never-turn target wants — by importing a
 * throwaway copy of their file with the one constant changed. Their file is
 * theirs; the copy is made and deleted in the same breath and is NOT kept in
 * the tree to rot:
 *
 *   sed -e "s#from './camp_materials.js'#from '../../src/camp/camp_materials.js'#" \
 *       -e "s#from '../core/MathUtils.js'#from '../../src/core/MathUtils.js'#" \
 *       -e "s#from '../render/Stylize.js'#from '../../src/render/Stylize.js'#" \
 *       -e "s#^const TOAST_ACC = 2.80;#const TOAST_ACC = 4.50;#" \
 *       src/camp/marshmallow_toast.js > tools/_scratch/_toast450.mjs
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
const ACC = String(process.argv.includes('--acc450') ? './_toast450.mjs' : '../../src/camp/marshmallow_toast.js');
const { ToastMap } = await import(ACC);
import { buildHeldStick } from '../../src/camp/camp_marshmallow.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const BANK = arg('bank', 'tools/_scratch/banks/roastpose.json');
const SPINS = String(arg('spin', '2.0,9.5')).split(',').map(Number);
const SECONDS = parseFloat(arg('seconds', '200'));
const HZ = parseFloat(arg('hz', '60'));
const WHAT = String(arg('what', 'tilt'));
const HEIGHT = String(arg('h', '0.24'));
const GOLD = parseFloat(arg('gold', '0.55'));   // the doneness the report is taken at
const DT = 1 / HZ;
const DEG = 180 / Math.PI;

const bank = JSON.parse(readFileSync(BANK, 'utf8'));
const FIRE = {
  pos: new THREE.Vector3(bank.fire.x, bank.fire.y, bank.fire.z),
  top: bank.fire.top,
  power: bank.fire.power ?? 1,
};

/**
 * The spin, rebuilt as a rotation about a LINE rather than about the
 * marshmallow's own centre.
 *
 * M90 * M0^-1 is the rigid world motion of a quarter turn. Its rotation part
 * gives the axis; its translation gives a point on the line, by solving
 * [(I-R) + a a^T] q = t — the added outer product makes the singular direction
 * invertible and drops the screw component out as `slide`, which is printed so
 * a non-rigid dump cannot pass silently.
 */
function spinLine(rec) {
  const M0 = new THREE.Matrix4().fromArray(rec.m0);
  const M90 = new THREE.Matrix4().fromArray(rec.m90);
  const Rel = M90.clone().multiply(M0.clone().invert());
  const R = new THREE.Matrix4().extractRotation(Rel);
  const q4 = new THREE.Quaternion().setFromRotationMatrix(R);
  const a = new THREE.Vector3(q4.x, q4.y, q4.z);
  if (a.lengthSq() < 1e-12) a.set(0, 0, 1); else a.normalize();
  const angle = 2 * Math.atan2(Math.hypot(q4.x, q4.y, q4.z), q4.w);
  const t = new THREE.Vector3().setFromMatrixPosition(Rel);
  const e = R.elements;
  const M3 = new THREE.Matrix3().set(
    1 - e[0] + a.x * a.x, -e[4] + a.x * a.y, -e[8] + a.x * a.z,
    -e[1] + a.y * a.x, 1 - e[5] + a.y * a.y, -e[9] + a.y * a.z,
    -e[2] + a.z * a.x, -e[6] + a.z * a.y, 1 - e[10] + a.z * a.z);
  const q = t.clone().applyMatrix3(M3.clone().invert());
  const slide = q.dot(a);
  q.addScaledVector(a, -slide);
  return { M0, M90, axis: a, angle, point: q, slide };
}

/**
 * One pose family: the marshmallow at a chosen tilt off the roll axis and a
 * chosen lateral offset from it, spun about the real line.
 *
 * tiltDeg = null keeps whatever the dump had; offMm = null likewise. The tilt
 * is applied about the axis perpendicular to both the roll axis and the
 * marshmallow's offset direction, i.e. the worst-case plane — a cone whose
 * bias lines up with the orbit rather than averaging against it.
 */
function poser(L, { tiltDeg = null, offMm = null } = {}) {
  const M = L.M0.clone();
  const p = new THREE.Vector3().setFromMatrixPosition(M);
  // radial offset of the centre from the roll line
  const d = p.clone().sub(L.point);
  const along = d.dot(L.axis);
  const rad = d.clone().addScaledVector(L.axis, -along);
  const r0 = rad.length();
  const rHat = r0 > 1e-9 ? rad.clone().divideScalar(r0) : new THREE.Vector3(1, 0, 0);

  // ── orientation ──────────────────────────────────────────────────────────
  const rot = new THREE.Matrix4().extractRotation(M);
  const mAxis = new THREE.Vector3(0, 0, 1).applyMatrix4(rot).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(rot);
  if (tiltDeg !== null) {
    // straighten first…
    q.premultiply(new THREE.Quaternion().setFromUnitVectors(mAxis, L.axis));
    // …then lay the cone back down by the requested angle, in the plane that
    // contains the orbit radius, which is the least forgiving choice.
    const perp = new THREE.Vector3().crossVectors(L.axis, rHat).normalize();
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(perp, tiltDeg / DEG));
  }

  // ── position ─────────────────────────────────────────────────────────────
  const centre = L.point.clone().addScaledVector(L.axis, along)
    .addScaledVector(rHat, offMm === null ? r0 : offMm * 1e-3);

  const base = new THREE.Matrix4().compose(centre, q, new THREE.Vector3(1, 1, 1));
  const obj = new THREE.Object3D();
  obj.matrixAutoUpdate = false;
  const rotL = new THREE.Matrix4();
  const T = new THREE.Matrix4();
  const Tb = new THREE.Matrix4();
  const tilt0 = Math.acos(Math.min(1, Math.abs(mAxis.dot(L.axis)))) * DEG;
  return {
    tilt0, off0: r0 * 1e3,
    tilt: tiltDeg === null ? tilt0 : tiltDeg,
    off: offMm === null ? r0 * 1e3 : offMm,
    at(spin) {
      rotL.makeRotationAxis(L.axis, spin);
      Tb.makeTranslation(-L.point.x, -L.point.y, -L.point.z);
      T.makeTranslation(L.point.x, L.point.y, L.point.z);
      obj.matrixWorld.copy(base).premultiply(Tb).premultiply(rotL).premultiply(T);
      return obj;
    },
  };
}

/** Cook one pose family and report what the grade would be. */
function cook(P, spin) {
  const map = new ToastMap({ rings: 24, bands: 12 });
  let t = 0, res = null, ceil = 0;
  while (t <= SECONDS + 1e-9) {
    if (!res && map.doneness >= GOLD) {
      res = { t, even: map.evenness, done: map.doneness, grade: map.grade().key };
      // The spread across one barrel ring at golden, which is the number the
      // toast author quoted.
      const j = 6, lo = [], hi = [];
      for (let i = 0; i < map.rings; i++) lo.push(map.toast[j * map.rings + i]);
      res.ringLo = Math.min(...lo); res.ringHi = Math.max(...lo);
      void hi;
    }
    if (map.doneness > 0.2 && map.doneness < 0.85) ceil = Math.max(ceil, map.evenness);
    map.update(DT, P.at(t * spin), FIRE);
    t += DT;
  }
  return { ...(res ?? { t: NaN, even: NaN, done: NaN, grade: 'never', ringLo: NaN, ringHi: NaN }), ceil };
}

const rec = bank.heights[HEIGHT] ?? bank.heights[Object.keys(bank.heights)[2]];
const L = spinLine(rec);

if (WHAT === 'geom') {
  // What the MESH does, independent of any dump: the angle between the
  // marshmallow's local +Z and the stick's +Z (the twirl axis), over seeds.
  const mk = (s) => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; };
  const tilt = [], off = [], tan = [];
  for (let i = 0; i < 300; i++) {
    const g = buildHeldStick(mk(0x85ebca6b ^ (i * 2246822519)));
    const h = g.userData.held;
    const ax = new THREE.Vector3(0, 0, 1).applyQuaternion(h.mallow.quaternion);
    tilt.push(Math.acos(Math.min(1, Math.abs(ax.z))) * DEG);
    off.push(Math.hypot(h.tip.x, h.tip.y) * 1e3);
    // …and what the SHAFT does at the same station, which is the crookedness
    // the eye reads at hero scale and which costs the toast map nothing,
    // because the map's lattice follows the mallow and not the wood. Two rings
    // of the swept shaft, 80 mm apart, averaged.
    const pts = [];
    g.traverse((o) => {
      if (!o.isMesh || o.name === 'held_mallow') return;
      const p = o.geometry.attributes.position;
      for (let k = 0; k < p.count; k++) pts.push([p.getX(k), p.getY(k), p.getZ(k)]);
    });
    const ring = (z0) => {
      const sel = pts.filter((p) => Math.abs(p[2] - z0) < 0.004);
      const n = sel.length || 1;
      return new THREE.Vector3(sel.reduce((a, b) => a + b[0], 0) / n,
        sel.reduce((a, b) => a + b[1], 0) / n, sel.reduce((a, b) => a + b[2], 0) / n);
    };
    tan.push(Math.acos(Math.min(1, ring(h.tip.z).sub(ring(h.tip.z - 0.08)).normalize().z)) * DEG);
    g.traverse((o) => o.isMesh && o.geometry.dispose());
  }
  const st = (a) => { const s = [...a].sort((x, y) => x - y); return `${s[0].toFixed(2)} / ${s[s.length >> 1].toFixed(2)} / ${s[s.length - 1].toFixed(2)}`; };
  console.log(`held mesh, 300 seeds:  spear tilt off +Z (deg) ${st(tilt)}   lateral offset (mm) ${st(off)}`);
  console.log(`                       shaft tangent off +Z at the mallow (deg) ${st(tan)}`);
  process.exit(0);
}

if (WHAT === 'mesh') {
  // The strongest form of the measurement: the REAL held stick, freshly built
  // per seed, hung on the real roll line at the real distance from the fire.
  // The dump's own mallow transform is discarded — only the line, the axial
  // station along it and the fire survive — so this reads whatever the geometry
  // file currently does, not whatever it did the day roastmat.mjs ran.
  const mk = (s) => () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; };
  const p0 = new THREE.Vector3().setFromMatrixPosition(L.M0);
  const along = p0.clone().sub(L.point).dot(L.axis);
  const bx = new THREE.Vector3(0, 1, 0).cross(L.axis);
  if (bx.lengthSq() < 1e-8) bx.set(1, 0, 0);
  bx.normalize();
  const by = new THREE.Vector3().crossVectors(L.axis, bx).normalize();
  const Rs = new THREE.Matrix4().makeBasis(bx, by, L.axis);
  const N = parseInt(arg('seeds', '12'), 10);
  console.log(` seed | tilt° |  off mm | spin | golden at | evenness | ring lo..hi | grade`);
  console.log('─'.repeat(76));
  const evens = [];
  for (let i = 0; i < N; i++) {
    const g = buildHeldStick(mk(0x85ebca6b ^ (i * 2246822519)));
    const h = g.userData.held;
    const ax = new THREE.Vector3(0, 0, 1).applyQuaternion(h.mallow.quaternion);
    const grip = L.point.clone().addScaledVector(L.axis, along - h.tip.z);
    const base = Rs.clone().setPosition(grip).multiply(
      new THREE.Matrix4().compose(h.mallow.position, h.mallow.quaternion, new THREE.Vector3(1, 1, 1)));
    const obj = new THREE.Object3D();
    obj.matrixAutoUpdate = false;
    const rotL = new THREE.Matrix4(), T = new THREE.Matrix4(), Tb = new THREE.Matrix4();
    Tb.makeTranslation(-L.point.x, -L.point.y, -L.point.z);
    T.makeTranslation(L.point.x, L.point.y, L.point.z);
    const P = { at(spin) {
      rotL.makeRotationAxis(L.axis, spin);
      obj.matrixWorld.copy(base).premultiply(Tb).premultiply(rotL).premultiply(T);
      return obj;
    } };
    for (const spin of SPINS) {
      const r = cook(P, spin);
      if (spin === SPINS[SPINS.length - 1]) evens.push(r.even);
      console.log(`${String(i).padStart(5)} | ${(Math.acos(Math.min(1, Math.abs(ax.z))) * DEG).toFixed(2).padStart(5)} | ` +
        `${(Math.hypot(h.tip.x, h.tip.y) * 1e3).toFixed(2).padStart(7)} | ${spin.toFixed(1).padStart(4)} |` +
        `${(Number.isFinite(r.t) ? r.t.toFixed(1) + ' s' : 'never').padStart(10)} |${r.even.toFixed(3).padStart(9)} | ` +
        `${r.ringLo.toFixed(3)}..${r.ringHi.toFixed(3)} | ${r.grade}`);
    }
    g.traverse((o) => o.isMesh && o.geometry.dispose());
  }
  const s = evens.sort((a, b) => a - b);
  console.log(`\nevenness at golden, ${N} seeds at ${SPINS[SPINS.length - 1]} rad/s: ` +
    `${s[0].toFixed(3)} / ${s[s.length >> 1].toFixed(3)} / ${s[s.length - 1].toFixed(3)}   ('perfect' needs > 0.78)`);
  process.exit(0);
}

console.log(`bank ${BANK}   height ${HEIGHT}   ${SECONDS} s at ${HZ} Hz`);
console.log(`spin line: axis ${L.axis.toArray().map((v) => v.toFixed(3)).join(',')}  ` +
  `quarter-turn ${(L.angle * DEG).toFixed(2)} deg  screw slide ${(L.slide * 1e3).toFixed(3)} mm`);
const probe = poser(L, {});
console.log(`as dumped: spear tilt ${probe.tilt0.toFixed(2)} deg   lateral offset ${probe.off0.toFixed(2)} mm\n`);

const cases = WHAT === 'offset'
  ? [0, 4, 8, 12, 16, 20, 28].flatMap((o) => [{ offMm: o, tiltDeg: 0 }, { offMm: o, tiltDeg: probe.tilt0 }])
  : [0, 1, 2, 3, 4, 6, 8, 10, 12, 13.9, 16, 20].map((t) => ({ tiltDeg: t }));

console.log(' tilt°   off mm | spin | golden at |  evenness  ceiling | ring lo..hi | grade');
console.log('─'.repeat(84));
for (const c of cases) {
  for (const spin of SPINS) {
    const P = poser(L, c);
    const r = cook(P, spin);
    console.log(
      `${P.tilt.toFixed(1).padStart(5)}  ${P.off.toFixed(1).padStart(7)} | ${spin.toFixed(1).padStart(4)} |` +
      `${(Number.isFinite(r.t) ? r.t.toFixed(1) + ' s' : 'never').padStart(10)} |` +
      `${r.even.toFixed(3).padStart(10)}  ${r.ceil.toFixed(3)} | ` +
      `${r.ringLo.toFixed(3)}..${r.ringHi.toFixed(3)} | ${r.grade}`);
  }
}

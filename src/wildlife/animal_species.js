// ─────────────────────────────────────────────────────────────────────────────
//  animal_species — the blueprints.
//
//  Every mammal in the game is the same quadruped: a lofted barrel on a spine,
//  a neck, a head with a muzzle and ears, four three-segment legs and a tail.
//  What separates a deer from a bear is entirely in the numbers — where the
//  back line sits, how deep the barrel is, how long the legs are, where the
//  head is carried relative to the withers.
//
//  That is deliberate. Plate 3 shows the bar: the bear is legible as a bear
//  from a hundred metres away as a flat black shape, because its proportions
//  are right — low head, high shoulder hump, short heavy legs, long body. Get
//  the profile right and the shading barely matters. Get it wrong and no amount
//  of shading saves it. So the profile arrays below are the actual art.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, lerp, clamp01 } from '../core/MathUtils.js';
import { RigBuilder, Skel, tube, makePrototype, MIX, mixLerp } from './animal_rig.js';

// ── hide material ────────────────────────────────────────────────────────────

/**
 * A standard material so it inherits the global stylised lighting, the shared
 * fog and shadows, plus a four-way region blend resolved from a vertex
 * attribute. Flat shading is doing real work here: it keeps the forms carved
 * and faceted like the rest of the world instead of smoothly airbrushed.
 *
 * All hide materials share one program (see customProgramCacheKey) — twelve
 * animals alive means twelve materials but one compile.
 */
export function createHideMaterial(c) {
  const uniforms = {
    uCoat: { value: new THREE.Color(c.coat) },
    uPale: { value: new THREE.Color(c.pale) },
    uDark: { value: new THREE.Color(c.dark) },
    uHorn: { value: new THREE.Color(c.horn ?? 0x9d8a6a) },
    uShadeLo: { value: c.shadeLo ?? 0.60 },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.97,        // matte hide; the reference has no sheen anywhere
    metalness: 0.0,
    flatShading: true,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = /* glsl */`
      attribute vec4 aMix;
      attribute float aShade;
      varying vec4 vMix;
      varying float vShade;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vMix = aMix;
       vShade = aShade;`
    );

    shader.fragmentShader = /* glsl */`
      uniform vec3 uCoat;
      uniform vec3 uPale;
      uniform vec3 uDark;
      uniform vec3 uHorn;
      uniform float uShadeLo;
      varying vec4 vMix;
      varying float vShade;
    ` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       vec3 hideCol = uCoat * vMix.x + uPale * vMix.y + uDark * vMix.z + uHorn * vMix.w;
       diffuseColor.rgb *= hideCol * mix( uShadeLo, 1.0, vShade );`
    );
  };
  // One program for every hide; only the uniform values differ.
  mat.customProgramCacheKey = () => 'animalHide';
  mat.userData.uniforms = uniforms;
  return mat;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Blend a barrel station between the two nearest spine bones by its z. */
function chainWeight(skel, names, z) {
  let i = 0;
  while (i < names.length - 2 && skel.bones[skel.idx(names[i + 1])].z < z) i++;
  const a = skel.bones[skel.idx(names[i])], b = skel.bones[skel.idx(names[i + 1])];
  const t = clamp01((z - a.z) / Math.max(1e-4, b.z - a.z));
  // Only actually split near the joint; elsewhere bind rigidly so the barrel
  // does not shear when the spine bends.
  const w = t < 0.32 ? 0 : t > 0.68 ? 1 : (t - 0.32) / 0.36;
  return { bone: skel.idx(names[i]), bone2: skel.idx(names[i + 1]), w2: w };
}

/**
 * One leg: three tapered segments with a 50/50 weight seam at each joint, plus
 * a hoof or paw block. Joints arrive already resolved to absolute model space
 * and already mirrored, so nothing here has to think about sides.
 */
function buildLeg(B, L, D) {
  const { spec: sp, iU, iL, iC, hip, knee, hock, foot } = L;
  const R = D.radialLimb;

  const seg = (aP, bP, bA, bB, r0, r1, mixA, mixB, shade) => {
    // A short overlap either side of each joint, weighted to both bones, hides
    // the seam without smooth-skinning the whole limb into rubber.
    const st = [];
    for (const t of [0.02, 0.22, 0.55, 0.86, 0.98]) {
      const r = lerp(r0, r1, t);
      st.push({
        x: lerp(aP[0], bP[0], t), y: lerp(aP[1], bP[1], t), z: lerp(aP[2], bP[2], t),
        rx: r * (sp.flat ?? 1), ry: r,
        mix: mixLerp(mixA, mixB, t), shade,
        // Only the last ring shares weight with the next bone down; the body of
        // the segment stays rigid to its own so the limb keeps a hard profile.
        bone: bA, bone2: t > 0.92 ? bB : bA, w2: t > 0.92 ? 0.5 : 0,
      });
    }
    tube(B, st, { radial: R, ao: 0.5, k: sp.k ?? 1 });
  };

  const coat = MIX.coat, dark = MIX.dark;
  const sockT = sp.sockTop ?? 0.55;   // where the coat gives way to dark legs
  const midMix = mixLerp(coat, dark, sockT);

  seg(hip, knee, iU, iL, sp.rTop, sp.rMid, coat, coat, 0.94);
  seg(knee, hock, iL, iC, sp.rMid, sp.rLow, coat, midMix, 0.90);
  seg(hock, foot, iC, iC, sp.rLow, sp.rFoot, midMix, dark, 0.86);

  // Hoof / paw: a small squat block so the leg does not end in a needle.
  const hh = sp.hoofH ?? 0.07, hr = sp.hoofR ?? (sp.rFoot * 1.5);
  tube(B, [
    { x: foot[0], y: foot[1] + hh, z: foot[2], rx: hr * 0.85, ry: hr * 0.85, bone: iC, mix: dark, shade: 0.8 },
    { x: foot[0], y: foot[1] + 0.004, z: foot[2] + (sp.hoofFwd ?? 0), rx: hr, ry: hr * (sp.hoofLong ?? 1), bone: iC, mix: dark, shade: 0.7 },
  ], { radial: Math.max(4, R - 1), ao: 0.2, k: 0.8 });
}

/** A recursive antler: main beam sweeping back and up, with forward tines. */
function buildAntler(B, skel, P, side, D, rnd) {
  if (!P.antler) return;
  const A = P.antler;
  const name = side > 0 ? 'antlerR' : 'antlerL';
  const bone = skel.idx(name);
  const base = skel.at(name, new THREE.Vector3());
  const horn = MIX.horn;

  const beam = (from, dir, len, r0, r1, levels, spreadSign) => {
    const st = [];
    const segs = D.antlerSegs;
    // Beams curve: the direction rotates steadily outward and upward.
    let px = from.x, py = from.y, pz = from.z;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      st.push({
        x: px, y: py, z: pz,
        rx: lerp(r0, r1, t), ry: lerp(r0, r1, t),
        bone, mix: horn, shade: 0.95,
      });
      const step = len / segs;
      px += dx * step; py += dy * step; pz += dz * step;
      // Curl back over the head.
      dy -= 0.14 / segs * 3; dz -= 0.10 / segs * 3; dx += spreadSign * 0.06 / segs * 3;
      const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      // Tines fork off the beam, shorter each time up.
      if (levels > 0 && i > 0 && i < segs && (i % A.tineEvery) === 0) {
        const tl = len * (0.42 + rnd() * 0.20) * (1 - t * 0.45);
        beam(
          { x: px, y: py, z: pz },
          { x: dx * 0.25 + spreadSign * 0.30, y: 0.86, z: 0.42 },
          tl, r0 * 0.62, r1 * 0.5, levels - 1, spreadSign,
        );
      }
    }
    tube(B, st, { radial: D.antlerRadial, ao: 0.3, tipEnd: true });
  };

  beam(
    { x: base.x, y: base.y, z: base.z },
    { x: side * A.out, y: A.up, z: A.back },
    A.len, A.r0, A.r1, D.antlerLevels, side,
  );
}

// ── the generic quadruped ────────────────────────────────────────────────────

const DETAIL = [
  // near
  { radialBody: 7, radialLimb: 5, antlerRadial: 4, antlerLevels: 1, antlerSegs: 5, barrelStep: 1, ears: true },
  // mid — half the rings, four-sided limbs, one antler fork
  { radialBody: 5, radialLimb: 4, antlerRadial: 3, antlerLevels: 1, antlerSegs: 3, barrelStep: 2, ears: true },
];

function buildQuadruped(P, detailLevel, seed) {
  const D = DETAIL[detailLevel];
  const rnd = mulberry32(seed >>> 0);
  const S = new Skel();
  const B = new RigBuilder();

  // ── skeleton ───────────────────────────────────────────────────────────────
  S.add('root', null, 0, 0, 0);
  S.add('pelvis', 'root', ...P.pelvis);
  let prev = 'pelvis';
  const spineNames = ['pelvis'];
  P.spine.forEach((p, i) => { S.add(`spine${i + 1}`, prev, ...p); prev = `spine${i + 1}`; spineNames.push(prev); });
  S.add('chest', prev, ...P.chest); spineNames.push('chest');

  prev = 'chest';
  const neckNames = [];
  P.neck.forEach((p, i) => { S.add(`neck${i + 1}`, prev, ...p); prev = `neck${i + 1}`; neckNames.push(prev); });
  S.add('head', prev, ...P.head);
  S.addRel('earL', 'head', -P.ear.at[0], P.ear.at[1], P.ear.at[2]);
  S.addRel('earR', 'head', P.ear.at[0], P.ear.at[1], P.ear.at[2]);
  if (P.antler) {
    S.addRel('antlerL', 'head', -P.antler.base[0], P.antler.base[1], P.antler.base[2]);
    S.addRel('antlerR', 'head', P.antler.base[0], P.antler.base[1], P.antler.base[2]);
  }

  prev = 'pelvis';
  const tailNames = [];
  P.tail.forEach((p, i) => { S.add(`tail${i + 1}`, prev, ...p); prev = `tail${i + 1}`; tailNames.push(prev); });

  // Limb joints are authored as offsets down the chain; resolve them to model
  // space once, here, so both the skeleton and the geometry read the same
  // numbers and nothing has to re-derive a mirrored position later.
  const legDefs = [];
  for (const spec of [P.hind, P.fore]) {
    for (const side of [-1, 1]) {
      const nm = spec.tag + (side < 0 ? 'L' : 'R');
      const parent = spec.front ? 'chest' : 'pelvis';
      const hip = [side * spec.hip[0], spec.hip[1], spec.hip[2]];
      const knee = [hip[0] + side * spec.knee[0], hip[1] + spec.knee[1], hip[2] + spec.knee[2]];
      const hock = [knee[0] + side * spec.hock[0], knee[1] + spec.hock[1], knee[2] + spec.hock[2]];
      const foot = [hock[0] + side * spec.foot[0], hock[1] + spec.foot[1], hock[2] + spec.foot[2]];
      const iU = S.add(nm + '_upper', parent, ...hip);
      const iL = S.add(nm + '_lower', nm + '_upper', ...knee);
      const iC = S.add(nm + '_cannon', nm + '_lower', ...hock);
      legDefs.push({ spec, side, name: nm, iU, iL, iC, hip, knee, hock, foot });
    }
  }

  // ── geometry ───────────────────────────────────────────────────────────────
  // Barrel: the single most important shape in the whole system.
  const bar = [];
  const src = P.barrel;
  for (let i = 0; i < src.length; i++) {
    // Keep the first, last and any station flagged as a silhouette key when
    // thinning for the mid LOD — dropping the hump would be fatal.
    if (detailLevel > 0 && i % D.barrelStep && i !== 0 && i !== src.length - 1 && !src[i].key) continue;
    const s = src[i];
    const w = chainWeight(S, spineNames, s.z);
    bar.push({
      x: 0, y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: s.k ?? 0.92,
      bone: w.bone, bone2: w.bone2, w2: w.w2,
      mix: s.mix ?? MIX.coat, shade: s.shade ?? 1,
    });
  }
  tube(B, bar, { radial: D.radialBody, ao: 0.55, tipStart: true, tipEnd: false });

  // Underside: a pale belly panel painted straight onto the barrel would need a
  // texture, so instead the barrel stations carry their own mix and the belly
  // is a second, slightly inset tube along the bottom. Cheaper and it reads as
  // a soft-edged colour break rather than a hard line.
  if (P.belly) {
    const bl = [];
    for (const s of P.belly) {
      const w = chainWeight(S, spineNames, s.z);
      bl.push({
        x: 0, y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: 0.75,
        bone: w.bone, bone2: w.bone2, w2: w.w2, mix: MIX.pale, shade: 0.72,
      });
    }
    tube(B, bl, { radial: Math.max(4, D.radialBody - 2), ao: 0.4, tipStart: true, tipEnd: true });
  }

  // Neck: from the chest up to the skull.
  const neckIdx = neckNames.map((n) => S.idx(n));
  const nk = [];
  const nPts = [S.at('chest', new THREE.Vector3()), ...neckNames.map((n) => S.at(n, new THREE.Vector3())), S.at('head', new THREE.Vector3())];
  for (let i = 0; i < P.neckProfile.length; i++) {
    const t = i / (P.neckProfile.length - 1);
    const f = t * (nPts.length - 1);
    const i0 = Math.min(nPts.length - 2, Math.floor(f)), ft = f - i0;
    const a = nPts[i0], b = nPts[i0 + 1];
    const bi = Math.max(0, Math.min(neckIdx.length - 1, i0 - 1 + (ft > 0.5 ? 1 : 0)));
    const bi2 = Math.min(neckIdx.length - 1, bi + 1);
    const pr = P.neckProfile[i];
    nk.push({
      x: 0, y: lerp(a.y, b.y, ft) + (pr.dy ?? 0), z: lerp(a.z, b.z, ft) + (pr.dz ?? 0),
      rx: pr.rx, ry: pr.ry, k: 0.92,
      bone: i0 === 0 ? S.idx('chest') : neckIdx[bi], bone2: neckIdx[bi2],
      w2: i0 === 0 ? 0 : (ft > 0.35 && ft < 0.65 ? 0.5 : 0),
      mix: pr.mix ?? MIX.coat, shade: pr.shade ?? 0.97,
    });
  }
  tube(B, nk, { radial: D.radialBody, ao: 0.5, capStart: false, capEnd: false });

  // Head + muzzle.
  const hd = S.at('head', new THREE.Vector3());
  const iHead = S.idx('head');
  const hs = P.headProfile.map((p) => ({
    x: 0, y: hd.y + p.dy, z: hd.z + p.dz, rx: p.rx, ry: p.ry, k: p.k ?? 0.9,
    bone: iHead, mix: p.mix ?? MIX.coat, shade: p.shade ?? 1,
  }));
  tube(B, hs, { radial: D.radialBody, ao: 0.45, tipEnd: P.muzzleTip !== false });

  // Ears. Every other part of the animal is authored in absolute model space and
  // these were authored relative to the ear bone, which put both ears on the
  // ground between the animal's feet as a pair of spikes — the skin transform
  // is bone * inverseBind, and inverseBind is a pure translation, so a vertex
  // written at the origin stays at the origin. No animal in the game had ears.
  if (D.ears) {
    for (const side of [-1, 1]) {
      const name = side < 0 ? 'earL' : 'earR';
      const eb = S.idx(name);
      const ep = S.at(name, new THREE.Vector3());
      const e = P.ear;
      const st = [];
      const n = 3;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        st.push({
          x: ep.x + side * e.dir[0] * e.len * t,
          y: ep.y + e.dir[1] * e.len * t,
          z: ep.z + e.dir[2] * e.len * t,
          rx: lerp(e.w, e.w * 0.45, t) * (1 - t * t * 0.5),
          ry: lerp(e.h, e.h * 0.7, t),
          bone: eb, mix: t > 0.6 ? MIX.dark : mixLerp(MIX.coat, MIX.pale, 0.25), shade: 0.92,
        });
      }
      tube(B, st, { radial: 4, ao: 0.3, tipEnd: true });
    }
  }

  // Tail.
  const tPts = [S.at('pelvis', new THREE.Vector3()), ...tailNames.map((n) => S.at(n, new THREE.Vector3()))];
  const tSt = [];
  for (let i = 0; i < tPts.length; i++) {
    const t = i / (tPts.length - 1);
    tSt.push({
      x: 0, y: tPts[i].y, z: tPts[i].z,
      rx: lerp(P.tailR[0], P.tailR[1], t), ry: lerp(P.tailR[0], P.tailR[1], t) * (P.tailFlat ?? 1),
      bone: i === 0 ? S.idx('pelvis') : S.idx(tailNames[Math.min(tailNames.length - 1, i - 1)]),
      // Dark at the root, pale at the tip. A deer's alarm flag is the white
      // underside flashing as the tail comes up, and a uniformly pale tail is
      // just a bright smudge on the rump the rest of the time.
      mix: mixLerp(P.tailMix ?? MIX.coat, P.tailTipMix ?? P.tailMix ?? MIX.coat, t),
      shade: 0.9,
    });
  }
  tube(B, tSt, { radial: 4, ao: 0.35, tipEnd: true, capStart: false });

  // Legs and antlers.
  for (const L of legDefs) buildLeg(B, L, D);
  for (const side of [-1, 1]) buildAntler(B, S, P, side, D, rnd);

  return { skel: S, geometry: B.toGeometry(), legDefs };
}

// ── the animation contract ───────────────────────────────────────────────────

/**
 * Everything the gait solver needs, derived once from the blueprint so the
 * per-frame code never touches the description again.
 */
function rigInfo(S, P, legDefs) {
  const legs = legDefs.map((L) => ({
    name: L.name, side: L.side, front: !!L.spec.front, bend: L.spec.bend,
    iUpper: L.iU, iLower: L.iL, iCannon: L.iC,
    l1: Math.hypot(L.spec.knee[0], L.spec.knee[1], L.spec.knee[2]),
    l2: Math.hypot(L.spec.hock[0], L.spec.hock[1], L.spec.hock[2]),
    cannon: Math.hypot(L.spec.foot[0], L.spec.foot[1], L.spec.foot[2]),
    // hock -> foot in model space. The animator holds this offset rigid so a
    // hoof stays vertical and a plantigrade paw stays flat, with no special case.
    footDY: L.spec.foot[1], footDZ: L.spec.foot[2],
    // Neutral ground contact point in model space — where this foot wants to
    // be when the animal is standing still. The gait swings around it.
    restX: L.foot[0], restZ: L.foot[2], restY: L.foot[1],
    hipY: L.hip[1],
  }));
  return {
    legs,
    spine: ['spine1', 'spine2', 'chest'].filter((n) => S.map[n] !== undefined).map((n) => S.idx(n)),
    iPelvis: S.idx('pelvis'), iChest: S.idx('chest'), iRoot: S.idx('root'),
    neck: Object.keys(S.map).filter((n) => /^neck\d$/.test(n)).map((n) => S.idx(n)),
    iHead: S.idx('head'),
    ears: [S.idx('earL'), S.idx('earR')],
    tail: Object.keys(S.map).filter((n) => /^tail\d$/.test(n)).map((n) => S.idx(n)),
  };
}

// ── blueprints ───────────────────────────────────────────────────────────────

// Deer. Long thin legs, a shallow laterally-compressed barrel, a level back
// line and a head carried high on a near-vertical neck. The white rump patch
// and pale belly are the only bright values on the animal, and they are what
// make a deer read as a deer at 60 m rather than as a generic brown quadruped.
const DEER = () => ({
  key: 'deer',
  pelvis: [0, 1.02, -0.42],
  spine: [[0, 1.05, -0.16], [0, 1.06, 0.10]],
  chest: [0, 1.07, 0.34],
  neck: [[0, 1.19, 0.45], [0, 1.37, 0.57]],
  head: [0, 1.47, 0.63],
  barrel: [
    { z: -0.68, y: 1.00, rx: 0.085, ry: 0.105, mix: MIX.pale, shade: 1.06 },
    // A white rump *patch*, not a white rump. At golden hour with bloom on top,
    // a strongly pale station here blows out into a bright yellow blob that
    // reads as a hole in the animal rather than as markings.
    { z: -0.58, y: 1.02, rx: 0.158, ry: 0.178, mix: mixLerp(MIX.coat, MIX.pale, 0.26), key: 1 },
    // The haunch and the shoulder are the two places a deer is widest. Without
    // them the barrel is a tube on four sticks, which is what the first pass
    // read as — an alpaca rather than a deer.
    { z: -0.42, y: 1.03, rx: 0.196, ry: 0.208, key: 1 },
    { z: -0.16, y: 1.03, rx: 0.178, ry: 0.214 },
    { z: 0.08, y: 1.035, rx: 0.176, ry: 0.222, key: 1 },
    { z: 0.28, y: 1.045, rx: 0.186, ry: 0.216 },
    { z: 0.44, y: 1.03, rx: 0.138, ry: 0.172, key: 1 },
  ],
  belly: [
    { z: -0.30, y: 0.885, rx: 0.105, ry: 0.045 },
    { z: -0.02, y: 0.870, rx: 0.118, ry: 0.050 },
    { z: 0.26, y: 0.885, rx: 0.108, ry: 0.045 },
  ],
  // A deer's neck is a wedge, thick where it leaves the chest and only
  // slightly narrower at the skull. Tapering it to a stalk is what turned the
  // first pass into a camelid.
  neckProfile: [
    { rx: 0.142, ry: 0.166 },
    { rx: 0.118, ry: 0.142 },
    { rx: 0.098, ry: 0.114 },
    { rx: 0.085, ry: 0.096 },
  ],
  headProfile: [
    { dy: -0.005, dz: -0.060, rx: 0.078, ry: 0.084 },
    { dy: 0.006, dz: 0.012, rx: 0.084, ry: 0.092 },
    { dy: -0.012, dz: 0.082, rx: 0.056, ry: 0.060 },
    { dy: -0.034, dz: 0.158, rx: 0.044, ry: 0.045, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.048, dz: 0.196, rx: 0.037, ry: 0.035, mix: MIX.dark },
  ],
  ear: { at: [0.066, 0.050, -0.022], dir: [0.60, 0.76, -0.26], len: 0.165, w: 0.056, h: 0.016 },
  // The white scut is a deer's signature at any distance, so it is a broad flat
  // paddle rather than a thin rope — it has to catch light when it lifts.
  tail: [[0, 1.00, -0.62], [0, 0.95, -0.70], [0, 0.89, -0.75]],
  tailR: [0.050, 0.032], tailFlat: 0.52,
  tailMix: mixLerp(MIX.coat, MIX.pale, 0.15), tailTipMix: MIX.pale,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.148, 0.98, -0.42], knee: [0, -0.36, 0.12], hock: [0, -0.26, -0.16], foot: [0, -0.36, 0.04],
    rTop: 0.140, rMid: 0.062, rLow: 0.036, rFoot: 0.026, flat: 0.82,
    hoofH: 0.055, hoofR: 0.036, hoofLong: 1.35, hoofFwd: 0.008, sockTop: 0.5,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.138, 1.06, 0.30], knee: [0, -0.36, -0.10], hock: [0, -0.28, 0.10], foot: [0, -0.42, 0.0],
    rTop: 0.120, rMid: 0.055, rLow: 0.033, rFoot: 0.025, flat: 0.82,
    hoofH: 0.055, hoofR: 0.034, hoofLong: 1.35, hoofFwd: 0.008, sockTop: 0.5,
  },
});

// Bear. Everything deer is not: the head hangs below the shoulder, the hump is
// the highest point, the barrel is nearly round and enormous, the legs are
// short columns and the feet are plantigrade plates. Plate 3 exactly.
const BEAR = () => ({
  key: 'bear',
  // A bear is a long low mass carried on short columns, with the head slung
  // below and in front of the shoulder hump. The first pass stood it too tall
  // and tucked the head into the shoulder, which read as a boar.
  pelvis: [0, 0.74, -0.52],
  spine: [[0, 0.78, -0.20], [0, 0.82, 0.12]],
  chest: [0, 0.86, 0.40],
  neck: [[0, 0.85, 0.62]],
  head: [0, 0.71, 0.92],
  barrel: [
    { z: -0.80, y: 0.68, rx: 0.196, ry: 0.196 },
    { z: -0.66, y: 0.72, rx: 0.245, ry: 0.242, key: 1 },
    { z: -0.42, y: 0.74, rx: 0.272, ry: 0.268 },
    { z: -0.12, y: 0.76, rx: 0.288, ry: 0.290, key: 1 },
    { z: 0.14, y: 0.80, rx: 0.290, ry: 0.315 },
    { z: 0.34, y: 0.84, rx: 0.278, ry: 0.345, key: 1 },   // the hump
    { z: 0.52, y: 0.82, rx: 0.230, ry: 0.262 },
    { z: 0.64, y: 0.78, rx: 0.168, ry: 0.182, key: 1 },
  ],
  belly: null,
  // Waisted at the throat so the skull is a separate mass from the hump.
  neckProfile: [
    { rx: 0.205, ry: 0.220 },
    { rx: 0.162, ry: 0.166 },
    { rx: 0.118, ry: 0.116 },
  ],
  headProfile: [
    { dy: 0.014, dz: -0.070, rx: 0.108, ry: 0.112 },
    { dy: 0.006, dz: 0.014, rx: 0.122, ry: 0.118 },
    { dy: -0.020, dz: 0.090, rx: 0.083, ry: 0.078, mix: mixLerp(MIX.coat, MIX.pale, 0.40) },
    { dy: -0.036, dz: 0.170, rx: 0.062, ry: 0.058, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.046, dz: 0.210, rx: 0.050, ry: 0.044, mix: MIX.dark },
  ],
  ear: { at: [0.096, 0.100, -0.066], dir: [0.44, 0.86, -0.26], len: 0.100, w: 0.066, h: 0.030 },
  tail: [[0, 0.74, -0.86], [0, 0.70, -0.92]],
  tailR: [0.045, 0.018], tailFlat: 1,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.205, 0.72, -0.50], knee: [0, -0.28, 0.11], hock: [0, -0.22, -0.15], foot: [0, -0.22, 0.10],
    rTop: 0.190, rMid: 0.132, rLow: 0.096, rFoot: 0.074, flat: 0.88, k: 0.85,
    hoofH: 0.070, hoofR: 0.082, hoofLong: 1.9, hoofFwd: 0.055, sockTop: 0.30,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.225, 0.86, 0.28], knee: [0, -0.33, -0.11], hock: [0, -0.30, 0.13], foot: [0, -0.23, 0.06],
    rTop: 0.186, rMid: 0.136, rLow: 0.102, rFoot: 0.082, flat: 0.90, k: 0.85,
    hoofH: 0.070, hoofR: 0.088, hoofLong: 1.7, hoofFwd: 0.048, sockTop: 0.30,
  },
});

// Rabbit. Read at 15 m or not at all, so the ears and the white scut do all
// the identifying work. Permanently crouched, with hind legs folded flat.
const RABBIT = () => ({
  key: 'rabbit',
  pelvis: [0, 0.175, -0.095],
  spine: [[0, 0.180, -0.025]],
  chest: [0, 0.165, 0.055],
  neck: [[0, 0.178, 0.092]],
  head: [0, 0.196, 0.126],
  barrel: [
    { z: -0.185, y: 0.150, rx: 0.048, ry: 0.052, mix: MIX.pale },
    { z: -0.135, y: 0.170, rx: 0.075, ry: 0.082, key: 1 },
    { z: -0.055, y: 0.176, rx: 0.082, ry: 0.090 },
    { z: 0.020, y: 0.168, rx: 0.076, ry: 0.082, key: 1 },
    { z: 0.078, y: 0.160, rx: 0.060, ry: 0.064 },
  ],
  belly: [
    { z: -0.10, y: 0.100, rx: 0.048, ry: 0.020 },
    { z: 0.01, y: 0.096, rx: 0.052, ry: 0.022 },
  ],
  // A rabbit has no visible neck at all. The head has to sit straight on the
  // shoulders or the crouch reads as a bird.
  neckProfile: [
    { rx: 0.066, ry: 0.068 },
    { rx: 0.060, ry: 0.062 },
    { rx: 0.054, ry: 0.055 },
  ],
  headProfile: [
    { dy: 0.000, dz: -0.034, rx: 0.050, ry: 0.052 },
    { dy: 0.003, dz: 0.008, rx: 0.052, ry: 0.053 },
    { dy: -0.012, dz: 0.044, rx: 0.037, ry: 0.036 },
    { dy: -0.024, dz: 0.072, rx: 0.026, ry: 0.024, mix: MIX.dark },
  ],
  // Ears are the whole identity at fifteen metres, so they are generous.
  // Spread into a clear V — from most angles two overlapping vertical ears
  // read as one, and the V is the whole silhouette cue at fifteen metres.
  ear: { at: [0.034, 0.032, -0.012], dir: [0.30, 0.945, -0.14], len: 0.175, w: 0.038, h: 0.012 },
  tail: [[0, 0.163, -0.190], [0, 0.166, -0.214]],
  tailR: [0.036, 0.033], tailFlat: 1, tailMix: MIX.pale,
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.050, 0.170, -0.100], knee: [0, -0.048, 0.070], hock: [0, -0.062, -0.098], foot: [0, -0.060, 0.058],
    rTop: 0.044, rMid: 0.026, rLow: 0.017, rFoot: 0.014, flat: 0.80,
    hoofH: 0.016, hoofR: 0.019, hoofLong: 2.6, hoofFwd: 0.030, sockTop: 0.25,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.040, 0.150, 0.060], knee: [0, -0.052, -0.014], hock: [0, -0.040, 0.020], foot: [0, -0.058, 0.004],
    rTop: 0.026, rMid: 0.018, rLow: 0.013, rFoot: 0.011, flat: 0.85,
    hoofH: 0.014, hoofR: 0.015, hoofLong: 1.8, hoofFwd: 0.012, sockTop: 0.25,
  },
});

// Antlers only exist on the stag variant, so they are grafted on rather than
// living in the base blueprint.
const STAG_ANTLER = {
  base: [0.050, 0.055, -0.035],
  out: 0.44, up: 0.84, back: -0.30,
  len: 0.42, r0: 0.020, r1: 0.008, tineEvery: 2,
};

// ── variants ─────────────────────────────────────────────────────────────────
//
// Hides are warm, desaturated and dark. Against a #f0ad46 meadow every animal
// has to survive being reduced to a silhouette, and a hide that is merely a
// slightly different orange from the grass disappears.

export const SPECIES = {
  deer: {
    key: 'deer',
    variants: [
      { name: 'doe', scale: 0.94, antler: false, weight: 0.46,
        col: { coat: 0x6a4830, pale: 0xb9a686, dark: 0x38251a, horn: 0x9c8763 } },
      { name: 'yearling', scale: 0.80, antler: false, weight: 0.26,
        col: { coat: 0x7a5537, pale: 0xc0ad8b, dark: 0x3d2a1d, horn: 0x9c8763 } },
      { name: 'stag', scale: 1.10, antler: true, weight: 0.20,
        col: { coat: 0x54381f, pale: 0xa89478, dark: 0x2d1d13, horn: 0xa08c68 } },
      { name: 'dark doe', scale: 0.97, antler: false, weight: 0.08,
        col: { coat: 0x4e3626, pale: 0xa89478, dark: 0x2a1c14, horn: 0x9c8763 } },
    ],
    blueprint: DEER,
    // Behaviour numbers live with the species so a tweak is one edit.
    gait: {
      walk: 1.25, trot: 3.4, run: 10.5,
      strideBase: 1.05, dutyWalk: 0.63, dutyTrot: 0.50, dutyRun: 0.30,
      bobAmp: 0.038, pitchAmp: 0.055, liftScale: 1.0,
    },
    brain: {
      alertDist: 62, fleeDist: 30, calmDist: 95,
      freezeTime: [0.7, 2.0], fleeTime: [3.5, 7.0],
      grazeTime: [6, 20], idleTime: [2.5, 7], walkTime: [4, 12],
      herd: [1, 4], herdRadius: 9, wanderRadius: 34,
      grazeChance: 0.55,
    },
  },

  bear: {
    key: 'bear',
    variants: [
      { name: 'boar', scale: 1.08, weight: 0.45,
        col: { coat: 0x2b1c15, pale: 0x6b5340, dark: 0x1a100c, horn: 0xa89a86 } },
      { name: 'sow', scale: 0.96, weight: 0.40,
        col: { coat: 0x33231a, pale: 0x77604a, dark: 0x1d130e, horn: 0xa89a86 } },
      { name: 'cinnamon', scale: 1.00, weight: 0.15,
        col: { coat: 0x4a2d1c, pale: 0x8a6b46, dark: 0x2a1810, horn: 0xa89a86 } },
    ],
    blueprint: BEAR,
    gait: {
      walk: 1.05, trot: 2.6, run: 6.2,
      strideBase: 1.05, dutyWalk: 0.68, dutyTrot: 0.56, dutyRun: 0.38,
      bobAmp: 0.035, pitchAmp: 0.022, liftScale: 0.72,
    },
    brain: {
      alertDist: 32, fleeDist: 15, calmDist: 55,
      freezeTime: [1.2, 2.6], fleeTime: [2.5, 5.0],
      grazeTime: [10, 26], idleTime: [3, 9], walkTime: [10, 30],
      herd: [1, 1], herdRadius: 0, wanderRadius: 60,
      grazeChance: 0.5, patrol: true,
    },
  },

  rabbit: {
    key: 'rabbit',
    variants: [
      // Hare-scaled rather than rabbit-scaled, and a good deal darker than a
      // real one: at 0.2 m in 0.6 m grass, a grass-coloured animal is invisible
      // rather than shy. The whole point of the species is the moment it bolts.
      { name: 'brown', scale: 1.18, weight: 0.55,
        col: { coat: 0x5b452e, pale: 0xd9cdb4, dark: 0x2c2015, horn: 0x8a7a60 } },
      { name: 'grey', scale: 1.09, weight: 0.30,
        col: { coat: 0x4f463a, pale: 0xd4cbb9, dark: 0x272018, horn: 0x8a7a60 } },
      { name: 'sandy', scale: 1.25, weight: 0.15,
        col: { coat: 0x6b5133, pale: 0xe0d4b8, dark: 0x322415, horn: 0x8a7a60 } },
    ],
    blueprint: RABBIT,
    gait: {
      walk: 0.9, trot: 2.0, run: 7.0,
      strideBase: 0.34, dutyWalk: 0.55, dutyTrot: 0.45, dutyRun: 0.22,
      bobAmp: 0.014, pitchAmp: 0.05, liftScale: 1.5,
    },
    brain: {
      alertDist: 34, fleeDist: 22, calmDist: 45,
      freezeTime: [0.6, 2.2], fleeTime: [1.6, 3.4],
      grazeTime: [4, 12], idleTime: [1.5, 5], walkTime: [1.5, 5],
      herd: [1, 2], herdRadius: 4, wanderRadius: 14,
      grazeChance: 0.6,
    },
  },
};

/**
 * Build the prototypes for one species. Called once at load; each variant gets
 * a near and a mid geometry sharing one skeleton description.
 */
export function buildSpecies(key, seed) {
  const sp = SPECIES[key];
  const protos = [];
  for (let vi = 0; vi < sp.variants.length; vi++) {
    const v = sp.variants[vi];
    const P = sp.blueprint();
    if (v.antler) P.antler = STAG_ANTLER;
    const vseed = (seed ^ 0x51ed) + vi * 7919 + key.length * 104729;

    const near = buildQuadruped(P, 0, vseed);
    const mid = buildQuadruped(P, 1, vseed);
    const info = rigInfo(near.skel, P, near.legDefs);

    // Extent for culling and for the impostor card. Padded for the tallest
    // pose the gait can reach (a bounding deer lifts its head a long way).
    let top = 0, halfLen = 0, halfW = 0;
    const pos = near.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      top = Math.max(top, pos[i + 1]);
      halfLen = Math.max(halfLen, Math.abs(pos[i + 2]));
      halfW = Math.max(halfW, Math.abs(pos[i]));
    }
    const sphere = new THREE.Sphere(new THREE.Vector3(0, top * 0.5, 0), Math.hypot(halfLen, top * 0.6) * 1.25);
    near.geometry.boundingSphere = sphere.clone();
    mid.geometry.boundingSphere = sphere.clone();

    protos.push(makePrototype(near.skel, [near.geometry, mid.geometry], {
      info, variant: v, species: key, scale: v.scale,
      height: top, halfLen, halfW,
      tris: near.geometry.index.count / 3,
      midTris: mid.geometry.index.count / 3,
    }));
  }
  return protos;
}

/** Weighted deterministic variant pick. */
export function pickVariant(key, r) {
  const vs = SPECIES[key].variants;
  let acc = 0;
  for (let i = 0; i < vs.length; i++) { acc += vs[i].weight; if (r < acc) return i; }
  return vs.length - 1;
}

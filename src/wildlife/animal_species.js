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
    // A fifth colour, for a marking that is not a region of the hide. The four
    // above are a blend and every hide tone is somewhere inside the tetrahedron
    // they span; the camp dog's pink nose patch is not — no mix of tan, cream,
    // dark brown and leather is pink. Carried on its own `aSpot` weight, which
    // is zero on every other animal in the game.
    uSpot: { value: new THREE.Color(c.spot ?? 0xc98a86) },
    uShadeLo: { value: c.shadeLo ?? 0.68 },
    // ── the distance silhouette ─────────────────────────────────────────────
    // Measured: off-road the median closest approach a player makes to an
    // animal is 77 m, where a deer is about sixteen pixels tall. At that size
    // the only thing an eye can use is the *shape*, and the shape only exists
    // if it holds a value the background does not. Left alone, a warm mid-brown
    // hide behind 80 m of aerial perspective lands on precisely the value of
    // the dark straw and litter patches in sunlit gold grass, which is why a
    // deer at 100 m reads as ground clutter.
    //
    // This is not a hack bolted onto the lighting: it is what the reference
    // does. Plate 3's bear is legible as a bear at a hundred metres because it
    // is a single flat dark shape, with no internal shading and no haze in it.
    // So with distance the four hide regions collapse into one tone, the
    // shading gradient flattens out, and the whole thing is pulled down in
    // value *after* fog — because fog's entire job is to take away the value
    // the animal needs to keep.
    uSilNear: { value: c.silNear ?? 38.0 },
    uSilFar:  { value: c.silFar  ?? 145.0 },
    // Pushed harder than the first cut (0.58 / 0.62) after looking at plate 3
    // beside our own frames. The plate's bear is not 'somewhat darker than the
    // grass', it is very nearly black, and it holds one flat value across its
    // whole body. Half measures here produce a mid-brown blob that still sits
    // in the same value band as the straw and litter in sunlit gold grass,
    // which is the exact failure the whole silhouette treatment exists to fix.
    uSilDark: { value: c.silDark ?? 0.44 },   // post-fog value multiplier at full range
    uSilFlat: { value: c.silFlat ?? 0.85 },   // how far the regions collapse into uDark
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
      attribute float aSpot;
      varying vec4 vMix;
      varying float vShade;
      varying float vSpot;
      varying float vHideDepth;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vMix = aMix;
       vShade = aShade;
       vSpot = aSpot;`
    ).replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       // View depth, taken after the skinning has already moved the vertex, so
       // an animal mid-bound reports where it actually is.
       vHideDepth = -mvPosition.z;`
    );

    shader.fragmentShader = /* glsl */`
      uniform vec3 uCoat;
      uniform vec3 uPale;
      uniform vec3 uDark;
      uniform vec3 uHorn;
      uniform vec3 uSpot;
      uniform float uShadeLo;
      uniform float uSilNear;
      uniform float uSilFar;
      uniform float uSilDark;
      uniform float uSilFlat;
      varying vec4 vMix;
      varying float vShade;
      varying float vSpot;
      varying float vHideDepth;
    ` + shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       float hideSil = smoothstep( uSilNear, uSilFar, vHideDepth );
       vec3 hideCol = uCoat * vMix.x + uPale * vMix.y + uDark * vMix.z + uHorn * vMix.w;
       // The marking sits on top of the blend rather than inside it, and fades
       // out with distance along with everything else — a two-centimetre patch
       // has no business surviving into the distance silhouette.
       hideCol = mix( hideCol, uSpot, vSpot * ( 1.0 - hideSil ) );
       // Four regions near, one flat tone far.
       hideCol = mix( hideCol, mix( hideCol, uDark, uSilFlat ), hideSil );
       // ...and no internal shading gradient far, which is what makes a shape
       // read as a shape rather than as a smudge.
       float hideShade = mix( uShadeLo, 1.0, vShade );
       diffuseColor.rgb *= hideCol * mix( hideShade, 0.92, hideSil * 0.85 );`
    ).replace(
      '#include <fog_fragment>',
      `#include <fog_fragment>
       gl_FragColor.rgb *= mix( 1.0, uSilDark, hideSil );`
    );
  };
  // One program for every hide; only the uniform values differ.
  mat.customProgramCacheKey = () => 'animalHide';
  mat.userData.uniforms = uniforms;
  return mat;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Catmull-Rom through four scalars. */
function crom(a, b, c, d, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * b) + (-a + c) * t
    + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
}

/**
 * Resample a profile so `factor - 1` intermediate stations sit between each
 * authored pair, positions and radii following a Catmull-Rom through the keys
 * rather than the straight chords. The authored stations pass through
 * unchanged — they are the art; this only rounds the path between them.
 *
 * Stations must be normalised first (every numeric field present on every
 * station, `mix` present if any station carries one). Skinning fields are
 * deliberately absent: callers resolve bones per-ring *after* resampling, so
 * an inserted ring weights itself exactly as an authored one at its z would.
 */
function smoothStations(src, factor) {
  if (factor <= 1 || src.length < 3) return src;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) {
    const p0 = src[Math.max(0, i - 1)], p1 = src[i];
    const p2 = src[i + 1], p3 = src[Math.min(src.length - 1, i + 2)];
    out.push(p1);
    for (let s = 1; s < factor; s++) {
      const t = s / factor;
      const st = {};
      for (const f in p1) {
        if (f === 'mix') continue;
        if (typeof p1[f] !== 'number') continue;
        st[f] = crom(p0[f] ?? p1[f], p1[f], p2[f] ?? p1[f], p3[f] ?? p2[f] ?? p1[f], t);
      }
      if (p1.mix) st.mix = mixLerp(p1.mix, p2.mix ?? p1.mix, t);
      out.push(st);
    }
  }
  out.push(src[src.length - 1]);
  return out;
}

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
  // near — rounded: extra radial sides, and `smooth` inserts Catmull-Rom rings
  // between the authored stations. Still flat-shaded and faceted, just with
  // facets small enough to read as a curve instead of as armour plate.
  { radialBody: 14, radialLimb: 10, radialTrim: 8, antlerRadial: 6, antlerLevels: 1, antlerSegs: 7,
    barrelStep: 1, ears: true, smooth: 3, neckRings: 14 },
  // mid — half the rings, four-sided limbs, one antler fork
  { radialBody: 5, radialLimb: 4, radialTrim: 4, antlerRadial: 3, antlerLevels: 1, antlerSegs: 3,
    barrelStep: 2, ears: true, smooth: 1, neckRings: 5 },
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
  const src = P.barrel;
  let barProf = [];
  for (let i = 0; i < src.length; i++) {
    // Keep the first, last and any station flagged as a silhouette key when
    // thinning for the mid LOD — dropping the hump would be fatal.
    if (detailLevel > 0 && i % D.barrelStep && i !== 0 && i !== src.length - 1 && !src[i].key) continue;
    const s = src[i];
    barProf.push({
      y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: s.k ?? 0.92,
      mix: s.mix ?? MIX.coat, shade: s.shade ?? 1,
    });
  }
  barProf = smoothStations(barProf, D.smooth);
  const bar = barProf.map((s) => {
    const w = chainWeight(S, spineNames, s.z);
    return {
      x: 0, y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: s.k,
      bone: w.bone, bone2: w.bone2, w2: w.w2,
      mix: s.mix, shade: s.shade,
    };
  });
  // `rumpTip` collapses the rear ring to a point. That is right for a bear or a
  // rabbit, whose backside really does taper away, and wrong for a deer, where
  // it hung a cone off the back of the animal.
  tube(B, bar, { radial: D.radialBody, ao: 0.55, tipStart: P.rumpTip !== false, tipEnd: false });

  // Underside: a pale belly panel painted straight onto the barrel would need a
  // texture, so instead the barrel stations carry their own mix and the belly
  // is a second, slightly inset tube along the bottom. Cheaper and it reads as
  // a soft-edged colour break rather than a hard line.
  if (P.belly) {
    const blProf = smoothStations(
      P.belly.map((s) => ({ y: s.y, z: s.z, rx: s.rx, ry: s.ry })), D.smooth);
    const bl = blProf.map((s) => {
      const w = chainWeight(S, spineNames, s.z);
      return {
        x: 0, y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: 0.75,
        // Not full pale. A belly panel at the top of the palette catches the
        // key light where the body pitches nose-down to graze and reads as a
        // lamp slung under the animal.
        bone: w.bone, bone2: w.bone2, w2: w.w2,
        mix: mixLerp(MIX.coat, MIX.pale, 0.55), shade: 0.62,
      };
    });
    tube(B, bl, { radial: Math.max(4, D.radialBody - 2), ao: 0.4, tipStart: true, tipEnd: true });
  }

  // Rump patch. Same trick as the belly: a small inset tube carrying its own
  // colour, so the marking has a soft edge and costs no texture. It lives on
  // the rear *underside*, where a whitetail's actually is — high on the rump it
  // blows out under bloom and reads as a hole rather than as markings.
  if (P.rump) {
    const rp = [];
    for (const s of P.rump) {
      const w = chainWeight(S, spineNames, s.z);
      rp.push({
        x: 0, y: s.y, z: s.z, rx: s.rx, ry: s.ry, k: 0.8,
        bone: w.bone, bone2: w.bone2, w2: w.w2,
        mix: mixLerp(MIX.coat, MIX.pale, 0.72), shade: 0.80,
      });
    }
    tube(B, rp, { radial: Math.max(4, D.radialBody - 2), ao: 0.35, tipStart: true, tipEnd: true });
  }

  // Neck: the chest → head chain, resampled as a smooth loft.
  //
  // Weighting matters more here than anywhere else on the animal. A grazing
  // quadruped swings its neck through about 120° — several times any other
  // joint — and the rigid-with-a-narrow-seam binding that keeps the barrel
  // crisp tears the throat wide open at that angle. The neck therefore gets a
  // genuinely blended weight across each segment, and enough rings to bend
  // through rather than snap at four hinges.
  const neckIdx = neckNames.map((n) => S.idx(n));
  const nPts = [S.at('chest', new THREE.Vector3()), ...neckNames.map((n) => S.at(n, new THREE.Vector3())), S.at('head', new THREE.Vector3())];
  // Bone owning each path point. The last one is the skull's socket, so the
  // final ring rides with the head and the throat cannot shear off the jaw.
  const nBone = [S.idx('chest'), ...neckIdx, S.idx('head')];
  const nk = [];
  const NR = D.neckRings;
  for (let i = 0; i < NR; i++) {
    const t = i / (NR - 1);
    const f = t * (nPts.length - 1);
    const seg = Math.min(nPts.length - 2, Math.floor(f));
    const ft = f - seg;
    const a = nPts[seg], b = nPts[seg + 1];
    // The profile is authored as a handful of key stations; resample it onto
    // however many rings this LOD wants.
    const pf = t * (P.neckProfile.length - 1);
    const pi = Math.min(P.neckProfile.length - 2, Math.floor(pf));
    const pt = pf - pi;
    const p0 = P.neckProfile[pi], p1 = P.neckProfile[pi + 1];
    nk.push({
      x: 0,
      y: lerp(a.y, b.y, ft) + lerp(p0.dy ?? 0, p1.dy ?? 0, pt),
      z: lerp(a.z, b.z, ft) + lerp(p0.dz ?? 0, p1.dz ?? 0, pt),
      rx: lerp(p0.rx, p1.rx, pt), ry: lerp(p0.ry, p1.ry, pt), k: 0.92,
      bone: nBone[seg], bone2: nBone[seg + 1],
      w2: clamp01((ft - 0.20) / 0.60),
      mix: p0.mix ?? MIX.coat, shade: p0.shade ?? 0.97,
    });
  }
  tube(B, nk, { radial: D.radialBody, ao: 0.5, capStart: false, capEnd: false });

  // A collar. Two rings straddling one neck station, grown a few percent so it
  // stands proud of the throat, riding the same bones the neck does so it does
  // not slide off when the head goes down to sniff. The `horn` mix channel
  // carries it — nothing else on a dog uses that channel, so the leather is a
  // per-variant colour for free.
  if (P.collar) {
    const C = P.collar;
    const f = clamp01(C.t) * (nk.length - 1);
    const ci = Math.min(nk.length - 2, Math.floor(f));
    const ct = f - ci;
    const a = nk[ci], b = nk[ci + 1];
    const cy = lerp(a.y, b.y, ct), cz = lerp(a.z, b.z, ct);
    const dy = b.y - a.y, dz = b.z - a.z;
    const dl = Math.hypot(dy, dz) || 1;
    const hw = (C.len ?? 0.03) * 0.5;
    const g = C.grow ?? 1.10;
    const cst = [];
    for (const s of [-1, 1]) {
      cst.push({
        x: 0, y: cy + (dy / dl) * hw * s, z: cz + (dz / dl) * hw * s,
        rx: lerp(a.rx, b.rx, ct) * g, ry: lerp(a.ry, b.ry, ct) * g, k: 0.95,
        bone: a.bone, bone2: a.bone2, w2: a.w2,
        mix: MIX.horn, shade: 0.86,
      });
    }
    tube(B, cst, { radial: D.radialBody, ao: 0.4, capStart: false, capEnd: false });
  }

  // Head + muzzle.
  const hd = S.at('head', new THREE.Vector3());
  const iHead = S.idx('head');
  const hProf = smoothStations(P.headProfile.map((p) => ({
    dy: p.dy, dz: p.dz, rx: p.rx, ry: p.ry, k: p.k ?? 0.9,
    mix: p.mix ?? MIX.coat, shade: p.shade ?? 1,
  })), D.smooth);
  const hs = hProf.map((p) => ({
    x: 0, y: hd.y + p.dy, z: hd.z + p.dz, rx: p.rx, ry: p.ry, k: p.k,
    bone: iHead, mix: p.mix, shade: p.shade,
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
      // Default: pale at the base, dark rim at the tip. A species whose ear is
      // its signature can say otherwise — the dog's are big dark-backed
      // triangles and are most of what makes it read as that dog.
      const eBase = e.mixBase ?? mixLerp(MIX.coat, MIX.pale, 0.25);
      const eTip = e.mixTip ?? MIX.dark;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        st.push({
          x: ep.x + side * e.dir[0] * e.len * t,
          y: ep.y + e.dir[1] * e.len * t,
          z: ep.z + e.dir[2] * e.len * t,
          rx: lerp(e.w, e.w * 0.45, t) * (1 - t * t * 0.5),
          ry: lerp(e.h, e.h * 0.7, t),
          bone: eb,
          mix: e.mixBase || e.mixTip ? mixLerp(eBase, eTip, t) : (t > 0.6 ? eTip : eBase),
          shade: 0.92,
        });
      }
      tube(B, st, { radial: D.radialTrim, ao: 0.3, tipEnd: true });
    }
  }

  // ── a face ────────────────────────────────────────────────────────────────
  //
  // Every other animal in this game is deliberately faceless, and that is the
  // right call for them: the median closest approach to a deer is 77 m, where
  // an eye is a fraction of a pixel, and geometry nobody can resolve is
  // geometry that only costs. The camp dog is the exception the rule implies —
  // it lies three metres from the player across a fire, at the one moment the
  // game asks them to sit still and look at something. A blank muzzle at that
  // range reads as a mannequin.
  //
  // So: eyes and a nose, on any blueprint that asks for them, and none of the
  // wild cast does.
  if (P.eye) {
    const E = P.eye;
    for (const side of [-1, 1]) {
      // A short outward-pointing loft — small, big, small — which is a ball
      // that costs three rings. Set proud of the skull so it catches the fire.
      const ex = side * E.at[0], ey = hd.y + E.at[1], ez = hd.z + E.at[2];
      const st = [];
      for (const [t, s] of [[-1, 0.34], [0, 1], [0.85, 0.42]]) {
        st.push({
          x: ex + side * E.r * t * 0.9, y: ey, z: ez,
          rx: E.r * s * 0.75, ry: (E.ry ?? E.r) * s,
          bone: iHead, mix: E.mix ?? MIX.dark, shade: E.shade ?? 0.66,
        });
      }
      tube(B, st, { radial: Math.max(5, D.radialBody - 3), ao: 0.25, k: 0.9 });
    }
  }
  // The nose pad. A dog's nose is a wet black bulb wider than the muzzle it
  // sits on, not a point — `muzzleTip` collapses the profile to one and that is
  // right for a deer's tapered nose and wrong here.
  if (P.nose) {
    const N = P.nose;
    const nx = hd.z + N.at[1];
    // An optional patch of the fifth colour on one side of the nose. `spot` is
    // evaluated per ring vertex, so the marking is painted onto the existing
    // tube by angle rather than being a second piece of geometry stuck on —
    // which is what keeps a 2 cm detail from costing a draw call's worth of
    // rings and lets it wrap the curve properly.
    const sp = N.spot;
    const spotFn = sp ? (a, ca) => {
      // `ca` is cos of the ring angle, which is the +X component: negative is
      // the dog's own left. Feathered so it reads as a patch of skin and not a
      // decal.
      const side = sp.side < 0 ? -ca : ca;
      return clamp01((side - (1 - (sp.size ?? 0.34))) / (sp.feather ?? 0.22));
    } : 0;
    const st = [];
    // Ring weights taper the patch along the muzzle as well as around it, so it
    // is a spot rather than a stripe down one side.
    for (const [dz, s, w] of [[-N.r * 0.8, 0.55, 0], [0, 1, 1], [N.r * 0.75, 0.5, 0.30]]) {
      st.push({
        x: 0, y: hd.y + N.at[0], z: nx + dz,
        rx: N.r * s, ry: N.r * (N.flat ?? 0.86) * s,
        bone: iHead, mix: MIX.dark, shade: 0.70,
        spot: sp && w ? (a, ca, sa) => spotFn(a, ca, sa) * w : 0,
      });
    }
    tube(B, st, { radial: Math.max(6, D.radialBody - 2), ao: 0.3, k: 0.85 });
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
  tube(B, tSt, { radial: D.radialTrim, ao: 0.35, tipEnd: true, capStart: false });

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
  // The neck is long, and that length is load-bearing: the muzzle has to reach
  // the grass. The first pass spanned 0.33 m between the withers and the poll,
  // so a "grazing" deer could only lower its head a third of the way and stood
  // with its chin folded into its own chest, reading as decapitated.
  neck: [[0, 1.21, 0.44], [0, 1.47, 0.58]],
  head: [0, 1.61, 0.65],
  rumpTip: false,
  barrel: [
    // Rounded off, not tipped. Collapsing this ring to a point and painting it
    // pale hung a bright cone off the back of every deer.
    { z: -0.62, y: 1.00, rx: 0.118, ry: 0.140 },
    { z: -0.55, y: 1.02, rx: 0.170, ry: 0.190, key: 1 },
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
  // The whitetail scut patch, low and small.
  rump: [
    { z: -0.48, y: 0.955, rx: 0.088, ry: 0.062 },
    { z: -0.60, y: 0.985, rx: 0.072, ry: 0.052 },
  ],
  // A deer's neck is a wedge, thick where it leaves the chest and only
  // slightly narrower at the skull. Tapering it to a stalk is what turned the
  // first pass into a camelid — but so does making it a column, which is what
  // the over-thick version read as at three metres.
  neckProfile: [
    { rx: 0.126, ry: 0.158 },
    { rx: 0.104, ry: 0.126 },
    { rx: 0.082, ry: 0.096 },
    { rx: 0.070, ry: 0.080 },
  ],
  // The skull has to be a mass of its own — narrower than the neck it sits on
  // and the animal reads as a llama however good the body is.
  headProfile: [
    { dy: -0.008, dz: -0.098, rx: 0.074, ry: 0.080 },
    { dy: 0.002, dz: -0.016, rx: 0.090, ry: 0.100 },
    { dy: -0.010, dz: 0.070, rx: 0.062, ry: 0.066 },
    { dy: -0.034, dz: 0.152, rx: 0.046, ry: 0.047, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.052, dz: 0.198, rx: 0.038, ry: 0.036, mix: MIX.dark },
  ],
  // A wafer-thin ear vanishes from every angle except dead side-on, which is
  // the one angle the player is least often at. Cupped, so it survives being
  // eight pixels of silhouette on top of the skull.
  ear: { at: [0.070, 0.054, -0.030], dir: [0.60, 0.75, -0.28], len: 0.185, w: 0.062, h: 0.040 },
  // The white scut is a deer's signature at any distance, so it is a broad flat
  // paddle rather than a thin rope — it has to catch light when it lifts.
  // Hangs, rather than sticking out behind. A level tail on a calm animal reads
  // as a spike welded to the rump; the whole point of the scut is that it is
  // *down* until the animal is frightened, and then suddenly up.
  // Long enough that raising it clears the rump. At 0.21 m the flag stood up
  // and stayed hidden behind the animal's own backside, which is worse than
  // not flagging at all — the motion is there and the signal is not.
  tail: [[0, 1.00, -0.66], [0, 0.88, -0.72], [0, 0.72, -0.78]],
  // Broad enough to read as a flag at a hundred metres. A thin rope of a tail
  // flashes nothing, and the flash is the only signal a fleeing deer gives.
  tailR: [0.052, 0.082], tailFlat: 0.38,
  tailMix: mixLerp(MIX.coat, MIX.pale, 0.28), tailTipMix: MIX.pale,
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
  // Two neck bones, not one. The animator solves the neck as a two-link chain
  // and silently disables the whole head — graze, look, alert, the lot — when a
  // species has fewer, which is why the bear and the rabbit shipped with skulls
  // welded to their shoulders.
  neck: [[0, 0.875, 0.60], [0, 0.825, 0.78]],
  head: [0, 0.735, 0.95],
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
    { rx: 0.212, ry: 0.230 },
    { rx: 0.184, ry: 0.192 },
    { rx: 0.148, ry: 0.148 },
    { rx: 0.118, ry: 0.114 },
  ],
  headProfile: [
    { dy: 0.014, dz: -0.096, rx: 0.100, ry: 0.104 },
    { dy: 0.006, dz: 0.014, rx: 0.122, ry: 0.118 },
    { dy: -0.020, dz: 0.090, rx: 0.083, ry: 0.078, mix: mixLerp(MIX.coat, MIX.pale, 0.40) },
    { dy: -0.036, dz: 0.170, rx: 0.062, ry: 0.058, mix: mixLerp(MIX.coat, MIX.pale, 0.55) },
    { dy: -0.046, dz: 0.210, rx: 0.050, ry: 0.044, mix: MIX.dark },
  ],
  // A bear's ears are its second silhouette cue after the hump: round, set wide
  // and well back on a low skull. Read as a black shape they are the difference
  // between a bear and a boar.
  ear: { at: [0.100, 0.104, -0.078], dir: [0.42, 0.86, -0.28], len: 0.108, w: 0.074, h: 0.052 },
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
  // Two bones, even though a rabbit has barely any neck at all — see the note
  // on the bear. Without the second one nothing on the head ever moves.
  neck: [[0, 0.180, 0.086], [0, 0.190, 0.108]],
  head: [0, 0.198, 0.132],
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
    { dy: 0.000, dz: -0.048, rx: 0.046, ry: 0.048 },
    { dy: 0.003, dz: 0.004, rx: 0.052, ry: 0.053 },
    { dy: -0.012, dz: 0.042, rx: 0.037, ry: 0.036 },
    { dy: -0.026, dz: 0.072, rx: 0.026, ry: 0.024, mix: MIX.dark },
  ],
  // Ears are the whole identity at fifteen metres, so they are generous.
  // Spread into a clear V — from most angles two overlapping vertical ears
  // read as one, and the V is the whole silhouette cue at fifteen metres.
  ear: { at: [0.036, 0.034, -0.014], dir: [0.28, 0.950, -0.13], len: 0.195, w: 0.044, h: 0.028 },
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

// Dog. The camp dog, drawn from reference-art/dog: a lean medium mongrel with
// a deep chest, a hard tuck-up behind the ribs, long clean legs, a sickle tail
// and — the thing that actually identifies it — enormous upright triangular
// ears with dark backs.
//
// It is the closest animal in the game to the camera, which changes what the
// numbers are for. A deer is tuned for a silhouette at 77 m; this one is tuned
// for three metres across a fire, so the muzzle, the stop, the tuck-up and the
// collar all have to survive being looked at directly.
const DOG = () => ({
  key: 'dog',
  // ── the one measurement that matters ──────────────────────────────────────
  //
  // Body length (point of shoulder to point of buttock) over withers height is
  // 0.88 on the reference dog, measured off `standing.png`. The first cut of
  // this blueprint came out at 1.08 — a fifth too long — and the effect was
  // not "a slightly long dog", it was a deer: chest depth and ground clearance
  // were already right, so the extra length had nowhere to go but the topline,
  // and a long level back on tall legs is a cervid whatever the head says.
  // Every z below is that correction; the heights are untouched.
  pelvis: [0, 0.415, -0.165],
  spine: [[0, 0.425, -0.052], [0, 0.428, 0.070]],
  chest: [0, 0.432, 0.175],
  // Carried at about 40° off horizontal, the way a standing dog holds it. Long
  // enough that the head can reach the ground to sniff without the throat
  // folding into the chest — the same trap the deer's neck was written around.
  // Steep. A dog carries its head clearly ABOVE the topline, and the first cut
  // of this rose at 40° which put the skull level with the withers — the whole
  // animal then read as one long horizontal mass with a nose on the front,
  // which is a weasel, not a dog. At 54° the head sits up where it belongs and
  // the body stops looking twice as long as it is.
  // Short. This dog's neck is a thick wedge that flows out of the shoulder over
  // a very small distance — the second reference photo (in the creek) shows it
  // clearly, and the previous 0.26 m span read as a lurcher's.
  neck: [[0, 0.492, 0.218], [0, 0.560, 0.266]],
  head: [0, 0.605, 0.298],
  rumpTip: false,
  barrel: [
    // The croup falls away to the tail root rather than ending square. Without
    // the slope the back is a plank from the shoulder to the backside.
    { z: -0.252, y: 0.393, rx: 0.058, ry: 0.064 },
    // The haunch. A dog's widest point behind the ribs, and what stops the
    // back half reading as a tube.
    { z: -0.204, y: 0.412, rx: 0.101, ry: 0.104, key: 1 },
    // The tuck-up: waisted, and shallower than anything either side of it.
    // This one station is most of what separates a dog from a small deer.
    { z: -0.087, y: 0.428, rx: 0.084, ry: 0.098, key: 1 },
    { z: 0.017, y: 0.420, rx: 0.094, ry: 0.127 },
    // The brisket, deepest just behind the elbow and laterally compressed —
    // a dog's chest is an oval standing on its end, not a barrel.
    { z: 0.113, y: 0.412, rx: 0.099, ry: 0.146, key: 1 },
    { z: 0.204, y: 0.424, rx: 0.096, ry: 0.134 },
    { z: 0.270, y: 0.432, rx: 0.066, ry: 0.096, key: 1 },
  ],
  // Cream from the brisket back along the belly, which is where the reference
  // dog's tan stops.
  belly: [
    { z: -0.139, y: 0.330, rx: 0.056, ry: 0.026 },
    { z: 0.00, y: 0.312, rx: 0.066, ry: 0.030 },
    { z: 0.139, y: 0.296, rx: 0.064, ry: 0.030 },
  ],
  // Thick where it leaves the chest — a dog's neck flows out of the shoulder
  // rather than being socketed into it, and a narrow first station left a
  // visible step at the withers.
  neckProfile: [
    { rx: 0.086, ry: 0.100 },
    { rx: 0.070, ry: 0.080 },
    { rx: 0.056, ry: 0.060 },
    { rx: 0.047, ry: 0.049 },
  ],
  // The skull: a broad cranium, a real stop, and a muzzle that stays square
  // rather than tapering to a deer's point. Bigger than the first cut all
  // round — a dog's head is a large fraction of it, and a small one on this
  // neck read as a whippet.
  // DEEP, not wide. A dog's head in profile is a tall wedge — a deep skull over
  // a deep muzzle with real jaw under it — and the first cut had the right plan
  // view and half the height, which read as a squashed weasel. Every `ry` here
  // is about 25% up on its `rx`; widening instead would have made it a toad.
  headProfile: [
    { dy: -0.006, dz: -0.056, rx: 0.048, ry: 0.061 },
    { dy: 0.008, dz: -0.014, rx: 0.058, ry: 0.071 },
    // The stop — a distinct narrowing where the skull gives way to the muzzle.
    { dy: -0.010, dz: 0.030, rx: 0.040, ry: 0.055 },
    // Blunt. A dog's muzzle is a squared-off box, and tapering it those last
    // two centimetres is the whole difference between this and a fox.
    { dy: -0.030, dz: 0.072, rx: 0.033, ry: 0.041, mix: mixLerp(MIX.coat, MIX.pale, 0.72) },
    { dy: -0.042, dz: 0.106, rx: 0.029, ry: 0.033, mix: mixLerp(MIX.coat, MIX.pale, 0.80) },
  ],
  // The nose is its own bulb rather than the muzzle tapering to a point — see
  // the note in buildQuadruped. Dark brown eyes set just behind the stop.
  muzzleTip: false,
  // Taller with the rest of the head, and carrying the pink patch on the dog's
  // own LEFT — the fifth colour, see `uSpot`. It is a real marking on the real
  // dog, and the one thing on this model that is a portrait rather than a breed.
  nose: { at: [-0.048, 0.117], r: 0.021, flat: 0.95, spot: { side: -1, size: 0.34, feather: 0.22 } },
  // Sat ON the skull, not in it. The first placement put the centre at 0.72 of
  // the cranium's own ellipse, so the entire ball was interior and the dog had
  // no eyes at all — the loft is only a few millimetres across and there is no
  // margin for being approximately right.
  eye: { at: [0.043, 0.016, 0.019], r: 0.0128, ry: 0.0106, shade: 0.58 },
  // Big, upright, set wide and carried a little FORWARD, with dark backs.
  // Authored base-to-tip rather than with the default pale/dark split: on this
  // dog the whole ear is dark against a pale skull, and that contrast IS the
  // animal. The first cut leaned them back at -0.14 z and they read as fins off
  // the back of the neck.
  ear: {
    at: [0.034, 0.040, -0.008], dir: [0.28, 0.94, 0.17],
    len: 0.126, w: 0.049, h: 0.028,
    mixBase: mixLerp(MIX.coat, MIX.dark, 0.35), mixTip: MIX.dark,
  },
  collar: { t: 0.60, grow: 1.13, len: 0.030 },
  // A sickle: thick at the root, tapering, hanging down off a sloped croup and
  // hooking up at the tip. Long — the first cut was a 0.29 m stub that read as
  // a docked tail, and the hook is the whole shape.
  tail: [[0, 0.383, -0.257], [0, 0.316, -0.330], [0, 0.274, -0.404], [0, 0.290, -0.470]],
  tailR: [0.026, 0.010], tailFlat: 1,
  tailMix: MIX.coat, tailTipMix: mixLerp(MIX.coat, MIX.pale, 0.55),
  // A dog's hind leg is heavily angulated — a big thigh, the stifle carried
  // well forward and the hock well back — and that Z shape is most of what
  // reads as "dog" from behind. `rTop` is deliberately more than twice `rMid`:
  // the thigh is a mass, the second link is a shin.
  // Thicker than the first cut all the way down, which had the leg radii
  // carried over from the deer's and made a dog on knitting needles. A dog
  // carries real muscle to the hock and a real pastern below it; the taper
  // still runs top to bottom, it just starts and ends heavier.
  hind: {
    tag: 'hind', front: false, bend: 1,
    hip: [0.062, 0.410, -0.170], knee: [0, -0.148, 0.058], hock: [0, -0.120, -0.080], foot: [0, -0.136, 0.026],
    rTop: 0.094, rMid: 0.042, rLow: 0.027, rFoot: 0.022, flat: 0.86,
    hoofH: 0.021, hoofR: 0.027, hoofLong: 1.8, hoofFwd: 0.016, sockTop: 0.34,
  },
  fore: {
    tag: 'fore', front: true, bend: -1,
    hip: [0.058, 0.430, 0.165], knee: [0, -0.158, -0.038], hock: [0, -0.130, 0.040], foot: [0, -0.138, 0.0],
    rTop: 0.078, rMid: 0.040, rLow: 0.026, rFoot: 0.022, flat: 0.88,
    hoofH: 0.021, hoofR: 0.026, hoofLong: 1.7, hoofFwd: 0.014, sockTop: 0.34,
  },
});

// The camp dog is NOT in `SPECIES`, and that is load-bearing rather than
// tidiness. `Wildlife` iterates `Object.keys(SPECIES)` to build prototypes, to
// size its mesh pool and to scatter home sites across the valley — so a dog in
// that table would be a wild animal living on the forest edge, and would also
// read `CFG.dog` and find nothing. The dog belongs to a camp; `src/camp/
// camp_dog.js` owns when one exists.
export const DOG_SPECIES = {
  key: 'dog',
  variants: [
    // The reference dog, and the common one.
    { name: 'tan', scale: 1.00, weight: 0.60,
      col: { coat: 0xa9754a, pale: 0xd7c7ae, dark: 0x2e2018, horn: 0x8a5a2e } },
    // Two litter-mates, so a second camp is not the same dog again. Same build,
    // different wash — a paler cream one and a darker red one.
    { name: 'cream', scale: 0.96, weight: 0.22,
      col: { coat: 0xbe9463, pale: 0xded2bc, dark: 0x33261b, horn: 0x7d5430 } },
    { name: 'red', scale: 1.04, weight: 0.18,
      col: { coat: 0x8e5730, pale: 0xc4b096, dark: 0x261a12, horn: 0x6f4526 } },
  ],
  blueprint: DOG,
  // A dog at camp trots and mills; it is never fleeing anything. `run` is here
  // because the gait ladder needs a third rung, not because it is ever used.
  gait: {
    walk: 0.95, trot: 2.6, run: 6.5,
    strideBase: 0.62, strideGain: 2.4, dutyWalk: 0.62, dutyTrot: 0.50, dutyRun: 0.32,
    bobAmp: 0.020, pitchAmp: 0.038, liftScale: 1.05,
    grazeAng: 1.32, grazeRake: 1.40,
  },
};

/** The camp dog's prototypes — same builder, kept out of the wild table. */
export function buildCampDog(seed) {
  return buildVariants(DOG_SPECIES, 'dog', seed);
}

// Antlers only exist on the stag variant, so they are grafted on rather than
// living in the base blueprint.
// Heavier than life. A real beam is 4 cm across at the burr, which at the size
// a stag occupies on screen is a scratch; the rack has to survive being eight
// pixels of silhouette, so it is thickened and shortened until it reads as a
// mass rather than as a pair of twigs.
const STAG_ANTLER = {
  base: [0.052, 0.058, -0.038],
  out: 0.46, up: 0.82, back: -0.32,
  len: 0.40, r0: 0.028, r1: 0.012, tineEvery: 2,
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
        col: { coat: 0x734e34, pale: 0xb5a184, dark: 0x3c2820, horn: 0x9c8763 } },
      { name: 'yearling', scale: 0.80, antler: false, weight: 0.26,
        col: { coat: 0x845c3b, pale: 0xbdaa88, dark: 0x422d1f, horn: 0x9c8763 } },
      { name: 'stag', scale: 1.10, antler: true, weight: 0.20,
        col: { coat: 0x5b3c22, pale: 0xa39077, dark: 0x30201a, horn: 0xa08c68 } },
      { name: 'dark doe', scale: 0.97, antler: false, weight: 0.08,
        col: { coat: 0x543a29, pale: 0xa39077, dark: 0x2d1f18, horn: 0x9c8763 } },
    ],
    blueprint: DEER,
    // Behaviour numbers live with the species so a tweak is one edit.
    gait: {
      walk: 1.25, trot: 3.4, run: 10.5,
      strideBase: 1.05, strideGain: 2.7, dutyWalk: 0.63, dutyTrot: 0.50, dutyRun: 0.30,
      bobAmp: 0.038, pitchAmp: 0.055, liftScale: 1.0,
      grazeAng: 1.20, grazeRake: 1.25,
    },
    brain: {
      // The freeze is the whole sighting: a deer notices you a long way off,
      // stands and stares for a beat or two, and only then leaves.
      // `noticeDist` is the outer band, and it is a legibility number rather
      // than an ethology one. Measured off-road, the median closest approach a
      // player ever makes to a deer is 77 m; the encounter therefore has to be
      // readable well outside `alertDist`, and a frozen animal is not. From
      // 108 m in (which at 13 m/s means the deer reacts around 123 m of real
      // distance) it is up, broadside and moving. Deliberately short of the
      // 172 m spawn radius: a valley where every deer is already standing to
      // attention when it streams in has no grazing in it, and the head-down
      // pose is half the gift.
      // How far the stand point is walked toward the open side of an edge
      // site. Enough to clear the canopy and put meadow behind the animal
      // instead of shadow; not enough to strand a deer alone in the middle of
      // open ground, which reads as a spawner and throws away the edge
      // habitat the site was chosen for.
      standoff: 6.5,
      alertDist: 62, fleeDist: 28, calmDist: 95, noticeDist: 108,
      freezeTime: [1.0, 2.6], fleeTime: [3.5, 7.0],
      grazeTime: [6, 20], idleTime: [2.5, 7], walkTime: [4, 12],
      herd: [1, 4], herdRadius: 9, wanderRadius: 34,
      grazeChance: 0.55,
    },
  },

  bear: {
    key: 'bear',
    variants: [
      { name: 'boar', scale: 1.08, weight: 0.45,
        col: { coat: 0x2c1d16, pale: 0x6b5340, dark: 0x1a100c, horn: 0xa89a86 } },
      { name: 'sow', scale: 0.96, weight: 0.40,
        col: { coat: 0x34241b, pale: 0x77604a, dark: 0x1d130e, horn: 0xa89a86 } },
      { name: 'cinnamon', scale: 1.00, weight: 0.15,
        col: { coat: 0x4c2e1d, pale: 0x8a6b46, dark: 0x2a1810, horn: 0xa89a86 } },
    ],
    blueprint: BEAR,
    gait: {
      walk: 1.05, trot: 2.6, run: 6.2,
      strideBase: 1.05, strideGain: 2.3, dutyWalk: 0.68, dutyTrot: 0.56, dutyRun: 0.38,
      bobAmp: 0.035, pitchAmp: 0.030, liftScale: 0.72,
      // A bear's nose is already low; it barely has to reach to crop.
      grazeAng: 1.30, grazeRake: 1.45,
    },
    brain: {
      // A bear mostly does not care that you exist. It looks up when you get
      // close, and only leaves if you get closer than that.
      // A bear does not spook, but it does stop and look, and a bear that has
      // stopped and turned side-on is the most legible animal in the game.
      // A bear is big enough to read anyway, and it patrols a river line where
      // the far bank is already the backdrop, so it needs less of a nudge.
      standoff: 4.0,
      alertDist: 24, fleeDist: 11, calmDist: 44, noticeDist: 66,
      freezeTime: [1.4, 3.0], fleeTime: [2.5, 5.0],
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
      strideBase: 0.48, strideGain: 2.5, dutyWalk: 0.55, dutyTrot: 0.45, dutyRun: 0.22,
      bobAmp: 0.014, pitchAmp: 0.05, liftScale: 1.5,
      grazeAng: 1.05, grazeRake: 1.15,
    },
    brain: {
      // A rabbit barely freezes at all — it is gone before you have registered
      // that it was there, which is the opposite beat to the deer's.
      // No `noticeDist`: a 0.25 m animal at 50 m is under three pixels, so the
      // wary-watch beat would cost animation and buy the player nothing. A
      // rabbit's whole legibility is the bolt, and that happens at 26 m.
      // No stand-off: at 0.25 m a rabbit is under three pixels at any range
      // where this would matter, and cover is the whole point of a rabbit.
      standoff: 0,
      alertDist: 36, fleeDist: 26, calmDist: 45,
      freezeTime: [0.15, 0.65], fleeTime: [1.6, 3.4],
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
  return buildVariants(SPECIES[key], key, seed);
}

/**
 * Build every variant of one species definition. Split out of `buildSpecies`
 * so the camp dog can use it without being in the wild `SPECIES` table — see
 * the note on DOG_SPECIES for why it must not be.
 */
function buildVariants(sp, key, seed) {
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

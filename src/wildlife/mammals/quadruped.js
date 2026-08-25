// ─────────────────────────────────────────────────────────────────────────────
//  quadruped — the one builder every mammal in the cast is made by.
//
//  A lofted barrel on a spine, a neck, a head with a muzzle and ears, four
//  three-segment legs and a tail. What separates a deer from a bear is
//  entirely in the numbers, and those live one file over: each species in this
//  folder authors a blueprint and this turns it into geometry, a skeleton and
//  the rig description the gait solver reads.
//
//  Nothing species-specific belongs in here. If a number only one animal uses
//  ends up in this file it is in the wrong place — the stag's antler rack is
//  the worked example, and it lives in `deer.js` as variant data.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mulberry32, lerp, clamp01 } from '../../core/MathUtils.js';
import { RigBuilder, Skel, tube, makePrototype, MIX, mixLerp } from '../animal_rig.js';
import { crom } from '../loft_smooth.js';

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
      // An angular marking (`spot`, see `tube`) is a function of the ring
      // angle, not a scalar, so there is nothing to interpolate — it is
      // carried forward from the station that owns it, which is what makes a
      // marking survive being resampled instead of falling into the gaps
      // between the authored rings.
      if (p1.spot) st.spot = p1.spot;
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
// Ring fractions along one limb segment. Packed toward the ends, where the
// joint seam and the dome cap live. `legRings` subdivides each gap evenly.
const LEG_T_BASE = [0.02, 0.22, 0.55, 0.86, 0.98];
function LEG_T(D) {
  const f = D.legRings ?? 1;
  if (f <= 1) return LEG_T_BASE;
  const out = [];
  for (let i = 0; i < LEG_T_BASE.length - 1; i++) {
    for (let s = 0; s < f; s++) out.push(lerp(LEG_T_BASE[i], LEG_T_BASE[i + 1], s / f));
  }
  out.push(LEG_T_BASE[LEG_T_BASE.length - 1]);
  return out;
}

function buildLeg(B, L, D) {
  const { spec: sp, iU, iL, iC, hip, knee, hock, foot } = L;
  const R = D.radialLimb;

  const seg = (aP, bP, bA, bB, r0, r1, mixA, mixB, shade, opts) => {
    // A short overlap either side of each joint, weighted to both bones, hides
    // the seam without smooth-skinning the whole limb into rubber.
    const st = [];
    for (const t of LEG_T(D)) {
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
    tube(B, st, { radial: R, ao: 0.5, k: sp.k ?? 1, domeSteps: D.domeSteps ?? 2, ...opts });
  };

  const coat = MIX.coat, dark = MIX.dark;
  const sockT = sp.sockTop ?? 0.55;   // where the coat gives way to dark legs
  const midMix = mixLerp(coat, dark, sockT);

  // Every segment top is domed rather than capped flat. Nothing here is a
  // sealed cylinder in practice: the hip rides at the edge of the barrel's
  // silhouette and clears it entirely on a raised or trailing leg, and each
  // joint below bends far enough that the segment's own cap swings out past
  // the one above it — a stifle at a dog's angulation is the worst of them.
  // A flat cap in either place reads as a sawn-off tube; a hemisphere reads as
  // the ball the joint actually is. Joint domes are shallower than the hip's
  // so a bent knee gains a knuckle without growing a bulb.
  const jd = sp.jointDome ?? 0.65;
  seg(hip, knee, iU, iL, sp.rTop, sp.rMid, coat, coat, 0.94, { domeStart: sp.hipDome ?? 0.9 });
  seg(knee, hock, iL, iC, sp.rMid, sp.rLow, coat, midMix, 0.90, { domeStart: jd });
  seg(hock, foot, iC, iC, sp.rLow, sp.rFoot, midMix, dark, 0.86, { domeStart: jd });

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

// The near LOD's radial counts were set by measuring facet width in both
// directions on every mammal and bringing them into line. `smooth: 3` already
// puts barrel rings 17–75 mm apart along the spine, but at `radialBody: 14` the
// facets AROUND the same barrel were 22–123 mm — 1.3–1.6× coarser across the
// whole cast (and 4.3× on the raccoon, whose barrel is authored at 40 rings).
// More authored stations therefore bought nothing but long thin quads; the
// binding direction was circumferential, and these are the numbers that move it.
//
//   part          lever         facet ratio (radial ÷ axial), median of the cast
//   barrel/neck   radialBody    1.45  →  14 × 1.45 ≈ 20
//   head          radialBody    1.22  →  (same lever; 20 overshoots slightly)
//   limbs         radialLimb    limb facets ran 1.0–1.3× the barrel's; 14 puts
//                               them at ≈0.7× — legs are bare tapered cones in
//                               silhouette, so they show polygons first
//   tail/ears     radialTrim    fox brush 28.7 mm, raccoon ringed tail 35.5 mm
//                               at 8 sides → 12 brings both under 24 mm
//
// `domeSteps` is the leg ball joints (hip, stifle, hock) and nothing else — the
// one lever that adds actual roundness to a limb rather than more rings along a
// straight cone. See buildLeg for why ring count there is deliberately fixed.
const DETAIL = [
  // near — rounded: extra radial sides, and `smooth` inserts Catmull-Rom rings
  // between the authored stations. Still flat-shaded and faceted, just with
  // facets small enough to read as a curve instead of as armour plate.
  { radialBody: 20, radialLimb: 14, radialTrim: 12, antlerRadial: 8, antlerLevels: 1, antlerSegs: 7,
    barrelStep: 1, ears: true, smooth: 3, neckRings: 14, domeSteps: 3 },
  // mid — half the rings, four-sided limbs, one antler fork
  { radialBody: 5, radialLimb: 4, radialTrim: 4, antlerRadial: 3, antlerLevels: 1, antlerSegs: 3,
    barrelStep: 2, ears: true, smooth: 1, neckRings: 5, domeSteps: 1 },
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
    mix: p.mix ?? MIX.coat, shade: p.shade ?? 1, spot: p.spot,
  })), D.smooth);
  const hs = hProf.map((p) => ({
    x: 0, y: hd.y + p.dy, z: hd.z + p.dz, rx: p.rx, ry: p.ry, k: p.k,
    // A head station may carry the fifth colour as an angular marking, the
    // same machinery the dog's nose patch uses. It is how the raccoon's mask
    // stops at the crown and the chin instead of being a band right round the
    // skull: `mix` is per RING and cannot vary around one, so a marking that
    // has to be on the SIDES of the face can only be `spot`.
    bone: iHead, mix: p.mix, shade: p.shade, spot: p.spot ?? 0,
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
  // ── a RINGED tail needs more rings than it has bones ──────────────────────
  // Every other tail in the game is one ring per bone carrying one ramp from
  // root colour to tip colour, and that is all a flag or a brush ever needs.
  // A raccoon's tail is the one marking in the cast that is neither: it is a
  // repeating band, and `mix` is a per-vertex attribute resolved per ring, so
  // the number of colour changes a tail can hold is exactly the number of
  // rings it has. Four bones give five rings, which is one and a half rings
  // per band — the bands then alias into a smear and you have shipped a grey
  // tail with a slightly odd gradient, which is the failure this exists to
  // avoid.
  //
  // So `tailBands` decouples the two: the chain is resampled to `tailRings`
  // stations along the same polyline, each ring binds rigidly to the nearest
  // tail bone exactly as an authored one at that point would, and the band
  // list is stepped (not lerped) across them. A band boundary then falls
  // inside one ring gap, which at three rings per band is a hard enough edge
  // to read as a ring rather than as a wave.
  //
  // Absent — every other species — this is bit-identical to what it always
  // was: `tailBands` undefined takes tN back to tPts.length and the ramp back
  // to `tailMix`/`tailTipMix`/`tailMixBias`.
  const bands = P.tailBands;
  const tN = bands ? Math.max(bands.length + 1, Math.round((P.tailRings ?? 24) / (detailLevel ? 2 : 1))) : tPts.length;
  const tSt = [];
  for (let i = 0; i < tN; i++) {
    const t = i / (tN - 1);
    let y, z, bone;
    if (bands) {
      // Where along the bone chain this ring sits, and which bone owns it.
      const f = t * (tPts.length - 1);
      const si = Math.min(tPts.length - 2, Math.floor(f)), sf = f - si;
      y = lerp(tPts[si].y, tPts[si + 1].y, sf);
      z = lerp(tPts[si].z, tPts[si + 1].z, sf);
      const bi = Math.min(tPts.length - 1, Math.round(f));
      bone = bi === 0 ? S.idx('pelvis') : S.idx(tailNames[bi - 1]);
    } else {
      y = tPts[i].y; z = tPts[i].z;
      bone = i === 0 ? S.idx('pelvis') : S.idx(tailNames[Math.min(tailNames.length - 1, i - 1)]);
    }
    tSt.push({
      x: 0, y, z,
      rx: lerp(P.tailR[0], P.tailR[1], t), ry: lerp(P.tailR[0], P.tailR[1], t) * (P.tailFlat ?? 1),
      bone,
      // Dark at the root, pale at the tip. A deer's alarm flag is the white
      // underside flashing as the tail comes up, and a uniformly pale tail is
      // just a bright smudge on the rump the rest of the time.
      // `tailMixBias` curves the ramp: at 1 (default) the blend is linear and
      // half the tail is half pale, which is right for a deer's flag and wrong
      // for a fox's brush, where the white is a TIP — the coat has to hold to
      // the last third and then turn.
      mix: bands
        ? bands[Math.min(bands.length - 1, Math.floor(t * bands.length))]
        : mixLerp(P.tailMix ?? MIX.coat, P.tailTipMix ?? P.tailMix ?? MIX.coat,
          Math.pow(t, P.tailMixBias ?? 1)),
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

// ── prototypes ───────────────────────────────────────────────────────────────

/**
 * Build every variant of one species definition. Each variant gets a near and
 * a mid geometry sharing one skeleton description.
 *
 * Takes the definition rather than a key into `SPECIES` so the camp dog can
 * use it without being in that table — see the note over DOG_SPECIES in
 * `dog.js` for why it must not be.
 */
export function buildVariants(sp, key, seed) {
  const protos = [];
  for (let vi = 0; vi < sp.variants.length; vi++) {
    const v = sp.variants[vi];
    const P = sp.blueprint();
    // A variant may name a rack; the blueprint never carries one, because only
    // one variant of one species has antlers. See STAG_ANTLER in `deer.js`.
    if (v.antler) P.antler = v.antler;
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

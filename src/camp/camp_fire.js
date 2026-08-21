// ─────────────────────────────────────────────────────────────────────────────
//  camp_fire — the fire pit: stone ring, burning logs, flame, embers, smoke,
//  and the light the whole camp is lit by after sundown.
//
//  This is the one prop in the camp that is not judged as a prop. Every other
//  object in the clearing is judged partly on how it looks lit by this, and the
//  emotional payload of the feature is one warm point in a cold valley — so the
//  flame, the ember bed and the point light are authored together against three
//  hours (midday, 20:24, 23:00) rather than against one.
//
//  ── why the flame is not crossed billboards ─────────────────────────────────
//
//  The placeholder was three additive cards on a shared Y rotation, and it
//  failed in exactly the two ways that trick always fails: it read as a sprite
//  the moment the camera walked around it (the cards counter-rotate, so the
//  silhouette is frozen relative to the viewer and the flame appears to follow
//  you), and its brightness was a single number, so at midday it was a white
//  blob and at midnight it was the same white blob.
//
//  What is here instead is a **nested additive shell volume**. Three low-poly
//  lathes — outer, body, core — share one draw call, are displaced in the
//  vertex shader by scrolling 3D value noise, and are shaded by an inverse
//  fresnel (`pow(|dot(N,V)|, k)`) so each shell is brightest where you are
//  looking through the most of it and falls to nothing at its own silhouette.
//  Three consequences, all of them the point:
//
//   · the core/body/tip structure is *geometric*, not a gradient painted on a
//     card. Down the axis you accumulate all three shells and get a near-white
//     core; a centimetre outside the core shell you accumulate two and get
//     amber; outside the body shell you accumulate one and get a translucent
//     orange edge. It looks right from every azimuth because it *is* right
//     from every azimuth.
//   · the noise is sampled in the flame's own object space, so walking around
//     it reveals a different silhouette rather than the same one re-projected.
//     `--turntable fire` is six azimuths of the same instant and they are six
//     different shapes.
//   · two constriction waves travel up the column at incommensurable rates and
//     pinch the radius as they pass, which is what makes the silhouette *change
//     shape* rather than scale. A flame that only breathes in and out is a
//     lamp.
//
//  The base ring of every shell sits 35 mm BELOW the ash surface. That is not a
//  detail: an additive volume with an open bottom has a hard horizontal cut
//  where the geometry ends, and burying the cut under an opaque mesh is what
//  makes the flame *sit on* the fuel instead of hovering over it. Depth test is
//  on and depth write is off, so the ash bed clips it for free.
//
//  ── why the brightness moves with the sun ───────────────────────────────────
//
//  The post chain thresholds bloom in LINEAR light and moves the threshold with
//  sun elevation: 1.05 with the sun high, 0.72 at the horizon, 1.70 at night
//  (see the glare ramp in PostFX.js). A flame authored at one radiance is
//  therefore *three different pictures*: at a fixed 2.0 linear it is 1.9x the
//  midday threshold — a featureless white disc, which is precisely what the
//  placeholder did — and only 1.2x the night threshold, which is a dull ember.
//  So `uGain` rides sun elevation and holds the flame at a roughly constant
//  multiple of the threshold it is actually being bloomed against. It reads as
//  fire at noon and owns the frame at midnight, and neither is an accident.
//
//  ── API contract (Camp.js depends on exactly this) ──────────────────────────
//    new Firepit(scene, rnd, opts) -> { group, light, update(dt,t,camera),
//                                       setReveal(k), setPosition(v3), dispose() }
//    buildWoodpile(rnd, opts) -> THREE.Group
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, at, tintFrom, tintMul, dusted, sanitizeNormals, M,
} from './camp_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const TAU = Math.PI * 2;

// Neutral tuning. `window.__fireTune` may override any field at runtime; that
// is how tools/_scratch/firesweep.mjs shoots a parameter ladder in one page
// load instead of one capture-pool slot per guess.
const FIRE_TUNE = { gain: 1, light: 1, bed: 1, ember: 1, smoke: 1, knee: 1, elev: NaN };

// ─────────────────────────────────────────────────────────────────────────────
//  Time of day
//
//  Read defensively off the published lighting singleton. The fire has to build
//  and run in the harness, in a unit test, and before Lighting has had a frame,
//  so every path here has to survive `window.__lighting` being absent.
//
//  Sun *elevation* is the discriminator rather than the hour, for the same
//  reason PostFX uses it: the glare ramp, the exposure ramp and the night ramp
//  are all keyed off elevation, so keying the fire off the hour would put the
//  fire's knee in a different place from the bloom's knee, and the two would
//  drift apart on any change to the arc.
// ─────────────────────────────────────────────────────────────────────────────
function sunElevation() {
  const L = (typeof window !== 'undefined') ? window.__lighting : null;
  const e = L?.sunDir?.y;
  if (Number.isFinite(e)) return e;
  // No lighting yet — derive a plausible elevation from the hour, and failing
  // that assume the game's default late afternoon.
  const h = Number.isFinite(L?.hour) ? L.hour : 16.6;
  return Math.sin(((h - 6.2) / 12.6) * Math.PI) * 0.92;
}

/** 0 with the sun high, 1 at the horizon. */
const duskAmount = (e) => smoothstep(0.34, 0.015, e);
/** 0 at the horizon, 1 once it is properly night. */
const nightAmount = (e) => smoothstep(-0.01, -0.17, e);

/** The prevailing wind, as (x, z). Same sources Camp.js consults, same fallback. */
function windXZ(out) {
  const s = (typeof window !== 'undefined') ? window.__systems : null;
  const w = s?.weather?.windDir ?? s?.grass?.windDir;
  if (w && Number.isFinite(w.x) && Number.isFinite(w.y)) out.set(w.x, w.y);
  else out.set(0.86, 0.51);
  const l = out.length();
  if (l > 1e-4) out.divideScalar(l); else out.set(1, 0);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared GLSL — 3D value noise
//
//  One hash, one lerp cube, used by the flame shells and by the smoke. It is
//  the cheapest noise that still gives a *shape* rather than a wobble: gradient
//  noise would be smoother but the flame wants the slightly cellular look that
//  value noise's flat cell interiors give it.
// ─────────────────────────────────────────────────────────────────────────────
const NOISE_GLSL = /* glsl */`
  float fHash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float fNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(fHash31(i + vec3(0.0, 0.0, 0.0)), fHash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(fHash31(i + vec3(0.0, 1.0, 0.0)), fHash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(fHash31(i + vec3(0.0, 0.0, 1.0)), fHash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(fHash31(i + vec3(0.0, 1.0, 1.0)), fHash31(i + vec3(1.0, 1.1, 1.0)), f.x), f.y), f.z);
  }`;

// ─────────────────────────────────────────────────────────────────────────────
//  The flame
// ─────────────────────────────────────────────────────────────────────────────
const FLAME_VERT = /* glsl */`
  attribute float aV;        // 0 at the fuel, 1 at the tip
  attribute float aShell;    // 0 outer, 1 body, 2 core
  attribute vec3  aTint;     // this shell's own colour at the base
  attribute float aWeight;   // this shell's radiance weight
  attribute float aSeed;

  uniform float uTime;
  uniform float uAmp;
  uniform float uSway;
  uniform float uPinch;
  uniform vec2  uWind;
  uniform float uReveal;

  varying float vV;
  varying vec3  vTint;
  varying float vW;
  varying float vFlick;
  varying vec3  vN;
  varying vec3  vView;

  ${NOISE_GLSL}

  void main() {
    float v = aV;
    vV = v;
    vTint = aTint;

    // ── the travelling constrictions ────────────────────────────────────────
    // Two gaussian necks running up the column at 0.29 and 0.41 Hz. Where one
    // passes, the radius pinches; when it runs off the top the tip appears to
    // detach and go out, which is the single most flame-like thing a shape can
    // do and is impossible with a scaling billboard. Held off the bottom 12% so
    // the flame never lifts off its own base.
    float base = smoothstep(0.02, 0.16, v);
    float d1 = v - fract(uTime * 0.29 + aShell * 0.21);
    float d2 = v - fract(uTime * 0.41 + 0.37 + aShell * 0.13);
    float pinch = 1.0
      - uPinch * base * exp(-d1 * d1 * 34.0)
      - uPinch * 0.62 * base * exp(-d2 * d2 * 58.0);

    // ── the noise ───────────────────────────────────────────────────────────
    // Sampled in object space so it is the flame that has a shape, not the
    // screen. The y term scrolls downward through the field, which moves the
    // pattern *up* the flame.
    vec3 np = position * 7.4;
    np.y -= uTime * 1.15;
    np += aShell * 9.7 + aSeed * 0.6;
    float n1 = fNoise(np) - 0.5;
    float n2 = fNoise(np * 2.35 + 4.1) - 0.5;
    float n = n1 + n2 * 0.42;

    float amp = uAmp * smoothstep(0.0, 0.30, v) * (0.55 + 0.85 * v);
    float rr = max(0.12, 1.0 + n * amp) * max(0.10, pinch);

    // ── the sway ────────────────────────────────────────────────────────────
    // The column wanders and leans downwind, quadratically with height so the
    // base stays welded to the fuel. Slow: 0.13 and 0.10 Hz. This is the term
    // that decides whether the fire is calm or frantic and it is deliberately
    // at the bottom of the range a real flame moves at.
    float sw = v * v;
    vec2 sway = vec2(sin(uTime * 0.83 + aSeed * 3.1), cos(uTime * 0.61 + 0.4)) * uSway * sw
              + uWind * (0.052 * sw);

    // ── height breathing ────────────────────────────────────────────────────
    // Secondary to the noise and the pinch, and per-shell out of phase so the
    // three do not grow together (which would read as one object scaling).
    float grow = 1.0 + 0.13 * sin(uTime * 0.77 + aShell * 2.1)
                     + 0.08 * sin(uTime * 1.19 + aShell * 0.7);
    grow *= mix(0.34, 1.0, uReveal);

    vec3 p;
    p.xz = position.xz * rr + sway;
    p.y = position.y * grow;

    // Brightness varies over the body, not as one global pulse: the hot spots
    // travel up with the noise field.
    vFlick = 0.72 + 0.55 * (n1 + 0.5);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = -mv.xyz;
    vN = normalMatrix * normal;
    vW = aWeight;
    gl_Position = projectionMatrix * mv;
  }`;

const FLAME_FRAG = /* glsl */`
  uniform float uGain;
  uniform vec3  uTipCol;
  uniform float uEdgePow;
  uniform float uFlicker;
  uniform float uKnee;
  uniform vec2  uChroma;

  varying float vV;
  varying vec3  vTint;
  varying float vW;
  varying float vFlick;
  varying vec3  vN;
  varying vec3  vView;

  void main() {
    // Guarded normalises. A zero-length normal here is a NaN in the HDR buffer
    // and the bloom pyramid turns one NaN into a black square hundreds of
    // pixels across — the failure autopsied in CamperModel.js.
    float ln = length(vN);
    vec3 N = ln > 1e-5 ? vN / ln : vec3(0.0, 0.0, 1.0);
    float lv = length(vView);
    vec3 V = lv > 1e-5 ? vView / lv : vec3(0.0, 0.0, 1.0);

    // Inverse fresnel: this shell is thickest along the view ray where it faces
    // you and vanishes at its own silhouette. Nested, the three shells sum to a
    // soft-edged volume with a hot centre.
    float depth = pow(clamp(abs(dot(N, V)), 0.0, 1.0), uEdgePow);

    // Tip: cooler, redder, and gone by the very top.
    //
    // The vertical shaping is the difference between a plume and a glowing
    // lump. The first pass rolled the brightness off from a quarter of the way
    // up and the flame's whole read was the bottom 30% — from behind the fuel
    // it was a pale smear with no silhouette at all. Full radiance now holds
    // to the halfway mark and only then tapers, which is where the visible
    // 0.35-0.5 m of flame comes from.
    float tipK = smoothstep(0.10, 0.94, vV);
    vec3 col = mix(vTint, uTipCol, tipK * 0.80);
    // ── how a fire wins in daylight ─────────────────────────────────────────
    // It cannot out-brighten the sun, so it has to be the most CHROMATIC thing
    // in the frame and the only thing whose silhouette changes. Authored for
    // night — where a hot core genuinely does go near-white — the same colours
    // arrive at midday as a pale yellow smudge on gold dirt, with nothing to
    // separate them. Pulling green and blue down by day deepens the whole
    // stack toward a saturated orange that nothing else in an autumn valley
    // is, and leaves the night untouched.
    col.g *= uChroma.x;
    col.b *= uChroma.y;
    float fade = smoothstep(1.0, 0.48, vV);

    float a = depth * fade * vW * vFlick * uFlicker * uGain;

    // ── the tail crusher, and why a fire needs one in this engine ───────────
    //
    // PostFX applies a Purkinje shift at night: below uRodKnee (0.60 linear
    // luma) a pixel is mixed halfway toward luma * (0.958, 0.910, 2.012), and
    // the gate that tapers the term off is the pixel's own *coolness* — so a
    // dim WARM pixel gets the shift at full strength. The comment beside it
    // says outright that the knee is set where it is so that "a campfire, a
    // headlight pool, a lit window" stays above it and keeps its colour.
    //
    // That is a contract with this file, and the first four passes broke it.
    // A soft additive envelope tapering from a hot core out to nothing spends
    // most of its screen area in the 0.05-0.4 band, and measured at 20:24 that
    // band came back srgb(142,106,157) — a lavender ghost around an orange
    // flame, with blue LEADING red. Read as a defect it looks like the flame
    // has a halo of fog; it is actually the grade doing exactly what it was
    // written to do to a warm thing that is not bright enough to be a light.
    //
    // So the flame is either bright enough to read as fire or it is not there.
    // This is a soft square law about uKnee: it leaves the body untouched and
    // collapses the sub-knee tail toward zero rather than letting it linger.
    // uKnee rides the same night ramp the grade does, so by day — where there
    // is no rod term — the soft wide envelope survives intact.
    a *= smoothstep(0.0, uKnee, a);
    if (a < 0.0015) discard;
    // Straight additive through CustomBlending (ONE, ONE) so the whole HDR
    // value travels in rgb. Routing it through the alpha channel instead would
    // hand a >1 blend factor to fixed-function blending, which is where a
    // flame that looked right in one browser looked flat in another.
    gl_FragColor = vec4(col * a, 1.0);
  }`;

/**
 * One lathe shell of the flame.
 *
 * The profile is authored rather than derived: widest a fifth of the way up,
 * 0.92 of that at the fuel, and a point at the top. Real campfire flame is
 * widest just above the fuel because that is where the volatiles are burning
 * off, and a cone that is widest at y=0 reads as a party hat.
 */
function flameShell(R, H, radial, rings, shellIdx, tint, weight, lean, squash, seed) {
  const prof = (v) => {
    const r = Math.pow(Math.max(0, 1 - v), 0.5) * (0.92 + v * (1 - v) * 1.0);
    // Never exactly zero: an apex ring of coincident vertices is a fan of
    // zero-area triangles, and a zero-area triangle is where a normal goes to
    // length zero and a NaN gets into the bloom pyramid.
    return [R * Math.max(r, 0.012), -0.035 + H * v];
  };
  const pos = [], nrm = [], vs = [], sh = [], tn = [], wt = [], sd = [];
  const P = [], N = [];
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const [r, y] = prof(v);
    const eps = 1 / (rings * 4);
    const [r1, y1] = prof(Math.min(1, v + eps));
    const [r0, y0] = prof(Math.max(0, v - eps));
    const dr = r1 - r0, dy = y1 - y0;
    const nl = Math.hypot(dy, dr) || 1;
    const ring = [], rnorm = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      // A fixed elliptical squash and a fixed lean, both per shell: a body of
      // revolution is still a body of revolution once you add noise to it, and
      // the turntable is what finds that out.
      const sq = 1 + squash * Math.cos(a * 2 + seed);
      ring.push(new THREE.Vector3(
        ca * r * sq + lean.x * v * v, y, sa * r * sq + lean.y * v * v));
      rnorm.push(new THREE.Vector3(ca * dy / nl, -dr / nl, sa * dy / nl).normalize());
    }
    P.push(ring); N.push(rnorm);
  }
  const push = (ri, ai) => {
    const p = P[ri][ai % radial], n = N[ri][ai % radial];
    pos.push(p.x, p.y, p.z);
    nrm.push(n.x, n.y, n.z);
    vs.push(ri / rings);
    sh.push(shellIdx);
    tn.push(tint[0], tint[1], tint[2]);
    wt.push(weight);
    sd.push(seed);
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < radial; i++) {
      // Wound so the geometric normal from the cross product agrees with the
      // analytic outward normal pushed above. Verified rather than reasoned:
      // the first version had it the other way round and `tools/winding.mjs`
      // reported 0.0% agreement over 424 sampled triangles. It happens to be
      // invisible on this material — the flame shades on abs(dot(N,V)) and
      // draws double-sided — but it is a trap for anyone who later wants a
      // one-sided or normal-lit variant, and it is the gate.
      push(j, i); push(j + 1, i + 1); push(j, i + 1);
      push(j, i); push(j + 1, i); push(j + 1, i + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  const F = (a, n) => new THREE.BufferAttribute(new Float32Array(a), n);
  g.setAttribute('position', F(pos, 3));
  g.setAttribute('normal', F(nrm, 3));
  g.setAttribute('aV', F(vs, 1));
  g.setAttribute('aShell', F(sh, 1));
  g.setAttribute('aTint', F(tn, 3));
  g.setAttribute('aWeight', F(wt, 1));
  g.setAttribute('aSeed', F(sd, 1));
  sanitizeNormals(g);
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The ember bed
//
//  A handful of coals lying in the ash whose brightness breathes on its own
//  clock, plus one broad soft glow that is the *glue* between the flame and the
//  ash. Without the glue the flame is an object standing on a floor; with it
//  the floor is part of the fire.
// ─────────────────────────────────────────────────────────────────────────────
const BED_VERT = /* glsl */`
  attribute vec2  aUv;
  attribute float aSeed;
  attribute float aKind;    // 0 broad glow, 1 coal
  attribute vec3  aTint;
  varying vec2  vUv;
  varying float vSeed;
  varying float vKind;
  varying vec3  vTint;
  void main() {
    vUv = aUv; vSeed = aSeed; vKind = aKind; vTint = aTint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const BED_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGain;
  uniform float uReveal;
  varying vec2  vUv;
  varying float vSeed;
  varying float vKind;
  varying vec3  vTint;
  void main() {
    float d = length(vUv);
    float coal = step(0.5, vKind);
    // A coal is a small hard-ish disc; the bed glow is a wide soft one.
    float m = mix(smoothstep(1.0, 0.02, d), smoothstep(0.86, 0.10, d), coal);
    if (m <= 0.001) discard;

    // Each coal breathes at its own incommensurable rate — that is the whole
    // point of them. A bed that pulses in unison with the flame reads as one
    // animated object rather than as coals under a fire.
    float rate = 0.42 + fract(vSeed * 7.31) * 1.15;
    float ph   = vSeed * 6.283;
    float b = 0.46 + 0.54 * (0.5 + 0.5 * sin(uTime * rate + ph))
                   * (0.72 + 0.28 * sin(uTime * (rate * 2.37) + ph * 1.7));
    b = mix(0.80 + 0.20 * sin(uTime * 0.37), b, coal);

    float a = m * b * uGain * uReveal;
    if (a < 0.0008) discard;
    gl_FragColor = vec4(vTint * a, 1.0);
  }`;

function emberBed(rnd, R, hot) {
  const pos = [], uv = [], sd = [], kd = [], tn = [];
  const quad = (cx, cy, cz, sx, sz, rot, seed, kind, tint) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const p = corner.map(([u, v]) => [
      cx + (u * sx * c - v * sz * s), cy, cz + (u * sx * s + v * sz * c)]);
    const tri = [0, 1, 2, 0, 2, 3];
    for (const i of tri) {
      pos.push(p[i][0], p[i][1], p[i][2]);
      uv.push(corner[i][0], corner[i][1]);
      sd.push(seed); kd.push(kind);
      tn.push(tint[0], tint[1], tint[2]);
    }
  };
  // The broad bed glow, elliptical and slightly off-centre so it is not a
  // target painted on the ground.
  quad((rnd() - 0.5) * 0.04, 0.011, (rnd() - 0.5) * 0.04,
       R * 0.62, R * 0.52, rnd() * TAU, rnd(), 0, [0.40, 0.115, 0.026]);
  // Coals. Clustered toward the middle where the fuel is, with a couple thrown
  // out toward the ring — a fire that has been burning a while spits.
  const n = 13 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const r = R * (0.06 + Math.pow(rnd(), 1.5) * 0.82);
    const s = 0.016 + rnd() * 0.030;
    // Hotter in the middle, going to a dull red at the edge of the bed.
    const k = clamp01(1 - r / (R * 0.9));
    const tint = [
      lerp(0.85, 1.0, k),
      lerp(0.115, 0.44, k * k),
      lerp(0.015, 0.13, k * k * k),
    ];
    const g = lerp(0.28, 1.0, Math.pow(k, 0.7)) * (0.5 + rnd());
    quad(Math.cos(a) * r, 0.013 + rnd() * 0.004, Math.sin(a) * r,
         s, s * (0.6 + rnd() * 0.7), rnd() * TAU, rnd(),
         1, [tint[0] * g, tint[1] * g, tint[2] * g]);
  }
  // A few embers clinging to the charred ends of the fuel, so the logs read as
  // burning rather than as black sticks placed in a fire.
  for (const h of hot) {
    if (rnd() < 0.35) continue;
    const s = 0.013 + rnd() * 0.016;
    quad(h.x, h.y, h.z, s, s * 0.8, rnd() * TAU, rnd(), 1,
         [1.0, 0.33, 0.06].map((c) => c * (0.55 + rnd() * 0.8)));
  }
  const g = new THREE.BufferGeometry();
  const F = (a, n2) => new THREE.BufferAttribute(new Float32Array(a), n2);
  g.setAttribute('position', F(pos, 3));
  g.setAttribute('aUv', F(uv, 2));
  g.setAttribute('aSeed', F(sd, 1));
  g.setAttribute('aKind', F(kd, 1));
  g.setAttribute('aTint', F(tn, 3));
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Embers and smoke
//
//  Built the way VehicleFX builds dust, leaves and spray: attributes are
//  written once at spawn and the shader integrates the ballistics, so the CPU
//  never touches a live particle and a few dozen sparks cost one draw call and
//  no per-frame work at all.
//
//  Two fields rather than one, because the blend modes genuinely differ — a
//  spark is light being added to the frame and smoke is light being occluded,
//  and faking either with the other is why so many game campfires have grey
//  sparks or glowing smoke.
// ─────────────────────────────────────────────────────────────────────────────
const FX_VERT = /* glsl */`
  attribute vec3  aVel;
  attribute vec3  aColor;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aSeed;
  uniform float uTime;
  uniform float uScale;
  uniform float uDrag;
  uniform float uGrav;
  uniform float uWander;
  uniform float uGrow;
  uniform vec2  uWind;
  uniform float uWindLean;
  varying vec3  vColor;
  varying float vAge;
  varying float vSeed;

  void main() {
    float t = uTime - aBirth;
    float a = t / aLife;
    vAge = a;
    vSeed = aSeed;
    vColor = aColor;
    if (a < 0.0 || a > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }

    vec3 p = position + aVel * ((1.0 - exp(-uDrag * t)) / uDrag);
    p.y += 0.5 * uGrav * t * t;
    // The wander is what stops a column of sparks reading as a fountain: each
    // one takes its own path through the thermal, at its own rate.
    p.x += sin(t * (2.1 + aSeed * 2.4) + aSeed * 31.0) * uWander * t;
    p.z += cos(t * (1.7 + aSeed * 2.1) + aSeed * 17.0) * uWander * t;
    // LINEAR in t, not quadratic. Wind is a velocity, not an acceleration, and
    // the difference does not show on a 1.5 s spark — it shows on a 7 s smoke
    // puff, which at 0.52 t^2 had travelled THIRTY-THREE METRES downwind before
    // it faded. That is why the whole-camp frames had no smoke column in them:
    // the smoke was there, it was just most of the way to the next valley.
    p.xz += uWind * (uWindLean * t);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(aSize * (1.0 + uGrow * a) * uScale / max(-mv.z, 0.08), 1.0, 210.0);
    gl_Position = projectionMatrix * mv;
  }`;

const EMBER_FRAG = /* glsl */`
  uniform float uGain;
  varying vec3  vColor;
  varying float vAge;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float m = smoothstep(0.5, 0.06, d);
    if (m <= 0.002) discard;
    // Cooling: a spark leaves the fire yellow-white and dies deep red.
    vec3 col = mix(vColor, vec3(1.0, 0.135, 0.02), vAge * vAge);
    // A gentle twinkle, not a strobe — 1.6 Hz with only a fifth of the range.
    float tw = 0.80 + 0.20 * sin(vAge * 26.0 + vSeed * 44.0);
    float fade = smoothstep(0.0, 0.06, vAge) * pow(1.0 - vAge, 1.35);
    float a = m * fade * tw * uGain;
    if (a < 0.0015) discard;
    gl_FragColor = vec4(col * a, 1.0);
  }`;

const SMOKE_FRAG = /* glsl */`
  uniform float uGain;
  varying vec3  vColor;
  varying float vAge;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    // A broken edge, so a puff is not a perfect disc — the same argument
    // VehicleFX makes for road dust.
    float wob = 0.5 + 0.5 * sin(atan(c.y, c.x) * 3.0 + vSeed * 21.0);
    float m = smoothstep(0.5 - wob * 0.07, 0.05, d);
    if (m <= 0.003) discard;
    float fade = smoothstep(0.0, 0.22, vAge) * pow(1.0 - vAge, 1.5);
    float a = m * fade * uGain;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

// ─────────────────────────────────────────────────────────────────────────────
//  The material set — built once, per module, exactly like campMaterials()
//
//  WHY THIS IS NOT PER-INSTANCE, and it is a frame-time fix rather than a
//  tidiness one. Pitching a camp used to freeze the game for most of a second:
//  the first camp linked 36 shader programs, two consecutive frames of 986 ms
//  and 898 ms, measured with tools/_scratch/camphitch.mjs. Camp.js pre-warms
//  the whole prop set under the loading screen so the engine compiles
//  everything before the player can see a stall — but a pre-warm only warms
//  the *materials it was given*, and a constructor that news up four
//  ShaderMaterials every time hands the pre-warm four objects that no longer
//  exist by the time the player clicks. So the real camp linked a fresh set on
//  the very frame it appeared.
//
//  Held at module scope there is exactly one flame program, one bed program,
//  one spark program and one smoke program for the session, and the pre-warm's
//  compile is the one the live camp uses.
//
//  Per-instance variation therefore has to live in a uniform or a vertex
//  attribute, never in a material. It already did: the shell colours, weights
//  and seeds are attributes, and everything the hour ramps drive is a uniform.
//  There is at most one Firepit in the world at a time (Camp.js guarantees it),
//  so a shared `uTime` has exactly one writer.
//
//  Consequence for teardown: `dispose()` must NOT touch these. The pre-warm
//  builds and throws away a Firepit at boot, and a material disposed there is
//  gone for the rest of the session — a black flame from the first camp on.
// ─────────────────────────────────────────────────────────────────────────────
let _fireMats = null;

function fireMaterials() {
  if (_fireMats) return _fireMats;
  const fx = (frag, o) => new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uScale: { value: 600 }, uGain: { value: 1 },
      uDrag: { value: o.drag }, uGrav: { value: o.grav },
      uWander: { value: o.wander }, uGrow: { value: o.grow },
      uWind: { value: new THREE.Vector2(0.86, 0.51) },
      uWindLean: { value: o.windLean },
    },
    vertexShader: FX_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: o.additive ? THREE.CustomBlending : THREE.NormalBlending,
    ...(o.additive ? {
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    } : {}),
  });

  _fireMats = {
    flame: new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGain: { value: 1 },
        uAmp: { value: 0.52 },
        uSway: { value: 0.030 },
        uPinch: { value: 0.40 },
        uWind: { value: new THREE.Vector2(0.86, 0.51) },
        uReveal: { value: 1 },
        uFlicker: { value: 1 },
        uEdgePow: { value: 1.42 },
        uKnee: { value: 0.10 },
        uChroma: { value: new THREE.Vector2(1, 1) },
        uTipCol: { value: new THREE.Vector3(1.00, 0.330, 0.075) },
      },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    }),
    bed: new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uGain: { value: 1 }, uReveal: { value: 1 } },
      vertexShader: BED_VERT,
      fragmentShader: BED_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    }),
    // A camp fire throws a few dozen sparks, not a fountain.
    ember: fx(EMBER_FRAG, {
      drag: 1.55, grav: 0.30, wander: 0.085, grow: -0.35, windLean: 0.26, additive: true,
    }),
    smoke: fx(SMOKE_FRAG, {
      drag: 0.80, grav: 0.145, wander: 0.105, grow: 6.2, windLean: 0.42, additive: false,
    }),
  };
  return _fireMats;
}

class FireFX {
  constructor(parent, max, material, opts) {
    this.max = max;
    this.head = 0;
    this.time = 0;
    const g = new THREE.BufferGeometry();
    const f = (n) => new THREE.BufferAttribute(new Float32Array(max * n), n);
    this.pos = f(3); this.vel = f(3); this.col = f(3);
    this.birth = f(1); this.life = f(1); this.size = f(1); this.seed = f(1);
    this.birth.array.fill(-1e6);
    this.life.array.fill(1);
    g.setAttribute('position', this.pos);
    g.setAttribute('aVel', this.vel);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aLife', this.life);
    g.setAttribute('aSize', this.size);
    g.setAttribute('aSeed', this.seed);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.4, 0), 6);

    this.material = material;
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.order;
    this.points.name = opts.name;
    parent.add(this.points);
    this._lo = -1; this._hi = -1; this._dirty = false;
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, seed) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (this._lo < 0) { this._lo = i; this._hi = i; }
    else if (i === (this._hi + 1) % this.max) { this._hi = i; }
    else { this._lo = 0; this._hi = this.max - 1; }
    const p3 = i * 3;
    this.pos.array[p3] = x; this.pos.array[p3 + 1] = y; this.pos.array[p3 + 2] = z;
    this.vel.array[p3] = vx; this.vel.array[p3 + 1] = vy; this.vel.array[p3 + 2] = vz;
    this.col.array[p3] = r; this.col.array[p3 + 1] = g; this.col.array[p3 + 2] = b;
    this.birth.array[i] = this.time;
    this.life.array[i] = life;
    this.size.array[i] = size;
    this.seed.array[i] = seed;
    this._dirty = true;
  }

  update(dt, pixelHeight, gain, wind) {
    this.time += dt;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uScale.value = pixelHeight * 0.9;
    u.uGain.value = gain;
    u.uWind.value.copy(wind);
    if (!this._dirty) return;
    const attrs = [this.pos, this.vel, this.col, this.birth, this.life, this.size, this.seed];
    const runs = this._lo <= this._hi
      ? [[this._lo, this._hi - this._lo + 1]]
      : [[this._lo, this.max - this._lo], [0, this._hi + 1]];
    for (const a of attrs) {
      for (const [start, count] of runs) a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this._lo = this._hi = -1;
    this._dirty = false;
  }

  /** Age every slot out. Used when the fire moves to a new camp. */
  clear() {
    this.birth.array.fill(-1e6);
    this.birth.addUpdateRange(0, this.max);
    this.birth.needsUpdate = true;
    this.head = 0;
    this._lo = this._hi = -1;
    this._dirty = false;
  }

  /** Geometry only. The material is a module singleton — see fireMaterials(). */
  dispose() {
    this.points.parent?.remove(this.points);
    this.points.geometry.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry — cobbles, ash, split logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A river cobble: a lumpy, flattened ellipsoid.
 *
 * Everything through `Parts.add` is flat shaded (it converts to non-indexed and
 * recomputes normals), so an 80-facet icosphere with radial noise is exactly
 * the right primitive here — the facets read as the chipped planes of a stone
 * rather than as a low-poly sphere, and they take the firelight in distinct
 * steps which is most of what makes the ring read at night.
 */
function cobble(rnd, R) {
  const g = new THREE.IcosahedronGeometry(R, 1);
  const p = g.attributes.position;
  const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const d = 1
      + 0.12 * Math.sin(v.x * 3.1 + ph[0]) * Math.cos(v.z * 2.7 + ph[1])
      + 0.08 * Math.sin(v.y * 4.3 + ph[2])
      + 0.05 * Math.cos(v.x * 5.9 + v.z * 4.1 + ph[3]);
    p.setXYZ(i, v.x * R * d, v.y * R * d, v.z * R * d);
  }
  return g;
}

/**
 * The ash and charcoal bed inside the ring.
 *
 * A low dome rather than a flat disc: ash piles up where the fire has been and
 * the rim of the pit is scraped down, and a flat disc inside a ring of round
 * stones reads as a lid.
 */
function ashBed(rnd, R) {
  const seg = 18;
  const radii = [0, 0.26, 0.52, 0.76, 0.95].map((k) => k * R);
  const H = [0.036, 0.032, 0.024, 0.012, 0.0];
  const ring = radii.map((r, ri) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      const wob = 1 + (ri === 0 ? 0 : 0.10 * Math.sin(a * 3 + ri) + 0.06 * Math.sin(a * 5 + ri * 2.1));
      out.push(new THREE.Vector3(
        Math.cos(a) * r * wob,
        H[ri] + (ri === 0 ? 0 : (rnd() - 0.5) * 0.010),
        Math.sin(a) * r * wob));
    }
    return out;
  });
  const pos = [];
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    tri(ring[0][0], ring[1][j], ring[1][i]);
    for (let r = 1; r < radii.length - 1; r++) {
      tri(ring[r][i], ring[r][j], ring[r + 1][j]);
      tri(ring[r][i], ring[r + 1][j], ring[r + 1][i]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  return g;
}

/**
 * A split log.
 *
 * Firewood is split, not sawn round, and the difference is the whole read: a
 * quarter-round has one curved bark face and two flat pale split faces, and it
 * is the pale split face catching the firelight that says "somebody cut this"
 * rather than "a branch fell here". Returns the bark shell and the split faces
 * as separate geometries so each can carry its own tint through the same
 * material bin — they merge into one mesh regardless.
 *
 * Y runs along the log, centred; the bark arc faces +X.
 */
function splitLog(rnd, len, R, spanA) {
  const NA = 6, NL = 3;
  const bendX = (rnd() - 0.5) * R * 0.55, bendZ = (rnd() - 0.5) * R * 0.4;
  const taperEnd = 0.80 + rnd() * 0.16;
  const arcJit = [];
  for (let k = 0; k <= NA; k++) arcJit.push(0.94 + rnd() * 0.13);

  const P = [];         // [l][k] arc points
  const A = [];         // [l] apex
  for (let l = 0; l <= NL; l++) {
    const t = l / NL;
    const y = -len * 0.5 + t * len;
    const tp = lerp(1, taperEnd, t) * (1 - 0.10 * Math.sin(t * Math.PI));
    const bx = bendX * Math.sin(t * Math.PI), bz = bendZ * Math.sin(t * Math.PI);
    const row = [];
    for (let k = 0; k <= NA; k++) {
      const ang = -spanA * 0.5 + (k / NA) * spanA;
      const r = R * tp * arcJit[k];
      row.push(new THREE.Vector3(Math.cos(ang) * r + bx, y, Math.sin(ang) * r + bz));
    }
    P.push(row);
    A.push(new THREE.Vector3(-0.06 * R * tp + bx, y, bz));
  }
  const barkP = [], splitP = [];
  // ── the winding, and how it was caught ──────────────────────────────────
  //
  // Emitted as (a, b, c) every one of these faces was wound inside out, and
  // `Parts.add` DERIVES normals from the winding — so `tools/winding.mjs`
  // reported perfect agreement while every piece of firewood in the camp was
  // lit by its own back face. That is precisely the failure the winding tool's
  // header describes ("a surface that stayed dark from every angle... each
  // time it was misdiagnosed first"), and the tool cannot see it, because the
  // normals really do agree with the winding: both are wrong together.
  //
  // What catches it is the signed volume, sum of (a x b).c / 6 over the
  // triangles: positive for an outward-wound closed solid, negative for an
  // inward one. This mesh measured -0.0049. Reversed here rather than at each
  // call site so the bark, the two split faces and both end caps can never
  // disagree with each other.
  const tri = (arr, a, b, c) => arr.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  const quad = (arr, a, b, c, d) => { tri(arr, a, b, c); tri(arr, a, c, d); };

  for (let l = 0; l < NL; l++) {
    for (let k = 0; k < NA; k++) {
      quad(barkP, P[l][k], P[l][k + 1], P[l + 1][k + 1], P[l + 1][k]);
    }
    // The two split faces. Winding derived in the header note: the face at the
    // low-angle edge runs apex-up-out-down, the high-angle edge the other way.
    quad(splitP, A[l], A[l + 1], P[l + 1][0], P[l][0]);
    quad(splitP, A[l], P[l][NA], P[l + 1][NA], A[l + 1]);
  }
  // End caps.
  for (let k = 0; k < NA; k++) {
    tri(splitP, A[0], P[0][k], P[0][k + 1]);
    tri(splitP, A[NL], P[NL][k + 1], P[NL][k]);
  }
  const mk = (arr) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    return g;
  };
  return { bark: mk(barkP), split: mk(splitP) };
}

// Wood colourways, all expressed against the shared `wood` material so the camp
// keeps one timber hue and the variation lives in the vertex colour.
const BARK_T = tintFrom(0x8a6a46, 0x6b5238);
const SPLIT_T = tintFrom(0x8a6a46, 0x9a7c56);
const CHAR_T = tintFrom(0x8a6a46, 0x231d1a);
const ASHTIP_T = tintFrom(0x8a6a46, 0x837b72);

/**
 * The bare-to-charred ramp along a log.
 *
 * Driven by world distance from the hot centre of the pit rather than by a
 * parameter along the log, which is what makes the transition land in a
 * different place on every log and at a different angle across the split face
 * than along the bark. That asymmetry is the tell that this is a fire doing it
 * and not a gradient.
 */
function charTint(base, hot, r0, r1) {
  return (x, y, z) => {
    const d = Math.hypot(x - hot.x, (y - hot.y) * 1.15, z - hot.z);
    const k = clamp01(smoothstep(r1, r0, d));
    // A thin band of white ash right at the edge of the char, which is what a
    // burning log actually looks like where the flame has just passed.
    const ash = smoothstep(0.30, 0.60, k) * (1 - smoothstep(0.62, 0.90, k)) * 0.70;
    const c = [
      lerp(base[0], CHAR_T[0], k),
      lerp(base[1], CHAR_T[1], k),
      lerp(base[2], CHAR_T[2], k),
    ];
    return [
      lerp(c[0], ASHTIP_T[0], ash),
      lerp(c[1], ASHTIP_T[1], ash),
      lerp(c[2], ASHTIP_T[2], ash),
    ];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Firepit
// ─────────────────────────────────────────────────────────────────────────────
export class Firepit {
  constructor(scene, rnd = Math.random, opts = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'camp_fire';
    this.reveal = 1;
    this._t = 0;
    this._flare = 0;
    this._nextFlare = 5 + rnd() * 7;
    this._emberAcc = 0;
    this._smokeAcc = 0;
    this._wind = new THREE.Vector2(0.86, 0.51);
    this._windT = 0;

    // The solid half of the pit lives under its own node so `setReveal` can
    // ease it in without moving the light or scaling the flame's noise field.
    this.solids = new THREE.Group();
    this.group.add(this.solids);

    // Sparks and smoke live for the lifetime of the object; only the geometry
    // in the pit is rebuilt per camp.
    // A camp fire throws a few dozen sparks, not a fountain: 96 slots at ~10/s
    // and a ~2 s life is about twenty alive at any moment, which is what the
    // night plate actually shows.
    const FM = fireMaterials();
    this.embers = new FireFX(this.group, 96, FM.ember, { order: 7, name: 'camp_fire_sparks' });
    this.smoke = new FireFX(this.group, 112, FM.smoke, { order: 8, name: 'camp_fire_smoke' });

    // ── the light ─────────────────────────────────────────────────────────
    //
    // Camp.js owns a PointLight that exists from boot and is never removed,
    // and hands it in as `opts.light`. Use it. A light *appearing* at runtime
    // changes NUM_POINT_LIGHTS, which relinks every lit material in the
    // valley — measured as most of a second of freeze on the frame the player
    // clicks — and there is nothing about a fire's light that has to be born
    // with the fire. Creating one is the fallback for a standalone Firepit
    // (a test, a tool) where nobody supplied one.
    //
    // It is NOT parented to `this.group`: it outlives this object, so
    // `setPosition` carries it instead and `dispose` leaves it alone.
    //
    // Colour is a real fire's ~1900 K and that saturation is deliberate here
    // even though Lighting.js spends a page warning against a saturated key —
    // that warning is about a *global* key performing a hue replacement on
    // every albedo in the frame. This is a local accent inside an otherwise
    // blue night, which is the good kind of hue variety rather than the bad,
    // and it is what the night plates show on the tent wall.
    //
    // DECAY IS INVERSE SQUARE WITH A TIGHT CUTOFF, and the reason is Stylize
    // rather than physics. A slow falloff (1.25) was tried first, on the
    // argument that inverse square is a 25:1 range between the ring and the
    // chairs. It measured terribly, and the frame that proved it was a night
    // capture with this light switched off entirely: deep navy dirt, the tent
    // a dark shape, one warm rim on the moonlit grass — the reference plate,
    // essentially. Turn the light back on at any intensity that lit the ring
    // and the whole clearing went pale lavender out to six metres and the
    // night was gone.
    //
    // The cause is the stylised direct term: it wraps the N.L, quantises it,
    // and then floors it so nothing is ever unlit. At a grazing angle three
    // metres out that turns a real 0.13 of cosine into more than 0.4, so a
    // point light in this engine reaches roughly three times as far as its
    // falloff says it does. Inverse square plus a ~6.6 m cutoff window brings
    // the lit pool back to the size a fire's actually is, and the *emissive*
    // flame and ember bed carry the warmth the light no longer sprays across
    // the camp.
    this.ownsLight = !opts.light;
    this.light = opts.light ?? new THREE.PointLight(0xffa259, 1.6, 6.5, 2.0);
    this.light.color.setHex(0xffa259, THREE.SRGBColorSpace);
    this.light.distance = 6.6;
    this.light.decay = 2.0;
    this.light.castShadow = false;
    this.light.name = 'camp_fire_light';
    if (this.ownsLight) scene.add(this.light);

    this._sc = new THREE.Color();
    scene.add(this.group);

    this._build(rnd, opts);
  }
  /**
   * Build every piece of geometry in the pit.
   *
   * Split out of the constructor so `rebuild(rnd)` exists. Camp.js keeps ONE
   * Firepit for the whole session and moves it to wherever the next camp is —
   * it has to, because a fire constructed per camp is a set of programs linked
   * per camp however thoroughly the boot pre-warm ran. The cost of that is
   * that every camp gets the same stone ring, which Camp's own note calls a
   * real loss. `rebuild` is what buys it back: the materials and the light are
   * session-scoped, the geometry is not.
   */
  _build(rnd, opts) {
    const R = opts.radius ?? 0.58;
    this.radius = R;
    const P = new Parts('fire');
    const hotSpots = [];

    // ── the stone ring ────────────────────────────────────────────────────
    //
    // River cobbles: varied in size, colour and how far they are sunk, with a
    // deliberate gap where somebody has taken one out to feed the fire. The
    // failure mode this is written against is a regular polygon of identical
    // dodecahedra, which is what the placeholder was and what every fire ring
    // in every asset store is.
    const n = 10 + Math.floor(rnd() * 4);
    const gap = Math.floor(rnd() * n);
    const CO = [
      tintFrom(0x7d7871, 0x8b8279), tintFrom(0x7d7871, 0x6e7278),
      tintFrom(0x7d7871, 0x9a8b76), tintFrom(0x7d7871, 0x5c5e60),
      tintFrom(0x7d7871, 0x968e83), tintFrom(0x7d7871, 0x7a6f63),
    ];
    for (let i = 0; i < n; i++) {
      if (i === gap && rnd() < 0.75) continue;
      const a = (i / n) * TAU + (rnd() - 0.5) * 0.30;
      const rr = R * (0.93 + rnd() * 0.17);
      const s = 0.072 + Math.pow(rnd(), 1.4) * 0.075;
      const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr;
      // Part-sunk, and by a different amount each time: the reason a ring of
      // stones sitting exactly on the dirt reads as placed rather than as dug
      // in is that all of them sit at the same height.
      const sink = 0.34 + rnd() * 0.30;
      const sy = 0.72 + rnd() * 0.42;
      const cy = s * sy * (1 - sink);
      const geo = cobble(rnd, s);
      const base = CO[Math.floor(rnd() * CO.length)];
      const inx = -Math.cos(a), inz = -Math.sin(a);
      // Two or three of them are sooted on the face that looks at the flame,
      // strongest just under the rim where the flame licks over.
      const soot = rnd() < 0.22 ? 0.62 : 0.14 + rnd() * 0.18;
      const stoneTint = (x, y, z) => {
        const dx = x - cx, dz = z - cz;
        const l = Math.hypot(dx, dz) || 1;
        const facing = clamp01((dx * inx + dz * inz) / l);
        // Soot climbs the inward face and stops short of the base, because the
        // base is buried in dirt and the flame never reaches it.
        const up = (y - cy) / Math.max(s * sy, 1e-3);
        const k = soot * Math.pow(facing, 2.4) * smoothstep(-0.55, 0.15, up);
        const dust = clamp01(smoothstep(s * 0.65, 0.0, y)) * 0.26;
        return [
          lerp(base[0] * (1 - dust) + 1.16 * dust, 0.09, k),
          lerp(base[1] * (1 - dust) + 1.10 * dust, 0.075, k),
          lerp(base[2] * (1 - dust) + 0.94 * dust, 0.07, k),
        ];
      };
      P.add(geo, 'stone',
        at(cx, cy, cz, (rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5,
           1.0 + rnd() * 0.35, sy, 1.0 + rnd() * 0.25),
        stoneTint);
    }

    // ── the ash bed ───────────────────────────────────────────────────────
    // Pale wood ash at the rim going to black charcoal under the fuel. Added
    // to the stone bin so the whole pit floor is one draw call.
    {
      const ASH = tintFrom(0x7d7871, 0x6e6862);
      const COAL = tintFrom(0x7d7871, 0x1e1a18);
      const ph = rnd() * TAU;
      const bedTint = (x, y, z) => {
        const d = Math.hypot(x, z) / R;
        const grain = 0.5 + 0.5 * Math.sin(x * 21 + ph) * Math.cos(z * 17 - ph);
        const k = clamp01(smoothstep(0.80, 0.10, d) * 0.86 + grain * 0.22);
        return [lerp(ASH[0], COAL[0], k), lerp(ASH[1], COAL[1], k), lerp(ASH[2], COAL[2], k)];
      };
      P.add(ashBed(rnd, R * 0.78), 'stone', null, bedTint);
      // A few angular lumps of charcoal sitting proud of the ash.
      for (let i = 0; i < 5; i++) {
        const a = rnd() * TAU, r = R * (0.15 + rnd() * 0.6);
        const s = 0.022 + rnd() * 0.028;
        P.add(new THREE.TetrahedronGeometry(s, 0), 'char',
          at(Math.cos(a) * r, 0.03 + s * 0.4, Math.sin(a) * r,
             rnd() * TAU, rnd() * TAU, rnd() * TAU, 1.3, 0.75, 1.0),
          [0.9 + rnd() * 0.5, 0.9, 0.88]);
      }
    }

    // ── the fuel ──────────────────────────────────────────────────────────
    //
    // A lean-to rather than a full tipi: three split logs leaned in against
    // each other on one side, two lying across the bed on the other. A closed
    // tipi hides the ember bed, and the ember bed is where half the warmth in
    // this frame comes from.
    const hot = new THREE.Vector3(0, 0.13, 0);
    const leanBase = rnd() * TAU;
    const nLean = 3;
    for (let i = 0; i < nLean; i++) {
      const a = leanBase + (i / nLean) * 2.1 - 1.05 + (rnd() - 0.5) * 0.3;
      const footR = R * (0.64 + rnd() * 0.15);
      const foot = new THREE.Vector3(Math.cos(a) * footR, 0.030, Math.sin(a) * footR);
      const headR = 0.05 + rnd() * 0.06;
      const ha = a + Math.PI + (rnd() - 0.5) * 0.9;
      const head = new THREE.Vector3(Math.cos(ha) * headR, 0.195 + rnd() * 0.065, Math.sin(ha) * headR);
      const len = foot.distanceTo(head) * (1.0 + rnd() * 0.06);
      const rad = 0.052 + rnd() * 0.020;
      // 145-185 deg of arc: a HALVED log, not a pie slice. At the 100 deg the
      // first pass used, the bark side barely curves across its own width and
      // every piece of fuel in the pit read as sawn planking.
      const { bark, split } = splitLog(rnd, len, rad, 2.52 + rnd() * 0.70);
      // Orient: +Y along foot->head, then roll so the bark faces outward.
      const dir = new THREE.Vector3().subVectors(head, foot).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * TAU);
      q.multiply(roll);
      const mid = new THREE.Vector3().addVectors(foot, head).multiplyScalar(0.5);
      const m = M().compose(mid, q, new THREE.Vector3(1, 1, 1));
      const r0 = 0.17 + rnd() * 0.06, r1 = 0.50 + rnd() * 0.12;
      P.add(bark, 'wood', m.clone(), charTint(BARK_T, hot, r0, r1));
      P.add(split, 'wood', m.clone(), charTint(SPLIT_T, hot, r0, r1));
      hotSpots.push(new THREE.Vector3(head.x * 0.7, 0.045, head.z * 0.7));
    }
    // Two logs lying in the bed, one of them burnt nearly through.
    for (let i = 0; i < 2; i++) {
      const a = leanBase + Math.PI + (i - 0.5) * 0.72 + (rnd() - 0.5) * 0.25;
      const len = R * (0.86 + rnd() * 0.30);
      const rad = 0.056 + rnd() * 0.020;
      const cx = Math.cos(a + 1.57) * R * (0.08 + rnd() * 0.18);
      const cz = Math.sin(a + 1.57) * R * (0.08 + rnd() * 0.18);
      const { bark, split } = splitLog(rnd, len, rad, 2.55 + rnd() * 0.65);
      const m = at(cx, 0.042 + rad * 0.5, cz,
        Math.PI * 0.5, a, (rnd() - 0.5) * 0.35);
      const r0 = 0.13 + rnd() * 0.05, r1 = 0.44 + rnd() * 0.13;
      P.add(bark, 'wood', m.clone(), charTint(BARK_T, hot, r0, r1));
      P.add(split, 'wood', m.clone(), charTint(SPLIT_T, hot, r0, r1));
      hotSpots.push(new THREE.Vector3(cx * 0.5, 0.055, cz * 0.5));
    }
    // Kindling: a couple of thin sticks poking out of the bed.
    for (let i = 0; i < 3; i++) {
      const a = rnd() * TAU;
      const len = 0.16 + rnd() * 0.18;
      const { bark, split } = splitLog(rnd, len, 0.017 + rnd() * 0.008, 2.7);
      const m = at(Math.cos(a) * R * (0.3 + rnd() * 0.35), 0.05 + rnd() * 0.03,
        Math.sin(a) * R * (0.3 + rnd() * 0.35),
        Math.PI * 0.5 - (rnd() * 0.5), a + (rnd() - 0.5), 0);
      P.add(bark, 'wood', m.clone(), charTint(BARK_T, hot, 0.13, 0.36));
      P.add(split, 'wood', m.clone(), charTint(SPLIT_T, hot, 0.13, 0.36));
    }

    P.flush(this.solids, { cast: true, receive: true });

    // ── the ember bed ─────────────────────────────────────────────────────
    this.bedMat = fireMaterials().bed;
    this.bed = new THREE.Mesh(emberBed(rnd, R * 0.74, hotSpots), this.bedMat);
    this.bed.frustumCulled = false;
    this.bed.renderOrder = 5;
    this.bed.name = 'camp_fire_embers';
    this.group.add(this.bed);

    // ── the flame ─────────────────────────────────────────────────────────
    //
    // Three nested shells in one geometry, one draw call, ~900 triangles.
    const seed = rnd() * 10;
    const lean = new THREE.Vector2((rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.05);
    // Weights are the per-shell radiance and they are SMALL, because the shells
    // are double-sided: a view ray down the axis crosses six surfaces, not
    // three, so the sum here is 2 x (0.100 + 0.200 + 0.300) = 1.20 at unit
    // gain. The first pass authored them as if each shell were one layer and
    // put 2.8 linear down the axis at midday, which is 2.6x the bloom
    // threshold at that hour — a white disc with a wash out to the grass.
    const shells = [
      // ── SIZE ────────────────────────────────────────────────────────────
      // The integrator's whole-camp frame settled this. At 0.62 m the flame
      // was "a small pale flicker roughly the size of the mug on the table",
      // the least conspicuous object in a picture arranged entirely around it.
      // A fire people sit round throws a flame of the same order as the ring
      // is wide — 1.16 m here — and the core/body/tip structure this shell
      // stack exists to produce cannot read at forty pixels either. 0.80 m of
      // geometry, about 0.72 m of it visible after the tip fade.
      //
      // ── HEIGHTS CLOSE, RADII NOT ────────────────────────────────────────
      // Authored as 0.62 / 0.47 / 0.30 the inner two shells had already ended
      // by 300 mm, so everything above the fuel was the outer shell alone at a
      // tenth of the core's radiance — a warm wisp instead of a flame. All
      // three now run most of the way up and the core/body/tip structure is a
      // *radial* one, which is what it is in a real flame.
      //
      // ── 22 RADIAL SEGMENTS ON THE OUTER SHELL ───────────────────────────
      // It is the shell that draws the silhouette, and at 15 the flame's
      // outline is a visible polygon at any framing closer than three metres.
      // The inner two never reach a silhouette, so they stay cheap.
      flameShell(0.256, 0.800, 22, 14, 0, [1.00, 0.330, 0.075], 0.100,
        lean, 0.115, seed + 0.0),
      flameShell(0.176, 0.710, 15, 13, 1, [1.00, 0.545, 0.185], 0.200,
        lean, 0.085, seed + 1.7),
      flameShell(0.106, 0.530, 12, 11, 2, [1.00, 0.840, 0.610], 0.300,
        lean, 0.060, seed + 3.4),
    ];
    const flameGeo = mergeAttr(shells);
    flameGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.45, 0), 1.4);
    this.flameMat = fireMaterials().flame;
    this.flame = new THREE.Mesh(flameGeo, this.flameMat);
    this.flame.frustumCulled = false;
    this.flame.renderOrder = 6;
    this.flame.name = 'camp_fire_flame';
    this.group.add(this.flame);

  }

  /** New stones, new fuel, new coals; same materials, same light, same programs. */
  rebuild(rnd = Math.random, opts = {}) {
    for (const m of [...this.solids.children]) {
      this.solids.remove(m);
      m.geometry?.dispose?.();
    }
    if (this.bed) { this.group.remove(this.bed); this.bed.geometry.dispose(); this.bed = null; }
    if (this.flame) { this.group.remove(this.flame); this.flame.geometry.dispose(); this.flame = null; }
    // Sparks and smoke are stored in the group's own space, so a camp pitched
    // somewhere else would otherwise inherit the last one's embers mid-flight.
    this.embers?.clear();
    this.smoke?.clear();
    this._build(rnd, { ...opts, radius: opts.radius ?? this.radius });
  }


  setPosition(v) {
    this.group.position.copy(v);
    // The light is not a child of the group (it outlives this object), so it
    // has to be carried by hand. `update` writes the y each frame.
    this.light.position.set(v.x, v.y + 0.46, v.z);
  }

  setReveal(k) {
    this.reveal = clamp01(k);
    this.group.visible = this.reveal > 0.004;
    // The light is not a child of the group, so hiding the group does not hide
    // it. `update` returns early while invisible, which would otherwise leave
    // the last camp's intensity burning over an empty patch of dirt.
    if (!this.group.visible) this.light.intensity = 0;
    // The solids ease up from the ground; the flame and the light ride their
    // own curves in `update`, so the fire lights before it is fully built —
    // which reads as somebody getting it going rather than as an object fading
    // into existence.
    const e = 1 - Math.pow(1 - this.reveal, 2.4);
    this.solids.scale.setScalar(lerp(0.62, 1, e));
  }

  /**
   * Flicker.
   *
   * Three incommensurable rates at 0.34, 0.54 and 0.91 Hz plus a slow 0.05 Hz
   * breath, with a combined amplitude of about ±13%. Every one of those numbers
   * is at the bottom of the range a real fire moves at, because this is a cozy
   * game and the test the brief sets is whether you could fall asleep beside
   * it. On top of that, a log settles every six to thirteen seconds: a fast
   * attack and a long decay, which is the only fast event in the whole system
   * and the only thing that keeps the slow rates from reading as a sine.
   */
  _flicker(dt) {
    const t = this._t;
    this._nextFlare -= dt;
    if (this._nextFlare <= 0) {
      this._flare = 1;
      this._nextFlare = 6 + Math.random() * 7;
      this._flareBurst = 5 + Math.floor(Math.random() * 8);
    }
    // Attack is instantaneous, decay is 1.6 s — the shape of a settling log.
    this._flare = Math.max(0, this._flare - dt / 1.6);
    const flare = this._flare * this._flare * 0.30;
    return 1
      + 0.055 * Math.sin(t * 2.13)
      + 0.041 * Math.sin(t * 3.37 + 1.1)
      + 0.028 * Math.sin(t * 5.71 + 2.3)
      + 0.045 * Math.sin(t * 0.31 + 0.7)
      + flare;
  }

  update(dt, t, camera) {
    if (!this.group.visible) return;
    const d = Math.min(dt, 0.1);
    this._t += d;

    // Wind, re-read twice a second: it is a uniform, not a per-frame cost, and
    // the weather system is allowed to arrive after the camp is pitched.
    this._windT -= d;
    if (this._windT <= 0) { windXZ(this._wind); this._windT = 0.5; }

    // Debug surface for tools/_scratch sweeps. Absent in a normal run, and a
    // handful of property reads when it is present.
    const T = (typeof window !== 'undefined' && window.__fireTune) || FIRE_TUNE;
    const elev = Number.isFinite(T.elev) ? T.elev : sunElevation();
    const dusk = duskAmount(elev);
    const night = nightAmount(elev);
    const rv = this.reveal;

    // ── the radiance ramp ───────────────────────────────────────────────────
    // See the header. These three numbers are the flame held at roughly a
    // constant multiple of the bloom threshold it is being measured against:
    // 1.05 linear at midday, 0.72 at the horizon, 1.70 at night.
    // Held at a roughly constant multiple of the bloom threshold it is being
    // measured against — 1.05 linear with the sun high, 0.72 at the horizon,
    // 1.70 at night (PostFX's glare ramp). Multiplied by the 0.91 stack above
    // these put the core at 1.05 / 1.15 / 2.55 linear at the three hours.
    const gain = lerp(lerp(1.90, 2.90, dusk), 4.60, night) * T.gain;
    const f = this._flicker(d);

    const fu = this.flameMat.uniforms;
    fu.uTime.value = this._t;
    fu.uGain.value = gain * rv;
    fu.uFlicker.value = f;
    fu.uReveal.value = rv;
    fu.uWind.value.copy(this._wind);
    fu.uKnee.value = lerp(lerp(0.10, 0.55, dusk), 0.80, night) * T.knee;
    const chroma = Math.max(dusk * 0.55, night);
    fu.uChroma.value.set(lerp(0.78, 1.0, chroma), lerp(0.56, 1.0, chroma));
    // A tighter falloff at night, for the same reason as the crusher: the wide
    // soft edge that reads as heat by day reads as a violet fringe after dark.
    fu.uEdgePow.value = lerp(1.35, 2.05, Math.max(dusk * 0.5, night));
    // At midday the tip has to stay chromatic or bloom eats it; at night it can
    // afford to go deeper and redder because there is nothing to compete with.
    fu.uTipCol.value.set(1.0, lerp(0.360, 0.245, night), lerp(0.090, 0.050, night));

    const bu = this.bedMat.uniforms;
    bu.uTime.value = this._t;
    // The bed carries more of the fire at night, when it is the thing that says
    // the pit is full of heat rather than full of black sticks.
    bu.uGain.value = lerp(0.26, 0.95, Math.max(dusk * 0.62, night)) * rv * T.bed;
    bu.uReveal.value = rv;

    // ── the light ───────────────────────────────────────────────────────────
    // 1.7 at midday — a supporting warm accent that just lifts the near stones
    // — against 8.6 at night, where it is the entire lighting of the camp.
    // Swept at 23:00 against a control frame with the light switched off. 4.2
    // put the whole clearing in pale lavender out to six metres; 1.15 left the
    // tent dark. 2.1 keeps the lit pool inside about three metres, which is
    // where the night plates put the edge of a camp fire's reach.
    const base = lerp(lerp(0.85, 1.45, dusk), 2.10, night);
    this.light.intensity = base * f * rv * rv * T.light;
    this.light.distance = lerp(4.6, 6.6, Math.max(dusk, night));
    // Warmer and a touch less saturated by day, so it does not read as a
    // coloured lamp on a sunlit prop.
    this._sc.setRGB(1.0, lerp(0.50, 0.40, night), lerp(0.22, 0.135, night));
    this.light.color.copy(this._sc);
    this.light.position.y = this.group.position.y + 0.42 + 0.08 * f;

    // ── spawning ────────────────────────────────────────────────────────────
    const px = window.__engine?.renderer?.domElement?.height ?? 900;
    const emberGain = lerp(lerp(0.55, 0.95, dusk), 1.25, night) * rv * T.ember;
    // A thin drifting column is the only part of a camp fire that is legible
    // at thirty metres, and it is what tells the player from across the
    // clearing that the fire is lit. The first passes had it at a sixth of
    // this and the integrator could not find it in the whole-camp frame at
    // all. Sparse but CONTINUOUS is the shape: many small puffs at low alpha,
    // not a few fat ones.
    const smokeGain = lerp(lerp(0.320, 0.125, dusk), 0.042, night) * rv * T.smoke;

    if (rv > 0.35) {
      // ~9 sparks a second, in ones and twos, plus a burst when a log settles.
      this._emberAcc += d * (10 + 7 * this._flare);
      let burst = this._flareBurst | 0;
      this._flareBurst = 0;
      let k = Math.min(6, Math.floor(this._emberAcc) + burst);
      this._emberAcc -= Math.floor(this._emberAcc);
      while (k-- > 0) this._spawnEmber();

      this._smokeAcc += d * 5.2;
      let s = Math.min(5, Math.floor(this._smokeAcc));
      this._smokeAcc -= Math.floor(this._smokeAcc);
      while (s-- > 0) this._spawnSmoke(night);
    }
    this.embers.update(d, px, emberGain, this._wind);
    this.smoke.update(d, px, smokeGain, this._wind);
    void t; void camera;
  }

  _spawnEmber() {
    const a = Math.random() * TAU;
    const r = Math.random() * 0.10;
    const y = 0.06 + Math.random() * 0.34;
    const up = 1.10 + Math.random() * 1.55;
    this.embers.spawn(
      Math.cos(a) * r, y, Math.sin(a) * r,
      (Math.random() - 0.5) * 0.30, up, (Math.random() - 0.5) * 0.30,
      1.5 + Math.random() * 1.7,
      // gl_PointSize is aSize * uScale / viewDepth with uScale ~ 0.9 * the
      // framebuffer height, so this is metres-ish, not pixels. The first pass
      // read it as pixels and shipped 210 px sparks — one of them landed above
      // the camper as a yellow ball the size of a wheel.
      0.017 + Math.random() * 0.019,
      1.0, 0.50 + Math.random() * 0.20, 0.115 + Math.random() * 0.105,
      Math.random());
  }

  _spawnSmoke(night) {
    const a = Math.random() * TAU;
    const r = Math.random() * 0.09;
    // Smoke is lit by the sky above and by the fire below; near the pit it is
    // warm and it cools as it climbs. At night there is nothing to light it at
    // all, which is why `smokeGain` all but switches it off.
    // Darker than it looks like it should be: this column is seen against a
    // near-white autumn sky as often as against the trees, and a pale grey
    // puff simply disappears into the first of those.
    const g = 0.44 + Math.random() * 0.16;
    this.smoke.spawn(
      Math.cos(a) * r, 0.56 + Math.random() * 0.20, Math.sin(a) * r,
      (Math.random() - 0.5) * 0.30, 0.50 + Math.random() * 0.40, (Math.random() - 0.5) * 0.30,
      4.6 + Math.random() * 3.6,
      0.150 + Math.random() * 0.085,
      g * lerp(1.06, 0.90, night), g * lerp(0.95, 0.90, night), g * lerp(0.84, 0.96, night),
      Math.random());
  }

  /**
   * Geometry only.
   *
   * The four ShaderMaterials are module singletons (see fireMaterials()) and
   * the point light usually belongs to Camp.js. Camp pre-warms the prop set at
   * boot by building one of everything and throwing it away, so anything this
   * disposes is gone for the session — disposing the flame material here would
   * leave every camp after the first with a black flame.
   */
  dispose() {
    this.scene.remove(this.group);
    this.embers.dispose();
    this.smoke.dispose();
    this.group.traverse((o) => { o.geometry?.dispose?.(); });
    if (this.ownsLight) {
      this.light.parent?.remove(this.light);
      this.light.dispose?.();
    } else {
      this.light.intensity = 0;
    }
  }
}

/**
 * Concatenate geometries that share an attribute set.
 *
 * `mergeGeometries` would do this, but it insists on identical attribute
 * *layouts* and takes a dispose path this does not need; these three shells are
 * built two lines above by one function and are non-indexed by construction, so
 * a straight concatenation is both shorter and impossible to get wrong.
 */
function mergeAttr(list) {
  const names = Object.keys(list[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = list[0].attributes[name].itemSize;
    let total = 0;
    for (const g of list) total += g.attributes[name].array.length;
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const g of list) g.dispose();
  sanitizeNormals(out);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The woodpile
//
//  The fire's supply, stacked where somebody dropped it. Same split-log
//  primitive as the fuel, so the two read as the same firewood — which is the
//  whole reason it is in this file and not in one of its own.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lay a log down: `+Y along the log` becomes `+Z`, yawed by `yaw` about world
 * up, and rolled by `roll` about the log's OWN length.
 *
 * This exists because `at()` cannot express it. `at()` takes an XYZ Euler,
 * which three.js composes as RX·RY·RZ — so the Z term is applied FIRST, before
 * the X term has tipped the log over, and a roll written as `at(..., PI/2, yaw,
 * rnd() * TAU)` is not a roll at all: it spins the log's long axis around while
 * it is still standing up, and comes out the far side as a full random yaw.
 * That is what turned this stack into a heap of crossed sticks that read as an
 * unlit fire — every log parallel on paper, every log pointing somewhere else
 * on screen. The fire's own lean logs sidestep it with `setFromUnitVectors` and
 * an explicit roll quaternion; this does the same thing for the flat-laid case.
 */
function layLog(x, y, z, yaw, roll) {
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(Math.PI * 0.5, yaw, 0, 'YXZ'))
    .multiply(new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll));
  return M().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
}

/**
 * How far a laid log reaches across and below/above its own origin, exactly.
 *
 * Nothing about a split log's silhouette can be predicted from its radius. It
 * is a wedge, and which way it was rolled decides everything: bark-down it
 * hangs a full radius below the axis, bark-up it hangs 0.06 of one — the apex —
 * and stands a radius proud instead. Seating a course on a nominal radius
 * therefore floats half of it and buries the other half, which is what left the
 * bottom course of the woodpile hovering 4 cm over its own shadow. Once the
 * stack holds quarters, halves AND whole rounds, no single nominal exists at
 * all, and measuring is the only thing that packs them.
 *
 * Transforming the points is exact where `Box3.applyMatrix4` is not: that
 * inflates the box to the axis-aligned bound of an already axis-aligned bound,
 * and under a 90 degree roll the error is the whole radius. It is ~180 vertices
 * per log and this runs once, when the camp is pitched.
 */
function extentsXY(geos, m) {
  const v = new THREE.Vector3();
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
  for (const g of geos) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.x < loX) loX = v.x;
      if (v.x > hiX) hiX = v.x;
      if (v.y < loY) loY = v.y;
      if (v.y > hiY) hiY = v.y;
    }
  }
  return { loX, hiX, loY, hiY };
}

/**
 * One piece of firewood: how much of a round it is, and how big that round was.
 *
 * A woodpile is not a box of identical billets. Somebody quartered the big
 * rounds, halved the middling ones and threw the small ones on whole, and the
 * mix is most of what makes a stack look like wood rather than like stock.
 *
 * The arc is the part that matters and it is the second time this file has had
 * to learn it: the fire's fuel carries a note that at 100 degrees of arc "the
 * bark side barely curves across its own width and every piece read as sawn
 * planking", and the woodpile was still on 97-155 degrees — so its pieces read
 * as shingles for exactly the same reason. Nothing here is under 155 now, and
 * a third of the stack is very nearly a closed cylinder.
 */
function firewoodPiece(rnd) {
  const r = rnd();
  // A small round, thrown on whole: as tall as it is wide, and the piece that
  // does most of the work of saying "these are logs".
  if (r < 0.30) return { span: 5.60 + rnd() * 0.50, rad: 0.042 + rnd() * 0.012 };
  // A halved round, the common case.
  if (r < 0.75) return { span: 2.95 + rnd() * 0.30, rad: 0.052 + rnd() * 0.016 };
  // A big one, off a trunk too thick to burn whole.
  return { span: 2.60 + rnd() * 0.35, rad: 0.068 + rnd() * 0.014 };
}

export function buildWoodpile(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_woodpile';
  const P = new Parts('woodpile');
  const wear = clamp01(opts.wear ?? 0.5);
  // `logs` is the number of pieces, and it comes from the site layout; it was
  // accepted and ignored for the whole of the last round, which is why every
  // camp had a stack of exactly the same mass.
  const N = Math.max(4, Math.round(opts.logs ?? 14));
  // How wide the rick is built, and the finger-gap between pieces in a course.
  // Courses are filled to this and then started again, so how many pieces a
  // course holds falls out of how big they happen to be — which is the only
  // thing that works once the stack contains quarters, halves and rounds.
  const ROW_W = 0.46;
  const GAP = 0.004;
  // The ends facing +Z are flush; the far ends are ragged, because the pieces
  // are not the same length and nobody trims a woodpile.
  const zFace = 0.17;
  // Each course is seated on the mean top of the one below, less a couple of
  // millimetres so it has settled into it rather than balanced on it. Mean
  // rather than max: the tallest piece in a course should be pressed into the
  // next, not hold it up over a gap.
  const SETTLE = 0.003;

  // ── cut the wood, and measure every piece ────────────────────────────────
  const pieces = [];
  for (let i = 0; i < N; i++) {
    const { span, rad } = firewoodPiece(rnd);
    const len = 0.34 + rnd() * 0.08;
    const { bark, split } = splitLog(rnd, len, rad, span);
    // A split piece settles onto a flat face with the bark up or down. A round
    // has no flat face and no preference, so it lands however it rolled.
    const roll = span > 4.5
      ? rnd() * TAU
      : (rnd() < 0.5 ? 1 : -1) * Math.PI * 0.5 + (rnd() - 0.5) * 0.45;
    const yaw = (rnd() - 0.5) * 0.05;
    pieces.push({ bark, split, roll, yaw, len, e: extentsXY([bark, split], layLog(0, 0, 0, yaw, roll)) });
  }

  // ── pack them into courses ───────────────────────────────────────────────
  const courses = [];
  let course = [], used = 0;
  for (const p of pieces) {
    const w = p.e.hiX - p.e.loX;
    if (course.length && used + GAP + w > ROW_W) { courses.push(course); course = []; used = 0; }
    used += (course.length ? GAP : 0) + w;
    course.push(p);
  }
  if (course.length) courses.push(course);

  // ── stack them ───────────────────────────────────────────────────────────
  let base = -0.005;                       // the ground course, a little bedded in
  for (let row = 0; row < courses.length; row++) {
    const c = courses[row];
    let total = 0;
    for (const p of c) total += p.e.hiX - p.e.loX;
    total += GAP * (c.length - 1);
    // Courses do not line up with each other on a real stack, and a rick whose
    // ends are flush on both sides is a pallet.
    let cursor = -total * 0.5 + (row % 2 ? 1 : -1) * 0.012 + (rnd() - 0.5) * 0.008;
    let topSum = 0;
    for (const p of c) {
      const x = cursor - p.e.loX;          // butt this piece up against the last
      cursor += (p.e.hiX - p.e.loX) + GAP;
      const y = base - p.e.loY + (rnd() - 0.5) * 0.003;
      const z = zFace - p.len * 0.5 + (rnd() - 0.5) * 0.014;
      topSum += y + p.e.hiY;
      const m = layLog(x, y, z, p.yaw, p.roll);
      const dust = dusted([1, 1, 1], { top: 0.10, amount: 0.20 + wear * 0.22 });
      const bt = 0.86 + rnd() * 0.3;
      P.add(p.bark, 'wood', m.clone(), tintMul(dust, [BARK_T[0] * bt, BARK_T[1] * bt, BARK_T[2] * bt]));
      P.add(p.split, 'wood', m.clone(), tintMul(dust, [SPLIT_T[0] * bt, SPLIT_T[1] * bt, SPLIT_T[2]]));
    }
    base = topSum / c.length - SETTLE;
  }

  // One that has rolled off the stack — the difference between a woodpile and
  // a crate of dowels. Beside the stack and turned out of line with it, so it
  // reads as one that got away rather than as the stack itself going wrong.
  {
    const { span, rad } = firewoodPiece(rnd);
    const len = 0.34 + rnd() * 0.07;
    const { bark, split } = splitLog(rnd, len, rad, span);
    const side = rnd() < 0.5 ? 1 : -1;
    const x = side * (ROW_W * 0.5 + 0.07 + rnd() * 0.05);
    const z = 0.14 + rnd() * 0.09;
    const yaw = side * (0.90 + rnd() * 0.30), roll = rnd() * TAU;
    const { loY } = extentsXY([bark, split], layLog(x, 0, z, yaw, roll));
    const m = layLog(x, -0.004 - loY, z, yaw, roll);
    const dust = dusted([1, 1, 1], { top: 0.09, amount: 0.26 + wear * 0.22 });
    P.add(bark, 'wood', m.clone(), tintMul(dust, BARK_T));
    P.add(split, 'wood', m.clone(), tintMul(dust, SPLIT_T));
  }
  P.flush(g, { cast: true, receive: true });
  // Measured, not asserted — the log lying beside the stack is what sets this,
  // and a hand-written constant went stale the moment the stack changed shape.
  // Every other prop in the set publishes the same field; the site's own
  // spacing radius is passed to `tryPlace` separately.
  const bb = new THREE.Box3().setFromObject(g);
  g.userData.footprint = Math.max(
    Math.abs(bb.min.x), Math.abs(bb.max.x),
    Math.abs(bb.min.z), Math.abs(bb.max.z),
  );
  return g;
}

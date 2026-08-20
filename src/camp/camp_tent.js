// ─────────────────────────────────────────────────────────────────────────────
//  camp_tent — the tent.
//
//  Shape language comes off the four plates in `reference-art/tents/`, and the
//  thing all four have in common is that a tent is a *membrane over a frame*.
//  Every legible feature falls out of that one fact:
//
//    · the pole arcs are visible as ridges under the fly, because the fabric is
//      pulled tight over them and slack everywhere else;
//    · the panels between the poles are pulled *inwards*, so the dome is four
//      soft lobes with a crease at each pole rather than an egg;
//    · the hem is cut in a catenary and staked at the four corners, so it
//      scallops up between them and never touches the ground;
//    · every guy-out point puckers the fabric into a small cone with a fan of
//      creases raking off it — the single most "photographed tent" detail there
//      is, and almost free;
//    · the door is a hole with depth behind it: fly, then a rim of fabric
//      turning inward, then the dark inner canopy, then the bathtub floor.
//
//  CONSTRUCTION
//
//  The fly is ONE parametric shell, not a bag of quads. A dome's surface is a
//  superellipsoid: plan outline `|x/A|^k + |z/B|^k = 1` (k < 1 ⇒ a rounded
//  rectangle, which is what a tent footprint is), vertical profile
//  `r^n + (y/H)^n = 1` (n > 2 ⇒ vertical walls and a flat crown, which is what
//  a dome tent is). Four flat `fabricPanel()` quads cannot make that shape —
//  they make a pup tent — so the fly is sampled from the surface function and
//  emitted as a grid, and `fabricPanel()` is used for the pieces that genuinely
//  *are* quads: the vestibule, its underside, and the rear vent hood. The warp
//  callback those take is the same wrinkle field the shell uses, so the whole
//  tent creases in one language.
//
//  The door is not a dark decal and not a mask over the grid: the grid's `v`
//  coordinate is remapped so that its bottom edge *is* the door arch. That
//  makes the aperture an exact curve at any tessellation instead of a
//  stairstep, which is what a mask over an 8 cm grid would have given.
//
//  Winding is decided per cell against an outward reference direction rather
//  than assumed from the parametrisation (see `patch()`). Three authors on this
//  project have shipped inverted geometry; a surface that folds back on itself
//  under a displacement field is exactly where that happens.
//
//  Sizes are real gear. A 2P dome is 2.2 × 1.4 × 1.05 m and the camper next to
//  it is 4.7 m long; scale error is invisible in a studio capture and obvious
//  in the wide shot, so the framings that matter are `wide` and `arrival`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, M, at, span, rbox, tube, rod, fabricPanel, sweptArc,
  tintOf, sanitizeNormals,
} from './camp_materials.js';
import { lerp, clamp, clamp01, smoothstep } from '../core/MathUtils.js';

const TAU = Math.PI * 2;
const PI = Math.PI;
const HALF = Math.PI / 2;
const QUARTER = Math.PI / 4;

// The grid stops just short of the true apex. At v = 1 the profile radius is
// exactly zero, which would collapse the whole top row into one point and give
// a ring of zero-area triangles — the black-square case `sanitizeNormals()`
// exists for. Stopping at 0.955 leaves an ~85 mm ring, which is then closed by
// a crown patch: a real tent has a reinforcement disc exactly there, where the
// poles cross, so the fix and the feature are the same thing.
const V_MAX = 0.955;

// ─────────────────────────────────────────────────────────────────────────────
//  Colourways
//
//  One per reference plate. They differ in more than hue: `nProf` is the
//  vertical superellipse exponent, so colourway 1 has the near-vertical walls
//  and flat roof of the grey cabin tent while colourway 2 is the low, long,
//  rounded 2P. A colourway that is only a hue swap is four renders of the same
//  tent, and the layout solver only ever pitches one, so each of these has to
//  carry a whole camp on its own.
//
//  `fly` / `flyAlt` alternate by gore — the teal/sage panelling of the fourth
//  plate — and meet in a blend across the pole line, so the seam is also a
//  colour boundary and the pole arc reads twice over.
// ─────────────────────────────────────────────────────────────────────────────
export const TENT_COLORWAYS = [
  {
    // 0 — the orange 2P dome. Grey-blue webbing, warm brown inner, staked
    //     vestibule with the door rolled back, exactly like the plate.
    name: 'passage',
    fly: 0xe08a2c, flyAlt: 0xcf7620, accent: 0x8d99a4, trim: 0x33383e,
    inner: 0x6d5a3e, floor: 0x6b4a2a, pole: 0xa9aeb3,
    A: 0.68, B: 0.92, H: 1.02, nProf: 2.55, pPlan: 0.70,
    vest: 0.26, doorOpen: true, sideGuys: false,
  },
  {
    // 1 — the grey cabin. Boxy: nProf 3.2 pushes the walls near-vertical and
    //     flattens the roof, pPlan 0.82 squares the footprint off. The bright
    //     blue is the pole sleeve and every seam tape, which is the only thing
    //     stopping a grey tent from being a grey lump.
    name: 'cabin',
    fly: 0x757b83, flyAlt: 0x63696f, accent: 0x2f92d6, trim: 0x25282d,
    inner: 0x33383e, floor: 0x2f3338, pole: 0x9aa0a6,
    A: 0.78, B: 1.00, H: 1.18, nProf: 3.2, pPlan: 0.76,
    vest: 0.18, doorOpen: false, sideGuys: true,
  },
  {
    // 2 — cream + red. Low and long, rounded (nProf 2.25), with the red trim
    //     running the pole lines and the hem the way the A-frame plate does.
    name: 'ridgeline',
    fly: 0xe3dac6, flyAlt: 0xcfc4ac, accent: 0xbe3a2b, trim: 0x7a4030,
    inner: 0x6a5a42, floor: 0x5d5040, pole: 0xb0b4b8,
    A: 0.66, B: 0.98, H: 0.94, nProf: 2.25, pPlan: 0.66,
    vest: 0.20, doorOpen: false, sideGuys: false,
  },
  {
    // 3 — the teal / sage / rust 4P. The biggest of the set: it has to still
    //     sit inside the solver's 1.45 m clearance, so it grows in height and
    //     in wall verticality rather than in plan.
    name: 'basecamp',
    fly: 0x2b6165, flyAlt: 0xa8b394, accent: 0xc9552f, trim: 0x1f4144,
    inner: 0x50372c, floor: 0x9c4326, pole: 0xa9aeb3,
    A: 0.88, B: 0.98, H: 1.28, nProf: 2.75, pPlan: 0.72,
    vest: 0.16, doorOpen: true, sideGuys: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Grid emitters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emit a parametric patch `S(u, v) -> Vector3` as a non-indexed triangle soup.
 *
 * Winding is not assumed. For every cell the geometric normal is compared
 * against a reference direction supplied by the caller and the two triangles
 * are emitted in whichever order agrees with it. A displaced membrane folds
 * back on itself wherever a wrinkle is deep relative to the cell size, and the
 * parametrisation's own handedness stops being a reliable guide exactly there —
 * which is the failure `tools/winding.mjs` was written to catch.
 *
 * @param S     (u, v, out:Vector3) => Vector3
 * @param NU,NV cell counts
 * @param ref   (p:Vector3, out:Vector3) => Vector3 — outward direction at p
 */
function patch(S, NU, NV, ref) {
  const pts = new Array((NU + 1) * (NV + 1));
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) pts[j * (NU + 1) + i] = S(i / NU, j / NV, new THREE.Vector3());
  }
  const arr = new Float32Array(NU * NV * 18);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const nn = new THREE.Vector3(), rf = new THREE.Vector3();
  let o = 0;
  const tri = (a, b, c) => {
    arr[o++] = a.x; arr[o++] = a.y; arr[o++] = a.z;
    arr[o++] = b.x; arr[o++] = b.y; arr[o++] = b.z;
    arr[o++] = c.x; arr[o++] = c.y; arr[o++] = c.z;
  };
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = pts[j * (NU + 1) + i];
      const b = pts[j * (NU + 1) + i + 1];
      const c = pts[(j + 1) * (NU + 1) + i + 1];
      const d = pts[(j + 1) * (NU + 1) + i];
      e1.subVectors(b, a); e2.subVectors(d, a);
      nn.crossVectors(e1, e2);
      ref(a, rf);
      // `nn` is cross(b-a, d-a), which carries the same sense as the normal
      // three will derive from triangle (a, b, c). Agreeing with the outward
      // reference therefore means dot > 0 — get this backwards and the whole
      // shell renders as its own dark interior, which is exactly what round 1
      // shipped.
      if (nn.dot(rf) > 0) { tri(a, b, c); tri(a, c, d); }
      else { tri(a, c, b); tri(a, d, c); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  sanitizeNormals(g);
  return g;
}

/**
 * Place a +Z-facing primitive (a flat patch, a torus) at `p` with its +Z along
 * `dir`. `at()` takes Euler angles, which is the wrong tool for "lie this patch
 * against a curved fly": the surface normal is what is known and the Euler
 * triple that produces it is not.
 */
function orient(p, dir) {
  return new THREE.Matrix4().compose(
    p,
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize()),
    new THREE.Vector3(1, 1, 1),
  );
}

/** A triangle fan from `c` out to a closed ring — the crown patch and the floor. */
function fan(c, ring, outwardUp = true) {
  const n = ring.length;
  const arr = new Float32Array(n * 9);
  let o = 0;
  // The ring's total signed area about +Y decides the order ONCE. Deciding it
  // per triangle is what round 1 did, and a ring with 17 mm of pole ridge in it
  // at an 85 mm radius has segments whose individual sign disagrees with the
  // ring's — which came out as a crown patch made of holes.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    area += (a.x - c.x) * (b.z - c.z) - (a.z - c.z) * (b.x - c.x);
  }
  const flip = (area < 0) !== outwardUp;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const q = flip ? [c, b, a] : [c, a, b];
    for (const v of q) { arr[o++] = v.x; arr[o++] = v.y; arr[o++] = v.z; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  sanitizeNormals(g);
  return g;
}

/**
 * A ribbon along a polyline of (centre, left, right) triples — pole sleeves,
 * seam tape, the zip track, the door reveal. Two-sided callers use `fabricIn`.
 */
function ribbon(l, r, ref) {
  const n = l.length;
  return patch((u, v, out) => {
    const i = Math.min(n - 1, Math.round(u * (n - 1)));
    return out.lerpVectors(l[i], r[i], v);
  }, n - 1, 1, ref);
}

// ─────────────────────────────────────────────────────────────────────────────
//  buildTent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {()=>number} rnd    seeded RNG — every random choice goes through it
 * @param {object} opts       { colorway:int, wear:0..1 }
 * @returns {THREE.Group}     origin at ground centre, +Z is the door
 */
export function buildTent(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_tent';
  const cw = TENT_COLORWAYS[(opts.colorway ?? 0) % TENT_COLORWAYS.length];
  const wear = clamp01(opts.wear ?? 0.4);
  const P = new Parts('tent');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  const { A, B, H, nProf, pPlan } = cw;
  const e = 2 / nProf;

  // Four phases so two camps in one valley do not crease identically. Drawn up
  // front and in a fixed order, because the RNG is shared with the layout and
  // a conditional draw would desync every prop placed after this one.
  const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];
  // Per-gore slackness. A tent nobody re-tensioned has one baggy side.
  const goreSlack = [0.78 + rnd() * 0.5, 0.78 + rnd() * 0.5, 0.78 + rnd() * 0.5, 0.78 + rnd() * 0.5];
  const hemJit = [rnd(), rnd(), rnd(), rnd()];

  // ── the surface ────────────────────────────────────────────────────────────
  // Plan outline: a superellipse. pPlan < 1 squares the corners off, which is
  // what turns "an ellipse" into "a tent footprint".
  const sc = (c) => Math.sign(c) * Math.pow(Math.abs(c), pPlan);
  const planX = (phi) => A * sc(Math.cos(phi));
  const planZ = (phi) => B * sc(Math.sin(phi));

  // Vertical profile, the same trick the camper's wheel arches use: a fractional
  // power of a sine gives a crown that flattens and a wall that stands up.
  const profR = (v) => Math.pow(Math.cos(HALF * v), e);
  const profY = (v) => H * Math.pow(Math.sin(HALF * v), e);

  // Angular distance to the nearest pole. The poles run corner to corner, so
  // they cross the outline at phi = ±pi/4, ±3pi/4 and meet at the crown.
  const poleD = (phi) => {
    const a = (((phi - QUARTER) % HALF) + HALF) % HALF;
    return Math.min(a, HALF - a);
  };
  const goreOf = (phi) => (((Math.round(phi / HALF) % 4) + 4) % 4);

  // Hem: cut in a catenary, staked at the four corners, so it sits ~35 mm off
  // the dirt at the stakes and lifts to ~135 mm in the middle of each panel.
  // The gap is what lets you see the bathtub floor under it, and a fly that
  // touches the ground all the way round is the second-loudest tell after flat
  // fabric.
  const hemLow = 0.016, hemRise = 0.052 + 0.022 * wear;
  const hemY = (phi) => {
    const k = 0.5 - 0.5 * Math.cos(4 * (phi - QUARTER));
    const j = hemJit[goreOf(phi)];
    return hemLow + hemRise * Math.pow(clamp01(k), 0.8) * (0.86 + 0.28 * j);
  };

  // Base (undisplaced) shell. The hem lift is a vertical offset that dies off
  // by a third of the way up, so it moves the cut edge without bending the wall.
  const base = (phi, v, out) => {
    const r = profR(v) * (1 + 0.055 * Math.pow(1 - v, 3));
    return out.set(planX(phi) * r, profY(v) + hemY(phi) * Math.pow(1 - v, 3), planZ(phi) * r);
  };

  const _n0 = new THREE.Vector3(), _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3();
  const _n3 = new THREE.Vector3(), _n4 = new THREE.Vector3();
  const normalAt = (phi, v, out) => {
    const h = 0.004;
    base(phi + h, v, _n0); base(phi - h, v, _n1); _n0.sub(_n1);              // dP/dphi
    base(phi, Math.min(1, v + h), _n2); base(phi, Math.max(0, v - h), _n1);
    _n2.sub(_n1);                                                            // dP/dv
    out.crossVectors(_n2, _n0);
    if (out.lengthSq() < 1e-12) return out.set(0, 1, 0);
    out.normalize();
    base(phi, v, _n1);
    // Reference is horizontal-radial plus a constant lift, so it still points
    // the right way at the crown where the radial part vanishes.
    if (out.x * _n1.x + out.z * _n1.z + out.y * 0.4 < 0) out.negate();
    return out;
  };

  // Guy-out anchors, in parameter space. The pucker they put in the fabric is
  // computed from these, so the geometry and the cord agree by construction.
  const ties = [];
  for (let k = 0; k < 4; k++) ties.push({ phi: QUARTER + k * HALF, v: 0.46, ph: ph[k % 4], slack: 0 });
  if (cw.sideGuys) { ties.push({ phi: 0, v: 0.62, ph: ph[1], slack: 0 }); ties.push({ phi: PI, v: 0.62, ph: ph[2], slack: 0 }); }
  // One line is always slightly slack. Factory-new gear reads as a shop display
  // and the eye finds the one thing that is not perfect before anything else.
  ties[Math.floor(rnd() * ties.length)].slack = 0.035 + 0.03 * wear;

  const slackAmp = 0.070 * ((A + B) / 1.9);
  const heightGate = (v) => Math.pow(Math.sin(PI * Math.pow(clamp01(v), 0.86)), 1.25);

  /**
   * Displacement along the surface normal, metres.
   *
   * Round two shipped this at roughly half these amplitudes and the tent
   * photographed as a vacuum-formed beach ball from every angle. The lesson is
   * that what makes cloth read is not depth, it is *normal variation*, and the
   * stylised lighting quantises diffuse into bands — so a departure only counts
   * if it is worth a whole band. A smooth 70 mm dent across a 0.9 m panel tips
   * the normal about 9°; a 13 mm wrinkle at a 0.25 m wavelength tips it 18°.
   * The wrinkles are doing most of the work here and they are deliberately
   * short — long enough to survive the grid (2.4 cm cells), short enough to
   * cross a band.
   */
  const disp = (phi, v) => {
    const d = poleD(phi);
    const t = d / QUARTER;                       // 0 on a pole, 1 mid-panel

    // The pole: a crease, not a swell. Narrow sigma so the fabric leaves the
    // arc quickly and the pole reads as a line down the fly.
    let s = 0.022 * Math.exp(-Math.pow(d / 0.095, 2)) * (v > 0.9 ? 1 - (v - 0.9) * 3.2 : 1);

    // The panel between two poles is pulled inward: zero gradient on the pole
    // line (the fabric leaves the crease tangentially) and zero at the panel
    // centre (a minimum, not a second crease).
    s -= slackAmp * (0.5 - 0.5 * Math.cos(PI * t)) * heightGate(v) * goreSlack[goreOf(phi)];

    // Wrinkles. These are the whole prop.
    //
    // Round four's set was inaudible on the front and back panels because every
    // high-frequency term was gated to the pole line, and the one ungated term
    // ran at 6 cycles around the tent — less than one full wave across a panel,
    // which is not a wrinkle, it is a lump. A lump is worse than nothing here:
    // the stylised shading quantises diffuse into bands, so a smooth 250 mm
    // swell does not shade as a swell, it shades as a hard-edged dark blotch,
    // and round four grew one of those on the side panel over a guy-out.
    // Creases band well; domes band badly. So everything below is directional —
    // long folds running down the panel, cross folds where the fabric gathers
    // above the hem — and every angular frequency is an integer so the shell
    // closes on itself at phi = 0 without a seam.
    // Fold amplitude has to die out towards the crown. On a dome every panel
    // line converges there, so creases that survive to the top all meet at one
    // point and the tent becomes a beach umbrella — which is exactly what round
    // five shipped, complete with hard black shadow slots down each rib where
    // the crease got deep enough to shadow itself.
    const crown = smoothstep(0.94, 0.50, v);
    const gate = heightGate(v) * crown;
    // Two long folds beating against each other, so the spacing is irregular
    // rather than radial.
    s += 0.0072 * Math.sin(7 * phi + ph[0] + v * 1.9) * gate * t;
    s += 0.0056 * Math.sin(11 * phi + ph[1] - v * 1.2) * gate * t;
    // Mid folds, amplitude modulated around the tent so some are creases and
    // some are barely there. Even spacing is the tell of a procedural wrinkle,
    // and it survives being squinted at.
    s += 0.0080 * Math.sin(19 * phi + ph[2] + v * 2.6) * gate
       * (0.45 + 0.55 * Math.sin(3 * phi + ph[3]));
    s += 0.0040 * Math.sin(29 * phi + ph[3] - v * 3.1) * gate;
    // Cross folds where the fabric gathers above the hem.
    s += 0.0105 * Math.sin(13 * phi + ph[3]) * Math.exp(-v / 0.28) * (0.30 + 0.70 * t);
    s += 0.0058 * Math.sin(9 * phi + ph[0] * 1.7 + v * 8.0) * Math.exp(-v / 0.42) * t;

    // Guy-out pucker: a cone of fabric pulled out at the anchor, a five-arm fan
    // of creases raking off it, and a tension line running from it down to the
    // hem. In every photograph of a pitched tent this star is the detail that
    // says the fabric is under load, and it costs one exp() per vertex.
    for (const gy of ties) {
      let dp = phi - gy.phi;
      dp = ((((dp + PI) % TAU) + TAU) % TAU) - PI;
      const dx = dp * 0.62, dy = (v - gy.v) * H;
      const D = Math.hypot(dx, dy);
      s += 0.0095 * Math.exp(-(D / 0.048) * (D / 0.048));
      const k = D / 0.22;
      s += 0.0125 * Math.cos(5 * Math.atan2(dy, dx) + gy.ph) * k * Math.exp(-k * k * 0.7);
      // the pull-down towards the hem below the anchor
      if (v < gy.v) {
        s += 0.010 * Math.exp(-(dx / 0.075) * (dx / 0.075)) * Math.pow(1 - v / gy.v, 0.7) * (v / gy.v);
      }
    }
    return s;
  };

  const surf = (phi, v, out) => {
    base(phi, v, out);
    normalAt(phi, v, _n3);
    return out.addScaledVector(_n3, disp(phi, v));
  };

  // ── the door ───────────────────────────────────────────────────────────────
  // A D: near-vertical sides, an arched top, and a SILL 200 mm off the dirt.
  //
  // Round three cut the aperture straight down to the hem and the whole
  // front-bottom of the tent went missing with it — you looked under the fly,
  // past an inset inner tent, and out the far side, and the thing read as
  // levitating over its own shadow. Real fly doors have a sill for the same
  // reason: a zip that runs into the dirt does not stay a zip for long.
  const SILL_Y = 0.20, DOOR_TOP = 0.78;        // metres, and a fraction of H
  const vOfY = (y) => (2 / PI) * Math.asin(clamp(Math.pow(clamp01(y / H), nProf / 2), 0, 1));
  const vSill = vOfY(SILL_Y);
  const doorV = vOfY(DOOR_TOP * H);
  const doorPhi = 0.40;
  // (1 - x^5)^0.5 rather than the wheel-arch (1 - x^2)^0.62: the fifth power
  // holds the arch near full height across most of the door and then drops it
  // hard at the sides, which is the difference between a D and an almond.
  const dPhi = (phi) => {
    const d = phi - HALF;
    return ((((d + PI) % TAU) + TAU) % TAU) - PI;
  };
  const doorArch = (phi) => {
    const x = Math.abs(dPhi(phi)) / doorPhi;
    if (x >= 1) return vSill;
    return vSill + (doorV - vSill) * Math.sqrt(1 - Math.pow(x, 5));
  };

  const outwardRef = (p, out) => out.set(p.x, 0.4, p.z);

  const cA = tintOf(cw.fly), cB = tintOf(cw.flyAlt);
  const flyTint = (x, y, z) => {
    const phi = Math.atan2(z / B, x / A);
    const gp = phi / HALF;
    const k = Math.round(gp);
    const seam = smoothstep(0.5 - 0.075, 0.5, Math.abs(gp - k));
    const even = ((((k % 2) + 2) % 2) === 0);
    const c0 = even ? cA : cB, c1 = even ? cB : cA;
    const m = 0.5 * seam;
    let r = lerp(c0[0], c1[0], m), gg = lerp(c0[1], c1[1], m), b = lerp(c0[2], c1[2], m);
    // Sun-bleached crown. UV kills a fly from the top down and this is most of
    // what separates a used tent from a swatch.
    const hn = clamp01(y / H);
    const bl = 1 + (0.035 + 0.075 * wear) * Math.pow(hn, 2.4);
    r *= bl; gg *= bl * 0.995; b *= bl * 0.985;
    // Faint blotching so a panel is never one flat value.
    const bt = 1 - 0.055 * (0.5 + 0.5 * Math.sin(3 * phi + y * 4.1 + ph[3])) * (0.4 + 0.6 * wear);
    r *= bt; gg *= bt; b *= bt;
    // The hem's underside is in its own shadow, then dirt on the last 120 mm.
    const ao = 1 - 0.16 * clamp01(smoothstep(0.20, 0.02, y));
    const dk = clamp01(smoothstep(0.15, 0.0, y)) * (0.14 + 0.24 * wear);
    r = (r * ao) * (1 - dk) + 1.12 * dk;
    gg = (gg * ao) * (1 - dk) + 1.04 * dk;
    b = (b * ao) * (1 - dk) + 0.86 * dk;
    return [r, gg, b];
  };

  // ── the fly ────────────────────────────────────────────────────────────────
  // Three patches, not one, because the aperture now has a sill and a shell
  // whose bottom edge is the door can no longer also be the shell whose bottom
  // edge is the hem:
  //
  //     MAIN   everything outside the door band, hem to crown
  //     FRONT  inside the band, door arch to crown
  //     SILL   inside the band, hem to the sill line
  //
  // The seams are the two vertical ribs at phi = pi/2 ± doorPhi, and they are
  // watertight by construction rather than by luck: `vRow` is one shared row
  // table with a break at the sill, MAIN walks all of it, SILL walks the rows
  // below the break and FRONT the rows above, so the three patches put vertices
  // at *identical* parameter values along the shared ribs. Sampling the same
  // rib at two different densities would leave a sub-millimetre crack, and a
  // crack in a shell you can see the sky through is a defect that survives
  // being squinted at.
  const NVS = 6, NVU = 40, NVT = NVS + NVU;
  const vRow = (k) => (k <= NVS
    ? (k / NVS) * vSill
    : vSill + ((k - NVS) / NVU) * (V_MAX - vSill));
  const NU_ALL = 232;
  const bandFrac = (doorPhi * 2) / TAU;
  const NU_F = Math.max(12, Math.round(NU_ALL * bandFrac));
  const NU_M = Math.max(24, NU_ALL - NU_F);

  P.add(patch((u, s, out) => {                                        // MAIN
    const phi = HALF + doorPhi + u * (TAU - doorPhi * 2);
    return surf(phi, vRow(s * NVT), out);
  }, NU_M, NVT, outwardRef), 'fabric', null, (x, y, z) => flyTint(x, y, z));

  P.add(patch((u, s, out) => {                                        // FRONT
    const phi = HALF - doorPhi + u * doorPhi * 2;
    return surf(phi, lerp(doorArch(phi), V_MAX, s), out);
  }, NU_F, NVU, outwardRef), 'fabric', null, (x, y, z) => flyTint(x, y, z));

  P.add(patch((u, s, out) => {                                        // SILL
    const phi = HALF - doorPhi + u * doorPhi * 2;
    return surf(phi, vRow(s * NVS), out);
  }, NU_F, NVS, outwardRef), 'fabric', null, (x, y, z) => flyTint(x, y, z));

  // Crown patch, closing the ring the grid stops at. On a real dome this is a
  // reinforced disc over the pole crossing, so it is slightly darker (two
  // layers of coated nylon) and lifted 6 mm at the centre by the poles under it.
  {
    const ring = [];
    const cn = 36;
    for (let i = 0; i < cn; i++) ring.push(surf((i / cn) * TAU, V_MAX, new THREE.Vector3()));
    const c = V(0, profY(1) + 0.006, 0);
    const dark = (x, y, z) => { const t = flyTint(x, y, z); return [t[0] * 0.93, t[1] * 0.93, t[2] * 0.94]; };
    P.add(fan(c, ring, true), 'fabric', null, dark);
  }

  // ── pole sleeves and seam tape ─────────────────────────────────────────────
  // A strip of tape along each pole line, in the accent colour, standing 8 mm
  // proud. Doubling the pole's read: it is already a ridge in the surface, and
  // now it is a colour line as well. The grey cabin plate is exactly this — the
  // blue is the only reason that tent has an arc at all.
  const acc = tintOf(cw.accent);
  for (let k = 0; k < 4; k++) {
    const pp = QUARTER + k * HALF;
    const L = [], R = [];
    const n = 26;
    for (let i = 0; i <= n; i++) {
      const v = lerp(0.012, V_MAX * 0.995, i / n);
      const p = surf(pp, v, new THREE.Vector3());
      const nrm = normalAt(pp, v, new THREE.Vector3());
      const tng = base(pp + 0.01, v, new THREE.Vector3()).sub(base(pp - 0.01, v, new THREE.Vector3())).normalize();
      const w = 0.015 * (1 - 0.30 * i / n);
      p.addScaledVector(nrm, 0.008);
      L.push(p.clone().addScaledVector(tng, -w));
      R.push(p.clone().addScaledVector(tng, w));
    }
    // Mixed halfway back to the fly: seam tape is the same coated nylon in a
    // contrast colour, not a stripe of paint, and at full saturation a 30 mm
    // line down each pole is the loudest thing on the tent.
    const tape = [lerp(cA[0], acc[0], 0.38), lerp(cA[1], acc[1], 0.38), lerp(cA[2], acc[2], 0.38)];
    P.add(ribbon(L, R, outwardRef), 'fabric', null, (x, y) => {
      const k2 = clamp01(smoothstep(0.16, 0.0, y)) * 0.20;
      return [tape[0] * (1 - k2) + 1.1 * k2, tape[1] * (1 - k2) + 1.02 * k2, tape[2] * (1 - k2) + 0.86 * k2];
    });
  }

  // ── door: reveal, zip track, pulls ─────────────────────────────────────────
  // The reveal is the whole trick. A hole cut in a single-sided shell is a
  // paper edge; turning 60 mm of fabric inward gives the aperture a lip that
  // catches light along its top and goes black down its sides, which is what
  // says "there is a volume behind this" — the same argument as the camper's
  // window reveals, which are deliberately deeper than a real car's.
  //
  // `arch` is the aperture's outline as an open curve running left jamb → over
  // the top → right jamb; `sillLine` closes it along the bottom. The reveal
  // wraps the whole loop, the zip only follows the arch, because that is where
  // a zip goes.
  const arch = [];
  {
    const n = 54;
    for (let i = 0; i <= n; i++) {
      const phi = HALF - doorPhi * 0.999 + (i / n) * doorPhi * 1.998;
      const v = doorArch(phi);
      arch.push({ phi, v, p: surf(phi, v, new THREE.Vector3()), n: normalAt(phi, v, new THREE.Vector3()) });
    }
  }
  const sillLine = [];
  {
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const phi = HALF + doorPhi * 0.999 - (i / n) * doorPhi * 1.998;
      sillLine.push({ phi, v: vSill, p: surf(phi, vSill, new THREE.Vector3()), n: normalAt(phi, vSill, new THREE.Vector3()) });
    }
  }
  const loop = arch.concat(sillLine);
  const archC = new THREE.Vector3();
  for (const a2 of loop) archC.add(a2.p);
  archC.multiplyScalar(1 / loop.length);

  {
    const L = [], R = [];
    for (const a2 of loop) {
      const inward = new THREE.Vector3().subVectors(archC, a2.p).normalize();
      L.push(a2.p.clone());
      R.push(a2.p.clone().addScaledVector(a2.n, -0.062).addScaledVector(inward, 0.018));
    }
    const revRef = (p, out) => out.subVectors(archC, p);
    const revTint = (x, y, z) => { const t = flyTint(x, y, z); return [t[0] * 0.62, t[1] * 0.62, t[2] * 0.66]; };
    P.add(ribbon(L, R, revRef), 'fabricIn', null, revTint);
  }

  // Zip track: a narrow dark tape sitting just outside the arch, offset along
  // the surface rather than along the normal so it hugs the curve.
  const archOut = [];
  {
    const L = [], R = [];
    for (let i = 0; i < arch.length; i++) {
      const a2 = arch[i];
      const b2 = arch[Math.min(arch.length - 1, i + 1)];
      const c2 = arch[Math.max(0, i - 1)];
      const tng = new THREE.Vector3().subVectors(b2.p, c2.p).normalize();
      const away = new THREE.Vector3().crossVectors(tng, a2.n).normalize();
      if (away.dot(new THREE.Vector3().subVectors(a2.p, archC)) < 0) away.negate();
      const p0 = a2.p.clone().addScaledVector(a2.n, 0.004);
      const p1 = p0.clone().addScaledVector(away, 0.024);
      archOut.push(p1.clone());
      L.push(p0); R.push(p1);
    }
    P.add(ribbon(L, R, outwardRef), 'fabric', null, tintOf(cw.trim));
  }

  // Two zip pulls with cord tails, parked where a zip actually parks: one down
  // at the right jamb, one just over the crown of the arch.
  for (const [f, side] of [[0.965, -1], [0.5, 1]]) {
    const i = Math.round(f * (arch.length - 1));
    const a2 = arch[i];
    const p = a2.p.clone().addScaledVector(a2.n, 0.012);
    P.add(rbox(0.013, 0.026, 0.005, 0.003), 'plastic',
      at(p.x, p.y, p.z, 0, Math.atan2(a2.n.x, a2.n.z), side * 0.3), [1, 1, 1]);
    const tail = p.clone().add(V(0, -0.040, 0)).addScaledVector(a2.n, 0.004);
    P.add(tube(0.0026, p.distanceTo(tail), 4), 'cord', span(p, tail, M()), [1, 1, 1]);
  }

  // The door rolled back and toggled, on the colourways whose plate shows it
  // open. Following the arch means the bundle reads as *the door*, not as a
  // sausage parked nearby.
  if (cw.doorOpen) {
    const n0 = 1, n1 = Math.round(arch.length * 0.30);
    P.add(sweptArc((t) => {
      const i = Math.round(lerp(n0, n1, t));
      const a2 = arch[i];
      const away = new THREE.Vector3().subVectors(archOut[i], a2.p).normalize();
      return a2.p.clone().addScaledVector(a2.n, 0.046).addScaledVector(away, 0.028);
    }, 12, 0.034, 6), 'fabric', null, (x, y, z) => {
      const t = flyTint(x, y, z); return [t[0] * 0.88, t[1] * 0.88, t[2] * 0.88];
    });
    // Two toggle ties around it. The torus is oriented so its axis follows the
    // bundle, which is the difference between a tie and a hula hoop.
    for (const f of [0.28, 0.74]) {
      const i = Math.round(lerp(n0, n1, f));
      const a2 = arch[i];
      const b2 = arch[Math.min(arch.length - 1, i + 3)];
      const away = new THREE.Vector3().subVectors(archOut[i], a2.p).normalize();
      const c2 = a2.p.clone().addScaledVector(a2.n, 0.046).addScaledVector(away, 0.028);
      const axis = new THREE.Vector3().subVectors(b2.p, a2.p).normalize();
      P.add(new THREE.TorusGeometry(0.038, 0.0042, 4, 12), 'cord', orient(c2, axis), [1, 1, 1]);
    }
  }

  // ── the inner tent ─────────────────────────────────────────────────────────
  // Everything below is only seen through the door and through the hem gap, and
  // that is precisely why it has to exist: the aperture needs three receding
  // values behind it (lit rim → dark canopy → warm floor) or it is a black hole
  // painted on a dome.
  const iS = 0.968, iH = 0.94, vTub = 0.062;
  const innerBase = (phi, v, out) => {
    const r = profR(v) * iS;
    return out.set(planX(phi) * r, profY(v) * iH, planZ(phi) * r);
  };
  // Deliberately smaller than the fly's aperture — about 60% of its width and
  // 70% of its height — so looking in you see a ring of canopy fabric before
  // you see a hole. Two apertures the same size read as one hole with a thick
  // rim; two different sizes read as depth.
  const innerDoor = (phi) => {
    const x = Math.abs(dPhi(phi)) / (doorPhi * 0.62);
    if (x >= 1) return vTub;
    return Math.max(vTub, doorV * 0.72 * Math.sqrt(1 - Math.pow(x, 4)));
  };
  const innerRef = (p, out) => out.set(p.x, 0.4, p.z);
  const innerTint = tintOf(cw.inner);

  // Canopy: from the top of the bathtub up, with its own arch cut the same way.
  P.add(patch((u, s, out) => {
    const phi = u * TAU;
    return innerBase(phi, lerp(innerDoor(phi), V_MAX * 0.97, s), out);
  }, 72, 16, innerRef), 'fabricIn', null, (x, y) => {
    // Lifted well off black. The canopy lives in the fly's own shadow, so the
    // renderer gives it almost nothing; left at its true value the door read as
    // a hole punched in the dome rather than as a room, and a door that reads
    // as a hole is the difference between a tent and a prop of a tent.
    const k = 0.85 + 0.55 * clamp01(y / (H * iH));
    return [innerTint[0] * k, innerTint[1] * k, innerTint[2] * k];
  });

  // Bathtub floor: a different, darker, heavier fabric, bulged where gear
  // pushes against it. Visible all the way round under the fly hem, which is
  // the band of value that stops the tent from ending in a hard black line.
  const floorTint = tintOf(cw.floor);
  P.add(patch((u, s, out) => {
    const phi = u * TAU;
    const v = s * vTub;
    innerBase(phi, v, out);
    const bulge = 1 + 0.022 * Math.sin(PI * s) + 0.014 * Math.sin(7 * phi + ph[1]) * Math.sin(PI * s);
    out.x *= bulge; out.z *= bulge;
    return out;
  }, 72, 6, innerRef), 'fabricIn', null, (x, y) => {
    const k = 0.46 + 0.34 * clamp01(y / 0.18);
    const dk = clamp01(smoothstep(0.06, 0.0, y)) * (0.18 + 0.3 * wear);
    return [
      floorTint[0] * k * (1 - dk) + 1.05 * dk,
      floorTint[1] * k * (1 - dk) + 0.98 * dk,
      floorTint[2] * k * (1 - dk) + 0.82 * dk,
    ];
  });

  // The floor itself, very slightly domed so it catches a little of whatever
  // light gets through the door instead of reading as a flat black plate.
  {
    const ring = [];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * TAU;
      ring.push(innerBase(phi, vTub * 0.22, new THREE.Vector3()).setY(0.026));
    }
    P.add(fan(V(0, 0.042, 0), ring, true), 'fabricIn', null,
      [floorTint[0] * 0.9, floorTint[1] * 0.9, floorTint[2] * 0.9]);
  }

  // Somebody's kit, on the floor, visible through the door.
  //
  // This is four primitives and it is worth more than any of them: an aperture
  // with nothing behind it is a hole, and an aperture with a rolled pad and a
  // stuff sack behind it is a room somebody sleeps in. Everything in here is
  // tinted well up because it lives inside the fly's own shadow, where the
  // renderer gives it almost nothing and its true value would be black.
  {
    const inX = A * iS * 0.52, inZ = B * iS * 0.34;
    const pad = V(-inX * 0.35, 0.10, -inZ * 0.30);
    const padEnd = V(inX * 0.72, 0.095, inZ * 0.55);
    P.add(rod(0.082, pad.distanceTo(padEnd), 7), 'fabricIn', span(pad, padEnd, M()),
      [0.96, 0.80, 0.58]);                                  // a rolled foam pad
    // A sleeping bag, half unrolled, lying along the other side.
    const bagA = V(inX * 0.30, 0.085, -inZ * 0.95);
    const bagB = V(-inX * 0.55, 0.075, inZ * 0.85);
    P.add(rod(0.092, bagA.distanceTo(bagB), 7), 'fabricIn', span(bagA, bagB, M()),
      [0.58, 0.68, 0.90]);
    // A stuff sack propped against the back wall.
    P.add(rbox(0.17, 0.15, 0.16, 0.055), 'fabricIn',
      at(inX * 0.55, 0.085, -inZ * 1.25, 0, 0.5, 0.12), [0.82, 0.76, 0.60]);
    // A head torch hanging from the canopy, off centre.
    P.add(rbox(0.05, 0.028, 0.028, 0.010), 'plastic',
      at(-A * iS * 0.18, profY(0.62) * iH, -B * iS * 0.10, 0, 0.3, 0), [1.15, 1.15, 1.15]);
  }

  // The mesh inner door, zipped shut on the colourways whose plate shows it
  // that way. Solid dark geometry rather than an alpha panel: a real screen at
  // 20 m is pure aliasing crawl, and the value is all the read needs.
  if (!cw.doorOpen) {
    P.add(patch((u, s, out) => {
      const phi = HALF - doorPhi * 0.62 + u * doorPhi * 1.24;
      return innerBase(phi, lerp(vTub, innerDoor(phi), s), out);
    }, 34, 8, innerRef), 'mesh', null, [1.5, 1.45, 1.4]);
  }

  // ── the poles ──────────────────────────────────────────────────────────────
  // The last 120 mm of each pole, below the fly hem, going into a grommet at
  // the corner webbing. Four bright thin lines under four dark hem corners:
  // cheap, and it is the detail that says the dome has a frame in it.
  const poleTint = tintOf(cw.pole);
  const feet = [];
  for (let k = 0; k < 4; k++) {
    const pp = QUARTER + k * HALF;
    // Start it well up inside the hem so a real length of pole shows below the
    // fly. Round two started it at v = 0.012 — 26 mm of tube, invisible at any
    // distance, and the corners read as fabric resting on nothing.
    const top = surf(pp, 0.085, new THREE.Vector3()).addScaledVector(normalAt(pp, 0.085, new THREE.Vector3()), -0.016);
    const dir = new THREE.Vector3(top.x, 0, top.z).normalize();
    const foot = V(top.x + dir.x * 0.030, 0.012, top.z + dir.z * 0.030);
    feet.push({ pp, top, foot, dir });
    P.add(tube(0.0058, top.distanceTo(foot), 6), 'alu', span(top, foot, M()), poleTint);
    // Ferrule where the pole enters the ground grommet.
    P.add(rbox(0.030, 0.020, 0.026, 0.006), 'plastic', at(foot.x, 0.016, foot.z, 0, -pp, 0), [1, 1, 1]);
  }

  // ── hardware: corner webbing, buckles, stakes, guy lines ───────────────────
  const cordTint = [1, 1, 1];
  const stakeAt = (p, awayDir) => {
    // Angled away from the tent and driven most of the way in, the way anybody
    // who has had a fly let go in the night drives them.
    const head = V(p.x, 0.052, p.z);
    const tip = V(p.x + awayDir.x * 0.062, -0.145, p.z + awayDir.z * 0.062);
    P.add(rod(0.0055, head.distanceTo(tip), 6), 'tube', span(head, tip, M()), [1, 1, 1]);
    P.add(rbox(0.022, 0.006, 0.014, 0.002), 'tube', at(head.x, head.y + 0.004, head.z, 0, Math.atan2(awayDir.x, awayDir.z), 0), [1, 1, 1]);
    return head;
  };

  for (const f of feet) {
    // Webbing strap from the hem corner out to its stake.
    const sp = V(f.foot.x + f.dir.x * 0.085, 0, f.foot.z + f.dir.z * 0.085);
    const head = stakeAt(sp, f.dir);
    const a = V(f.foot.x, 0.030, f.foot.z);
    const len = a.distanceTo(head);
    const m = span(a, head, M());
    P.add(rbox(0.026, len, 0.004, 0.0015), 'cord', m, [acc[0] * 0.9 + 0.1, acc[1] * 0.9 + 0.1, acc[2] * 0.9 + 0.1]);
    // A ladder-lock buckle partway along it.
    const mid = new THREE.Vector3().lerpVectors(a, head, 0.42);
    P.add(rbox(0.030, 0.021, 0.007, 0.002), 'plastic',
      at(mid.x, mid.y + 0.004, mid.z, 0, Math.atan2(f.dir.x, f.dir.z), 0), [1, 1, 1]);
  }

  for (const gy of ties) {
    const anchor = surf(gy.phi, gy.v, new THREE.Vector3());
    const nrm = normalAt(gy.phi, gy.v, new THREE.Vector3());
    anchor.addScaledVector(nrm, 0.010);
    // A reinforcement patch where the line pulls on the fly.
    // A reinforcement patch where the line pulls on the fly. Small: at 52 mm
    // in a saturated accent it read as a signal flag stuck to the tent.
    P.add(rbox(0.046, 0.046, 0.004, 0.009), 'fabric', orient(anchor, nrm),
      [acc[0] * 0.78 + 0.06, acc[1] * 0.78 + 0.06, acc[2] * 0.78 + 0.06]);

    const away = new THREE.Vector3(nrm.x, 0, nrm.z).normalize();
    const reach = 0.40 + 0.06 * (1 - gy.v);
    const sp = V(anchor.x + away.x * reach, 0, anchor.z + away.z * reach);
    const head = stakeAt(sp, away);

    // The line. One of them is slack, and it is the first thing the eye finds.
    const sag = 0.006 + gy.slack;
    P.add(sweptArc((t) => {
      const p = new THREE.Vector3().lerpVectors(anchor, head, t);
      p.y -= sag * 4 * t * (1 - t);
      return p;
    }, 16, 0.0052, 5), 'cord', null, cordTint);
    // Line-lok tensioner, three quarters of the way down.
    const tn = new THREE.Vector3().lerpVectors(anchor, head, 0.72);
    tn.y -= sag * 4 * 0.72 * 0.28;
    P.add(rbox(0.026, 0.034, 0.006, 0.003), 'plastic',
      at(tn.x, tn.y, tn.z, 0, Math.atan2(away.x, away.z), 0), [1, 1, 1]);
  }

  // ── vestibule ──────────────────────────────────────────────────────────────
  // The brow over the door, and the second thing on this prop that has to read
  // as cloth. Two earlier attempts got it wrong in instructive ways: staked
  // flat to the dirt it was a curtain drawn across the door, and built as one
  // `fabricPanel` quad between four corners it was a paper wing stuck on the
  // side of a dome — flat, straight-edged, and plainly a different object from
  // the fly it grows out of.
  //
  // So it is swept, not spanned. The fabric leaves the fly tangentially at the
  // brow seam, arcs forward over a pole, and falls to a leading edge that is
  // high in the middle (the pole holds it) and low at the corners (the lines
  // pull them down) — which is the shape in the first plate, and the shape a
  // straight-edged quad can never make. `fabricPanel` still builds the two
  // skins; it is handed a warp that does the sweeping, exactly the way the
  // chair author uses it for a sling that is not a rectangle either.
  {
    const browPhiL = HALF + 0.48, browPhiR = HALF - 0.48;
    const browV = 0.60;

    // Where the leading edge sits: mid-height at the centre, dropping at the
    // corners. Measured off the brow seam so it tracks tent height.
    const seamY = surf(HALF, browV, new THREE.Vector3()).y;
    const lipMidY = seamY - 0.115;
    const lipCornerY = seamY - 0.40;
    const outZ = B + cw.vest;

    // The four nominal corners `fabricPanel` spans; everything interesting
    // happens in the warp between them.
    const bl = surf(browPhiL, browV, new THREE.Vector3());
    const br = surf(browPhiR, browV, new THREE.Vector3());
    const fl = V(-A * 0.62, lipCornerY, B + cw.vest * 0.55);
    const fr = V(A * 0.62, lipCornerY, B + cw.vest * 0.55);

    // The seam curve on the fly and the leading-edge curve, sampled by u.
    const seamAt = (u, out) => surf(lerp(browPhiL, browPhiR, u), browV, out);
    const lipAt = (u, out) => {
      const k = 1 - (2 * u - 1) * (2 * u - 1);              // 1 centre, 0 corners
      return out.set(
        lerp(fl.x, fr.x, u) * (1 - 0.10 * k),
        lerp(lipCornerY, lipMidY, Math.pow(k, 0.72)) - 0.035 * k,
        lerp(B + cw.vest * 0.55, outZ, Math.pow(k, 0.55)),
      );
    };

    const _s = new THREE.Vector3(), _l = new THREE.Vector3(), _c = new THREE.Vector3();
    const hood = (u, v, p) => {
      seamAt(u, _s); lipAt(u, _l);
      // Quadratic Bezier: the control point lifts the sheet over the brow pole
      // so the fabric arcs instead of ramping, which is the difference between
      // an awning and a lean-to made of card.
      _c.lerpVectors(_s, _l, 0.42).add(V(0, 0.085 * (1 - Math.abs(2 * u - 1) * 0.5), 0.045));
      const w = 1 - v;
      p.set(
        w * w * _s.x + 2 * w * v * _c.x + v * v * _l.x,
        w * w * _s.y + 2 * w * v * _c.y + v * v * _l.y,
        w * w * _s.z + 2 * w * v * _c.z + v * v * _l.z,
      );
      // Cross-wise slack between the two side edges, deepest under the pole.
      p.y -= 0.030 * Math.sin(PI * u) * Math.sin(PI * Math.pow(v, 0.8));
      // Creases raking off the two corners the lines pull on.
      const dl = Math.hypot(u * 1.1, 1 - v), dr = Math.hypot((1 - u) * 1.1, 1 - v);
      p.y += 0.020 * Math.cos(5 * Math.atan2(1 - v, u * 1.1) + ph[0]) * (dl / 0.45) * Math.exp(-(dl / 0.45) * (dl / 0.45));
      p.y += 0.020 * Math.cos(5 * Math.atan2(1 - v, (1 - u) * 1.1) + ph[1]) * (dr / 0.45) * Math.exp(-(dr / 0.45) * (dr / 0.45));
      // And the general slackness of a panel nobody re-tensioned.
      p.y += 0.011 * Math.sin(u * 9 + ph[2] + v * 3.0) * Math.sin(PI * v);
      return p;
    };

    // NOTE the 1 - u. `fabricPanel` takes its facing from cross(dp/du, dp/dv),
    // and with u running left → right along the brow that cross product points
    // down and back: round three rendered the awning's *underside* upwards and
    // the brow came out as a dark cave over the door. Running u the other way
    // flips it. The lower skin keeps the same winding on purpose — it is
    // `fabricIn`, which is double-sided, so the face you actually see from
    // below is a back face and three flips its normal for you.
    const skin = (u, v, p) => hood(1 - u, v, p);
    const corners = [bl, br, fr, fl];
    P.add(fabricPanel(corners, 26, 16, 0, skin), 'fabric', null, flyTint);
    P.add(fabricPanel(corners, 26, 16, 0,
      (u, v, p) => { skin(u, v, p); p.y -= 0.010; }), 'fabricIn', null,
      (x, y, z) => { const t = flyTint(x, y + 0.010, z); return [t[0] * 0.60, t[1] * 0.60, t[2] * 0.66]; });

    // The brow pole along the seam, and the two lines holding the corners down.
    P.add(sweptArc((t) => {
      const phi = lerp(browPhiL, browPhiR, t);
      const p = surf(phi, browV, new THREE.Vector3());
      return p.addScaledVector(normalAt(phi, browV, new THREE.Vector3()), 0.016);
    }, 20, 0.0095, 5), 'alu', null, poleTint);

    for (const u of [0.0, 1.0]) {
      const c = lipAt(u, new THREE.Vector3());
      hood(u, 1, c);
      const sp = V(c.x * 1.12, 0, c.z + 0.10);
      const away = V(sp.x, 0, sp.z).normalize();
      const head = stakeAt(sp, away);
      P.add(sweptArc((t) => {
        const q = new THREE.Vector3().lerpVectors(c, head, t);
        q.y -= 0.010 * 4 * t * (1 - t);
        return q;
      }, 10, 0.0052, 5), 'cord', null, cordTint);
      P.add(rbox(0.028, 0.020, 0.006, 0.002), 'plastic',
        at(c.x, c.y - 0.024, c.z, 0.4, Math.atan2(away.x, away.z), 0), [1, 1, 1]);
    }
  }

  // ── rear vent ──────────────────────────────────────────────────────────────
  // A hooded vent low on the back panel. The back of a tent is the half of the
  // silhouette the player drives past, and without this it is a blank lobe.
  // Round two put it at v = 0.70 with a 75 mm lip, where it broke the crown
  // line from the front and read as a piece of litter stuck to the top.
  {
    const vPhi = -HALF, vV = 0.46, hw = 0.17;
    const l = surf(vPhi - hw, vV, new THREE.Vector3());
    const r = surf(vPhi + hw, vV, new THREE.Vector3());
    const nl = normalAt(vPhi - hw, vV, new THREE.Vector3());
    const nr = normalAt(vPhi + hw, vV, new THREE.Vector3());
    const bl2 = surf(vPhi - hw, vV - 0.115, new THREE.Vector3()).addScaledVector(nl, 0.048);
    const br2 = surf(vPhi + hw, vV - 0.115, new THREE.Vector3()).addScaledVector(nr, 0.048);
    // The dark slot behind the hood — a mesh panel, not a hole.
    P.add(fabricPanel([
      surf(vPhi - hw * 0.94, vV - 0.015, new THREE.Vector3()),
      surf(vPhi + hw * 0.94, vV - 0.015, new THREE.Vector3()),
      surf(vPhi + hw * 0.94, vV - 0.115, new THREE.Vector3()),
      surf(vPhi - hw * 0.94, vV - 0.115, new THREE.Vector3()),
    ], 5, 3, -0.018), 'mesh', null, [1.35, 1.3, 1.25]);
    P.add(fabricPanel([l, r, br2, bl2], 12, 7, 0,
      (u, v, p) => {
        p.y -= 0.020 * 4 * u * (1 - u) * Math.pow(v, 1.3);
        p.y += 0.006 * Math.sin(u * 13 + ph[3]) * v;
      }), 'fabric', null, (x, y, z) => {
      const t = flyTint(x, y, z); return [t[0] * 0.96, t[1] * 0.96, t[2] * 0.97];
    });
    // A stiffener strut across the hood's lip.
    P.add(tube(0.0042, bl2.distanceTo(br2), 5), 'alu', span(bl2, br2, M()), poleTint);
  }

  P.flush(g, { cast: true, receive: true });

  // ── footprint ──────────────────────────────────────────────────────────────
  // Measured rather than declared: the guy stakes are the outermost thing on
  // this prop and their reach depends on the colourway. The layout solver
  // currently passes a hard-coded 1.45 (see docs/CAMP_REQUESTS.md), so every
  // colourway is dimensioned to stay inside that.
  let fp = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    const a = o.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) {
      const d = a[i] * a[i] + a[i + 2] * a[i + 2];
      if (d > fp) fp = d;
    }
  });
  g.userData.footprint = clamp(Math.sqrt(fp) + 0.02, 1.25, 1.6);
  g.userData.colorway = cw.name;
  return g;
}

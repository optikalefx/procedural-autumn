// ─────────────────────────────────────────────────────────────────────────────
//  camp_telescope — the two telescopes in `reference-art/telescope/`.
//
//  Two objects, one builder, because they are the same object at two sizes and
//  the difference between them is most of what makes either one work:
//
//   · `refractor` — a GeoSafari-class 50/360 achromat: a 0.46 m white tube with
//     a black dew shield, a 45-degree diagonal, and a pan head on a light
//     three-section tripod. Waist high. The scope somebody's kid unpacks.
//   · `reflector` — an Omegon-class 150/750 Newtonian on a German equatorial
//     head: a 0.70 m white tube 0.19 m across in red rings, a counterweight on
//     a shaft, and a proper tripod with an accessory tray. Chest high, and it
//     is the single tallest thing in the camp after the tent.
//
//  Building both from one file is not thrift. The camp only ever gets ONE
//  telescope (see `camp_site.js`), so the two are never seen together, and the
//  only thing that makes them read as two different objects rather than as one
//  object at two scales is that the details differ in KIND — a diagonal versus
//  a side focuser, a pan handle versus a counterweight. Those decisions are
//  easier to keep honest with both bodies of geometry in front of you.
//
//  ── what the plates actually show, and what the model owes them ────────────
//
//  1. **The tube is the silhouette and it is white.** Squint at either plate
//     and what survives is one bright bar at an angle over a dark tripod. That
//     angle is the whole prop. Everything else — knobs, rings, the finder — is
//     detail that only exists once the bar and the angle are right, and the
//     first version of this file had the bar at 25 degrees, which reads as a
//     surveyor's level rather than as a telescope. It is 36 degrees on the
//     refractor and 41 on the reflector now, and both are jittered.
//
//  2. **White, but not the brightest thing in the camp.** The brief is explicit
//     that the fire owns the value range at dusk, and a white-painted tube is
//     the only object in this set that can compete with it. So the enamel is
//     authored at 0xdcd9d1 rather than at white, with the upward facets carried
//     the rest of the way by a baked sky gradient (see `skyGrad`) and the
//     underside allowed to fall well down. Measured at hour 20.4 the tube's
//     brightest pixel sits below the flame core; that is the constraint, not
//     the hex.
//
//  3. **Black is the drawing.** Both plates are a white cylinder interrupted by
//     black: a dew shield, end rings, a focuser, a mount. Those dark bands are
//     what stop the tube reading as a length of PVC pipe, and they are placed
//     where they break the bar into unequal segments — a black band at the
//     midpoint of a white tube is a mistake you can see from thirty metres.
//
//  4. **Metal.** There isn't any. `campMaterials()`'s `alu` / `steel` / `anod`
//     have `envMapIntensity` but no `envMap` and nothing sets
//     `scene.environment`, so a standard material at 0.9 metalness has no
//     diffuse term and nothing to reflect — it renders as flat near-black. The
//     table author measured this and logged it in `docs/CAMP_REQUESTS.md`; the
//     finding still holds. So every part of both telescopes is authored against
//     the dielectrics (`plastic`, `rubber`, `hdpe`) with `tintFrom()` carrying
//     it to the colour it should be, exactly as `camp_table.js` does. The named
//     descriptors at the top of this file are the two-line revert.
//
//  Geometry: origin at the ground under the tripod's centre, `+Z` is the side
//  the observer stands on — which is the eyepiece side — so `Camp.js`'s "yaw
//  the prop's +Z at the fire" leaves the telescope pointing out of the camp at
//  the dark sky, which is the only direction it can usefully point.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, at, rbox, tube, rod, sweptArc, dusted, tintFrom, tintMul, M,
} from './camp_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

// Base colours of the shared materials this file borrows. Same duplication the
// table carries and for the same reason: a mismatch here shows up as a
// wrong-coloured knob rather than as an error.
const HEX_PLASTIC = 0x2a2a2e;
const HEX_RUBBER  = 0x1b1b1e;
const HEX_HDPE    = 0x8f3a3c;

// ── the palette ──────────────────────────────────────────────────────────────
//
// ENAMEL is the tube white. Held two thirds of a stop under paper white for the
// reason in the header, and warmed very slightly: a neutral white tube in a
// valley whose whole grade is warm reads as a hole cut in the frame.
//
// SHELL is the black of a dew shield or an end ring — a *gloss* black, so it is
// lifted off true black. Real black anodising photographs at about 12% and the
// temptation to author it at 3% is what makes a prop look like a cut-out.
//
// CHROME is the counterweight shaft and the focuser knobs: a bright neutral
// that has to stand in for polished steel without any specular to help it, so
// it goes high and stays desaturated.
const ENAMEL = 0xdcd9d1;
const SHELL  = 0x26262a;
const CHROME = 0xb4b6b4;
const RED    = 0xa32a24;   // the reflector's tube rings
const LEGMET = 0xa8a9a6;   // mill-finish tripod leg

// Everything is a dielectric; see note 4 in the header.
const T_ENAMEL = tintFrom(HEX_PLASTIC, ENAMEL);
const T_SHELL  = tintFrom(HEX_PLASTIC, SHELL);
const T_CHROME = tintFrom(HEX_PLASTIC, CHROME);
const T_RED    = tintFrom(HEX_PLASTIC, RED);
const T_LEG    = tintFrom(HEX_PLASTIC, LEGMET);
const T_GLASS  = tintFrom(HEX_PLASTIC, 0x121620);
const T_FOOT   = tintFrom(HEX_RUBBER, 0x232326);

/**
 * Bake the sky into a part's upward-facing colour.
 *
 * The same problem `camp_table.js` solved for its frame and the same fix. A
 * white cylinder outdoors is not evenly lit: its top sees the whole dome and
 * its underside sees dirt, and a stylised renderer that quantises diffuse into
 * bands throws away most of that difference — which turns a tube into a flat
 * white lozenge and loses the roundness that is the entire read of the object.
 *
 * `k` is the strength. It is applied against the part's own local up, not the
 * world's, and only to the vertical component, so a tube inclined at 40 degrees
 * still gets a gradient around its circumference rather than along its length.
 *
 * @param base   [r,g,b] tint the part would otherwise have
 * @param axisY  fn(x,y,z) -> -1..1, how "up" this vertex's normal faces
 */
function skyGrad(base, k = 0.22, axisY = null) {
  return (x, y, z) => {
    const up = axisY ? axisY(x, y, z) : 0;
    const g = 1 + k * up;
    return [base[0] * g, base[1] * g, base[2] * g];
  };
}

/**
 * An orthonormal, right-handed basis with local +Y along `dir`.
 *
 * Placement helpers that use `setFromUnitVectors` (like the kit's `span()`)
 * pick *an* orientation about the axis rather than a chosen one. That is fine
 * for a round tube and wrong for everything on a telescope that has a side to
 * it: the focuser has to come out of the tube on a chosen bearing, the
 * counterweight shaft has to hang in the same plane as the optical tube, and
 * the accessory tray's arms have to reach the legs. So the roll is given.
 *
 * `ref` becomes local +X after being orthonormalised against the axis; local +Z
 * is x × y, in that order, so the determinant is positive and the winding
 * survives `tools/winding.mjs`.
 */
function basis(dir, ref = V(1, 0, 0)) {
  const y = dir.clone().normalize();
  let x = ref.clone().addScaledVector(y, -ref.dot(y));
  if (x.lengthSq() < 1e-9) x = V(0, 0, 1).addScaledVector(y, -y.z);
  if (x.lengthSq() < 1e-9) x = V(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return { x, y, z };
}

/** Matrix placing a Y-axis primitive centred at `pos`, aligned to `dir`. */
function axisAt(pos, dir, ref = V(1, 0, 0)) {
  const b = basis(dir, ref);
  return M().makeBasis(b.x, b.y, b.z).setPosition(pos);
}

/**
 * A cylinder — straight or tapered — spanning `a` to `b`.
 *
 * Six or eight sides by default rather than sixteen. The argument is the kit's
 * own, from `tube()`: a 24 mm focuser barrel is a handful of pixels at the
 * distance a player looks at a camp from, and a sixteen-sided cylinder at six
 * pixels is a crawling grey worm because no facet is ever a pixel wide. The
 * exception is the two OTAs themselves, which are 60 mm and 190 mm across and
 * *are* the silhouette; those get enough sides to have a real profile (see the
 * `sides` arguments at the call sites) because a hexagonal telescope tube reads
 * as a hexagonal telescope tube.
 */
function seg(P, key, a, b, r0, r1 = r0, sides = 8, tint = null, capped = true) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return;
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, !capped);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  P.add(g, key, axisAt(mid, dir), tint);
}

/** A flat disc facing along `dir` — a lens, a cap, an open tube mouth. */
function disc(P, key, pos, dir, r, sides = 16, tint = null) {
  const g = new THREE.CylinderGeometry(r, r, 0.002, sides, 1, false);
  P.add(g, key, axisAt(pos, dir), tint);
}

/** A knurled knob: a short cylinder with a raised rim, read as a grip. */
function knob(P, key, pos, dir, r, len, tint) {
  seg(P, key, pos.clone().addScaledVector(dir, -len * 0.5),
      pos.clone().addScaledVector(dir, len * 0.5), r, r, 10, tint);
  // Two proud rims. A knob without them is a bead; with them it is something
  // fingers turn, and at 8 px the pair reads as a highlight-shadow pair rather
  // than as two rings, which is exactly the read wanted.
  for (const s of [-0.36, 0.36]) {
    const c = pos.clone().addScaledVector(dir, len * s);
    seg(P, key, c.clone().addScaledVector(dir, -len * 0.10),
        c.clone().addScaledVector(dir, len * 0.10), r * 1.09, r * 1.09, 10, tint);
  }
}

/**
 * A bolt head — the small dark full stop that makes a joint read as a joint.
 *
 * Every hinge, clamp and bracket on both plates has one, and they are most of
 * why a photographed tripod looks like hardware and a modelled one looks like
 * three sticks. Cheap: eight triangles each.
 */
function bolt(P, pos, dir, r = 0.006, tint = T_CHROME) {
  seg(P, 'plastic', pos.clone().addScaledVector(dir, -0.002),
      pos.clone().addScaledVector(dir, 0.005), r, r * 0.92, 6, tint);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The tripod
//
//  Shared by both variants because both plates show the same machine: three
//  legs splayed off a hub, a spreader or tray tying them together, rubber feet.
//  What differs is section (round-ish extrusion on the small one, square on the
//  big one), whether the legs telescope, and what the spreader is.
//
//  Two things here are load-bearing and neither is obvious:
//
//  · **The legs are not evenly spaced in the frame.** They are at 120 degrees
//    in plan, which means from any viewpoint two are near and one is far, or
//    the reverse — and which of those you get changes the silhouette
//    completely. The hub is rolled by `spin` so a camp does not always show the
//    same one. It matters more than it sounds: the "two front legs, one behind"
//    view is the one both plates were shot from and is much the stronger image,
//    so the roll is biased toward it rather than uniform.
//
//  · **The feet are on the ground, all three of them, and the model is what
//    guarantees it.** `Camp.js` stands a prop on the terrain normal, and this
//    prop asks for very little of that normal (`tilt` is 0.3 in the layout)
//    because a telescope is the one object in a camp that somebody deliberately
//    levelled. The cost is that on a slope one foot can hang; the fix is that
//    the feet are soft cones rather than flat pads, so a millimetre of hang
//    does not read as a gap.
// ─────────────────────────────────────────────────────────────────────────────
function buildTripod(P, rnd, {
  height,          // hub top, in metres
  spread,          // foot radius, in metres
  legR,            // leg half-section
  square = false,  // square extrusion (reflector) vs round-ish (refractor)
  spin = 0,        // roll of the leg triad in plan
  tray = null,     // 'spreader' | 'tray' | null
  wear = 0.5,
}) {
  const hubR = square ? 0.052 : 0.034;
  const hub = V(0, height, 0);
  const legs = [];

  for (let i = 0; i < 3; i++) {
    const a = spin + (i / 3) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Each leg's own splay wanders a little. A tripod whose three legs are at
    // identical angles is a CAD render; a real one has been set down on uneven
    // ground and nobody straightened it afterwards.
    const sp = spread * (1 + (rnd() - 0.5) * 0.07);
    const top = V(ca * hubR, height - 0.012, sa * hubR);
    const foot = V(ca * sp, 0.030, sa * sp);
    const dir = new THREE.Vector3().subVectors(foot, top).normalize();
    // Outward, in the plane of the leg — the axis the leg's flat faces and its
    // hardware are oriented against.
    const out = V(ca, 0, sa);
    legs.push({ a, top, foot, dir, out, ca, sa });
  }

  const legTint = tintMul(dusted([1, 1, 1], { top: 0.16, amount: 0.22 + wear * 0.20 }), T_LEG);

  for (const L of legs) {
    // Where the leg changes section. The reference tripods both telescope: an
    // outer section from the hub down to a clamp, then a thinner inner section
    // to the foot. That clamp is a strong dark accent two thirds of the way
    // down a bright leg and it is the main thing keeping the leg from reading
    // as one undifferentiated stick.
    const clampT = square ? 0.56 : 0.62;
    const mid = new THREE.Vector3().lerpVectors(L.top, L.foot, clampT);

    if (square) {
      // A box beam, rolled so one flat faces out of the tripod. Built by hand
      // rather than with `rbox` + `span()` for the reason in `basis()`: the
      // roll has to be chosen, and a randomly rolled square leg looks like a
      // modelling error rather than like a leg.
      const b = basis(L.dir, L.out);
      const up = new THREE.Vector3().lerpVectors(L.top, mid, 0.5);
      const lo = new THREE.Vector3().lerpVectors(mid, L.foot, 0.5);
      const put = (c, ab, w, d) => {
        const g = rbox(w, ab, d, Math.min(w, d) * 0.30, 1);
        P.add(g, 'plastic', M().makeBasis(b.x, b.y, b.z).setPosition(c), legTint);
      };
      put(up, L.top.distanceTo(mid), legR * 2.0, legR * 1.5);
      put(lo, mid.distanceTo(L.foot) + 0.02, legR * 1.52, legR * 1.14);
    } else {
      seg(P, 'plastic', L.top, mid, legR * 1.06, legR, 6, legTint);
      seg(P, 'plastic', mid, L.foot.clone().addScaledVector(L.dir, 0.01),
          legR * 0.76, legR * 0.72, 6, legTint);
    }

    // The clamp: a collar with a lever. Dark, and deliberately a little
    // oversized — on the plates it is the widest thing on the leg.
    {
      const c = mid.clone();
      seg(P, 'plastic', c.clone().addScaledVector(L.dir, -0.016),
          c.clone().addScaledVector(L.dir, 0.014), legR * 1.5, legR * 1.42, 8,
          square ? T_ENAMEL : T_SHELL);
      // The lever sticks out sideways, catching light against the leg.
      const lev = c.clone().addScaledVector(L.out, legR * 1.5);
      const lv = rbox(0.030, 0.010, 0.013, 0.004, 1);
      P.add(lv, 'plastic', M().makeBasis(
        basis(L.dir, L.out).x, basis(L.dir, L.out).y, basis(L.dir, L.out).z,
      ).setPosition(lev), square ? T_ENAMEL : T_SHELL);
      bolt(P, c.clone().addScaledVector(L.out, legR * 1.55), L.out, 0.005);
    }

    // The bracket at the hub: a black clevis the leg hinges in, with its bolt.
    {
      const c = L.top.clone().addScaledVector(L.dir, 0.026);
      seg(P, 'plastic', c.clone().addScaledVector(L.dir, -0.036),
          c.clone().addScaledVector(L.dir, 0.020), legR * 1.62, legR * 1.5, 6, T_SHELL);
      bolt(P, c.clone().addScaledVector(L.out, legR * 1.7), L.out, 0.0065);
    }

    // The foot: a rubber ferrule on the end of the tilted leg, and under it a
    // swivel pad that lies FLAT on the ground.
    //
    // The pad is not a detail, it is the contact shadow. `Camp.js` stands this
    // prop on very little of the terrain normal (`tilt` 0.22 in the layout,
    // because a tripod is the one thing in a camp somebody levelled), which
    // means the model itself has to guarantee that all three feet reach the
    // dirt on ground the prop is not aligned to. A cone tipped along the leg
    // axis does not: it ends in a point, the point is the only thing that can
    // touch, and the first build measured its lowest vertex at -27 mm — a
    // quarter of the way through the terrain, and the brief's limit is -10.
    // A flat pad bottoming out at +3 mm cannot sink, and it puts a small dark
    // ellipse under each leg, which is what glues a spindly thing down.
    {
      const f = L.foot.clone().addScaledVector(L.dir, -0.010);
      seg(P, 'rubber', f, L.foot.clone().addScaledVector(L.dir, 0.014),
          legR * 1.24, legR * 1.06, 8, T_FOOT);
      const pc = V(L.foot.x, 0.0, L.foot.z);
      seg(P, 'rubber', pc.clone().add(V(0, 0.0035, 0)), pc.clone().add(V(0, 0.030, 0)),
          legR * 1.32, legR * 1.02, 10, T_FOOT);
    }
  }

  // ── what ties the legs together ──────────────────────────────────────────
  if (tray === 'spreader') {
    // The small tripod's three-arm brace: a hub on the centre column with a
    // flat bar out to each leg. Thin — 5 mm stock — and it must stay thin;
    // fattening it to stop it aliasing is the mistake the brief names.
    const y = height * 0.36;
    const hubP = V(0, y, 0);
    seg(P, 'plastic', hubP.clone().add(V(0, -0.010, 0)), hubP.clone().add(V(0, 0.010, 0)),
        0.024, 0.024, 8, T_SHELL);
    for (const L of legs) {
      const t = (L.top.y - y) / Math.max(1e-4, L.top.y - L.foot.y);
      const p = new THREE.Vector3().lerpVectors(L.top, L.foot, t);
      const dir = new THREE.Vector3().subVectors(p, hubP);
      const len = dir.length();
      const b = basis(dir.clone().normalize(), V(0, 1, 0));
      const g = rbox(0.030, len * 0.97, 0.006, 0.002, 1);
      P.add(g, 'plastic', M().makeBasis(b.x, b.y, b.z)
        .setPosition(new THREE.Vector3().addVectors(hubP, p).multiplyScalar(0.5)), T_SHELL);
      bolt(P, p.clone().addScaledVector(L.out, -0.004).add(V(0, 0.006, 0)), V(0, 1, 0), 0.005);
    }
    // The centre column the hub rides on, running up into the head.
    seg(P, 'plastic', V(0, y - 0.03, 0), V(0, height + 0.005, 0), 0.014, 0.014, 6, T_LEG);
  } else if (tray === 'tray') {
    // The big tripod's accessory tray: the scalloped triangle in the plate,
    // built as a hub with three lobes. It reads at distance as a dark triangle
    // slung under the mount, and that dark triangle low in the silhouette is
    // what makes the tripod look loaded rather than empty.
    const y = height * 0.40;
    const hubP = V(0, y, 0);
    for (const L of legs) {
      const t = (L.top.y - y) / Math.max(1e-4, L.top.y - L.foot.y);
      const p = new THREE.Vector3().lerpVectors(L.top, L.foot, t);
      const dir = new THREE.Vector3().subVectors(p, hubP);
      const len = dir.length();
      const b = basis(dir.clone().normalize(), V(0, 1, 0));
      // The lobe: wide at the leg, narrow at the hub, with a raised lip.
      const g = new THREE.CylinderGeometry(0.055, 0.055, 0.008, 12, 1, false);
      P.add(g, 'plastic', M().setPosition(p.clone().addScaledVector(
        dir.clone().normalize(), -0.030)), T_SHELL);
      const bar = rbox(0.062, len * 0.92, 0.008, 0.003, 1);
      P.add(bar, 'plastic', M().makeBasis(b.x, b.y, b.z)
        .setPosition(new THREE.Vector3().addVectors(hubP, p).multiplyScalar(0.5)), T_SHELL);
      // The clip that grips the leg.
      seg(P, 'plastic', p.clone().addScaledVector(L.dir, -0.014),
          p.clone().addScaledVector(L.dir, 0.014), legR * 1.44, legR * 1.44, 8, T_ENAMEL);
    }
    seg(P, 'plastic', hubP.clone().add(V(0, -0.006, 0)), hubP.clone().add(V(0, 0.008, 0)),
        0.046, 0.046, 12, T_SHELL);
    // The bolt and the white knob under the tray — the tray tensions the legs,
    // and this is the object that says so.
    seg(P, 'plastic', V(0, y - 0.055, 0), V(0, y + 0.004, 0), 0.011, 0.011, 6, T_CHROME);
    knob(P, 'plastic', V(0, y - 0.068, 0), V(0, 1, 0), 0.020, 0.026, T_ENAMEL);
    seg(P, 'plastic', V(0, y, 0), V(0, height - 0.03, 0), 0.017, 0.017, 6, T_LEG);
  }

  // The hub casting itself.
  seg(P, 'plastic', hub.clone().add(V(0, -0.030, 0)), hub.clone().add(V(0, 0.006, 0)),
      hubR * 1.20, hubR * 1.34, 12, square ? T_ENAMEL : T_SHELL);

  return { hub, legs, spread };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Variant A — the small refractor
// ─────────────────────────────────────────────────────────────────────────────
function buildRefractor(P, rnd, opts) {
  const wear = clamp01(opts.wear ?? 0.5);
  // Altitude of the optical axis. Jittered, because a camp where the telescope
  // is always at the same angle is a camp with one telescope in it, and because
  // the angle is the prop's whole silhouette.
  const alt = lerp(0.52, 0.72, rnd());
  const H_HUB = 0.545;
  const tripod = buildTripod(P, rnd, {
    height: H_HUB, spread: 0.255, legR: 0.0115, square: false,
    // Biased to put two legs toward +Z (the observer's side), which is the
    // stronger of the two silhouettes — see the note in `buildTripod`.
    spin: Math.PI * 0.5 + (rnd() - 0.5) * 1.1,
    tray: 'spreader', wear,
  });

  // ── the head ──────────────────────────────────────────────────────────────
  // A pan-tilt head: a black body with the big knurled tilt knob on one side —
  // the object that most says "cheap alt-az mount" in the plate, and it is
  // nearly as wide as the tube, so it is doing real compositional work as the
  // dark node between the bright tube and the bright legs.
  const pivot = V(0, H_HUB + 0.088, 0);
  {
    seg(P, 'plastic', V(0, H_HUB, 0), V(0, H_HUB + 0.030, 0), 0.030, 0.026, 10, T_SHELL);
    const body = rbox(0.052, 0.062, 0.058, 0.012, 2);
    P.add(body, 'plastic', at(0, H_HUB + 0.058, 0), T_SHELL);
    // The tilt knob, on the -X flank.
    knob(P, 'plastic', V(-0.040, H_HUB + 0.062, 0), V(1, 0, 0), 0.026, 0.030, T_SHELL);
    bolt(P, V(-0.056, H_HUB + 0.062, 0), V(-1, 0, 0), 0.007, T_CHROME);
    // …and a stub of the pan handle on the other side, angled back and down.
    const hd = V(0.62, -0.62, 0.48).normalize();
    const h0 = V(0.026, H_HUB + 0.056, 0.010);
    seg(P, 'plastic', h0, h0.clone().addScaledVector(hd, 0.075), 0.0075, 0.0065, 6, T_SHELL);
    seg(P, 'plastic', h0.clone().addScaledVector(hd, 0.070),
        h0.clone().addScaledVector(hd, 0.115), 0.0105, 0.0095, 8, T_SHELL);
  }

  // ── the optical tube ──────────────────────────────────────────────────────
  //
  // Along the axis, `s` runs positive toward the objective. The segment lengths
  // are the reference's: a 110 mm dew shield, a 240 mm painted tube, then
  // 150 mm of black focuser and diagonal hanging off the back. That the black
  // is 40% of the length and all of it at one end is the thing that makes the
  // silhouette asymmetric, and asymmetry is what makes it read as an instrument
  // pointed somewhere rather than as a bar balanced on a stick.
  const dir = V(0, Math.sin(alt), -Math.cos(alt));      // toward the objective
  const back = dir.clone().negate();
  // Perpendicular to the tube, in the vertical plane, pointing up-and-toward
  // the observer: the diagonal folds the light through 90 degrees into this.
  const upPerp = V(0, Math.cos(alt), Math.sin(alt));
  const side = V(1, 0, 0);
  const P0 = (s, o = 0) => pivot.clone().addScaledVector(dir, s).addScaledVector(upPerp, o);

  // How "up" a point on the tube's surface faces, for the sky gradient. Taken
  // from the point's offset from the axis rather than from a normal, because
  // `Parts.add` recomputes normals after the tint has already been baked.
  const axisUp = (ox, oy, oz) => {
    const p = V(ox, oy, oz).sub(pivot);
    const along = p.dot(dir);
    p.addScaledVector(dir, -along);
    const l = p.length();
    return l < 1e-5 ? 0 : p.dot(upPerp) / l;
  };
  const enamel = tintMul(skyGrad(T_ENAMEL, 0.26, axisUp),
                         dusted([1, 1, 1], { top: 0.02, amount: 0.0 }));
  const shell = skyGrad(T_SHELL, 0.55, axisUp);

  // dew shield → tube → rear cell
  seg(P, 'plastic', P0(0.185), P0(0.300), 0.0345, 0.0355, 14, shell);
  // The objective, recessed inside the shield: a dark disc with a cool rim. It
  // is 8 px of near-black at the end of a bright tube and it is the single
  // cheapest detail in the file — without it the tube is a length of pipe.
  disc(P, 'plastic', P0(0.276), dir, 0.0295, 16, T_GLASS);
  seg(P, 'plastic', P0(0.166), P0(0.190), 0.0300, 0.0345, 14, shell);
  seg(P, 'plastic', P0(-0.050), P0(0.170), 0.0300, 0.0300, 14, enamel);
  // A ring band where the reference has its logo — a value break in the middle
  // third, subtle, so the white does not run 240 mm without an interruption.
  seg(P, 'plastic', P0(0.030), P0(0.044), 0.0304, 0.0304, 14,
      skyGrad([T_ENAMEL[0] * 0.80, T_ENAMEL[1] * 0.80, T_ENAMEL[2] * 0.80], 0.26, axisUp));
  // rear cell
  seg(P, 'plastic', P0(-0.082), P0(-0.046), 0.0330, 0.0326, 12, shell);

  // The saddle: the tube is clamped to the head by a small cradle. Without it
  // the tube floats over the mount, which was the first version's loudest tell.
  {
    const c = P0(-0.010, -0.030);
    const b = basis(upPerp, dir);
    P.add(rbox(0.044, 0.030, 0.052, 0.006, 1), 'plastic',
      M().makeBasis(b.x, b.y, b.z).setPosition(c), T_SHELL);
    seg(P, 'plastic', P0(-0.010, -0.046), V(0, H_HUB + 0.078, 0), 0.017, 0.020, 8, T_SHELL);
    bolt(P, P0(-0.010, -0.052).addScaledVector(side, 0.020), side, 0.006);
  }

  // ── focuser, diagonal, eyepiece ───────────────────────────────────────────
  const EP_OUT = V(0, 0, 0);
  {
    // The focuser body, then the drawtube sliding out of it.
    seg(P, 'plastic', P0(-0.118), P0(-0.078), 0.0250, 0.0250, 10, shell);
    seg(P, 'plastic', P0(-0.150), P0(-0.114), 0.0198, 0.0198, 10, shell);
    // The big white focus knob. On the plate it is the brightest small object
    // on the whole scope and it sits right where the eye lands — keep it white.
    const kc = P0(-0.100).addScaledVector(side, 0.030);
    knob(P, 'plastic', kc, side, 0.0225, 0.016, T_ENAMEL);
    knob(P, 'plastic', P0(-0.100).addScaledVector(side, -0.030), side, 0.0145, 0.012, T_SHELL);
    seg(P, 'plastic', P0(-0.100).addScaledVector(side, -0.026),
        P0(-0.100).addScaledVector(side, 0.026), 0.0075, 0.0075, 6, T_CHROME);

    // The 45-degree diagonal: a black elbow, then the eyepiece out of its top
    // face along `upPerp`.
    const d0 = P0(-0.168);
    seg(P, 'plastic', P0(-0.152), d0, 0.0215, 0.0230, 10, shell);
    const ep0 = d0.clone().addScaledVector(upPerp, 0.012);
    seg(P, 'plastic', ep0, ep0.clone().addScaledVector(upPerp, 0.030), 0.0215, 0.0180, 10, shell);
    seg(P, 'plastic', ep0.clone().addScaledVector(upPerp, 0.026),
        ep0.clone().addScaledVector(upPerp, 0.062), 0.0158, 0.0150, 10, shell);
    // The rubber eyecup, folded down, and the dark hole in it.
    seg(P, 'rubber', ep0.clone().addScaledVector(upPerp, 0.058),
        ep0.clone().addScaledVector(upPerp, 0.076), 0.0165, 0.0182, 10, T_FOOT);
    disc(P, 'plastic', ep0.clone().addScaledVector(upPerp, 0.074), upPerp, 0.0105, 12, T_GLASS);
    EP_OUT.copy(ep0).addScaledVector(upPerp, 0.082);

    // The little angled accessory plate under the diagonal — the flat black
    // shade in the plate. Modelled thin and given a real tilt so it catches a
    // different value from everything around it; it is the one silhouette
    // element on this scope that is not a cylinder, which is why it is worth
    // the twelve triangles.
    const pd = upPerp.clone().multiplyScalar(-0.55).addScaledVector(back, 0.83).normalize();
    const pc = d0.clone().addScaledVector(pd, 0.052).addScaledVector(back, 0.006);
    const pb = basis(pd, side);
    P.add(rbox(0.070, 0.052, 0.005, 0.002, 1), 'plastic',
      M().makeBasis(pb.x, pb.y, pb.z).setPosition(pc), T_SHELL);
    seg(P, 'plastic', d0.clone().addScaledVector(pd, 0.012),
        d0.clone().addScaledVector(pd, 0.034), 0.010, 0.009, 6, T_SHELL);
  }

  return {
    tripod,
    top: pivot.y + 0.30 * Math.sin(alt) + 0.05,
    // Where a person's eye goes and what they see when it is there. Published
    // so `camp_scope_view.js` can put the camera exactly at the eyepiece rather
    // than guessing from a bounding box — a guess is wrong by 100 mm and 15
    // degrees, and at a 12-degree field of view that is a different sky.
    view: { eye: EP_OUT.clone(), aim: dir.clone() },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Variant B — the 150/750 Newtonian on a German equatorial head
//
//  The hard one, and what makes it hard is that the EQ head is a machine with
//  no symmetry at all: a polar axis raked over at the site's latitude, a
//  declination axis across it, a counterweight hanging off the back to balance
//  a tube that is nowhere near the mount's centre. Get that wrong and it reads
//  as a tube on a pole. Get it right and the counterweight sticking out one
//  side is the most distinctive silhouette in the whole camp.
// ─────────────────────────────────────────────────────────────────────────────
function buildReflector(P, rnd, opts) {
  const wear = clamp01(opts.wear ?? 0.5);
  const alt = lerp(0.60, 0.86, rnd());
  const H_HUB = 0.905;
  const tripod = buildTripod(P, rnd, {
    height: H_HUB, spread: 0.375, legR: 0.017, square: true,
    spin: Math.PI * 0.5 + (rnd() - 0.5) * 1.0,
    tray: 'tray', wear,
  });

  // The polar axis: raked back over the tripod, in the -Z half so the
  // counterweight swings out over +Z where it is visible from the observer's
  // side. 48 degrees, which is a plausible latitude for this valley and, more
  // to the point, is the rake that keeps the counterweight clear of the legs.
  const lat = 0.84;
  const pol = V(0, Math.sin(lat), -Math.cos(lat));
  // The mount's own "up": perpendicular to the polar axis, in the same vertical
  // plane. Everything bolted to the head — the saddle, the dovetail, the rings —
  // is offset along this rather than along world up, which is what makes the
  // whole assembly rake over together instead of looking bolted on afterwards.
  const mUp = V(0, Math.cos(lat), Math.sin(lat));
  const base = V(0, H_HUB + 0.030, 0);

  // The optical axis, hoisted: the saddle inside the head block is oriented
  // against it, because a dovetail runs along the tube and nothing else.
  const dir = V(0, Math.sin(alt), -Math.cos(alt));
  const upPerp = V(0, Math.cos(alt), Math.sin(alt));
  const side = V(1, 0, 0);

  // ── the head ──────────────────────────────────────────────────────────────
  {
    // Azimuth base and the latitude wedge, in the mount's own white.
    seg(P, 'plastic', V(0, H_HUB - 0.006, 0), base, 0.056, 0.050, 12, T_ENAMEL);
    const wed = rbox(0.062, 0.070, 0.084, 0.010, 1);
    P.add(wed, 'plastic', at(0, H_HUB + 0.058, -0.008, -0.30, 0, 0), T_ENAMEL);
    // The latitude bolt pushing on the wedge from behind — a bright horizontal
    // stub low on a white body, and it is what tells you the wedge adjusts.
    const lb = V(0, H_HUB + 0.040, 0.052);
    seg(P, 'plastic', lb, lb.clone().add(V(0, 0.012, 0.036)), 0.0075, 0.0075, 6, T_CHROME);
    knob(P, 'plastic', lb.clone().add(V(0, 0.016, 0.048)), V(0, 0.32, 0.95).normalize(),
         0.017, 0.020, T_SHELL);

    // The RA housing, along the polar axis.
    const ra0 = base.clone().addScaledVector(pol, 0.030);
    const ra1 = base.clone().addScaledVector(pol, 0.185);
    seg(P, 'plastic', ra0, ra1, 0.046, 0.042, 12, T_ENAMEL);
    // Setting-circle rings: two dark bands around the housing. Real ones are
    // engraved silver; here they are the value break that keeps a 155 mm white
    // cylinder from being a blank.
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.050),
        base.clone().addScaledVector(pol, 0.066), 0.0475, 0.0475, 12, T_SHELL);
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.150),
        base.clone().addScaledVector(pol, 0.162), 0.0445, 0.0445, 12, T_SHELL);
    // The polar-scope cap at the bottom end of the axis.
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.026),
        base.clone().addScaledVector(pol, 0.010), 0.024, 0.021, 10, T_SHELL);

    // The counterweight shaft, out of the bottom of the RA axis, and the weight
    // on it. This is the silhouette element — a bright bar and a heavy puck
    // hanging low on the opposite side from the tube.
    const cw = pol.clone().negate();
    const s0 = base.clone().addScaledVector(pol, 0.020);
    seg(P, 'plastic', s0, s0.clone().addScaledVector(cw, 0.300), 0.0092, 0.0092, 8, T_CHROME);
    const wc = s0.clone().addScaledVector(cw, 0.150);
    seg(P, 'plastic', wc.clone().addScaledVector(cw, -0.042),
        wc.clone().addScaledVector(cw, 0.042), 0.049, 0.049, 14,
        skyGrad(T_ENAMEL, 0.20, (x, y, z) => {
          const p = V(x, y, z).sub(wc); const a = p.dot(cw);
          p.addScaledVector(cw, -a); const l = p.length();
          return l < 1e-5 ? 0 : p.y / l;
        }));
    // Chamfers, so the weight is a machined puck and not a bead.
    seg(P, 'plastic', wc.clone().addScaledVector(cw, -0.049),
        wc.clone().addScaledVector(cw, -0.042), 0.040, 0.049, 14, T_ENAMEL);
    seg(P, 'plastic', wc.clone().addScaledVector(cw, 0.042),
        wc.clone().addScaledVector(cw, 0.049), 0.049, 0.040, 14, T_ENAMEL);
    knob(P, 'plastic', wc.clone().addScaledVector(cw, 0.056), cw, 0.014, 0.016, T_SHELL);
    // The safety stop at the very end of the shaft.
    seg(P, 'plastic', s0.clone().addScaledVector(cw, 0.292),
        s0.clone().addScaledVector(cw, 0.308), 0.014, 0.014, 8, T_SHELL);

    // The DEC housing, across the top of the polar axis.
    const dec = V(1, 0, 0).addScaledVector(pol, -V(1, 0, 0).dot(pol)).normalize();
    const dc = base.clone().addScaledVector(pol, 0.190);
    seg(P, 'plastic', dc.clone().addScaledVector(dec, -0.052),
        dc.clone().addScaledVector(dec, 0.062), 0.041, 0.041, 12, T_ENAMEL);
    seg(P, 'plastic', dc.clone().addScaledVector(dec, -0.058),
        dc.clone().addScaledVector(dec, -0.048), 0.0435, 0.0435, 12, T_SHELL);

    // Two slow-motion cables. They hang, they are the thinnest things on the
    // prop, and they are the detail that makes the mount look operable —
    // swept, not straight, because a flexible cable that is dead straight is
    // the most obvious modelled object on any telescope.
    const cable = (from, aim, len, droop) => {
      const a = aim.clone().normalize();
      const g = sweptArc((t) => from.clone()
        .addScaledVector(a, len * t)
        .add(V(0, -droop * t * t, 0)), 10, 0.0042, 5);
      P.add(g, 'plastic', null, T_CHROME);
      const end = from.clone().addScaledVector(a, len).add(V(0, -droop, 0));
      const kd = a.clone().add(V(0, -droop * 2, 0)).normalize();
      knob(P, 'plastic', end.clone().addScaledVector(kd, 0.016), kd, 0.0125, 0.026, T_SHELL);
    };
    cable(dc.clone().addScaledVector(dec, 0.060).add(V(0, -0.010, 0)),
          dec.clone().add(V(0, -0.35, 0.15)), 0.155, 0.055);
    cable(base.clone().addScaledVector(pol, 0.052).addScaledVector(dec, -0.040),
          dec.clone().negate().add(V(0, -0.20, 0.55)), 0.135, 0.048);

    // The saddle plate on the DEC axis, which the dovetail drops into.
    const sd = basis(mUp, dir);
    const sc = dc.clone().addScaledVector(mUp, 0.032);
    P.add(rbox(0.056, 0.028, 0.100, 0.006, 1), 'plastic',
      M().makeBasis(sd.x, sd.y, sd.z).setPosition(sc), T_SHELL);
    knob(P, 'plastic', sc.clone().addScaledVector(dec, 0.048), dec, 0.014, 0.024, T_SHELL);
  }

  // ── the optical tube ──────────────────────────────────────────────────────
  //
  // 190 mm across and 700 mm long, held in two rings on a dovetail above the
  // DEC axis. The tube's centre is offset from the mount by the ring height,
  // which is what puts it off to one side of the polar axis and gives the whole
  // machine its lopsided, counterweighted look.
  const R = 0.095;
  const dc = base.clone().addScaledVector(pol, 0.190);
  // Where the tube's axis sits: up off the saddle by the ring radius plus the
  // dovetail and the ring foot.
  const tubeC = dc.clone().addScaledVector(mUp, R + 0.086);
  const A = (s, o = 0, l = 0) => tubeC.clone()
    .addScaledVector(dir, s).addScaledVector(upPerp, o).addScaledVector(side, l);

  const axisUp = (ox, oy, oz) => {
    const p = V(ox, oy, oz).sub(tubeC);
    const along = p.dot(dir);
    p.addScaledVector(dir, -along);
    const l = p.length();
    return l < 1e-5 ? 0 : p.dot(upPerp) / l;
  };
  const enamel = skyGrad(T_ENAMEL, 0.30, axisUp);
  const shell = skyGrad(T_SHELL, 0.60, axisUp);

  // The tube: 20 sides, because at 190 mm across this is the one cylinder in
  // the file whose profile is the object.
  seg(P, 'plastic', A(-0.300), A(0.360), R, R, 20, enamel);
  // Front ring (the wide black band at the open end) and rear cell.
  seg(P, 'plastic', A(0.300), A(0.372), R * 1.012, R * 1.012, 20, shell);
  seg(P, 'plastic', A(-0.336), A(-0.296), R * 1.012, R * 1.008, 20, shell);
  // Open mouth: a dark disc set well back inside the tube. The single strongest
  // "this is a Newtonian" cue in the plate is that the front end is a hole.
  disc(P, 'plastic', A(0.300), dir, R * 0.985, 20, T_GLASS);
  // The secondary's spider and mirror, just visible in that hole.
  {
    const m = A(0.250);
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI * 0.5 + 0.4;
      const v = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(upPerp, Math.sin(a));
      seg(P, 'plastic', m.clone().addScaledVector(v, -R * 0.98),
          m.clone().addScaledVector(v, R * 0.98), 0.0032, 0.0032, 4, T_SHELL);
    }
    const md = dir.clone().multiplyScalar(-0.7).addScaledVector(side, 0.7).normalize();
    seg(P, 'plastic', m.clone().addScaledVector(md, -0.010), m.clone().addScaledVector(md, 0.010),
        0.024, 0.024, 10, T_SHELL);
  }
  // The rear cell's collimation bolts.
  for (let i = 0; i < 3; i++) {
    const a = i * (TAU / 3) + 0.5;
    const v = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(upPerp, Math.sin(a));
    bolt(P, A(-0.338).addScaledVector(v, R * 0.62), dir.clone().negate(), 0.009, T_CHROME);
  }

  // ── rings and dovetail ────────────────────────────────────────────────────
  // The red is the only saturated colour on the object and there is very little
  // of it. That is the point: two thin red bands on a white tube is jewellery,
  // and a red tube would be a toy.
  const ringAt = (s) => {
    const c = A(s);
    seg(P, 'plastic', A(s - 0.017), A(s + 0.017), R * 1.055, R * 1.055, 20, T_RED);
    // The hinge boss and the clamp knob, on opposite sides.
    const hd = side.clone();
    bolt(P, c.clone().addScaledVector(hd, R * 1.06), hd, 0.010, T_SHELL);
    const kd = upPerp.clone().multiplyScalar(0.55).addScaledVector(side, -0.83).normalize();
    knob(P, 'plastic', c.clone().addScaledVector(kd, R * 1.10), kd, 0.011, 0.020, T_SHELL);
    // The foot of the ring, down onto the dovetail.
    const dn = mUp.clone().negate();
    seg(P, 'plastic', c.clone().addScaledVector(dn, R * 1.00),
        c.clone().addScaledVector(dn, R + 0.030), 0.030, 0.026, 8, T_RED);
  };
  ringAt(-0.145);
  ringAt(0.075);
  {
    const dn = mUp.clone().negate();
    const b = basis(dir, side);
    const bar = rbox(0.052, 0.300, 0.014, 0.003, 1);
    P.add(bar, 'plastic', M().makeBasis(b.x, b.y, b.z)
      .setPosition(A(-0.035).addScaledVector(dn, R + 0.036)), T_SHELL);
  }

  // ── focuser, finder, eyepiece ─────────────────────────────────────────────
  //
  // On a Newtonian these are near the FRONT of the tube and stick out sideways,
  // which is the layout cue that most distinguishes it from the refractor at a
  // glance. Angled up and toward the observer so the eyepiece is somewhere a
  // person could actually put their eye.
  const EP_OUT = V(0, 0, 0);
  {
    const fd = side.clone().multiplyScalar(0.80).addScaledVector(upPerp, 0.60).normalize();
    const f0 = A(0.215).addScaledVector(fd, R * 0.95);
    seg(P, 'plastic', f0.clone().addScaledVector(fd, -0.020),
        f0.clone().addScaledVector(fd, 0.036), 0.030, 0.028, 12, T_SHELL);
    seg(P, 'plastic', f0.clone().addScaledVector(fd, 0.030),
        f0.clone().addScaledVector(fd, 0.062), 0.0215, 0.0215, 10, T_CHROME);
    // The eyepiece and its cup.
    seg(P, 'plastic', f0.clone().addScaledVector(fd, 0.058),
        f0.clone().addScaledVector(fd, 0.092), 0.0195, 0.0180, 10, T_SHELL);
    seg(P, 'rubber', f0.clone().addScaledVector(fd, 0.088),
        f0.clone().addScaledVector(fd, 0.106), 0.0190, 0.0210, 10, T_FOOT);
    disc(P, 'plastic', f0.clone().addScaledVector(fd, 0.104), fd, 0.0120, 12, T_GLASS);
    EP_OUT.copy(f0).addScaledVector(fd, 0.112);
    // Focus knobs, on an axis across the focuser.
    const kd = new THREE.Vector3().crossVectors(fd, dir).normalize();
    knob(P, 'plastic', f0.clone().addScaledVector(kd, 0.034), kd, 0.016, 0.016, T_SHELL);
    knob(P, 'plastic', f0.clone().addScaledVector(kd, -0.034), kd, 0.016, 0.016, T_SHELL);
    seg(P, 'plastic', f0.clone().addScaledVector(kd, -0.030), f0.clone().addScaledVector(kd, 0.030),
        0.0068, 0.0068, 6, T_CHROME);

    // The finder: a small tube on a two-post bracket, parallel to the OTA and
    // offset around the barrel from the focuser.
    const nd = side.clone().multiplyScalar(0.20).addScaledVector(upPerp, 0.98).normalize();
    const n0 = A(0.150).addScaledVector(nd, R + 0.052);
    seg(P, 'plastic', n0.clone().addScaledVector(dir, -0.062),
        n0.clone().addScaledVector(dir, 0.062), 0.0155, 0.0155, 8, T_SHELL);
    seg(P, 'plastic', n0.clone().addScaledVector(dir, 0.055),
        n0.clone().addScaledVector(dir, 0.074), 0.0185, 0.0185, 8, T_SHELL);
    disc(P, 'plastic', n0.clone().addScaledVector(dir, 0.072), dir, 0.0135, 10, T_GLASS);
    for (const s of [-0.040, 0.040]) {
      seg(P, 'plastic', n0.clone().addScaledVector(dir, s).addScaledVector(nd, -0.014),
          A(0.150 + s).addScaledVector(nd, R * 0.98), 0.0165, 0.0165, 8, T_SHELL);
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI + 0.9;
        const v = side.clone().multiplyScalar(Math.cos(a))
          .addScaledVector(new THREE.Vector3().crossVectors(nd, dir), Math.sin(a));
        bolt(P, n0.clone().addScaledVector(dir, s).addScaledVector(v, 0.017), v, 0.0055);
      }
    }
  }

  return {
    tripod,
    top: A(0.372).y,
    view: { eye: EP_OUT.clone(), aim: dir.clone() },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The builder
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param rnd   seeded RNG
 * @param opts  { variant: 'refractor' | 'reflector', wear: 0..1 }
 * @returns {THREE.Group}
 */
export function buildTelescope(rnd, opts = {}) {
  const g = new THREE.Group();
  // Two literals, deliberately, and the second one is load-bearing.
  //
  // `src/tools/gallery/registry.js` reads a builder's options out of the
  // builder's own source text and only recognises an option as an ENUM when it
  // sees it compared against two or more string literals; anything else lands
  // in `unknown`, which is reported but never expanded into cards. Written the
  // short way — `opts.variant === 'reflector' ? 'reflector' : 'refractor'` —
  // the gallery gave this file exactly one card, the default one, and the
  // 150/750 was unreachable on the page whose entire job is to let somebody
  // look at it. Spelling both branches out costs a line and makes the gallery
  // enumerate both telescopes on its own.
  const variant = opts.variant === 'reflector' ? 'reflector'
                : opts.variant === 'refractor' ? 'refractor'
                : 'refractor';
  g.name = `camp_telescope_${variant}`;
  const P = new Parts(`telescope_${variant}`);

  const info = variant === 'reflector'
    ? buildReflector(P, rnd, opts)
    : buildRefractor(P, rnd, opts);

  P.flush(g, { cast: true, receive: true });

  // Measured, not asserted — the tripod's splay is jittered per leg and a
  // hand-written constant would be wrong for two thirds of the camps. The XZ
  // extent is what the layout solver has to keep clear; the tube overhangs it,
  // but the tube is 0.7 m in the air and nothing walks into it.
  const bb = new THREE.Box3().setFromObject(g);
  g.userData.footprint = Math.max(
    Math.abs(bb.min.x), Math.abs(bb.max.x),
    Math.abs(bb.min.z), Math.abs(bb.max.z),
  ) * 0.82;
  // What the interaction layer needs. `eye` and `aim` are in the prop's own
  // space; `camp_scope_view.js` carries them to world space through the group's
  // own matrix, so a telescope standing on a slope still looks where its tube
  // is actually pointing rather than where a flat-ground assumption says.
  g.userData.telescope = {
    variant, top: info.top,
    eye: info.view.eye, aim: info.view.aim,
  };
  return g;
}

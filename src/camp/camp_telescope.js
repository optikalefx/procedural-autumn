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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
// Two rounds of measurement moved both of these a long way from the plate.
//
// ENAMEL. The plates are white; this is not, and the reason is in the numbers.
// At hour 20.4 the first build's 0xdcd9d1 put 87% of the reflector's tube
// pixels at the clip ceiling, threw a bloom halo forty pixels into the trees,
// and measured a tube-region mean of 0.819 against a flame core of 0.713 — the
// telescope was brighter than the fire, which the brief names as the one thing
// that may not happen. Holding "two thirds of a stop under paper white" was not
// a ceiling at all; a low sun ate it in a single frame. 0.41 linear instead of
// 0.72 is a full stop down, it lands where the tent fly and the cooler lid
// already sit (neither of which clips in the same frame), and against a valley
// this dark at dusk it is still unmistakably the white object.
//
// …except that almost none of that was this prop's fault, and the level came
// nearly all the way back. The story is worth keeping because it is a good
// example of a measurement being confidently wrong three times.
//
// The dusk clipping is real, and it is caused by WHERE the telescope stands.
// This camp has a large blown-out warm pool on the grass on one flank — the
// meadow inside it is clipped white too, with or without a telescope in it —
// and the layout was putting the scope at its edge. Measured with a magenta
// mask pass (`scopelab`'s third instrument, and the first honest one), the same
// object at the same hour with the same albedo:
//
//     bearing seat+1.7 (inside the pool):   peak 0.995, 13.7% of the prop clipped
//     bearing seat-1.7 (outside it):        peak 0.676,  0.00% clipped
//
// Two rounds of albedo were spent chasing that, and each one traded away the
// thing the plates are actually about — a WHITE telescope — to fix a scene
// lighting hotspot that is not in this file and that blows out everything
// standing in it. So the level is back up near where it started.
//
// What is kept from those rounds is the COOL, and that is a real finding.
//
// Lifted again after round 3 put a number on the thing all three rounds of
// darkening had quietly conceded: the reflector's brightest lit facet measured
// L=167 and the meadow behind it L=200, and the refractor's L=146 against the
// same 200. Both tubes were DARKER than the grass they stood in front of, in a
// pair of plates whose whole subject is the brightest object in the picture. It
// had stopped being a white telescope and become galvanised pipe, and the long
// comment above was the argument that let that happen — every step of it was
// defensible and the sum of them was wrong. There is a full stop of headroom at
// dusk (prop peak 0.48 against a flame at 0.85), so the level goes where the
// plates put it and the dusk measurement is what polices it, not caution.
//
// AND THAT IS AS BRIGHT AS THIS TUBE CAN BE. Do not lift the hex again; it does
// nothing. Measured directly — the same frame, the same mask, ENAMEL at
// 0xf1f3f8 and then at pure 0xffffff, an 11% lift in linear albedo:
//
//     side  peak 0.756  ->  0.756
//     high  peak 0.750  ->  0.750
//
// Zero. `src/render/PostFX.js` says why, in its own words: the grade is Khronos
// PBR Neutral, which "starts compressing at 0.76 and is very aggressive above
// it", and that author measured the same wall from the other side — "a 13% cut
// in scene radiance moved the card by 1.6% on screen, because the shoulder is
// exactly where changes stop showing". This tube sits on that shoulder. Three
// critic rounds have asked for a brighter tube and two of them got an albedo
// lift that could not possibly have delivered one.
//
// The meadow reaches 199/255 where the tube reaches 168 because grass is a
// different shader with its own lighting path, not because it has more albedo.
// So the gap cannot be closed from this file by making the tube lighter, and
// the lever that is left is CONTRAST: everything the tube is seen against —
// the rings, the mount, the tripod, the black bands — going darker buys the
// same read. That is the only direction left and it is the direction the
// remaining work goes in. A neutral prop takes
// the light's chroma entirely: the tube sampled (196,161,105) tan at play
// framing and (113,106,68) olive at three-quarter — six values off the grass
// immediately behind it. It camouflaged. The teal cooler and the blue chair
// read instantly in the same frames for exactly the reason the brief gives, so
// the enamel is given a blue lean it can hold against a warm key. It is the
// complementary split the brief asks for, and it is the only thing that keeps
// a white object legible in a yellow autumn valley.
const ENAMEL = 0xf1f3f8;
// Deepened from 0x26262a.
//
// The tube cannot be made brighter — see the note on ENAMEL — so the read has
// to be bought as contrast, and the place to spend it is the tube's own
// furniture rather than the mount. The eye compares the tube to what is inside
// its own silhouette, and measured there the reflector's rings sat at L=75
// against a 151 tube: a 2:1 ratio where both plates run nearer 6:1. Halving the
// shell's albedo takes the rings, the sky-end band and the focuser down toward
// that without touching a single lighting term.
//
// It is still lifted off true black — a gloss black photographs at about 12%
// reflectance and authoring it at 3% is what makes a prop look like a cut-out —
// just less generously than before.
const SHELL  = 0x191a1d;
// The counterweight shaft and the drawtubes. Deliberately NOT close to the
// enamel — at 0xb4b6b4 the shaft and the housings it joins were fifteen values
// apart and the head squinted to one lumpy white blob. A dark shaft is what
// separates the weight from the mount, and a dark line between two masses is
// how the reference reads at all.
// Bright. This went DOWN in round 2 to separate the weight from the mount, and
// that was the wrong direction: at 0x8d9095 the shaft measured seventeen values
// from the tripod legs and merged into the one it crosses, taking the opposed
// diagonal — the thing that says "German equatorial" — with it. The plate's
// shaft is deliberately the brightest thin line on the whole mount. The
// separation the darkening was after is bought by the dark collar at the head
// instead, which is where the plate puts it.
const CHROME = 0xcdd0d2;
const RED    = 0x9c2f26;   // the reflector's ring clamps
// Mill-finish tripod leg. Lifted from 0xa8a9a6 after the first captures came
// back with the legs reading as a black wire tripod under a white tube — in the
// reference plates the legs are nearly as bright as the tube and the DARK things
// on the tripod are the hardware, which is the opposite value structure. A
// dielectric standing in for aluminium has no specular to carry it, so the
// albedo has to do the whole job; see `legTint` for the gradient that does the
// rest.
// Lifted once, then brought back down. At 0xb9bcbe the legs were the brightest
// surface on the prop at dusk — brighter than the tube they hold up, which is
// backwards: in both plates the TUBE is white and the legs are grey aluminium.
// Bright enough to read as metal, half a stop under the enamel so the hierarchy
// runs tube, then legs, then hardware.
// Mill-finish tripod leg.
//
// Lifted, then dropped, and now dropped again in the BLUE rather than in level.
// At 0x9ea3a6 the legs read mid-grey at noon and clipped to pure white at dusk,
// where the silhouette dissolved into the bright grass entirely — the spreader
// stayed black in the same frame, which proves the kit can hold value there and
// that the leg simply had too little floor. Cooler and very slightly darker: a
// blue-leaning grey cannot go white under a warm key without the hue giving it
// away first, which is the same argument the enamel makes one notch brighter.
const LEGMET = 0x93999e;

// Everything is a dielectric; see note 4 in the header.
const T_ENAMEL = tintFrom(HEX_PLASTIC, ENAMEL);
const T_SHELL  = tintFrom(HEX_PLASTIC, SHELL);
const T_CHROME = tintFrom(HEX_PLASTIC, CHROME);
const T_RED    = tintFrom(HEX_PLASTIC, RED);
const T_LEG    = tintFrom(HEX_PLASTIC, LEGMET);
const T_GLASS  = tintFrom(HEX_PLASTIC, 0x121620);
// Hardware that must not become a highlight: collimation screws, small bolts on
// a dark ground. Bright enough to be metal, dark enough not to be a dot.
const T_CHROME_DK = tintFrom(HEX_PLASTIC, 0x5c6066);
// The equatorial head's castings. A mid grey: dark enough to break from the
// tube lying above it, light enough to stay a painted casting rather than
// becoming more hardware. See the note at the RA housing.
const T_MOUNT = tintFrom(HEX_PLASTIC, 0x8b9098);
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
function skyGrad(base, k = 0.22, axisY = null, cool = 0.06) {
  return (x, y, z) => {
    const up = axisY ? axisY(x, y, z) : 0;
    const g = 1 + k * up;
    // …and the underside leans COOL, which is the half of this that matters.
    //
    // The top of a white tube outdoors sees a blue dome and the bottom sees
    // bounce off dirt, so the naive version of this makes the underside warmer.
    // That is what the first build did and it is why the tube slid to olive:
    // warm light times warm bounce, in a valley graded warm, leaves nothing for
    // the object's own colour to say. Leaning the shadow side blue instead is
    // the complementary split — warm key, cool shadow — and it is what makes a
    // white cylinder read as round rather than as a flat lozenge, because the
    // eye reads a hue shift across a form long after a value shift has been
    // quantised away by the stylised bands.
    // The cool leans the shadow side blue. It used to DARKEN it too, by up to
    // 19% in red, and that was the single biggest thing making the tube read
    // grey — because the shadow side is most of the visible surface at every
    // camera angle a player has, so it sets the MEDIAN.
    //
    // Three rounds asked for a brighter tube and got an albedo lift. Two of
    // those lifts were measured on the tube's PEAK, which is one pixel sitting
    // exactly on the grade's compression knee and is the one statistic in the
    // frame guaranteed not to respond — a clean repeatable number attached to
    // the wrong object, which is the failure this project's own critic protocol
    // names. Measured properly: 98.6% of the tube's pixels are BELOW the knee,
    // in the part of the curve that still responds, with a median of 145 and a
    // p90 of 169 against a meadow at 195. The lit facets already reach 196. The
    // frame reads grey because the lit band is narrow and the shaded band is
    // pushed down, not because the albedo is low.
    //
    // So the hue rotation stays and the darkening goes: `cool` is 0.06 rather
    // than 0.15, and it now only tints. Nothing about the tonemapper prevents
    // this and it costs nothing.
    const c = cool * Math.max(0, -up);
    return [
      base[0] * g * (1 - c * 1.25),
      base[1] * g * (1 - c * 0.30),
      base[2] * g * (1 + c * 0.90),
    ];
  };
}

/**
 * The grime a white enamel tube picks up living in a truck.
 *
 * Every other prop in this set has a wear story and the first build of this one
 * had it only on the tripod legs — the tube itself was factory-fresh, which on
 * the whitest object in the camp is the loudest possible version of the defect
 * the brief names. Two things, both subtle, both measurable at the dusk frame:
 * an overall knock-down, and a band of handling dirt where hands actually go,
 * which is around the focuser and the rings rather than uniformly.
 */
function grimed(base, wear, bands = []) {
  // Held back down from 0.10 + 0.14w. That doubling was round 3's answer to
  // "no visible grime" and it took a fifth of the enamel's value with it, on an
  // object whose defining property is being the bright thing. Grime belongs
  // where hands and dirt actually reach — the band terms below do that work —
  // rather than as a flat tax on the whole tube.
  const k = 0.045 + wear * 0.075;
  return (x, y, z) => {
    let d = k;
    for (const b of bands) {
      const r = Math.hypot(x - b[0], y - b[1], z - b[2]);
      d += b[3] * Math.max(0, 1 - r / b[4]);
    }
    const m = 1 - Math.min(0.30, d);
    // Grime desaturates as well as darkens; a tube that only goes darker reads
    // as being in shadow rather than as being dirty.
    return [base[0] * m, base[1] * m * 1.012, base[2] * m * 1.02];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The contact patch
//
//  A soft dark pool on the ground under the tripod, and it is the only part of
//  this file that is not geometry the object actually has.
//
//  It is here because the sun's shadow map cannot see this prop and no amount of
//  modelling will change that. The shadow camera spans 480 m across 4096 texels
//  — 117 mm per texel — so a 190 mm tube is 1.6 texels and a 34 mm tripod leg is
//  under a third of one; PCF erases both. Measured across three rounds: a camp
//  chair darkens the ground under it by 44-65% and this telescope by 1.7%, which
//  is noise. The brief's rule 5 is that a prop which does not cast a contact
//  shadow floats, and every critic pass has led with it.
//
//  What was tried first and does not work: darkening the FEET. Round 3 authored
//  a 55% occlusion gradient into the foot geometry, and it changed nothing,
//  because the feet were already near-black and darkening a prop cannot plant a
//  prop. The darkness has to be on the ground.
//
//  Shape: a very shallow inverted cone rather than a flat disc, and that is the
//  whole trick. The camp's dirt is a lifted, hummocked mesh — `camp_ground.js`
//  puts its surface anywhere from 0 to about 35 mm above the terrain height this
//  prop was placed against — so a flat patch at any fixed height is buried on
//  half the ground and floating on the other half. A cone from +48 mm at the
//  centre to −12 mm at the rim crosses that whole band, so it always intersects
//  the dirt: the part standing proud is what draws, and the part underneath is
//  depth-tested away. It self-fits to ground it cannot measure. Over a half-metre
//  radius that is a 5-degree slope, which reads as flat from any camera the
//  player has. The rim stops at −9 mm because the prop contract's floor is −10
//  and the rim only has to reach the TERRAIN — the dirt it is fitting itself to
//  is above that, never below.
//
//  Alpha comes from a four-component colour attribute, which is how a
//  `MeshBasicMaterial` gets per-vertex transparency. `camp_fire.js` sets the
//  precedent for a camp prop owning a blended material; this one is a module
//  singleton so a hundred telescopes share it, exactly like `campMaterials()`.
// ─────────────────────────────────────────────────────────────────────────────
let _contactMat = null;

function contactMaterial() {
  if (_contactMat) return _contactMat;
  _contactMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Never writes depth: it lies flat against the dirt and against its own
    // per-foot patches, and a transparent surface that writes depth punches a
    // hole in whatever is drawn after it.
    depthWrite: false,
    // Multiplicative, not alpha-over-black. A black quad at 40% opacity lifts
    // the ground toward grey; multiplying darkens it while keeping the dirt's
    // own hue, which is what a shadow does and what the eye checks.
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  });
  return _contactMat;
}

/** Drop the shared contact material. Only a full camp teardown should call it. */
export function disposeTelescopeMaterials() {
  if (!_contactMat) return;
  _contactMat.dispose();
  _contactMat = null;
}

/**
 * A radially-fading dark pool centred on the origin.
 *
 * @param r      outer radius, where the darkening reaches zero
 * @param depth  darkening at the centre, 0..1
 * @param yTop   height of the centre; the rim drops to `yRim`
 */
function contactPatch(r, depth, yTop = 0.048, yRim = -0.009, seg = 28) {
  const rings = 5;
  const pos = [], col = [];
  const at2 = (i, k) => {
    const a = (i / seg) * TAU;
    // No wobble. It was here to stop the pool being a compass circle, on the
    // reasoning that dirt does not do circles — true of a dirt DECAL and false
    // of a shadow. What it produced was a lumpy cog outline, and a lumpy
    // outline is MORE legible as an edge than a round one, not less: it gives
    // the eye a shape to find.
    const rr = r * k;
    const t = k;
    return {
      x: Math.cos(a) * rr, z: Math.sin(a) * rr,
      y: yTop + (yRim - yTop) * t * t,
      // A MONOTONIC shoulder. No plateau.
      //
      // Two profiles came before this one and each fixed the other's defect.
      // (1-t)^2 from the middle darkened 57,000 pixels by a mean of 8.4% — the
      // pool existed and did nothing, because almost all its area sat at an
      // alpha too low to see. Holding it flat to 40% of the radius fixed the
      // strength and broke the edge: a flat interior with a hard shoulder read
      // from above as a rust-brown coaster stuck under each foot, and a strong
      // BOUNDED patch is the definition of a decal.
      //
      // What a contact shadow needs is to be strong AND unbounded, so this
      // starts dark at the centre and never stops falling. The depth is raised
      // to pay for the missing plateau; the number to hold is what the ground
      // directly under the foot reads, which is 44-65% for the camp chair
      // standing three metres away in the same frame.
      a: depth * (1 - t) * (1 - t * 0.35),
    };
  };
  const push = (p) => { pos.push(p.x, p.y, p.z); col.push(0, 0, 0, p.a); };
  for (let ring = 0; ring < rings; ring++) {
    const k0 = ring / rings, k1 = (ring + 1) / rings;
    for (let i = 0; i < seg; i++) {
      const a0 = at2(i, k0), b0 = at2(i + 1, k0);
      const a1 = at2(i, k1), b1 = at2(i + 1, k1);
      push(a0); push(a1); push(b1);
      push(a0); push(b1); push(b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}

/**
 * Attach the contact pool, and make sure it can never cast a shadow.
 *
 * `Camp._buildNext` traverses every prop it places and sets `castShadow = true`
 * on each mesh, which is right for all of them and catastrophic for this one: a
 * metre-wide alpha-blended plane is opaque in the depth pass, so it would lay a
 * hard black disc of shadow on the ground it exists to soften. A plain
 * `castShadow = false` is overwritten a frame later.
 *
 * So the property is redefined as an accessor that ignores writes. A silently
 * ignoring setter rather than a non-writable value: `Camp.js` is an ES module
 * and therefore strict, where assigning to a non-writable property throws — it
 * would take the whole camp build down rather than the shadow.
 */
function addContact(g, parts) {
  // One mesh, not four. They share a material and none of them moves relative
  // to the others, so merging keeps this prop at three draw calls instead of
  // six — the same merge-by-material rule the rest of the kit follows, applied
  // to the one part of it that does not go through `Parts`.
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) for (const p of parts) p.dispose();
  const m = new THREE.Mesh(geo, contactMaterial());
  m.name = 'telescope_contact';
  m.receiveShadow = false;
  m.frustumCulled = true;
  // Drawn after the opaque props so it lands over the dirt rather than under it.
  m.renderOrder = 2;
  Object.defineProperty(m, 'castShadow', {
    get: () => false, set: () => {}, configurable: true,
  });
  g.add(m);
  return m;
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
  legHex = null,   // override the leg metal — see the note at the call sites
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
    const foot = V(ca * sp, 0.052, sa * sp);
    const dir = new THREE.Vector3().subVectors(foot, top).normalize();
    // Outward, in the plane of the leg — the axis the leg's flat faces and its
    // hardware are oriented against.
    const out = V(ca, 0, sa);
    legs.push({ a, top, foot, dir, out, ca, sa });
  }

  // Dust at the bottom, sky at the top. The vertical gradient is doing the work
  // the missing specular line cannot: a leg whose upward-facing side is 20%
  // brighter than its underside reads as a round bright extrusion, and a leg at
  // one flat value reads as a stick whatever colour it is painted.
  const base = legHex ? tintFrom(HEX_PLASTIC, legHex) : T_LEG;
  const legTint = tintMul(
    dusted([1, 1, 1], { top: 0.30, amount: 0.34 + wear * 0.26 }),
    (x, y, z) => {
      const g = 1 + 0.10 * clamp01((y - 0.02) / Math.max(0.2, height));
      return [base[0] * g, base[1] * g, base[2] * g];
    },
  );

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
      // Eight sides, not six.
      //
      // The kit's `tube()` argues for six and it is right for a 14 mm chair
      // frame — but a hexagon seen roughly face-on presents TWO faces, and at
      // 5x the round-2 crop showed exactly that: each leg was two quads, one
      // light and one dark, with a hard seam down the middle, reading as an
      // extruded batten rather than as a tube. The brief's own reasoning is
      // that a faceted tube reads because the value STEPS AROUND it; two values
      // is not a step, it is a fold. Eight faces put three or four values
      // across the leg at every bearing, which is the least that reads as
      // round, and this leg is 25 mm rather than the chair's 14 so it can
      // afford them.
      seg(P, 'plastic', L.top, mid, legR * 1.06, legR, 8, legTint);
      seg(P, 'plastic', mid, L.foot.clone().addScaledVector(L.dir, 0.01),
          legR * 0.76, legR * 0.72, 8, legTint);
    }

    // The clamp: a collar with a lever. Dark, and deliberately a little
    // oversized — on the plates it is the widest thing on the leg.
    {
      const c = mid.clone();
      // DARK, on both tripods. The first build made the reflector's clamps
      // white to match the mount castings, and the result was six bright beads
      // scattered down a bright tripod: invisible close up and a speckle rash
      // at distance. The plates use white for the CASTINGS and dark for the
      // HARDWARE, and that split is what gives a mostly-white machine any
      // internal read at all.
      seg(P, 'plastic', c.clone().addScaledVector(L.dir, -0.016),
          c.clone().addScaledVector(L.dir, 0.014), legR * 1.5, legR * 1.42, 8, T_SHELL);
      // The lever sticks out sideways, catching light against the leg.
      const lev = c.clone().addScaledVector(L.out, legR * 1.5);
      const lv = rbox(0.030, 0.010, 0.013, 0.004, 1);
      const lb = basis(L.dir, L.out);
      P.add(lv, 'plastic', M().makeBasis(lb.x, lb.y, lb.z).setPosition(lev), T_SHELL);
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
      // ── the foot, and why it is 62 mm tall ────────────────────────────
      //
      // The round-2 critic measured ZERO ground darkening under every foot at
      // every angle, while the camp chair three metres away measured -45%, and
      // called the prop pasted on rather than planted. The flags were not the
      // problem: `castShadow` is true on both meshes, the shadow map is on at
      // 4096, and the prop sits well inside the sun's shadow camera — all
      // checked in the running scene rather than assumed. Two other things
      // were.
      //
      // First, the shadow map cannot see this prop. The sun's shadow camera
      // spans 480 m across 4096 texels: 117 mm per texel. A 190 mm tube is 1.6
      // texels wide and a 34 mm leg is under a third of one, so the PCF filter
      // erases both. That is a global setting, it is not mine, and nothing this
      // file does will make a shadow map resolve a 34 mm stick.
      //
      // Second — and this one WAS mine — the feet were buried. The camp's dirt
      // is a LIFTED mesh: `camp_ground.js` adds `LIFT` 13 mm, plus a berm and
      // up to 26 mm of hummock, over the terrain the layout solver measured
      // against. The visible ground under a prop therefore stands 30-40 mm
      // above y = 0, and these pads spanned 3.5-26 mm — entirely inside that
      // band, under the dirt, with the legs coming out of the ground as cut
      // sticks and nothing at the contact point at all. The table author hit
      // exactly this and wrote it up; this is the same fix.
      //
      // So the foot clears the band with room to spare, and it takes the
      // table's other lesson with it: a dark mass low down, sitting where the
      // contact is, READS as contact even at a distance where a real shadow
      // would be gone. It is darkened toward its sole by hand — the cooler's
      // trick, and the only ambient occlusion available in a kit with no AO
      // pass — which is what the eye reads as ground closing around it.
      const f = L.foot.clone().addScaledVector(L.dir, -0.030);
      seg(P, 'rubber', f, L.foot.clone().addScaledVector(L.dir, 0.014),
          legR * 1.66, legR * 1.52, 8, T_FOOT);
      const pc = V(L.foot.x, 0.0, L.foot.z);
      const contact = (x, y) => {
        const k = clamp01((0.062 - y) / 0.050);
        const m = 1 - 0.55 * k * k;
        return [T_FOOT[0] * m, T_FOOT[1] * m, T_FOOT[2] * m];
      };
      seg(P, 'rubber', pc.clone().add(V(0, 0.002, 0)), pc.clone().add(V(0, 0.062, 0)),
          legR * 2.05, legR * 1.46, 12, contact);
    }
  }

  // ── what ties the legs together ──────────────────────────────────────────
  if (tray === 'spreader') {
    // The small tripod's three-arm brace: a hub on the centre column with a
    // flat bar out to each leg. Thin — 5 mm stock — and it must stay thin;
    // fattening it to stop it aliasing is the mistake the brief names.
    // Height, measured off the plate rather than guessed. At `height * 0.36`
    // the brace sat 64% of the way down the legs — where they are widest — so
    // its arms had to be long and the result was a wide black bar low in the
    // silhouette, the strongest dark shape on the whole prop and in the worst
    // place for it. The GeoSafari's is about half way down. Shorter arms, and
    // the dark mass moves up into the tripod where it reads as structure.
    const y = height * 0.50;
    const hubP = V(0, y, 0);
    seg(P, 'plastic', hubP.clone().add(V(0, -0.010, 0)), hubP.clone().add(V(0, 0.010, 0)),
        0.022, 0.022, 8, T_SHELL);
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
    const y = height * 0.56;
    const hubP = V(0, y, 0);
    for (const L of legs) {
      const t = (L.top.y - y) / Math.max(1e-4, L.top.y - L.foot.y);
      const p = new THREE.Vector3().lerpVectors(L.top, L.foot, t);
      const dir = new THREE.Vector3().subVectors(p, hubP);
      const len = dir.length();
      const b = basis(dir.clone().normalize(), V(0, 1, 0));
      // The lobe, and it has an actual LIP this time — the previous version's
      // comment promised one and the geometry was a flat 8 mm disc, which read
      // as black tape rather than as a dish. A 14 mm rim is enough to catch a
      // different value from the floor of the tray, and that pair of values is
      // the whole difference between a tray and a shadow.
      const lc = p.clone().addScaledVector(dir.clone().normalize(), -0.030);
      const g = new THREE.CylinderGeometry(0.052, 0.052, 0.008, 12, 1, false);
      P.add(g, 'plastic', M().setPosition(lc), T_SHELL);
      const rim = new THREE.CylinderGeometry(0.056, 0.052, 0.015, 12, 1, true);
      P.add(rim, 'plastic', M().setPosition(lc.clone().add(V(0, 0.010, 0))), T_SHELL);
      const bar = rbox(0.062, len * 0.92, 0.008, 0.003, 1);
      P.add(bar, 'plastic', M().makeBasis(b.x, b.y, b.z)
        .setPosition(new THREE.Vector3().addVectors(hubP, p).multiplyScalar(0.5)), T_SHELL);
      // The clip that grips the leg.
      seg(P, 'plastic', p.clone().addScaledVector(L.dir, -0.014),
          p.clone().addScaledVector(L.dir, 0.014), legR * 1.44, legR * 1.44, 8, T_SHELL);
    }
    seg(P, 'plastic', hubP.clone().add(V(0, -0.006, 0)), hubP.clone().add(V(0, 0.012, 0)),
        0.046, 0.046, 12, T_SHELL);
    // The bolt and the knob under the tray — the tray tensions the legs, and
    // this is the object that says so. Dark, not white: a white knob hanging in
    // space under a black tray reads as a detached bead, which is what the
    // capture showed it doing.
    seg(P, 'plastic', V(0, y - 0.050, 0), V(0, y + 0.004, 0), 0.011, 0.011, 6, T_CHROME);
    knob(P, 'plastic', V(0, y - 0.062, 0), V(0, 1, 0), 0.019, 0.024, T_SHELL);
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
  // Height, and this is a decision rather than a measurement.
  //
  // The plate is a tabletop unit: its tripod is about 0.4 m and the whole thing
  // stands 0.55 m. The first build split the difference at 0.72 m overall,
  // which is the one answer that is wrong — too tall to stand on the camp table
  // and too short to use standing up, so it reads as neither object. These kits
  // ship with an extending aluminium tripod and the camp is the case where it
  // is extended, so: commit to the field tripod. 0.70 m to the head puts the
  // eyepiece at 0.86 m, which is a usable height for somebody sitting in one of
  // the camp chairs eight feet away — and being usable from the chairs is the
  // reason this prop is in a camp at all.
  const H_HUB = 0.700;
  const tripod = buildTripod(P, rnd, {
    height: H_HUB, spread: 0.300, legR: 0.0125, square: false,
    // The two plates do not agree about tripods and this file should not either.
    // The Omegon's legs are grey mill-finish aluminium with black fittings; the
    // GeoSafari's are WHITE, near enough the same white as its tube, and a
    // round-3 note that the legs were reading near-black in half the refractor
    // frames was really a note that this variant had been given the other
    // plate's tripod. Bright, and let the black hardware do the dividing.
    legHex: 0xe4e7ea,
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
    // A rounded casting with a heavy corner radius, not the plain box the first
    // build had. The plate's head is a moulding, and a moulding's read is its
    // radius — a hard-edged box beside a set of cylinders is the single most
    // reliable tell of primitives placed rather than a part designed.
    const body = rbox(0.050, 0.060, 0.056, 0.021, 3);
    P.add(body, 'plastic', at(0, H_HUB + 0.058, 0), T_SHELL);
    // The tilt knob, on the -X flank: the fat protruding ball the plate has,
    // and the biggest single detail on this end of the prop.
    knob(P, 'plastic', V(-0.042, H_HUB + 0.062, 0), V(1, 0, 0), 0.030, 0.032, T_SHELL);
    seg(P, 'plastic', V(-0.060, H_HUB + 0.062, 0), V(-0.070, H_HUB + 0.062, 0),
        0.020, 0.014, 10, T_SHELL);
    bolt(P, V(-0.070, H_HUB + 0.062, 0), V(-1, 0, 0), 0.007, T_CHROME);
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
  // `dusted(..., { amount: 0.0 })` was a no-op wearing the costume of a wear
  // story — the whitest object in the camp was factory-fresh in a dirt
  // clearing. Real grime now, concentrated around the focuser where hands go.
  const enamel = tintMul(
    skyGrad(T_ENAMEL, 0.20, axisUp),
    grimed([1, 1, 1], wear, [
      [pivot.x + dir.x * -0.06, pivot.y + dir.y * -0.06, pivot.z + dir.z * -0.06, 0.10, 0.30],
      [pivot.x + dir.x * 0.20, pivot.y + dir.y * 0.20, pivot.z + dir.z * 0.20, 0.06, 0.26],
    ]),
  );
  // 0.16, down from 0.50, and this was the refractor's one true blocker.
  //
  // `skyGrad` lifts a surface's upward facets to stand in for the sky they see.
  // On the enamel that is a roundness cue worth having. On the near-black dew
  // shield it is invisible under a sun key and catastrophic when the SKY is the
  // key: measured at hour 20.4 the shield rendered srgb(116,129,191), L=130,
  // against a tube at L=120 — a blue shield brighter than the white tube it is
  // fitted to, with the single feature that identifies the plate's object
  // inverted out of existence. Day and dusk read as two different telescopes.
  const shell = skyGrad(T_SHELL, 0.16, axisUp);

  // dew shield → tube → rear cell
  //
  // Every number in this block grew by half after round 2 measured the plate's
  // proportion and the render's side by side. Tube length over tripod height is
  // about 1.15 in the plate — it is a tube-dominant object, top-heavy, and the
  // tripod is a stand for it. The r10 build measured 0.70: a camera tripod with
  // a small scope perched on it, which is exactly how the critic described it
  // without knowing the number. Committing the tripod to field height in round
  // 1 without scaling the tube is what did it, so this is the other half of
  // that change rather than a new decision.
  //
  // Grown by lengthening and fattening the OTA (0.49 -> 0.75 m, 60 -> 78 mm)
  // rather than by dropping the hub, because the hub height is load-bearing for
  // a different reason: it puts the eyepiece at 0.86 m, which is where somebody
  // sitting in one of the camp chairs can actually reach it.
  seg(P, 'plastic', P0(0.300), P0(0.470), 0.0450, 0.0462, 14, shell);
  // The objective, recessed inside the shield: a dark disc with a cool rim. It
  // is 8 px of near-black at the end of a bright tube and it is the single
  // cheapest detail in the file — without it the tube is a length of pipe.
  disc(P, 'plastic', P0(0.440), dir, 0.0388, 16, T_GLASS);
  // The dew-shield step, and it is a real step now. 71/60 was 1.18x — under
  // four pixels at play distance, so the barrel read as one uniform pipe half
  // painted black. The plate's is about 1.30x.
  seg(P, 'plastic', P0(0.272), P0(0.306), 0.0390, 0.0450, 14, shell);
  seg(P, 'plastic', P0(-0.060), P0(0.278), 0.0390, 0.0390, 14, enamel);
  // A ring band where the reference has its logo — a value break in the middle
  // third, subtle, so the white does not run 240 mm without an interruption.
  seg(P, 'plastic', P0(0.070), P0(0.088), 0.0394, 0.0394, 14,
      skyGrad([T_ENAMEL[0] * 0.80, T_ENAMEL[1] * 0.80, T_ENAMEL[2] * 0.80], 0.20, axisUp));
  // rear cell
  seg(P, 'plastic', P0(-0.096), P0(-0.056), 0.0420, 0.0414, 12, shell);

  // The saddle: the tube is clamped to the head by a small cradle. Without it
  // the tube floats over the mount, which was the first version's loudest tell.
  {
    const c = P0(-0.014, -0.042);
    const b = basis(upPerp, dir);
    P.add(rbox(0.050, 0.030, 0.058, 0.006, 1), 'plastic',
      M().makeBasis(b.x, b.y, b.z).setPosition(c), T_SHELL);
    seg(P, 'plastic', P0(-0.014, -0.056), V(0, H_HUB + 0.076, 0), 0.018, 0.021, 8, T_SHELL);
    bolt(P, P0(-0.014, -0.062).addScaledVector(side, 0.022), side, 0.006);
  }

  // ── focuser, diagonal, eyepiece ───────────────────────────────────────────
  const EP_OUT = V(0, 0, 0);
  {
    // The focuser body, then a BRIGHT drawtube sliding out of it.
    //
    // Everything at this end used to be `T_SHELL`: the head, the tilt knob, the
    // pan handle, the focuser, the diagonal, the eyepiece. The result was a
    // single black inkblot as long as the visible white tube with no internal
    // read whatsoever. The plate stays legible here because there IS value
    // separation inside the cluster — a chrome drawtube, a white focus wheel, a
    // bright collar on the diagonal — so those three are put back.
    seg(P, 'plastic', P0(-0.140), P0(-0.092), 0.0300, 0.0300, 10, shell);
    seg(P, 'plastic', P0(-0.182), P0(-0.136), 0.0232, 0.0232, 10, T_CHROME);
    // The big white focus knob. On the plate it is the brightest small object
    // on the whole scope and it sits right where the eye lands — keep it white.
    // The focus wheel is the second-brightest thing on the plate — a near-white
    // disc against black — and it is what keeps this end of the telescope
    // legible at all. Round 2 shrank it and capped it in shell black to stop it
    // clipping at dusk; it stopped clipping and it also stopped existing, and
    // the whole rear cluster went back to being one black clot. It is white
    // again, and bigger. The dusk clip it was shrunk for turned out to be the
    // camper's headlights rather than this prop, so the trade was being made
    // against a condition that does not occur in play.
    const kc = P0(-0.116).addScaledVector(side, 0.034);
    knob(P, 'plastic', kc, side, 0.0245, 0.017, T_ENAMEL);
    disc(P, 'plastic', kc.clone().addScaledVector(side, 0.010), side, 0.0160, 12, T_CHROME);
    knob(P, 'plastic', P0(-0.116).addScaledVector(side, -0.034), side, 0.0170, 0.013, T_SHELL);
    seg(P, 'plastic', P0(-0.116).addScaledVector(side, -0.030),
        P0(-0.116).addScaledVector(side, 0.030), 0.0080, 0.0080, 6, T_CHROME);

    // ── the diagonal and the eyepiece ────────────────────────────────────
    //
    // This is the prop's identity and the first build hid it. The eyepiece rose
    // 88 mm off a 30 mm tube — 58 mm proud, less than one tube diameter — and
    // was swallowed by the black head mass sitting under it, so the one shape
    // that says "small refractor with a 45-degree diagonal" rather than
    // "spotting scope" never cleared the outline. On the plate the eyepiece tip
    // stands about 1.4 diameters above the drawtube axis, silhouetted against
    // open sky. So: a taller diagonal, a longer barrel, and the head mass
    // pulled down and back (see the saddle) so nothing crowds it.
    const d0 = P0(-0.206);
    seg(P, 'plastic', P0(-0.184), d0, 0.0250, 0.0270, 10, shell);
    // A bright collar where the diagonal screws onto the drawtube — the second
    // of the three value breaks in this cluster.
    seg(P, 'plastic', P0(-0.192), P0(-0.180), 0.0284, 0.0284, 10, T_CHROME);
    // The diagonal is a readable BODY, not a bend in a pipe. On the plate it is
    // a distinct cube-ish mass with the eyepiece leaving it at a right angle to
    // the tube, and that right angle is the single thing that separates this
    // object from a spotting scope. The r10 eyepiece left at about 30 degrees
    // off the barrel and read as a lens hood on the back end.
    const db = basis(upPerp, dir);
    P.add(rbox(0.062, 0.058, 0.062, 0.009, 2), 'plastic',
      M().makeBasis(db.x, db.y, db.z)
        .setPosition(d0.clone().addScaledVector(upPerp, 0.012)), T_SHELL);
    const ep0 = d0.clone().addScaledVector(upPerp, 0.032);
    seg(P, 'plastic', ep0, ep0.clone().addScaledVector(upPerp, 0.034), 0.0290, 0.0228, 10, shell);
    seg(P, 'plastic', ep0.clone().addScaledVector(upPerp, 0.024),
        ep0.clone().addScaledVector(upPerp, 0.040), 0.0212, 0.0212, 10, T_CHROME);
    seg(P, 'plastic', ep0.clone().addScaledVector(upPerp, 0.040),
        ep0.clone().addScaledVector(upPerp, 0.112), 0.0202, 0.0190, 10, shell);
    // The rubber eyecup, folded down, and the dark hole in it.
    seg(P, 'rubber', ep0.clone().addScaledVector(upPerp, 0.108),
        ep0.clone().addScaledVector(upPerp, 0.132), 0.0208, 0.0232, 10, T_FOOT);
    disc(P, 'plastic', ep0.clone().addScaledVector(upPerp, 0.130), upPerp, 0.0134, 12, T_GLASS);
    EP_OUT.copy(ep0).addScaledVector(upPerp, 0.138);

    // The accessory plate that used to hang under the diagonal is GONE.
    //
    // It was the flat black shade in the plate and it was worth twelve
    // triangles in principle — the one silhouette element on this scope that is
    // not a cylinder. In practice its bracket was hidden behind the diagonal
    // from most bearings, so what the captures showed was a black rectangle
    // floating in the air beside the mount, unattached to anything, on three
    // frames out of seven. A detail that reads as detached geometry costs more
    // than it pays, and the eyepiece above it is the shape that has to win this
    // corner of the silhouette anyway.
    void back;
  }

  return {
    tripod,
    top: pivot.y + 0.47 * Math.sin(alt) + 0.05,
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
  // Tube altitude, and it is now deliberately SHALLOW.
  //
  // The plate's read is an X: the tube at about 20 degrees and the polar axis
  // at about 50, crossing. Round 2 dropped the polar rake to 0.62 rad to get
  // the counterweight out of the tripod, which worked — and left the polar axis
  // running parallel to a tube raked at 0.60-0.86, two light-grey cylinders in
  // the same material fusing into one stepped tube with no elbow at all. That
  // elbow IS the equatorial mount; without it this reads as a large refractor,
  // which is the worst possible answer in a file that also ships a refractor.
  //
  // Fixed on the MOUNT's side, second time of asking. Round 3 flattened the tube
  // to 0.30-0.48 rad to open the crossing, and measured on screen that put the
  // bar at 19 degrees — below the 25 this file's own header condemns as reading
  // like a surveyor's level, and the squint test came back "a fat white
  // spotting scope". The tube's rake is the prop's whole first impression and it
  // is not the variable to spend. So the tube goes back to 35-45 degrees and the
  // elbow is bought by laying the POLAR axis over instead, which also happens to
  // be what the plate does and what hangs the counterweight lowest.
  //
  // The counterweight hangs along -mUp = (0, -cos(lat), -sin(lat)), so a SMALL
  // lat is what points it at the ground: 0.34 gives (0, -0.94, -0.33), near
  // vertical, clear of the tripod cone by 130 mm at the height it passes.
  const alt = lerp(0.62, 0.78, rnd());
  const H_HUB = 0.905;
  // Splay, measured off the Omegon plate: its foot circle is about 1.15x its
  // own height — planted wider than it is tall. The first build was at 0.83,
  // a steep cone, and the front and back frames read as a camera tripod
  // carrying something too heavy for it. That is not a detail; a tall
  // instrument on a narrow base looks precarious, and precarious is the
  // opposite of what this camp is for.
  const tripod = buildTripod(P, rnd, {
    height: H_HUB, spread: 0.505, legR: 0.017, square: true,
    spin: Math.PI * 0.5 + (rnd() - 0.5) * 1.0,
    tray: 'tray', wear,
  });

  // The polar axis: raked back over the tripod, in the -Z half so the
  // counterweight swings out over +Z where it is visible from the observer's
  // side. 48 degrees, which is a plausible latitude for this valley and, more
  // to the point, is the rake that keeps the counterweight clear of the legs.
  // Latitude of the polar axis — and this number is chosen for the silhouette,
  // not for astronomy.
  //
  // At 0.84 rad (48 degrees) the mount's own up is (0, 0.67, 0.75): more than
  // half of it points at -Z. The counterweight hangs along the negative of
  // that, so it swung DOWN AND AWAY from the observer's side of the camp, and
  // the capture showed it foreshortened into a pale stub tucked behind the
  // head on five of six bearings. A counterweight that cannot be seen is not a
  // counterweight, and it is the one shape that separates this object from a
  // large refractor.
  const lat = 0.34;
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
    // Size hierarchy, which the first build had none of: the azimuth base, the
    // RA housing, the DEC housing and the counterweight all landed within 15%
    // of each other in diameter, in the same material, and the head squinted to
    // one lumpy white blob — primitives at the same scale in the same colour,
    // which is the textbook read of programmer art. The plate is legible
    // because the RA housing is unambiguously the fattest thing, everything
    // else is clearly smaller, and there is a dark break between each pair.
    seg(P, 'plastic', V(0, H_HUB - 0.006, 0), base, 0.050, 0.043, 12, T_MOUNT);
    // The dark collar between the tripod and the head. Cheap, and it is what
    // stops the mount growing out of the tripod as one continuous pale mass.
    seg(P, 'plastic', V(0, H_HUB + 0.012, 0), V(0, H_HUB + 0.026, 0), 0.046, 0.044, 12, T_SHELL);
    const wed = rbox(0.056, 0.066, 0.078, 0.010, 1);
    P.add(wed, 'plastic', at(0, H_HUB + 0.058, -0.008, -0.30, 0, 0), T_MOUNT);
    // The latitude bolt pushing on the wedge from behind — a bright horizontal
    // stub low on a white body, and it is what tells you the wedge adjusts.
    const lb = V(0, H_HUB + 0.040, 0.052);
    seg(P, 'plastic', lb, lb.clone().add(V(0, 0.012, 0.036)), 0.0075, 0.0075, 6, T_CHROME);
    // Red, and on purpose. Round 2's ring inversion was right but it left the
    // prop with two six-pixel chips of colour visible from one bearing — white,
    // grey and black in a warm desaturated valley, i.e. concrete. The brief is
    // explicit that these are saturated manufactured objects and that the
    // contrast is most of what makes them read as somebody's kit. The lock
    // knobs are where a real mount puts its colour and they are the parts that
    // survive at twenty pixels, because they sit proud against a white casting.
    knob(P, 'plastic', lb.clone().add(V(0, 0.016, 0.048)), V(0, 0.32, 0.95).normalize(),
         0.019, 0.022, T_RED);

    // The RA housing, along the polar axis.
    // The dominant mass. Fattened from 0.046 to 0.058 so it is half again the
    // DEC housing's diameter rather than a tenth more than it.
    const ra0 = base.clone().addScaledVector(pol, 0.030);
    const ra1 = base.clone().addScaledVector(pol, 0.185);
    // NOT enamel. The polar axis and the tube are close to parallel by
    // construction — they are 16 degrees apart, which is roughly what the plate
    // has — and a 0.61 R light-grey cylinder in the tube's own colour lying
    // directly under it fuses with it: measured at squint size, the two read as
    // one stepped tube and the mount disappears. The plate gets away with a
    // white head because a photograph has a specular break between the two
    // castings and this renderer does not.
    //
    // So the break is made in value instead. The RA housing is the mount's
    // biggest mass and it is now clearly darker than the tube it carries, which
    // is also what lets the counterweight's bright shaft read against it.
    seg(P, 'plastic', ra0, ra1, 0.058, 0.052, 12, T_MOUNT);
    // Setting-circle rings: two dark bands around the housing. Real ones are
    // engraved silver; here they are the value break that keeps a 155 mm white
    // cylinder from being a blank.
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.048),
        base.clone().addScaledVector(pol, 0.068), 0.0595, 0.0585, 12, T_SHELL);
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.156),
        base.clone().addScaledVector(pol, 0.176), 0.0535, 0.0525, 12, T_SHELL);
    // The polar-scope cap at the bottom end of the axis.
    seg(P, 'plastic', base.clone().addScaledVector(pol, 0.026),
        base.clone().addScaledVector(pol, 0.010), 0.024, 0.021, 10, T_SHELL);

    // The DEC housing, across the top of the polar axis.
    const dec = V(1, 0, 0).addScaledVector(pol, -V(1, 0, 0).dot(pol)).normalize();
    const dc = base.clone().addScaledVector(pol, 0.190);
    seg(P, 'plastic', dc.clone().addScaledVector(dec, -0.050),
        dc.clone().addScaledVector(dec, 0.058), 0.036, 0.036, 12, T_MOUNT);
    seg(P, 'plastic', dc.clone().addScaledVector(dec, -0.060),
        dc.clone().addScaledVector(dec, -0.046), 0.0385, 0.0385, 12, T_SHELL);
    // The dark break where the counterweight arm leaves the head — see the
    // note on CHROME. Without it the weight is a white puck joined to a white
    // housing by a pale line, and the three read as one shape.
    seg(P, 'plastic', dc.clone().addScaledVector(mUp, -0.028),
        dc.clone().addScaledVector(mUp, -0.010), 0.026, 0.022, 10, T_SHELL);

    // ── the counterweight ────────────────────────────────────────────────
    //
    // The shaft is an extension of the DECLINATION axis, not of the polar one,
    // and getting that wrong is the difference between a German equatorial
    // mount and a thing with a weight stuck on it.
    //
    // The first build ran the shaft down the polar axis, which put it inside
    // the tripod: measured, the weight's centre landed at y 0.83 with the hub
    // at 0.905 and the legs splaying past it on every side, so the single most
    // distinctive object on this telescope was invisible from every one of the
    // six turntable angles. On the DEC axis it hangs out to `-mUp` — down and
    // AWAY from the tube, clear of the legs by 0.25 m — which is where the
    // reference has it and, more to the point, is what balances a 0.7 m tube
    // sitting a ring's height up on the other side.
    //
    // It is also the best silhouette element on the prop. Squint at the plate
    // and what survives is a bright bar raked up one way and a heavy dark-ended
    // stub raked down the other; that opposed diagonal is the whole read of an
    // equatorial mount, and nothing else in this camp has a shape like it.
    // How far out the weight sits is the identity of the whole prop and it was
    // wrong twice. The plate has it at roughly 75-80% of the shaft with only a
    // short stop beyond, so the silhouette carries a heavy mass at the END of a
    // long arm; at the midpoint (which is where it was) there is 150 mm of bare
    // shaft past it, the arm reads as twice as long as it needs to be, and the
    // mass reads as sitting in the middle of nothing.
    const cw = mUp.clone().negate();
    const s0 = dc.clone().addScaledVector(cw, 0.016);
    seg(P, 'plastic', s0, s0.clone().addScaledVector(cw, 0.378), 0.0104, 0.0104, 8, T_CHROME);
    // The weight is NOT the tube's white.
    //
    // At `T_ENAMEL` it was the same value as the optical tube, hung on a merged
    // shaft with a black stub past it, and it read as a white lunchbox floating
    // beside the tripod — at dusk, as a lantern. A counterweight is a lump of
    // cast iron with a painted skin; holding it a third under the enamel keeps
    // it subordinate to the tube while staying clearly lighter than the mount's
    // hardware, which is the hierarchy the plate has.
    // Darker again. At 0.62 of the enamel it still squinted to a SECOND light
    // mass of near-tube value hanging off nothing legible — a lantern, a
    // bottle, a battery pack, depending on the bearing. A counterweight is cast
    // iron under a thin skin of paint and it is subordinate to the tube in
    // every photograph of one; 0.40 puts it clearly below the tube while
    // keeping it above the mount castings it hangs from.
    const T_WEIGHT = [T_ENAMEL[0] * 0.40, T_ENAMEL[1] * 0.41, T_ENAMEL[2] * 0.44];
    const wc = s0.clone().addScaledVector(cw, 0.242);
    // A drum LONGER than it is wide, with the shaft running visibly through it.
    //
    // Round 4's version was 1:0.85 — squat, with the shaft stopping at its face
    // — and it read as a paint tin, a bucket and a lollipop head to three
    // different passes. A counterweight is a thick disc threaded onto a bar,
    // and the two things that say so are that the bar comes out the far side
    // and that the disc is deeper than it is wide seen from the side. So: 1:1.5
    // the other way, and the shaft continues past it to its stop.
    seg(P, 'plastic', wc.clone().addScaledVector(cw, -0.062),
        wc.clone().addScaledVector(cw, 0.062), 0.068, 0.068, 20,
        skyGrad(T_WEIGHT, 0.20, (x, y, z) => {
          const q = V(x, y, z).sub(wc); const a = q.dot(cw);
          q.addScaledVector(cw, -a); const l = q.length();
          return l < 1e-5 ? 0 : q.y / l;
        }));
    // Chamfers, so the weight is a machined puck and not a bead.
    seg(P, 'plastic', wc.clone().addScaledVector(cw, -0.073),
        wc.clone().addScaledVector(cw, -0.062), 0.055, 0.068, 20, T_WEIGHT);
    seg(P, 'plastic', wc.clone().addScaledVector(cw, 0.062),
        wc.clone().addScaledVector(cw, 0.073), 0.068, 0.055, 20, T_WEIGHT);
    // The clamp knob on the weight, and the safety stop at the end of the
    // shaft. The stop matters more than its size suggests: it is the dark full
    // stop that ends the diagonal, and without it the shaft reads as a bar that
    // has been cut off by the edge of the model.
    // The lock knob, on the shaft below the weight where a real one is, and
    // clear of the drum so it is a separate object at squint size.
    knob(P, 'plastic', wc.clone().addScaledVector(cw, 0.108), cw, 0.017, 0.019, T_RED);
    seg(P, 'plastic', s0.clone().addScaledVector(cw, 0.362),
        s0.clone().addScaledVector(cw, 0.382), 0.017, 0.017, 8, T_SHELL);

    // Two slow-motion cables. They hang, they are the thinnest things on the
    // prop, and they are the detail that makes the mount look operable —
    // swept, not straight, because a flexible cable that is dead straight is
    // the most obvious modelled object on any telescope.
    const cable = (from, aim, len, droop) => {
      const a = aim.clone().normalize();
      const g = sweptArc((t) => from.clone()
        .addScaledVector(a, len * t)
        .add(V(0, -droop * t * t, 0)), 12, 0.0075, 6);
      // Dark, not `LEGMET` and not `CHROME`: it hangs into the tripod and
      // crosses a leg, and at either of those values it merged with the leg and
      // read as a dipstick. A corrugated flexible sheath is a dark object.
      P.add(g, 'plastic', null, [T_SHELL[0] * 1.9, T_SHELL[1] * 1.9, T_SHELL[2] * 2.0]);
      const end = from.clone().addScaledVector(a, len).add(V(0, -droop, 0));
      const kd = a.clone().add(V(0, -droop * 2, 0)).normalize();
      knob(P, 'plastic', end.clone().addScaledVector(kd, 0.016), kd, 0.0125, 0.026, T_SHELL);
    };
    // ONE cable, not two. Two of them, roughly symmetric, arcing out of either
    // side of the head, read as insect antennae — and at 8.4 mm each was a
    // single pixel at play framing, which is not "thin", it is missing. The
    // plate has one, on a corrugated sheath about 15 mm across, in a strong
    // droop. "Thin things stay thin" is a rule about structural members; a
    // sub-pixel feature is just crawl.
    cable(dc.clone().addScaledVector(dec, 0.056).add(V(0, -0.012, 0)),
          dec.clone().add(V(0, -0.62, 0.30)), 0.205, 0.165);

    // The saddle plate on the DEC axis, which the dovetail drops into.
    const sd = basis(mUp, dir);
    const sc = dc.clone().addScaledVector(mUp, 0.032);
    P.add(rbox(0.056, 0.028, 0.100, 0.006, 1), 'plastic',
      M().makeBasis(sd.x, sd.y, sd.z).setPosition(sc), T_SHELL);
    knob(P, 'plastic', sc.clone().addScaledVector(dec, 0.048), dec, 0.016, 0.026, T_RED);
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
  // 0.30 was enough gradient to show quantised longitudinal banding across a
  // 20-sided cylinder at close range, which fights the roundness it is there to
  // create. 0.20, plus the cool underside, plus grime around the rings and the
  // focuser where hands actually go.
  const enamel = tintMul(
    skyGrad(T_ENAMEL, 0.20, axisUp),
    grimed([1, 1, 1], wear, [
      [tubeC.x + dir.x * 0.185 + upPerp.x * 0.06,
       tubeC.y + dir.y * 0.185 + upPerp.y * 0.06,
       tubeC.z + dir.z * 0.185 + upPerp.z * 0.06, 0.10, 0.40],
      // Held well clear of the mirror cell. At 0.34 m this band reached the
      // rear end face and drew a maroon smear across it, which on a part whose
      // whole job is to NOT read as a lens is the worst place in the model to
      // put a stain.
      [tubeC.x - dir.x * 0.105, tubeC.y - dir.y * 0.105, tubeC.z - dir.z * 0.105,
       0.055, 0.20],
    ]),
  );
  // Same clamp as the refractor's, and for the same reason — the front band and
  // the focuser are the reflector's black and they must not go blue at dusk.
  const shell = skyGrad(T_SHELL, 0.18, axisUp);

  // The tube: 20 sides, because at 190 mm across this is the one cylinder in
  // the file whose profile is the object.
  // 28 sides, not 20.
  //
  // A column scan across the r12 tube found seven discrete value plateaus with
  // hard 12-18/255 steps between them — corrugated metal, not enamel. That is
  // the stylised lighting quantising diffuse into bands, and it lands on facet
  // boundaries, so the only lever geometry has is to make each facet narrower
  // than the band it would otherwise fill. At 190 mm across this is the one
  // cylinder in the file big enough for the steps to be visible and big enough
  // to afford the triangles.
  seg(P, 'plastic', A(-0.300), A(0.360), R, R, 28, enamel);
  // Front ring — the wide black band at the OPEN end, and now the only black
  // disc on the tube.
  // Shortened from 0.072 m to 0.046 — from about 0.38 tube diameters to 0.24.
  // Together with the dark cavity behind it the sky end was reading as a solid
  // black cap 0.9-1.0 diameters deep, which is a dew shield, which is a
  // refractor. The black at this end has to be a BAND, and the mass beside it
  // has to be the focuser.
  seg(P, 'plastic', A(0.326), A(0.372), R * 1.012, R * 1.012, 28, shell);
  // The rear cell is a NARROW black trim ring on an enamel end, not a black cap.
  //
  // Round 3's version put a 40 mm black band and a full black end face at the
  // low end of the tube, and from front, three-quarter, side and back — every
  // bearing where the tube foreshortens — that presented a dark disc about
  // three quarters of the tube's silhouette width, sitting exactly where a
  // refractor's objective sits. The critic read the whole prop as a big
  // refractor aimed downward and was right to: the black belongs at the OPEN
  // end, and putting a second black disc at the closed end throws away the one
  // asymmetry that says which way a Newtonian points.
  seg(P, 'plastic', A(-0.318), A(-0.296), R * 1.012, R * 1.008, 28, shell);
  // A DOME, not an end face.
  //
  // Round 3 had a black cap here and round 4 made it an enamel disc, and both
  // failed the same way for the same reason: any flat face normal to the tube
  // axis presents, at every bearing where the tube foreshortens, a filled
  // circle 85% of the tube's silhouette width sitting exactly where a
  // refractor's objective sits. It does not matter what value it is — round 3's
  // was dark against a light tube, round 4's was light against a dark one at
  // dusk, and the second was worse because three collimation bolts on a pale
  // disc make a face. What has to go is the DISC.
  //
  // A shallow cone has no facet normal to the axis, so it shades as part of the
  // cylinder from every bearing, and the flat that remains at its centre is
  // under 40% of the tube's width — small enough to read as a cell boss rather
  // than as a lens.
  seg(P, 'plastic', A(-0.336), A(-0.316), R * 1.006, R * 0.995, 28, enamel);
  seg(P, 'plastic', A(-0.372), A(-0.336), R * 0.38, R * 0.995, 28, enamel);
  disc(P, 'plastic', A(-0.370), dir.clone().negate(), R * 0.37, 20, T_MOUNT);
  // Open mouth: a dark disc set well back inside the tube. The single strongest
  // "this is a Newtonian" cue in the plate is that the front end is a hole.
  // The inside of the tube, and it is lifted well off the rim's black.
  //
  // The mouth disc was `T_GLASS` set 72 mm back inside a `T_SHELL` ring with
  // `T_SHELL` spider vanes in it — everything in the hole the same near-black
  // as the rim, so there was no hole. The sky end read as a solid black
  // cylinder, which is precisely the silhouette of a refractor's dew shield and
  // a large part of why this object was reading as a big refractor. A cavity
  // needs a value step at its mouth: the wall inside is lifted, the disc at the
  // bottom stays dark, and the secondary is lifted further still so there is
  // something IN the hole to see.
  seg(P, 'plastic', A(0.296), A(0.372), R * 0.965, R * 0.965, 28,
      [T_SHELL[0] * 2.6, T_SHELL[1] * 2.6, T_SHELL[2] * 2.7], false);
  disc(P, 'plastic', A(0.296), dir, R * 0.96, 28, T_GLASS);
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
    seg(P, 'plastic', m.clone().addScaledVector(md, -0.011), m.clone().addScaledVector(md, 0.011),
        0.026, 0.026, 10, [T_CHROME[0] * 0.55, T_CHROME[1] * 0.55, T_CHROME[2] * 0.58]);
  }
  // The rear cell's collimation bolts.
  for (let i = 0; i < 3; i++) {
    const a = i * (TAU / 3) + 0.5;
    const v = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(upPerp, Math.sin(a));
    // Dark. At 18 mm of chrome on a black disc these read as three bright polka
    // dots — a speaker grille, not collimation hardware — and at dusk they were
    // the brightest thing on the back of the tube.
    // On the SIDE WALL of the cell, not on the end face. Three bright dots
    // arranged on a disc are a face; three bolts around a cylinder are
    // hardware, and they stay legible without turning the tube's end into one.
    bolt(P, A(-0.306).addScaledVector(v, R * 1.014), v, 0.009, T_CHROME_DK);
  }

  // ── rings and dovetail ────────────────────────────────────────────────────
  // The red is the only saturated colour on the object and there is very little
  // of it. That is the point: two thin red bands on a white tube is jewellery,
  // and a red tube would be a toy.
  // The rings are BLACK bands with a RED clamp block, which is what the plate
  // shows and is the inverse of the first build.
  //
  // Painting the whole circumference red put a mid-value colour where the
  // tube's only interruptions are, and once the tube itself had gone tan under
  // a warm sun the two sat close enough in value to merge — at play framing the
  // tube read as one unbroken white lozenge with no ring on it at all. Black
  // bands do the job note 3 in this file's header describes: they cut the
  // bright bar into three unequal segments and they cannot be talked out of it
  // by the light. The red survives as the clamp block on one side, which is
  // where the plate's red actually is, and two small patches of a saturated
  // colour is jewellery where a red tube would be a toy.
  const ringAt = (s) => {
    const c = A(s);
    // 52 mm on a 190 mm tube was ring/diameter 0.27 against the plate's 0.13 —
    // black zebra stripes taped to a barrel. And at R * 1.055 they stood 5 mm
    // proud of a 95 mm radius, which is nothing in silhouette. Half the width,
    // twice the standoff: a ring you can see the shape of from the side.
    seg(P, 'plastic', A(s - 0.018), A(s + 0.018), R * 1.135, R * 1.135, 28, T_SHELL);
    // The hinge boss and the clamp block, on opposite sides.
    const hd = side.clone();
    bolt(P, c.clone().addScaledVector(hd, R * 1.14), hd, 0.014, T_SHELL);
    const kd = upPerp.clone().multiplyScalar(0.55).addScaledVector(side, -0.83).normalize();
    const bb = basis(kd, dir);
    P.add(rbox(0.042, 0.040, 0.048, 0.006, 1), 'plastic',
      M().makeBasis(bb.x, bb.y, bb.z).setPosition(c.clone().addScaledVector(kd, R * 1.16)),
      T_RED);
    knob(P, 'plastic', c.clone().addScaledVector(kd, R * 1.16 + 0.026), kd, 0.013, 0.022, T_SHELL);
    // The foot of the ring, down onto the dovetail.
    const dn = mUp.clone().negate();
    seg(P, 'plastic', c.clone().addScaledVector(dn, R * 1.00),
        c.clone().addScaledVector(dn, R + 0.030), 0.030, 0.026, 8, T_SHELL);
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
    // ── the focuser, which is the whole Newtonian read ──────────────────
    //
    // The critic's single named change, and it is right. Three things say
    // "Newtonian on an equatorial mount" and only one of them is cheap: a large
    // body projecting at a hard angle out of the tube, a quarter of the way
    // back from the OPEN end. That perpendicular break in an otherwise smooth
    // bar is what the eye reads, and it survives being squinted at when the
    // aperture and the mount elbow do not.
    //
    // The r10 focuser had the geometry but pointed it 23 degrees above
    // horizontal — almost straight sideways — so it foreshortened to nothing
    // from the side and the high angles and hid behind the tube from the front.
    // At 5x it read as an irregular black amoeba coplanar with the barrel: a
    // scorch mark. 55 degrees up-and-out, and roughly twice the mass: the
    // plate's focuser body is about 55 mm and stands 110 mm proud.
    const fd = side.clone().multiplyScalar(0.58).addScaledVector(upPerp, 0.82).normalize();
    const f0 = A(0.185).addScaledVector(fd, R * 0.95);
    seg(P, 'plastic', f0.clone().addScaledVector(fd, -0.030),
        f0.clone().addScaledVector(fd, 0.052), 0.0425, 0.0400, 12, T_SHELL);
    seg(P, 'plastic', f0.clone().addScaledVector(fd, 0.046),
        f0.clone().addScaledVector(fd, 0.092), 0.0290, 0.0290, 10, T_CHROME);
    // The eyepiece and its cup.
    seg(P, 'plastic', f0.clone().addScaledVector(fd, 0.086),
        f0.clone().addScaledVector(fd, 0.128), 0.0245, 0.0228, 10, T_SHELL);
    seg(P, 'rubber', f0.clone().addScaledVector(fd, 0.124),
        f0.clone().addScaledVector(fd, 0.148), 0.0238, 0.0262, 10, T_FOOT);
    disc(P, 'plastic', f0.clone().addScaledVector(fd, 0.146), fd, 0.0150, 12, T_GLASS);
    EP_OUT.copy(f0).addScaledVector(fd, 0.112);
    // Focus knobs, on an axis across the focuser.
    const kd = new THREE.Vector3().crossVectors(fd, dir).normalize();
    knob(P, 'plastic', f0.clone().addScaledVector(kd, 0.046), kd, 0.021, 0.019, T_SHELL);
    knob(P, 'plastic', f0.clone().addScaledVector(kd, -0.046), kd, 0.021, 0.019, T_SHELL);
    seg(P, 'plastic', f0.clone().addScaledVector(kd, -0.042), f0.clone().addScaledVector(kd, 0.042),
        0.0080, 0.0080, 6, T_CHROME);

    // The finder: a small tube on a two-post bracket, parallel to the OTA and
    // offset around the barrel from the focuser.
    // Further FORWARD and higher than the focuser, and rolled well around the
    // barrel from it. Sitting level with the focuser and the same distance off
    // the tube, both in the same black, the two read as a pair of eyes with the
    // focuser's rectangle as a nose between them — the whole tube end read as a
    // face, which once seen cannot be unseen. Breaking the symmetry in all
    // three of position, height and roll is what kills it, and it is also what
    // the plate does: its finder is up on a bridge near the front, the focuser
    // is a barrel out of the side further back.
    // Roughly twice the size, and it changes diameter along its length. At
    // 15.5 mm on a 190 mm tube it rendered as a nine-pixel uniform bar with a
    // right-angle bracket and read as a handle or a bit of bent wire — a
    // constant-width stick is a stick whatever it is meant to be. The plate's
    // finder is about 30 mm with a tapered dew cap and two visible saddles.
    const nd = side.clone().multiplyScalar(-0.42).addScaledVector(upPerp, 0.91).normalize();
    const n0 = A(0.244).addScaledVector(nd, R + 0.076);
    seg(P, 'plastic', n0.clone().addScaledVector(dir, -0.086),
        n0.clone().addScaledVector(dir, 0.052), 0.0210, 0.0246, 10, T_SHELL);
    seg(P, 'plastic', n0.clone().addScaledVector(dir, 0.046),
        n0.clone().addScaledVector(dir, 0.094), 0.0288, 0.0282, 10, T_SHELL);
    disc(P, 'plastic', n0.clone().addScaledVector(dir, 0.090), dir, 0.0230, 12, T_GLASS);
    // The eyepiece end, narrow — the taper is the whole point.
    seg(P, 'plastic', n0.clone().addScaledVector(dir, -0.104),
        n0.clone().addScaledVector(dir, -0.080), 0.0158, 0.0170, 8, T_SHELL);
    for (const s of [-0.052, 0.030]) {
      seg(P, 'plastic', n0.clone().addScaledVector(dir, s).addScaledVector(nd, -0.020),
          A(0.244 + s).addScaledVector(nd, R * 0.98), 0.0180, 0.0180, 8, T_SHELL);
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI + 0.9;
        const v = side.clone().multiplyScalar(Math.cos(a))
          .addScaledVector(new THREE.Vector3().crossVectors(nd, dir), Math.sin(a));
        bolt(P, n0.clone().addScaledVector(dir, s).addScaledVector(v, 0.023), v, 0.0065);
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

  // Read here as well as in each variant, so the gallery's option scanner —
  // which reads `buildTelescope`'s own source and nothing deeper — offers the
  // wear slider. Both variants read it again from `opts`; this is the
  // declaration, not the value.
  const wear = clamp01(opts.wear ?? 0.45);

  const info = variant === 'reflector'
    ? buildReflector(P, rnd, { ...opts, wear })
    : buildRefractor(P, rnd, { ...opts, wear });

  P.flush(g, { cast: true, receive: true });

  // The ground contact, sized off the tripod that was actually built. Two
  // scales, because one does not do the job: a broad soft pool the size of the
  // footprint reads as the mass of the instrument sitting there, and a tight
  // dark spot under each foot reads as the three points that are actually
  // touching. The chair gets both for free out of the shadow map; this gets
  // neither, so both are authored.
  //
  // Measured, not asserted, BEFORE the contact pool is attached: the footprint
  // is what the layout solver keeps clear, and the shadow is not something
  // anything has to be kept clear of. Attaching first put a 1.17 m radius into
  // a field that means "do not place a chair inside this".
  const bb = new THREE.Box3().setFromObject(g);
  g.userData.footprint = Math.max(
    Math.abs(bb.min.x), Math.abs(bb.max.x),
    Math.abs(bb.min.z), Math.abs(bb.max.z),
  ) * 0.82;

  //
  // THREE FOOT POOLS AND ONE UNDER THE HEAD — not one pool spanning the
  // footprint.
  //
  // The single broad pool measured well and read wrong, and the critique put
  // the reason better than the measurement could: a chair earns one soft oval
  // because it has a seat occluding the sky, and a tripod is mostly air. One
  // ellipse across the whole footprint is a spill, and from the plan view it
  // was unmistakably a decal — a clean outer boundary with a second concentric
  // halo inside it. It also failed where it most needed to work: at radius
  // `spread * 1.16` the feet sat at 23% of the plateau, so the darkest ground
  // was in the middle where nothing touches and the faintest was under the
  // three points that do.
  //
  // Three pools, one per foot, put the darkness where the contact is. The small
  // one under the head is what the instrument itself occludes — a 1.5 m
  // telescope does throw something, just not through its legs.
  {
    // Three pools, one per foot. NO head pool, and the radius cut to about
    // twice the foot's width.
    //
    // The head pool was the broad pool's mistake at a smaller scale: it sat on
    // open ground with nothing touching it at every bearing, and from above it
    // was the largest of the four. A chair seat is a broad opaque mass 40 cm
    // up; a tripod hub is a 10 cm casting 90 cm up, and it earns nothing.
    //
    // The cone's HEIGHT and its RADIUS have to move together, and one revision
    // here moved only the radius: shrinking it to 104 mm while leaving the
    // centre 64 mm proud turned a 10-degree wedge lying on the ground into a
    // 35-degree cone standing on it, and the measured contact fell even though
    // the depth had been raised. The span still has to cross the dirt band —
    // `camp_ground.js` puts its surface up to 35 mm above the terrain height
    // this prop was placed against, and a shallower cone lost 95% of one foot's
    // pool to a hummock on one capture — so the rule is: yTop about a third of
    // the radius, and never under 45 mm.
    const parts = [];
    for (const L of info.tripod.legs) {
      const spot = contactPatch(0.165, 0.95, 0.055, -0.009, 22);
      spot.translate(L.foot.x, 0, L.foot.z);
      parts.push(spot);
    }
    addContact(g, parts);
  }

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

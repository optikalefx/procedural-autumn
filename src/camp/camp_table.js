// ─────────────────────────────────────────────────────────────────────────────
//  camp_table — the folding camp table.
//
//  Shape language: a GCI-style compact aluminium folding table (see the plates
//  in `reference-art/table/`). Three things make that object read, and every
//  number below is in service of one of them:
//
//   1. **A black anodised slat top with real gaps.** You can see the ground
//      through it. This is the whole character of the prop — the moment the top
//      becomes a solid black plane it is a floating slab, which is exactly what
//      the placeholder was. Eight slats across a 450 mm depth is a 56 mm pitch,
//      of which 44 mm is slat and 12 mm is air; that 21% open ratio survives
//      being 20 m away as a *tone* (the top greys down) instead of collapsing
//      into a moiré, because the gap is wide relative to the slat rather than a
//      hairline. A twenty-slat top looks better in a close-up and turns into
//      crawling static at any distance a player actually stands.
//
//   2. **A bright mill-finish X-frame.** This is the only low-roughness,
//      high-metalness object in the whole camp and that is a gift: it throws one
//      bright line down the length of each leg, and a bright line is what pins a
//      thin object into space. A 22 mm leg is about six pixels at 15 m; six grey
//      pixels are a smudge, six grey pixels with a two-pixel highlight down one
//      side are a metal tube. So the leg section is a *flattened* hexagon —
//      22 mm in the plane of the X (where the bending load is, which is also why
//      real ones are extruded this way) and 14.5 mm across it — and the flat is
//      deliberately oriented so one narrow shoulder facet takes the sun while
//      the broad face stays diffuse. See `beam()`.
//
//   3. **Black plastic at every joint.** Collars where the X crosses, a collar
//      where each leg meets the top, moulded feet, and a flat black stabiliser
//      bar tying each leg pair together at the bottom. Without these the frame
//      is four sticks; with them it is a mechanism that folds. They also do
//      compositional work: the dark nodes break the bright legs into segments,
//      which is what stops the frame reading as a wire diagram.
//
//  Construction follows the camper: author everything as primitives placed by
//  matrix, bin by material, merge once. The whole table is five draw calls.
//
//  Geometry: origin at ground centre, +Z is the long front edge, metres.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, at, rbox, tube, sweptArc, dusted, tintFrom, tintMul, M,
} from './camp_materials.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Material base colours, needed by `tintFrom` whenever a part borrows a shared
// material and has to be talked out of that material's own colour. Keep these
// in step with `campMaterials()`; they are the only coupling this file has to
// the kit's internals and a mismatch shows up as a wrong-coloured mug rather
// than as an error, so it is worth the duplication being explicit.
const HEX_HDPE = 0x8f3a3c;
const HEX_PLASTIC = 0x2a2a2e;
const HEX_WOOD = 0x8a6a46;
// Mill aluminium. Not the kit's 0xb9bdc2: that is a cool grey, right for the
// metal itself but wrong for a dielectric standing in for it, because without a
// metal's dark diffuse the cool cast survives into the midtones and the legs
// come out lavender against warm dirt. Nearly neutral instead, and held well
// below white — the ×1.4 sky gradient in `beam()` is what takes the upward
// facets to near-white where the plan view needs them, and holding the base
// down is what keeps the side facets from going chalky at eye level and keeps
// the frame from being the brightest thing in the camp at dusk. The fire is.
const HEX_ALU = 0xa9aaa8;
const HEX_ANOD = 0x2b2c30;
const HEX_STEEL = 0xa8abae;

// ─────────────────────────────────────────────────────────────────────────────
//  Material descriptors — and the one open request this file has.
//
//  This prop is made of metal, and right now the kit's metals cannot be lit.
//  `campMaterials()` gives `alu`, `anod` and `steel` an `envMapIntensity` but no
//  `envMap`, and nothing in `src/` sets `scene.environment`; a standard material
//  at 0.88 metalness keeps only `albedo * (1 - metalness)` as diffuse and puts
//  the rest into an F0 with no environment to reflect, and `Stylize.js` flattens
//  the direct specular that is left. Measured on r1: the anodised top sampled
//  `rgb(51,41,33)` and the aluminium leg touching it sampled `rgb(51,41,33)` —
//  identical to the bit, in every frame — while the dirt under them was at 105
//  luma. The whole table was one flat black cut-out.
//
//  The fix belongs in `camp_materials.js`, which is not this author's file; the
//  request is logged in `docs/CAMP_REQUESTS.md` and `CamperModel.buildEnvMap()`
//  already bakes exactly the probe wanted. Until it lands, the frame and the top
//  are authored against `plastic` — a dielectric at roughness 0.56, the sharpest
//  specular lobe among the kit's non-metals — and `tintFrom()` carries it to the
//  right colour. That buys the reference's value structure (bright frame against
//  a dark top, which is most of what makes this object read) and loses the metal
//  itself: no bright line down the leg, which is the detail the brief cares
//  about most.
//
//  To revert, when the metals can see a sky: put each `key`/`hex` pair back to
//  the commented value. Every tint in the file is computed through `tintFrom`
//  against `hex`, so nothing else has to change.
// ─────────────────────────────────────────────────────────────────────────────
const FRAME = { key: 'plastic', hex: HEX_PLASTIC, want: HEX_ALU };   // 'alu'
const TOP   = { key: 'plastic', hex: HEX_PLASTIC, want: HEX_ANOD };  // 'anod'
const BOSS  = { key: 'plastic', hex: HEX_PLASTIC, want: HEX_STEEL }; // 'steel'
const DARK  = { key: 'plastic', hex: HEX_PLASTIC, want: HEX_PLASTIC };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * Place a flattened hexagonal beam spanning `a` → `b`.
 *
 * Why not `span()` + `tube()`: `span()` builds its rotation with
 * `setFromUnitVectors`, which picks *an* orientation about the beam axis rather
 * than a chosen one. For a round tube that is fine. For a section that is wider
 * one way than the other it is not — the flat has to face out of the plane of
 * the X, or the legs read as randomly twisted extrusions, and the roll error is
 * different for each of the four legs so it does not even look like a
 * consistent mistake.
 *
 * So the basis is built by hand: local +Y is the beam axis, local +X is `flat`
 * (orthonormalised against the axis) and local +Z is their cross product, taken
 * in that order so the determinant stays positive. A mirrored basis would flip
 * the winding on half the frame and `tools/winding.mjs` would — correctly —
 * fail the build.
 *
 * The authoring hexagon has a vertex on ±local-Z and a flat facet on ±local-X
 * (three.js starts `CylinderGeometry` at theta = 0, which puts a vertex on +Z),
 * so `wide` measures point-to-point and `thin` measures flat-to-flat.
 */
function beam(P, key, a, b, flat, wide, thin, tint = null, sky = 0) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return;
  dir.divideScalar(len);

  const nx = flat.clone().addScaledVector(dir, -flat.dot(dir));
  // Degenerate only if the caller asked for a flat parallel to the axis; fall
  // back to any perpendicular rather than emitting a NaN basis.
  if (nx.lengthSq() < 1e-9) nx.set(dir.y, -dir.x, 0);
  if (nx.lengthSq() < 1e-9) nx.set(0, dir.z, -dir.y);
  nx.normalize();
  const nz = new THREE.Vector3().crossVectors(nx, dir);

  const R = 0.01;                                   // authoring radius
  const kx = thin / (2 * Math.cos(Math.PI / 6) * R); // flat-to-flat is √3·R
  const kz = wide / (2 * R);                         // point-to-point is 2·R
  const m = M().makeBasis(nx.multiplyScalar(kx), dir, nz.multiplyScalar(kz));
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  m.setPosition(mid);

  // `sky` bakes the one thing the stopgap material cannot do for itself.
  //
  // A metal tube outdoors is not evenly lit: its upward facets see the whole
  // sky and its downward facets see the ground, so it carries a strong gradient
  // from bright along the top edge to dark underneath, and that gradient is
  // most of what makes a 22 mm tube read as round metal at eight pixels. A
  // dielectric standing in for it has no such gradient — it is a uniformly pale
  // rod, which at dusk reads as white plastic. So the gradient is written into
  // the vertex colour from each vertex's offset off the beam's own centreline:
  // +Y-facing goes up, -Y-facing goes down.
  //
  // It is baked, so it does not track the sun. That is correct rather than
  // lazy: the term stands in for the *sky*, which is overhead all day, and not
  // for the sun. When the metals get an environment map this can drop to about
  // a third of its value — the real probe will be doing the same job.
  const base = typeof tint === 'function' ? tint : () => (tint || [1, 1, 1]);
  const shaded = sky === 0 ? tint : (x, y, z) => {
    const px = x - mid.x, py = y - mid.y, pz = z - mid.z;
    const d = px * dir.x + py * dir.y + pz * dir.z;
    const rx = px - dir.x * d, ry = py - dir.y * d, rz = pz - dir.z * d;
    const r2 = rx * rx + ry * ry + rz * rz;
    const k = 1 + sky * (r2 > 1e-12 ? ry / Math.sqrt(r2) : 0);
    const c = base(x, y, z);
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  P.add(tube(R, len), key, m, shaded);
}

/**
 * The wear signal for the anodised top.
 *
 * Anodising is a dyed oxide layer grown into the metal, not a paint film, so it
 * does not chip — it goes *thin* where things have been dragged across it, and
 * a thin oxide reads as a slightly lighter, slightly warmer grey. Hard-edged
 * scratches would be the wrong story and would also alias horribly; this is
 * deliberately low-frequency so it survives being resolved at eight pixels.
 *
 * The extra term at the centre is where the pan goes down. It is the one piece
 * of wear on this prop a player might consciously notice.
 */
function anodWear(rnd, wear) {
  const p0 = rnd() * 6.2832, p1 = rnd() * 6.2832, p2 = rnd() * 6.2832;
  const amp = 0.055 + 0.10 * wear;
  return (x, y, z) => {
    const n = Math.sin(x * 6.1 + p0) * 0.5
            + Math.sin(x * 17.3 + z * 9.7 + p1) * 0.32
            + Math.sin(z * 27.0 + p2) * 0.18;
    const centre = smoothstep(0.20, 0.02, Math.hypot(x, z)) * 0.14 * wear;
    const m = 1 + n * amp + centre;
    // A hair cool. The camp sits on red dirt under a low autumn sun and a
    // neutral black picks up so much warm bounce it turns brown; holding a
    // little blue in it is what keeps the top reading as anodised metal
    // rather than as a plank.
    return [m * 0.965, m * 0.985, m];
  };
}

/**
 * Ground dust, as a *multiplier*.
 *
 * `dusted()` in the kit lerps a base colour toward a dust colour, which is the
 * right model when the base is roughly white. Here most tints are large
 * `tintFrom` multipliers — the frame's is about ×20, because it is talking a
 * near-black plastic into mill aluminium — and lerping ×20 toward ×1.1 does not
 * dust the bottom of the leg, it deletes it. So the dust is built against white
 * and multiplied in afterwards.
 */
const dustMul = (base, top, amount) =>
  tintMul(base, dusted([1, 1, 1], { top, amount }));

/**
 * @param {(…)=>number} rnd  seeded RNG
 * @param {object} opts      { wear: 0..1, dressed: boolean }
 * @returns {THREE.Group}    origin at ground centre, +Z is the long front edge
 */
export function buildTable(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_table';
  const P = new Parts('table');
  const wear = clamp01(opts.wear ?? 0.4);

  // ── size ───────────────────────────────────────────────────────────────────
  // A compact folding table is 550–600 mm on the long edge and sits at knee/arm
  // height beside a low camp chair, which is 380 mm at the seat. 400–440 mm is
  // the band that looks right next to it; anything at desk height (720 mm) next
  // to a camp chair reads instantly as a scale error, and scale errors are
  // invisible in a studio capture — the `wide` framing with the camper in it is
  // the one that catches them.
  const W = 0.536 + rnd() * 0.050;   // long axis, X
  const D = 0.420 + rnd() * 0.042;   // short axis, Z — the front edge faces +Z
  // 425–470 mm, not 400. The integrator's whole-camp plan frame is what moved
  // this: at 400 mm the top sat so close to the dirt that it and its own shadow
  // merged into one shape and the table read as a black doormat lying on the
  // ground. Height is the cheapest elevation cue there is — it pushes the cast
  // shadow clear of the top's own footprint — and 470 mm is still inside the
  // band the brief allows (0.6 × 0.6 at 0.5 is the big end of the same family).
  const H = 0.425 + rnd() * 0.045;   // slat top

  // ── the top ────────────────────────────────────────────────────────────────
  // A perimeter rail of black anodised extrusion carrying a panel of slats. The
  // rail is what stops the slats reading as loose sticks: it closes the
  // silhouette, and its 26 mm depth gives the top a real edge that catches a
  // terminator line all the way round instead of a paper-thin plane.
  const railT = 0.014;               // rail wall, horizontal
  const railH = 0.022;               // rail depth, vertical — top flush at H
  const anodBase = tintFrom(TOP.hex, TOP.want);

  // How the gaps read at eye level.
  //
  // They cannot read by being see-through, and it took a render to accept that:
  // the prop framing looks along the top from about 11° above it, and at 11° a
  // 10 mm gap is occluded by anything deeper than 2 mm of slat. A slat is 12.
  // So at eye level a slat top with real gaps in it shows no holes at all — and
  // neither does the reference plate, which is shot from about the same angle.
  // What the plate shows is a *bright slat face beside a dark recess*, which is
  // a value cue, not an occlusion one, and a value cue survives any angle and
  // any distance.
  //
  // So the top 1.5 mm of every slat and of the perimeter rail is lifted, and
  // everything below it is dropped to about a third. The top stops being a
  // plane and becomes corduroy. The r3 build had all of it on one flat value
  // and went solid black from every eye-level angle — the exact failure the
  // brief names.
  //
  // The lift is nearly ×2 rather than a nudge for a second reason: black
  // anodised aluminium under an open sky does not photograph black. In the
  // plate the slat faces sit around 30% grey with a sheen on them, and it is
  // 30% grey — not 17% — that keeps the top from dissolving into its own cast
  // shadow when the camera is high and far, which is where the integrator found
  // it dissolving.
  //
  // The ramp is deliberately deeper than the slat cap rather than confined to
  // it, because of what a *very* grazing view does. The prop framing looks
  // along the top from about 10° above, and at 10° a slat 12 mm deep occludes
  // 68 mm of the top behind it — more than the 54 mm pitch — so not one square
  // millimetre of any slat's top face is visible and the top is genuinely, not
  // apparently, a black plane. What you see instead is the *side wall* of each
  // slat with the gap beside it, so it is the side wall that has to carry the
  // stripe: it runs from nearly the face's value at the top down to the recess
  // value at the bottom, and the eye reads that alternation as slats. The slats
  // are also 8.5 mm deep now rather than 14, which pulls the occlusion angle in
  // far enough that the faces themselves come back by about 15°.
  const faceLift = (y) => 0.30 + 1.66 * smoothstep(H - 0.0090, H - 0.0005, y);
  const wearOf = anodWear(rnd, wear);
  const railTint = (x, y, z) => {
    const w = wearOf(x, y, z), f = faceLift(y);
    return [anodBase[0] * w[0] * f, anodBase[1] * w[1] * f, anodBase[2] * w[2] * f];
  };

  // Long rails, front and back, running the full width.
  for (const sz of [-1, 1]) {
    P.add(rbox(W, railH, railT, 0.0035),
      TOP.key, at(0, H - railH * 0.5, sz * (D * 0.5 - railT * 0.5)), railTint);
  }
  // End rails, left and right, between them.
  for (const sx of [-1, 1]) {
    P.add(rbox(railT, railH, D - railT * 2, 0.0035),
      TOP.key, at(sx * (W * 0.5 - railT * 0.5), H - railH * 0.5, 0), railTint);
  }

  // ── the slats ──────────────────────────────────────────────────────────────
  // 7–9 of them; see the header for why not more. Each is a two-piece section:
  // a 4 mm cap that is the face you see, and a 10 mm web hanging under it,
  // 12 mm narrower. The web is not structure-for-its-own-sake — it is what puts
  // a shadow under each slat edge, so from a low angle the gaps read as depth
  // rather than as painted stripes, and it is the difference between corduroy
  // and a barcode.
  const SLATS = 7 + Math.floor(rnd() * 3);
  const inner = D - railT * 2 - 0.004;      // clear span between the end rails
  const pitch = inner / SLATS;
  const slatW = pitch * 0.79;               // ~21% open
  const slatL = W - railT * 2 + 0.002;      // ends buried in the end rails

  for (let i = 0; i < SLATS; i++) {
    const z = (i + 0.5) / SLATS * inner - inner * 0.5;
    // Cap: segmented so the wear function has vertices to vary across, and
    // lightly rounded so its long edges take a highlight. The radius is small
    // on purpose — a 1.4 mm break, not a bullnose; anodised extrusion is sharp.
    P.add(rbox(slatL, 0.0040, slatW, 0.0013, 3),
      TOP.key, at(0, H - 0.0020, z), railTint);
    // Web. A plain box; it is never seen except in silhouette from below, and
    // it is what puts a real step — not just a painted one — under each slat
    // edge, which is what the plan view reads as gaps.
    P.add(new THREE.BoxGeometry(slatL - 0.003, 0.0045, slatW - 0.011),
      TOP.key, at(0, H - 0.00625, z), railTint);
  }

  // ── the frame ──────────────────────────────────────────────────────────────
  // Two X-frames, and they cross across the *width*, not the depth.
  //
  // This is worth being explicit about because the first pass got it backwards
  // and the mistake is invisible in a description and obvious in a render. The
  // plate settles it three ways at once: the two black stabiliser bars run
  // front-to-back, one down each side; the two pivot crossings are separated
  // along the *depth* of the table, one behind the other; and each bar's two
  // feet belong to legs that rise in the same direction. So a frame is a wide
  // trapezoid — two legs, one at the front and one at the back, both running
  // from the top corners on one side down to the feet on the other, tied by a
  // top tube at the head and by the black bar at the feet. Two of those, pinned
  // through each other on a shaft that runs front-to-back at the crossing.
  //
  // The payoff is compositional, not pedantic. With the X across the width it
  // reads as an X from the front, from both three-quarters and from the back —
  // four of the six angles a player sees. Crossing it across the depth hides it
  // in all four of those and only shows it from the side, which is how the r1
  // build ended up looking like a table on four bent sticks.
  //
  // The lean is not a style choice either: a leg that runs from one top corner
  // to the opposite foot on a 560 × 400 table is at atan(0.56 / 0.40) ≈ 54° from
  // vertical whether you like it or not. That is the object. The only free
  // choice is the depth splay, which is small — 8 mm proud of the top edge, so
  // the feet stand just outside the silhouette and the stance reads as braced.
  //
  // The feet stand 25 mm proud of the top's edge across the width and 22 mm
  // proud front-to-back, and that number is doing real work rather than being
  // an eyeballed detail. At the 8 mm the first pass used, the *entire frame*
  // was inside the top's own outline: seen from directly above — which is how a
  // player looking down at a camp mostly sees it — there was nothing outside
  // the black rectangle at all, so the table had no legs and no height and read
  // as a mat on the dirt. Pushing the feet out projects four bright leg ends
  // past the silhouette, and four bright ends round a dark rectangle is the
  // whole difference between a table and a stain.
  //
  // 25 mm is as far as it can go: the layout solver reserves a 0.40 m radius
  // for this prop and the corner foot is then 0.391 m out on the diagonal.
  const xt = W * 0.5 - 0.055;       // leg top, X — inboard of the corner
  const xf = W * 0.5 + 0.025;       // foot, X — proud of the top edge
  const zt = D * 0.5 - 0.038;       // leg top, Z
  const zf = D * 0.5 + 0.022;       // foot, Z — splayed outward
  const yTop = H - railH + 0.004;   // top of the leg, buried in the rail
  const yFoot = 0.046;              // bottom of the leg, buried in the foot

  const LEG_W = 0.022, LEG_T = 0.0145;   // in-plane × out-of-plane
  const SKY_ALU = 0.40, SKY_DARK = 0.20; // see `beam()`
  // Mill-finish aluminium is not a mirror and it is not uniform; a touch of
  // per-table tint keeps two tables in the same camp from being clones, and the
  // dust ramp over the lowest 110 mm is what sits the feet in the dirt rather
  // than on it.
  const aluJitter = 0.965 + rnd() * 0.06;
  const alu = tintFrom(FRAME.hex, FRAME.want);
  const aluTint = dustMul(
    [alu[0] * aluJitter, alu[1] * aluJitter, alu[2] * aluJitter * 0.995],
    0.11, 0.14 + 0.26 * wear);
  const blackTint = dustMul(tintFrom(DARK.hex, DARK.want), 0.075, 0.10 + 0.30 * wear);
  const bossTint = tintFrom(BOSS.hex, BOSS.want);

  // The crossing height falls out of the geometry rather than being dialled in:
  // two straight members between (±xt, top) and (∓xf, foot) meet at
  // xf / (xt + xf) of the way up — about 55% here, which is where the plate's
  // pivot sits. Deriving it means the crossing stays put when the size
  // randomiser moves W.
  const tCross = xt / (xt + xf);
  const zCross = zt + (zf - zt) * tCross;
  const yCross = yTop + (yFoot - yTop) * tCross;
  const xCross = 0;
  const EZ = V(0, 0, 1);

  for (const sx of [-1, 1]) {
    // `sx` is the side the frame's *head* is on; its feet are on the other side.
    const headX = sx * xt, footX = -sx * xf;
    const legs = [1, -1].map((sz) => ({
      sz,
      top: V(headX, yTop, sz * zt),
      foot: V(footX, yFoot, sz * zf),
    }));
    // The frame plane contains both legs and the front-to-back direction (the
    // two legs sit at matched depths either side of centre), so the normal is
    // just the leg direction crossed with +Z. Taken this way it stays
    // well-conditioned even if the depth splay is dialled to zero, which the
    // leg-cross-leg form would not be.
    const nrm = new THREE.Vector3()
      .crossVectors(new THREE.Vector3().subVectors(legs[0].foot, legs[0].top), EZ)
      .normalize();

    // Head tube: the frame's own top member, running front-to-back under the
    // slats and carrying both legs. It is what the legs actually hang off, and
    // it gives the gaps something with a lit edge to reveal from a low angle
    // instead of empty dark.
    beam(P, FRAME.key,
      V(headX, yTop + 0.004, -zt - 0.012), V(headX, yTop + 0.004, zt + 0.012),
      V(1, 0, 0), 0.019, 0.014, aluTint, SKY_ALU);

    for (const leg of legs) {
      beam(P, FRAME.key, leg.top, leg.foot, nrm, LEG_W, LEG_T, aluTint, SKY_ALU);

      // Collar where the leg meets the head tube. Kept short so the bright run
      // of the leg starts almost immediately below the table — a long bracket
      // eats the top of the specular line, which is the part of it that reads
      // against the dark top.
      beam(P, DARK.key,
        leg.top.clone().lerp(leg.foot, 0.010),
        leg.top.clone().lerp(leg.foot, 0.105),
        nrm, LEG_W + 0.009, LEG_T + 0.008, blackTint, SKY_DARK);

      // The moulded clamp that sits just below the pivot on each tube. In the
      // plates there are four of these and they are most of what says
      // "mechanism"; they also chop each leg into two bright segments of
      // unequal length, which is far better looking than one even run.
      beam(P, DARK.key,
        leg.top.clone().lerp(leg.foot, tCross + 0.045),
        leg.top.clone().lerp(leg.foot, tCross + 0.155),
        nrm, LEG_W + 0.010, LEG_T + 0.009, blackTint, SKY_DARK);
    }

    // ── stabiliser bar and feet ──────────────────────────────────────────────
    // The flat black bar tying this frame's two feet together, and the moulded
    // shoes it ends in. The bar is the single most useful thing on the whole
    // prop for making the table not float: it is a dark horizontal low down,
    // sitting directly against its own contact shadow, and the eye reads the two
    // together as ground contact even at a distance where the feet are gone.
    //
    // The whole assembly lives higher up the leg than a measurement off the
    // plate would put it — the shoe reaches 51 mm and the bar sits at 52 — and
    // that is a deliberate accommodation, not a scale error. The camp's dirt
    // decal is a *lifted* mesh: `camp_ground.js` adds `LIFT` 13 mm plus up to
    // 22 mm of berm and ±26 mm of hummock noise on top of the terrain the layout
    // solver placed this prop against. So the visible ground under a prop can
    // stand 30–40 mm above y = 0, and the r4 build proved it: the shoes spanned
    // −4…36 mm, every one of them was under the dirt, and all four legs came out
    // of the render as bare cut sticks ending in mid-air. Anything that has to
    // be seen touching the ground has to clear that band. Logged for the ground
    // author in `docs/CAMP_REQUESTS.md`; this is the belt to that braces.
    P.add(rbox(0.031, 0.014, zf * 2 + 0.050, 0.005),
      DARK.key, at(footX, 0.052, 0), blackTint);

    for (const sz of [-1, 1]) {
      P.add(rbox(0.036, 0.056, 0.058, 0.014),
        DARK.key, at(footX, 0.023, sz * zf), blackTint);
      // A rubber pad on the underside, a hair wider than the moulding so it
      // shows as a dark line under it — what a foot needs to not look like the
      // leg was simply cut off at ground level.
      P.add(rbox(0.038, 0.012, 0.060, 0.005),
        'rubber', at(footX, 0.003, sz * zf), blackTint);
    }
  }

  // ── the pivot ──────────────────────────────────────────────────────────────
  // The shaft the two frames turn on, running front-to-back between the two
  // crossings, with a stainless boss on the outside of each. The shaft is
  // hidden end-on from the front and from both three-quarters, and it is the
  // one strong horizontal in the profile view — which is exactly the view where
  // the X collapses and the frame would otherwise have nothing to say.
  beam(P, FRAME.key,
    V(xCross, yCross, -zCross - 0.014), V(xCross, yCross, zCross + 0.014),
    V(1, 0, 0), 0.014, 0.014, aluTint, SKY_ALU);
  for (const sz of [-1, 1]) {
    // 14 mm across, so it is one or two pixels of bright at distance — which is
    // right, because a highlight at the crossing is what tells you the two tubes
    // are joined rather than merely overlapping.
    const c = V(xCross, yCross, sz * zCross);
    beam(P, BOSS.key,
      c.clone().addScaledVector(EZ, sz * 0.014),
      c.clone().addScaledVector(EZ, sz * 0.026),
      V(1, 0, 0), 0.015, 0.015, bossTint, SKY_ALU);
  }

  if (opts.dressed) dressTable(P, rnd, W, D, H, wear);

  P.flush(g);
  // The corner foot lands 0.391 m from the origin on the diagonal, so 0.40 is
  // the honest clearance and it matches the radius `camp_site.js` reserves.
  g.userData.footprint = 0.40;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The still life
//
//  One or two objects, never three. This is the prop that most easily says
//  "somebody is here" and it is also the one that most easily tips into a shop
//  display; the restraint *is* the effect. A mug alone reads as someone who
//  stepped away for a minute, which is the exact feeling the camp is for.
//
//  Both objects are placed off-centre and off-axis. A mug in the middle of a
//  table, square to its edges, is a mug that was placed by a level editor.
// ─────────────────────────────────────────────────────────────────────────────
function dressTable(P, rnd, W, D, H, wear) {
  // Push things toward one end and one edge, but never past the last slat: an
  // object hanging over the rail would need a physics argument this prop has no
  // way to make.
  const side = rnd() < 0.5 ? -1 : 1;
  const mx = side * (W * 0.14 + rnd() * W * 0.16);
  const mz = (rnd() - 0.5) * D * 0.34;
  mug(P, rnd, mx, H, mz, rnd() * 6.2832, wear);

  // Roughly half the time, one more thing, always on the far side of the table
  // from the mug so the two read as a composition with a gap in it rather than
  // as a cluster.
  if (rnd() < 0.55) {
    const bx = -side * (W * 0.16 + rnd() * W * 0.12);
    const bz = (rnd() - 0.5) * D * 0.22;
    paperback(P, rnd, bx, H, bz, (rnd() - 0.5) * 1.1, wear);
  }
}

/**
 * An enamel mug — cream body, dark rolled rim, wire handle, and coffee in it.
 *
 * Sized off a real one: 78 mm tall, 76 mm across the rim. That is small — about
 * a fifth of the table's short edge — and it needs to be, because the thing a
 * mug does compositionally is give the eye a piece of known scale, and a mug
 * that is 10% too big makes the *table* read as a doll's-house table.
 *
 * The coffee matters more than it should. A cream cylinder is a cylinder; a
 * cream cylinder with a dark disc in the top is a container, and the dark disc
 * is also the only place on this prop where the eye can rest.
 */
function mug(P, rnd, x, y, z, yaw, wear) {
  const R = 0.038, HGT = 0.078;
  const cream = tintFrom(HEX_HDPE, 0xe8e4da);
  const rim = tintFrom(HEX_PLASTIC, 0x1d2a3c);
  const brew = tintFrom(HEX_PLASTIC, 0x2c1a10);

  const base = at(x, y, z, 0, yaw, 0);
  const local = (m) => M().multiplyMatrices(base, m);

  // Body: a hair narrower at the foot, the way a pressed steel mug is, so the
  // silhouette has a taper instead of being a straight-sided can.
  const body = new THREE.CylinderGeometry(R, R * 0.90, HGT, 14, 1, false);
  P.add(body, 'hdpe', local(at(0, HGT * 0.5, 0)), (px, py) => {
    // Enamel chips at the rim and the foot, where it has been knocked. Cheap,
    // low-frequency, and it keeps the mug from reading as new plastic.
    const k = wear * 0.16 * (smoothstep(HGT * 0.86, HGT, py) +
                             smoothstep(HGT * 0.10, 0, py));
    return [cream[0] * (1 - k * 0.5), cream[1] * (1 - k * 0.6), cream[2] * (1 - k * 0.7)];
  });
  // Coffee, sitting 8 mm down inside the rim.
  P.add(new THREE.CylinderGeometry(R * 0.90, R * 0.90, 0.004, 14),
    'plastic', local(at(0, HGT - 0.008, 0)), brew);
  // The rolled rim: a torus rather than a ring of box, because it is the one
  // edge on this object that is always catching light from somewhere.
  P.add(new THREE.TorusGeometry(R - 0.002, 0.0035, 5, 16),
    'plastic', local(at(0, HGT - 0.002, 0, Math.PI * 0.5)), rim);

  // Handle: swept by hand along a C, because `TorusGeometry` cannot be given
  // the flattened D-shape a real mug handle has and a plain half-torus reads as
  // a croissant. 5 sides is plenty at this size.
  P.add(sweptArc((t) => {
    const a = (-0.62 + t * 1.24) * Math.PI;         // ±112° of arc
    return new THREE.Vector3(
      R * 0.86 + Math.cos(a) * 0.030 * 0.78,
      HGT * 0.58 + Math.sin(a) * 0.030,
      0);
  }, 12, 0.0042, 5), 'hdpe', local(M()), cream);
}

/**
 * A paperback, face down and slightly askew.
 *
 * Built as cover / pages / cover / spine rather than as one coloured box,
 * because the read of a closed book is entirely in the contrast between the
 * coloured cover face and the cream page block on the other three edges. A
 * single box gets the silhouette right and looks like a brick.
 */
function paperback(P, rnd, x, y, z, yaw, wear) {
  const BW = 0.104, BD = 0.148, BT = 0.019;   // width, depth, thickness
  const covers = [0xa8493a, 0x3d5b52, 0x8a6f3c, 0x39445c];
  const cover = tintFrom(HEX_HDPE, covers[Math.floor(rnd() * covers.length) % covers.length]);
  // Paper yellows; a well-read paperback's block is nearer bone than white, and
  // it gets more so with wear.
  const pages = tintFrom(HEX_WOOD, 0xd6d2c6 - Math.floor(wear * 0x0a0a06));

  const base = at(x, y + BT * 0.5, z, 0, yaw, 0);
  const local = (m) => M().multiplyMatrices(base, m);

  P.add(rbox(BW - 0.004, BT - 0.006, BD - 0.004, 0.0012),
    'wood', local(M()), pages);
  for (const sy of [-1, 1]) {
    P.add(rbox(BW, 0.0026, BD, 0.0009),
      'hdpe', local(at(0, sy * (BT * 0.5 - 0.0013), 0)), cover);
  }
  // Spine, on the long edge. Rounded hard — a paperback spine is a fold, not a
  // corner, and this is the one silhouette cue that says "book" from above.
  P.add(rbox(0.0042, BT, BD, 0.0021),
    'hdpe', local(at(-(BW * 0.5 - 0.0021), 0, 0)), cover);
}

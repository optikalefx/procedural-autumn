// ─────────────────────────────────────────────────────────────────────────────
//  camp_chair — the two camp chairs.
//
//  The reference plates are two genuinely different products and both of them
//  are built here, picked by `opts.style`:
//
//    'sling'  a packable butterfly chair (Helinox Chair One / REI Flexlite).
//             Four splayed 14 mm legs meeting two small moulded hubs, a shallow
//             X of shock-corded tube, and ONE deep fabric bucket that is the
//             seat and the back in a single sheet. Plates 1 and 3.
//    'arm'    a folding quad chair (Coleman / REI Camp X). A scissor X-frame on
//             all four faces, tubular armrests with a moulded cup holder, a
//             mesh back panel in a fabric surround, a sagging seat with side
//             skirts. Plates 2 and 4.
//
//  Three things decide whether this ships, and they are all consequences of the
//  same observation — that a camp chair is a *tensile* structure, not a solid:
//
//  1. THE SLING HANGS OFF FOUR POINTS, NOT OFF THE RAILS. Look at plate 3: the
//     black side rail runs from the front corner up to the top corner as a
//     straight line, and the fabric edge is 30–50 mm INSIDE it for the whole
//     middle of that run, because the sling is only sewn to the frame at the
//     four corner pockets. That inward-curving free hem is the single loudest
//     "this is cloth under tension" cue in the plate, and a sling modelled as
//     a quad stretched corner to corner throws it away. So the surface here is
//     authored as a parametric bucket: a centreline profile that drops far
//     below the pocket chord, a cross-section that is a U, and free edges that
//     are pulled in and let down from the rail on a sin(πv) profile so they
//     still meet the pockets exactly.
//
//  2. THE FRAME MUST STAY THIN. 13.6 mm tube on the sling, 14.4 mm on the quad
//     chair. Under the shadow map a tube this thin aliases, and the reflex is
//     to fatten it until it stops. Do not: `tube()` is hexagonal for exactly
//     this reason (see the note in camp_materials.js) and six flat facets hold
//     a definite lit side and a definite dark side at 8 px where a cylinder
//     shimmers. Everything that would make the frame heavier — the hub blocks,
//     the pivot collars, the feet — is a *separate*, larger part, so the tube
//     itself never has to carry legibility on its own.
//
//  3. THE FEET SIT IN THE DIRT. Every leg ends in a moulded cap 23 mm across —
//     nearly twice the tube — with its tip 4 mm below y = 0. That contact is
//     what stops the chair floating; a prop whose legs simply stop at y = 0
//     reads as hovering no matter how good its shadow is.
//
//  Construction note on `fabricPanel`. Both chairs are built as *patchworks* of
//  a single parametric surface: the sling is split into a body, two side wings,
//  two mesh inserts and two binding tapes; the quad chair's back is split into a
//  mesh window and the fabric surround around it. Splitting rather than
//  overlaying is deliberate — coincident panels z-fight, and lifting one 2 mm
//  proud makes a sewn seam look like a sticker. The patches share one `surf`
//  function and their (u, v) boxes tile it exactly, so their edges are vertex-
//  for-vertex identical and the seams are invisible. That is also why the sag
//  term lives inside the surface functions rather than being passed to
//  `fabricPanel`: `fabricPanel` zeroes its sag on the panel's own border, so a
//  sub-patch handed the same sag value would pull itself flat along a seam that
//  is in the middle of the sheet. Written out once, in `bowl()`, it is the same
//  product-of-parabolas for every patch and the seams close.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, at, span, tube, rod, rbox, fabricPanel, sweptArc, dusted, tintOf, tintMul,
} from './camp_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * The colourways.
 *
 * These are saturated manufactured objects in a desaturated autumn valley and
 * that contrast is most of what makes them read as somebody's kit. The four
 * below are the four plates: REI teal, the Helinox colour-block, the green
 * quad chair, the red one.
 *
 * `blocked` only means anything to the sling — it turns on the rust side wings
 * and the dark mesh shoulder inserts of plate 3. A solid sling still gets
 * `side`, a couple of percent off `body`, because a real sling's side wings are
 * cut from the same roll but hang at a different angle and never quite match.
 */
export const CHAIR_COLORWAYS = [
  // 0 — plate 1: REI Flexlite, one flat teal, binding in the same cloth.
  { body: 0x35899b, side: 0x2d7688, insert: 0x2a6a7b, bind: 0x235a68, blocked: false },
  // 1 — plate 3: Helinox colour-block. Teal body, rust wings, grey mesh
  //     shoulders, and an olive binding tape round the top and the front lip.
  { body: 0x2a9cb2, side: 0xe8631f, insert: null,     bind: 0x8a8055, blocked: true },
  // 2 — plate 2: the green quad chair.
  { body: 0x4f8446, side: 0x44733d, insert: 0x355c31, bind: 0x2d4a26, blocked: false },
  // 3 — plate 4: the red one.
  { body: 0xd04c34, side: 0xb43a2b, insert: 0x8a2c1e, bind: 0x35211c, blocked: false },
];

/**
 * The two screen greys — and why they are NOT on the `mesh` material.
 *
 * `mesh` is authored at 0x14161a, which is right for an insect screen seen
 * against a lit tent wall, and the obvious move is `tintFrom(0x14161a, …)` to
 * lift it for a chair back, which is held up against the sky and reads as a mid
 * grey in all four plates. That does not work here. Three passes at it —
 * 0x5c5d54, 0x6a6b5f, 0x9a9b8e, the last a 30× multiplier — each moved the
 * rendered value by only a few percent and the panel stayed a black hole
 * punched in the chair. Whatever the stylised path does with a very dark base
 * colour, a vertex colour does not undo it.
 *
 * So the chair's screens are `fabricIn` — the same double-sided cloth material
 * as the rest of the chair, at a grey the tint reaches reliably. It is an
 * opaque screen either way; a real alpha panel this size is pure aliasing crawl
 * at 20 m. Nobody else's mesh moves, which is the point of not "fixing" the
 * shared material from this file.
 */
const MESH_BACK = tintOf(0x8d8f88);   // the quad chair's back panel
const MESH_WING = tintOf(0x6f7169);   // plate 3's shoulder inserts

/**
 * Piping.
 *
 * Every seam on both armchair plates is finished with near-black tape, and that
 * tape is doing more work than it looks: it draws the edge of every panel, so
 * the chair keeps its internal structure when the fabric itself falls to the
 * same value as the dirt it is standing on. A red chair on red-brown ground
 * with no piping loses its whole lower half the moment you squint, which is
 * exactly what happened to this one in round 4.
 */
const PIPE = tintOf(0x241f1c);

// ─────────────────────────────────────────────────────────────────────────────
//  Surface patchwork
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `fabricPanel`'s own sag term, written out so sub-patches can share it.
 *
 * Product of two parabolas: zero along every edge of the *whole sheet*, deepest
 * at its centre. `u`/`v` here are always global sheet coordinates, never the
 * patch's own, which is the entire point — a patch covering u ∈ [0.8, 1.0] must
 * get the sag the sheet has there, not a fresh parabola of its own.
 */
const bowl = (u, v) => 16 * u * (1 - u) * v * (1 - v);

/**
 * One rectangle of a parametric fabric surface.
 *
 * `surf(u, v, out)` writes the world position for global sheet coordinates.
 * `box` is the [u0, u1, v0, v1] window this patch covers; `dens` is grid lines
 * per unit of u and v across the *whole* sheet, so every patch comes out at the
 * same tessellation density however small it is and the seams stay watertight.
 *
 * `fabricPanel` is used as the grid host — its sag is passed as zero because
 * `surf` already carries it — and it still does the two jobs that matter here:
 * it rebuilds the vertex normals from the warped positions, and it runs
 * `sanitizeNormals` on the result. A thin binding tape 15 mm wide is exactly
 * the sort of patch that produces a degenerate triangle at a corner.
 */
function patch(P, surf, box, dens, key, tint) {
  const [u0, u1, v0, v1] = box;
  const gu = (t) => u0 + (u1 - u0) * t;
  const gv = (t) => v0 + (v1 - v0) * t;
  const nu = Math.max(2, Math.round((u1 - u0) * dens[0]));
  const nv = Math.max(2, Math.round((v1 - v0) * dens[1]));
  const corners = [
    surf(gu(0), gv(0), V(0, 0, 0)), surf(gu(1), gv(0), V(0, 0, 0)),
    surf(gu(1), gv(1), V(0, 0, 0)), surf(gu(0), gv(1), V(0, 0, 0)),
  ];
  const g = fabricPanel(corners, nu, nv, 0, (u, v, p) => surf(gu(u), gv(v), p));
  P.add(g, key, null, tint);
  return g;
}

/**
 * Bake a soft occlusion gradient into a tint.
 *
 * The bottom of a chair sling sees a slot of sky about 40° wide and the top of
 * the back sees half the hemisphere, so the bucket is genuinely darker than the
 * shoulders — by rather more than a shadow map at this scale will ever tell
 * you. Baking it into the vertex colour is free, and it is most of what stops a
 * one-colour fabric sheet reading as a flat cut-out under the stylised lighting.
 */
const shade = (base, y0, y1, k) => (x, y) => {
  const s = 1 - k * (1 - clamp01(smoothstep(y0, y1, y)));
  return [base[0] * s, base[1] * s, base[2] * s];
};

/**
 * Occlusion by depth into the pouch, for the sling.
 *
 * A height gradient is the wrong axis here: the inside and the outside of the
 * bowl are at the same height, so `shade()` gives them the same value and the
 * interior comes out LIGHTER than the exterior, because it faces the sky. A
 * bowl's inside is the darkest part of the object. This measures how far a
 * point hangs below the pocket-to-pocket chord — which is exactly how deep in
 * the pouch it is, and therefore how little sky it can see.
 */
const pouchAO = (base, k, front, top) => (x, y, z) => {
  const t = clamp01((front.z - z) / (front.z - top.z));
  const d = clamp01((lerp(front.y, top.y, t) - y) / 0.21);
  const f = 1 - k * d * d;
  return [base[0] * f, base[1] * f, base[2] * f];
};

/** Fade a colourway toward the sun-bleached grey a season outdoors gives it. */
function weathered(hex, wear) {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  const k = 0.16 * wear;
  return [
    c.r * (1 - k) + (l * 0.55 + 0.30) * k,
    c.g * (1 - k) + (l * 0.55 + 0.30) * k,
    c.b * (1 - k) + (l * 0.55 + 0.30) * k,
  ];
}

/** A CatmullRom through control points, as an fn(t) `sweptArc` can sample. */
function pathOf(pts, tension = 0.5) {
  const c = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', tension);
  // `sweptArc` collects the samples into an array, so the one-argument call has
  // to hand back a fresh vector; the two-argument form is for the per-vertex
  // path, where allocating 2000 vectors to build one chair is silly.
  return (t, out) => c.getPoint(t, out);
}

/**
 * A leg: a moulded foot cap sunk into the dirt, and the tube above it.
 *
 * The cap is built first and the tube starts *inside* it, so the tube's flat
 * hexagonal end cap is never visible — an open tube end at ground level is a
 * small thing that reads as unfinished from exactly the low angle the fireside
 * framing uses.
 */
function legWithFoot(P, foot, top, tint, r, capR = 0.0142, capL = 0.056) {
  const dir = new THREE.Vector3().subVectors(top, foot).normalize();
  const capTop = foot.clone().addScaledVector(dir, capL);
  // The cap is lifted about 40% off the `rubber` base. At the material's own
  // 0x1b1b1e it sits within a couple of percent of the `tube` black beside it,
  // so a foot that is geometrically there reads as the tube simply stopping —
  // which is what "the legs have no feet" means in a critique. A moulded rubber
  // foot is matte and scuffed pale; giving it its own value is what makes the
  // contact visible at 15 m.
  P.add(rod(capR, capL), 'rubber', span(foot, capTop), tintMul(tint, [1.45, 1.42, 1.36]));
  const start = foot.clone().addScaledVector(dir, capL * 0.55);
  P.add(tube(r, start.distanceTo(top)), 'tube', span(start, top), tint);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The packable butterfly sling — plates 1 and 3
// ─────────────────────────────────────────────────────────────────────────────

// Metres. Seat height is measured at the deepest point of the bucket, which is
// where a sitter's weight actually lands and about 65 mm below the front lip —
// the lip being *above* the pan is what makes a butterfly chair a bucket rather
// than a hammock, and it is clearly visible in the plate-1 side profile.
const S = {
  footX: 0.276, footZf: 0.250, footZb: -0.258,   // 0.55 × 0.51 m of splayed feet
  hubX: 0.098, hubY: 0.238,                      // the two moulded hubs
  // The back was 0.84 in round 2 and the pan only 150 mm deep, which put 470 mm
  // of back above a trough you could not see into: from above, the chair was a
  // flat sail with a dark slot at the bottom. A real butterfly sling is a 250 mm
  // pan with 350 mm of back over it, so the pockets moved — front lip forward
  // and down, top pocket down and back — and the profile below spends four of
  // its six control points on the pan.
  frontX: 0.256, frontY: 0.440, frontZ: 0.268,   // front corner pockets
  topX: 0.294, topY: 0.792, topZ: -0.176,        // top corner pockets
  railR: 0.0072,                                  // 14.4 mm — the upper frame
  legR: 0.0068,                                   // 13.6 mm — the legs
  sag: 0.046,                                     // the free 8%-of-span bow
  // How much of the pouch the free side hem takes. Round 1 had this at 0.16 and
  // the chair was flat from the side and from above: the hem sat almost exactly
  // on the rail, so the near edge occluded the whole bucket and the sling read
  // as a kite. In the plates the hem hangs a good 80 mm below the rail at
  // mid-height, and the gap of daylight between hem and tube is what tells you
  // there is a pouch behind it at all.
  edgeShare: 0.42,
};

/**
 * The sling's centreline, in the chair's YZ plane, from the front pocket to the
 * top pocket. This is the shape the cloth takes with nobody in it.
 *
 * The straight chord between those two pockets — which is where the frame rail
 * runs — passes about 200 mm ABOVE the seat. That is not sag in the
 * `fabricPanel` sense and no plausible sag value produces it; it is the cut of
 * the panel. A butterfly sling is a deep pouch sewn to be that deep, and the
 * bow of the unloaded cloth rides on top of it.
 *
 * The control points land on v = 0, 0.2, … 1.0 because `CatmullRomCurve3`
 * spreads its points evenly over t; reading them as a table of "the section at
 * this height" is only correct because of that.
 *
 *   v = 0.0  front lip, at the pockets — 40 mm above the pan
 *   v = 0.2–0.6  the pan: 250 mm of nearly level seat, which is the part a
 *                round-2 profile with its lowest point at a single v did not
 *                have and the reason that chair had no seat to look into
 *   v = 0.8  the lumbar break, where the pouch turns up and pushes back
 *   v = 1.0  top pocket
 */
const SLING_PROFILE = pathOf([
  V(0, 0.440, 0.268), V(0, 0.406, 0.206), V(0, 0.400, 0.088),
  V(0, 0.438, -0.046), V(0, 0.570, -0.150), V(0, 0.792, -0.176),
], 0.5);

/**
 * The sling surface. `u` runs left to right, `v` from the front lip up to the
 * top edge; both are global to the whole sheet.
 */
function slingSurface(ph, wrinkle, j) {
  // The panel normal of the pocket-to-pocket chord plane: up and forward.
  const n = V(0, S.topZ - S.frontZ, -(S.topY - S.frontY)).normalize().multiplyScalar(-1);
  const pr = V(0, 0, 0);
  // Corners of each of the four puckers. Cloth gathered into a pocket throws
  // creases back into the sheet; without them the corners are the one place the
  // surface looks stamped rather than sewn.
  const PUCK = [[0, 0], [1, 0], [1, 1], [0, 1]];

  return (u, v, out) => {
    const s = u - 0.5;
    const t = Math.abs(s) * 2;              // 0 on the centreline, 1 at a free edge
    const sv = Math.sin(Math.PI * v);

    // 1 — the chord plane between the four pockets.
    const cx = lerp(-S.frontX, S.frontX, u) * (1 - v) + lerp(-S.topX, S.topX, u) * v;
    const cy = lerp(S.frontY, S.topY, v);
    const cz = lerp(S.frontZ, S.topZ, v);
    out.set(cx, cy, cz);

    // 2 — the free bow of unloaded cloth, ~8% of the span, along the chord
    //     normal. Zero on every edge of the sheet, so the pockets stay pinned.
    out.addScaledVector(n, -j.sag * bowl(u, v));

    // 3 — the pouch. The centreline takes the profile in full and the free
    //     edges take `edgeShare` of it, with a rounded falloff between, so the
    //     cross-section is a U: flattish under the sitter, steep up the sides.
    SLING_PROFILE(v, pr);
    const w = 1 - (1 - j.edge) * Math.pow(t, 1.55);
    out.y += (pr.y - cy) * w;
    out.z += (pr.z - cz) * w;

    // 4 — the waist. Plate 3 is visibly narrower at the lumbar break than at
    //     either the lip or the shoulders; the wings are cut on a curve. The
    //     pinch is a bump centred at v = 0.60 rather than a sin(πv), because a
    //     sin peaks at v = 0.5 and that is the middle of the seat — narrowing
    //     the pan is exactly the wrong place to take width out.
    out.x *= 1 - 0.080 * Math.exp(-Math.pow((v - 0.60) / 0.28, 2)) * Math.pow(sv, 0.35);

    // 5 — the free hem, pulled in off the rail. This is the tension read: the
    //     edge is a concave curve between two pockets, not a straight line
    //     following the tube. It has to vanish at v = 0 and v = 1 or the
    //     corners come off their pockets, hence the sin(πv).
    // The falloff is t^2.6 rather than a smoothstep. A smoothstep spread the
    // displacement over the outer third of the wing and tipped the whole panel,
    // which from three-quarter front turned each wing into a flat fin standing
    // out sideways like a manta. t^2.6 keeps almost all of it inside the last
    // 15% of the width, which is a rolled hem — the cloth turning over on
    // itself at the edge, which is what it actually does.
    const free = Math.pow(sv, 0.8) * Math.pow(t, 2.6);
    out.x -= Math.sign(s) * 0.040 * free;
    // The hem also DROPS, hard, just behind the front lip. Without this the
    // near hem rises monotonically from the lip to the top pocket and the side
    // silhouette is a symmetric canoe hull — you cannot tell which way the
    // chair is facing, which is a fatal thing for a prop the layout solver aims
    // at a fire. The notch is what says "seat here, back there" in one line.
    out.y -= j.dip * Math.pow(t, 2.2) * Math.exp(-Math.pow((v - 0.30) / 0.22, 2));
    // …and forward. This is the wrap: a butterfly sling's wings curl round the
    // sitter, so the hem stands ~50 mm in front of the rail at shoulder height.
    // It is what gives the chair depth from the side, where round 2 was a flat
    // leaning sail with no seat you could see into.
    out.z += 0.050 * free;

    // 6 — the scoop in the top edge: the middle of the head end is cut and
    //     hangs about 60 mm below the shoulders. Vanishes at the pockets.
    const sc = j.scoop * clamp01(smoothstep(0.52, 1.0, v)) * Math.cos(Math.PI * s);
    out.y -= sc;
    out.z -= sc * 0.28;

    // 7 — the fold down each side where the wing panel is sewn to the body and
    //     the cloth turns over the rail. A soft crease running the length of
    //     the sling; it is what breaks the wings into their own value from
    //     three-quarter front. Kept shallow — at 10 mm it read as a black gash
    //     across the pan rather than as a fold.
    const fold = 0.0055 * Math.exp(-Math.pow((t - 0.76) / 0.13, 2)) * Math.pow(sv, 0.6);
    out.addScaledVector(n, -fold);

    // 8 — creases. Two long low-frequency wrinkles across the sheet, plus a
    //     radial pucker at each pocket that grows from zero at the corner so
    //     the corner itself stays exactly where the tube end is.
    let cr = wrinkle * (
      0.0075 * Math.sin(u * 8.6 + v * 2.2 + ph) * sv +
      0.0052 * Math.sin(v * 11.0 - u * 3.1 + ph * 1.7) * Math.sin(Math.PI * u));
    for (const [pu, pv] of PUCK) {
      const du = u - pu, dv = (v - pv) * 0.8;
      const d = Math.hypot(du, dv);
      // Two harmonics per pocket, not one. Cloth pulled into a corner throws a
      // fan of creases of visibly different lengths; a single cosine gives an
      // even scallop that reads as a moulding seam. Amplitude is up from 9 mm
      // to 19 mm because at 9 mm the tension read did not survive being
      // squinted at, which is the only test that matters at 15 m.
      const a = Math.atan2(dv, du);
      cr += 0.30 * d * Math.exp(-d * 6.0) * Math.cos(a * 4.5 + ph + pu * 2.1 + pv * 3.7);
      cr += 0.13 * d * Math.exp(-d * 10.0) * Math.cos(a * 8.0 - ph * 1.3 + pv * 2.2);
    }
    out.addScaledVector(n, cr);

    // 9 — the rolled hems. Cloth does not stop at a knife edge: the front lip
    //     and the head end are both turned under and stitched round a cord, so
    //     each has a couple of millimetres of thickness and turns away from the
    //     camera before it ends. Without this the sling's outline is a razor
    //     cut with no material behind it, which is visible at 2 m and is the
    //     difference between cloth and a decal.
    const rollF = clamp01(smoothstep(0.062, 0.0, v));
    out.addScaledVector(n, -0.011 * rollF);
    out.y -= 0.013 * rollF;
    const rollT = clamp01(smoothstep(0.955, 1.0, v));
    out.addScaledVector(n, -0.008 * rollT);
    out.z -= 0.007 * rollT;

    // 10 — one shoulder a little lower than the other. Two chairs beside a fire
    //      built from the same numbers are two copies of a prop; the shock cord
    //      in a real one never seats evenly and one corner always sits proud.
    //      Antisymmetric in u, so it cannot be mistaken for a modelling error.
    out.y += j.twist * Math.sin(2 * Math.PI * u) * sv;
    return out;
  };
}

function buildSling(P, rnd, cw, wear, g) {
  const ph = rnd() * 6.283;
  // Per-instance cut and seat of the cloth. `Camp.js` puts two or three of
  // these in an arc facing one fire, and every term here is one the eye reads
  // as "somebody has been sitting in that one" rather than as a variant.
  const j = {
    sag: S.sag * (0.84 + rnd() * 0.34),
    edge: S.edgeShare + (rnd() - 0.5) * 0.10,
    scoop: 0.062 * (0.86 + rnd() * 0.30),
    dip: 0.050 * (0.82 + rnd() * 0.38),
    twist: (rnd() - 0.5) * 0.020,
  };
  const surf = slingSurface(ph, 0.8 + wear * 0.9, j);
  const dust = dusted([1, 1, 1], { top: 0.14, amount: 0.18 + 0.30 * wear });

  // ── upper frame ───────────────────────────────────────────────────────────
  // One shock-corded pole per side, running from the front pocket back and up
  // to the top pocket with a slight outward bow. It is straight in the plate to
  // within a few millimetres, but a truly straight tube alongside a curved sheet
  // of cloth looks like a mistake, and the 18 mm of bow costs nothing.
  const railAt = (sx, t) => {
    const b = Math.sin(Math.PI * t);
    return V(sx * (lerp(S.frontX, S.topX, t) + 0.018 * b),
             lerp(S.frontY, S.topY, t),
             lerp(S.frontZ, S.topZ, t) + 0.012 * b);
  };
  for (const sx of [-1, 1]) {
    P.add(sweptArc((t) => railAt(sx, t), 20, S.railR, 6), 'tube', null, dust);
    // The tube end poking out of the top pocket. Small, but it is the detail
    // that says the cloth is *hung on* the frame rather than moulded to it, and
    // it is clearly visible in both sling plates.
    const a = railAt(sx, 1.0), b0 = railAt(sx, 0.94);
    // Kept very short: at 30 mm, and even at 20, these read as antennae with
    // ball finials in the side and back framings. The plate's nub is a few
    // millimetres of pole end showing out of the corner pocket, no more.
    const tip = a.clone().addScaledVector(a.clone().sub(b0).normalize(), 0.011);
    P.add(rod(0.0086, 0.013), 'plastic', span(a, tip), dust);
  }

  // Front cross rail, bowed down a little under the lip of the sling.
  const fl = railAt(-1, 0), fr = railAt(1, 0);
  P.add(sweptArc((t) => V(lerp(fl.x, fr.x, t), fl.y - 0.013 * Math.sin(Math.PI * t),
                          lerp(fl.z, fr.z, t) - 0.004 * Math.sin(Math.PI * t)),
                 12, 0.0065, 6), 'tube', null, dust);

  // ── hubs, legs, feet ──────────────────────────────────────────────────────
  // Two moulded hubs on a short cross tube, four legs splaying out of them. The
  // hub block is 46 mm across — three and a half times the tube — which is what
  // gives the leg cluster a readable knuckle at distance instead of a scribble.
  const hubL = V(-S.hubX, S.hubY, 0), hubR = V(S.hubX, S.hubY, 0);
  P.add(tube(0.0062, hubR.x - hubL.x), 'tube', span(hubL, hubR), dust);
  for (const sx of [-1, 1]) {
    const hub = V(sx * S.hubX, S.hubY, 0);
    // 40 mm and squared off, not 46 and round. At the larger size with a 13 mm
    // radius the pair read as two spheres on a bar — a dumbbell slung under the
    // seat — instead of as two moulded knuckles the legs plug into.
    P.add(rbox(0.040, 0.033, 0.056, 0.008), 'plastic',
          at(hub.x, hub.y, hub.z, 0, 0, sx * 0.10), dust);
    legWithFoot(P, V(sx * S.footX, -0.004, S.footZf), hub, dust, S.legR);
    legWithFoot(P, V(sx * S.footX * 0.94, -0.004, S.footZb), hub, dust, S.legR);
    // Two stays up to the side rail: one to the front pocket junction, one
    // catching the rail at the lumbar break so the back is not a cantilever.
    const j0 = railAt(sx, 0.07), j1 = railAt(sx, 0.44);
    P.add(tube(0.0062, hub.distanceTo(j0)), 'tube', span(hub, j0), dust);
    P.add(tube(0.0056, hub.distanceTo(j1)), 'tube', span(hub, j1), dust);
    P.add(rbox(0.030, 0.026, 0.030, 0.010), 'plastic',
          at(j0.x, j0.y, j0.z, 0, 0, 0), dust);
  }

  // ── the sling ─────────────────────────────────────────────────────────────
  // Nine patches tiling one sheet. `dens` is deliberately higher across v than
  // across u: the profile is where all the curvature is, and a coarse v grid
  // faceted the lumbar break into a visible crease at 3 m.
  const DENS = [36, 52];
  // Occlusion by depth into the pouch rather than by height — see `pouchAO`.
  // A height gradient made the inside of the bowl lighter than the outside,
  // which is backwards and which a critic caught before this author did.
  const F = V(0, S.frontY, S.frontZ), T = V(0, S.topY, S.topZ);
  const body = pouchAO(weathered(cw.body, wear), 0.30, F, T);
  const side = pouchAO(weathered(cw.side, wear), 0.30, F, T);
  const bind = pouchAO(weathered(cw.bind, wear), 0.24, F, T);

  const V0 = 0.040;          // the front lip binding, ~17 mm of tape
  const V1 = 0.962;          // the top binding
  // 125, not 150: the rust wings sit within about 15° of the sunlit dirt in
  // hue, so the wider they are the more of the chair disappears into the ground
  // when you squint. The cool panel has to be the dominant one and the warm one
  // the accent — which is also how plate 3 is cut.
  const WING = 0.125;        // width of a side wing in u
  const INSV = 0.500;        // the shoulder gore starts at the lumbar break

  // The shoulder gore is a WEDGE, not a stripe. Round 3 cut it as a fixed
  // column of u and it came out as two hard vertical bars flanking the centre
  // panel — a flag, not a garment. In plate 3 the mesh is a triangular gore
  // sewn between the body and the wing: zero width where the wing meets the
  // seat and 110 mm across at the shoulder. Everything below is expressed as a
  // remap of u so the gore, the wing and the body all tile the same sheet
  // exactly however wide the gore happens to be at a given height.
  const gore = (v) => 0.108 * clamp01(smoothstep(INSV, 0.90, v));
  const rm = (f) => (u, v, out) => surf(f(u, v), v, out);
  const G = [26, 52], GW = [7, 52];

  patch(P, surf, [0, 1, 0, V0], DENS, 'fabricIn', bind);
  patch(P, surf, [0, 1, V1, 1], DENS, 'fabricIn', bind);
  patch(P, surf, [0, WING, V0, V1], DENS, 'fabricIn', side);
  patch(P, surf, [1 - WING, 1, V0, V1], DENS, 'fabricIn', side);
  // Below the gore the body simply runs wing to wing.
  patch(P, rm((u) => WING + u * (1 - 2 * WING)), [0, 1, V0, INSV], G, 'fabricIn', body);
  // Above it, the body is squeezed by the gore on both sides.
  patch(P, rm((u, v) => {
    const w = WING + gore(v);
    return w + u * (1 - 2 * w);
  }), [0, 1, INSV, V1], G, 'fabricIn', body);
  const goreKey = 'fabricIn';
  const goreTint = cw.blocked ? MESH_WING
    : pouchAO(weathered(cw.insert ?? cw.side, wear), 0.30, F, T);
  patch(P, rm((u, v) => WING + u * gore(v)), [0, 1, INSV, V1], GW, goreKey, goreTint);
  patch(P, rm((u, v) => 1 - WING - (1 - u) * gore(v)), [0, 1, INSV, V1], GW, goreKey, goreTint);
  g.userData.seatHeight = 0.37;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The folding mesh armchair — plates 2 and 4
// ─────────────────────────────────────────────────────────────────────────────

const A = {
  // Wider than round 1 by 60 mm across the feet. A quad chair is a squat, wide
  // object — the plates are broader than they are tall once the arms are
  // counted — and at 0.55 m across a 0.87 m back it read as a dining chair.
  footX: 0.305, footZ: 0.285,
  seatX: 0.268, seatZf: 0.238, seatZb: -0.212,
  seatY: 0.452,       // the seat RAIL; the cloth pools 90 mm below it
  backTop: 0.848,
  armY: 0.660, armZf: 0.196, armZb: -0.186,
  // Two gauges, and further apart than round 4's 14.4/12.4 — at that spread
  // the rail, the legs, both X-braces and the arm posts were all one stroke
  // width, and from the side the chair was a scribble of a dozen identical
  // black lines. The plates use a visibly heavier main tube and let the light
  // braces sit behind it.
  tubeR: 0.0080,      // 16.0 mm — rail, legs, seat frame
  braceR: 0.0058,     // 11.6 mm — the scissor diagonals read as lighter
};

/**
 * The back panel.
 *
 * Bounded by the frame, not by a rectangle inside it. Round 4 authored this as
 * a flat card between four fixed corners and it left daylight in two places a
 * real chair has none: a wedge of grass between the top rail and the top of the
 * cloth, and a slot between the bottom of the cloth and the back of the seat.
 * Both were legible at 3 m and both said "this is a card in a wire hoop".
 *
 * So the outline is now the bent tube itself — `bx/by/bz` trace the same path
 * the frame sweptArc traces, so the cloth reaches the tube's centreline and
 * wraps it — and the bottom edge is pinned to `seatSurface`'s own back hem,
 * dip and all, so the two pieces of cloth meet along a seam instead of leaving
 * a gap that the ground shows through.
 */
function backSurface(ph) {
  const bx = (v) => (0.268 + 0.010 * Math.sin(Math.PI * v * 0.8)) *
                    (1 - 0.35 * Math.pow(clamp01(smoothstep(0.80, 1.0, v)), 2));
  const by = (v) => 0.466 + 0.382 * v - 0.010 * Math.sin(Math.PI * v);
  const bz = (v) => -0.212 - 0.090 * Math.pow(v, 0.75);
  return (u, v, out) => {
    out.set((u * 2 - 1) * bx(v), by(v), bz(v));
    // Meet the seat's back hem exactly, including its 26 mm dip.
    out.y -= 0.026 * Math.sin(Math.PI * u) * Math.pow(1 - v, 2);
    // 55 mm of hollow. Cloth slung between two uprights is not a plane; from
    // the side this is what separates the back panel from the frame holding it.
    out.z -= 0.055 * bowl(u, v);
    // Vertical drape: mesh hung between two uprights falls in shallow flutes.
    out.z -= 0.006 * Math.sin(u * 11.0 + ph) * Math.sin(Math.PI * v) *
             Math.sin(Math.PI * u);
    // The top edge is not a taut line either — it hangs a little between the
    // two shoulders, which softens the one hard horizontal in the silhouette.
    out.y -= 0.016 * Math.sin(Math.PI * u) * Math.pow(v, 2.5);
    return out;
  };
}

/**
 * The seat.
 *
 * Pinned at the four corner posts and nowhere else. Round 1 pinned the whole
 * perimeter to the rails and the seat came out a flat board with a ruled front
 * edge — the single worst thing in that pass. A quad chair's seat is a loose
 * rectangle stitched round four tubes: the FRONT edge dips ~26 mm between the
 * posts, the SIDE edges dip ~22 mm, and the middle pools 90 mm. Every one of
 * those numbers is visible in the plates as a curve where a beginner draws a
 * straight line.
 */
function seatSurface(ph) {
  const FL = V(-A.seatX, A.seatY, A.seatZf), FR = V(A.seatX, A.seatY, A.seatZf);
  const BL = V(-A.seatX, A.seatY + 0.014, A.seatZb), BR = V(A.seatX, A.seatY + 0.014, A.seatZb);
  return (u, v, out) => {
    const fx = lerp(FL.x, FR.x, u), bx = lerp(BL.x, BR.x, u);
    out.set(lerp(fx, bx, v), lerp(FL.y, BL.y, v), lerp(FL.z, BL.z, v));
    const eu = Math.sin(Math.PI * u), ev = Math.sin(Math.PI * v);
    out.y -= 0.026 * eu + 0.022 * ev + 0.042 * eu * ev;
    // The pool drags the cloth inboard off the side rails as well as down.
    out.x *= 1 - 0.035 * ev;
    // Diagonal draw-creases from the corners, where the cloth is stitched round
    // the rails and cannot follow the sag.
    out.y -= 0.010 * eu * ev * Math.sin(u * 5.5 - v * 4.5 + ph);
    return out;
  };
}

/** A skirt hanging off a rail: `edge(u)` is the rail, `drop(u)` how far it falls. */
function skirtSurface(edge, drop, ph, flare = 0.010) {
  return (u, v, out) => {
    edge(u, out);
    out.y -= drop(u) * v;
    // A hanging hem swings out a little and ripples; a skirt that drops as a
    // flat plane is the same programmer-art tell as flat fabric anywhere else.
    const k = Math.sin(Math.PI * u);
    out.z += flare * v * v * (0.5 + 0.5 * Math.sin(u * 7.0 + ph));
    out.x *= 1 + 0.03 * v * v;
    out.y -= 0.008 * v * k * Math.sin(u * 9.0 + ph * 1.3);
    return out;
  };
}

function buildArm(P, rnd, cw, wear, g) {
  const ph = rnd() * 6.283;
  const dust = dusted([1, 1, 1], { top: 0.15, amount: 0.18 + 0.30 * wear });
  const DENS = [30, 30];
  const body = shade(weathered(cw.body, wear), 0.30, 0.70, 0.13);

  const footF = (sx) => V(sx * A.footX, -0.004, A.footZ);
  const footB = (sx) => V(sx * A.footX, -0.004, -A.footZ);
  const seatF = (sx) => V(sx * A.seatX, A.seatY, A.seatZf);
  const seatB = (sx) => V(sx * A.seatX, A.seatY, A.seatZb);

  // ── the back frame ────────────────────────────────────────────────────────
  // One continuous pole: up from the rear-left seat corner, round the top, down
  // to the rear-right. The corners are radiused rather than mitred because a
  // folding chair's back is a single bent tube, and because a hard 90° corner
  // at this scale is four pixels of aliasing.
  P.add(sweptArc(pathOf([
    seatB(-1), V(-0.272, 0.630, -0.262), V(-0.258, 0.770, -0.298),
    V(-0.200, 0.838, -0.302), V(0, A.backTop, -0.292),
    V(0.200, 0.838, -0.302), V(0.258, 0.770, -0.298),
    V(0.272, 0.630, -0.262), seatB(1),
  ], 0.5), 46, A.tubeR, 6), 'tube', null, dust);

  // ── posts, braces, feet ───────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    legWithFoot(P, footF(sx), seatF(sx), dust, A.tubeR, 0.0112, 0.046);
    legWithFoot(P, footB(sx), seatB(sx), dust, A.tubeR, 0.0112, 0.046);
    // Seat side rail: this is also what the arm's rear leg lands on.
    P.add(tube(0.0072, seatF(sx).distanceTo(seatB(sx))), 'tube',
          span(seatF(sx), seatB(sx)), dust);
  }
  P.add(tube(0.0072, 2 * A.seatX), 'tube', span(seatF(-1), seatF(1)), dust);

  // The scissor X on all four faces. This is the whole reason a quad chair
  // folds, and the crossed diagonals under the seat are a big part of what the
  // silhouette reads as at 15 m — without them the chair is four sticks.
  const braces = [
    [footF(-1), seatB(-1)], [footB(-1), seatF(-1)],
    [footF(1), seatB(1)], [footB(1), seatF(1)],
    [footF(-1), seatF(1)], [footF(1), seatF(-1)],
    [footB(-1), seatB(1)], [footB(1), seatB(-1)],
  ];
  for (const [a, b] of braces) {
    const lo = a.clone().lerp(b, 0.06), hi = a.clone().lerp(b, 0.99);
    P.add(tube(A.braceR, lo.distanceTo(hi)), 'tube', span(lo, hi), dust);
  }
  // Pivot collars at the four crossings — moulded plastic, 30 mm, and the only
  // thing that stops eight tubes meeting in mid-air looking like an accident.
  for (const [a, b] of [[footF(-1), seatB(-1)], [footF(1), seatB(1)],
                        [footF(-1), seatF(1)], [footB(-1), seatB(1)]]) {
    const m = a.clone().lerp(b, 0.5);
    P.add(rbox(0.030, 0.026, 0.030, 0.010), 'plastic', at(m.x, m.y, m.z), dust);
  }

  // ── armrests ──────────────────────────────────────────────────────────────
  // The pad is a solid, not a sheet. Round 1 built it as a fabric panel and it
  // read as a knife blade from every angle above the horizon, because a plane
  // seen edge-on has no thickness to catch light on. A quad chair's arm is a
  // 40 mm padded sleeve with a stiffener up the middle, so a rounded box with a
  // generous radius is both truer and vastly more legible: it holds a lit top
  // face, a shaded outer face and a dark underside, which is three values where
  // the plane had one.
  const cupSide = rnd() < 0.5 ? -1 : 1;
  for (const sx of [-1, 1]) {
    // Front stanchion up off the front post, then back to the back frame. Swept
    // as one path so both bends are radiused.
    P.add(sweptArc(pathOf([
      seatF(sx).clone().add(V(0, -0.006, 0)),
      V(sx * 0.286, 0.566, 0.226), V(sx * 0.300, A.armY - 0.016, A.armZf),
      V(sx * 0.292, A.armY + 0.004, -0.040),
      V(sx * 0.276, A.armY + 0.012, A.armZb), V(sx * 0.272, 0.706, -0.266),
    ], 0.5), 34, 0.0062, 6), 'tube', null, dust);

    // 124 × 32 × 470 mm, tipped so the front end drops and the outer edge sits
    // a little lower than the inner — both true of a real arm and both worth
    // the two lines because they keep the top face off the horizontal, which is
    // where it caught the sun and blew out to near-white in round 1. Wide and
    // shallow, not deep: at 42 mm thick it read as a bolster rather than as a
    // padded sleeve over a tube.
    //
    // Long enough to REACH THE BACK FRAME. At 404 mm it stopped 90 mm short and
    // the arm read as a plank cantilevered off the front post with its rear end
    // floating — a real quad chair's arm is carried at both ends. The separate
    // cloth flap that used to hang under the outer edge is gone with it: beside
    // a pad that now has genuine thickness it read as a second, thinner plank.
    P.add(rbox(0.124, 0.032, 0.470, 0.013, 2), 'fabric',
          at(sx * 0.278, A.armY + 0.006, -0.028, 0.052, 0, -sx * 0.075),
          shade(weathered(cw.body, wear), A.armY - 0.014, A.armY + 0.024, 0.34));

    // ── cup holder ──────────────────────────────────────────────────────────
    // Moulded rim plus a mesh pouch, on one arm only, exactly as the plates
    // show. A rim and not a disc: the hole is the whole point of a cup holder.
    if (sx === cupSide) {
      const cx = sx * 0.318, cy = A.armY - 0.030, cz = A.armZf - 0.026;
      P.add(new THREE.TorusGeometry(0.0450, 0.0062, 5, 12), 'plastic',
            at(cx, cy, cz, -Math.PI / 2, 0, 0), tintMul(dust, [1.7, 1.66, 1.6]));
      // Dark, not screen-grey: this is a recess and it has to read as a hole.
      // At the back panel's grey it came out as a bright square floating in
      // front of the chair from three-quarter front.
      P.add(new THREE.CylinderGeometry(0.0435, 0.034, 0.062, 10, 1, true), 'fabricIn',
            at(cx, cy - 0.031, cz), tintOf(0x2e2f2b));
      P.add(new THREE.CylinderGeometry(0.034, 0.030, 0.008, 10, 1, false), 'plastic',
            at(cx, cy - 0.066, cz), dust);
    }
  }

  // ── back panel: a mesh window in a fabric surround ────────────────────────
  // The surround's width in u grows at the waist, which is how the hourglass in
  // plate 4 is made. Both the window and the surround are driven off the same
  // `wu(v)` so their seams are the same vertices.
  const back = backSurface(ph);
  const wu = (v) => 0.150 + 0.085 * Math.pow(Math.sin(Math.PI * v), 1.2);
  const remap = (f) => (u, v, out) => back(f(u, v), v, out);
  // Each side border is three strips: piping, cloth, piping. The tape is 16% of
  // the border's width, which at the waist is about 8 mm — the same as the
  // plates — and it is what keeps the panel's edges drawn when the red falls to
  // ground value.
  const piped = (map) => {
    const w = 0.16;
    patch(P, remap((u, v) => map(u * w, v)), [0, 1, 0, 1], [3, 34], 'fabricIn', PIPE);
    patch(P, remap((u, v) => map(w + u * (1 - 2 * w), v)), [0, 1, 0, 1], [8, 34], 'fabricIn', body);
    patch(P, remap((u, v) => map(1 - w + u * w, v)), [0, 1, 0, 1], [3, 34], 'fabricIn', PIPE);
  };
  piped((a, v) => a * wu(v));
  piped((a, v) => 1 - wu(v) * (1 - a));
  const mid = (u, v) => wu(v) + u * (1 - 2 * wu(v));
  patch(P, remap(mid), [0, 1, 0, 0.098], [24, 5], 'fabricIn', body);
  patch(P, remap(mid), [0, 1, 0.098, 0.115], [24, 2], 'fabricIn', PIPE);
  patch(P, remap(mid), [0, 1, 0.115, 0.885], [24, 28], 'fabricIn', MESH_BACK);
  patch(P, remap(mid), [0, 1, 0.885, 0.902], [24, 2], 'fabricIn', PIPE);
  patch(P, remap(mid), [0, 1, 0.902, 1], [24, 5], 'fabricIn', body);

  // ── seat and skirts ───────────────────────────────────────────────────────
  // Every skirt is cloth down to v = 0.86 and tape below it. A camp chair's
  // hems are all taped, and a taped hem is also the cheapest way to give a
  // hanging edge a definite terminus instead of a fading gradient.
  const seat = seatSurface(ph);
  const hemmed = (surf, dens) => {
    patch(P, surf, [0, 1, 0, 0.86], dens, 'fabricIn', body);
    patch(P, surf, [0, 1, 0.86, 1], [dens[0], 3], 'fabricIn', PIPE);
  };
  patch(P, seat, [0, 1, 0, 1], DENS, 'fabricIn', body);
  // Front skirt. Its hem is a deep concave curve — 105 mm at the middle against
  // 55 at the corners, hanging off an edge that has already dipped 26 — and
  // that curve is the strongest single line in the quad chair's silhouette from
  // the front, so it is worth getting exactly right.
  hemmed(skirtSurface((t, out) => seat(t, 0, out),
                      (t) => 0.055 + 0.050 * Math.cos(Math.PI * (t - 0.5)), ph, 0.018), [30, 9]);
  for (const sx of [-1, 1]) {
    hemmed(skirtSurface((t, out) => seat(sx < 0 ? 0 : 1, t, out),
                        (t) => 0.046 + 0.034 * Math.sin(Math.PI * t), ph + sx, 0.006), [24, 7]);
  }
  // Back skirt, so the seat is not open when the chair is seen from behind —
  // the turntable's `back` frame is where a hollow prop gets caught.
  hemmed(skirtSurface((t, out) => seat(1 - t, 1, out),
                      () => 0.040, ph + 2.0, -0.008), [24, 7]);

  g.userData.seatHeight = 0.365;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {()=>number} rnd  seeded RNG — every random choice comes from here
 * @param {object} opts     { style: 'sling'|'arm', colorway: 0..3, wear: 0..1 }
 * @returns {THREE.Group}   origin at ground centre, +Z is the seat front
 */
export function buildChair(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_chair';
  const style = opts.style === 'arm' || opts.style === 'sling'
    ? opts.style : (rnd() < 0.5 ? 'sling' : 'arm');
  const cw = CHAIR_COLORWAYS[(opts.colorway ?? 0) % CHAIR_COLORWAYS.length];
  const wear = clamp01(opts.wear ?? 0.4);
  const P = new Parts(`chair_${style}`);

  if (style === 'arm') buildArm(P, rnd, cw, wear, g);
  else buildSling(P, rnd, cw, wear, g);

  // Nobody sets a chair down square to anything, and a degree or two of lean is
  // the difference between two chairs and two placed props. It goes on an inner
  // group because `Camp.js` writes the outer group's quaternion outright to
  // stand the prop on the terrain normal, which would discard a rotation set
  // here. The lean is small enough that the feet stay within a millimetre of
  // the ground over a 0.55 m footprint.
  const lean = new THREE.Group();
  lean.name = 'chair_lean';
  lean.rotation.set((rnd() - 0.5) * 0.024, 0, (rnd() - 0.5) * 0.030);
  P.flush(lean);
  g.add(lean);
  g.userData.footprint = 0.42;
  g.userData.style = style;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Ground-cover forms — the procedural mesh library for the mid layer.
//
//  The mid layer's job is to break the meadow's uniform gold with *value* and
//  *scale*: dark shrubs dotted through the open, bronze ferns under canopy,
//  litter drifts and deadfall on the forest floor. That means silhouette does
//  almost all the work — these things are 20-80 px tall on screen and their
//  shading is nearly flat, so if the outline is wrong nothing else can save it.
//
//  Two rules shape every builder here:
//
//   1. A BUSH IS NOT A SMALL TREE. Trees are a trunk carrying a crown. A shrub
//      is a *ground-hugging cluster of lobes* with no visible stem and a much
//      wider-than-tall proportion, and dry scrub is a fan of near-vertical
//      sprays with no mass at all. Getting those proportions right is what
//      stops the layer reading as saplings.
//
//   2. NORMALS ARE ART, NOT GEOMETRY. Foliage normals are pushed outward from
//      the lobe centre and lifted toward +Y, exactly as the tree author does
//      for conifer fans. A true sphere normal makes a lobe read as a ball; the
//      lifted normal makes it read as a lit mass with a soft under-shadow,
//      which is what the reference plates paint.
//
//  Every vertex carries `cInfo` (vec4):
//     x  colour channel   0 = instance colour A … 1 = instance colour B
//     y  ambient occlusion 0 = buried in the clump … 1 = open tip
//     z  wind sway weight  0 = rooted … 1 = whips
//     w  translucency      how much backlight passes through here
//  Passing -1 for ao or sway asks finish() to derive it from vertex height.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const TAU = Math.PI * 2;

// Strip normals are blended between the true face normal (which points
// outward from an upright spray) and straight up. Pure face normals split a
// tuft into a lit half and a near-black half and it reads as dead twigs; pure
// up loses the form entirely. Two thirds of the way to vertical keeps the tuft
// reading as one soft mass while still turning with the plant.
const FROND_OUT = 0.55, FROND_UP = 0.85;

// ── builder ──────────────────────────────────────────────────────────────────

class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.idx = []; }

  vert(px, py, pz, nx, ny, nz, chan, ao, sway, trans) {
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.c.push(chan, ao, sway, trans);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * Fill in any auto (-1) AO / sway from vertex height and hand back geometry.
   * Height-derived AO is a cheap stand-in for a real occlusion bake and it is
   * the single thing that stops a clump of lobes reading as a pile of balls:
   * the ground contact goes dark, the top stays open.
   */
  finish(height) {
    const h = Math.max(0.06, height);
    for (let k = 0, v = 0; k < this.c.length; k += 4, v += 3) {
      const y = this.p[v + 1];
      if (this.c[k + 1] < 0) this.c[k + 1] = 0.26 + 0.74 * smoothstep(0, h * 0.70, y);
      if (this.c[k + 2] < 0) this.c[k + 2] = Math.pow(clamp01(y / h), 1.35);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('cInfo', new THREE.Float32BufferAttribute(this.c, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.userData.tris = this.idx.length / 3;
    return g;
  }
}

// ── unit lobe topology (octahedron, optionally subdivided once) ──────────────

function octa() {
  const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const F = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
  return { V, F };
}

function subdivide({ V, F }) {
  const verts = V.map((v) => v.slice());
  const mid = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? a * 4096 + b : b * 4096 + a;
    let m = mid.get(key);
    if (m !== undefined) return m;
    const p = [verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]];
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    verts.push([p[0] / l, p[1] / l, p[2] / l]);
    m = verts.length - 1;
    mid.set(key, m);
    return m;
  };
  const faces = [];
  for (const [a, b, c] of F) {
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    faces.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  return { V: verts, F: faces };
}

const LOBE = [octa(), subdivide(octa())];   // 8 tris / 32 tris

/**
 * One foliage lobe: a radially-jittered ellipsoid with lifted normals.
 * `ragged` is the whole silhouette story — 0 gives a clean ball, 0.4 gives the
 * bitten-into outline the reference's bushes have.
 */
function lobe(b, cx, cy, cz, rx, ry, rz, detail, rng, o = {}) {
  const { V, F } = LOBE[detail];
  const ragged = o.ragged ?? 0.34;
  // Clamped, and this is a latent NaN guard rather than a style limit. `lift`
  // is added to the outward unit direction before normalising, so at exactly
  // 1.0 the bottom vertex — direction (0,-1,0) — sums to the zero vector, and
  // `Math.hypot(...) || 1` then quietly stores a zero-length normal rather than
  // failing. That is precisely the defect behind commit 3003973: the fragment
  // prelude normalises it to NaN, the NaN lands in the HDR buffer and bloom
  // spreads it into a black square. `moss` at 0.85 and `log`/`stump` at 0.90
  // were already inside a rounding error of it.
  const lift = Math.min(0.88, o.lift ?? 0.30);
  const chan = o.chan ?? 0;
  const trans = o.trans ?? 0.6;
  const base = b.p.length / 3;

  const P = [];
  for (let i = 0; i < V.length; i++) {
    const d = V[i];
    const r = 1 + (rng() - 0.5) * 2 * ragged;
    P.push([cx + d[0] * rx * r, cy + d[1] * ry * r, cz + d[2] * rz * r]);
  }

  // `facet` splits the vertices per face and writes the face's own normal, so
  // the lobe shades as hard flat plates instead of as a smooth ball.
  //
  // Foliage does not want this — a bush is a soft mass and the shared, lifted
  // vertex normal is what makes it read as one. Stone does. The brief is
  // explicit that faceting on rock "is fine and often desirable", and a smooth
  // eight-face octahedron at half a metre across came out of the meadow frame
  // reading as a *tarpaulin*: two broad gradients meeting on a soft crease,
  // with nothing anywhere that says the surface is hard. Same triangle count;
  // only the shared vertices go, and the geometry is instanced so the extra
  // vertices are paid once for the whole field.
  if (o.facet) {
    // Still lifted, but only a little: enough that a stone's top plate answers
    // the key light more strongly than its side, not so much that the plates
    // blend back into a gradient.
    const fl = o.facetLift ?? 0.18;
    for (const f of F) {
      const A = P[f[0]], B2 = P[f[1]], C = P[f[2]];
      const ux = B2[0] - A[0], uy = B2[1] - A[1], uz = B2[2] - A[2];
      const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const gl = Math.hypot(nx, ny, nz) || 1;
      nx /= gl; ny = ny / gl + fl; nz /= gl;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const ao = o.ao ?? -1, sway = o.sway ?? -1;
      const a0 = b.vert(A[0], A[1], A[2], nx, ny, nz, chan, ao, sway, trans);
      const a1 = b.vert(B2[0], B2[1], B2[2], nx, ny, nz, chan, ao, sway, trans);
      const a2 = b.vert(C[0], C[1], C[2], nx, ny, nz, chan, ao, sway, trans);
      b.tri(a0, a1, a2);
    }
    return;
  }

  // MASS NORMAL. `bias` blends every vertex normal of this lobe toward one
  // supplied direction — the direction from the *whole plant's* centre out
  // through this lobe — before the lobe's own radial term is applied.
  //
  // This is the fix for "scrub reads as black faceted blobs", and the mechanism
  // is worth stating because four previous rounds treated it as a facet-size
  // problem and it is not.
  //
  // A floret whose normals point radially out of its own 10 cm centre answers
  // the key light independently of the floret 10 cm away from it. Thirty-one of
  // them therefore paint thirty-one unrelated values inside one silhouette,
  // which is *noise*, not form — and averaged over a 60 px bush the noise
  // integrates to the middle of the response curve, i.e. to one flat dark
  // value. Worse at golden hour, which is the game's own light: the previous
  // fix biased every floret hard toward +Y to make it read as a soft mark, and
  // with the sun 20° above the horizon a sky-facing normal takes sin(20°) of
  // the key. The bush was authored to be dark and then lit as if it were flat
  // ground.
  //
  // Biasing toward the mass instead gives the whole sunward flank of the plant
  // one bright value, the top a middle one and the far flank a dark one — three
  // broad masses, which is exactly what the reference's bushes are painted as
  // (crop plate 1 at the birch bases, plate 2 at the river bank). The floret's
  // own radial component survives at `1 - bias` and is what keeps the surface
  // from reading as a single smooth dome.
  const bias = Math.min(0.85, o.bias ?? 0);
  const bx = o.bx ?? 0, by = o.by ?? 1, bz = o.bz ?? 0;

  for (let i = 0; i < V.length; i++) {
    const d = V[i];
    // Outward from the lobe centre, then bent toward the sky. A lobe lit this
    // way has one broad lit top and one broad shaded underside — two flat
    // masses — instead of a continuous sphere gradient.
    let nx = d[0], ny = d[1] + lift, nz = d[2];
    let l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (bias > 0) {
      nx = nx * (1 - bias) + bx * bias;
      ny = ny * (1 - bias) + by * bias;
      nz = nz * (1 - bias) + bz * bias;
      l = Math.hypot(nx, ny, nz);
      // A blend of two unit vectors can only reach zero length if they are
      // exactly opposed at bias 0.5, which `ragged` jitter makes unlikely and
      // not impossible. A zero normal is the black-square defect (3003973), so
      // it is caught here rather than trusted not to happen.
      if (l < 1e-4) { nx = 0; ny = 1; nz = 0; }
      else { nx /= l; ny /= l; nz /= l; }
    }
    b.vert(P[i][0], P[i][1], P[i][2], nx, ny, nz, chan, o.ao ?? -1, o.sway ?? -1, trans);
  }
  for (const f of F) b.tri(base + f[0], base + f[1], base + f[2]);
}

/**
 * Unit direction from a plant's own centre out through a point on it, for
 * `lobe`'s `bias`. `sx`/`sy` normalise the plant's proportions so a wide flat
 * shrub still produces a hemisphere of directions rather than a disc of them,
 * and the `Math.max` floor stops a floret low on the flank pointing downward —
 * a bush's underside is in shadow, but its skirt is not a ceiling.
 */
function massDir(px, py, pz, cy, sx, sy) {
  const dx = px / sx, dz = pz / sx;
  const dy = Math.max(-0.12, (py - cy) / sy);
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-4) return { bx: 0, by: 1, bz: 0 };
  return { bx: dx / l, by: dy / l, bz: dz / l };
}

/**
 * A tapered, arching strip — fern frond, scrub spray, flower stem, grass-like
 * seed stalk. The alternating side width is a cheap serration that reads as
 * pinnae at fern scale and as twigginess at scrub scale.
 */
function frond(b, o) {
  const segs = o.segs ?? 4;
  const dirx = Math.cos(o.yaw), dirz = Math.sin(o.yaw);
  let px = o.x ?? 0, py = o.y ?? 0, pz = o.z ?? 0;
  let ang = o.tilt ?? 0.4;                       // radians from vertical
  const step = o.len / segs;
  let pl = -1, pr = -1;
  // The tilt angle that carries the strip from the previous ring to this one.
  // The quad's *geometric* normal is fixed by that tangent; the stored normal
  // is not. See the winding note below.
  let segAng = ang;

  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const serr = (s & 1) ? 1.34 : 0.74;
    const w = o.w * (1 - t * (o.taper ?? 0.85)) * serr;
    const sx = -dirz * w, sz = dirx * w;
    const chan = lerp(o.chanA ?? 0, o.chanB ?? 0, t * t);
    const ao = lerp(o.aoA ?? 0.5, o.aoB ?? 1.0, t);
    const sway = lerp(o.swayA ?? 0.2, 1.0, t);
    // The strip's true normal: perpendicular to its tangent and its width axis.
    // Getting this wrong is expensive in a way that is easy to miss — a nearly
    // vertical blade whose normal points *up* is lit almost entirely by the cool
    // sky dome and barely at all by the low sun, and renders as a pale grey rag
    // no matter what colour you feed it. For an upright spray this comes out
    // horizontal, facing outward, exactly like a blade of grass.
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let nx = dirx * ca * FROND_OUT, ny = -sa * FROND_OUT + FROND_UP, nz = dirz * ca * FROND_OUT;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // MASS NORMAL, the same idea as `lobe`'s `bias` and for the same reason —
    // and this is the half of critic blocker 15 that the lobe fix missed.
    //
    // A shrub's visible surface is not its florets, it is the forty-odd blades
    // of `leafShell` sitting on top of them, and every one of those takes its
    // normal from its OWN yaw, which is random. So the lobes underneath now
    // resolve into three broad masses and the blades over them still paint
    // forty unrelated values inside one silhouette — which is what
    // shots/cover/close1/close-grass-2m.png shows: a pile of mid-green,
    // near-black and chalky pale plates with no light direction in it at all.
    //
    // Blending toward the direction from the plant's centre out through this
    // blade gives the sunward side of the canopy one value and the far side
    // another, while the blade keeps enough of its own facing to stay a blade.
    //
    // GUARDED, because `frond` is the one function in this file where the
    // stored normal and the triangle winding have to agree — see the long note
    // below, and commit 3003973. A blend that carried the normal past 90 deg
    // from the geometric one would reproduce the unlit-from-both-sides defect
    // exactly. So the blend is backed off until it keeps a solid positive dot
    // with the original, and `tools/winding.mjs` is the check that it worked.
    if (o.bias) {
      const bx = o.bx ?? 0, by = o.by ?? 1, bz = o.bz ?? 0;
      let k = Math.min(0.72, o.bias);
      const dot = nx * bx + ny * by + nz * bz;
      // At dot <= 0 the two vectors disagree by more than a right angle; the
      // largest blend that still keeps the result on the original's side is
      // then bounded by 1/(1-dot). Half of that is the safety margin.
      if (dot < 0.25) k = Math.min(k, 0.5 / (1 - dot));
      let mx2 = nx * (1 - k) + bx * k;
      let my2 = ny * (1 - k) + by * k;
      let mz2 = nz * (1 - k) + bz * k;
      const ml = Math.hypot(mx2, my2, mz2);
      if (ml > 1e-4 && (mx2 * nx + my2 * ny + mz2 * nz) / ml > 0.20) {
        nx = mx2 / ml; ny = my2 / ml; nz = mz2 / ml;
      }
    }
    const l = b.vert(px + sx, py, pz + sz, nx, ny, nz, chan, ao, sway, o.trans ?? 0.9);
    const r = b.vert(px - sx, py, pz - sz, nx, ny, nz, chan, ao, sway, o.trans ?? 0.9);
    // Wound to agree with the normals above, and this is the largest single
    // defect that was in this file.
    //
    // `quad(pl, l, r, pr)` produced a face normal of roughly −n. Strips render
    // on the *double-sided* material, and three flips the shading normal for
    // back faces (`normal *= gl_FrontFacing ? 1 : -1`) precisely so that a
    // double-sided surface faces the viewer from either side. That only works
    // when the winding agrees with the stored normal. When it disagrees the
    // logic runs backwards and the shading normal points *away from the camera
    // from both sides at once* — so the surface is unlit whichever way you look
    // at it, and no albedo, palette lift or ambient floor can recover it.
    //
    // Everything this library builds out of strips went through here: every
    // shrub's leaf canopy, the scrub sprays, the fern fronds, the flower stems
    // and the straw mats. It is why the scrub bush measured as "the darkest
    // object in every frame it appears in", and it is almost certainly why the
    // palette in cover_scatter had to be lifted 1.8x to be visible at all.
    //
    // SECOND CORRECTION, and this is the half the first fix missed. Flipping
    // the quad made the winding agree with the stored normal *for an upright
    // spray only*. The strip's true normal is `G = (dirx·cos a, −sin a,
    // dirz·cos a)`, and what gets stored is `FROND_OUT·G + FROND_UP·ŷ`. So
    //
    //     dot( G , stored ) = FROND_OUT − FROND_UP · sin a
    //
    // which goes negative once `sin a > 0.55/0.85`, i.e. past about 40° of
    // tilt. Beyond that the artistic up-lift has carried the normal across the
    // strip's own plane and out the other side, so a fixed winding cannot
    // agree with it — the surface is unlit from both sides again, exactly as
    // before, and only on the forms that droop.
    //
    // That is precisely the set the audit still flagged: `deadTuft` lays its
    // straw past horizontal (tilt 1.34–1.64) and scored 0%, `fern` arches its
    // fronds to the 2.35 cap and scored 12%. It was also quietly costing a
    // quarter of every shrub, whose `leafShell` blades tilt 0.30–0.92.
    //
    // The lift is right — a straw lying flat on the ground *should* shade as
    // if it faces the sky, and that is the whole reason a mat of it reads as
    // ground texture rather than as a pile of edge-on slivers. So the winding
    // follows the normal rather than the other way round.
    if (s > 0) {
      if (FROND_OUT - FROND_UP * Math.sin(segAng) >= 0) b.quad(pr, r, l, pl);
      else b.quad(pl, l, r, pr);
    }
    pl = l; pr = r;
    segAng = ang;
    px += dirx * Math.sin(ang) * step;
    pz += dirz * Math.sin(ang) * step;
    py += Math.cos(ang) * step;
    ang = Math.min(2.35, ang + (o.droop ?? 0.18));
  }
  return { x: px, y: py, z: pz, yaw: o.yaw, ang };
}

/**
 * Leafy shoots breaking the outline of a foliage mass. A low-poly lobe is a
 * convex polyhedron and reads as a *rock* however you colour it; a dozen small
 * blades poking through the silhouette are what make the same mass read as a
 * bush. Two triangles each, and they buy more than another subdivision level.
 */
function fringe(b, h, w, count, rng, chanBase) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rng() * 0.8;
    const t = 0.30 + rng() * 0.62;                 // height up the mass
    frond(b, {
      x: Math.cos(a) * w * 0.34 * t, y: h * t, z: Math.sin(a) * w * 0.34 * t,
      yaw: a + (rng() - 0.5) * 0.9,
      tilt: 0.35 + rng() * 0.85,
      len: w * (0.34 + rng() * 0.34), w: w * 0.055,
      segs: 1, droop: 0.3, taper: 0.9,
      chanA: chanBase, chanB: chanBase + 0.55, aoA: 0.8, aoB: 1.0,
      swayA: 0.6, trans: 1.0,
    });
  }
}

/**
 * A ring of small ground-hugging lobes at the foot of a mass.
 *
 * Two jobs, both aimed at the same defect: a bush meeting the terrain on a
 * clean curve reads as an object *placed on* the ground rather than one that
 * grew out of it, and the critic called that line out in five separate views.
 * The ring widens and ruffles the base so the silhouette flares into the
 * ground; and because these vertices sit at y ≈ 0, where the height-derived AO
 * bottoms out, they lay a band of the darkest value exactly along the contact,
 * which is the job a contact shadow would do if we could afford one.
 *
 * Lobes rather than a flat skirt disc on purpose. A disc large enough to read
 * would float on its uphill side, because an instance only takes 55% of the
 * terrain's tilt; a lobe has thickness and simply intersects instead.
 */
function skirt(b, w, rng, count = 5, chan = 0.0) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rng() * 1.1;
    // Tightened hard against the foot of the mass. At r up to 0.78 w with a
    // 0.50 radial jitter these landed a metre clear of the bush they belong to,
    // and at ry ≈ 0.3 s they were plates rather than lumps — so what the frame
    // actually showed was isolated flat dark-green polygons lying on the meadow
    // with nothing attached to them, which is the exact defect the skirt exists
    // to fix. Half the radius, a third of the footprint, and proportioned as
    // lumps (ry 0.55-0.90 s) so they turn through the light instead of
    // presenting one flat facet. `ao` off the floor for the same reason: 0.16
    // was dark enough to read as a hole rather than as contact.
    // TIGHTENED AGAIN, and the measurement is unambiguous this time. The mass
    // above only reaches r ≈ 0.34 w, so a skirt lobe drawn anywhere in
    // 0.24-0.47 w spends half its range *outside the silhouette it is meant to
    // flare into* — standing alone on open gold with nothing above it. Zooming
    // `close-grass-2m` on the bush cluster shows exactly that: a half-metre
    // hard-edged dark-green polygon lying on the bank a metre clear of the
    // nearest plant. The ring has to sit strictly inside the crown radius or it
    // is not a skirt, it is litter.
    const r = w * (0.09 + rng() * 0.17);
    // And smaller with it. At 0.062-0.120 w a lobe on a 2.4 m bush was a 29 cm
    // octahedron — a facet scale the whole file has spent four rounds pulling
    // *down* everywhere else. Matched to the crown facet instead.
    const s = w * (0.040 + rng() * 0.042);
    lobe(b, Math.cos(a) * r, w * 0.03, Math.sin(a) * r,
         s, s * (0.55 + rng() * 0.35), s, 0, rng,
         // `ao` up off 0.30 for the same reason the radius came in: a lump that
         // does end up half-visible at the contact should read as shadow under
         // a plant, not as a hole cut in the ground.
         { chan, trans: 0.22, ragged: 0.30, lift: 0.55, ao: 0.50, sway: 0.05 });
  }
}

/**
 * A shell of leafy shoots over a foliage mass — two triangles each, and they
 * are what the silhouette is actually made of.
 *
 * This replaced a shell of small octahedral buds, and the reason is worth
 * keeping. A low-poly lobe is a convex polyhedron: at 2 m each of its eight
 * faces is a flat plate several centimetres across, and jittering the vertices
 * only makes the plates more obviously plates. Zoomed, a bush built that way
 * reads as a stack of folded dark card. Thirty small blades breaking the
 * outline instead read as brush marks, which is both what the plates paint and
 * what the brief asks for — and at two triangles each they cost a quarter of
 * what the buds did.
 *
 * Placement is on the golden angle up a rising shell, so no two neighbours
 * share a height band and the outline never stripes.
 */
function leafShell(b, h, w, count, rng, chanBase, o = {}) {
  const wide = o.wide ?? 0.062;
  const len = o.len ?? 0.125;
  // `inset` < 1 pulls every base in toward the mass. At 1.0 the blades ring the
  // outline and read as a halo of separate cards; at ~0.75 they start inside
  // the crowns and only their tips clear the edge, which is a ragged silhouette
  // rather than a detached one.
  const inset = o.inset ?? 1.0;
  // taper 0.55 left the blade near-parallel-sided, and a near-parallel-sided
  // quad *is* a rectangle — forty of them at forty rotations is precisely the
  // "same rectangle at different rotations" the critic counted. `frond`'s
  // alternating serration widens the base ring and narrows the tip ring, so at
  // 0.84 the same two triangles come out as a pointed leaf at no extra cost.
  // (0.55 was chosen to avoid the old scrub "almond pile"; that failed on
  // *large* fanned strips, and these are an order of magnitude smaller.)
  const taper = o.taper ?? 0.84;
  // How far up the palette pair a blade's tip runs. The default 0.60 was
  // authored when the blades were the whole silhouette and needed to carry the
  // lit half of the bush themselves. Now that the crowns are the mass, a tip
  // that reaches 0.72 of the way to `shrubLit` (a pale yellow-green) turns
  // every blade into a bright spike standing off a dark body — which, counted
  // across ninety-six of them, is most of what "faceted scribble" was pointing
  // at. A mark on a mass should differ from the mass by a step, not by the
  // whole range.
  const span = o.span ?? 0.60;
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996 + rng() * 0.6;
    const t = (i + 0.5) / count;
    // Bases sit inside the mass, and the blade is short enough that its tip
    // lands only about a quarter of a radius beyond it. Longer blades — the
    // first attempt used nearly half the bush's width — project as straight
    // rigid planks radiating out of the mass, which is worse than the smooth
    // blob they were meant to fix.
    // Radius is drawn over a wide range rather than a thin shell. Blades deep
    // inside the mass are not wasted: they are what the outer ones overlap, and
    // overlap is where a canopy of strokes gets its interior depth from.
    const r = w * inset * (0.24 + 0.20 * Math.sin(t * Math.PI)) * (0.34 + rng() * 0.92);
    const bx2 = Math.cos(a) * r, by2 = h * (0.12 + t * 0.80), bz2 = Math.sin(a) * r;
    // Same mass centre as the crowns use, so the blades and the florets under
    // them agree about which way the plant's sunward flank faces — but with the
    // vertical scale doubled, which flattens the direction toward the horizontal.
    //
    // That is not cosmetic. `frond`'s own note is explicit that a blade whose
    // normal points UP is lit by the cool sky dome and renders as a pale grey
    // rag, and the blades on top of a bush are exactly the ones whose mass
    // direction is near +Y. Biasing them there is how you turn the crown of
    // every shrub into the chalky mint facets visible in
    // shots/cover/b1/meadow.png. A bush's sunward flank is a horizontal
    // direction; the bias should point along it.
    const md = o.bias ? massDir(bx2, by2, bz2, h * 0.20, w * 0.34, h * 1.05) : null;
    frond(b, {
      x: bx2, y: by2, z: bz2,
      yaw: a + (rng() - 0.5) * 1.1,
      // Capped short of horizontal: a blade lying flat reads as a plank.
      tilt: (o.tilt ?? 0.30) + rng() * 0.62,
      len: w * len * (0.7 + rng() * 0.7),
      w: w * wide * (0.7 + rng() * 0.6),
      segs: 1, droop: 0.30, taper,
      chanA: chanBase, chanB: chanBase + span,
      aoA: 0.60 + t * 0.30, aoB: 1.0, swayA: 0.45, trans: o.trans ?? 1.0,
      bias: o.bias ?? 0, bx: md?.bx, by: md?.by, bz: md?.bz,
    });
  }
}

/**
 * A flat-ish leaf blade lying near the ground — the broadleaf undergrowth and
 * the fallen-leaf scatter.
 *
 * `cup` rolls the two edge normals away from the midrib. Geometrically the
 * blade is still four vertices and two triangles; what changes is that its
 * shading is no longer constant across its width, and under the game's
 * quantised diffuse response the two halves land in different bands. That is
 * the whole difference between a leaf and a piece of green plastic: with cup 0
 * every one of these renders as a single flat polygon of one value, which is
 * exactly how they read on bare ground in `river` and `cool` — hard-edged
 * cards attached to nothing.
 */
function leafBlade(b, ox, oy, oz, yaw, len, wide, tilt, chan, trans, cup = 0.55) {
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const ny = Math.cos(tilt), nh = Math.sin(tilt);
  const tip = { x: ox + dx * len * Math.sin(tilt + 0.9), y: oy + len * Math.cos(tilt + 0.9) * 0.55, z: oz + dz * len * Math.sin(tilt + 0.9) };
  const midY = oy + len * 0.30 * Math.cos(tilt);
  const mx = ox + dx * len * 0.52, mz = oz + dz * len * 0.52;
  const px = -dz * wide, pz = dx * wide;
  const nrm = [dx * nh * 0.3, ny, dz * nh * 0.3];
  const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
  const n0 = [nrm[0] / nl, nrm[1] / nl, nrm[2] / nl];
  // Roll about the blade's own axis: the width axis is (-dz, 0, dx).
  const roll = (sgn) => {
    const vx = n0[0] + sgn * -dz * cup, vy = n0[1], vz = n0[2] + sgn * dx * cup;
    const l = Math.hypot(vx, vy, vz) || 1;
    return [vx / l, vy / l, vz / l];
  };
  const nL = roll(1), nR = roll(-1);
  const a = b.vert(ox, oy, oz, n0[0], n0[1], n0[2], chan * 0.2, 0.42, 0.1, trans);
  const l = b.vert(mx + px, midY, mz + pz, nL[0], nL[1], nL[2], chan * 0.6, 0.85, 0.6, trans);
  const r = b.vert(mx - px, midY, mz - pz, nR[0], nR[1], nR[2], chan * 0.6, 0.85, 0.6, trans);
  const t = b.vert(tip.x, tip.y, tip.z, n0[0], n0[1], n0[2], chan, 1.0, 1.0, trans);
  b.tri(a, l, r);
  b.tri(l, t, r);
}

/** Loft an n-gon along a polyline of {x,y,z,r} — logs, stumps, branches. */
function tube(b, path, sides, chan, trans, capEnds = true) {
  const rings = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const q = path[Math.min(path.length - 1, i + 1)];
    const o = path[Math.max(0, i - 1)];
    let ax = q.x - o.x, ay = q.y - o.y, az = q.z - o.z;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    // Any vector not parallel to the axis will do for the frame.
    let ux = -az, uy = 0, uz = ax;
    if (Math.hypot(ux, uy, uz) < 1e-4) { ux = 1; uy = 0; uz = 0; }
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
      // Lift the normal so the top of a log catches the key light as one mass.
      const lnx = nx, lny = ny + 0.55, lnz = nz;
      const ll = Math.hypot(lnx, lny, lnz) || 1;
      ring.push(b.vert(p.x + nx * p.r, p.y + ny * p.r, p.z + nz * p.r,
                       lnx / ll, lny / ll, lnz / ll,
                       chan, 0.42 + 0.58 * clamp01(ny * 0.5 + 0.5), 0.0, trans));
    }
    rings.push(ring);
  }
  // Wound so the *outer* wall is the front face.
  //
  // This was inverted, and it is the single reason every piece of fallen wood
  // in the game rendered as a near-black ribbon on a pale gold ground. The ring
  // runs u→v, which is right-handed about the tube's axis, so `quad(A[s], B[s],
  // B[s2], A[s2])` produced a face normal of exactly −n: on the front-sided
  // solid material the lit outer surface was culled and what reached the screen
  // was the *far inner wall*, whose vertex normals point away from both the
  // camera and the sun. No albedo can survive that — the pale `barkGrey` was
  // arriving as `srgb(46,38,32)`. Logs, stumps and branches all shared it.
  for (let i = 1; i < rings.length; i++) {
    const A = rings[i - 1], B2 = rings[i];
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      b.quad(A[s], A[s2], B2[s2], B2[s]);
    }
  }
  if (capEnds) {
    // The caps were always right — natural ring order gives a +axis face, so
    // the start cap is the flipped one. Only the side quads were inverted.
    for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]]) {
      for (let s = 1; s < sides - 1; s++) {
        if (flip) b.tri(ring[0], ring[s + 1], ring[s]);
        else b.tri(ring[0], ring[s], ring[s + 1]);
      }
    }
  }
}

// ── archetype builders ───────────────────────────────────────────────────────

/**
 * The value anchor. Plate 1's meadow is dotted with these — near-black-green
 * domes about knee-to-waist high, wider than tall, no visible stem. They are
 * the single most important thing in this system: without them the gold reads
 * as a flat carpet with no scale.
 */
function buildShrubDark(rng) {
  const b = new Builder();
  // Knee-to-waist. At the previous 1.5-2.4 m these silhouetted taller than the
  // camper's wheel arches and read as saplings, and the 2 m close-up put one
  // across a third of the frame.
  const h = 0.92 + rng() * 0.60;
  // NARROWED, and the arithmetic behind it is the thing that had been missing
  // from four rounds of "make the facet smaller".
  //
  // What the crop actually shows after the facets came down is not plates any
  // more, it is *holes*: dark green marks with sunlit gold between them, over
  // the whole body of the bush. Coverage is the number nobody had computed.
  // Thirty crowns of radius p scattered inside a dome of radius R paint
  // N.pi.p^2 over a disc of pi.R^2, so opacity depends only on N(p/R)^2 — and
  // at the old p = 0.118 w, R = 0.36 w that is 1.6, about 80% of one covering.
  // Random placement then leaves e^-1.6 = 20% of the silhouette showing
  // through, which is exactly what a scribble is.
  //
  // Only three things move that number, and two of them cost triangles. The
  // third is free: shrink the crown-placement radius R relative to w. That is
  // what the `r` line below now does, and coverage depends on the *ratio* p/R,
  // so the aspect of the bush is free to be whatever the plates say it is.
  //
  // Which is wider than tall, and the first pass at this overshot into taller
  // than wide — the crop came back with bushes stacked like small conifers.
  // Back to a dome.
  const w = h * (1.00 + rng() * 0.34);

  // REBUILT. The previous form was a *core plus a shell*: two concentric
  // ellipsoids carrying all the value, ringed by forty separate blades. At 2 m
  // that read exactly as the critic described it — "a solid near-black
  // hexagonal core with one flat value and no interior form, surrounded by a
  // halo of detached rectangular leaf quads". Both halves of that were
  // structural, not shading:
  //
  //  · two concentric lobes sharing one centre, one `chan`, one `lift` and one
  //    narrow height band have nothing to vary *across* them. Every face
  //    landed in the same quantised lighting band, so thirty-two triangles
  //    resolved to one flat polygon whatever the albedo was.
  //  · a shell whose blades all start at 0.24-0.44 w and run outward puts
  //    every card beyond the core's own outline, against bright background,
  //    with a gap behind it. That is what makes them read as detached.
  //
  // So the mass is now a *clump*: seven crowns of different size at different
  // heights on a golden-angle spiral, deliberately overlapping. Their edges cut
  // across each other, which is where interior contour comes from; and each
  // carries its own albedo mix, its own AO and — the strongest of the three —
  // its own normal lift, so a crown low on the flank splays its normals
  // sideways and sits a whole lighting band below the crown above it. Value
  // range inside the silhouette is the thing that was missing.
  // The armature is deliberately *small*. This is the second correction to the
  // same defect and it is the one that matters: a low-poly lobe is a convex
  // polyhedron, and no amount of subdividing or jittering stops it presenting
  // 20 cm flat plates at 2 m — nine crowns of them read as folded green card
  // exactly as two did. So the lobes retreat to being an interior armature that
  // carries value and blocks light, and the *visible surface* becomes a canopy
  // of a hundred-odd leaf strokes over the top of it. That is what the plates
  // actually paint: a shrub there is a cluster of small dark marks with a
  // bitten edge, not a solid with facets. Same triangle budget, spent on the
  // part of the form the player can resolve.
  //
  // THIRD CORRECTION, and it reverses part of the second. Measuring the
  // reference rather than reasoning about it: crop plate 1 at the birch bases
  // and plate 2 at the river bank and a low bush there is a *dense cluster of
  // small rounded lobes* — overlapping florets with bright tops, dark flanks
  // and near-black pockets between them, ragged at the edge. It is not a cloud
  // of blades over nothing. Retreating the armature to "interior" left ninety
  // blades carrying the whole silhouette, each one 10-20 px on a 90 px bush,
  // and a hundred separate marks with gold showing between them is precisely
  // the "faceted scribble" the critic named.
  //
  // So the split changes: the florets are the mass and are meant to be seen,
  // and the blades come *down* to a size where they read as texture on that
  // mass rather than as the mass itself. Two things keep the florets from
  // reading as the folded card they did last time — there are twelve rather
  // than six, so no single 8-face lobe is a large share of the outline; and
  // the rise runs in spiral order rather than being drawn at random, which
  // fills a dome evenly instead of clumping two thirds of them into one height
  // band and leaving a ring.
  // FOURTH, and it is a size correction rather than another rebuild — the
  // clumped mass is right, the proportions inside it were not. At twelve
  // florets each about a quarter of the bush wide, stepped by a clean golden
  // angle with no jitter on the rise, the 2 m frame came back reading as a
  // *pine cone*: regular overlapping scales, each showing three or four flat
  // 20 cm plates. That is phyllotaxis doing exactly what phyllotaxis does, and
  // the fix is the one rule this file keeps relearning — the facet has to be
  // the size of the mark, not the size of the form.
  //
  // So: seventeen florets at a little over half the radius, the spiral broken
  // by a full-turn jitter on one in three, and the rise jittered off the
  // sequence so no two neighbours are a fixed step apart. Facet and leaf mark
  // now land within a couple of centimetres of each other, which is what makes
  // a surface read as one material instead of as scales with confetti on them.
  // FIFTH, and it is the same lesson measured properly rather than reasoned
  // about. Cropping `meadow` at the named pixels and scaling it 2x, the bush is
  // not black any more — the receive-shadow fix did land — but it is a heap of
  // hard-edged mid-green *plates* 20-35 px across on a 250 px bush, with gold
  // showing through the gaps between them. That is 8-14% of the bush width per
  // facet. Cropping plate 1 at the birch bases and plate 2 at the river bank,
  // the marks on a reference bush are 6-10 px on a 110-130 px bush: 5-8%.
  //
  // Two numbers were producing the plates and only one of them had ever been
  // touched. `sz` at 0.118 w gives an octahedron whose eight faces each span
  // most of its radius — but `ragged: 0.50` then moves every vertex by up to
  // half the radius *outward*, so the worst facets were running to 0.18 w and
  // the silhouette was a spiky polyhedron rather than a lump. Cutting the size
  // alone would have left the spikes; cutting the jitter alone would have left
  // 25 cm plates. Both, and the count up to keep the mass closed.
  const crowns = 35 + ((rng() * 5) | 0);
  for (let i = 0; i < crowns; i++) {
    const a = i * 2.39996 + (rng() < 0.34 ? rng() * TAU : rng() * 0.9);
    const rise = clamp01(Math.pow((i + 0.35) / crowns, 0.60) + (rng() - 0.5) * 0.30);
    // Radius closes with height so the silhouette is a dome. The previous
    // ordering widened with height, which is a bowl, and a bowl seen from a
    // standing camera shows its inside.
    //
    // `sqrt` rather than a flat roll: a flat radius roll piles crowns at the
    // centre in *area* terms and thins the rim, which is where a mass most
    // needs to be closed. Uniform-in-area fill is what a dome of florets is.
    // At R = 0.27 w over a height span of 0.58 h the mass came out 0.64 h wide
    // and 0.58 h tall — a cone, and the crop showed a row of stacked scales.
    // A dome wants the base wide and the rise short. Coverage only depends on
    // N (p/R)^2, so widening R has to be paid for in one of the other two: a
    // sixth more crowns and a slightly larger floret, which together hold the
    // covering near 2.2 and cost twenty triangles a bush.
    const r = w * (0.36 - 0.21 * rise) * Math.sqrt(0.05 + rng() * 0.95);
    // Widened jitter. At 0.80-1.24 every floret was within a quarter of every
    // other, and a golden-angle spiral of equal discs is a sunflower head —
    // which is what "stacked scales" was. A 2.4x spread inside the same mean
    // breaks the pattern for nothing.
    // Spread narrowed from 0.62-1.48. The top of that range put a 40 cm floret
    // on a 1.4 m bush, and one lobe that size is three hard plates the eye
    // groups before it groups the mass — the "low-poly blob" reading survives
    // any amount of value work while the biggest facet is that big. Same mean,
    // two thirds the spread, and the count up to keep the covering closed.
    const sz = w * (0.098 - 0.022 * rise) * (0.74 + rng() * 0.54);
    const fx = Math.cos(a) * r, fy = h * (0.12 + 0.54 * rise), fz = Math.sin(a) * r;
    // SIXTH, and unlike the five above it is not another size correction — the
    // facets are the right size now and the bush was still a dark scribble. See
    // the note on `bias` in `lobe`: the value range has to be organised by the
    // mass, not distributed at random across it.
    const md = massDir(fx, fy, fz, h * 0.20, w * 0.34, h * 0.52);
    lobe(b, fx, fy, fz,
         sz, sz * (0.74 + rng() * 0.34) * (h / w), sz * (0.86 + rng() * 0.32),
         0, rng,
         { chan: 0.16 + rise * 0.40 + rng() * 0.22,
           trans: 0.32 + rise * 0.34,
           // Ragged down from 0.44. At half the lobe radius the worst vertices
           // ran a spike out past the silhouette, and thirty-one spikes on a
           // 90 px bush is the "hard-edged scribble" outline. The reference's
           // bushes have a *lobed* edge — bitten, but out of a curve.
           ragged: 0.32,
           bias: 0.62, bx: md.bx, by: md.by, bz: md.bz,
           // Per-floret normal bias is where the interior value range actually
           // comes from. The palette pair is deliberately narrow, so albedo
           // cannot supply it; what can is adjacent faces landing in different
           // bands of the global quantised diffuse response, and `lift` is the
           // one parameter that moves a whole floret across a band boundary.
           //
           // RAISED, and the floor is the important half. At `lift` 0.04 a
           // floret's own six normals still point almost radially, so its eight
           // faces land in six different bands and every one of them shows its
           // edges — which is what "hard flat triangles" is, independently of
           // how big the triangles are. Biasing the normals hard toward the sky
           // makes the faces of one floret shade nearly alike, so the floret
           // reads as a soft round mark and the value range moves up a level to
           // being *between* florets, where the eye can group it. Free: it is
           // the same eight triangles.
           //
           // The ceiling is not a taste call — see the clamp in `lobe`. At 1.0
           // the underside normal is the zero vector.
           //
           // AND NOW CUT BACK, because the reasoning above is right about the
           // floret and wrong about the plant. Biasing toward +Y does make one
           // floret read as one soft mark — and at golden hour, with the sun
           // 20° up, it also hands every mark the same weak grazing value, so
           // the plant has no lit side. `bias` above does the softening job
           // instead, and does it toward the direction that actually catches
           // the key. What is left here is a small sky term that keeps the
           // tops a shade above the flanks.
           lift: 0.16 + rise * 0.20 });
  }
  // Marks sized to the floret facet, and pushed back out to `inset` 1.0 so
  // their tips clear the mass. Cut too small last round they vanished into it,
  // and a mass with no marks past its own outline has a smooth edge — which is
  // the one thing every bush in the plates does not have.
  //
  // Count down with the crown count up, so the triangle total is unchanged
  // (26 x 8 + 58 x 2 + 6 x 8 = 372, against the previous 376-384). The blades
  // are no longer being asked to carry the silhouette on their own, so ninety
  // of them was ninety chances to read as a separate pale card; and `span`
  // holds their tips one step off the mass instead of taking them to the pale
  // end of the palette. See the note on `span` in `leafShell`.
  // …and pulled back in again. `inset` 0.94 with the blade's own 0.34-1.26
  // radius roll puts a third of them wholly outside the crown radius, which is
  // a halo of loose marks on gold, not a ragged edge. At 0.78 the bases are
  // buried and only the tips break the outline. Shorter with it, so a tip
  // clears the mass by a couple of centimetres rather than by a blade length.
  // Count up and size down together. Crops of reference plate 2 put the fringe
  // on a bush at roughly 2% of its own width; at len 0.074 ours was at 8%, and
  // a mark that big does not fringe a silhouette, it is one of the shapes the
  // silhouette is made of. Blades are two triangles, so trading size for count
  // at constant painted area is close to free.
  leafShell(b, h, w, 76, rng, 0.14,
            { len: 0.044, wide: 0.024, inset: 0.78, tilt: 0.24, span: 0.30,
              // See the note beside `bias` in `frond`. Without it the crowns
              // resolve into three masses and the forty blades over them go on
              // painting forty unrelated values.
              bias: 0.55,
              // Held back off the default 1.0. A blade is the thinnest thing on
              // the plant, so the backlit rim finds it first and finds all of
              // it; at full translucency the `backlit` frame came back with
              // near-white slivers standing off every bush.
              trans: 0.70 });
  skirt(b, w, rng, 4, 0.0);
  return b.finish(h);
}

/** Autumn berry bush: rust foliage with crimson accent lobes and berry knots. */
function buildShrubBerry(rng) {
  const b = new Builder();
  const h = 0.92 + rng() * 0.56;
  // Narrowed with `shrubDark`, for the coverage arithmetic written out there.
  const w = h * (0.96 + rng() * 0.30);
  // Same clumped construction as `shrubDark`, for the same reason: a single
  // core plus a shell renders as one smooth dome with two flat facets, and at
  // 2 m the berry knots sitting on top of it read as pink diamonds stuck to a
  // ball. Fewer, slightly larger crowns than the dark shrub — an autumn berry
  // bush is rangier — and the colour turn runs by crown rather than by patch,
  // so a whole shoulder goes over to the accent at once.
  // Follows `shrubDark`'s third correction: ordered rise up a golden-angle
  // spiral so the florets fill a dome rather than a band, a radius that closes
  // with height, and marks small enough to be texture on the mass instead of
  // the large flat plates that made this one read as folded dark-red card
  // beside the dark shrub in `meadow`.
  // Facet and mark scale follow `shrubDark`'s fifth correction exactly: crown
  // size down by a third, vertex jitter roughly halved, count up to keep the
  // mass closed, and the blade tips held one palette step off the body instead
  // of running to the pale end. Measured beside it in the same frame this was
  // the *worse* of the two — the maroon pair has a wider value range, so a
  // 25 cm plate of it against gold was the highest-contrast hard edge anywhere
  // in the layer.
  const crowns = 33 + ((rng() * 5) | 0);
  for (let i = 0; i < crowns; i++) {
    const a = i * 2.39996 + (rng() < 0.34 ? rng() * TAU : rng() * 0.9);
    const rise = clamp01(Math.pow((i + 0.35) / crowns, 0.58) + (rng() - 0.5) * 0.30);
    const rr = w * (0.37 - 0.22 * rise) * Math.sqrt(0.05 + rng() * 0.95);
    const sz = w * (0.102 - 0.023 * rise) * (0.74 + rng() * 0.54);
    const fx = Math.cos(a) * rr, fy = h * (0.13 + 0.54 * rise), fz = Math.sin(a) * rr;
    const md = massDir(fx, fy, fz, h * 0.21, w * 0.35, h * 0.52);
    lobe(b, fx, fy, fz,
         sz, sz * (0.74 + rng() * 0.32) * (h / w), sz * (0.84 + rng() * 0.34),
         0, rng,
         { chan: rng() < 0.34 ? 0.58 + rng() * 0.26 : 0.18 + rise * 0.34,
           trans: 0.55 + rise * 0.35, ragged: 0.32,
           // Mass-biased with `shrubDark`, and it matters more here: the maroon
           // pair has the widest value range in the layer, so unorganised
           // per-floret normals turned it into the highest-contrast noise
           // anywhere in the frame.
           bias: 0.62, bx: md.bx, by: md.by, bz: md.bz,
           lift: 0.16 + rise * 0.20 });
  }
  leafShell(b, h, w, 58, rng, 0.10,
            { len: 0.044, wide: 0.023, inset: 0.80, tilt: 0.24, span: 0.30,
              bias: 0.55, trans: 0.70 });
  leafShell(b, h, w, 22, rng, 0.54,
            { len: 0.042, wide: 0.022, inset: 0.84, tilt: 0.24, span: 0.26,
              bias: 0.55, trans: 0.70 });
  // Berry knots, fully accent, and small enough to read as a fleck rather than
  // as a facet. Tucked *into* the crowns, not perched on the outside.
  for (let i = 0; i < 5; i++) {
    const a = rng() * TAU, rr = w * (0.16 + rng() * 0.30);
    lobe(b, Math.cos(a) * rr, h * (0.34 + rng() * 0.44), Math.sin(a) * rr,
         w * 0.050, w * 0.042, w * 0.050, 0, rng,
         { chan: 1.0, trans: 0.35, ragged: 0.24, lift: 0.35 });
  }
  skirt(b, w, rng, 6, 0.0);
  return b.finish(h);
}

/**
 * Low dry scrub — the ochre clumps dotted through plate 1's meadow and banked
 * along plate 2's slope.
 *
 * REBUILT. The previous form had no mass at all: it was a fan of ten to
 * sixteen tapered strips, and a tapered strip seen anywhere near flat-on is a
 * pale oval. A hillside of them read, exactly as the critic put it, as a heap
 * of almonds — and it corresponded to nothing in any plate. What the plates
 * actually show is a *low dense clump* with a bitten outline: a squat body
 * carrying its value, with twiggy sprays as the fuzz on its edge rather than
 * as the whole plant. Wider than tall by half again, and knee-high at most, so
 * it sits below the grass line and reads as ground texture rather than as
 * another bush.
 */
function buildScrubDry(rng) {
  const b = new Builder();
  const h = 0.32 + rng() * 0.26;
  const w = h * (1.50 + rng() * 0.95);
  for (let i = 0; i < 2; i++) {
    const a = i * 2.4 + rng() * 1.4;
    const r = w * 0.14 * i;
    const fx = Math.cos(a) * r, fy = h * (0.28 + rng() * 0.12), fz = Math.sin(a) * r;
    const md = massDir(fx, fy, fz, h * 0.10, w * 0.34, h * 0.42);
    // Only the first core is subdivided. There are several hundred of these on
    // a hillside and the second lobe is entirely inside the blade shell, so it
    // is buying value, not silhouette, and eight faces buy that just as well.
    lobe(b, fx, fy, fz,
         w * (0.30 + rng() * 0.12), h * (0.28 + rng() * 0.10), w * (0.28 + rng() * 0.12),
         i === 0 ? 1 : 0, rng,
         { chan: 0.0, trans: 0.55, ragged: 0.30,
           // A scrub clump is squat and wide, so its two cores nearly share a
           // centre; without the mass bias they present one sky-facing dome
           // that at golden hour is the same grazing value from every side.
           bias: 0.45, bx: md.bx, by: md.by, bz: md.bz,
           lift: 0.24 });
  }
  // Broad short blades, not sprays. The whole point of the rebuild is that a
  // long tapered strip seen flat-on is a pale oval; keeping them short and
  // near-parallel-sided keeps them reading as a bristly edge on a mass.
  //
  // SHORTENED. `len: 0.20` on a w up to 1.4 m put 30 cm blades on a plant 40 cm
  // tall — longer than the body they grow from, and drawn at `chanB` 0.90,
  // which is near the pale tip of the scrub pair. In `meadow` those are the
  // mint-green spikes standing clear of every clump: not a bristly edge, a
  // scatter of loose pale strips. Two thirds the length, a fifth narrower, more
  // of them, and the tip held a third of the way up the pair instead of nine
  // tenths.
  leafShell(b, h, w, 46, rng, 0.26,
            { wide: 0.050, len: 0.105, tilt: 0.42, inset: 0.70, span: 0.24,
              bias: 0.48 });
  skirt(b, w, rng, 4, 0.0);
  return b.finish(h);
}

/**
 * Riverbank thicket — willow / alder. Taller and rangier than a meadow shrub,
 * with drooping whips over the mass, so a bank reads as a soft green wall.
 */
function buildThicket(rng) {
  const b = new Builder();
  const h = 1.7 + rng() * 1.5;
  const w = h * (0.48 + rng() * 0.26);
  // BROKEN UP, and this is the same defect as the shrubs' — found late because
  // there are only about forty thickets in a frame and they live on riverbanks
  // rather than in the meadow the critic was measuring. Three to five stem
  // masses at `w * (0.36-0.58)` on a thicket up to 2.4 m wide are lobes 1.4 m
  // across, i.e. eight flat plates each two thirds of a metre. Zooming
  // `close-grass-2m` on the far bank, those are the remaining "loose green
  // cards": hard-edged dark-green polygons a metre across with a visible
  // straight silhouette, sitting where the bank meets the water.
  //
  // The stems stay, at a third the size, as the interior armature that carries
  // the deep value and blocks light through the mass. Over them goes the same
  // crown cloud the shrubs use. A thicket costs about a hundred triangles more
  // than it did, which at forty instances is nothing.
  const stems = 3 + ((rng() * 3) | 0);
  const tops = [];
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * TAU + rng() * 0.8;
    const r = w * 0.32 * rng();
    const top = h * (0.62 + rng() * 0.38);
    tops.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, top });
    // Smaller again, and this is the second cut. `w * (0.15-0.24)` reads fine
    // written down and is a 58 cm radius on a thicket 2.4 m wide — a single
    // unsubdivided lobe 1.15 m across, which is still the biggest flat facet in
    // the layer and still visible as one in `close-grass-2m`, because the crown
    // cloud started at 30% of the stem height and left its lower half bare. Cut
    // to a real armature, and the crowns now start low enough to cover it.
    lobe(b, Math.cos(a) * r, top * 0.56, Math.sin(a) * r,
         w * (0.09 + rng() * 0.06), top * 0.32, w * (0.085 + rng() * 0.055),
         0, rng,
         { chan: rng() * 0.35, trans: 0.85, ragged: 0.36, lift: 0.72 });
  }
  const crowns = 25 + ((rng() * 5) | 0);
  for (let i = 0; i < crowns; i++) {
    const s = tops[i % stems];
    const a = i * 2.39996 + rng() * 0.9;
    const rise = clamp01(Math.pow((i + 0.4) / crowns, 0.55) + (rng() - 0.5) * 0.34);
    const rr = w * (0.34 - 0.16 * rise) * Math.sqrt(0.05 + rng() * 0.95);
    const sz = w * (0.088 - 0.020 * rise) * (0.62 + rng() * 0.86);
    const fx = s.x + Math.cos(a) * rr, fy = s.top * (0.14 + 0.82 * rise);
    const fz = s.z + Math.sin(a) * rr;
    const md = massDir(fx, fy, fz, h * 0.26, w * 0.42, h * 0.60);
    lobe(b, fx, fy, fz,
         sz, sz * (0.80 + rng() * 0.36), sz * (0.84 + rng() * 0.34), 0, rng,
         { chan: 0.18 + rise * 0.44 + rng() * 0.16, trans: 0.70 + rise * 0.30,
           ragged: 0.34,
           bias: 0.58, bx: md.bx, by: md.by, bz: md.bz,
           lift: 0.16 + rise * 0.20 });
  }
  // Same mark scale as the two shrubs. A thicket is bigger, so a blade sized
  // as a fraction of *its* width was a 40 cm plate — the widest flat facet in
  // the layer, on the archetype with the longest visibility radius.
  leafShell(b, h, w, 118, rng, 0.30,
            { wide: 0.034, len: 0.078, inset: 0.80, tilt: 0.26, span: 0.36,
              bias: 0.52 });
  skirt(b, w, rng, 5, 0.10);
  const whips = 4 + ((rng() * 4) | 0);
  for (let i = 0; i < whips; i++) {
    const a = rng() * TAU;
    frond(b, {
      x: 0, y: h * (0.42 + rng() * 0.42), z: 0,
      yaw: a, tilt: 0.75 + rng() * 0.55,
      len: h * (0.40 + rng() * 0.34), w: h * 0.030,
      segs: 3, droop: 0.30, taper: 0.9,
      chanA: 0.35, chanB: 1.0, aoA: 0.7, aoB: 1.0, swayA: 0.55, trans: 1.0,
    });
  }
  return b.finish(h);
}

/** Forest-floor fern, arching, green at the crown and bronzing at the tips. */
function buildFern(rng) {
  const b = new Builder();
  const h = 0.30 + rng() * 0.28;
  const n = 6 + ((rng() * 3) | 0);
  // Two or three crowns a hand's width apart, not one hub. Every frond leaving
  // a single point at one height and one length is the starburst again — from
  // the near-top-down angle the player gets while driving, a fern built that way
  // resolves to eight strips radiating from a dot, which is the shape the critic
  // called a scratch on the lens. Real ferns clump, and no two fronds in a clump
  // are the same length.
  const crowns = 2 + ((rng() * 2) | 0);
  const cx = [], cz = [];
  for (let c = 0; c < crowns; c++) {
    const ca = rng() * TAU, cr = h * (0.10 + rng() * 0.38);
    cx.push(Math.cos(ca) * cr); cz.push(Math.sin(ca) * cr);
  }
  for (let i = 0; i < n; i++) {
    const c = i % crowns;
    const a = i * 2.39996 + rng() * 0.9;
    frond(b, {
      x: cx[c], y: h * (0.03 + rng() * 0.09), z: cz[c],
      yaw: a, tilt: 0.42 + rng() * 0.60,
      len: h * (0.70 + 1.05 * rng() * rng()), w: h * (0.13 + rng() * 0.09),
      segs: 4, droop: 0.22 + rng() * 0.20, taper: 0.92,
      chanA: 0.0, chanB: 0.95, aoA: 0.44, aoB: 1.0, swayA: 0.25, trans: 1.0,
    });
  }
  return b.finish(h * 1.1);
}

/**
 * Low broadleaf — the flat green stuff between the ferns.
 *
 * REBUILT, and it is one of the two things that were producing the loose green
 * cards lying on bare ground. Five to eight blades up to `h * 2.4` long,
 * radiating from one point at one height, with `h` up to 0.38 and an instance
 * scale up to 1.5, put metre-long flat planes on the terrain — and because
 * every vertex of a blade carried the *same* normal they rendered as single
 * untextured green polygons. From a low camera a whole plant is edge-on and
 * all you see is the two or three blades facing you, so the "plant" they belong
 * to is invisible and the cards read as orphans.
 *
 * Now: two thirds the height, blades a third the length, a squat body lobe
 * underneath them so there is a mass they visibly grow out of, and the leaves
 * cupped so each one shades across its width.
 */
function buildBroadleaf(rng) {
  const b = new Builder();
  const h = 0.13 + rng() * 0.12;
  const n = 7 + ((rng() * 5) | 0);
  lobe(b, 0, h * 0.20, 0, h * (0.62 + rng() * 0.30), h * 0.28, h * (0.58 + rng() * 0.30),
       0, rng, { chan: 0.0, trans: 0.35, ragged: 0.46, lift: 0.55, ao: 0.44 });
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rng() * 0.9;
    const r = h * (0.08 + rng() * 0.26);
    leafBlade(b, Math.cos(a) * r, h * (0.08 + rng() * 0.20), Math.sin(a) * r, a,
              h * (0.80 + rng() * 0.70), h * (0.22 + rng() * 0.14),
              0.60 + rng() * 0.52, 0.30 + rng() * 0.65, 1.0, 0.62);
  }
  return b.finish(h * 1.2);
}

/**
 * Moss cushion for the damp north side of logs, rocks and trunks.
 *
 * REBUILT, and it is the other source of the loose green cards. Three
 * unsubdivided octahedra is *eight flat faces each*, at 0.2-0.36 m across and
 * 0.09-0.16 m tall — squashed almost flat. Seen from a standing camera an
 * octahedron squashed on Y presents one large upward-facing quad, so a moss
 * patch on the open clay in `river` resolved to two or three green
 * parallelograms with hard polygon edges and no interior variation.
 *
 * Now: smaller and more numerous lobes so no single facet dominates, the first
 * one subdivided, per-lobe albedo mix, and a fuzz of tiny tufts over the rim so
 * the outline is never a straight polygon edge. (Also moved to the double-sided
 * material — the tufts are one-sided quads.)
 */
function buildMoss(rng) {
  const b = new Builder();
  const h = 0.07 + rng() * 0.06;
  const n = 4 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rng() * 0.9;
    const r = 0.05 + rng() * 0.16;
    const s = 0.085 + rng() * 0.105;
    lobe(b, Math.cos(a) * r, h * (0.30 + rng() * 0.40), Math.sin(a) * r,
         s, h * (0.70 + rng() * 0.55), s * (0.78 + rng() * 0.44), i === 0 ? 1 : 0, rng,
         { chan: rng() * 0.60, trans: 0.35, ragged: 0.48, lift: 0.85,
           ao: 0.66 + rng() * 0.32 });
  }
  for (let i = 0; i < 7; i++) {
    const a = rng() * TAU, r = 0.07 + rng() * 0.15;
    frond(b, {
      x: Math.cos(a) * r, y: h * 0.45, z: Math.sin(a) * r,
      yaw: a, tilt: 0.22 + rng() * 0.50,
      len: 0.040 + rng() * 0.050, w: 0.013 + rng() * 0.011,
      segs: 1, droop: 0.20, taper: 0.85,
      chanA: 0.30, chanB: 1.0, aoA: 0.88, aoB: 1.0, swayA: 0.10, trans: 0.9,
    });
  }
  return b.finish(h * 2.2);
}

/**
 * Late-season aster drift. The heads are deliberately tiny: plate 1's
 * blue-violet flecks are a two-pixel surprise at close range, and anything
 * bigger would break the brief's 1%-cool-pixels budget.
 */
function buildFlowerAster(rng) {
  const b = new Builder();
  const h = 0.26 + rng() * 0.22;
  const n = 7 + ((rng() * 5) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = 0.10 + rng() * 0.16;
    const stemH = h * (0.65 + rng() * 0.55);
    const tip = frond(b, {
      x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r,
      yaw: a, tilt: 0.10 + rng() * 0.22, len: stemH, w: 0.010,
      segs: 1, droop: 0.10, taper: 0.4,
      chanA: 0.0, chanB: 0.0, aoA: 0.5, aoB: 1.0, swayA: 0.3, trans: 0.8,
    });
    const hw = 0.020 + rng() * 0.014;
    const c0 = b.vert(tip.x - hw, tip.y, tip.z - hw, 0, 1, 0, 1, 1, 1, 0.5);
    const c1 = b.vert(tip.x + hw, tip.y, tip.z - hw, 0, 1, 0, 1, 1, 1, 0.5);
    const c2 = b.vert(tip.x + hw, tip.y + hw * 0.5, tip.z + hw, 0, 1, 0, 1, 1, 1, 0.5);
    const c3 = b.vert(tip.x - hw, tip.y + hw * 0.5, tip.z + hw, 0, 1, 0, 1, 1, 1, 0.5);
    b.quad(c3, c2, c1, c0);            // face up, to match the (0,1,0) normals
  }
  return b.finish(h);
}

/** Goldenrod — taller, with a gold plume that catches the low sun. */
function buildGoldenrod(rng) {
  const b = new Builder();
  const h = 0.44 + rng() * 0.32;
  const n = 6 + ((rng() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = 0.08 + rng() * 0.14;
    const tip = frond(b, {
      x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r,
      yaw: a, tilt: 0.06 + rng() * 0.20, len: h * (0.60 + rng() * 0.30), w: 0.011,
      segs: 1, droop: 0.08, taper: 0.35,
      chanA: 0.0, chanB: 0.1, aoA: 0.5, aoB: 0.95, swayA: 0.35, trans: 0.9,
    });
    frond(b, {
      x: tip.x, y: tip.y, z: tip.z,
      yaw: a + 0.4, tilt: 0.05 + rng() * 0.18, len: h * (0.24 + rng() * 0.16), w: 0.030,
      segs: 2, droop: 0.16, taper: 0.95,
      chanA: 0.6, chanB: 1.0, aoA: 0.9, aoB: 1.0, swayA: 0.8, trans: 1.0,
    });
  }
  return b.finish(h);
}

/** Dry seed stalks — the pale vertical flecks over a late-season meadow. */
function buildSeedHead(rng) {
  const b = new Builder();
  const h = 0.50 + rng() * 0.40;
  const n = 8 + ((rng() * 6) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = 0.06 + rng() * 0.16;
    const tip = frond(b, {
      x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r,
      yaw: a, tilt: 0.05 + rng() * 0.30, len: h * (0.68 + rng() * 0.34), w: 0.008,
      segs: 1, droop: 0.14, taper: 0.3,
      chanA: 0.0, chanB: 0.2, aoA: 0.55, aoB: 1.0, swayA: 0.4, trans: 0.95,
    });
    frond(b, {
      x: tip.x, y: tip.y, z: tip.z,
      yaw: a, tilt: 0.20 + rng() * 0.35, len: h * 0.13, w: 0.019,
      segs: 1, droop: 0.30, taper: 0.85,
      chanA: 0.8, chanB: 1.0, aoA: 1.0, aoB: 1.0, swayA: 0.9, trans: 1.0,
    });
  }
  return b.finish(h);
}

/**
 * A drift of fallen leaves. A scalloped low disc for the mass plus a few
 * leaves standing proud of the rim, which is what keeps it from reading as a
 * decal — a flat painted patch on a hillside gives itself away instantly.
 */
function buildLeafDrift(rng) {
  const b = new Builder();
  const R = 0.50 + rng() * 0.50;

  // REBUILT as a shallow *mound*. The previous form was a scalloped ten-sided
  // disc lying flat with every normal pointing straight up, and that is a decal
  // however it is wound: one polygon, one normal, therefore one value across
  // half a metre of ground, with a hard straight edge where it stops. Under a
  // 20-degree sun that single value sits far enough under the terrain beside it
  // to read as a black hole in the meadow — which is exactly how it measured at
  // every deciduous tree base.
  //
  // A drift of leaves has depth. Small flattened lobes give it a top that turns
  // through the light and an edge that breaks up, and the loose leaves over
  // them do the rest.
  // Nine or ten small lobes rather than five or eight bigger ones, and the
  // reason is what the 2 m crop showed: at `R * (0.16-0.32)` on an R up to 1.0
  // this was two or three 60 cm lumps and it read as a smooth maroon gel blob
  // lying in the meadow — one value, no marks, a slug. A drift is many small
  // heaps of leaves. Same lesson, same file, fourth form.
  const n = 9 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rng() * 0.8;
    const r = R * (0.08 + rng() * 0.52) * Math.sqrt(0.1 + rng() * 0.9);
    const s = R * (0.11 + rng() * 0.11);
    lobe(b, Math.cos(a) * r, 0.018 + rng() * 0.055, Math.sin(a) * r,
         s, 0.030 + rng() * 0.048, s * (0.80 + rng() * 0.45), 0, rng,
         { chan: rng() < 0.38 ? 0.80 + rng() * 0.20 : 0.10 + rng() * 0.22,
           trans: 0.35, ragged: 0.48, lift: 0.50 + rng() * 0.30,
           ao: 0.68 + rng() * 0.32 });
  }
  for (let i = 0; i < 16; i++) {                 // loose leaves over the mound
    const a = rng() * TAU, r = R * (0.20 + rng() * 0.85);
    leafBlade(b, Math.cos(a) * r, 0.012 + rng() * 0.055, Math.sin(a) * r,
              rng() * TAU, 0.115 + rng() * 0.115, 0.050 + rng() * 0.030,
              0.72 + rng() * 0.58, rng() < 0.5 ? 1.0 : 0.30, 0.9, 0.60);
  }
  return b.finish(0.34);
}

/** Fallen log — the cheapest thing there is that makes a forest look inhabited. */
function buildLog(rng) {
  const b = new Builder();
  const len = 2.6 + rng() * 3.4;
  const r0 = 0.16 + rng() * 0.13;
  const r1 = r0 * (0.58 + rng() * 0.25);
  const sag = 0.05 + rng() * 0.09;
  const bend = (rng() - 0.5) * 0.5;
  const path = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    path.push({
      x: t * len,
      y: r0 * 0.85 + Math.sin(t * Math.PI) * sag,
      z: Math.sin(t * Math.PI) * bend,
      r: lerp(r0, r1, t) * (0.9 + rng() * 0.2),
    });
  }
  tube(b, path, 6, 0.0, 0.05);
  for (let i = 0; i < 2; i++) {                   // snapped-off limb stubs
    const t = 0.25 + rng() * 0.5;
    const px = t * len, py = r0 * 0.9, pz = Math.sin(t * Math.PI) * bend;
    const a = rng() * TAU;
    tube(b, [
      { x: px, y: py, z: pz, r: r0 * 0.30 },
      { x: px + Math.cos(a) * 0.5, y: py + 0.22 + rng() * 0.3, z: pz + Math.sin(a) * 0.5, r: r0 * 0.14 },
    ], 4, 0.0, 0.05);
  }
  for (let i = 0; i < 2; i++) {                   // moss riding the top
    const t = 0.15 + rng() * 0.7;
    lobe(b, t * len, r0 * 1.45, Math.sin(t * Math.PI) * bend + (rng() - 0.5) * r0,
         r0 * (0.7 + rng() * 0.5), r0 * 0.30, r0 * (0.7 + rng() * 0.5), 0, rng,
         { chan: 1.0, trans: 0.3, ragged: 0.40, lift: 0.9, ao: 0.95 });
  }
  return b.finish(r0 * 2.4);
}

/** Broken stump with root flares — reads as history, not as a cylinder. */
function buildStump(rng) {
  const b = new Builder();
  const h = 0.42 + rng() * 0.55;
  const r = 0.22 + rng() * 0.18;
  tube(b, [
    { x: 0, y: 0, z: 0, r: r * 1.35 },
    { x: 0, y: h * 0.35, z: 0, r: r },
    { x: 0, y: h, z: 0, r: r * (0.78 + rng() * 0.2) },
  ], 6, 0.0, 0.05);
  const flares = 3 + ((rng() * 2) | 0);
  for (let i = 0; i < flares; i++) {
    const a = (i / flares) * TAU + rng() * 0.6;
    tube(b, [
      { x: 0, y: h * 0.10, z: 0, r: r * 0.42 },
      { x: Math.cos(a) * r * (1.6 + rng()), y: 0.03, z: Math.sin(a) * r * (1.6 + rng()), r: r * 0.16 },
    ], 4, 0.0, 0.05);
  }
  lobe(b, (rng() - 0.5) * r, h * 0.98, (rng() - 0.5) * r, r * 0.7, r * 0.22, r * 0.7, 0, rng,
       { chan: 1.0, trans: 0.3, ragged: 0.45, lift: 0.9, ao: 0.95 });
  // Moss and needle litter banked against the root flares. A stump is a
  // cylinder pushed into a hillside without this, and the join gives it away.
  skirt(b, r * 2.4, rng, 4, 0.85);
  return b.finish(h);
}

// ── the ground substrate ─────────────────────────────────────────────────────
//
//  These three exist to answer one measured defect: two thirds of the 2 m road
//  close-up and 40% of `vehicle` were a smooth, untextured orange slab — the
//  brief's named anti-pattern, in the exact place the player spends the whole
//  game looking. Nothing else in the build can fix it. The terrain can only
//  ever paint that slab a different colour, and grass grows in tufts with bare
//  ground between them by construction. What was missing is *objects at the
//  5-30 cm scale*, and they have to be wherever the player can see the ground,
//  not only where a canopy or a river says they may be.
//
//  All three are deliberately cheap (14-40 triangles) and carry short
//  visibility radii, because they only ever pay for themselves within about
//  50 m and there will be thousands of them inside that.

/**
 * A small stone cluster. The strongest of the three, because it breaks the
 * slab on *two* axes at once: stones are lighter in value than the shaded
 * substrate and — per the brief's rock anchors, lavender-grey and never
 * brown-grey — they are the one cool note allowed at ground level in a frame
 * that is otherwise 95% red-orange. Heavily jittered so no two facets are
 * parallel and the cluster reads as chipped rather than as dice.
 */
function buildPebble(rng, variant) {
  const b = new Builder();
  // Three tiers, not two, and they are separated by a factor of four rather
  // than the previous 1.6. The critic measured the old scatter as "a uniform
  // grade with every stone within ±30% of the same size" — the brief's named
  // anti-pattern — and two variants that overlap in size cannot fix that
  // however they are weighted. Grit reads as ground texture, stones as
  // objects, cobbles as landmarks at the 30 cm scale, and the scatter picks
  // between them on a power law so cobbles stay rare.
  //
  // The ceiling still matters: an earlier pass reached 0.34 m before instance
  // scale and dotted the meadow with metre-wide wedges. Those are boulders and
  // they belong to the rocks system.
  const big = variant === 1;
  const n = big ? 2 + ((rng() * 2) | 0) : 3 + ((rng() * 3) | 0);
  const R = big ? 0.078 + rng() * 0.062 : 0.032 + rng() * 0.034;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, r = R * (0.4 + rng() * 1.5);
    // Members of a cluster vary among themselves too, so even one site is a
    // bigger stone with two chips beside it rather than three equal dice.
    const s = R * (0.32 + rng() * rng() * 1.10);
    lobe(b, Math.cos(a) * r, s * (0.30 + rng() * 0.22), Math.sin(a) * r,
         s, s * (0.40 + rng() * 0.30), s * (0.70 + rng() * 0.50), 0, rng,
         { chan: 0.30 + rng() * 0.65, trans: 0.0, ragged: 0.44,
           facet: true, facetLift: 0.22,
           ao: 0.80 + rng() * 0.20, sway: 0 });
  }
  return b.finish(R);
}

/**
 * The top rung of the stone ladder — a 20-45 cm cobble with a chip or two
 * beside it.
 *
 * Its own archetype rather than a third `pebble` variant, and the reason is the
 * visibility radius. Density is cap / π·vis², so grit that has to be thick
 * underfoot wants a short radius; but a short radius on the *large* stones is
 * what left the river bank measuring as half a frame of bare clay, because
 * every stone on it had already shrunk away by the time the bank was in view.
 * Splitting them lets the big ones carry two and a half times the radius on a
 * third of the count — which is also simply what a size hierarchy is: big
 * things visible from far off, small things only close up.
 */
function buildCobble(rng, variant) {
  const b = new Builder();
  const R = (variant === 1 ? 0.235 : 0.155) + rng() * 0.110;
  const n = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = i === 0 ? 0 : R * (0.6 + rng() * 1.2);
    const s = i === 0 ? R * (0.80 + rng() * 0.35) : R * (0.18 + rng() * 0.34);
    lobe(b, Math.cos(a) * r, s * (0.26 + rng() * 0.20), Math.sin(a) * r,
         s, s * (0.44 + rng() * 0.30), s * (0.70 + rng() * 0.48),
         i === 0 ? 1 : 0, rng,
         { chan: 0.28 + rng() * 0.66, trans: 0.0,
           // Blockier than the grit. A cobble carrying the small stones' 0.44
           // jitter comes out as a smooth pebble the size of a football, which
           // reads as dough; a chipped stone wants flatter, harder facets.
           //
           // "Wants flatter, harder facets" was written and then not delivered:
           // the lobe still shared its vertex normals, so the eight plates
           // smoothed into two gradients and a half-metre stone in `meadow`
           // came out as a lavender tarpaulin. `facet` is the missing half.
           ragged: 0.30, facet: true, facetLift: 0.16,
           ao: 0.78 + rng() * 0.22, sway: 0 });
  }
  return b.finish(R);
}

/**
 * Fallen leaves lying flat. Deliberately *not* the scalloped disc `leafDrift`
 * uses — a disc is fine at 30 m and gives itself away as a painted decal the
 * moment you walk up to it, and this is the layer the player is closest to.
 * Individual blades at random yaws survive the walk-up.
 */
function buildLeafScatter(rng, variant) {
  const b = new Builder();
  // Denser and tighter than before. Six leaves spread over a 48 cm radius is
  // six separate marks, and at 2 m on a flat gold track that is what they read
  // as — isolated chips, the loudest thing in the frame at a fortieth of the
  // instance count. The same triangles gathered into a 20-30 cm patch read as
  // one small drift, which is what the plates paint and what the clump logic
  // upstream is already trying to build.
  const n = variant === 1 ? 10 + ((rng() * 6) | 0) : 13 + ((rng() * 8) | 0);
  const R = 0.15 + rng() * 0.19;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, r = R * Math.sqrt(rng());
    // tilt ≈ 0.67 is where `leafBlade` lays the blade flat with its normal
    // still pointing up; the spread either side of that gives one leaf in a
    // patch a different share of the key light than its neighbour, which is
    // what stops the patch reading as one tone.
    leafBlade(b, Math.cos(a) * r, 0.006 + rng() * 0.024, Math.sin(a) * r,
              rng() * TAU, 0.058 + rng() * 0.060, 0.024 + rng() * 0.018,
              0.56 + rng() * 0.30, rng() < 0.28 ? 1.0 : 0.12, 0.85);
  }
  return b.finish(0.10);
}

/**
 * Collapsed dry stalks — the straw mat that lies between standing grass tufts
 * in a late-season meadow. Laid over rather than upright, so it never competes
 * with the grass system's silhouette; its job is value texture inside the gold
 * family, where a stone would be too strong a note.
 */
function buildDeadTuft(rng, variant) {
  if (variant === 1) return buildThatchMound(rng);
  const b = new Builder();
  const n = 17 + ((rng() * 7) | 0);
  const R = 0.20 + rng() * 0.22;

  // REBUILT — this was the starburst. Spreading the origins along the radius
  // was not enough, because the *yaw* still came from the same angular sweep:
  // every strand pointed away from the centre, so the mat still resolved to
  // eight strips radiating from a point, and because `len` was a flat
  // 0.42-0.86 R they were all near enough the same length. Three of those per
  // frame, at one height, is a drawn asterisk — "scratches on the lens".
  //
  // Weather does not lay straw radially. It lays it *down*, all one way, in
  // overlapping courses. So there is now a single lay direction per instance
  // with a modest spread about it, the patch is elongated along that direction
  // rather than circular, and length is drawn from a squared curve so most
  // strands are stubs and one or two run right across — a size hierarchy
  // inside a single 20-triangle prop.
  const lay = rng() * TAU;
  const cl = Math.cos(lay), sl = Math.sin(lay);
  for (let i = 0; i < n; i++) {
    const u = (rng() - 0.5) * R * 1.5, v = (rng() - 0.5) * R * 0.8;
    frond(b, {
      x: cl * u - sl * v, y: 0.004 + rng() * 0.030, z: sl * u + cl * v,
      yaw: lay + (rng() - 0.5) * 1.5,
      // Past vertical: the strand lies over and its far end settles slightly
      // *into* the ground, which is what a flattened stem actually does and
      // what stops the mat reading as a decal floating on the surface.
      tilt: 1.34 + rng() * 0.30,
      // Narrow. At 0.012-0.031 the serrated base ring came out 16 cm wide
      // after instance scale, and a 16 cm wide flat strip is a wood chip.
      // SHORTENED, and this is the defect the 2 m road frame led with. The
      // width was fixed last round; the *length* was not, and `R * 1.21` at an
      // instance scale of up to 1.95 put 1.3 m strands on open ground. A 1.3 m
      // strand two centimetres wide is not straw, it is a lath — and the frame
      // showed a dozen of them lying at angles across the track like dropped
      // timber. The mat needs to be many short pieces, because what it is for
      // is *texture*: one long piece is an object, twenty short ones are a
      // surface. Same triangle order, spent on count instead of reach.
      // Wider, now that they are short. The width was cut to stop a 1.3 m
      // strand reading as a wood chip; with the length fixed the constraint
      // goes the other way — at 1.5-3.5 cm across, twenty strands cover about
      // a fifth of the patch they sit in and the mat reads as a handful of
      // scratches rather than as ground. Three to eight centimetres on a
      // 10-35 cm strand is a flattened stem, and it closes the mat up.
      len: R * (0.20 + 0.58 * rng() * rng()), w: 0.011 + rng() * 0.013,
      segs: 1, droop: 0.10, taper: 0.60,
      chanA: 0.05, chanB: 1.0,
      aoA: 0.52 + rng() * 0.34, aoB: 0.95, swayA: 0.05, trans: 0.8,
    });
  }
  return b.finish(0.12);
}

/**
 * A thatch mound — matted dead grass with real relief, and the answer to the
 * one blocker that has now survived three critic passes.
 *
 * The arithmetic that motivated it. At the 2 m road anchor this layer places
 * about 5,700 substrate instances inside their own visibility radii, which is
 * 2.7 per square metre — a number that sounds like plenty and measures as 8%
 * of the ground covered, because every one of them is a 20-40 cm patch of
 * 1-3 cm strands and a handful of 4 cm stones. The critic's reading of that
 * frame ("a smooth flat orange-tan slab with only low-frequency blotching") is
 * simply what 8% coverage looks like. Raising the count is the obvious move
 * and it is the wrong one: the whole scene is at 4.14-4.29 M triangles against
 * a 4.5 M cap, and this layer has no headroom to buy area by the instance.
 *
 * So buy it by the triangle instead. Eight triangles of squashed lobe cover
 * about a third of a square metre; eight triangles of straw strand cover four
 * hundredths of one. This is an order of magnitude the cheapest area in the
 * file, and it is also the more honest form: what lies between grass tufts in
 * a late-season meadow is *matted* — a low swell of collapsed thatch, not a
 * scatter of loose stalks on bare clay.
 *
 * The failure mode to avoid is the one `leafDrift` was rebuilt for: a flat
 * disc with every normal up is a decal, and a decal a value-step below the
 * ground it sits on reads as a hole. Two things keep this off that: the lobes
 * have real height so their tops turn through the key light while their flanks
 * do not, and the palette pair sits a *half* step under the meadow gold rather
 * than a whole one, so a mound is a change of texture rather than a stain.
 */
function buildThatchMound(rng) {
  const b = new Builder();
  // FIRST ATTEMPT WAS TWICE THIS AND IT FAILED THE SAME WAY EVERY BIG LOBE IN
  // THIS FILE HAS. At R up to 0.64 with lobes at 0.42-0.72 R, one lobe was 0.9 m
  // across before the instance scale, and the 2 m frame came back with a pair of
  // two-metre flat olive polygons on the sand — the decal `leafDrift` had been
  // rebuilt to stop being. The rule the file keeps relearning applies to ground
  // props too: the facet has to be the size of the mark. A mound is five lumps
  // the size of a fist, not one lump the size of a doormat.
  // Sized in metres rather than as a fraction of anything, because what this
  // form is competing against is a *coverage* number and coverage is absolute.
  //
  // The second attempt was five fist-sized lumps in a 50 cm patch: correct as a
  // shape, and it moved the measured ground coverage at the 2 m anchor by about
  // two points, because 62 triangles were buying 0.16 m2. Area per triangle is
  // the whole game here and it is worth writing down: one squashed lobe 25 cm
  // across covers 0.15 m2 for eight triangles; five lobes 10 cm across, spread
  // to the same footprint, cover a third of that for five times the cost. The
  // small-lump version is the better *object* and the worse *ground*, and this
  // layer is not trying to make objects.
  //
  // So: three lobes at the size of a dinner plate, not five at the size of a
  // fist — and the guard against the flat-slab failure is no longer smallness
  // but value. A swell the player reads as ground can be broad; it must not be
  // a *stain*, which is what the first attempt's dark olive over bright sand
  // was. Hence the palette pair lifted, `chan` biased to the pale end, and the
  // lobes given real height so the key light finds a flank.
  // THIRD SIZE, and this one is settled by the distance the frame is taken at
  // rather than by the coverage sum. Three dinner-plate lobes do buy the area —
  // at 8-25 m the mid-ground of `close-road-2m` came back reading exactly as
  // intended, low gold swells with a lit top and a shaded flank. At 2 m the
  // same prop is a 1.2 m flat olive slab with a straight edge, because *every*
  // half-metre facet is enormous two metres from the camera.
  //
  // So the size is set by the near frame and the coverage is bought back by
  // instance count instead, which the shrub caps have just freed the triangles
  // for. Four lobes the size of a grapefruit: still four times the area per
  // triangle of the strand mat, and nothing in it is bigger than a tussock.
  const R = 0.26 + rng() * 0.14;
  const n = 4;
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rng() * 0.9;
    const r = R * (0.12 + rng() * 0.46);
    const s = R * (0.36 + rng() * 0.20);
    lobe(b, Math.cos(a) * r, 0.008 + rng() * 0.022, Math.sin(a) * r,
         s, R * (0.13 + rng() * 0.14), s * (0.74 + rng() * 0.46), 0, rng,
         // Ragged hard, because the one thing a ground mound must not have is a
         // clean elliptical outline — that is what gives a decal away.
         //
         // `lift` moderate, and that is the opposite of the shrub crowns on
         // purpose. A crown is a small round mark and wants its eight faces to
         // shade alike; a mound is a swell in the ground and its whole job is to
         // *turn through the key light* — to have a lit flank and a shaded one
         // where the painted albedo blotch underneath has neither. Lifted to
         // 0.80 the first attempt gave every face the same near-vertical normal,
         // which is exactly how it managed to be a flat slab.
         { chan: 0.46 + rng() * 0.54, trans: 0.30, ragged: 0.56, lift: 0.44,
           ao: 0.84 + rng() * 0.16, sway: 0.02 });
  }
  // A dozen strands lying over the swell in one weather direction, exactly as
  // in the flat variant. They are what stops the mound reading as a pebble the
  // size of a dinner plate: without a fibre direction on it, a low gold lump is
  // just a stone in the wrong colour. Short — the first attempt's `0.76 R` at an
  // instance scale of 1.75 put 85 cm strands out of a 60 cm mound, which read as
  // a stick lying across it.
  const lay = rng() * TAU;
  const cl = Math.cos(lay), sl = Math.sin(lay);
  for (let i = 0; i < 8; i++) {
    const u = (rng() - 0.5) * R * 1.5, v = (rng() - 0.5) * R * 0.9;
    frond(b, {
      x: cl * u - sl * v, y: 0.022 + rng() * 0.045, z: sl * u + cl * v,
      yaw: lay + (rng() - 0.5) * 1.6,
      tilt: 1.30 + rng() * 0.32,
      len: R * (0.18 + 0.34 * rng() * rng()), w: 0.009 + rng() * 0.012,
      segs: 1, droop: 0.10, taper: 0.60,
      chanA: 0.35, chanB: 1.0,
      aoA: 0.78 + rng() * 0.22, aoB: 1.0, swayA: 0.06, trans: 0.8,
    });
  }
  return b.finish(0.14);
}

/**
 * A GROUND MAT — a broad, low, ragged swathe of matted growth, and the answer
 * to critic blocker 5 ("bare substrate ... an entire hillside is bare brown").
 *
 * The mechanism the previous four rounds missed is a *range* problem, not a
 * density one. Every prop in the substrate tier — grit, litter, straw, thatch —
 * carries a visibility radius of 22-24 m, and `_layerGround` only runs in
 * band-0 cells, i.e. inside 50 m. So beyond about 24 metres the game has no
 * ground dressing at all, and whatever the terrain albedo happens to be is the
 * whole picture. That is exactly what `review/045`'s RIVER tile is: a hillside
 * between 20 and 120 m out, with a fine dusting of thatch along its near edge
 * and nothing whatever past it.
 *
 * Raising the substrate caps cannot reach that. A 30 cm thatch mound at 80 m is
 * two pixels; ten thousand of them would cost 400,000 triangles and still read
 * as noise. What covers ground at 80 m is something the size of a car.
 *
 * Area per triangle is the number this form spends on — but it is bounded, and
 * five rounds of this file were spent discovering the bound the hard way by
 * buying footprint the terrain would not let it place. See the deviation table
 * inside `buildGroundMat`. A mat is planar; the ground is not; past about a
 * metre of radius the ground moves further through the mat than the mat is
 * thick, and what renders is not a swathe, it is the handful of fragments that
 * happened to surface.
 *
 * Three things keep it from being the flat decal every previous attempt at
 * broad ground cover collapsed into:
 *
 *  · it CONFORMS. `COVER_ARCHETYPES.conform` takes the instance to the full
 *    terrain tilt rather than the 55% every other archetype uses, so a mat lies
 *    *on* a slope instead of burying one edge and flying the other. That fixes
 *    the tilt; it does nothing about the curvature, which is what the radius
 *    and the buried rim are for.
 *  · it has VERTICAL TOLERANCE. The pad's rim and the strands' bases both sit
 *    well below the plane the instance is placed on, so terrain that rises
 *    through the mat buries part of it — invisible — instead of leaving the
 *    rest of it hanging in the air, which is what a viewer reads as a
 *    rendering error rather than as ground.
 *  · every mark in it is under the legibility threshold at the range it is
 *    drawn at. The reference plates never show a single identifiable leaf on
 *    the ground at 40 m; they show a mass. Individually legible is the enemy,
 *    and it is a property of contrast and size together, not of size alone.
 *
 * And it fades *in* with distance as well as out — see `nearFade` in
 * `shaders/cover_material.js`. Up close the fine substrate is the right answer
 * and a metre-wide pad is a slab; this form exists for the 15-90 m band where
 * nothing else in the game is doing anything at all.
 */
/**
 * A ragged ground pad: a very low dome whose rim is driven under the surface.
 *
 * This is what replaced the disc of squashed lobes, and the reason is measured
 * rather than felt — see the note on `buildGroundMat`.
 *
 * The rim ring sits at a large NEGATIVE y, a quarter to a half a metre below
 * the pad's own plane, and that tolerance is the whole point of the form.
 * Where the ground inside the footprint rises above the plane the pad simply
 * intersects it and what shows is a soft closed blob; where it falls away, the
 * rim is still under the surface, so there is never an under-edge to read as
 * an object lying on the hill. A flat disc has no such tolerance: on this
 * terrain it is either buried or floating, and it is floating half the time.
 *
 * Normals are held within 9 degrees of vertical on the top rings, so every
 * facet answers the key light the way the ground beside it does. That is what
 * lets the pad be built out of a few large triangles without reading as
 * plates: the facets are big, but they all shade alike, so the eye reads one
 * mass. Variation comes from the colour channel instead, which costs nothing.
 */
function groundPad(b, R, rng, o = {}) {
  const sect = o.sect ?? 8;
  const crest = o.crest ?? 0.05;
  const cx = o.x ?? 0, cy = o.y ?? 0, cz = o.z ?? 0;
  // Ring radius as a fraction of R, and the ring's height above the plane. The
  // last ring is the buried rim; its drop grows with the footprint, because so
  // does the amount of terrain the pad has to span.
  const rings = o.rings === 3
    ? [{ f: 0.46, y: crest * 0.72 }, { f: 0.86, y: crest * 0.04 },
       { f: 1.00, y: -(0.11 + R * 0.34) }]
    : [{ f: 0.62, y: crest * 0.40 }, { f: 1.00, y: -(0.11 + R * 0.34) }];
  const chan = o.chan ?? 0.12, chanVar = o.chanVar ?? 0.30;
  const aoTop = o.ao ?? 0.94;
  const a0 = rng() * TAU;
  const c = b.vert(cx, cy + crest, cz, 0, 1, 0, chan + rng() * chanVar, aoTop, 0.02, 0.5);
  const ring = [];
  for (let j = 0; j < rings.length; j++) {
    const last = j === rings.length - 1;
    const row = [];
    for (let i = 0; i < sect; i++) {
      const a = a0 + (i / sect) * TAU + (rng() - 0.5) * 0.30;
      // Ragged outline. At 40 m the silhouette is the only part of a pad the
      // eye can read, so the jitter goes on the radius and not on the height —
      // a rippled height profile just breaks the flat mass into facets again.
      const rr = R * rings[j].f * (0.70 + rng() * 0.56);
      const y = cy + rings[j].y + (last ? 0 : (rng() - 0.5) * 0.026);
      const ux = Math.cos(a), uz = Math.sin(a);
      const out = last ? 0.42 : 0.15;
      const nl = Math.hypot(ux * out, 1, uz * out);
      row.push(b.vert(cx + ux * rr, y, cz + uz * rr,
                      ux * out / nl, 1 / nl, uz * out / nl,
                      chan + rng() * chanVar,
                      last ? 0.56 : aoTop - j * 0.06,
                      0.02 + j * 0.02, 0.5));
    }
    ring.push(row);
  }
  // Wound so the geometric normal comes out +Y. In a right-handed frame with Y
  // up, a fan that advances with DECREASING angle faces the sky; advancing the
  // other way stores an up normal on a down-facing triangle, which is the
  // unlit-from-both-sides defect this file has now hit five times.
  // `tools/winding.mjs` is the check that this is right.
  for (let i = 0; i < sect; i++) {
    const n = (i + 1) % sect;
    b.tri(c, ring[0][n], ring[0][i]);
    for (let j = 1; j < ring.length; j++) {
      b.quad(ring[j - 1][n], ring[j][n], ring[j][i], ring[j - 1][i]);
    }
  }
}

function buildGroundMat(rng, variant) {
  const b = new Builder();
  const broad = variant === 1;
  // FOOTPRINT, and this is the number the previous five rounds got wrong.
  //
  // A mat is a planar object: the instance is placed on one tangent plane
  // sampled at its centre, and every vertex in it is fixed relative to that
  // plane. So the honest maximum radius is set by how far the ground departs
  // from that plane, and on the hillside this form exists for that was never
  // measured. It is now (400 sites, slope > 0.5, deviation of `getHeight` from
  // the centre tangent plane, worst of 8 directions):
  //
  //     r = 0.5 m   p50 0.05   p90 0.09
  //     r = 1.0 m   p50 0.11   p90 0.21
  //     r = 1.5 m   p50 0.24   p90 0.46
  //     r = 2.5 m   p50 0.57   p90 1.18
  //
  // The form's entire relief was 0.13 m. At the old 2.0-3.05 m radius the
  // ground moved half a metre to a metre and a half through the mat, so most
  // of every mat was underground and the fragments that surfaced were whatever
  // happened to poke out — isolated, hard-edged, at arbitrary angles. Verified
  // directly: `tools/_scratch/cover/matwhy2.mjs` renders the mats raised 0.6 m
  // clear of the ground, and the same hillside goes from a scatter of loose
  // chips to a dense field. Nothing was wrong with the density. The layer was
  // being eaten.
  //
  // So the radius comes back to where the plane approximation survives, and
  // the reach that costs is bought back in `_layerMat`'s drift count, which is
  // nearly free because it only runs on sites that already passed `_ground`.
  //
  // The pads inside it carry a buried rim whose drop scales with their own
  // radius (`0.11 + 0.34 R`), so a 0.9 m pad tolerates 0.4 m of terrain
  // deviation against a measured p90 of 0.18 m at that radius — comfortably
  // inside. That tolerance is what lets the footprint come back up from the
  // first pass at this: the constraint is not the mat's overall size, it is the
  // size of any single planar mark inside it.
  const R = broad ? 1.55 + rng() * 0.60 : 0.56 + rng() * 0.28;

  // The pads: SEVERAL SMALL ONES, OVERLAPPING, not one big one.
  //
  // A single pad the size of the mat was the first thing tried here and the
  // capture is `shots/cover/b1-river.png`: pale hexagons lying on the hill,
  // legible one at a time from thirty metres. A polygon reads as a polygon
  // however ragged its radius jitter is, because at eight or ten sectors the
  // straight chords between the jittered points are longer than the jitter.
  //
  // Three or four discs of a third the radius, overlapping each other, have a
  // union outline that is not a polygon at all — it is a lobed blob with
  // re-entrant corners, which is what a patch of matted growth looks like from
  // any distance. It is also the cheaper shape: two rings each instead of
  // three, so four small pads cost less than one big one did.
  const pads = broad ? 3 + ((rng() * 2) | 0) : 2;
  for (let pI = 0; pI < pads; pI++) {
    const pa = rng() * TAU, pr = pI === 0 ? 0 : R * 0.52 * Math.sqrt(rng());
    groundPad(b, R * (broad ? 0.40 + rng() * 0.22 : 0.46 + rng() * 0.20), rng, {
      x: Math.cos(pa) * pr, z: Math.sin(pa) * pr,
      // Staggered vertically as well as laterally, so the group is a rumpled
      // drift rather than a plateau with a lobed edge.
      y: (rng() - 0.5) * 0.05,
      sect: broad ? 8 : 7,
      crest: 0.04 + rng() * 0.03,
      // DEEP half of the palette pair. The pad is ground colour — it is there
      // to lift the substrate's value and hue, not to be seen. Everything the
      // eye is meant to catch is in the strands over it, whose silhouettes are
      // thin and overlapping and therefore cannot read as objects. At the pale
      // end of the pair a pad is a decal on the hillside, which is the whole
      // complaint against this layer.
      chan: 0.02 + rng() * 0.16, chanVar: 0.22 + rng() * 0.16,
      // Near the top of the range — a mat is open ground, not the buried
      // interior of a clump, and darkening it is how the previous broad forms
      // turned into stains.
      ao: 0.88 + rng() * 0.12,
    });
  }

  // The strands, and they START BELOW THE SURFACE.
  //
  // `y0` is drawn from a band running from 23 cm under the pad's plane to two
  // centimetres over it, weighted toward the bottom, and that band is what
  // makes the form tolerant of the deviation table above. Wherever the ground
  // sits inside the footprint, some course of strands is emerging from it and
  // the rest are buried — and burial is invisible, where floating is the
  // defect. A population spread through a vertical band degrades into less
  // cover; a population at one height degrades into cards hanging in the air.
  //
  // They are also wider and shorter than the strands they replace. Coverage
  // per triangle is the only thing this form is spending on, a strand is two
  // triangles whatever its size, and a 9 cm blade at 40 m is three pixels —
  // under the legibility threshold, which is where every mark in this layer
  // needs to be. What the reference plates never show at this range is a
  // single identifiable leaf.
  const courses = broad ? 3 : 2;
  const perCourse = broad ? 24 : 12;
  const lay0 = rng() * TAU;
  for (let c = 0; c < courses; c++) {
    const lay = lay0 + c * (1.9 + rng() * 0.9);
    const cl = Math.cos(lay), sl = Math.sin(lay);
    for (let i = 0; i < perCourse; i++) {
      // Elongated along the lay direction, so a course is a swept band rather
      // than a disc of strands that happen to point the same way. Kept inside
      // the pad group rather than spread over the whole footprint: strands
      // scattered wider than the mass they belong to are just isolated marks
      // on bare ground, which is the defect, and strands ON the pads are what
      // breaks their outline.
      const u = (rng() - 0.5) * R * 1.20, v = (rng() - 0.5) * R * 0.86;
      const t = rng();
      frond(b, {
        x: cl * u - sl * v, y: 0.03 - 0.26 * Math.sqrt(rng()), z: sl * u + cl * v,
        yaw: lay + (rng() - 0.5) * 1.15,
        // Under a right angle, so the strand climbs out of the ground rather
        // than running parallel to it. Past vertical it would lie flat at
        // whatever height it started, which is the floating case again.
        tilt: 0.95 + rng() * 0.42,
        len: 0.17 + t * t * 0.30, w: 0.050 + rng() * 0.056,
        segs: 1, droop: 0.20, taper: 0.70,
        // Base in the deep half of the pair, tip in the lit half: a strand
        // that is one flat colour end to end is a painted stripe. The tip stops
        // short of the pale end of the pair now — at chanB 0.80-1.00 the tips
        // rendered within a few percent of `matDryLit`, which is a near-white
        // against ground that measures srgb(97,73,29) on this hillside, and a
        // near-white mark on dark brown is legible however small it is.
        chanA: 0.08 + rng() * 0.22, chanB: 0.50 + rng() * 0.34,
        aoA: 0.74, aoB: 0.98, swayA: 0.25, trans: 0.85,
      });
    }
  }
  return b.finish(0.30);
}

/**
 * Fallen deadwood — the sticks that fill the gaps between the logs.
 *
 * REBUILT. The old form was 0.9-2.2 m long at a single radius, dead straight
 * with one hard kink, floating at `y = r` with a second stick crossing it at a
 * right angle — and, because `tube` was wound inside out, rendered in
 * near-black. At 2 m it read as a broken plastic strut, not as wood.
 *
 * Two size tiers now, because a stick field where every stick is the same
 * length is a texture rather than litter; a real taper along the length; a
 * bowed profile so the middle rides over whatever it fell across; and one end
 * in three driven under the surface, which is what actually sells contact.
 */
function buildBranch(rng, variant) {
  const b = new Builder();
  const big = variant === 1;
  const len = big ? 0.70 + rng() * 0.62 : 0.30 + rng() * 0.42;
  // Thickened by about a fifth. At the previous radius a short stick on open
  // ground projected to a one-pixel dark line — the critic's "thin black twig
  // hairlines" in `drive` — which reads as a scratch on the frame rather than
  // as wood, and no amount of albedo fixes a line that thin.
  const r = (big ? 0.035 : 0.019) + rng() * 0.022;
  // Built *centred on the origin and sagging through it*: the middle rides a
  // little above the surface and both ends finish below y = 0.
  //
  // This is the correction to the first attempt, which modelled the stick from
  // one end outward. An instance only takes 55% of the terrain's tilt, so a
  // stick laid out along +x lifts its far end clear of the ground on any slope
  // at all — and a two-metre stick hanging in mid-air over the grass is a worse
  // defect than the black scratch it replaced. Centred, the same tilt error is
  // halved and lands on ends that were already buried. The length came down
  // with it: deadfall *litter* is under two metres, and anything longer is a
  // log, which is its own archetype and knows how to sit on a hillside.
  const dip = r * (1.3 + rng() * 1.6);
  const bow = r * (0.2 + rng() * 1.3);
  const bend = (rng() - 0.5) * len * 0.26;
  const yAt = (u) => (r + bow + dip) * (1 - 4 * u * u) - dip;
  const path = [];
  for (let i = 0; i <= 3; i++) {
    const u = i / 3 - 0.5;
    path.push({
      x: u * len,
      y: yAt(u),
      z: Math.sin((u + 0.5) * Math.PI) * bend + (rng() - 0.5) * r * 1.2,
      // Real taper along the length rather than a single radius: a stick of
      // constant thickness reads as a dowel.
      r: r * (0.55 + 0.85 * (0.5 - u)) * (0.85 + rng() * 0.3),
    });
  }
  tube(b, path, 4, 0.0, 0.05);
  const stubs = big ? 1 + ((rng() * 2) | 0) : (rng() < 0.4 ? 1 : 0);
  for (let i = 0; i < stubs; i++) {
    const u = -0.34 + rng() * 0.6;
    const px = u * len, py = yAt(u), pz = Math.sin((u + 0.5) * Math.PI) * bend;
    const a = rng() * TAU;
    const sl = len * (0.10 + rng() * 0.20);
    tube(b, [
      { x: px, y: py, z: pz, r: r * 0.42 },
      { x: px + Math.cos(a) * sl, y: py + sl * (0.08 + rng() * 0.40),
        z: pz + Math.sin(a) * sl, r: r * 0.15 },
    ], 3, 0.0, 0.05);
  }
  return b.finish(r * 4);
}

// ── the archetype table ──────────────────────────────────────────────────────
//
//  `band` is the streaming detail class: a cell only generates archetypes whose
//  band is at least the cell's current distance band, so a cell 250 m away
//  never pays to place ferns that could not be seen from there. It must always
//  be *coarser* than the archetype's own visibility radius or things pop in.
//
//  `vis` is the radius, in metres, at which an instance has finished shrinking
//  away. Small things get small radii — that single rule is most of the
//  triangle budget, and it is also the right art call: the far field should be
//  composed of the big shapes only.

//  `shadow` casts into the sun's shadow map. `recv` is **false everywhere**,
//  and that is a bug fix, not a style choice.
//
//  IT WAS NOT FALSE EVERYWHERE. `shrubDark`, `thicket`, `log` and `stump` were
//  carrying `recv: true` under this exact paragraph, and the note below —
//  written when the flag was turned off — was left describing a state the table
//  no longer had. The four that kept it are also the four with `shadow: true`,
//  which is the worst possible pairing: a form that writes itself into the
//  shadow map and then samples it is guaranteed to sit inside its own penumbra.
//
//  What that looked like is the critic's blocker 15. Zooming `meadow` on the
//  named pixels shows a shrub whose upper shoulder is a correct mid-green and
//  whose lower two thirds is a flat `#2a2d1e` hole with a hard, curved edge
//  between them — the outline of the plant's own shadow lying across itself,
//  not a lack of interior form. It was read as "no internal value range"
//  because the range that was there was one lit cap over one black body.
//
//  Turning it off costs something real and it is worth saying plainly: a bush
//  standing inside a tree's shadow band is now lit as though it were in the
//  sun. Against that, every one of them was previously black in full sunlight.
//  The trade only stops being right if the sun's `shadow.normalBias` is raised
//  (logged in docs/INTEGRATION_REQUESTS.md); until then, cast yes, receive no.
//
//  Every mesh in this layer used to do both, and the result was that shrubs,
//  logs, stumps and scrub rendered as flat, hueless, near-black silhouettes
//  with no normal response at all — the exact pathology the critic measured
//  across "rock, cliff, bush, understory and terrain". The cause is
//  self-shadowing: the shadow pass draws the same displaced geometry through
//  `customDepthMaterial`, the sun's shadow is 24 soft blur samples wide, and
//  there is not enough normal bias to keep a 20 cm form out of its own shadow.
//  Ground-hugging forms had it worse still, picking up the terrain's bias
//  envelope as well. Proof: forcing the log's albedo to white left it black
//  with receive on, and turning receive off restored a correctly lit, clearly
//  faceted cylinder at the palette value.
//
//  It is also, separately, where all this layer's frame time was going.
//  `tools/perf.mjs --seconds 45 --res 1536`, median frame time:
//
//      cover removed from the scene          15.4 ms
//      cover present, no shadows at all      14.9 ms   (the geometry is free)
//      cover present, cast only              15.8 ms   (+0.4)
//      cover present, cast and receive       27.9 ms   (+12.5)
//
//  Receiving is paid per fragment, and a scatter layer covers a large share of
//  the near field. Logged in docs/INTEGRATION_REQUESTS.md — if the sun's
//  `shadow.normalBias` is raised, foliage could receive again and a bush
//  standing inside a tree's shadow band would stop reading as lit.
//
//  `card` selects the double-sided material. Every archetype whose silhouette
//  is carried by strips wants it — a `fringe` spray is a one-sided quad, so on
//  a front-sided material roughly half of every bush's ragged edge was simply
//  not drawn, which is a large part of why the shrubs silhouetted as smooth
//  boxy blobs. The closed forms (stones, logs) stay front-sided.

export const COVER_ARCHETYPES = [
  { key: 'shrubDark',   variants: 3, card: true,  cap: 285, vis: 135, band: 3, recv: false, wind: 0.030, shadow: true,  build: buildShrubDark },
  { key: 'shrubBerry',  variants: 2, card: true,  cap: 112, vis: 145, band: 2, recv: false, wind: 0.032, shadow: false,  build: buildShrubBerry },
  { key: 'scrubDry',    variants: 3, card: true,  cap: 700, vis: 55,  band: 2, recv: false, wind: 0.075, shadow: false, build: buildScrubDry },
  { key: 'thicket',     variants: 2, card: true,  cap: 120, vis: 250, band: 3, recv: false, wind: 0.055, shadow: true,  build: buildThicket },
  { key: 'fern',        variants: 2, card: true,  cap: 950, vis: 44,  band: 1, recv: false, wind: 0.045, shadow: false, build: buildFern },
  { key: 'broadleaf',   variants: 2, card: true,  cap: 640, vis: 32,  band: 0, recv: false, wind: 0.030, shadow: false, build: buildBroadleaf },
  { key: 'moss',        variants: 2, card: true,  cap: 440, vis: 26,  band: 0, recv: false, wind: 0.000, shadow: false, build: buildMoss },
  { key: 'flowerAster', variants: 2, card: true,  cap: 220, vis: 42,  band: 0, recv: false, wind: 0.055, shadow: false, build: buildFlowerAster },
  { key: 'goldenrod',   variants: 1, card: true,  cap: 200, vis: 44,  band: 0, recv: false, wind: 0.065, shadow: false, build: buildGoldenrod },
  { key: 'seedHead',    variants: 1, card: true,  cap: 240, vis: 44,  band: 0, recv: false, wind: 0.085, shadow: false, build: buildSeedHead },
  { key: 'leafDrift',   variants: 2, card: true,  cap: 260, vis: 120, band: 2, recv: false, wind: 0.006, shadow: false, build: buildLeafDrift },
  { key: 'log',         variants: 2, card: false, cap: 90,  vis: 210, band: 3, recv: false, wind: 0.000, shadow: true,  build: buildLog },
  { key: 'stump',       variants: 1, card: false, cap: 90,  vis: 165, band: 3, recv: false, wind: 0.000, shadow: true,  build: buildStump },
  { key: 'branch',      variants: 2, card: false, cap: 300, vis: 50,  band: 1, recv: false, wind: 0.000, shadow: false, build: buildBranch },
  // The substrate tier. Caps raised hard and radii pulled in, and the two move
  // together on purpose: what the eye reads is *density*, which is cap over
  // π·vis², and the previous numbers bought 800 stones spread over 5000 m² —
  // 0.16 per square metre. That is why the 2 m close-up still showed a bare
  // clay slab with half a dozen objects on it after the substrate layer was
  // added. Shrinking the radius is nearly free (these are 20-60 triangle props
  // that contribute nothing past 30 m anyway) and it triples the density under
  // the player's nose for the same triangle count.
  //
  // Pulled in again, for the same reason and with the arithmetic stated so the
  // next author does not have to rediscover it. Coverage of the ground is
  // `cap * area-per-instance / (pi * vis^2)`, and only the last term is free.
  // Going from 26 m to 23 m on `deadTuft` is a 28% gain in what the player sees
  // underfoot at no triangle cost at all; going from 2400 to 2900 on the cap
  // would buy the same for 24,000 triangles in a frame that is running at
  // 4.33 M against a 4.5 M budget. Do the free one first, every time.
  //
  // What it costs is reach: the mat now finishes fading at 23 m instead of 26.
  // That is the right thing to spend, because past about 20 m the terrain's own
  // albedo is carrying the ground anyway and a 30 cm prop is three pixels.
  { key: 'pebble',      variants: 2, card: false, cap: 2150, vis: 24, band: 0, recv: false, wind: 0.000, shadow: false, build: buildPebble },
  { key: 'cobble',      variants: 2, card: false, cap: 1050, vis: 74, band: 2, recv: false, wind: 0.000, shadow: false, build: buildCobble },
  { key: 'leafScatter', variants: 2, card: true,  cap: 1450, vis: 22, band: 0, recv: false, wind: 0.004, shadow: false, build: buildLeafScatter },
  { key: 'deadTuft',    variants: 2, card: true,  cap: 2900, vis: 23, band: 0, recv: false, wind: 0.020, shadow: false, build: buildDeadTuft },
  // The mid-range ground dressing. `conform: 1` takes it to the full terrain
  // tilt (every other archetype leans only 55% with the ground, which is right
  // for a plant standing on a slope and wrong for a three-metre mat lying on
  // one), and `nearFade` keeps it out of the 2 m band where the fine substrate
  // is the better answer and a metre-wide lobe would be a slab. See
  // `buildGroundMat` for why the radius is 88 m rather than the substrate's 23.
  // Radius RAISED from 88 to 130, and this was the second half of why the
  // critic's hillside stayed bare after the placement gate was fixed. The
  // instance fade in `shaders/cover_material.js` shrinks a prop from `0.76*vis`
  // to `vis`, so at 88 the layer stopped drawing at 67 m and was gone by 88 —
  // a 35 m annulus — while the hillside it was written for runs from 20 to
  // 120 m. Measured at the `river` anchor: 330 mats in front of the camera, of
  // which 220 were outside the fade window and drawing at zero size. Cells are
  // generated for this layer at `band <= 1`, i.e. out to a nearest-corner
  // distance of 134 m, so 130 is the largest radius that is fully populated.
  { key: 'groundMat',   variants: 2, card: true,  cap: 1200, vis: 130, band: 2, recv: false, wind: 0.010, shadow: false, build: buildGroundMat, conform: 1.0, nearFade: true },
];

/** arch key -> index into COVER_ARCHETYPES, for the flat instance buffers. */
export const ARCH_INDEX = Object.fromEntries(COVER_ARCHETYPES.map((a, i) => [a.key, i]));

/** Grow every archetype variant once, deterministically. */
export function buildCoverLibrary(seed) {
  const out = [];
  let tris = 0;
  for (let ai = 0; ai < COVER_ARCHETYPES.length; ai++) {
    const arch = COVER_ARCHETYPES[ai];
    const geoms = [];
    for (let v = 0; v < arch.variants; v++) {
      // A dedicated stream per (archetype, variant) so adding a variant to one
      // archetype never reshuffles the shapes of another.
      const rng = mulberryLocal((seed ^ 0x9e37) + ai * 7919 + v * 104729);
      const g = arch.build(rng, v);
      g.name = `cover_${arch.key}_${v}`;
      tris += g.userData.tris;
      geoms.push(g);
    }
    out.push(geoms);
  }
  return { geoms: out, tris };
}

// Local copy so the library can be grown without importing the RNG into every
// builder signature; identical algorithm to MathUtils.mulberry32.
function mulberryLocal(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

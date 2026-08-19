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
  const lift = o.lift ?? 0.30;
  const chan = o.chan ?? 0;
  const trans = o.trans ?? 0.6;
  const base = b.p.length / 3;

  for (let i = 0; i < V.length; i++) {
    const d = V[i];
    const r = 1 + (rng() - 0.5) * 2 * ragged;
    const px = cx + d[0] * rx * r;
    const py = cy + d[1] * ry * r;
    const pz = cz + d[2] * rz * r;
    // Outward from the lobe centre, then bent toward the sky. A lobe lit this
    // way has one broad lit top and one broad shaded underside — two flat
    // masses — instead of a continuous sphere gradient.
    let nx = d[0], ny = d[1] + lift, nz = d[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    b.vert(px, py, pz, nx, ny, nz, chan, o.ao ?? -1, o.sway ?? -1, trans);
  }
  for (const f of F) b.tri(base + f[0], base + f[1], base + f[2]);
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
    if (s > 0) b.quad(pr, r, l, pl);
    pl = l; pr = r;
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
    const r = w * (0.25 + rng() * 0.24);
    const s = w * (0.10 + rng() * 0.09);
    lobe(b, Math.cos(a) * r, w * 0.03, Math.sin(a) * r,
         s, s * (0.55 + rng() * 0.35), s, 0, rng,
         { chan, trans: 0.22, ragged: 0.38, lift: 0.55, ao: 0.30, sway: 0.05 });
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
    frond(b, {
      x: Math.cos(a) * r, y: h * (0.12 + t * 0.80), z: Math.sin(a) * r,
      yaw: a + (rng() - 0.5) * 1.1,
      // Capped short of horizontal: a blade lying flat reads as a plank.
      tilt: (o.tilt ?? 0.30) + rng() * 0.62,
      len: w * len * (0.7 + rng() * 0.7),
      w: w * wide * (0.7 + rng() * 0.6),
      segs: 1, droop: 0.30, taper,
      chanA: chanBase, chanB: chanBase + 0.60,
      aoA: 0.60 + t * 0.30, aoB: 1.0, swayA: 0.45, trans: 1.0,
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
  const h = 1.00 + rng() * 0.66;
  const w = h * (1.02 + rng() * 0.46);            // decisively wider than tall

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
  const crowns = 5 + ((rng() * 2) | 0);
  for (let i = 0; i < crowns; i++) {
    const a = i * 2.39996 + rng() * 0.5;
    // Biased low: most of the mass is the broad body near the ground, and the
    // last one or two crowns ride up on the shoulder and break the top line.
    const rise = Math.pow(rng(), 0.75);
    const r = w * (0.05 + 0.26 * rise) * (0.70 + rng() * 0.60);
    const sz = w * (0.185 - 0.07 * rise) * (0.80 + rng() * 0.44);
    lobe(b, Math.cos(a) * r, h * (0.24 + 0.42 * rise), Math.sin(a) * r,
         sz, sz * (0.72 + rng() * 0.34) * (h / w), sz * (0.84 + rng() * 0.36),
         0, rng,
         { chan: 0.03 + rise * 0.50 + rng() * 0.16,
           trans: 0.34 + rise * 0.30, ragged: 0.44, lift: 0.08 + rise * 0.54 });
  }
  leafShell(b, h, w, 118, rng, 0.14, { len: 0.150, wide: 0.056, inset: 0.86 });
  skirt(b, w, rng, 6, 0.0);
  return b.finish(h);
}

/** Autumn berry bush: rust foliage with crimson accent lobes and berry knots. */
function buildShrubBerry(rng) {
  const b = new Builder();
  const h = 0.95 + rng() * 0.60;
  const w = h * (0.95 + rng() * 0.40);
  // Same clumped construction as `shrubDark`, for the same reason: a single
  // core plus a shell renders as one smooth dome with two flat facets, and at
  // 2 m the berry knots sitting on top of it read as pink diamonds stuck to a
  // ball. Fewer, slightly larger crowns than the dark shrub — an autumn berry
  // bush is rangier — and the colour turn runs by crown rather than by patch,
  // so a whole shoulder goes over to the accent at once.
  const crowns = 5 + ((rng() * 2) | 0);
  for (let i = 0; i < crowns; i++) {
    const a = i * 2.39996 + rng() * 0.6;
    const rise = Math.pow(rng(), 0.70);
    const rr = w * (0.05 + 0.26 * rise) * (0.70 + rng() * 0.60);
    const sz = w * (0.195 - 0.07 * rise) * (0.80 + rng() * 0.44);
    lobe(b, Math.cos(a) * rr, h * (0.24 + 0.46 * rise), Math.sin(a) * rr,
         sz, sz * (0.74 + rng() * 0.32) * (h / w), sz * (0.84 + rng() * 0.34),
         0, rng,
         { chan: rng() < 0.34 ? 0.55 + rng() * 0.30 : 0.05 + rise * 0.28,
           trans: 0.55 + rise * 0.35, ragged: 0.44, lift: 0.08 + rise * 0.52 });
  }
  leafShell(b, h, w, 72, rng, 0.08, { len: 0.150, wide: 0.056, inset: 0.86 });
  leafShell(b, h, w, 34, rng, 0.52, { len: 0.130, wide: 0.050, inset: 0.90 });
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
    // Only the first core is subdivided. There are several hundred of these on
    // a hillside and the second lobe is entirely inside the blade shell, so it
    // is buying value, not silhouette, and eight faces buy that just as well.
    lobe(b, Math.cos(a) * r, h * (0.28 + rng() * 0.12), Math.sin(a) * r,
         w * (0.30 + rng() * 0.12), h * (0.28 + rng() * 0.10), w * (0.28 + rng() * 0.12),
         i === 0 ? 1 : 0, rng,
         { chan: 0.0, trans: 0.55, ragged: 0.36, lift: 0.32 });
  }
  // Broad short blades, not sprays. The whole point of the rebuild is that a
  // long tapered strip seen flat-on is a pale oval; keeping them short and
  // near-parallel-sided keeps them reading as a bristly edge on a mass.
  leafShell(b, h, w, 54, rng, 0.30, { wide: 0.055, len: 0.19, tilt: 0.42, inset: 0.86 });
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
  const stems = 3 + ((rng() * 3) | 0);
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * TAU + rng() * 0.8;
    const r = w * 0.32 * rng();
    const top = h * (0.62 + rng() * 0.38);
    lobe(b, Math.cos(a) * r, top * 0.62, Math.sin(a) * r,
         w * (0.36 + rng() * 0.22), top * 0.40, w * (0.34 + rng() * 0.20),
         i === 0 ? 1 : 0, rng,
         { chan: rng() * 0.35, trans: 0.85, ragged: 0.40, lift: 0.36 });
  }
  leafShell(b, h, w, 78, rng, 0.30, { wide: 0.052, len: 0.155, inset: 0.88 });
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
  const n = 5 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.7;
    frond(b, {
      x: 0, y: h * 0.06, z: 0,
      yaw: a, tilt: 0.50 + rng() * 0.45,
      len: h * (1.15 + rng() * 0.55), w: h * (0.16 + rng() * 0.07),
      segs: 4, droop: 0.26 + rng() * 0.14, taper: 0.92,
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
  const n = 5 + ((rng() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rng() * 0.8;
    const r = R * (0.08 + rng() * 0.46);
    const s = R * (0.16 + rng() * 0.16);
    lobe(b, Math.cos(a) * r, 0.018 + rng() * 0.055, Math.sin(a) * r,
         s, 0.035 + rng() * 0.060, s * (0.80 + rng() * 0.45), i === 0 ? 1 : 0, rng,
         { chan: rng() < 0.38 ? 0.80 + rng() * 0.20 : 0.10 + rng() * 0.22,
           trans: 0.35, ragged: 0.48, lift: 0.50 + rng() * 0.30,
           ao: 0.68 + rng() * 0.32 });
  }
  for (let i = 0; i < 14; i++) {                 // loose leaves over the mound
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
         { chan: 0.30 + rng() * 0.65, trans: 0.0, ragged: 0.44, lift: 0.30,
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
           ragged: 0.28, lift: 0.22, ao: 0.78 + rng() * 0.22, sway: 0 });
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
  const n = variant === 1 ? 6 + ((rng() * 4) | 0) : 8 + ((rng() * 6) | 0);
  const R = 0.22 + rng() * 0.26;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, r = R * Math.sqrt(rng());
    // tilt ≈ 0.67 is where `leafBlade` lays the blade flat with its normal
    // still pointing up; the spread either side of that gives one leaf in a
    // patch a different share of the key light than its neighbour, which is
    // what stops the patch reading as one tone.
    leafBlade(b, Math.cos(a) * r, 0.006 + rng() * 0.024, Math.sin(a) * r,
              rng() * TAU, 0.058 + rng() * 0.060, 0.024 + rng() * 0.018,
              0.56 + rng() * 0.30, rng() < 0.45 ? 1.0 : 0.15, 0.85);
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
  const b = new Builder();
  const n = (variant === 1 ? 11 : 15) + ((rng() * 7) | 0);
  const R = 0.26 + rng() * 0.30;

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
      len: R * (0.16 + 1.05 * rng() * rng()), w: 0.007 + rng() * 0.011,
      segs: 1, droop: 0.10, taper: 0.60,
      chanA: 0.05, chanB: 1.0,
      aoA: 0.52 + rng() * 0.34, aoB: 0.95, swayA: 0.05, trans: 0.8,
    });
  }
  return b.finish(0.12);
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
  const len = big ? 0.85 + rng() * 0.95 : 0.34 + rng() * 0.52;
  const r = (big ? 0.030 : 0.015) + rng() * 0.019;
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
  { key: 'shrubDark',   variants: 3, card: true,  cap: 380, vis: 175, band: 3, recv: true , wind: 0.030, shadow: true,  build: buildShrubDark },
  { key: 'shrubBerry',  variants: 2, card: true,  cap: 130, vis: 155, band: 2, recv: false, wind: 0.032, shadow: false,  build: buildShrubBerry },
  { key: 'scrubDry',    variants: 3, card: true,  cap: 820, vis: 58,  band: 2, recv: false, wind: 0.075, shadow: false, build: buildScrubDry },
  { key: 'thicket',     variants: 2, card: true,  cap: 120, vis: 250, band: 3, recv: true , wind: 0.055, shadow: true,  build: buildThicket },
  { key: 'fern',        variants: 2, card: true,  cap: 620, vis: 54,  band: 1, recv: false, wind: 0.045, shadow: false, build: buildFern },
  { key: 'broadleaf',   variants: 2, card: true,  cap: 640, vis: 32,  band: 0, recv: false, wind: 0.030, shadow: false, build: buildBroadleaf },
  { key: 'moss',        variants: 2, card: true,  cap: 640, vis: 30,  band: 0, recv: false, wind: 0.000, shadow: false, build: buildMoss },
  { key: 'flowerAster', variants: 2, card: true,  cap: 220, vis: 42,  band: 0, recv: false, wind: 0.055, shadow: false, build: buildFlowerAster },
  { key: 'goldenrod',   variants: 1, card: true,  cap: 200, vis: 44,  band: 0, recv: false, wind: 0.065, shadow: false, build: buildGoldenrod },
  { key: 'seedHead',    variants: 1, card: true,  cap: 240, vis: 44,  band: 0, recv: false, wind: 0.085, shadow: false, build: buildSeedHead },
  { key: 'leafDrift',   variants: 2, card: true,  cap: 260, vis: 120, band: 2, recv: false, wind: 0.006, shadow: false, build: buildLeafDrift },
  { key: 'log',         variants: 2, card: false, cap: 90,  vis: 210, band: 3, recv: true , wind: 0.000, shadow: true,  build: buildLog },
  { key: 'stump',       variants: 1, card: false, cap: 90,  vis: 165, band: 3, recv: true , wind: 0.000, shadow: true,  build: buildStump },
  { key: 'branch',      variants: 2, card: false, cap: 420, vis: 54,  band: 1, recv: false, wind: 0.000, shadow: false, build: buildBranch },
  // The substrate tier. Caps raised hard and radii pulled in, and the two move
  // together on purpose: what the eye reads is *density*, which is cap over
  // π·vis², and the previous numbers bought 800 stones spread over 5000 m² —
  // 0.16 per square metre. That is why the 2 m close-up still showed a bare
  // clay slab with half a dozen objects on it after the substrate layer was
  // added. Shrinking the radius is nearly free (these are 20-60 triangle props
  // that contribute nothing past 30 m anyway) and it triples the density under
  // the player's nose for the same triangle count.
  { key: 'pebble',      variants: 2, card: false, cap: 2000, vis: 29, band: 0, recv: false, wind: 0.000, shadow: false, build: buildPebble },
  { key: 'cobble',      variants: 2, card: false, cap: 880,  vis: 74, band: 1, recv: false, wind: 0.000, shadow: false, build: buildCobble },
  { key: 'leafScatter', variants: 2, card: true,  cap: 1700, vis: 26, band: 0, recv: false, wind: 0.004, shadow: false, build: buildLeafScatter },
  { key: 'deadTuft',    variants: 2, card: true,  cap: 1700, vis: 26, band: 0, recv: false, wind: 0.020, shadow: false, build: buildDeadTuft },
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

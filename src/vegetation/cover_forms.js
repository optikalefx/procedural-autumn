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

// A little upward bias on strip normals — the same stylistic lift the lobes
// get, so a spray reads as a lit fan rather than as two flat-shaded faces.
const FROND_LIFT = 0.34;

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
    let nx = dirx * ca, ny = -sa + FROND_LIFT, nz = dirz * ca;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const l = b.vert(px + sx, py, pz + sz, nx, ny, nz, chan, ao, sway, o.trans ?? 0.9);
    const r = b.vert(px - sx, py, pz - sz, nx, ny, nz, chan, ao, sway, o.trans ?? 0.9);
    if (s > 0) b.quad(pl, l, r, pr);
    pl = l; pr = r;
    px += dirx * Math.sin(ang) * step;
    pz += dirz * Math.sin(ang) * step;
    py += Math.cos(ang) * step;
    ang = Math.min(2.35, ang + (o.droop ?? 0.18));
  }
  return { x: px, y: py, z: pz, yaw: o.yaw, ang };
}

/** A flat-ish leaf blade lying near the ground — the broadleaf undergrowth. */
function leafBlade(b, ox, oy, oz, yaw, len, wide, tilt, chan, trans) {
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const ny = Math.cos(tilt), nh = Math.sin(tilt);
  const tip = { x: ox + dx * len * Math.sin(tilt + 0.9), y: oy + len * Math.cos(tilt + 0.9) * 0.55, z: oz + dz * len * Math.sin(tilt + 0.9) };
  const midY = oy + len * 0.30 * Math.cos(tilt);
  const mx = ox + dx * len * 0.52, mz = oz + dz * len * 0.52;
  const px = -dz * wide, pz = dx * wide;
  const nrm = [dx * nh * 0.3, ny, dz * nh * 0.3];
  const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
  const a = b.vert(ox, oy, oz, nrm[0] / nl, nrm[1] / nl, nrm[2] / nl, chan * 0.2, 0.42, 0.1, trans);
  const l = b.vert(mx + px, midY, mz + pz, nrm[0] / nl, nrm[1] / nl, nrm[2] / nl, chan * 0.6, 0.85, 0.6, trans);
  const r = b.vert(mx - px, midY, mz - pz, nrm[0] / nl, nrm[1] / nl, nrm[2] / nl, chan * 0.6, 0.85, 0.6, trans);
  const t = b.vert(tip.x, tip.y, tip.z, nrm[0] / nl, nrm[1] / nl, nrm[2] / nl, chan, 1.0, 1.0, trans);
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
  for (let i = 1; i < rings.length; i++) {
    const A = rings[i - 1], B2 = rings[i];
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      b.quad(A[s], B2[s], B2[s2], A[s2]);
    }
  }
  if (capEnds) {
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
  const h = 1.50 + rng() * 0.90;
  const w = h * (0.74 + rng() * 0.34);            // wider than tall — not a tree
  lobe(b, 0, h * 0.44, 0, w * 0.62, h * 0.46, w * 0.58, 1, rng,
       { chan: 0.05, trans: 0.42, ragged: 0.30, lift: 0.40 });
  const n = 4 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.9;
    const r = w * (0.34 + rng() * 0.44);
    const s = w * (0.26 + rng() * 0.22);
    lobe(b, Math.cos(a) * r, h * (0.26 + rng() * 0.60), Math.sin(a) * r,
         s, s * (0.70 + rng() * 0.35), s, 0, rng,
         { chan: rng() * 0.30, trans: 0.72, ragged: 0.46, lift: 0.55 });
  }
  return b.finish(h);
}

/** Autumn berry bush: rust foliage with crimson accent lobes and berry knots. */
function buildShrubBerry(rng) {
  const b = new Builder();
  const h = 1.35 + rng() * 0.80;
  const w = h * (0.70 + rng() * 0.34);
  lobe(b, 0, h * 0.46, 0, w * 0.58, h * 0.48, w * 0.55, 1, rng,
       { chan: 0.12, trans: 0.80, ragged: 0.34, lift: 0.45 });
  const n = 4 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 1.0;
    const r = w * (0.36 + rng() * 0.42);
    const s = w * (0.24 + rng() * 0.22);
    // A couple of lobes ride high on the accent channel, so the bush turns
    // colour in patches the way a real one does, not uniformly.
    lobe(b, Math.cos(a) * r, h * (0.30 + rng() * 0.60), Math.sin(a) * r,
         s, s * 0.82, s, 0, rng,
         { chan: rng() < 0.45 ? 0.85 : 0.20, trans: 0.95, ragged: 0.44, lift: 0.55 });
  }
  for (let i = 0; i < 3; i++) {                    // berry knots, fully accent
    const a = rng() * TAU, r = w * (0.42 + rng() * 0.40);
    lobe(b, Math.cos(a) * r, h * (0.42 + rng() * 0.45), Math.sin(a) * r,
         w * 0.11, w * 0.09, w * 0.11, 0, rng,
         { chan: 1.0, trans: 0.35, ragged: 0.24, lift: 0.3 });
  }
  return b.finish(h);
}

/**
 * Rangy dry scrub — the low ochre stuff on plate 2's slope. No mass at all:
 * a fan of stiff sprays. It reads as texture rather than as an object, which
 * is exactly what a gold hillside needs between the grass and the bushes.
 */
function buildScrubDry(rng) {
  const b = new Builder();
  const h = 0.70 + rng() * 0.85;
  const n = 9 + ((rng() * 6) | 0);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = h * 0.16 * rng();
    frond(b, {
      x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r,
      yaw: a + (rng() - 0.5) * 1.4,
      tilt: 0.10 + rng() * 0.52,
      len: h * (0.62 + rng() * 0.62),
      w: h * (0.032 + rng() * 0.030),
      segs: 3, droop: 0.20 + rng() * 0.22, taper: 0.88,
      chanA: 0.0, chanB: 0.62, aoA: 0.38, aoB: 0.95, swayA: 0.30, trans: 0.85,
    });
  }
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
         w * (0.36 + rng() * 0.22), top * 0.40, w * (0.34 + rng() * 0.20), 1, rng,
         { chan: rng() * 0.35, trans: 0.85, ragged: 0.40, lift: 0.42 });
  }
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

/** Low broadleaf — the flat green stuff between the ferns. */
function buildBroadleaf(rng) {
  const b = new Builder();
  const h = 0.20 + rng() * 0.18;
  const n = 5 + ((rng() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.8;
    leafBlade(b, 0, h * 0.04, 0, a,
              h * (1.5 + rng() * 0.9), h * (0.34 + rng() * 0.22),
              0.55 + rng() * 0.55, 0.35 + rng() * 0.6, 1.0);
  }
  return b.finish(h);
}

/** Moss cushion for the damp north side of logs, rocks and trunks. */
function buildMoss(rng) {
  const b = new Builder();
  const h = 0.09 + rng() * 0.07;
  for (let i = 0; i < 3; i++) {
    const a = rng() * TAU, r = 0.16 + rng() * 0.20;
    lobe(b, Math.cos(a) * r, h * (0.3 + rng() * 0.3), Math.sin(a) * r,
         0.20 + rng() * 0.16, h * (0.7 + rng() * 0.5), 0.20 + rng() * 0.16, 0, rng,
         { chan: rng() * 0.4, trans: 0.35, ragged: 0.40, lift: 0.85, ao: 0.85 });
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
    b.quad(c0, c1, c2, c3);
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
  const R = 0.9 + rng() * 0.9;
  const n = 10;
  const c = b.vert(0, 0.055, 0, 0, 1, 0, 0.25, 1.0, 0.0, 0.35);
  const rim = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = R * (0.62 + rng() * 0.55);
    rim.push(b.vert(Math.cos(a) * r, 0.006 + rng() * 0.02, Math.sin(a) * r,
                    Math.cos(a) * 0.18, 1, Math.sin(a) * 0.18,
                    rng() < 0.35 ? 1.0 : 0.1, 0.86, 0.0, 0.5));
  }
  for (let i = 0; i < n; i++) b.tri(c, rim[i], rim[(i + 1) % n]);
  for (let i = 0; i < 5; i++) {                  // leaves caught on edge
    const a = rng() * TAU, r = R * (0.45 + rng() * 0.55);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    leafBlade(b, x, 0.01, z, rng() * TAU, 0.20 + rng() * 0.13, 0.075,
              1.05 + rng() * 0.35, rng() < 0.5 ? 1.0 : 0.35, 0.9);
  }
  return b.finish(0.4);
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
  return b.finish(h);
}

/** Broken branch litter. Tiny, but it is what fills the gaps between logs. */
function buildBranch(rng) {
  const b = new Builder();
  const len = 0.9 + rng() * 1.3;
  const r = 0.035 + rng() * 0.03;
  tube(b, [
    { x: 0, y: r, z: 0, r },
    { x: len * 0.55, y: r * 1.15, z: (rng() - 0.5) * 0.25, r: r * 0.75 },
    { x: len, y: r * 0.9, z: (rng() - 0.5) * 0.4, r: r * 0.4 },
  ], 4, 0.0, 0.05);
  const a = rng() * TAU;
  tube(b, [
    { x: len * 0.45, y: r, z: 0, r: r * 0.5 },
    { x: len * 0.45 + Math.cos(a) * 0.35, y: r * 1.6, z: Math.sin(a) * 0.35, r: r * 0.2 },
  ], 3, 0.0, 0.05);
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

export const COVER_ARCHETYPES = [
  { key: 'shrubDark',   variants: 3, card: false, cap: 420, vis: 240, band: 3, wind: 0.030, shadow: true,  build: buildShrubDark },
  { key: 'shrubBerry',  variants: 2, card: false, cap: 190, vis: 165, band: 2, wind: 0.032, shadow: true,  build: buildShrubBerry },
  { key: 'scrubDry',    variants: 3, card: true,  cap: 330, vis: 135, band: 2, wind: 0.075, shadow: false, build: buildScrubDry },
  { key: 'thicket',     variants: 2, card: false, cap: 200, vis: 250, band: 3, wind: 0.055, shadow: true,  build: buildThicket },
  { key: 'fern',        variants: 2, card: true,  cap: 620, vis: 64,  band: 1, wind: 0.045, shadow: false, build: buildFern },
  { key: 'broadleaf',   variants: 2, card: true,  cap: 520, vis: 46,  band: 0, wind: 0.030, shadow: false, build: buildBroadleaf },
  { key: 'moss',        variants: 1, card: false, cap: 480, vis: 40,  band: 0, wind: 0.000, shadow: false, build: buildMoss },
  { key: 'flowerAster', variants: 2, card: true,  cap: 300, vis: 48,  band: 0, wind: 0.055, shadow: false, build: buildFlowerAster },
  { key: 'goldenrod',   variants: 1, card: true,  cap: 260, vis: 58,  band: 0, wind: 0.065, shadow: false, build: buildGoldenrod },
  { key: 'seedHead',    variants: 1, card: true,  cap: 320, vis: 52,  band: 0, wind: 0.085, shadow: false, build: buildSeedHead },
  { key: 'leafDrift',   variants: 2, card: true,  cap: 420, vis: 120, band: 2, wind: 0.006, shadow: false, build: buildLeafDrift },
  { key: 'log',         variants: 2, card: false, cap: 120, vis: 210, band: 3, wind: 0.000, shadow: true,  build: buildLog },
  { key: 'stump',       variants: 1, card: false, cap: 110, vis: 165, band: 3, wind: 0.000, shadow: true,  build: buildStump },
  { key: 'branch',      variants: 1, card: false, cap: 200, vis: 88,  band: 1, wind: 0.000, shadow: false, build: buildBranch },
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

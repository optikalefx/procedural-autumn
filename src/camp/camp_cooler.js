// ─────────────────────────────────────────────────────────────────────────────
//  camp_cooler — the rotomoulded hard cooler.
//
//  Shape language, in one sentence: **there is not a hard edge on it**.
//
//  A rotomoulded box is made by tumbling powdered HDPE inside a heated mould,
//  so every corner is a large fillet by manufacturing necessity — a Tundra 45
//  is 660 mm across and carries a 75 mm plan radius on its vertical corners,
//  which is more than a fifth of its depth. That is not a detail, it *is* the
//  object: the reason a cooler photographs as a friendly lump rather than as a
//  crate is that light rolls continuously around the corner instead of stopping
//  at a terminator. CamperModel argues that a 25 mm bevel is what separates a
//  shaded box from programmer art; this prop is that argument taken to its
//  limit, and the failure mode if the radii are shy is not "slightly wrong", it
//  is "reads as a toolbox".
//
//  So the body and the lid are not rounded boxes. They are **swept shells**: a
//  vertical profile of (height, inset) knots, every transition in it a fillet
//  of two to six rings, swept around a rounded-rectangle cross section whose
//  corner radius shrinks with the inset so the plan stays a true offset. One
//  profile therefore produces the tapered lower wall, the slight barrel of the
//  side, the rebate under the lid, the rim, the 50 mm wall thickness seen from
//  above, the cavity and its filleted floor — all mutually consistent, which
//  stacking eight rounded boxes never is.
//
//  Two departures from the shared kit, both deliberate:
//
//  · **Smooth normals.** `Parts.add()` converts to non-indexed and then calls
//    computeVertexNormals(), which is per-face — correct for the camper's flat
//    panels and for a hexagonal chair tube, and wrong here, because the one
//    thing this object is judged on is a *continuous* roll of light down a
//    curved wall. Faceting a 90° corner into eight flats under a renderer that
//    already quantises diffuse into bands gives visible stripes. `Shell` below
//    is `Parts` with the normals computed on the indexed geometry and then
//    carried through `toNonIndexed()`, so they survive the merge. Everything
//    hard-edged — latch rubber, feet, hardware — still goes through `Parts`.
//  · **Winding is fixed by measurement, not by hand.** Every shell here is a
//    closed volume, so its signed volume says whether we wound it inside out;
//    `orient()` flips the index buffer when it comes out negative. Three
//    authors on this project have shipped inverted geometry by reasoning about
//    cross products, so this file does not reason about them.
//
//  Everything merges to five meshes: HDPE, rubber, moulded hardware, rope,
//  and the hinge pin.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Parts, campMaterials, sanitizeNormals, C, M, at, rbox, tube, tintFrom,
} from './camp_materials.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Colourways
//
//  These are saturated manufactured objects in a valley that is all ochre,
//  olive and dust, and that contrast is most of what makes the camp read as
//  somebody's kit rather than as terrain decoration. But a rotomould is *matte*
//  — the failure on the other side is a body that blows out into a flat chip of
//  pure hue. So each colourway is authored a touch darker and a touch less
//  saturated than the product photo looks, and the wide soft roll of light down
//  the corner is what supplies the brightness instead.
//
//  `lid` differs from `body` only on the two-tone Igloo-style one, which also
//  gets the white gasket band at the seam — the loudest value read in the whole
//  reference set.
// ─────────────────────────────────────────────────────────────────────────────
export const COOLER_COLORWAYS = [
  // Harvest red. The hero, and the plate the brief points at.
  { body: 0xb14c47, lid: 0xa8453f, band: null, hw: 'rope', hard: 0x22201f },
  // Stone body, navy lid, the white gasket band at the seam.
  { body: 0x969a9c, lid: 0x2f4770, band: 0xc9c6bd, hw: 'swing', hard: 0x1d1d20 },
  // Seafoam. Reads cool against every autumn hue in the valley.
  { body: 0x3a9086, lid: 0x35887f, band: null, hw: 'rope', hard: 0x22201f },
];

// The HDPE material already carries the burgundy, so every tint below is a
// multiplier relative to it (see tintFrom's note on linear space).
const HDPE_BASE = 0x8f3a3c;
const PLASTIC_BASE = 0x2a2a2e;
const RUBBER_BASE = 0x1b1b1e;

// ─────────────────────────────────────────────────────────────────────────────
//  Swept-shell machinery
// ─────────────────────────────────────────────────────────────────────────────

const UX = new THREE.Vector3(1, 0, 0);
const UY = new THREE.Vector3(0, 1, 0);
const UZ = new THREE.Vector3(0, 0, 1);

/**
 * One ring of a rounded rectangle, in the plane spanned by `U` and `V`.
 *
 * `nc` samples per 90° corner and *four* straight edges of a single segment
 * each, so the vertex count is 4·(nc+1) whatever the radius is — which is what
 * lets consecutive rings of different radius be stitched into a quad grid.
 */
function ring(o, U, V, a, b, r, nc) {
  const rr = Math.max(0.003, Math.min(r, Math.min(a, b) * 0.985));
  const ca = a - rr, cb = b - rr;
  const QU = [1, -1, -1, 1], QV = [1, 1, -1, -1];
  const pts = [];
  for (let k = 0; k < 4; k++) {
    for (let j = 0; j <= nc; j++) {
      const th = (k + j / nc) * Math.PI * 0.5;
      const u = ca * QU[k] + rr * Math.cos(th);
      const v = cb * QV[k] + rr * Math.sin(th);
      pts.push(new THREE.Vector3(
        o.x + U.x * u + V.x * v,
        o.y + U.y * u + V.y * v,
        o.z + U.z * u + V.z * v,
      ));
    }
  }
  return pts;
}

/**
 * Flip the index buffer if the closed mesh came out inside out.
 *
 * Signed volume by the divergence theorem: Σ v0·(v1×v2)/6 over the triangles.
 * Positive means the winding already agrees with an outward normal. It is
 * origin-independent, so it works on a shell built anywhere in space, and it is
 * the whole reason `tools/winding.mjs` has nothing to say about this file.
 */
function orient(index, pos) {
  let vol = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (vol >= 0) return;
  for (let t = 0; t < index.length; t += 3) {
    const s = index[t + 1]; index[t + 1] = index[t + 2]; index[t + 2] = s;
  }
}

/**
 * Stitch a list of equal-length rings into a closed shell with smooth normals.
 *
 * Built *indexed* precisely so `computeVertexNormals()` averages across the
 * seams; converted to non-indexed afterwards only because the merge bins want a
 * uniform layout, and `toNonIndexed()` carries the normal attribute along
 * unchanged.
 */
function shell(rings) {
  const n = rings[0].length, m = rings.length;
  const verts = [];
  for (const r of rings) for (const p of r) verts.push(p.x, p.y, p.z);
  const idx = [];
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = i * n + j, b = i * n + j2, c = (i + 1) * n + j2, d = (i + 1) * n + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const fan = (r, base, forward) => {
    let cx = 0, cy = 0, cz = 0;
    for (const p of r) { cx += p.x; cy += p.y; cz += p.z; }
    const ci = verts.length / 3;
    verts.push(cx / n, cy / n, cz / n);
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      if (forward) idx.push(ci, base + j, base + j2);
      else idx.push(ci, base + j2, base + j);
    }
  };
  fan(rings[0], 0, false);
  fan(rings[m - 1], (m - 1) * n, true);

  const pos = new Float32Array(verts);
  orient(idx, pos);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  sanitizeNormals(g);
  const out = g.toNonIndexed();
  g.dispose();
  return out;
}

/**
 * `Parts`, but the normals the caller computed are the normals that ship.
 *
 * `mPost` exists for the open lid: the wear tints are functions of position, so
 * they have to be evaluated in the lid's *closed* frame and the hinge rotation
 * applied afterwards, or the dust and the scuffs swing round with it.
 */
class Shell {
  constructor(label) { this.bins = new Map(); this.label = label; }

  add(geo, key, m = null, tint = null, mPost = null) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // applyMatrix4 pushes normals through the inverse-transpose and
    // renormalises them, so a non-uniform scale here would still be safe.
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const col = new Float32Array(n * 3);
    const p = g.attributes.position.array;
    if (typeof tint === 'function') {
      for (let i = 0; i < n; i++) {
        const c = tint(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
    } else {
      const c = tint || [1, 1, 1];
      for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (mPost) g.applyMatrix4(mPost);
    sanitizeNormals(g);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  flush(parent) {
    const mats = campMaterials();
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn(`[camp:${this.label}] no material "${key}"`); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn(`[camp:${this.label}] merge failed for "${key}"`); continue; }
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `${this.label}_${key}`;
      parent.add(mesh);
    }
    this.bins.clear();
  }
}

// Profile helpers. A profile is a list of [y, inset] knots; `filletV` turns a
// corner whose tangent is vertical at the start, `filletH` one whose tangent is
// horizontal at the start. Every corner on this prop is one of the two, which
// is the point — nothing in the profile is allowed to be a step.
const filletV = (out, y0, i0, dy, di, n = 4) => {
  for (let k = 1; k <= n; k++) {
    const f = (k / n) * Math.PI * 0.5;
    out.push([y0 + dy * Math.sin(f), i0 + di * (1 - Math.cos(f))]);
  }
};
const filletH = (out, y0, i0, dy, di, n = 4) => {
  for (let k = 1; k <= n; k++) {
    const f = (k / n) * Math.PI * 0.5;
    out.push([y0 + dy * (1 - Math.cos(f)), i0 + di * Math.sin(f)]);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {(…)=>number} rnd seeded RNG
 * @param {object} opts  colorway | lidOpen | wear | size
 * @returns {THREE.Group} origin at ground centre, +Z is the latch face
 */
export function buildCooler(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_cooler';

  const cw = COOLER_COLORWAYS[(opts.colorway ?? 0) % COOLER_COLORWAYS.length];
  const wear = clamp01(opts.wear ?? 0.5);
  // Two chest sizes, a 45 and a 65. One size everywhere reads as a catalogue.
  const big = opts.size !== undefined ? !!opts.size : rnd() < 0.34;
  const W = big ? 0.79 : 0.66, HT = big ? 0.42 : 0.40, D = big ? 0.45 : 0.40;
  const aW = W * 0.5, aD = D * 0.5;
  // Every height below was authored against a 400 mm chest.
  const h = (v) => v * (HT / 0.40);
  // The plan radius on the vertical corners. 75 mm against a 400 mm depth: this
  // is the number that decides whether the prop reads as rotomoulded or as a
  // box, and it is the last number that should ever be trimmed for room.
  const RC = big ? 0.083 : 0.075;
  const RN = 8;                         // ring samples per 90° corner — 11° each

  const S = new Shell('cooler');
  const P = new Parts('cooler');

  const bodyRGB = tintFrom(HDPE_BASE, cw.body);
  const lidRGB = tintFrom(HDPE_BASE, cw.lid);
  const bandRGB = cw.band ? tintFrom(HDPE_BASE, cw.band) : null;
  const hardRGB = tintFrom(PLASTIC_BASE, cw.hard);
  const rubRGB = tintFrom(RUBBER_BASE, cw.hard);

  // ── the wall's own section ────────────────────────────────────────────────
  // Draft, and almost nothing else. A rotomould is pulled from a mould, so it
  // drafts; but the faces themselves are flat. Earlier rounds carried a 3 mm
  // barrel at the waist on the theory that a cooling wall relaxes outward, and
  // in the frames that barrel was most of why the prop read as a padded red
  // trunk rather than as plastic: a convex face under a matte material has no
  // straight terminator anywhere on it, so nothing on it says "panel". Flat
  // faces and a 75 mm corner is the entire rotomould read.
  const SHOULDER = h(0.276);
  const wallInset = (y) => {
    const t = clamp01((y - h(0.026)) / (SHOULDER - h(0.026)));
    const draft = 0.023 * Math.pow(1 - t, 1.25);
    return draft - 0.0010 * Math.sin(Math.PI * t);
  };
  // The outer surface of the wall at a given height, for anything bolted to it.
  const faceZ = (y) => aD - wallInset(y);
  const faceX = (y) => aW - wallInset(y);

  // ───────────────────────────────────────────────────────────────────────────
  //  Body: outer bottom → outer wall → rebate → rim → cavity → cavity floor.
  //  One continuous surface, so the 50 mm wall thickness at the rim is real
  //  rather than implied — which is the first thing you see when the lid is up.
  // ───────────────────────────────────────────────────────────────────────────
  const yb = h(0.026);              // underside of the chest, clear of the feet
  const RIM = h(0.304);             // top of the rim
  const REB = 0.011;                // how far the body steps in under the lid
  const WALL = 0.050;

  const bp = [];
  {
    const rvB = 0.023;                                   // bottom roll
    for (let k = 0; k <= 5; k++) {
      const f = (k / 5) * Math.PI * 0.5;
      const y = yb + rvB * (1 - Math.cos(f));
      bp.push([y, rvB * (1 - Math.sin(f)) + wallInset(y)]);
    }
    for (const v of [0.080, 0.108, 0.136, 0.164, 0.192, 0.222, 0.250, 0.276]) {
      bp.push([h(v), wallInset(h(v))]);                  // wall
    }
    filletV(bp, SHOULDER, 0, h(0.014), REB, 4);          // shoulder into the rebate
    bp.push([h(0.298), REB]);                            // the recessed band
    filletV(bp, h(0.298), REB, h(0.006), 0.009, 3);      // outer rim roll
    bp.push([RIM, REB + 0.009 + 0.026]);                 // the rim, seen from above
    filletH(bp, RIM, REB + 0.035, -h(0.008), 0.008, 3);  // inner rim roll
    for (const v of [0.250, 0.190, 0.140, 0.104]) {      // cavity, drafted
      bp.push([h(v), 0.054 + (h(0.296) - h(v)) * 0.020]);
    }
    const last = bp[bp.length - 1];
    filletH(bp, last[0], last[1], -0.024, 0.024, 4);     // cavity floor
  }

  // ── wear ──────────────────────────────────────────────────────────────────
  // Three stories, all of them things that happen to a cooler and none of them
  // things that happen to a shop display: it has been set down on dirt, it has
  // been shoved across a truck bed on its lower corners, and the lid has been
  // closed on it a thousand times.
  const scuffs = [];
  for (let i = 0; i < 4; i++) {
    scuffs.push([
      (rnd() * 2 - 1) * aW * 0.92,
      h(lerp(0.352, 0.401, rnd())),
      (rnd() < 0.5 ? -1 : 1) * aD * lerp(0.5, 1.02, rnd()),
      lerp(0.040, 0.080, rnd()),
    ]);
  }
  // Dried splash up the lower wall. A clean horizontal dust gradient reads as a
  // gradient; what sells it is that the top of the dirt is ragged and that a
  // few marks have run higher than the rest.
  const grime = [];
  for (let i = 0; i < 5; i++) {
    grime.push([
      (rnd() * 2 - 1) * aW,
      h(lerp(0.060, 0.215, rnd())),
      (rnd() < 0.5 ? -1 : 1) * aD * lerp(0.35, 1.05, rnd()),
      lerp(0.055, 0.125, rnd()),
      lerp(0.35, 0.85, rnd()),
    ]);
  }
  const mottle = (x, y, z) =>
    1 + 0.020 * Math.sin(x * 11.7 + z * 5.3) * Math.cos(z * 13.1 - y * 6.9);

  // ── the two wear colours, and why they are computed rather than typed ─────
  //
  // Vertex colour on these props is a *multiplier* on a material that is
  // already burgundy, so "blend the tint toward [1.14, 1.04, 0.86]" — which is
  // what dusted() does, correctly, for a white material — only ever produces a
  // slightly brighter burgundy. Three rounds of this prop had dust and scuffs
  // authored that way and not one frame showed either of them; the surface just
  // went a shade warmer and read as clean. What the multiplier has to be is the
  // one that turns the *material's own* colour into the colour we want, which
  // is exactly what tintFrom computes — so both wear colours are derived from
  // an absolute linear target here and divided through HDPE's base.
  const base = C(HDPE_BASE);
  const through = (r, g, b) => [r / base.r, g / base.g, b / base.b];
  // Pale dry valley dirt, in linear.
  const DUST = through(0.335, 0.278, 0.190);
  // Abraded HDPE goes chalky: the body's own hue, pulled most of the way to a
  // light neutral. Derived from the colourway so every colourway scuffs in its
  // own colour rather than in one grey.
  const CB = C(cw.body);
  const SCUFF = through(
    lerp(CB.r, 0.60, 0.62), lerp(CB.g, 0.58, 0.62), lerp(CB.b, 0.54, 0.62));
  const mixTo = (c, t, k) => [lerp(c[0], t[0], k), lerp(c[1], t[1], k), lerp(c[2], t[2], k)];

  const bodyTint = (x, y, z) => {
    const k = mottle(x, y, z);
    let c = [bodyRGB[0] * k, bodyRGB[1] * k, bodyRGB[2] * k];
    // the rub band where the lid closes on it
    const rub = smoothstep(h(0.252), h(0.270), y) * (1 - smoothstep(h(0.282), h(0.296), y))
              * 0.10 * (0.4 + wear);
    // corner abrasion low down, where it takes the truck bed
    const dx = Math.max(0, Math.abs(x) - (aW - RC)), dz = Math.max(0, Math.abs(z) - (aD - RC));
    const cor = clamp01(smoothstep(RC * 0.42, RC * 1.0, Math.hypot(dx, dz)))
              * (1 - smoothstep(h(0.055), h(0.175), y)) * 0.42 * wear;
    c = mixTo(c, SCUFF, clamp01(rub + cor));
    // Sky occlusion down the wall. A vertical face high up sees most of the
    // hemisphere; the same face at ankle height sees the ground instead, and
    // that gradient is why a real cooler in a photograph has a lighter top half
    // and a darker bottom half even in flat light. Without it the body is one
    // even chip of hue from rim to foot, the lid does not separate from the
    // chest, and four rounds of frames read as a soft red trunk. The dust then
    // lifts the last 40 mm back up, which is the ordering the reference plate
    // has too: pale dirty foot, dark shin, bright shoulder.
    const sky = 1 - 0.22 * (1 - smoothstep(h(0.030), h(0.285), y));
    c = [c[0] * sky, c[1] * sky, c[2] * sky];
    // Baked occlusion in the rebate under the lid. The seam is the read that
    // decides whether the two halves are two halves, and a 13 mm recess is not
    // deep enough to shadow itself at every hour — at noon the sky fills it and
    // the lid and the body fuse into one lump. This is the one place on the
    // prop where a value is painted rather than lit, and it is worth it.
    const ao = smoothstep(h(0.258), h(0.286), y) * (1 - smoothstep(h(0.300), h(0.306), y));
    c = [c[0] * (1 - 0.62 * ao), c[1] * (1 - 0.62 * ao), c[2] * (1 - 0.63 * ao)];
    // and the dust it has been standing in — the top of it ragged, not level
    const ragged = h(0.185) * (0.60 + 0.58 * (0.5 + 0.5 * Math.sin(x * 21.3 + z * 15.7)
                                                   * Math.cos(z * 17.9 - x * 11.1))
                                    + 0.22 * Math.sin(x * 61.0 + z * 44.0));
    let d = clamp01(smoothstep(ragged, h(0.004), y)) * (0.42 + 0.34 * wear);
    for (const [sx, sy, sz, sr, amp] of grime) {
      d += (1 - smoothstep(sr * 0.25, sr, Math.hypot((x - sx) * 0.8, (y - sy) * 1.5, (z - sz) * 0.8)))
         * amp * 0.30 * wear;
    }
    return mixTo(c, DUST, clamp01(d));
  };

  S.add(shell(bp.map(([y, ins]) =>
    ring(new THREE.Vector3(0, y, 0), UX, UZ, aW - ins, aD - ins, RC - ins, RN))),
    'hdpe', null, bodyTint);

  // ───────────────────────────────────────────────────────────────────────────
  //  Lid: a plug that drops into the cavity, a land that sits on the rim, and
  //  an outer skirt that stands 6 mm proud of the body wall. The overhang is
  //  the whole seam read — the body is rebated 11 mm underneath it, so what the
  //  eye gets is a 17 mm dark step running the full way round, which survives
  //  being squinted at from fifteen metres. Shy it and the two halves fuse into
  //  one lump and the prop stops being a cooler.
  // ───────────────────────────────────────────────────────────────────────────
  const LIDTOP = h(0.400);
  const PROUD = -0.010;
  const ROLL = 0.029;                    // the lid's own corner roll, top edge
  const lp = [];
  {
    lp.push([h(0.290), WALL + 0.026]);                     // plug underside
    filletH(lp, h(0.290), WALL + 0.026, h(0.006), -0.018, 3);
    lp.push([h(0.300), WALL + 0.006]);                     // plug wall
    filletV(lp, h(0.300), WALL + 0.006, h(0.003), -0.008, 2);
    lp.push([RIM - h(0.001), 0.024]);                      // land, on the rim
    filletH(lp, RIM - h(0.001), 0.024, -h(0.005), -0.021, 3);
    lp.push([h(0.298), 0.001]);                            // skirt bottom edge
    filletH(lp, h(0.298), 0.001, h(0.005), PROUD - 0.001, 3);
    for (const v of [0.314, 0.338, 0.360, 0.371]) lp.push([h(v), PROUD - 0.001]);
    for (let k = 1; k <= 6; k++) {                         // the big top roll
      const f = (k / 6) * Math.PI * 0.5;
      lp.push([h(0.371) + ROLL * Math.sin(f) * (HT / 0.40), PROUD - 0.001 + ROLL * (1 - Math.cos(f))]);
    }
    lp.push([LIDTOP, PROUD - 0.001 + ROLL + 0.030]);        // top land
    filletH(lp, LIDTOP, PROUD - 0.001 + ROLL + 0.030, -h(0.011), 0.011, 3);
    const last = lp[lp.length - 1];
    lp.push([last[0], last[1] + 0.026]);                    // recessed panel floor
  }

  const lidTint = (x, y, z) => {
    const k = mottle(x, y * 1.7, z);
    let c = [lidRGB[0] * k, lidRGB[1] * k, lidRGB[2] * k];
    if (bandRGB) {
      const bnd = (1 - smoothstep(h(0.310), h(0.320), y)) * smoothstep(h(0.296), h(0.301), y) * 0.9;
      c = [lerp(c[0], bandRGB[0], bnd), lerp(c[1], bandRGB[1], bnd), lerp(c[2], bandRGB[2], bnd)];
    }
    // lid corners take every knock: a general abrasion on the top corner roll,
    // plus four seeded scuffs so no two coolers are marked the same way.
    const dx = Math.max(0, Math.abs(x) - (aW - RC - 0.018));
    const dz = Math.max(0, Math.abs(z) - (aD - RC - 0.018));
    let s = clamp01(smoothstep(RC * 0.35, RC * 0.95, Math.hypot(dx, dz)))
          * smoothstep(h(0.340), h(0.392), y) * 0.34 * wear;
    for (const [sx, sy, sz, sr] of scuffs) {
      s += (1 - smoothstep(sr * 0.3, sr, Math.hypot(x - sx, (y - sy) * 1.7, z - sz))) * 0.55 * wear;
    }
    c = mixTo(c, SCUFF, clamp01(s));
    // and the underside of the overhang, which is in shadow whatever the hour
    const ao = 1 - smoothstep(h(0.298), h(0.312), y);
    return [c[0] * (1 - 0.5 * ao), c[1] * (1 - 0.5 * ao), c[2] * (1 - 0.5 * ao)];
  };

  {
    const geo = shell(lp.map(([y, ins]) =>
      ring(new THREE.Vector3(0, y, 0), UX, UZ, aW - ins, aD - ins, RC - ins, RN)));
    let post = null;
    if (opts.lidOpen) {
      const py = RIM, pz = -(aD - REB - 0.012);
      post = M().makeTranslation(0, py, pz)
        .multiply(M().makeRotationX(-lerp(1.55, 1.86, rnd())))
        .multiply(M().makeTranslation(0, -py, -pz));
    }
    S.add(geo, 'hdpe', null, lidTint, post);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Moulded panel on the front and back faces.
  //
  //  A 3 mm proud pad with a rolled edge, following the wall's own draft and
  //  barrel so it neither floats off the surface nor sinks into it. Without it
  //  the two big faces are blank slabs; with it they carry two soft terminator
  //  lines that tell you the wall in between them is curved.
  // ───────────────────────────────────────────────────────────────────────────
  const facePad = (axis, sgn, halfU, y0, y1, rc, proud) => {
    const cy = (y0 + y1) * 0.5, halfY = (y1 - y0) * 0.5;
    const rings = [];
    // Four rings, not three: the first pair is a true vertical wall so the
    // rolled edge has an unambiguous normal, and the cap sits 2.5 mm inside the
    // body wall where nothing can see it.
    for (const [ins, out] of [[0, -0.003], [0, 0.0016], [0.0022, proud * 0.68],
                              [0.0056, proud * 0.93], [0.0098, proud]]) {
      const flat = ring(new THREE.Vector3(0, 0, 0), UX, UY,
                        halfU - ins, halfY - ins, Math.max(0.006, rc - ins), 6);
      rings.push(flat.map((p) => {
        const yy = cy + p.y;
        const o = sgn * ((axis === 'z' ? faceZ(yy) : faceX(yy)) + out);
        return axis === 'z' ? new THREE.Vector3(p.x, yy, o) : new THREE.Vector3(o, yy, p.x);
      }));
    }
    return shell(rings);
  };
  for (const sgn of [1, -1]) {
    S.add(facePad('z', sgn, aW - RC - 0.034, h(0.082), h(0.226), 0.074, 0.0022),
          'hdpe', null, bodyTint);
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  T-latches — the detail that says "cooler" and not "toolbox" at 15 m.
  //
  //  A moulded rubber strap anchored on the lid's top front edge, over the
  //  roll, down the lid face, bulging outward across the seam and flaring into
  //  a T that hooks a keeper on the body. Built as one swept ribbon whose
  //  section widens at the last three stations, so the T is part of the strap
  //  rather than a box stuck on the end of it — which is what it is on the
  //  real thing, and it also means the flare catches light continuously.
  // ───────────────────────────────────────────────────────────────────────────
  const ribbon = (x, path, wid, thk, r = 0.0035, nc = 3) => {
    const rings = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      let ty = b[0] - a[0], tz = b[1] - a[1];
      const L = Math.hypot(ty, tz) || 1; ty /= L; tz /= L;
      rings.push(ring(new THREE.Vector3(x, path[i][0], path[i][1]),
                      UX, new THREE.Vector3(0, -tz, ty), wid[i] * 0.5, thk[i] * 0.5, r, nc));
    }
    return shell(rings);
  };

  const latchX = Math.min(aW * 0.53, aW - RC - 0.030);
  for (const sx of [-1, 1]) {
    const x = sx * latchX;
    const sl = (rnd() - 0.5) * 0.004;      // no two latches are pulled alike
    // Stations follow the surface the strap is lying on, offset ~5 mm along its
    // normal: the lid's top land, then the 38 mm top roll, then the lid face,
    // then a duck across the seam into the rebate, then the body wall.
    const path = [
      [h(0.4010), aD - 0.022],             // anchored on the lid's top land
      [h(0.4003), aD - 0.012],
      [h(0.3993), aD - 0.002],             // over the top roll
      [h(0.3880), aD + 0.0075],
      [h(0.3700), aD + 0.0155 + sl],       // down the lid face
      [h(0.3400), aD + 0.0165 + sl],
      [h(0.3180), aD + 0.0175 + sl],
      [h(0.3060), aD + 0.0165],
      [h(0.2990), aD + 0.0115],            // ducking under the lid's edge
      [h(0.2900), aD + 0.0050],            // and across the shadow gap
      [h(0.2820), aD + 0.0035],
      [h(0.2720), aD + 0.0075],            // back out onto the body wall
      [h(0.2630), aD + 0.0095],            // the T flares here
      [h(0.2550), aD + 0.0105],
      [h(0.2490), aD + 0.0085],
    ];
    const wid = [0.028, 0.029, 0.029, 0.029, 0.029, 0.028, 0.028, 0.028, 0.028, 0.028,
                 0.030, 0.036, 0.056, 0.060, 0.052];
    const thk = [0.008, 0.009, 0.009, 0.009, 0.009, 0.008, 0.008, 0.008, 0.008, 0.008,
                 0.009, 0.010, 0.012, 0.013, 0.010];
    S.add(ribbon(x, path, wid, thk), 'rubber', null, rubRGB);

    // The anchor that pins the strap to the lid, and the keeper the T hooks
    // under. Both are the small hard shapes that read as *mechanism*.
    P.add(rbox(0.048, 0.013, 0.030, 0.005, 1), 'rubber',
          at(x, h(0.4005), aD - 0.022), rubRGB);
    P.add(rbox(0.058, 0.016, 0.024, 0.007, 1), 'plastic',
          at(x, h(0.2365), faceZ(h(0.2365)) + 0.002), hardRGB);
  }

  // ── padlock lugs, front corners ───────────────────────────────────────────
  // A Tundra carries two moulded ears either side of the latches, one on the
  // lid and one on the body, that line up so a padlock passes through both.
  // They are 30 mm of hard-edged detail on an object that is otherwise all
  // radius, and they are most of what stops the front face reading as a blank
  // panel from across the camp.
  {
    const lx = Math.min(aW - RC - 0.010, aW * 0.78);
    for (const sx of [-1, 1]) {
      P.add(rbox(0.032, 0.030, 0.020, 0.006, 1), 'hdpe',
            at(sx * lx, h(0.268), faceZ(h(0.268)) + 0.004), bodyTint);
      // the lid's half only when the lid is down; it belongs to the lid, and
      // Parts has no hinge to swing it on
      if (!opts.lidOpen) {
        P.add(rbox(0.032, 0.026, 0.020, 0.006, 1), 'hdpe',
              at(sx * lx, h(0.312), aD + 0.013), lidTint);
      }
    }
  }

  // ── badge: a shape, not text ──────────────────────────────────────────────
  {
    const by = h(0.170);
    const z = faceZ(by) + 0.003;
    P.add(rbox(0.106, 0.036, 0.007, 0.010, 2), 'plastic', at(0, by, z + 0.0015),
          tintFrom(PLASTIC_BASE, 0x9a9184));
    P.add(rbox(0.090, 0.023, 0.007, 0.007, 2), 'plastic', at(0, by, z + 0.0038),
          tintFrom(PLASTIC_BASE, 0x1e2227));
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Handles. Rope with moulded end caps, or a black swing handle, per
  //  colourway — either way the point is that the silhouette is broken on both
  //  ends. A cooler whose ends are blank walls reads as a crate.
  // ───────────────────────────────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    const wx = sx * faceX(h(0.240));
    if (cw.hw === 'rope') {
      const zA = Math.min(aD * 0.52, aD - RC - 0.010);
      for (const sz of [-1, 1]) {
        P.add(rbox(0.032, 0.040, 0.048, 0.011, 2), 'hdpe',
              at(wx + sx * 0.010, h(0.240), sz * zA), bodyTint);
        P.add(rbox(0.018, 0.022, 0.028, 0.008, 1), 'plastic',
              at(wx + sx * 0.028, h(0.240), sz * zA), hardRGB);
      }
      // the rope: a catenary that hangs down and stands a little off the wall
      const droop = h(0.108) * lerp(0.9, 1.1, rnd());
      const y0 = h(0.238);
      const pts = [];
      for (let i = 0; i <= 22; i++) {
        const t = i / 22, s = t * 2 - 1, sag = 1 - s * s;
        pts.push(new THREE.Vector3(
          wx + sx * (0.022 + 0.020 * sag), y0 - droop * sag, s * zA * 1.02));
      }
      const t = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.0), 22, 0.0115, 5, false);
      sanitizeNormals(t);
      // A pale rope is the brightest thing on the prop and pulls the eye off the
      // latches; the real ones are a dark braided cord anyway.
      S.add(t, 'cord', null, tintFrom(0xd8cfae, 0x5b5449));
      // the moulded grip sleeve at the bottom of the U
      P.add(tube(0.0165, 0.098, 6), 'plastic',
            at(wx + sx * 0.040, y0 - droop, 0, Math.PI * 0.5, 0, 0), hardRGB);
    } else {
      const zA = Math.min(aD * 0.50, aD - RC - 0.014);
      for (const sz of [-1, 1]) {
        P.add(rbox(0.032, 0.044, 0.052, 0.012, 1), 'plastic',
              at(wx + sx * 0.012, h(0.250), sz * zA), hardRGB);
        P.add(rbox(0.024, 0.108, 0.024, 0.009, 1), 'plastic',
              at(wx + sx * 0.048, h(0.202), sz * (zA - 0.006), 0, 0, sx * 0.30), hardRGB);
      }
      P.add(rbox(0.032, 0.036, zA * 2 - 0.006, 0.014, 2), 'plastic',
            at(wx + sx * 0.062, h(0.150), 0), hardRGB);
    }
  }

  // ── drain plug, low on the −X end ─────────────────────────────────────────
  {
    const dy = h(0.070);
    const wx = -faceX(dy);
    P.add(tube(0.024, 0.024, 8), 'hdpe', at(wx - 0.006, dy, 0, 0, 0, Math.PI * 0.5), bodyTint);
    P.add(tube(0.017, 0.020, 6), 'plastic', at(wx - 0.022, dy, 0, 0, 0, Math.PI * 0.5), hardRGB);
    P.add(rbox(0.007, 0.022, 0.007, 0.002, 1), 'plastic', at(wx - 0.030, dy, 0), hardRGB);
  }

  // ── feet ──────────────────────────────────────────────────────────────────
  // Four moulded pads. The 14 mm of air they leave under the chest is what
  // makes the contact shadow read as *under* the cooler rather than as a black
  // outline drawn around it.
  {
    const fx = aW - RC * 0.5 - 0.044, fz = aD - RC * 0.55 - 0.033;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      P.add(rbox(0.090, 0.030, 0.068, 0.008, 2), 'rubber',
            at(sx * fx, h(0.015), sz * fz), rubRGB);
    }
  }

  // ── hinge, at the back seam ───────────────────────────────────────────────
  {
    const z = -(aD - REB - 0.002);
    for (const sx of [-1, 1]) {
      P.add(rbox(0.086, 0.034, 0.028, 0.010, 1), 'plastic',
            at(sx * aW * 0.42, h(0.290), z - 0.004), hardRGB);
    }
    P.add(tube(0.0065, W * 0.90, 6), 'steel',
          at(0, h(0.294), z - 0.014, 0, 0, Math.PI * 0.5), [1, 1, 1]);
  }

  S.flush(g);
  P.flush(g);
  // Measured, not guessed: the swing handle and the rope both stand well off
  // the end walls, and a footprint that ignores them is how a chair ends up
  // parked inside one.
  const bb = new THREE.Box3().setFromObject(g);
  g.userData.footprint = Math.max(0.46,
    Math.hypot(Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.z, bb.max.z)) + 0.02);
  return g;
}

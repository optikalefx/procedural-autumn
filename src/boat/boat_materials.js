// ─────────────────────────────────────────────────────────────────────────────
//  boat_materials — the shared kit both boats are built out of.
//
//  Same argument as camp_materials, one folder over: two boats authored against
//  one palette and one material set, with every per-colourway hue coming in
//  through the vertex colour attribute rather than through a new material. The
//  boat-specific materials below are all authored with a WHITE base colour, so
//  a vertex tint is an absolute linear colour (tintOf) rather than a ratio
//  against some base hue — which sidesteps the tintFrom bookkeeping the cooler
//  spends a paragraph on, at the cost of the material's own swatch meaning
//  nothing. For a kit whose every user tints every vertex, that is the right
//  trade.
//
//  The loft machinery (rring / shellFromRings) is the cooler's, generalised:
//  constant-vertex-count cross sections stitched into a closed indexed shell,
//  winding fixed by SIGNED VOLUME rather than by reasoning about cross
//  products (five authors have now shipped inverted geometry by reasoning
//  about cross products), smooth normals computed on the indexed mesh and
//  carried through toNonIndexed() so the hull reads as one continuous roll of
//  light instead of a faceted drum.
//
//  One extension: a ring builder may tag its points (0 = outer skin, 1 =
//  interior, 2 = seam …) and the tag rides along as an `atag` attribute into
//  the tint callback. A canoe's interior and exterior meet at the same (x, y)
//  for half the hull, so a positional tint alone cannot paint "faded red
//  outside, tan inside" — the tag can, crisply, because duplicated boundary
//  points make the colour discontinuity real.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { campMaterials, sanitizeNormals, C } from '../camp/camp_materials.js';

// The geometry helpers both boats lean on, re-exported so a boat file has one
// import to make.
export {
  M, at, rbox, tube, rod, span, sweptArc, patch, fan, ribbon, orient,
  dusted, tintOf, tintFrom, sanitizeNormals, C,
} from '../camp/camp_materials.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
//
//  Roughness values are not decoration (see camp_materials' header). The four
//  below span the reads a boat livery needs: varnished wood throws a wet-look
//  highlight down the gunwale, enamel is a step duller, royalex/poly is the
//  matte workhorse, fiberglass sits between them.
// ─────────────────────────────────────────────────────────────────────────────

let _mats = null;

/**
 * The shared boat material set, merged over the camp kit so a boat can also
 * reach for `cord`, `plastic`, `steel`, `rubber` without duplicating them.
 * Created once, reused by both boats and every colourway.
 */
export function boatMaterials() {
  if (_mats) return _mats;
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });

  // Varnished wood: gunwales, thwarts, seats, paddles, the wood-strip hull.
  // keepPhysicalSpecular so Stylize leaves the real specular term alone — the
  // one bright line down a varnished outwale is the whole "wet sheen" read.
  const varnish = std({ color: C(0xffffff), roughness: 0.35, metalness: 0.0, envMapIntensity: 1.15 });
  varnish.userData.keepPhysicalSpecular = true;

  _mats = {
    ...campMaterials(),
    varnish,
    // Painted hull enamel — the canvas-and-filler skin of a wood canoe.
    enamel:  std({ color: C(0xffffff), roughness: 0.45, metalness: 0.0, envMapIntensity: 0.95 }),
    // Royalex / rotomoulded poly — matte, takes its brightness from form.
    royalex: std({ color: C(0xffffff), roughness: 0.60, metalness: 0.0, envMapIntensity: 0.80 }),
    // Fiberglass gelcoat — the kayak's monocoque.
    glass:   std({ color: C(0xffffff), roughness: 0.40, metalness: 0.0, envMapIntensity: 0.95 }),
  };
  // The shadow side of a hull is the shot the art review flagged: at golden
  // hour the in-game frame turned warm cedar into near-black slate. Two causes,
  // two knobs. envMapIntensity above is the fill — a boat lives on open water
  // under the whole sky dome, and the old values starved the shade of it. This
  // one is the hue: Stylize's cool shadow term rotates shadowed pixels toward
  // slate blue, which is right for ground masses and wrong for warm wood —
  // the same exception the grass shader and the camp dirt already make.
  // `userData.shadowCool` scales that term per material (Stylize.js ~988);
  // low on the wood and canvas, milder on gelcoat, so the wood reads as dark
  // warm chestnut in shade instead of black.
  _mats.varnish.userData.shadowCool = 0.40;
  _mats.enamel.userData.shadowCool = 0.45;
  _mats.royalex.userData.shadowCool = 0.50;
  _mats.glass.userData.shadowCool = 0.65;
  return _mats;
}

/**
 * Hand the kit an environment probe, so the `envMapIntensity` values above
 * mean something.
 *
 * They did not, until this existed. A `MeshStandardMaterial` reads
 * `envMapIntensity` only from inside `#ifdef USE_ENVMAP`, and nothing in the
 * game sets `scene.environment` — so the fill this file's header claims to be
 * tuning ("a boat lives on open water under the whole sky dome, and the old
 * values starved the shade of it") was multiplying a term that was never
 * summed. Measured at h19.0 on seed 20261018, bow to the sunset, hull luma 32
 * against a sky at 193; with the probe attached at the same authored
 * intensities, 113, and the shore beside it unchanged to 1/255. Same hole the
 * table author opened against camp_materials.js on 2026-08-20
 * (docs/CAMP_REQUESTS.md), where it renders every camp metal flat black.
 *
 * Per-MATERIAL, deliberately, and not `scene.environment`: terrain, grass and
 * ground cover are hijacked MeshStandardMaterials (TerrainMaterial.js) while
 * the tree canopy is on raw ShaderMaterials, so a scene-wide probe relights
 * the ground and not the canopy — measured, it takes the bank from luma 58 to
 * 180 and pulls the frame apart. A prop kit's fill belongs to the prop kit.
 *
 * Call BEFORE the first boat is built: `envMap` is part of three's program
 * cache key, so setting it after Boat._prewarm() would make the prewarm link
 * the wrong variants and pay for the relink at the first launch instead of
 * under the loading screen.
 */
export function setBoatEnv(env) {
  const m = boatMaterials();
  for (const k of ['varnish', 'enamel', 'royalex', 'glass']) {
    m[k].envMap = env;
    m[k].needsUpdate = true;
  }
}

/** Dispose only the boat-specific materials; the camp set has its own owner. */
export function disposeBoatMaterials() {
  if (!_mats) return;
  for (const k of ['varnish', 'enamel', 'royalex', 'glass']) _mats[k]?.dispose();
  _mats = null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BoatParts — merge-by-material bins, smooth-normal flavour
//
//  Modeled on the cooler's `Shell`: normals the caller computed are the
//  normals that ship (a lofted hull's smooth normals must survive the merge).
//  Geometry without normals — camp's patch()/fan() output after a matrix, or
//  anything the caller wants re-faceted — gets computeVertexNormals() on the
//  non-indexed soup, which is the per-face look and correct for flat panels.
// ─────────────────────────────────────────────────────────────────────────────
export class BoatParts {
  constructor(label = 'boat') { this.bins = new Map(); this.label = label; }

  /**
   * @param geo   source geometry (consumed)
   * @param key   material key in `boatMaterials()`
   * @param m     THREE.Matrix4 placement (optional)
   * @param tint  [r,g,b], or fn(x, y, z, tag) -> [r,g,b] evaluated per vertex.
   *              `tag` is the `atag` attribute if the geometry carries one
   *              (see shellFromRings), else 0.
   * @param facet force per-face normals (thin members that read by facet)
   */
  add(geo, key, m = null, tint = null, { facet = false } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // applyMatrix4 pushes normals through the inverse-transpose and
    // renormalises, so even a non-uniform scale here is safe.
    if (m) g.applyMatrix4(m);
    if (facet || !g.attributes.normal) {
      g.deleteAttribute('normal');
      g.computeVertexNormals();
    }
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const tagA = g.getAttribute('atag');
    const col = new Float32Array(n * 3);
    const p = g.attributes.position.array;
    if (typeof tint === 'function') {
      for (let i = 0; i < n; i++) {
        const c = tint(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], tagA ? tagA.getX(i) : 0);
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      }
    } else {
      const c = tint || [1, 1, 1];
      for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // The tag has done its job; it must not survive into the merge, where a
    // bin-mate without one would make mergeGeometries return null.
    if (tagA) g.deleteAttribute('atag');
    sanitizeNormals(g);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  /** Merge each bin into one mesh and parent it. Shadows on, per the kit. */
  flush(parent) {
    const mats = boatMaterials();
    const made = [];
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn(`[boat:${this.label}] no material "${key}"`); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn(`[boat:${this.label}] merge failed for "${key}"`); continue; }
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `${this.label}_${key}`;
      parent.add(mesh);
      made.push(mesh);
    }
    this.bins.clear();
    return made;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Loft machinery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One ring of a rounded rectangle in the plane spanned by `U` and `V` —
 * the cooler's `ring()`, needed here for paddle-blade and strap sections.
 * `nc` samples per 90° corner; vertex count is 4·(nc+1) whatever the radius.
 */
export function rring(o, U, V, a, b, r, nc = 3) {
  const rr = Math.max(0.0015, Math.min(r, Math.min(a, b) * 0.985));
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

/** An elliptical ring in the XZ plane, lifted by `y` — hatches, coamings. */
export function ellipseRing(cx, y, cz, rx, rz, n = 20, yAt = null) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const x = cx + rx * Math.cos(th), z = cz + rz * Math.sin(th);
    pts.push(new THREE.Vector3(x, yAt ? yAt(x, z) : y, z));
  }
  return pts;
}

/**
 * Flip the index buffer if the closed mesh came out inside out — signed volume
 * by the divergence theorem, exactly the cooler's `orient()`. Origin-free, so
 * it works on a hull built about the waterline.
 */
function fixWinding(index, pos) {
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
 * Stitch equal-length rings into a closed shell with smooth normals.
 *
 * Indexed first so computeVertexNormals() averages across seams; converted to
 * non-indexed only because the merge bins want a uniform layout, and
 * toNonIndexed() carries both the normals and the `atag` attribute along.
 *
 * @param rings  Vector3[][] — every ring the same length
 * @param tags   optional number[] of length ring[0].length (per ring point),
 *               or number[][] per ring — baked as the `atag` attribute.
 *               Fan centres inherit the tag of their ring's first point.
 */
export function shellFromRings(rings, tags = null) {
  const n = rings[0].length, m = rings.length;
  const verts = [];
  const tagArr = tags ? [] : null;
  const tagOf = (ri, j) => (Array.isArray(tags[0]) ? tags[ri][j] : tags[j]);
  for (let ri = 0; ri < m; ri++) {
    for (let j = 0; j < n; j++) {
      const p = rings[ri][j];
      verts.push(p.x, p.y, p.z);
      if (tagArr) tagArr.push(tagOf(ri, j));
    }
  }
  const idx = [];
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = i * n + j, b = i * n + j2, c = (i + 1) * n + j2, d = (i + 1) * n + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const capFan = (r, base, forward, ri) => {
    let cx = 0, cy = 0, cz = 0;
    for (const p of r) { cx += p.x; cy += p.y; cz += p.z; }
    const ci = verts.length / 3;
    verts.push(cx / n, cy / n, cz / n);
    if (tagArr) tagArr.push(tagOf(ri, 0));
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      if (forward) idx.push(ci, base + j, base + j2);
      else idx.push(ci, base + j2, base + j);
    }
  };
  capFan(rings[0], 0, false, 0);
  capFan(rings[m - 1], (m - 1) * n, true, m - 1);

  const pos = new Float32Array(verts);
  fixWinding(idx, pos);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (tagArr) g.setAttribute('atag', new THREE.BufferAttribute(new Float32Array(tagArr), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  sanitizeNormals(g);
  const out = g.toNonIndexed();
  g.dispose();
  return out;
}

// ── small tint helpers ───────────────────────────────────────────────────────
export const mixRGB = (a, b, k) => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
export const mulRGB = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** Deterministic per-index hash on [0,1) — plank lightness, strap jitter. */
export const hash01 = (i) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ─────────────────────────────────────────────────────────────────────────────
//  bike_materials — the kit the bike is built out of.
//
//  Same shape as `boat_materials` one folder over, and for the same reason: a
//  family of colourways authored against one material set, with every per-bike
//  hue arriving through the vertex colour attribute rather than through a new
//  material. Every material here is authored with a WHITE base colour, so a
//  vertex tint is an absolute linear colour (`tintOf`) rather than a ratio
//  against some base hue.
//
//  ── why this file exists at all, and is not four lines in camp_materials ────
//
//  A bicycle is the most METAL object in the game outside the camper, and the
//  camp kit's metals cannot currently be lit. `camp_table.js` spends a page on
//  this and it is worth restating in one sentence: `campMaterials()` gives
//  `alu`, `anod` and `steel` an `envMapIntensity` but no `envMap`, nothing in
//  `src/` sets `scene.environment`, and a standard material at 0.9 metalness
//  keeps only `albedo * (1 - metalness)` as diffuse — so it puts almost
//  everything into an F0 with nothing to reflect and renders as a flat black
//  cut-out. The table's author worked around it by authoring the frame against
//  `plastic` and losing the bright line down the leg.
//
//  The bike cannot take that trade. A 19 mm spoke-and-rim wheel at fifteen
//  metres is held together by exactly one thing — a highlight running round the
//  rim — and a bicycle without it is a dark scribble. So this kit does what the
//  boat's does instead: it owns four materials and a `setBikeEnv`, and `Bike`
//  drives a `SkyProbe` into them. Per-MATERIAL and not `scene.environment`,
//  because terrain, grass and the tree canopy are raw ShaderMaterials and a
//  scene-wide probe relights the ground and not the canopy — see the SkyProbe
//  header for the measured version of that.
//
//  `groundMix` is the one number that differs from the boat's: a boat's lower
//  hemisphere is water and takes dimmed sky (0), a bike's is dirt and takes the
//  warm meadow bounce. See `Bike._probe`.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { campMaterials, sanitizeNormals, C } from '../camp/camp_materials.js';

// The geometry helpers the bike leans on, re-exported so the model file has one
// import to make.
export {
  M, at, rbox, tube, rod, span, sweptArc, patch, fan, ribbon, orient,
  dusted, tintOf, tintFrom, sanitizeNormals, C,
} from '../camp/camp_materials.js';

// The four this kit owns. Named for what they are on a bicycle, because that is
// how the model file reads.
const OWN = ['paint', 'polish', 'chrome', 'tread', 'lens'];

let _mats = null;

/**
 * The shared bike material set, merged over the camp kit so the model can also
 * reach for `plastic`, `rubber`, `cord`, `fabric` without duplicating them.
 * Created once, reused by every colourway.
 */
export function bikeMaterials() {
  if (_mats) return _mats;
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });

  // Frame enamel. The glossiest dielectric in the game: a painted bicycle tube
  // is a mirror with a colour, and the specular line down the top tube is what
  // makes a 32 mm tube read as a tube instead of a stroke.
  // keepPhysicalSpecular so Stylize leaves the real specular term alone — the
  // same exception the boat's varnish takes, for the same reason.
  const paint = std({ color: C(0xffffff), roughness: 0.24, metalness: 0.0, envMapIntensity: 1.25 });
  paint.userData.keepPhysicalSpecular = true;

  _mats = {
    ...campMaterials(),
    paint,
    // Mill / anodised aluminium: rims, cranks, bars, stem, seatpost.
    polish: std({ color: C(0xffffff), roughness: 0.26, metalness: 0.86, envMapIntensity: 1.15 }),
    // Bright steel: spokes, chain, cassette, hardware. Sharper than `polish`
    // because a spoke is two pixels wide and only a hot highlight survives that.
    chrome: std({ color: C(0xffffff), roughness: 0.18, metalness: 0.96, envMapIntensity: 1.25 }),
    // Tyre rubber, and the saddle. Matte, and it must stay matte: a shiny tyre
    // is the single loudest "this is plastic" tell an object like this has.
    tread:  std({ color: C(0xffffff), roughness: 0.93, metalness: 0.0, envMapIntensity: 0.30 }),
    // The headlamp lens, and the only material in the kit that makes its own
    // light. `Bike._lamp` ramps `emissiveIntensity` with the sun — a cold grey
    // disc by day, a warm eye at night — the same mechanism `Vehicle._lights`
    // drives on the camper's `lensHead`. Kept slightly rough rather than
    // mirror-smooth: a bike lamp lens is moulded acrylic with a fluted pattern
    // in it, and a perfect mirror there reads as a chrome cap.
    lens:   std({
      color: C(0xffffff), roughness: 0.30, metalness: 0.0, envMapIntensity: 0.9,
      emissive: C(0xffe6b4), emissiveIntensity: 0.05,
    }),
  };

  // Stylize's cool shadow term rotates shadowed pixels toward slate blue, which
  // is right for ground masses and wrong for a small saturated object standing
  // on its own — the same exception the boat's hull materials take. Low on the
  // paint (a red bike in shade should read as dark red, not slate), milder on
  // the metals, which genuinely do reflect a cold sky.
  _mats.paint.userData.shadowCool = 0.40;
  _mats.polish.userData.shadowCool = 0.70;
  _mats.chrome.userData.shadowCool = 0.75;
  _mats.tread.userData.shadowCool = 0.55;
  // The lens is the one thing here that must NOT be cooled in shadow: it is a
  // light source, and rotating a lit lamp toward slate is the exact defect
  // `render/Hearth.js` was written about.
  _mats.lens.userData.shadowCool = 0.0;
  _mats.lens.userData.keepPhysicalSpecular = true;
  return _mats;
}

/**
 * Point the kit's metals and paint at a baked sky probe.
 *
 * Call BEFORE the first bike is built: `envMap` is part of three's program
 * cache key, so setting it after `Bike._prewarm()` would make the prewarm link
 * the wrong variants and pay for the relink at the first mount instead of under
 * the loading screen. See `SkyProbe`'s `onBake` note for why re-pointing has to
 * happen on every bake and not only the first.
 */
export function setBikeEnv(env) {
  const m = bikeMaterials();
  for (const k of OWN) { m[k].envMap = env; m[k].needsUpdate = true; }
}

/** Dispose only the bike-specific materials; the camp set has its own owner. */
export function disposeBikeMaterials() {
  if (!_mats) return;
  for (const k of OWN) _mats[k]?.dispose();
  _mats = null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BikeParts — merge-by-material bins
//
//  The camp kit's `Parts` always re-facets (it deletes normals and recomputes
//  them on the non-indexed soup), which is right for a folding table and wrong
//  for a wheel: a faceted rim at fifteen metres is a polygon, and the whole
//  object is two circles. So this is the boat's flavour — normals the caller
//  computed are the normals that ship, and `{ facet: true }` asks for the camp
//  look on the members that want it (dropouts, brackets, the chainring).
// ─────────────────────────────────────────────────────────────────────────────
export class BikeParts {
  constructor(label = 'bike') { this.bins = new Map(); this.label = label; }

  /**
   * @param geo   source geometry (consumed — do not reuse it afterwards)
   * @param key   material key in `bikeMaterials()`
   * @param m     THREE.Matrix4 placement (optional)
   * @param tint  [r,g,b], or fn(x, y, z) -> [r,g,b] evaluated per vertex
   * @param facet force per-face normals
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
    sanitizeNormals(g);
    if (!this.bins.has(key)) this.bins.set(key, []);
    this.bins.get(key).push(g);
    return this;
  }

  /** Merge each bin into one mesh and parent it. */
  flush(parent) {
    const mats = bikeMaterials();
    const made = [];
    for (const [key, list] of this.bins) {
      const mat = mats[key];
      if (!mat) { console.warn(`[bike:${this.label}] no material "${key}"`); continue; }
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) { console.warn(`[bike:${this.label}] merge failed for "${key}"`); continue; }
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
//  Small colour helpers, same names and meanings as the boat kit's.
// ─────────────────────────────────────────────────────────────────────────────
export const mixRGB = (a, b, k) => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
export const mulRGB = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

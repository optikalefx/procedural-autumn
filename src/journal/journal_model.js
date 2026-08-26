// ─────────────────────────────────────────────────────────────────────────────
//  journal_model — the brown leather-bound camping journal, as geometry.
//
//  `buildJournal(rnd, opts) -> THREE.Group` is the repo's prop convention, so
//  this shows up in gallery.html with no registry edit (src/journal/ is inside
//  its glob). `opts.open` is a 0..1 number and `opts.colorway` an index, which
//  means the gallery's own option reader gives you a slider that scrubs the
//  book open and a dropdown of hides — that is the fastest way to iterate on
//  the model, and it is worth writing the options in exactly that shape for it.
//
//  ── what makes a small book read as a book ─────────────────────────────────
//  In order of how much each one is worth, measured by covering it up in a
//  capture and seeing what dies:
//
//   1. THE SQUARE. The covers overhang the text block by ~4 mm on the three
//      free edges. A cover flush with the pages is a box; the overhang is the
//      single silhouette cue that says "bound". The first pass had no square
//      and no amount of leather shading rescued it.
//   2. THE ROUNDED SPINE. Not a flat back. The spine is a half-cylinder wider
//      than the block is thick, with raised cords across it. Flat-backed, the
//      closed book is a brick with a texture on it.
//   3. THE FORE EDGE IS MANY SHEETS. 26 individually jittered slabs, slightly
//      concave across the stack. One cream-coloured box for the text block is
//      the loudest tell in the whole model, and it is the cheapest to fix.
//   4. THE BLIND-TOOLED BORDER, which lives in the cover's height field (see
//      journal_textures.js) rather than in geometry — a 0.4 mm groove modelled
//      as polygons is sub-pixel at every distance this is ever seen from.
//
//  Headbands, the sewing thread across the gutter, the ribbon marker and the
//  elastic band are all detail on top of those four. They are worth having and
//  none of them would save the model if any of the four were missing.
//
//  ── the frame ──────────────────────────────────────────────────────────────
//  Built with the SPINE HINGE AT x = 0, +x toward the fore edge, +y up the
//  page, +z out of the front cover. That is not where the object's centre is,
//  and it is deliberate: every hinge in the book — both covers and every leaf —
//  rotates about the y axis through x = 0, so in this frame opening anything is
//  one `rotation.y`. Rotating the front cover by pi maps (x, y, z) to
//  (-x, y, -z), which lands it flat on the far side at EXACTLY the height of
//  the back cover, with no fudge factor and no second animation to level it.
//  The returned group carries a child that re-centres the closed book on the
//  group's origin, so callers still get a prop centred on itself.
//
//  ── pages bend; they do not hinge ──────────────────────────────────────────
//  `deformPage` integrates a tangent angle along the sheet instead of rotating
//  a quad. That preserves the page's arc length, which is what makes it read as
//  paper: a rigid quad on a hinge sweeps its fore edge through a circle, and a
//  circle is what a door does. The angle runs from a root value at the spine to
//  a larger tip value at the fore edge, so the free edge is always flopped
//  ahead of the bound one, and it is biased along the page's height so the top
//  corner leads — that is the hand that is turning it.
//
//  ── the second trap in the text block, and it is worse ─────────────────────
//  The leaves DIVE into the gutter and the stack slabs are flat boxes that run
//  all the way to the fold, so the inner ~15 mm of every recto is inside the
//  block and does not draw. The symptom is beautifully misleading: the text is
//  fine, but every checkbox on the right-hand page loses three of its four
//  sides and comes out as a bracket, which reads as a font or mip-filtering
//  problem and is neither. (Versos are unaffected — their fold is on the other
//  side of the canvas — which is what makes it look like a texture bug.)
//
//  Three numbers fix it together and none of them works alone:
//    · GUT_INSET      each slab's inner edge starts further from the fold the
//                     higher it is in the stack, so the block's top surface
//                     STEPS DOWN into the gutter instead of ending in a cliff;
//    · PAGE_LIFT      the printed leaf floats a shade higher above its stack;
//    · GUTTER         a shallower dive, so the leaf has recovered by the time
//                     it reaches the top slab's inner edge.
//
//  ── the trap in the text block ─────────────────────────────────────────────
//  The block is 1.4 mm THINNER than the gap between the boards. Without that
//  clearance the top leaf and the front cover's endpaper occupy the same plane
//  and the closed book z-fights along its whole top face — which does not show
//  up while you are iterating with the book open, and is the first thing anyone
//  sees when it shuts.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import {
  leatherMaps, contactShadowTexture, endpaperTexture, blankLeafTexture,
} from './journal_textures.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Every dimension in the book, in metres. A5-ish field journal. */
export const BOOK = {
  W: 0.148,        // page width, spine to fore edge
  H: 0.210,        // page height
  T: 0.026,        // board to board, inside face to inside face
  COV: 0.0026,     // cover board
  SQ: 0.0042,      // the square: cover overhang on the three free edges
  LEAVES: 26,      // slabs in each half of the stack (see header, point 3)
  CLEAR: 0.0007,   // block-to-board clearance, per side (see header)
  GUT_INSET: 0.009,// how far the TOP slab's inner edge stands off the fold
  PAGE_LIFT: 0.0012, // printed leaf above its own stack
};

/**
 * Hides. `name` is read by the gallery to label the variants.
 *
 * The brief asks for brown and brown is the default, but a book is a prop and
 * a prop with one colourway always turns out to need two. `oxblood` is the
 * other classic bookbinding leather; `spruce` is here because the game's
 * palette is gold and orange and a green book is the only one of the three
 * that does not disappear into a sunlit meadow behind it.
 */
export const JOURNAL_COLORWAYS = [
  { name: 'saddle brown', hide: 0x7d4820, board: 0x4a2c16, band: 0x191612 },
  { name: 'oxblood', hide: 0x63241f, board: 0x3d1614, band: 0x241f1e },
  { name: 'spruce', hide: 0x334a36, board: 0x1e2c22, band: 0x1e211f },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Materials
// ─────────────────────────────────────────────────────────────────────────────
//
// Cached per colourway, like `campMaterials()`. The leather maps cost ~35 ms
// each to generate and the gallery builds every colourway on one page, so
// rebuilding them per call would be a second of frozen tab per card.
//
// NOTE these are NOT harvested by Stylize/Atmosphere: the journal renders in
// its own scene, after the post chain, so it gets three's own lighting model
// with no toon banding and no fog. That is the right answer for an object held
// up in front of the camera — but it does mean the roughness values here are
// doing real work, and cannot be copied from the camp kit, where Stylize is
// flattening the specular term for them.

const _mats = new Map();

export function journalMaterials(colorway = 0) {
  const key = colorway | 0;
  const hit = _mats.get(key);
  if (hit) return hit;
  const cw = JOURNAL_COLORWAYS[key] ?? JOURNAL_COLORWAYS[0];

  const cover = leatherMaps(C(cw.hide), { size: 512, border: true, seed: 3 + key });
  // The spine's own map. Its UV is one unit across a 25 mm arc and one unit up
  // a 218 mm height, so a repeat of 1 stretches the grain 9:1 along the spine
  // and it comes out looking POLISHED next to the cover — which is the single
  // most obvious "these are two different objects" tell the closed book had.
  // The repeat pair below puts the same ~2.6 mm cell on both.
  const plain = leatherMaps(C(cw.hide), {
    size: 256, border: false, repeat: [0.17, 1.45], seed: 11 + key,
  });

  // A printed leaf. `emissive` carrying the same map is what keeps the page
  // legible once it has swung away from the key light: the page IS the user
  // interface, and an interface that goes dark at 120 degrees of cover is a bug
  // however physically correct it is. 0.22 is as far as it can go before the
  // paper stops taking the scene's shading at all and reads as a decal.
  const pageMat = (side) => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0, envMapIntensity: 0.06,
    side, emissive: 0xfff2dc, emissiveIntensity: 0.10,
  });

  const m = {
    // Cover faces. envMapIntensity is low: the leather is matte enough that a
    // strong environment turns the grain into glitter.
    coverOut: new THREE.MeshStandardMaterial({
      color: 0xffffff, ...cover, roughness: 1, metalness: 0.0, envMapIntensity: 0.42,
      normalScale: new THREE.Vector2(0.85, 0.85),
    }),
    // Spine, and anywhere else leather wraps without a tooled border on it.
    hide: new THREE.MeshStandardMaterial({
      color: 0xffffff, ...plain, roughness: 1, metalness: 0.0, envMapIntensity: 0.38,
      normalScale: new THREE.Vector2(0.5, 0.5), side: THREE.DoubleSide,
    }),
    // The board seen at the cover's cut edge: greyboard, not leather.
    board: new THREE.MeshStandardMaterial({
      color: C(cw.board), roughness: 0.92, metalness: 0.0, envMapIntensity: 0.15,
    }),
    endpaper: new THREE.MeshStandardMaterial({
      color: 0xffffff, map: endpaperTexture(512, 11 + key), roughness: 0.88, metalness: 0.0,
      envMapIntensity: 0.12, side: THREE.DoubleSide,
    }),
    // The text block. vertexColors carries the per-slab cream jitter, which
    // arrives through instanceColor — and instanceColor is only multiplied into
    // the fragment when USE_COLOR is also defined, which is why the slab
    // geometry below carries a white `color` attribute it appears not to need.
    // Without it the whole text block renders black.
    paper: new THREE.MeshStandardMaterial({
      color: 0xf0e5cc, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.10,
      vertexColors: true,
    }),
    pageA: pageMat(THREE.FrontSide),      // right-hand leaf at rest
    pageB: pageMat(THREE.BackSide),       // left-hand leaf at rest
    pageC: pageMat(THREE.FrontSide),      // turning leaf, recto face
    pageD: pageMat(THREE.BackSide),       // turning leaf, verso face
    band: new THREE.MeshStandardMaterial({
      color: C(cw.band), roughness: 0.86, metalness: 0.0, envMapIntensity: 0.14,
      side: THREE.DoubleSide,
    }),
    // Satin, not felt. 0.72 was matte enough that the marker took no highlight
    // at all and read as a painted stripe; a ribbon is woven silk and its whole
    // visual signature is a soft moving band of light down its length.
    ribbonShade: new THREE.MeshBasicMaterial({
      color: 0x2b1d12, transparent: true, opacity: 0.42, depthWrite: false,
      toneMapped: false, side: THREE.DoubleSide,
    }),
    ribbon: new THREE.MeshStandardMaterial({
      color: C(0x6a2a24), roughness: 0.50, metalness: 0.0, envMapIntensity: 0.62,
      side: THREE.DoubleSide,
    }),
    thread: new THREE.MeshStandardMaterial({
      color: C(0xe4d9b8), roughness: 0.85, metalness: 0.0, envMapIntensity: 0.2,
    }),
    headband: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.7, metalness: 0.0, envMapIntensity: 0.3, vertexColors: true,
    }),
    shadow: new THREE.MeshBasicMaterial({
      color: 0xffffff, map: contactShadowTexture(256), transparent: true, opacity: 0.9,
      depthWrite: false, toneMapped: false,
    }),
  };
  _mats.set(key, m);
  return m;
}

/** Free every cached material and its maps. Journal.dispose calls this. */
export function disposeJournalMaterials() {
  for (const set of _mats.values()) {
    for (const mat of Object.values(set)) {
      if (!mat) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap']) mat[k]?.dispose?.();
      mat.dispose?.();
    }
  }
  _mats.clear();
  _blank?.dispose?.();
  _blank = null;
}

let _blank = null;
const blankLeaf = () => (_blank ??= blankLeafTexture());

// ─────────────────────────────────────────────────────────────────────────────
//  Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cover board: a rounded-corner slab, gently domed on its outer face.
 *
 * The dome is 0.6 mm over 150 mm and it is not optional. A dead-flat cover
 * catches the key light as one uniform value and the whole board reads as a
 * decal; half a millimetre of crown gives it a gradient across its width, which
 * is what every photograph of a real book shows.
 *
 * ExtrudeGeometry's own UVs are in WORLD units, not 0..1, so the cover map — a
 * non-tiling texture with a border tooled into it — lands as a 15-fold repeat
 * of its own corner. They are recomputed from x and y here. This cost an hour
 * the first time.
 */
function coverGeometry(w, h, t, r, dome) {
  const shape = new THREE.Shape();
  const hw = w / 2, hh = h / 2;
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);

  // curveSegments 12, not 6. At 6 the cover's 6 mm corner radius is four flat
  // chords and it staircases visibly on the closed book — which is the first
  // frame anyone sees. The triangles came out of the spine's old uniform grid,
  // where they were being spent on a smooth tube nobody can see the cords of.
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -t / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Cap vertices get the dome; the extruded side wall does not.
    if (Math.abs(z) > t * 0.4) {
      const u = clamp01(1 - (x / hw) ** 2) * clamp01(1 - (y / hh) ** 2);
      pos.setZ(i, z + Math.sign(z) * dome * u);
    }
    uv.setXY(i, clamp01(x / w + 0.5), clamp01(y / h + 0.5));
  }
  uv.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * The spine: an arc from the front hinge round to the back hinge, with raised
 * cords across it — and, unlike everything else that used to live here, a
 * SURFACE THAT IS POSED. See `poseSpine`.
 *
 * The cords are a radius bump, not applied geometry. Three of them, ~1.1 mm
 * proud — enough to break the spine's silhouette when the book is seen from the
 * side, which is the only time anybody looks at a spine.
 *
 * ── the rows are not uniform, and that is the whole budget story ────────────
 * This was a 26 x 44 uniform grid: 2,288 triangles, 38% of the whole model, on
 * a smooth tube whose 0.6 mm cords are invisible at every distance the book is
 * ever seen from — while the cover's corner radius was staircasing visibly at
 * `curveSegments: 6`. The grid is now placed where the shape actually bends:
 * a coarse uniform backbone, five rows across each cord, two at each turn-in.
 * Same silhouette, a third of the triangles, and the surplus went to the
 * corners where it shows.
 *
 * ── the lap, and the bright seam it kills ──────────────────────────────────
 * The arc used to stop dead at the hinge (a = 0 and a = pi, both at x = 0),
 * abutting the cover skin's edge in a T-junction. On a framebuffer with no
 * MSAA that junction leaks: a one-pixel CREAM SLIT ran the full height of the
 * closed book down the front hinge — on the first frame anybody ever sees. The
 * arc now overruns by `SPINE_LAP` at BOTH ends and tapers as it does, so each
 * end runs ~2.3 mm in +x and tucks UNDER the board, behind the joint. Nothing
 * can leak through a crack that has leather behind it.
 */
const SPINE_FLAT = 0.52;
// How far past each hinge the leather runs, in radians of the arc.
const SPINE_LAP = 0.30;
// How much the lap sinks as it overruns, so it passes under the board rather
// than standing proud of it.
const SPINE_LAP_SINK = 0.13;

function spineGeometry(r, h, { segs = 16, cords = 3, cordH = 0.0006, flat = SPINE_FLAT } = {}) {
  const cordAt = [];
  for (let i = 0; i < cords; i++) cordAt.push(-h / 2 + h * (0.24 + 0.26 * i));

  // ── rows, placed where the profile changes ──────────────────────────────
  const set = new Set();
  const R0 = 9;
  for (let j = 0; j <= R0; j++) set.add(-h / 2 + (h * j) / R0);
  for (const cy of cordAt) for (let k = -2; k <= 2; k++) set.add(cy + k * 0.00275);
  for (const e of [-1, 1]) for (const d of [0.0043, 0.0086]) set.add(e * (h / 2 - d));
  const rowY = [...set]
    .filter((y) => y >= -h / 2 - 1e-9 && y <= h / 2 + 1e-9)
    .sort((a, b) => a - b);

  // Per-row radius: the cords, and the head/tail turning in over the boards —
  // a bound spine is not a straight extrusion, it is capped at both ends.
  const rowR = rowY.map((y) => {
    let bump = 0;
    for (const cy of cordAt) {
      const d = Math.abs(y - cy) / 0.0055;
      if (d < 1) bump = Math.max(bump, cordH * (0.5 + 0.5 * Math.cos(d * Math.PI)));
    }
    const endIn = smoothstep(0, 0.013, Math.min(y + h / 2, h / 2 - y));
    return (r + bump) * (0.90 + 0.10 * endIn);
  });

  // ── columns, including the lap past each hinge ──────────────────────────
  const angle = [], sink = [];
  const A0 = -SPINE_LAP, A1 = Math.PI + SPINE_LAP;
  for (let i = 0; i <= segs; i++) {
    const a = A0 + ((A1 - A0) * i) / segs;
    angle.push(a);
    // 1 across the visible arc, tapering down through each lap.
    const over = Math.max(0, -a, a - Math.PI) / SPINE_LAP;
    sink.push(1 - SPINE_LAP_SINK * clamp01(over));
  }

  const g = new THREE.BufferGeometry();
  const rows = rowY.length, cols = segs + 1;
  const uv = [], idx = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) uv.push(i / segs, (rowY[j] + h / 2) / h);
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.userData.spine = { rowY, rowR, angle, sink, flat, r, rows, cols };
  poseSpine(g, 0);
  return g;
}

// Where the spine goes as the book opens.
//
// A book opened flat RESTS ON ITS SPINE. Shut, the leather is the rounded back
// of the block and stands ~15 mm proud of the boards; open, it is a shallow
// band UNDER the block, and the gutter you look into is paper and thread.
// Leaving it posed shut — which is what happened for one whole round — put an
// 11 mm leather ridge above the paper down the entire gutter of every spread,
// lit on top and hide-tiled, and it read as a foreign object lying on the book.
const SPINE_OPEN_X = 1.22;        // the arc spreads a little as it flattens
const SPINE_OPEN_DROP = 0.0026;   // how far the flattened band hangs below the boards

/**
 * Re-lay the spine for a cover angle.
 *
 * The profile is always `x = -sin(a)*AX`, `z = CZ + cos(a)*AZ - sin(a)*DROP`,
 * and opening the book only moves those four numbers: the vertical semi-axis
 * AZ collapses to nothing, the centre CZ drops to the plane the boards lie in,
 * and DROP takes over as the only bulge — which turns a tube standing over the
 * block into a lens lying under it, through one continuous family of shapes.
 *
 * @param open 0..1, the same number the covers use
 * @param zHinge  z of the plane the boards lie in when flat (negative)
 */
export function poseSpine(geo, open, zHinge = 0) {
  const t = geo.userData.spine;
  if (!t) return;
  const k = clamp01(open);
  const { rowY, rowR, angle, sink, flat, r, rows, cols } = t;
  const pos = geo.attributes.position;
  const arr = pos.array;
  let n = 0;
  for (let j = 0; j < rows; j++) {
    const rr = rowR[j] * 1;
    const ax = rr * flat * (1 + (SPINE_OPEN_X - 1) * k);
    const az = rr * (1 - k);
    const cz = zHinge * k;
    const drop = SPINE_OPEN_DROP * k * (rr / r);
    const y = rowY[j];
    for (let i = 0; i < cols; i++) {
      const a = angle[i], sk = sink[i];
      const sn = Math.sin(a), cs = Math.cos(a);
      arr[n] = -sn * ax * sk;
      arr[n + 1] = y;
      arr[n + 2] = cz + cs * az * sk - sn * drop;
      n += 3;
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
}

/** A closed ribbon of `n` sections, 4 verts each. Positions are filled by a poser. */
function ribbonGeometry(n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + 1) * 4 * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((n + 1) * 4 * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((n + 1) * 4 * 2), 2));
  const idx = [];
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < 4; f++) {
      const a = i * 4 + f, b = i * 4 + ((f + 1) % 4);
      idx.push(a, a + 4, b, b, a + 4, b + 4);
    }
  }
  g.setIndex(idx);
  g.userData.sections = n;
  return g;
}

/**
 * Sweep a rectangular cross-section along `pts`.
 *
 * `wide` is the direction the band's WIDTH points in, projected perpendicular
 * to the path. Passing a surface normal here (the obvious guess) puts the band
 * on edge — the elastic loop lies in a plane and its width is the plane's
 * normal, while the ribbon marker lies on a page and its width is across the
 * page. One vector, two very different cases, and getting it backwards produces
 * a band that is invisible from the front and 6 mm tall from the side.
 */
const _rT = new THREE.Vector3(), _rN = new THREE.Vector3(), _rU = new THREE.Vector3();
const _rW = new THREE.Vector3(), _rQ = new THREE.Quaternion();
function fillRibbon(geo, pts, hw, ht, wide, { roll = 0.30, twist = 0 } = {}) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const n = pts.length - 1;
  const CORN = [[+1, +1], [-1, +1], [-1, -1], [+1, -1]];
  for (let i = 0; i <= n; i++) {
    _rT.subVectors(pts[Math.min(n, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    // Twist rolls the WIDTH direction about the path as it runs. A ribbon that
    // keeps one face to the camera down its whole length is the thing that
    // reads as a strip of UI: the free end has to show its back somewhere.
    _rW.copy(wide);
    if (twist) _rW.applyQuaternion(_rQ.setFromAxisAngle(_rT, twist * (i / n) * (i / n)));
    _rN.copy(_rW).addScaledVector(_rT, -_rW.dot(_rT));
    if (_rN.lengthSq() < 1e-9) _rN.set(0, 0, 1).addScaledVector(_rT, -_rT.z);
    _rN.normalize();
    _rU.crossVectors(_rN, _rT).normalize();
    const p = pts[i];
    for (let f = 0; f < 4; f++) {
      const [a, b] = CORN[f];
      const k = (i * 4 + f) * 3;
      pos.array[k] = p.x + _rN.x * a * hw + _rU.x * b * ht;
      pos.array[k + 1] = p.y + _rN.y * a * hw + _rU.y * b * ht;
      pos.array[k + 2] = p.z + _rN.z * a * hw + _rU.z * b * ht;
      // Blended corner normal: mostly the broad face, some of the edge. `roll`
      // is how much — it is the cross-section's camber, and on the marker
      // ribbon it is most of what stops a 5 mm strip reading as a flat decal,
      // because a rolled normal across the width gives the broad face a satin
      // gradient instead of one uniform value.
      const nx = _rU.x * b + _rN.x * a * roll;
      const ny = _rU.y * b + _rN.y * a * roll;
      const nz = _rU.z * b + _rN.z * a * roll;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.array[k] = nx / l; nor.array[k + 1] = ny / l; nor.array[k + 2] = nz / l;
    }
  }
  pos.needsUpdate = true; nor.needsUpdate = true;
  geo.computeBoundingSphere();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Page bending
// ─────────────────────────────────────────────────────────────────────────────

// How far the fore edge is flopped ahead of the spine edge at mid-turn, in
// radians. 0.95 was arrived at by capture: below ~0.6 the leaf reads as a rigid
// flap, and above ~1.3 it folds back on itself and pokes through the stack.
const TIP_LAG = 0.95;
// How much further the top of the page turns than the bottom. This is the hand.
const CORNER_LEAD = 0.16;
// Out-of-plane cup at mid-turn, metres.
const CUP = 0.0055;
// The dive into the gutter where the leaf is sewn in: an angle at the spine
// edge, and how fast it straightens out along the page.
//
// THE TRAP: this is an angle added to an INTEGRATED tangent, so it does not
// tilt the page near the fold — it displaces the entire rest of the sheet
// downward by the integral of itself. The first version used 0.62 rad with a
// decay of 10, which is a 9 mm drop, and the whole page sank under the text
// block and vanished. It looked exactly like a texture that had failed to
// load, and it cost an hour of staring at material state. `deformPage` now
// re-levels the fore edge (see `zShift`), and these two numbers only set how
// DEEP the fold is: ~2.5 mm over the first 10 mm of the page.
const GUTTER = 0.26;
const GUTTER_DECAY = 16;

/**
 * Deform a plane into a page.
 *
 * The plane must be `PlaneGeometry(W, H, segsU, segsV)` in the XY plane; every
 * position is rewritten from its own uv, so the incoming positions are ignored
 * entirely and the same geometry can be re-posed forever without drifting.
 *
 * @param p   0 = lying flat on the right stack, 1 = flat on the left
 * @param zR  height of the right stack's top face
 * @param zL  height of the left stack's top face
 */
export function deformPage(geo, p, zR, zL, { W = BOOK.W, H = BOOK.H } = {}) {
  const pos = geo.attributes.position;
  const uvA = geo.attributes.uv;
  const segsU = geo.parameters?.widthSegments ?? 24;
  const segsV = geo.parameters?.heightSegments ?? 4;

  const t = clamp01(p);
  const root = Math.PI * smoothstep(0, 1, t);
  const lag = TIP_LAG * Math.sin(Math.PI * t);
  const gut = GUTTER * Math.cos(Math.PI * t);
  const cup = CUP * Math.sin(Math.PI * t);
  const zBase = zR + (zL - zR) * t;
  const du = W / segsU;

  // One integration per row of the mesh into a table, then read back per
  // vertex. The table is kept on the geometry because `samplePage` — which is
  // how a photograph finds the surface it is being taped to — has to sample the
  // SAME surface, not a second evaluation of the same formula that has since
  // been re-tuned.
  const rows = segsV + 1, cols = segsU + 1;
  let tab = geo.userData.table;
  if (!tab || tab.rows !== rows || tab.cols !== cols) {
    tab = geo.userData.table = {
      rows, cols, H,
      tx: new Float64Array(rows * cols), tz: new Float64Array(rows * cols),
      tnx: new Float64Array(rows * cols), tnz: new Float64Array(rows * cols),
    };
  }
  tab.H = H;
  const { tx, tz, tnx, tnz } = tab;

  for (let j = 0; j < rows; j++) {
    const vv = segsV ? j / segsV : 0.5;
    const lead = 1 + CORNER_LEAD * (vv - 0.5) * 2;

    // Where the fore edge would land WITHOUT the gutter dive, minus where it
    // lands with it. Adding that to the start height keeps the flat part of
    // the page on top of its stack and lets the fold be a fold, instead of
    // sliding the whole sheet down by the integral of the dive. See GUTTER.
    let zShift = 0;
    if (gut !== 0) {
      for (let i = 0; i < segsU; i++) {
        const um = (i + 0.5) / segsU;
        const base = root + (lag * lead) * smoothstep(0, 1, um);
        zShift += (Math.sin(base) - Math.sin(base + gut * Math.exp(-um * GUTTER_DECAY))) * du;
      }
    }

    let x = 0, z = zBase + zShift;
    for (let i = 0; i < cols; i++) {
      const u = i / segsU;
      const phi = root + (lag * lead) * smoothstep(0, 1, u) + gut * Math.exp(-u * GUTTER_DECAY);
      const cupAmt = cup * Math.sin(Math.PI * u) * (1 - (2 * vv - 1) ** 2);
      const sn = Math.sin(phi), cs = Math.cos(phi);
      const k = j * cols + i;
      tx[k] = x - sn * cupAmt;
      tz[k] = z + cs * cupAmt;
      tnx[k] = -sn; tnz[k] = cs;
      // Advance along the sheet using the MIDPOINT angle, so the arc length
      // stays W however hard it is bent. This is the whole reason the page
      // does not stretch as it turns.
      if (i < segsU) {
        const um = (i + 0.5) / segsU;
        const pm = root + (lag * lead) * smoothstep(0, 1, um) + gut * Math.exp(-um * GUTTER_DECAY);
        x += Math.cos(pm) * du;
        z += Math.sin(pm) * du;
      }
    }
  }

  for (let n = 0; n < pos.count; n++) {
    const u = uvA.getX(n), v = uvA.getY(n);
    const k = Math.round(v * segsV) * cols + Math.round(u * segsU);
    pos.setXYZ(n, tx[k], (v - 0.5) * H, tz[k]);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

const _spQ = new THREE.Quaternion();
const _spM = new THREE.Matrix4();
const _spN = new THREE.Vector3(), _spT = new THREE.Vector3(), _spU = new THREE.Vector3();

/**
 * The world frame of a point on a posed page: where a photograph has to land.
 *
 * Reads the table `deformPage` left behind rather than re-integrating, so a
 * photo can never land a hair off the surface it was computed against.
 *
 * @param u,v  page UV, v measured from the BOTTOM (three's convention)
 */
export function samplePage(mesh, u, v, outPos, outQuat) {
  const t = mesh.geometry.userData.table;
  if (!t) return false;
  const fi = clamp(u, 0, 1) * (t.cols - 1), fj = clamp(v, 0, 1) * (t.rows - 1);
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const i1 = Math.min(t.cols - 1, i0 + 1), j1 = Math.min(t.rows - 1, j0 + 1);
  const ai = fi - i0, aj = fj - j0;
  const bil = (arr) =>
    (arr[j0 * t.cols + i0] * (1 - ai) + arr[j0 * t.cols + i1] * ai) * (1 - aj) +
    (arr[j1 * t.cols + i0] * (1 - ai) + arr[j1 * t.cols + i1] * ai) * aj;

  outPos.set(bil(t.tx), (v - 0.5) * t.H, bil(t.tz));
  mesh.localToWorld(outPos);

  if (outQuat) {
    _spN.set(bil(t.tnx), 0, bil(t.tnz)).normalize();     // page normal
    _spT.set(_spN.z, 0, -_spN.x);                        // along +u
    _spU.crossVectors(_spN, _spT).normalize();
    _spM.makeBasis(_spT, _spU, _spN);
    outQuat.setFromRotationMatrix(_spM);
    mesh.getWorldQuaternion(_spQ);
    outQuat.premultiply(_spQ);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param rnd   mulberry32-style () => 0..1
 * @param opts  { colorway = 0, open = 0, pages = null }
 *              `open` 0..1 poses the book from shut to lying open at the first
 *              spread — a plain number, so the gallery's option reader gives it
 *              a slider. `pages` is an array of THREE.Texture in reading order;
 *              without it the leaves are blank stock, which is what the gallery
 *              sees.
 */
export function buildJournal(rnd = Math.random, opts = {}) {
  const colorway = Math.round(opts.colorway ?? 0) % JOURNAL_COLORWAYS.length;
  const open = clamp01(opts.open ?? 0);
  const M = journalMaterials(colorway);
  const { W, H, T, COV, SQ, LEAVES, CLEAR } = BOOK;

  const group = new THREE.Group();
  group.name = 'journal';
  const root = new THREE.Group();
  root.position.x = -(W + SQ) / 2;                 // re-centre; see the header
  group.add(root);

  const zTop = T / 2, zBot = -T / 2;
  const spineR = T / 2 + COV;
  const coverW = W + SQ, coverH = H + SQ * 2;

  // ── covers ────────────────────────────────────────────────────────────────
  // Each cover is a pivot group at x = 0 holding the board, the leather it is
  // covered in, and the endpaper pasted inside it. Opening is `pivot.rotation.y`
  // and nothing else.
  const mkCover = (sign) => {
    const pivot = new THREE.Group();
    const board = new THREE.Mesh(coverGeometry(coverW, coverH, COV, 0.006, 0.0006), M.board);
    board.position.set(coverW / 2, 0, sign * (zTop + COV / 2));
    // The leather is a second, slightly larger and slightly OUTBOARD shell, so
    // the board shows only as a dark line at the cut edge and the inside face
    // is left clear for the endpaper. Doing it as a material swap on one slab
    // put leather on the inside too, where paper belongs.
    const skin = new THREE.Mesh(
      coverGeometry(coverW + 0.0005, coverH + 0.0005, COV + 0.0006, 0.0062, 0.0006), M.coverOut);
    skin.position.set(coverW / 2, 0, sign * (zTop + COV / 2 + 0.0005));
    // The endpaper is inset from the cover edge by more than the square, so the
    // leather turn-in shows all the way round — which is what the inside of a
    // case-bound cover actually looks like.
    const ep = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.0035, H - 0.0035), M.endpaper);
    ep.position.set(SQ + (W - 0.0035) / 2, 0, sign * (zTop - 0.0002));
    if (sign > 0) ep.rotation.y = Math.PI;         // the front one faces the pages
    pivot.add(skin, board, ep);
    pivot.userData.endpaper = ep;
    return pivot;
  };

  const frontPivot = mkCover(+1);
  const backPivot = mkCover(-1);
  root.add(frontPivot, backPivot);

  // ── spine ─────────────────────────────────────────────────────────────────
  // The plane the boards lie in once the book is open flat. `poseSpine` needs
  // it, and it is derived here rather than guessed there so the two can never
  // drift: it is the OUTER face of the board, because the spine passes under
  // the boards, not between them.
  const zHingeFlat = -(zTop + COV);
  const spine = new THREE.Mesh(spineGeometry(spineR, coverH), M.hide);
  root.add(spine);
  const headbands = [];

  // Headbands at head and tail — the little striped rolls that cap a sewn
  // spine. 3 mm of object, and the only saturated colour anywhere on the closed
  // book, which is exactly why they are worth their triangles.
  for (const s of [-1, 1]) {
    const g = new THREE.TorusGeometry(spineR * 0.80, 0.0013, 6, 22, Math.PI);
    // Stripe from the ring angle BEFORE the geometry is rotated into place —
    // afterwards the ring is in the xz plane and atan2 of what used to be y is
    // meaningless.
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const ca = new THREE.Color(0xa8362b), cb = new THREE.Color(0xf2e3c2), cc = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      cc.copy(Math.floor(Math.atan2(p.getY(i), p.getX(i)) * 8.5) % 2 ? ca : cb);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // Into the spine's own frame: the arc has to run round the -x side.
    g.rotateX(Math.PI / 2);
    g.rotateY(-Math.PI / 2);
    // The spine is an ELLIPSE, not a circle (see spineGeometry's `flat`), so a
    // circular headband pokes straight through it at the crown. Squash it by
    // the same factor and it sits in the joint where it belongs.
    g.scale(SPINE_FLAT, 1, 1);
    const hb = new THREE.Mesh(g, M.headband);
    hb.position.set(0.0002, s * (H / 2 - 0.0016), 0);
    root.add(hb);
    headbands.push(hb);
  }

  // ── the text block ────────────────────────────────────────────────────────
  // Two instanced stacks, left and right of the fold. Poses are written every
  // frame by `poseJournal`; what is fixed here is the per-slab jitter, which
  // has to be stable or the fore edge boils.
  // A slab at its NOMINAL size, not a unit cube, with per-instance scales near
  // 1. That is not cosmetic: gallery.html sizes and frames an object from
  // `geometry.boundingBox` transformed by the MESH's matrix, with no knowledge
  // of instanceMatrix — so a unit-cube slab reported the whole journal as
  // "1.00 x 1.00 x 1.00 m" and the gallery framed a 15 cm book as a metre box,
  // leaving it a speck in the middle of the stage.
  //
  // ── the gutter gradient, and why it is in the vertex colours ────────────
  // Cream paper running right up to the fold is half of why the spine used to
  // read as a foreign object lying on the book: a real gutter is the darkest
  // thing on a spread, and the block's exposed top surface was the same value
  // at the fold as at the fore edge. The printed leaves paint their own fold
  // shadow (journal_page's `_gutterShade`); the STACK had none.
  //
  // It is three vertex columns rather than a map because a map on 26 instanced
  // slabs is a second texture bind for a surface that is 15 mm of gradient.
  // The middle column is pushed in to ~18 mm so the ramp is short and steep
  // instead of running the whole width of the page — and the two stacks get
  // MIRRORED copies, because the left stack's fold is on its other side and a
  // shared geometry would darken its fore edge.
  const GUT_DARK = 0.34, GUT_RAMP = 0.018;
  const slabGeometry = (sign) => {
    const g = new THREE.BoxGeometry(W, H, T / LEAVES, 2, 1, 1);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      if (Math.abs(x) < W * 0.25) { x = sign * (-W / 2 + GUT_RAMP); pos.setX(i, x); }
      // Distance from the fold, which is at -W/2 for the right stack and
      // +W/2 for the left one.
      const d = sign > 0 ? x + W / 2 : W / 2 - x;
      const v = GUT_DARK + (1 - GUT_DARK) * smoothstep(0, GUT_RAMP, d);
      col[i * 3] = v; col[i * 3 + 1] = v * 0.995; col[i * 3 + 2] = v * 0.985;
    }
    pos.needsUpdate = true;
    // See the note on `paper`: instanceColor is only multiplied in when
    // USE_COLOR is defined, so this attribute earns its place twice.
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const mkStack = (sign) => {
    const im = new THREE.InstancedMesh(slabGeometry(sign), M.paper, LEAVES);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(LEAVES * 3), 3);
    const jit = [];
    for (let i = 0; i < LEAVES; i++) {
      // Slightly narrower, slightly shorter, slightly offset, slightly a
      // different cream — at random, per slab. Three numbers, and they are the
      // entire "many sheets" read.
      jit.push({
        dw: 1 - rnd() * 0.007,
        dh: 1 - rnd() * 0.004,
        dx: (rnd() - 0.5) * 0.0008,
        tone: 0.93 + rnd() * 0.11,
      });
      const t = jit[i].tone;
      im.instanceColor.setXYZ(i, t, t * 0.995, t * 0.962);
    }
    im.instanceColor.needsUpdate = true;
    im.userData = { jit, sign };
    im.frustumCulled = false;
    return im;
  };
  const stackR = mkStack(+1);
  const stackL = mkStack(-1);
  root.add(stackR, stackL);

  // ── the four printed leaves ───────────────────────────────────────────────
  // Two at rest and two faces of one leaf in flight. Assigning a texture is a
  // per-frame material swap rather than a mesh per page, so a forty-page book
  // costs the same as a four-page one.
  const PG = { su: 26, sv: 6 };
  const leafGeo = () => new THREE.PlaneGeometry(W - 0.0018, H - 0.0018, PG.su, PG.sv);
  const mkLeaf = (geo, mat) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  };
  const pageRight = mkLeaf(leafGeo(), M.pageA);
  const pageLeft = mkLeaf(leafGeo(), M.pageB);
  const turnGeo = leafGeo();
  const turnFront = mkLeaf(turnGeo, M.pageC);
  const turnBack = mkLeaf(turnGeo, M.pageD);
  root.add(pageRight, pageLeft, turnFront, turnBack);

  // ── sewing thread across the gutter ───────────────────────────────────────
  // Only ever visible when the book is open, which is when it is looked at.
  // Four stations of linen crossing the fold, sitting just above the bottom of
  // the block so the leaves close over them.
  const threads = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const g = new THREE.CapsuleGeometry(0.00044, 0.0105, 2, 5);
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, M.thread);
    m.position.set(0, -H / 2 + H * (0.16 + i * 0.226), zBot + CLEAR + 0.0018);
    m.rotation.y = (i % 2 ? 1 : -1) * 0.55;
    threads.add(m);
  }
  root.add(threads);

  const ribbon = mkLeaf(ribbonGeometry(26), M.ribbon);
  // The ribbon's own contact shadow, and it is worth its 200 triangles: a
  // strip of silk with no shadow does not lie ON the page, it hovers a
  // millimetre above it, and that is most of what made the marker read as a
  // drawn UI element. Only the ON-PAGE run — the hanging tail has nothing to
  // cast onto and a shadow following it into mid-air is worse than none.
  // Drawn transparent and depth-tested, so where the ribbon covers it the
  // shadow is simply rejected and only the millimetre that escapes shows.
  const ribbonShade = mkLeaf(ribbonGeometry(18), M.ribbonShade);
  ribbonShade.renderOrder = 2;
  const band = mkLeaf(ribbonGeometry(60), M.band);
  root.add(ribbon, ribbonShade, band);

  // ── contact shadow ────────────────────────────────────────────────────────
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(coverW * 3.1, coverH * 1.75), M.shadow);
  shadow.position.set(coverW * 0.5, 0, zBot - COV - 0.0014);
  shadow.renderOrder = -1;
  // The shadow plane is three times the width of the book, and gallery.html
  // frames a prop from the union of its meshes' `geometry.boundingBox` — so
  // the journal reported itself as 0.32 x 0.38 m instead of 0.16 x 0.22 and
  // the stage framed a 15 cm book as a stamp in the middle of an empty set.
  // A pre-set (degenerate) bounding box is honoured by every one of those
  // walks, and nothing else reads it: culling and picking use the SPHERE.
  shadow.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
  root.add(shadow);

  group.userData.journal = {
    dims: BOOK, colorway, mats: M,
    root, frontPivot, backPivot, spine, headbands, zHingeFlat, stackR, stackL, ribbonShade,
    pageRight, pageLeft, turnFront, turnBack, ribbon, band, shadow, threads,
    frontEndpaper: frontPivot.userData.endpaper,
    backEndpaper: backPivot.userData.endpaper,
    inside: false,
    state: { cover: 0, leaf: 0, sheets: 1, band: 0 },
  };

  poseJournal(group, { cover: open, leaf: 0, sheets: 1, band: open });
  setJournalPages(group, opts.pages ?? [], 0);
  return group;
}

/**
 * Point the four leaf materials at the right textures for the pose.
 *
 * `pages` is in reading order: page 2i is the front (recto) of leaf i and page
 * 2i+1 is its back (verso). A missing entry falls back to blank stock, which is
 * exactly right for the unused paper at the end of the book.
 *
 * Call this AFTER `poseJournal` — it is what finally decides leaf visibility,
 * because visibility is "has a texture" AND "the cover has let go of it", and
 * only this half knows the first.
 */
export function setJournalPages(group, pages, leaf) {
  const J = group.userData.journal;
  if (!J) return;
  const s = Math.floor(leaf + 1e-6);
  const f = leaf - s;
  const set = (mat, tex) => {
    const t = tex ?? blankLeaf();
    if (mat.map !== t) { mat.map = t; mat.emissiveMap = t; mat.needsUpdate = true; }
  };
  set(J.mats.pageB, pages[2 * s - 1]);
  set(J.mats.pageA, pages[f > 1e-4 ? 2 * s + 2 : 2 * s]);
  if (f > 1e-4) {
    set(J.mats.pageC, pages[2 * s]);
    set(J.mats.pageD, pages[2 * s + 1]);
  }
  J.pageRight.visible = J.inside;
  J.pageLeft.visible = J.inside && J.leftStack > 0.0005;
  J.turnFront.visible = J.turnBack.visible = J.inside && f > 1e-4;
}

/**
 * Pose every moving part.
 *
 * @param state {
 *   cover:  0..1   front cover, shut to lying flat open
 *   leaf:   float  0 = the first spread; the integer part counts turned leaves
 *                  and the fraction is the leaf currently in flight
 *   sheets: int    how many turnable leaves the book has (for the stack split)
 *   band:   0..1   elastic still round the covers, to slipped onto the back
 * }
 */
export function poseJournal(group, state) {
  const J = group.userData.journal;
  if (!J) return;
  const S = Object.assign(J.state, state);
  const { W, H, T, COV, SQ, LEAVES, CLEAR, GUT_INSET, PAGE_LIFT } = BOOK;
  const zTop = T / 2, zBot = -T / 2;

  J.frontPivot.rotation.y = Math.PI * clamp01(S.cover);

  // ── spine ─────────────────────────────────────────────────────────────────
  // The one part of the book that used to be posed by nothing at all. It
  // flattens and drops with the cover; see `poseSpine`. Re-laying it costs a
  // normal recompute over ~500 vertices, so it is gated on the cover actually
  // having moved — during the swing that is 40-odd frames, and at rest it is
  // free, which is the state the book spends all its time in.
  const ck = smoothstep(0, 1, clamp01(S.cover));
  if (J._spineK !== ck) {
    J._spineK = ck;
    poseSpine(J.spine.geometry, ck, J.zHingeFlat ?? 0);
    // The headbands ride the spine. Left where they were, they end up as two
    // striped half-tori standing 11 mm above a flat spread, which is the same
    // bug as the ridge and twice as odd-looking because they are the only
    // saturated colour in the frame. Open, they settle into the ends of the
    // gutter as a small roll, which is what a real one does.
    for (const hb of J.headbands ?? []) {
      hb.scale.set(1 + 0.15 * ck, 1, 1 - 0.58 * ck);
      hb.position.z = ck * ((J.zHingeFlat ?? 0) + 0.0048);
    }
  }

  // ── stacks ────────────────────────────────────────────────────────────────
  const sheets = Math.max(1, S.sheets | 0);
  const frac = clamp01(S.leaf / sheets);
  // Nothing inside the book exists until the cover is most of the way off it,
  // or the left stack pops out from under a cover that has not moved yet.
  const gate = smoothstep(0.50, 0.94, clamp01(S.cover));
  const TB = T - CLEAR * 2;                    // the block, inside the boards
  const zFloor = zBot + CLEAR;
  const tL = TB * frac * gate;
  const tR = TB - tL;
  const zL = zFloor + tL, zR = zFloor + tR;
  J.leftStack = tL;
  J.inside = gate > 0.02;

  const m = _poseM, q = _poseQ, v = _poseV, sc = _poseS;
  q.identity();
  for (const im of [J.stackR, J.stackL]) {
    const sign = im.userData.sign;
    const th = sign > 0 ? tR : tL;
    // How many slabs this side is showing. An InstancedMesh has no per-instance
    // visibility and a zero-thickness slab still catches a specular line, so
    // the unused ones are parked at zero SCALE, not zero height.
    const n = Math.round(LEAVES * (th / TB));
    const step = n > 0 ? th / n : 0;
    for (let i = 0; i < LEAVES; i++) {
      if (i >= n) { m.makeScale(0, 0, 0); im.setMatrixAt(i, m); continue; }
      const j = im.userData.jit[i];
      const u = n > 1 ? i / (n - 1) : 0.5;
      // Concave fore edge: the middle of the stack sits a hair proud of the
      // ends, which is what a sewn and rounded text block does.
      const bulge = 1 - 0.011 * (1 - (2 * u - 1) ** 2);
      // The higher a leaf sits in the block, the further its inner edge stands
      // off the fold — that is what turns a cliff at the gutter into a curve.
      // See the header: without it the recto's inner margin is buried.
      const inset = GUT_INSET * u;
      const w = (W - 0.0014 - inset) * j.dw * bulge;
      sc.set(w / W, ((H - 0.0012) * j.dh) / H, (step * 0.86) / (T / LEAVES));
      v.set(sign * (inset + w / 2 + 0.0007) + j.dx, 0, zFloor + step * (i + 0.5));
      m.compose(v, q, sc);
      im.setMatrixAt(i, m);
    }
    im.instanceMatrix.needsUpdate = true;
    im.visible = J.inside && n > 0;
  }

  // ── leaves ────────────────────────────────────────────────────────────────
  const f = S.leaf - Math.floor(S.leaf + 1e-6);
  deformPage(J.pageRight.geometry, 0, zR + PAGE_LIFT, zL + PAGE_LIFT);
  deformPage(J.pageLeft.geometry, 1, zR + PAGE_LIFT, zL + PAGE_LIFT);
  if (f > 1e-4) deformPage(J.turnFront.geometry, f, zR + PAGE_LIFT + 0.0005, zL + PAGE_LIFT + 0.0005);

  J.threads.visible = J.inside;
  J.ribbon.visible = J.inside;

  // gallery.html frames a prop from the union of its meshes' geometry bounding
  // boxes and knows nothing about `visible`. The LEFT leaf is posed flat-open
  // at all times (`deformPage(..., 1, ...)`) and simply not drawn while the
  // book is shut, so a closed journal reported itself 300 mm wide — twice its
  // own width — and the stage framed it accordingly. Hidden leaves contribute
  // nothing; visible ones go back to being measured. Written only when the
  // state flips, so this allocates nothing per frame.
  //
  // The text block has the same problem one level worse: the slab geometry is
  // at NOMINAL size and centred on the mesh origin, which is the HINGE, so its
  // own box sits a whole page-width to the left of where any instance actually
  // is — and `instanceMatrix` is invisible to that walk. Each stack is handed
  // the extent it really occupies instead. The marker ribbon goes in the same
  // list: 38 mm of it hangs below the tail edge, which is a real part of the
  // OPEN book and nothing at all while it is shut.
  if (J._boundsInside !== J.inside) {
    J._boundsInside = J.inside;
    for (const m of [J.pageLeft, J.pageRight, J.turnFront, J.turnBack, J.ribbon, J.ribbonShade]) {
      m.geometry.boundingBox = J.inside ? null : _emptyBox;
    }
    J.stackR.geometry.boundingBox = J.inside ? _stackBoxR : _emptyBox;
    J.stackL.geometry.boundingBox = J.inside ? _stackBoxL : _emptyBox;
  }

  // ── ribbon marker ─────────────────────────────────────────────────────────
  // Down the right-hand leaf a little way in from the fold, and over the tail
  // edge to hang below the book. The first version ran it diagonally from the
  // head of the spine to the fore edge, which is a thing a real ribbon does and
  // which, at 11 mm wide across a 148 mm page, read as a luggage strap: it cut
  // the page in half and it was the first thing the eye landed on. Narrow, and
  // parallel to the gutter, it is a detail instead of a feature.
  //
  // ── and it has to be CLOTH ────────────────────────────────────────────────
  // The first version of this was geometrically correct and read as the most
  // obviously programmer-art thing in the frame: dead straight, dead flat,
  // one uniform value from head to tail, with a hard edge and no weight. Three
  // things fix it, and none of them is a texture:
  //   · it WANDERS. A slow lateral drift of about a millimetre, plus a lift
  //     off the paper in the middle — a ribbon lying in a book is not glued
  //     down, it touches at the ends and bows in between;
  //   · the free end CURLS and TWISTS as it comes over the tail edge, so the
  //     hanging tail shows its back and catches a different value;
  //   · a cambered cross-section (`roll`), so the broad face has a satin
  //     gradient across its width rather than one flat tone.
  {
    const pts = [];
    const xr = W * 0.030;
    const yTop = H / 2 - 0.006;
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      if (u < 0.70) {
        const k = u / 0.70;
        // Drift and bow. A ribbon left in a book does not run parallel to the
        // gutter — it lies where it fell. The drift is 2.4 mm over the page,
        // which is under half its own width, and the bow is 0.7 mm: the whole
        // difference between "lying on the page" and "printed on the page".
        const drift = (Math.sin(k * 4.1 + 0.4) + 0.4 * Math.sin(k * 7.7 - 1.1)) * 0.0017;
        const bow = Math.sin(Math.PI * k) * 0.0007;
        pts.push(new THREE.Vector3(
          xr + k * 0.010 + drift,
          yTop - k * (H - 0.012),
          zR + PAGE_LIFT + 0.0006 + bow));
      } else {
        // Over the tail edge, and hanging with a curl in it.
        const k = (u - 0.70) / 0.30;
        const a = Math.min(1, k * 1.9) * Math.PI * 0.5;
        pts.push(new THREE.Vector3(
          xr + 0.010 + Math.sin(k * 2.6) * 0.0026,
          -H / 2 - 0.006 - k * 0.032,
          zR + PAGE_LIFT + 0.0006 - (1 - Math.cos(a)) * 0.0075 - k * k * 0.0035));
      }
    }
    fillRibbon(J.ribbon.geometry, pts, 0.0028, 0.00042, _xAxis, { roll: 0.62, twist: 0.62 });
    // The shadow: the first 19 sections, nudged down-page and hard onto the
    // paper, a shade wider than the ribbon so a millimetre escapes on the side
    // the key light is not on.
    const spts = [];
    for (let i = 0; i <= 18; i++) {          // pts[0..18] is exactly the on-page run
      const q = pts[i];
      spts.push(new THREE.Vector3(q.x + 0.00085, q.y - 0.0009, zR + PAGE_LIFT + 0.00022));
    }
    fillRibbon(J.ribbonShade.geometry, spts, 0.0031, 0.00005, _xAxis, { roll: 0 });
    J.ribbonShade.visible = J.inside;
  }

  // ── elastic band ──────────────────────────────────────────────────────────
  // A closed loop in the plane x = 0.80 W: down the front cover, round the
  // tail, up the back cover, round the head. `band` slides the FRONT RUN down
  // onto the back cover, which is the band coming off — one lerp, because the
  // loop is described by where its two long runs sit rather than by keyframes.
  {
    const off = clamp01(S.band);
    const zBack = zBot - COV - 0.0010;
    const zFrontShut = zTop + COV + 0.0010;
    const zRun = zFrontShut + (zBack + 0.0024 - zFrontShut) * off;
    const xb = W * 0.80;
    const hy = H / 2 + SQ + 0.0014;
    const pts = [];
    const N = 60;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 4;
      let y, z;
      if (u < 1) { y = -hy + 2 * hy * u; z = zRun; }                       // front run
      else if (u < 2) {                                                    // round the head
        const a = (u - 1) * Math.PI;
        y = hy + Math.sin(a) * 0.0032;
        z = zRun + (zBack - zRun) * (1 - Math.cos(a)) * 0.5;
      } else if (u < 3) { y = hy - 2 * hy * (u - 2); z = zBack; }          // back run
      else {                                                               // round the tail
        const a = (u - 3) * Math.PI;
        y = -hy - Math.sin(a) * 0.0032;
        z = zBack + (zRun - zBack) * (1 - Math.cos(a)) * 0.5;
      }
      pts.push(new THREE.Vector3(xb, y, z));
    }
    fillRibbon(J.band.geometry, pts, 0.0039, 0.00060, _xAxis);
  }

  // ── contact shadow ────────────────────────────────────────────────────────
  // Widens and slides as the book opens: the footprint really does double.
  const sp = smoothstep(0, 1, clamp01(S.cover));
  J.shadow.scale.set(0.42 + 0.58 * sp, 1, 1);
  J.shadow.position.x = (W + SQ) * (0.5 - 0.5 * sp);
}

const _poseM = new THREE.Matrix4();
const _poseQ = new THREE.Quaternion();
const _poseV = new THREE.Vector3();
const _poseS = new THREE.Vector3();
const _emptyBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
const _stackBoxR = new THREE.Box3(
  new THREE.Vector3(0, -BOOK.H / 2, -BOOK.T / 2), new THREE.Vector3(BOOK.W, BOOK.H / 2, BOOK.T / 2));
const _stackBoxL = new THREE.Box3(
  new THREE.Vector3(-BOOK.W, -BOOK.H / 2, -BOOK.T / 2), new THREE.Vector3(0, BOOK.H / 2, BOOK.T / 2));
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);

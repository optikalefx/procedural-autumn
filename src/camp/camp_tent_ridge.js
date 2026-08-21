// ─────────────────────────────────────────────────────────────────────────────
//  camp_tent_ridge — the A-frame.
//
//  `reference-art/tents/triangle-tent.jpg`: a classic ridge tent, and the one
//  shape in the tent folder that `camp_tent.js` cannot make. That module is a
//  superellipsoid — plan outline times a vertical profile, both closing to a
//  crown — and every knob on it produces a dome. Its colourway 2 is even
//  authored "off the A-frame plate", but what it inherited from that plate was
//  the cream-and-red PALETTE, not the shape, and a cream dome is still a dome.
//  So the A-frame was in the reference folder and never in the game. This is it.
//
//  WHAT MAKES IT AN A-FRAME
//
//  Not "a tent with sloped sides" — a dome has those. Four things, and if any
//  one of them is missing the prop reads as a wedge someone modelled:
//
//    · a RIDGE. A horizontal line, the full length of the tent, where two flat
//      planes meet at an angle you can see. It is the whole silhouette.
//    · TWO A-POLES, one at each end, whose legs run down the four corner seams
//      from the ridge ends to the four ground corners. In the plate those legs
//      are the red piped edges, and they are the second thing the eye finds.
//    · FLAT PANELS. A dome's fabric is doubly curved everywhere; an A-frame's
//      is four nearly developable sheets. Fabric that is flat in one direction
//      creases in long straight folds running down the fall line, which is a
//      completely different crease language from a dome's radial gathering.
//    · ENDS THAT LEAN IN. The ridge is shorter than the floor, so each end is a
//      leaning trapezoid, and the door cut into it is a triangle rather than a D.
//
//  CONSTRUCTION
//
//  One closed shell, `surf(s, t)`, exactly one patch family, no bag of quads:
//
//    · `s` runs once around the PERIMETER, 0 at the middle of the rear end and
//      0.5 at the middle of the door end. It is not an angle. A dome can use
//      atan2 because its plan is star-shaped and roughly round; a plan that
//      collapses to a line segment at the ridge cannot, because uniform samples
//      in angle pile up at the ridge ENDS and leave the middle of the ridge with
//      almost no vertices. The outline is therefore a rounded rectangle walked
//      by arc length, with the four straight edges and four corner arcs each
//      given a fixed slice of `s` — so a seam sits at a fixed `s` at every
//      height, and the four seams sweep out the A-poles for free.
//    · `t` runs 0 at the hem to 1 at the ridge. Half-width goes to ZERO at
//      t = 1, which means the two sides of the shell meet along the ridge line
//      and close the tent with no cap patch at all. The `s` ranges of all three
//      patches are symmetric about the ridge, so the point at `s` and the point
//      at `1 - s` coincide exactly rather than nearly — see `disp()` for the one
//      thing that had to be gated to keep that true.
//
//  Door construction (three patches sharing one row table, so the ribs beside
//  the aperture are watertight by construction) is lifted wholesale from
//  `camp_tent.js`, as are the winding rule in `patch()`, the crease-as-vertex-
//  colour trick and the gain argument. Those were expensive lessons and there
//  is no reason for this prop to relearn them.
//
//  Sizes are real gear: a 3P A-frame is 1.9 m long, 1.44 m wide and 1.10 m at
//  the ridge, which is a little longer and a lot flatter-topped than the 2P dome
//  beside it in the gallery. The pair should not look like one tent twice.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  Parts, M, at, span, rbox, tube, rod, sweptArc,
  patch, fan, ribbon, orient, lanternMaterial,
  tintOf, sanitizeNormals,
} from './camp_materials.js';
import { lerp, clamp, clamp01, smoothstep } from '../core/MathUtils.js';

const TAU = Math.PI * 2;
const PI = Math.PI;
const HALF = Math.PI / 2;

// Corner radius of the plan outline at the hem, as a fraction of each half
// extent. This is what stops the four corner seams being knife edges: a pitched
// tent's corner is a 150 mm roll of fabric over a pole, not a fold.
const FX0 = 0.26, FZ0 = 0.20;

// The door sill, and how far up the end wall the aperture reaches.
const SILL_Y = 0.105, T_DOOR = 0.80;

// Fly-to-inner clearance. Same argument as camp_tent's INNER_GAP: build the
// inner as an OFFSET of the smooth fly rather than as a scaled copy, and the
// two can never intersect however deep the panel slack gets.
const INNER_GAP = 0.058;
// Where the inner tent stops. It cannot follow the fly to t = 1: at the ridge
// the fly's own normal rakes outward at about 45°, so an inward offset applied
// to both halves swaps them across the centre line and the inner tent turns
// itself inside out in the last 60 mm. Stopping at 0.94 with a tapering gap
// leaves the two halves 60 mm apart, closed by a cap of their own.
const INNER_TOP = 0.94;

// ─────────────────────────────────────────────────────────────────────────────
//  Colourways
//
//  Four, to match TENT_COLORWAYS, because the layout hands a tent
//  `colorway: floor(rnd() * 4)` without knowing which of the two builders will
//  receive it — four and four is the only pair of table lengths that keeps that
//  draw uniform for both.
//
//  Each one changes the STRUCTURE as well as the hue, for camp_tent's reason:
//  the solver only ever pitches one tent, so a colourway that is a hue swap is
//  four renders of the same object. `wallBow` under 1 bows the walls outward
//  like a tent someone over-tensioned, over 1 pulls them in taut and straight;
//  `endLean` is how much shorter the ridge is than the floor, which is the
//  difference between a scout tent and a pup tent.
// ─────────────────────────────────────────────────────────────────────────────
export const RIDGETENT_COLORWAYS = [
  {
    // 0 — the plate. Cream fly over a taupe wall band, everything structural in
    //     red: ridge piping, all four pole seams, the door surround, the window
    //     binding. Same argument as camp_tent's `ridgeline` — a granite boulder
    //     in this valley sits mid-grey, so the fly is pushed to a near-white
    //     cream and the tent reads by VALUE before it reads by hue.
    name: 'timberline', gain: 1.38,
    fly: 0xeae2cf, flyAlt: 0xdbd2ba, accent: 0xc03a28, trim: 0x8f2b20,
    band: 0x6f5c45, bandT: 0.30,
    inner: 0x6a5a42, floor: 0x5b4a34, pole: 0xb0b4b8,
    WX: 0.72, LZ: 0.94, H: 1.10, endLean: 0.14, wallBow: 0.94,
    doorOpen: true, sideGuys: false, window: true,
  },
  {
    // 1 — proofed cotton canvas with bottle-green kit. Tall, narrow and almost
    //     straight-ended: a scout ridge tent is pitched to stand up in, not to
    //     crawl into, and at endLean 0.06 the ends are nearly vertical
    //     trapezoids. The green does the work camp_tent's blue does on the grey
    //     cabin — without it this is a beige tent in a beige valley.
    name: 'scoutmaster', gain: 1.20,
    fly: 0xd9cca8, flyAlt: 0xcabd99, accent: 0x2f4c37, trim: 0x1d3122,
    band: 0x3e5240, bandT: 0.26,
    inner: 0x5d5340, floor: 0x4a4634, pole: 0xa9aeb3,
    WX: 0.62, LZ: 1.00, H: 1.24, endLean: 0.06, wallBow: 1.06,
    doorOpen: false, sideGuys: true, window: true,
  },
  {
    // 2 — the 1970s pup tent: low, wide, squat, bowed walls, and the blue-over-
    //     mustard two-tone that every one of them was made in. At H 0.92 it is
    //     the shortest thing in the camp, which is worth having — four props all
    //     about a metre tall is a skyline with no incident in it.
    name: 'lakeshore', gain: 1.16,
    fly: 0x35719c, flyAlt: 0x2c6289, accent: 0xe8c65a, trim: 0x1d3d55,
    band: 0xc9a13c, bandT: 0.34,
    inner: 0x4a4234, floor: 0x7d5b30, pole: 0xa9aeb3,
    WX: 0.78, LZ: 0.82, H: 0.92, endLean: 0.20, wallBow: 0.86,
    doorOpen: true, sideGuys: false, window: true,
  },
  {
    // 3 — forestry-service sage over charcoal, with an orange door surround so
    //     there is one warm thing on it. Guyed on all four flanks: this is the
    //     one that looks like it has been pitched somewhere with weather.
    name: 'ranger', gain: 1.24,
    fly: 0x8d9a7c, flyAlt: 0x7f8b6f, accent: 0xd4622a, trim: 0x2c3229,
    band: 0x3a3f38, bandT: 0.28,
    inner: 0x4f4a3c, floor: 0x413d33, pole: 0xb0b4b8,
    WX: 0.66, LZ: 0.98, H: 1.16, endLean: 0.11, wallBow: 1.00,
    doorOpen: false, sideGuys: true, window: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  buildRidgeTent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {()=>number} rnd    seeded RNG — every random choice goes through it
 * @param {object} opts       { colorway:int, wear:0..1 }
 * @returns {THREE.Group}     origin at ground centre, +Z is the door
 */
export function buildRidgeTent(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'camp_tent_ridge';
  const cw = RIDGETENT_COLORWAYS[(opts.colorway ?? 0) % RIDGETENT_COLORWAYS.length];
  const wear = clamp01(opts.wear ?? 0.4);
  const P = new Parts('ridgetent');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  const { WX, LZ, H } = cw;

  // Drawn up front and in a fixed order, because the RNG is shared with the
  // layout and a conditional draw would desync every prop placed after this one.
  const ph = [rnd() * TAU, rnd() * TAU, rnd() * TAU, rnd() * TAU];
  // Per-face slackness. A tent nobody re-tensioned has one baggy panel, and on
  // an A-frame that is far more obvious than on a dome because the panel it is
  // baggy on is otherwise flat.
  const faceSlack = [0.80 + rnd() * 0.55, 0.80 + rnd() * 0.55,
                     0.80 + rnd() * 0.55, 0.80 + rnd() * 0.55];
  const hemJit = [rnd(), rnd(), rnd(), rnd()];

  // ── the plan outline ───────────────────────────────────────────────────────
  //
  // A rounded rectangle in normalised coordinates: `ox`, `oz` in [-1, 1], scaled
  // by the half-extents at this height. Walked by `s`, which is allocated to the
  // eight pieces of the outline in proportion to their length AT THE HEM and
  // then held fixed for every height. Fixed is the point: it is what puts a seam
  // at one `s` all the way up, and what lets the shading recover which panel a
  // vertex is on without inverting anything.
  const fxOf = (t) => FX0 * (1 - 0.72 * t);
  const fzOf = (t) => FZ0 * (1 - 0.80 * Math.pow(t, 1.3));

  // Fractions: one long side `A`, one end `B`, one corner `C`. 2A + 2B + 4C = 1.
  let SA, SB, SC, PERIM;
  {
    const ex = 1 - FX0, ez = 1 - FZ0;
    const side = 2 * ez * LZ;
    const end = 2 * ex * WX;
    // Quarter of an ellipse with semiaxes (FX0·WX, FZ0·LZ), near enough.
    const rx = FX0 * WX, rz = FZ0 * LZ;
    const corner = (PI / 2) * Math.sqrt((rx * rx + rz * rz) / 2);
    PERIM = 2 * side + 2 * end + 4 * corner;
    SA = side / PERIM; SB = end / PERIM; SC = corner / PERIM;
  }
  // Segment breakpoints, starting at the middle of the REAR end and running
  // toward +x. Putting s = 0 there is what puts the door end at s = 0.5, so the
  // door band is |s - 0.5| < DOOR_S and never has to wrap.
  const B0 = SB / 2;                 // rear half-end  -> rear-right corner
  const B1 = B0 + SC;                // corner         -> +x side
  const B2 = B1 + SA;                // +x side        -> front-right corner
  const B3 = B2 + SC;                // corner         -> front end
  const B4 = B3 + SB;                // front end      -> front-left corner
  const B5 = B4 + SC;                // corner         -> -x side
  const B6 = B5 + SA;                // -x side        -> rear-left corner
  const B7 = B6 + SC;                // corner         -> rear half-end

  // The four pole seams: the midpoint of each corner arc.
  const SEAM = [B0 + SC / 2, B2 + SC / 2, B4 + SC / 2, B6 + SC / 2];
  // The faces they bound: 0 = +x side, 1 = door end, 2 = -x side, 3 = rear end.
  const FACE_W = [SEAM[1] - SEAM[0], SEAM[2] - SEAM[1],
                  SEAM[3] - SEAM[2], SEAM[0] + 1 - SEAM[3]];

  const _o = [0, 0];
  /** The normalised outline point at perimeter parameter `s` and height `t`. */
  const outline = (s, t) => {
    let q = s - Math.floor(s);
    const fx = fxOf(t), fz = fzOf(t);
    const ex = 1 - fx, ez = 1 - fz;
    let th;
    if (q < B0)      { _o[0] = ex * (q / B0);                 _o[1] = -1; }
    else if (q < B1) { th = ((q - B0) / SC) * HALF;
                       _o[0] = ex + fx * Math.sin(th);        _o[1] = -ez - fz * Math.cos(th); }
    else if (q < B2) { _o[0] = 1;                             _o[1] = lerp(-ez, ez, (q - B1) / SA); }
    else if (q < B3) { th = ((q - B2) / SC) * HALF;
                       _o[0] = ex + fx * Math.cos(th);        _o[1] = ez + fz * Math.sin(th); }
    else if (q < B4) { _o[0] = lerp(ex, -ex, (q - B3) / SB);  _o[1] = 1; }
    else if (q < B5) { th = ((q - B4) / SC) * HALF;
                       _o[0] = -ex - fx * Math.sin(th);       _o[1] = ez + fz * Math.cos(th); }
    else if (q < B6) { _o[0] = -1;                            _o[1] = lerp(ez, -ez, (q - B5) / SA); }
    else if (q < B7) { th = ((q - B6) / SC) * HALF;
                       _o[0] = -ex - fx * Math.cos(th);       _o[1] = -ez - fz * Math.sin(th); }
    else             { _o[0] = -ex * (1 - (q - B7) / B0);     _o[1] = -1; }
    return _o;
  };

  /**
   * Which panel `s` is on, packed as `face + u`.
   *
   * Packed rather than returned as an object because this runs once per vertex
   * on a 30 000-vertex shell and again for every one of them in the tint pass;
   * an allocation there is a megabyte of garbage per tent.
   */
  const faceAt = (s) => {
    const q = s - Math.floor(s);
    for (let i = 0; i < 4; i++) {
      const a = SEAM[i];
      const qq = q < a ? q + 1 : q;
      const u = (qq - a) / FACE_W[i];
      if (u >= 0 && u < 1) return i + u;
    }
    return 0;
  };
  /** Metres along the perimeter to the nearest pole seam. */
  const seamM = (s) => {
    const f = faceAt(s);
    const i = Math.floor(f), u = f - i;
    return Math.min(u, 1 - u) * FACE_W[i] * PERIM;
  };

  // ── the profile ────────────────────────────────────────────────────────────
  // Half-width closes to ZERO at the ridge — that is what makes the top an edge
  // rather than a crown, and it is also what closes the shell without a cap.
  // Half-length shrinks by `endLean`, which is what makes the ends lean in.
  const halfX = (t) => WX * Math.pow(clamp01(1 - t), cw.wallBow);
  const halfZ = (t) => LZ * (1 - cw.endLean * Math.pow(clamp01(t), 1.25));

  // Peg points: the four corners, the middle and thirds of each long side, and
  // the middle of each end. The hem is a catenary between them, so it sits ~15 mm
  // off the dirt at a peg and lifts to ~120 mm between — which is the gap you see
  // the bathtub floor through, and the second-loudest tell after flat fabric.
  const PEGS = [
    SEAM[0], SEAM[1], SEAM[2], SEAM[3], 0, 0.5,
    B1 + SA / 3, B1 + 2 * SA / 3, B5 + SA / 3, B5 + 2 * SA / 3,
  ];
  const hemLow = 0.014, hemRise = 0.098 + 0.030 * wear;
  const hemY = (s) => {
    let d = 1;
    for (let i = 0; i < PEGS.length; i++) {
      let e = Math.abs(s - PEGS[i]);
      e = Math.min(e, 1 - e);
      if (e < d) d = e;
    }
    const k = clamp01((d * PERIM) / 0.30);
    return hemLow + hemRise * Math.pow(k, 0.75) * (0.84 + 0.32 * hemJit[Math.floor(faceAt(s))]);
  };

  // The ridge dips a little between the two A-poles — a ridge pole is stiff but
  // it is a 9 mm tube over 1.9 m with a fly tensioned onto it, and a dead
  // straight ridge is the one thing that would make this read as a solid.
  const ridgeSag = 0.024 * H;

  const baseCore = (s, t, out) => {
    const o = outline(s, t);
    const flare = 1 + 0.048 * Math.pow(1 - t, 3.0);   // the wall kicks out at the tub
    out.set(halfX(t) * o[0] * flare, H * t, halfZ(t) * o[1] * flare);
    out.y -= ridgeSag * smoothstep(0.62, 1.0, t) * (1 - o[1] * o[1]);
    return out;
  };
  // The fly, with its hem cut. The inner tent uses `baseCore` — it has no hem to
  // lift, it goes to the dirt.
  const base = (s, t, out) => {
    baseCore(s, t, out);
    out.y += hemY(s) * Math.pow(1 - t, 3);
    return out;
  };

  const _n0 = new THREE.Vector3(), _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3();
  const _n3 = new THREE.Vector3(), _n4 = new THREE.Vector3();
  const normalAt = (s, t, out) => {
    const h = 0.0025;
    base(s + h, t, _n0); base(s - h, t, _n1); _n0.sub(_n1);                    // dP/ds
    base(s, Math.min(1, t + h), _n2); base(s, Math.max(0, t - h), _n1);
    _n2.sub(_n1);                                                              // dP/dt
    out.crossVectors(_n2, _n0);
    if (out.lengthSq() < 1e-12) return out.set(0, 1, 0);
    out.normalize();
    base(s, t, _n1);
    // Horizontal-radial plus a constant lift, so it still points the right way
    // along the ridge where the radial part goes to zero.
    if (out.x * _n1.x + out.z * _n1.z + out.y * 0.4 < 0) out.negate();
    return out;
  };

  // Guy-out anchors, in parameter space. The pucker they put in the fabric is
  // computed from these, so the geometry and the cord agree by construction.
  const ties = [];
  ties.push({ s: B1 + SA / 2, t: 0.60, ph: ph[0], slack: 0, reach: 0.50 });
  ties.push({ s: B5 + SA / 2, t: 0.60, ph: ph[1], slack: 0, reach: 0.50 });
  if (cw.sideGuys) {
    ties.push({ s: B1 + SA * 0.22, t: 0.44, ph: ph[2], slack: 0, reach: 0.42 });
    ties.push({ s: B1 + SA * 0.78, t: 0.44, ph: ph[3], slack: 0, reach: 0.42 });
    ties.push({ s: B5 + SA * 0.22, t: 0.44, ph: ph[1], slack: 0, reach: 0.42 });
    ties.push({ s: B5 + SA * 0.78, t: 0.44, ph: ph[0], slack: 0, reach: 0.42 });
  }
  // One line is always slightly slack. Factory-new gear reads as a shop display
  // and the eye finds the one thing that is not perfect before anything else.
  ties[Math.floor(rnd() * ties.length)].slack = 0.034 + 0.03 * wear;

  const heightGate = (t) => Math.pow(Math.sin(PI * Math.pow(clamp01(t), 0.86)), 1.25);

  /**
   * A sharpened sine — same period, but the wave spends longer near its extremes
   * and crosses zero faster. Coated fabric does not roll, it creases: it stays
   * flat and then turns a corner, and the exponent is what buys the corner.
   * (camp_tent's, and the argument there applies twice over here, because these
   * panels really are flat.)
   */
  const crease = (x) => {
    const q = Math.sin(x);
    return Math.sign(q) * Math.pow(Math.abs(q), 0.55);
  };

  /**
   * The smooth half of the displacement: the pole seam and the panel slack.
   *
   * Split out because the inner tent is built as a constant offset from THIS
   * rather than from the bare wedge — an offset surface cannot be pushed through
   * by the fly's own slack, and a fly through an inner tent comes out as
   * hard-edged black tears in the fabric.
   */
  const dispSmooth = (s, t) => {
    const dm = seamM(s);
    // The pole in its sleeve: a crease, not a swell. Narrow sigma so the fabric
    // leaves the arc quickly and the leg reads as a line from the ground to the
    // ridge end.
    //
    // The taper must reach EXACTLY zero at t = 1, and that is a watertightness
    // constraint, not a taste one. This is a displacement along the surface
    // normal, and at the ridge the two halves' normals point opposite ways in x —
    // so any surviving amplitude pushes them apart rather than moving them
    // together. At the ridge ends, where all four seams converge, the first cut
    // of this left 14 mm on the clock and parted the shell by 23 mm: a slot down
    // the top of the tent, hidden by the ridge piping from most angles, which is
    // the worst kind of defect to ship. `smoothstep` to 1.0 closes it.
    const seam = 0.024 * Math.exp(-Math.pow(dm / 0.075, 2))
               * (1 - smoothstep(0.88, 1.0, t));
    // The panel between two seams is pulled inward: zero gradient at each seam
    // and a minimum between. Zero gradient matters — the fabric has to leave the
    // crease tangentially or the seam gets a second, softer crease beside it.
    //
    // THREE lobes on the long sides, one on the ends.
    //
    // A dome has one lobe per gore because it is pegged at four corners and has
    // nothing in between. A ridge tent's flank is 1.9 m of hem pegged at its two
    // corners AND at two points between them — the same peg list the hem
    // catenary is cut from — so the fabric scallops in three shallow bays, not
    // in one deep dent. Frequency is also the safer bet under this renderer:
    // camp_tent's note is that the stylised lighting quantises diffuse into
    // bands, and a smooth swell shades as a hard-edged blotch rather than as a
    // swell. A dome hides that inside its own curvature; a flat panel has none
    // to hide it in, so the amplitude comes down to 26 mm as the count goes up.
    const f = faceAt(s);
    const i = Math.floor(f), u = f - i;
    const side = (i === 0 || i === 2);
    const lobes = side ? 3 : 1;
    const amp = (side ? 0.026 : 0.034) * ((WX + LZ) / 1.7);
    return seam - amp * (0.5 - 0.5 * Math.cos(TAU * u * lobes)) * heightGate(t) * faceSlack[i];
  };

  /**
   * The crease field: the wrinkles alone.
   *
   * Used TWICE — once to move the vertices and once to shade them. `fabric` runs
   * at roughness 0.94 with an env intensity of 0.22, so most of its light arrives
   * as flat hemisphere ambient and a 12 mm fold buys about eight per cent of
   * value on its own. Baking the same field into the vertex colour as a curvature
   * term costs nothing and survives any lighting.
   *
   * Every angular frequency is an integer multiple of the perimeter, so the
   * field closes on itself at s = 0 with no seam.
   */
  const dispDetail = (s, t) => {
    const th = TAU * s;
    // 0 on a seam, 1 well out into the panel.
    const tt = clamp01(seamM(s) / 0.34);
    const gate = heightGate(t);
    let w = 0;
    // Long folds down the fall line. On a developable panel these run more or
    // less straight from the ridge to the hem, so they drift only slowly with t —
    // which is the visual difference from a dome, where every fold converges on
    // the crown.
    w += 0.0125 * crease(8 * th + ph[0] + t * 1.1) * gate * tt;
    w += 0.0072 * crease(13 * th + ph[1] - t * 0.8) * gate;
    // Mid folds, amplitude modulated around the tent so some are creases and
    // some are barely there. Even spacing is the tell of a procedural wrinkle,
    // and it survives being squinted at.
    w += 0.0128 * crease(21 * th + ph[2] + t * 1.9) * gate
       * (0.42 + 0.58 * Math.sin(3 * th + ph[3]));
    w += 0.0048 * crease(34 * th + ph[3] - t * 2.4) * gate;
    // Cross folds where the fabric gathers above the hem.
    w += 0.0150 * crease(15 * th + ph[3]) * Math.exp(-t / 0.26) * (0.30 + 0.70 * tt);
    w += 0.0070 * Math.sin(10 * th + ph[0] * 1.7 + t * 8.0) * Math.exp(-t / 0.40) * tt;
    return w;
  };

  /** The guy-out stars: a cone at the anchor, a fan of creases, a pull to the hem. */
  const dispTies = (s, t) => {
    let w = 0;
    for (const gy of ties) {
      let ds = s - gy.s;
      ds -= Math.round(ds);
      const dx = ds * PERIM, dy = (t - gy.t) * H;
      const D = Math.hypot(dx, dy);
      w += 0.0095 * Math.exp(-(D / 0.048) * (D / 0.048));
      const k = D / 0.22;
      w += 0.0125 * Math.cos(5 * Math.atan2(dy, dx) + gy.ph) * k * Math.exp(-k * k * 0.7);
      if (t < gy.t) {
        w += 0.010 * Math.exp(-(dx / 0.075) * (dx / 0.075))
           * Math.pow(1 - t / gy.t, 0.7) * (t / gy.t);
      }
    }
    return w;
  };

  /**
   * Displacement along the surface normal, metres.
   *
   * `crown` is not cosmetic. The shell closes itself at the ridge because the
   * point at `s` and the point at `1 - s` are the same point there — and that
   * holds only while every term is symmetric under s -> 1 - s. `dispSmooth` is
   * (both halves see the same seam distance, and the slack term is gated to zero
   * at t = 1 by `heightGate`). The wrinkles are NOT: `crease(8·2π·s)` is odd
   * about s = 0, and the tie fan reads a signed angle. Left ungated they part the
   * two halves by about a millimetre along the whole ridge, and a crack you can
   * see the sky through is a defect that survives being squinted at. Folding
   * `crown` over both kills them before they get there — which is also correct
   * for its own sake, since fabric pulled over a ridge pole is taut and creases
   * nowhere near it.
   */
  const disp = (s, t) => {
    const crown = smoothstep(0.96, 0.45, t);
    return dispSmooth(s, t) + crown * (dispDetail(s, t) + dispTies(s, t));
  };

  const surf = (s, t, out) => {
    base(s, t, out);
    normalAt(s, t, _n3);
    return out.addScaledVector(_n3, disp(s, t));
  };

  // ── the door ───────────────────────────────────────────────────────────────
  // A triangle, not a D. The band of `s` it is cut from is constant, and the end
  // wall it is cut into narrows with height because the ends lean in, so the
  // aperture's sides converge on their own — the arch only has to bring the top
  // down at the jambs.
  const tSill = SILL_Y / H;
  const DOOR_S = Math.min(0.45 * FACE_W[1], 0.50 / PERIM);
  const doorTopT = (s) => {
    const x = Math.abs(s - 0.5) / DOOR_S;
    if (x >= 1) return tSill;
    return tSill + (T_DOOR - tSill) * Math.sqrt(1 - Math.pow(x, 2.6));
  };

  const outwardRef = (p, out) => out.set(p.x, 0.4, p.z);

  // ── recovering (s, t) from a position ──────────────────────────────────────
  //
  // The tint callbacks are handed world positions, and every interesting thing
  // they want to say — which panel is this, how far from a seam, where is the
  // wall band — is a function of (s, t). The outline is convex and star-shaped
  // about the origin, so the angle to a point is MONOTONE in s and a table
  // inverts it exactly. Built from the hem outline: near the ridge the mapping
  // degenerates (every point is at x ≈ 0, so the angle is ±π/2 whatever s is),
  // but everything that reads `s` up there is already gated to zero by `crown`.
  const NS = 384;
  const sAng = new Float32Array(NS + 1);
  for (let i = 0; i <= NS; i++) {
    const o = outline(i / NS, 0);
    let a = Math.atan2(o[1], o[0]);
    if (a < -HALF) a += TAU;                     // s = 0 is (0, -1) -> -π/2
    if (i && a < sAng[i - 1]) a += TAU;
    sAng[i] = a;
  }
  const sOf = (x, z) => {
    let a = Math.atan2(z / LZ, x / WX);
    if (a < -HALF) a += TAU;
    let lo = 0, hi = NS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sAng[mid] <= a) lo = mid; else hi = mid; }
    const d = sAng[hi] - sAng[lo];
    return (lo + (d > 1e-9 ? (a - sAng[lo]) / d : 0)) / NS;
  };

  // GAIN — the single most load-bearing number on this prop, and the argument is
  // camp_tent's verbatim: `fabric` runs at envMapIntensity 0.22, so a fly gets
  // 22% of the sky fill the terrain and the rocks get from their own shaders,
  // and a colourway authored to its swatch lands on screen parked between rock
  // and dirt. Vertex colour multiplies in linear space and is not clamped to 1,
  // so the whole colourway is authored PAST its swatch in order to land on it.
  const G = cw.gain ?? 1;
  const gainOf = (hex) => { const q = tintOf(hex); return [q[0] * G, q[1] * G, q[2] * G]; };
  const cA = gainOf(cw.fly), cB = gainOf(cw.flyAlt);
  const bandC = gainOf(cw.band), acc = gainOf(cw.accent);
  // Piping, binding and seam tape are the SAME accent at three quarters of its
  // value. They are 10-20 mm strips seen against a near-white fly, and at the
  // full colourway value a 22 mm binding round a window stopped reading as tape
  // and started reading as a rectangle drawn on the tent in marker pen. The flat
  // pieces — the door surround, the guy-out patches — keep the full value,
  // because area is what a colour needs in order to be worth its saturation.
  const accTape = [acc[0] * 0.76, acc[1] * 0.76, acc[2] * 0.80];
  // One value for every cord on the prop — guy lines, corner webbing, toggles.
  const cordTint = [1.18, 1.16, 1.06];
  const poleTint = tintOf(cw.pole);

  // The wall band's boundary, in world Y, as a function of s. Keyed off the hem
  // rather than off a flat height so it follows the cut: the hem lifts up to
  // 130 mm between pegs, and a band drawn at a constant Y would cross the piping
  // that marks it by that much and read as a printing error.
  const bandYAt = (s) => H * cw.bandT + hemY(s) * Math.pow(1 - cw.bandT, 3);

  const flyTint = (x, y, z) => {
    const s = sOf(x, z);
    const t = clamp01(y / H);
    const f = faceAt(s);
    const i = Math.floor(f), u = f - i;
    // Sides and ends are cut from different bolts, and the value step at the
    // seam makes the pole line read a third time — as geometry, as piping, and
    // as a colour boundary.
    const c0 = (i === 0 || i === 2) ? cA : cB;
    const c1 = (i === 0 || i === 2) ? cB : cA;
    const blend = 0.5 * smoothstep(0.5, 0.5 - 0.06, Math.abs(u - 0.5) - 0.44 + 0.5);
    let r = lerp(c0[0], c1[0], blend), gg = lerp(c0[1], c1[1], blend), b = lerp(c0[2], c1[2], blend);
    // Sun-bleached crown. UV kills a fly from the top down, and on a ridge tent
    // the top is a line rather than a dome, so the gradient has an edge to run
    // out from — it is most of what separates a used tent from a swatch.
    const bl = 1 + (0.038 + 0.080 * wear) * Math.pow(t, 2.2);
    r *= bl; gg *= bl * 0.995; b *= bl * 0.985;
    // Faint blotching so a panel is never one flat value.
    const bt = 1 - 0.055 * (0.5 + 0.5 * Math.sin(9 * u + y * 4.1 + ph[3])) * (0.4 + 0.6 * wear);
    r *= bt; gg *= bt; b *= bt;
    // The wall band. Not a 60% mix like the dome's hem valance — a full swap,
    // because on every A-frame ever made this is a different piece of cloth and
    // the line between them is the strongest horizontal on the prop.
    const by = bandYAt(s);
    const k = clamp01(smoothstep(by + 0.022, by - 0.016, y));
    r = lerp(r, bandC[0], k); gg = lerp(gg, bandC[1], k); b = lerp(b, bandC[2], k);
    // The hem's underside is in its own shadow, then dirt on the last 110 mm.
    const ao = 1 - 0.16 * clamp01(smoothstep(0.18, 0.02, y));
    const dk = clamp01(smoothstep(0.12, 0.0, y)) * (0.10 + 0.16 * wear);
    // Ground bounce, not dust: this tent stands on red dirt.
    r = (r * ao) * (1 - dk) + 1.05 * G * dk;
    gg = (gg * ao) * (1 - dk) + 0.76 * G * dk;
    b = (b * ao) * (1 - dk) + 0.58 * G * dk;
    // Shade the crease field — a curvature term, not a light. It is what makes
    // 12 mm of fold read at 20 m and in flat overcast, where the geometry alone
    // reads at neither.
    const crown = smoothstep(0.96, 0.45, t);
    const sh = 1 + clamp(dispDetail(s, t) * crown * 7.5, -0.17, 0.15);
    r *= sh; gg *= sh; b *= sh;
    // And the large form: panel centres are pulled in and see less sky, the pole
    // seams stand proud and see more. This is what makes the tent read as four
    // panels with a pole between them rather than as a solid wedge.
    // Deliberately gentler than camp_tent's 1.9 on a term that is already
    // smaller: a flat panel has no curvature of its own to hide a large-form
    // shading term inside, so anything low-frequency here reads as a stain.
    const sm = 1 + clamp(dispSmooth(s, t) * 1.35, -0.10, 0.06);
    r *= sm; gg *= sm; b *= sm;
    // Push the chroma back out. These props are manufactured objects in a
    // desaturated valley and the contrast is most of what makes them read as
    // somebody's kit rather than as terrain.
    const mean = (r + gg + b) / 3;
    return [
      Math.max(0, mean + (r - mean) * 1.16),
      Math.max(0, mean + (gg - mean) * 1.30),
      Math.max(0, mean + (b - mean) * 1.30),
    ];
  };

  // ── the fly ────────────────────────────────────────────────────────────────
  // Row table first. Every patch of the shell samples `t` from THIS and only
  // this, which is what makes the whole thing watertight: two patches that meet
  // along a rib put vertices at identical parameter values because they are
  // reading the same table, not because two independent formulae happen to
  // agree. The break at the sill is the door's; camp_tent's note on the crack a
  // mismatched rib leaves applies verbatim.
  const NTS = 5, NTU = 40, NT = NTS + NTU;
  const tRow = (k) => (k <= NTS
    ? (k / NTS) * tSill
    : tSill + ((k - NTS) / NTU) * (1 - tSill));
  /** The row index nearest a wanted height — how an aperture picks its edges. */
  const kOf = (t) => clamp(Math.round(NTS + ((t - tSill) / (1 - tSill)) * NTU), NTS + 1, NT - 1);
  const NU_ALL = 264;

  // ── the apertures ──────────────────────────────────────────────────────────
  //
  // A window is a HOLE. The first cut of this hung a mesh panel 16 mm behind an
  // intact wall with a binding drawn round it on the outside, which rendered as
  // exactly what it was: a red rectangle felt-tipped onto the tent, with the
  // screen invisible behind two layers of opaque fly. Fabric is not glass.
  //
  // So the shell is emitted as RUNS between the apertures, and an aperture is a
  // run split into a piece below it and a piece above it. Both pieces read the
  // row table, so their ribs match the neighbouring solid runs exactly, and the
  // rectangle between them is genuinely missing. The sides of the aperture are
  // vertical in (s, t) — which on a wall that both curves and leans in becomes
  // the tapered trapezoid the plate shows, without anything having to taper it.
  const CUTS = [];
  {
    const winHW = Math.min(0.36 / PERIM, FACE_W[0] * 0.36);
    if (cw.window) {
      // Sits entirely ABOVE the wall band. The first cut ran it from t 0.22,
      // which put its lower third in the taupe and let the band's own binding
      // run straight across the glass — two seams crossing at a right angle in
      // the middle of a window, which no tent has ever had.
      const kW = [kOf(cw.bandT + 0.055), kOf(cw.bandT + 0.355)];
      // Both flanks. A window on one side only reads as damage from the other.
      CUTS.push({ c: B5 + SA / 2, hw: winHW, k0: kW[0], k1: kW[1], hood: 0.042, roll: true });
      CUTS.push({ c: B1 + SA / 2 + 1, hw: winHW, k0: kW[0], k1: kW[1], hood: 0.042, roll: true });
    }
    // The rear vent, under the back apex. The back of a tent is the half of the
    // silhouette the player drives past, and without this it is a blank triangle.
    CUTS.push({ c: 1.0, hw: 0.185 / PERIM, k0: kOf(0.56), k1: kOf(0.72), hood: 0.055, roll: false });
    CUTS.sort((a, b) => a.c - b.c);
  }

  // The runs, in order from one side of the door round to the other.
  {
    const edges = [0.5 + DOOR_S];
    for (const q of CUTS) { edges.push(q.c - q.hw, q.c + q.hw); }
    edges.push(1.5 - DOOR_S);
    const nuFor = (a, b) => Math.max(4, Math.round(NU_ALL * (b - a)));
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a = edges[i], b = edges[i + 1];                        // a solid run
      P.add(patch((u, k, out) => surf(lerp(a, b, u), tRow(k * NT), out),
        nuFor(a, b), NT, outwardRef), 'fabric', null, flyTint);
    }
    for (const q of CUTS) {                                        // and a holed one
      const a = q.c - q.hw, b = q.c + q.hw;
      const nu = nuFor(a, b);
      P.add(patch((u, k, out) => surf(lerp(a, b, u), tRow(k * q.k0), out),
        nu, q.k0, outwardRef), 'fabric', null, flyTint);
      P.add(patch((u, k, out) => surf(lerp(a, b, u), tRow(q.k1 + k * (NT - q.k1)), out),
        nu, NT - q.k1, outwardRef), 'fabric', null, flyTint);
    }
  }

  // The door band: the aperture's arch above, its sill below. Same split, and
  // FRONT's rows are a uniform walk of [doorTop, 1] which at the ribs is exactly
  // the table's upper rows — see camp_tent, where this was worked out.
  {
    const NU_F = Math.max(14, Math.round(NU_ALL * DOOR_S * 2));
    P.add(patch((u, k, out) => {
      const sv = 0.5 - DOOR_S + u * DOOR_S * 2;
      return surf(sv, lerp(doorTopT(sv), 1, k), out);
    }, NU_F, NTU, outwardRef), 'fabric', null, flyTint);

    P.add(patch((u, k, out) => {
      const sv = 0.5 - DOOR_S + u * DOOR_S * 2;
      return surf(sv, tRow(k * NTS), out);
    }, NU_F, NTS, outwardRef), 'fabric', null, flyTint);
  }

  // ── the ridge ──────────────────────────────────────────────────────────────
  // The line the whole silhouette hangs off. It is a piped seam rather than an
  // exposed pole: on a real A-frame the ridge pole is inside, and what you see
  // from outside is 25 mm of doubled, corded, contrast-bound fabric — which is
  // also, conveniently, exactly what covers the knife edge where the two halves
  // of the shell meet.
  P.add(sweptArc((k) => {
    const sv = lerp(0.0005, 0.4995, k);
    const p = surf(sv, 1, new THREE.Vector3());
    return p.add(V(0, 0.006, 0));
  }, 30, 0.0135, 5), 'fabric', null, accTape);

  // The two ends of the ridge pole, poking out of the apex where the A-poles
  // meet it and the ridge lines are tied on. Two bright 60 mm marks at the very
  // top of the prop: the cheapest thing on it that says there is a frame inside.
  const apex = [];
  for (const end of [0.5, 0.0]) {
    const a = surf(end === 0.5 ? 0.4995 : 0.0005, 1, new THREE.Vector3());
    const outZ = end === 0.5 ? 1 : -1;
    const tip = V(a.x, a.y + 0.004, a.z + outZ * 0.058);
    apex.push(tip);
    P.add(tube(0.0088, a.distanceTo(tip), 6), 'alu', span(a, tip, M()), poleTint);
    P.add(rbox(0.019, 0.015, 0.013, 0.004), 'plastic',
      at(tip.x, tip.y, tip.z, 0, 0, 0), [1, 1, 1]);
  }

  // ── the pole seams ─────────────────────────────────────────────────────────
  // Four piped edges from the ground corners to the ridge ends. In the plate
  // these are red and they are the second thing you see; without them the tent
  // is a wedge with a crease down each corner and reads as one folded sheet.
  const seamCurve = (k, sm, t0 = 0.010, t1 = 0.998) => {
    const t = lerp(t0, t1, k);
    const p = surf(sm, t, new THREE.Vector3());
    return p.addScaledVector(normalAt(sm, t, new THREE.Vector3()), 0.008);
  };
  for (const sm of SEAM) {
    P.add(sweptArc((k) => seamCurve(k, sm), 22, 0.0105, 5), 'fabric', null, (x, y) => {
      // Scuffed and dusty where the sleeve meets the dirt.
      const k = clamp01(smoothstep(0.15, 0.0, y)) * 0.22;
      return [accTape[0] * (1 - k) + 1.10 * k, accTape[1] * (1 - k) + 1.00 * k, accTape[2] * (1 - k) + 0.84 * k];
    });
  }

  // ── the wall band's binding ────────────────────────────────────────────────
  // A cord of the accent along the seam between the two fabrics. The colour step
  // is already there in the vertex colour; this gives it a highlight and a
  // shadow so it is a SEAM and not a printed line.
  //
  // It stops at the door jambs. Run all the way round, it crosses the doorway —
  // a cord hanging in mid-air across an open door, which is what the first cut
  // shipped and is the single most obvious wrong thing a prop can have.
  P.add(sweptArc((k) => {
    const sv = lerp(0.5 + DOOR_S, 1.5 - DOOR_S, k);
    const p = surf(sv, cw.bandT, new THREE.Vector3());
    return p.addScaledVector(normalAt(sv, cw.bandT, new THREE.Vector3()), 0.005);
  }, 80, 0.0072, 4), 'fabric', null, accTape);

  // ── door: reveal, binding, zip, pulls ──────────────────────────────────────
  // The reveal is the whole trick. A hole cut in a single-sided shell is a paper
  // edge; turning 60 mm of fabric inward gives the aperture a lip that catches
  // light along its top and goes black down its sides, which is what says there
  // is a volume behind this.
  const arch = [];
  {
    const n = 54;
    for (let i = 0; i <= n; i++) {
      const sv = 0.5 - DOOR_S * 0.999 + (i / n) * DOOR_S * 1.998;
      const t = doorTopT(sv);
      arch.push({ sv, t, p: surf(sv, t, new THREE.Vector3()), n: normalAt(sv, t, new THREE.Vector3()) });
    }
  }
  const sillLine = [];
  {
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const sv = 0.5 + DOOR_S * 0.999 - (i / n) * DOOR_S * 1.998;
      sillLine.push({ sv, t: tSill, p: surf(sv, tSill, new THREE.Vector3()), n: normalAt(sv, tSill, new THREE.Vector3()) });
    }
  }
  const loop = arch.concat(sillLine);
  const archC = new THREE.Vector3();
  for (const a of loop) archC.add(a.p);
  archC.multiplyScalar(1 / loop.length);

  {
    const L = [], R = [];
    for (const a of loop) {
      const inward = new THREE.Vector3().subVectors(archC, a.p).normalize();
      L.push(a.p.clone());
      R.push(a.p.clone().addScaledVector(a.n, -0.062).addScaledVector(inward, 0.018));
    }
    const revRef = (p, out) => out.subVectors(archC, p);
    const revTint = (x, y, z) => { const q = flyTint(x, y, z); return [q[0] * 0.62, q[1] * 0.62, q[2] * 0.66]; };
    P.add(ribbon(L, R, revRef), 'fabricIn', null, revTint);
  }

  // Binding and zip track just outside the aperture, offset ALONG the surface so
  // they hug the end wall rather than standing off it.
  const archOut = [];
  {
    const L = [], R = [];
    for (let i = 0; i < arch.length; i++) {
      const a = arch[i];
      const b = arch[Math.min(arch.length - 1, i + 1)];
      const c = arch[Math.max(0, i - 1)];
      const tng = new THREE.Vector3().subVectors(b.p, c.p).normalize();
      const away = new THREE.Vector3().crossVectors(tng, a.n).normalize();
      if (away.dot(new THREE.Vector3().subVectors(a.p, archC)) < 0) away.negate();
      const p0 = a.p.clone().addScaledVector(a.n, 0.004);
      const p1 = p0.clone().addScaledVector(away, 0.022);
      archOut.push(p1.clone());
      L.push(p0); R.push(p1);
    }
    P.add(ribbon(L, R, outwardRef), 'fabric', null, gainOf(cw.trim));
    const L2 = [], R2 = [];
    for (let i = 0; i < arch.length; i++) {
      const a = arch[i];
      const away = new THREE.Vector3().subVectors(archOut[i], a.p).normalize();
      L2.push(archOut[i].clone());
      R2.push(archOut[i].clone().addScaledVector(away, 0.032).addScaledVector(a.n, -0.002));
    }
    P.add(ribbon(L2, R2, outwardRef), 'fabric', null, acc);
  }

  // Two zip pulls with cord tails, parked where a zip on a triangular door
  // actually parks: one at the apex, one down at the foot of the left jamb.
  for (const [f, side] of [[0.5, 1], [0.955, -1]]) {
    const i = Math.round(f * (arch.length - 1));
    const a = arch[i];
    const p = a.p.clone().addScaledVector(a.n, 0.012);
    P.add(rbox(0.013, 0.026, 0.005, 0.003), 'plastic',
      at(p.x, p.y, p.z, 0, Math.atan2(a.n.x, a.n.z), side * 0.3), [1, 1, 1]);
    const tail = p.clone().add(V(0, -0.040, 0)).addScaledVector(a.n, 0.004);
    P.add(tube(0.0026, p.distanceTo(tail), 4), 'cord', span(p, tail, M()), [1, 1, 1]);
  }

  // The door rolled back and toggled. A triangular door does not roll over its
  // own top the way a dome's D-door does — there is no top to roll over — it
  // rolls to ONE jamb and gets tied there, which is what the plate shows.
  if (cw.doorOpen) {
    const n0 = Math.round(arch.length * 0.985), n1 = Math.round(arch.length * 0.62);
    P.add(sweptArc((k) => {
      const i = Math.round(lerp(n0, n1, k));
      const a = arch[i];
      const away = new THREE.Vector3().subVectors(archOut[i], a.p).normalize();
      return a.p.clone().addScaledVector(a.n, 0.048).addScaledVector(away, 0.030);
    }, 12, 0.036, 6), 'fabric', null, (x, y, z) => {
      const q = flyTint(x, y, z); return [q[0] * 0.88, q[1] * 0.88, q[2] * 0.88];
    });
    // Two toggle ties around it, oriented so the torus axis follows the bundle —
    // which is the difference between a tie and a hula hoop.
    for (const f of [0.26, 0.72]) {
      const i = Math.round(lerp(n0, n1, f));
      const a = arch[i];
      const b = arch[Math.max(0, i - 3)];
      const away = new THREE.Vector3().subVectors(archOut[i], a.p).normalize();
      const c = a.p.clone().addScaledVector(a.n, 0.048).addScaledVector(away, 0.030);
      const axis = new THREE.Vector3().subVectors(b.p, a.p).normalize();
      P.add(new THREE.TorusGeometry(0.040, 0.0042, 4, 12), 'cord', orient(c, axis), [1, 1, 1]);
    }
  }

  // ── what goes in the apertures ─────────────────────────────────────────────
  // Screen, reveal, binding, and — on the windows — the storm flap rolled to the
  // top edge, which is where a flap you are not using actually lives.
  //
  // The reveal is the same trick as the door's and it is doing the same job: a
  // hole cut in a single-sided shell is a paper edge, and turning 55 mm of fabric
  // inward gives it a lip that catches light along the top and goes black down
  // the sides. Without it the window is a shape; with it, it is a hole in
  // something thick.
  for (const q of CUTS) {
    const tA = tRow(q.k0), tB = tRow(q.k1);
    const at2 = (u, k, out, push) => {
      const sv = lerp(q.c - q.hw, q.c + q.hw, u);
      const t = lerp(tA, tB, k);
      surf(sv, t, out);
      normalAt(sv, t, _n4);
      return out.addScaledVector(_n4, push);
    };

    // The screen, set back inside the reveal so its own lip shades it. 24 mm,
    // not 34: this is seen at a grazing angle from most of the camp, and depth
    // buys parallax at the rate of one millimetre of slide per millimetre of
    // set-back — at 34 the mesh visibly slid out from under its own binding.
    //
    // Tinted well up, and brighter toward the sill. `mesh` is 0x14161a at env
    // 0.14: left at its own value a 0.7 m panel of it is a hole cut in the
    // world, which is the same failure the inner canopy has and is fixed the
    // same way. What a real screen shows is the floor of the tent bouncing
    // daylight back through it, so the gradient runs the right way up.
    P.add(patch((u, k, out) => at2(u, k, out, -0.024), 18, 10, outwardRef),
      'mesh', null, (x, y) => {
        // These multipliers look absurd and are not. `mesh` is authored at
        // 0x14161a — linear (0.006, 0.007, 0.011) — for 60 mm vent slots, where
        // near-black is right. A 0.7 x 0.33 m panel of it in daylight is a hole
        // cut in the world: the first pass ran this at 2.5x and photographed as
        // solid black. 14x lands the screen at about a tenth of the fly's
        // albedo, which is what a bug screen with a lit tent behind it measures.
        // Warmed on the way, because the kit's mesh is authored cool and a
        // window should take its colour from the room.
        const q2 = 10.5 - 5.0 * clamp01((y - tA * H) / Math.max(0.05, (tB - tA) * H));
        return [q2, q2 * 0.88, q2 * 0.66];
      });

    // Once round the aperture: up one side, along the top, down the other, back
    // along the bottom. Sampled off the same `at2`, so the loop is ON the cut
    // edge rather than near it.
    const edge = [], nrm = [];
    {
      const n = 56;
      for (let i = 0; i <= n; i++) {
        const f = (i / n) * 4;
        let u, k;
        if (f < 1)      { u = 0; k = f; }
        else if (f < 2) { u = f - 1; k = 1; }
        else if (f < 3) { u = 1; k = 3 - f; }
        else            { u = 4 - f; k = 0; }
        edge.push(at2(u, k, new THREE.Vector3(), 0));
        const sv = lerp(q.c - q.hw, q.c + q.hw, u);
        nrm.push(normalAt(sv, lerp(tA, tB, k), new THREE.Vector3()));
      }
    }
    const ctr = new THREE.Vector3();
    for (const e of edge) ctr.add(e);
    ctr.multiplyScalar(1 / edge.length);

    {                                                        // the reveal
      const L = [], R = [];
      for (let i = 0; i < edge.length; i++) {
        const inward = new THREE.Vector3().subVectors(ctr, edge[i]).normalize();
        L.push(edge[i].clone());
        R.push(edge[i].clone().addScaledVector(nrm[i], -0.055).addScaledVector(inward, 0.014));
      }
      const ref = (p2, out) => out.subVectors(ctr, p2);
      P.add(ribbon(L, R, ref), 'fabricIn', null,
        (x, y, z) => { const c = flyTint(x, y, z); return [c[0] * 0.60, c[1] * 0.60, c[2] * 0.64]; });
    }

    if (q.roll) {                                            // the binding
      // Offset ALONG the wall rather than along the normal, so a 22 mm tape hugs
      // the fabric instead of standing off it like a picture frame. Narrow on
      // purpose: the first cut ran this at 32 mm in the full accent and the
      // window read as a rectangle drawn on the tent in marker pen.
      const L = [], R = [];
      for (let i = 0; i < edge.length; i++) {
        const b = edge[Math.min(edge.length - 1, i + 1)];
        const c = edge[Math.max(0, i - 1)];
        const tng = new THREE.Vector3().subVectors(b, c);
        if (tng.lengthSq() < 1e-10) tng.set(0, 1, 0);
        tng.normalize();
        const away = new THREE.Vector3().crossVectors(tng, nrm[i]).normalize();
        if (away.dot(new THREE.Vector3().subVectors(edge[i], ctr)) < 0) away.negate();
        const p0 = edge[i].clone().addScaledVector(nrm[i], 0.004);
        L.push(p0);
        R.push(p0.clone().addScaledVector(away, 0.016));
      }
      P.add(ribbon(L, R, outwardRef), 'fabric', null, accTape);
    }

    if (q.roll) {
      // The storm flap, rolled tight along the top edge and toggled at each end.
      const roll = [];
      for (let i = 0; i <= 12; i++) {
        const p2 = at2(lerp(0.03, 0.97, i / 12), 1, new THREE.Vector3(), 0.024);
        p2.y += 0.012;
        roll.push(p2);
      }
      P.add(sweptArc((k) => roll[Math.round(k * 12)].clone(), 12, 0.024, 6),
        'fabric', null, (x, y, z) => {
          const c = flyTint(x, y, z); return [c[0] * 0.90, c[1] * 0.90, c[2] * 0.92];
        });
      for (const [i, j] of [[1, 3], [11, 9]]) {
        const axis = new THREE.Vector3().subVectors(roll[j], roll[i]).normalize();
        P.add(new THREE.TorusGeometry(0.032, 0.0040, 4, 12), 'cord',
          orient(roll[i], axis), [1, 1, 1]);
      }
      // A zip pull hanging at the low corner of the binding.
      const p2 = at2(0.94, 0.06, new THREE.Vector3(), 0.014);
      P.add(rbox(0.012, 0.024, 0.005, 0.003), 'plastic',
        at(p2.x, p2.y, p2.z, 0, Math.atan2(nrm[0].x, nrm[0].z), 0.25), [1, 1, 1]);
    } else {
      // The vent's hood: a BULGE welded to the fly along its top and sides and
      // free only at its lower lip, rather than a quad hung off two corners —
      // the latter reads as a piece of torn paper glued on, which is the note
      // camp_tent's round nine got for exactly this part.
      const tmp = new THREE.Vector3();
      P.add(patch((u, k, out) => {
        const sv = lerp(q.c - q.hw * 1.22, q.c + q.hw * 1.22, u);
        const t = lerp(tB + 0.014, tA + (tB - tA) * 0.18, k);
        surf(sv, t, out);
        normalAt(sv, t, tmp);
        out.addScaledVector(tmp, q.hood * Math.sin(PI * u) * Math.pow(k, 0.6));
        out.y -= 0.014 * Math.sin(PI * u) * k * k;          // the lip falls away
        return out;
      }, 16, 6, outwardRef), 'fabric', null, (x, y, z) => {
        const c = flyTint(x, y, z); return [c[0] * 0.97, c[1] * 0.97, c[2] * 0.98];
      });
    }
  }

  // ── the inner tent ─────────────────────────────────────────────────────────
  // Only ever seen through the door and under the hem, and that is precisely why
  // it has to exist: the aperture needs three receding values behind it — lit
  // rim, then dark canopy, then warm floor — or it is a black triangle painted
  // on a wedge.
  const tTub = 0.070;
  const innerGapAt = (t) => INNER_GAP * (1 - 0.55 * smoothstep(0.55, INNER_TOP, t));
  const innerBase = (s, t, out) => {
    baseCore(s, t, out);
    normalAt(s, t, _n4);
    return out.addScaledVector(_n4, dispSmooth(s, t) - innerGapAt(t));
  };
  // Deliberately smaller than the fly's aperture — about 62% of its width and
  // 72% of its height — so looking in you see a ring of canopy fabric before you
  // see a hole. Two apertures the same size read as one hole with a thick rim;
  // two different sizes read as depth.
  const innerDoorT = (s) => {
    const x = Math.abs(s - 0.5) / (DOOR_S * 0.62);
    if (x >= 1) return tTub;
    return Math.max(tTub, T_DOOR * 0.72 * Math.sqrt(1 - Math.pow(x, 2.4)));
  };
  const innerRef = (p, out) => out.set(p.x, 0.4, p.z);
  const innerTint = tintOf(cw.inner);
  // Lifted well off black. The canopy lives in the fly's own shadow, so the
  // renderer gives it almost nothing; left at its true value the door reads as a
  // hole punched in the tent rather than as a room.
  const canopyTint = (x, y) => {
    const k = 1.55 + 0.85 * clamp01(y / H);
    return [innerTint[0] * k, innerTint[1] * k, innerTint[2] * k];
  };

  P.add(patch((u, k, out) => innerBase(u, lerp(innerDoorT(u), INNER_TOP, k), out),
    76, 16, innerRef), 'fabricIn', null, canopyTint);
  // …and the slot left at the top of it, closed by pairing s with 1 - s. The two
  // halves are 60 mm apart there; the two cells at the very ends of the strip are
  // degenerate, which is what `sanitizeNormals` is for.
  P.add(patch((u, k, out) => {
    const a = innerBase(u * 0.5, INNER_TOP, new THREE.Vector3());
    const b = innerBase(1 - u * 0.5, INNER_TOP, new THREE.Vector3());
    return out.lerpVectors(a, b, k);
  }, 38, 1, innerRef), 'fabricIn', null, canopyTint);

  // Bathtub floor: a darker, heavier fabric, bulged where gear pushes against
  // it, visible all the way round under the hem. That band of value is what
  // stops the tent ending in a hard black line.
  const floorTint = tintOf(cw.floor);
  P.add(patch((u, k, out) => {
    innerBase(u, k * tTub, out);
    // Flared at the very bottom and pinched at the top: a floor with gear on it
    // spreads where it meets the ground, and that flare plus the value drop
    // below it is the only ground CONTACT this prop has.
    const bulge = 1 + 0.030 * Math.pow(1 - k, 2.2) + 0.022 * Math.sin(PI * k)
                + 0.014 * Math.sin(7 * TAU * u + ph[1]) * Math.sin(PI * k);
    out.x *= bulge; out.z *= bulge;
    return out;
  }, 76, 6, innerRef), 'fabricIn', null, (x, y) => {
    const k = (0.42 + 0.98 * clamp01(smoothstep(0.0, 0.075, y))) * (0.72 + 0.5 * clamp01(y / 0.20));
    const dk = clamp01(smoothstep(0.06, 0.0, y)) * (0.18 + 0.3 * wear);
    return [
      floorTint[0] * k * (1 - dk) + 1.05 * dk,
      floorTint[1] * k * (1 - dk) + 0.98 * dk,
      floorTint[2] * k * (1 - dk) + 0.82 * dk,
    ];
  });

  // The floor itself, very slightly domed so it catches a little of whatever
  // light gets through the door instead of reading as a flat black plate.
  {
    const ring = [];
    const n = 48;
    for (let i = 0; i < n; i++) ring.push(innerBase(i / n, tTub * 0.22, new THREE.Vector3()).setY(0.026));
    P.add(fan(V(0, 0.040, 0), ring, true), 'fabricIn', null,
      [floorTint[0] * 1.5, floorTint[1] * 1.5, floorTint[2] * 1.5]);
  }

  // Somebody's kit, on the floor, visible through the door. An aperture with
  // nothing behind it is a hole; an aperture with a rolled pad and a stuff sack
  // behind it is a room somebody sleeps in. Everything here is tinted well up
  // because it lives inside the fly's own shadow — but at about a third of the
  // dome's values, not at them. camp_tent's kit is authored to be found
  // through a 0.6 m D-door with a canopy overhanging it; an A-frame's door is
  // most of the end wall, so the same numbers put two glowing pale boulders in
  // the middle of the prop. An A-frame is narrow, so it all lies along the
  // length rather than across it — which is also why anyone who has slept in
  // one remembers it.
  {
    const inX = WX * 0.40, inZ = LZ * 0.42;
    const pad = V(-inX * 0.55, 0.10, -inZ * 0.85);
    const padEnd = V(-inX * 0.30, 0.095, inZ * 0.55);
    P.add(rod(0.078, pad.distanceTo(padEnd), 12), 'fabricIn', span(pad, padEnd, M()),
      [0.52, 0.43, 0.31]);                                  // a rolled foam pad
    const bagA = V(inX * 0.52, 0.085, -inZ * 0.90);
    const bagB = V(inX * 0.30, 0.075, inZ * 0.62);
    P.add(rod(0.088, bagA.distanceTo(bagB), 12), 'fabricIn', span(bagA, bagB, M()),
      [0.30, 0.35, 0.48]);                                  // a bag, half unrolled
    P.add(rbox(0.15, 0.14, 0.15, 0.050), 'fabricIn',
      at(0, 0.082, -inZ * 1.35, 0, 0.5, 0.12), [0.46, 0.42, 0.33]);   // a stuff sack
    P.add(rbox(0.05, 0.028, 0.028, 0.010), 'plastic',
      at(-WX * 0.14, H * 0.55 - INNER_GAP, -LZ * 0.20, 0, 0.3, 0), [0.55, 0.55, 0.55]);
  }

  // The lantern, hung off the ridge just inside the door, and deliberately off
  // centre — a lantern dead centre in a doorway is a headlight.
  {
    const ly = H * 0.54 - 0.10, lx = -WX * 0.11, lz = LZ * 0.20;
    const lg = rbox(0.068, 0.084, 0.068, 0.022);
    lg.computeVertexNormals();
    sanitizeNormals(lg);
    const lantern = new THREE.Mesh(lg, lanternMaterial());
    lantern.position.set(lx, ly, lz);
    lantern.name = 'tent_lantern';
    lantern.castShadow = false;
    lantern.receiveShadow = false;
    g.add(lantern);
    const top = V(lx, ly + 0.048, lz);
    const hook = V(lx, H * 0.72, lz);
    P.add(tube(0.0028, top.distanceTo(hook), 4), 'cord', span(top, hook, M()), cordTint);
  }

  // The inner tent's mesh door, unzipped and rolled to the jamb. Always open:
  // every plate that shows a shut mesh door also shows the interior THROUGH it,
  // which solid geometry cannot do, so the interior does the work instead.
  P.add(sweptArc((k) => {
    const sv = 0.5 + DOOR_S * 0.34 + k * 0.012;
    const t = lerp(tTub + 0.02, innerDoorT(0.5 + DOOR_S * 0.30) * 0.94, k);
    return innerBase(sv, t, new THREE.Vector3()).multiplyScalar(0.995);
  }, 14, 0.028, 6), 'mesh', null, [1.5, 1.45, 1.4]);

  // ── the A-poles, at the ground ─────────────────────────────────────────────
  // The last 130 mm of each leg, below the hem, going into a grommet at the
  // corner webbing. Four bright thin lines under four dark hem corners: cheap,
  // and it is what says the wedge has a frame in it.
  const feet = [];
  for (const sm of SEAM) {
    // Started well up inside the hem so a real length of tube shows below the
    // fly — 26 mm of pole is invisible at any distance and the corners read as
    // fabric resting on nothing.
    const top = surf(sm, 0.090, new THREE.Vector3())
      .addScaledVector(normalAt(sm, 0.090, new THREE.Vector3()), -0.016);
    const dir = new THREE.Vector3(top.x, 0, top.z).normalize();
    const foot = V(top.x + dir.x * 0.032, 0.012, top.z + dir.z * 0.032);
    feet.push({ top, foot, dir });
    P.add(tube(0.0060, top.distanceTo(foot), 6), 'alu', span(top, foot, M()), poleTint);
    P.add(rbox(0.030, 0.020, 0.026, 0.006), 'plastic',
      at(foot.x, 0.016, foot.z, 0, Math.atan2(dir.x, dir.z), 0), [1, 1, 1]);
  }

  // ── hardware: webbing, stakes, guy lines ───────────────────────────────────
  const stakeAt = (p, awayDir) => {
    // Angled away from the tent and driven most of the way in, the way anybody
    // who has had a fly let go in the night drives them.
    const head = V(p.x, 0.052, p.z);
    const tip = V(p.x + awayDir.x * 0.062, -0.145, p.z + awayDir.z * 0.062);
    P.add(rod(0.0055, head.distanceTo(tip), 6), 'tube', span(head, tip, M()), [1, 1, 1]);
    P.add(rbox(0.022, 0.006, 0.014, 0.002), 'tube',
      at(head.x, head.y + 0.004, head.z, 0, Math.atan2(awayDir.x, awayDir.z), 0), [1, 1, 1]);
    return head;
  };

  for (const f of feet) {
    const sp = V(f.foot.x + f.dir.x * 0.085, 0, f.foot.z + f.dir.z * 0.085);
    const head = stakeAt(sp, f.dir);
    const a = V(f.foot.x, 0.030, f.foot.z);
    const m = span(a, head, M());
    P.add(rbox(0.026, a.distanceTo(head), 0.004, 0.0015), 'cord', m, cordTint);
    const mid = new THREE.Vector3().lerpVectors(a, head, 0.42);
    P.add(rbox(0.030, 0.021, 0.007, 0.002), 'plastic',
      at(mid.x, mid.y + 0.004, mid.z, 0, Math.atan2(f.dir.x, f.dir.z), 0), [1, 1, 1]);
  }

  // Peg loops along the hem, at the peg points the catenary was cut for. Without
  // them the hem scallops for no visible reason, which is worse than not
  // scalloping: the eye reads an unexplained wobble as a modelling error.
  for (const pg of PEGS) {
    if (SEAM.includes(pg)) continue;                 // those have webbing already
    const p = surf(pg, 0.004, new THREE.Vector3());
    const dir = new THREE.Vector3(p.x, 0, p.z).normalize();
    const sp = V(p.x + dir.x * 0.050, 0, p.z + dir.z * 0.050);
    const head = stakeAt(sp, dir);
    const a = V(p.x, 0.020, p.z);
    P.add(rbox(0.018, a.distanceTo(head), 0.003, 0.0012), 'cord', span(a, head, M()), cordTint);
  }

  // The flank guys, off their reinforcement patches.
  for (const gy of ties) {
    const anchor = surf(gy.s, gy.t, new THREE.Vector3());
    const nrm = normalAt(gy.s, gy.t, new THREE.Vector3());
    anchor.addScaledVector(nrm, 0.010);
    // Small: at 52 mm in a saturated accent it reads as a signal flag stuck on.
    P.add(rbox(0.046, 0.046, 0.004, 0.009), 'fabric', orient(anchor, nrm),
      [acc[0] * 0.78 + 0.06, acc[1] * 0.78 + 0.06, acc[2] * 0.78 + 0.06]);

    const away = new THREE.Vector3(nrm.x, 0, nrm.z).normalize();
    const sp = V(anchor.x + away.x * gy.reach, 0, anchor.z + away.z * gy.reach);
    const head = stakeAt(sp, away);
    const sag = 0.006 + gy.slack;
    P.add(sweptArc((k) => {
      const p = new THREE.Vector3().lerpVectors(anchor, head, k);
      p.y -= sag * 4 * k * (1 - k);
      return p;
    }, 18, 0.0068, 5), 'cord', null, cordTint);
    const tn = new THREE.Vector3().lerpVectors(anchor, head, 0.72);
    tn.y -= sag * 4 * 0.72 * 0.28;
    P.add(rbox(0.026, 0.034, 0.006, 0.003), 'plastic',
      at(tn.x, tn.y, tn.z, 0, Math.atan2(away.x, away.z), 0), [1, 1, 1]);
  }

  // The two ridge lines, off the ends of the ridge pole. THE A-frame detail:
  // nothing else in this camp has a cord running off the very top of it, and in
  // the wide shot the two long diagonals are how you tell this tent from the
  // dome at a distance where neither has any other feature left.
  for (const tip of apex) {
    const away = V(0, 0, Math.sign(tip.z) || 1);
    const sp = V(tip.x + away.x * 0.34, 0, tip.z + away.z * 0.34);
    const head = stakeAt(sp, away);
    P.add(sweptArc((k) => {
      const p = new THREE.Vector3().lerpVectors(tip, head, k);
      p.y -= 0.014 * 4 * k * (1 - k);
      return p;
    }, 16, 0.0068, 5), 'cord', null, cordTint);
    const tn = new THREE.Vector3().lerpVectors(tip, head, 0.76);
    tn.y -= 0.014 * 4 * 0.76 * 0.24;
    P.add(rbox(0.026, 0.034, 0.006, 0.003), 'plastic',
      at(tn.x, tn.y, tn.z, 0, Math.atan2(away.x, away.z), 0), [1, 1, 1]);
  }

  P.flush(g, { cast: true, receive: true });

  // ── footprint ──────────────────────────────────────────────────────────────
  // Measured rather than declared: the ridge-line stakes are the outermost thing
  // on this prop and their reach depends on the colourway. The layout solver
  // passes a hard-coded 1.45 (see docs/CAMP_REQUESTS.md), so every colourway is
  // dimensioned to stay inside that.
  let fp = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    const a = o.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i += 3) {
      const d = a[i] * a[i] + a[i + 2] * a[i + 2];
      if (d > fp) fp = d;
    }
  });
  g.userData.footprint = clamp(Math.sqrt(fp) + 0.02, 1.25, 1.6);
  g.userData.colorway = cw.name;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  boat_canoe — a 4.6 m open canoe.
//
//  The shape is one lofted shell, the cooler's argument applied to a hull: a
//  constant-vertex-count closed cross section — outer skin from port sheer
//  down through the keel and up to starboard sheer, over the gunwale lip, back
//  down the INTERIOR to the floor and up the other side — swept along
//  Chebyshev-spaced stations so the rings crowd toward the stems, where all
//  the curvature is. One surface therefore produces the flared topsides, the
//  shallow-arch bottom, the visible 28 mm wall, the interior floor and the
//  rising sheer, all mutually consistent. Winding is fixed by signed volume
//  and the normals are computed indexed, so the light rolls continuously
//  around the bilge instead of stepping — a faceted hull is the loudest
//  programmer-art tell on water.
//
//  Everything wooden — outwales, inwales, thwarts, the seats, the decks, the
//  paddle — is the same varnish material, tinted per colourway. The paddle is
//  a separate object (userData.paddle) laid across the gunwales, pivot at the
//  shaft centre, so the game can animate it later.
//
//  Convention: +Z is the bow, +Y up, origin at hull centre, and THE STATIC
//  WATERLINE IS y = 0 — draft hangs below, freeboard stands above, so placing
//  the group at the water surface floats it correctly.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  BoatParts, shellFromRings, rring, sweptArc, patch, rod, rbox, tube, at, M,
  tintOf, mixRGB, mulRGB, hash01,
} from './boat_materials.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

export const CANOE_DIM = { length: 4.6, beam: 0.90, draft: 0.15 };

// ─────────────────────────────────────────────────────────────────────────────
//  Colourways — hull material differs (that is what the materials are FOR),
//  every hue is a vertex tint.
// ─────────────────────────────────────────────────────────────────────────────
export const CANOE_COLORWAYS = [
  // Wood-strip classic: cedar strips under varnish, walnut trim.
  // Every hue here is authored a step brighter than the "true" swatch: vertex
  // tints multiply in linear space, and the first round's 0x84501f cedar was
  // measured near-black on the in-game shadow side. The wood has to stay warm
  // chestnut even when the sun is off it — the brief's lifted-shadow mandate
  // applies to props too, and albedo is where it starts.
  {
    name: 'Wood strip', hull: 'varnish',
    stripLo: 0xa06430, stripHi: 0xeec384,   // the band of cedar hues
    stripDk: 0x7d4c2c,                       // the odd walnut accent strip
    interiorMix: 0.46,                       // interior strips read paler
    trim: 0x6f4a28, seat: 0xb0854f, cane: 0xd0ab64,
    stripe: null, blade: 0xa06430,
  },
  // Forest-green expedition royalex, wood trim, waterline stripe.
  {
    name: 'Expedition green', hull: 'royalex',
    hullC: 0x426a4d, interiorC: 0x557a5e,
    trim: 0x94693c, seat: 0xb0854f, cane: 0xcea55b,
    stripe: 0xd4c89e, blade: 0x426a4d,
  },
  // Faded red canvas over cedar, tan-painted interior.
  {
    name: 'Red canvas', hull: 'enamel',
    hullC: 0xb55a46, interiorC: 0xc8a674,
    trim: 0x7d5a35, seat: 0xa37b4a, cane: 0xd0ab64,
    stripe: null, blade: 0xb55a46,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
export function buildCanoe(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'boat_canoe';
  const cw = CANOE_COLORWAYS[(opts.colorway ?? 0) % CANOE_COLORWAYS.length];

  const L = CANOE_DIM.length, HL = L * 0.5;
  const HB = CANOE_DIM.beam * 0.5;
  const DRAFT = CANOE_DIM.draft;
  const FB = 0.33;              // sheer height amidships
  const STEM = 0.52;            // sheer height at the stems
  const WALL = 0.028;           // hull wall thickness, visible at the gunwale
  const FLOOR = 0.032;

  // every random choice up front, so the draw order can never change with opts
  const stripPhase = rnd() * 6.283;
  const stripSeed = 1 + Math.floor(rnd() * 97);
  const wobble = 0.9 + rnd() * 0.2;          // sheer-line micro character
  const paddleYaw = 0.38 + rnd() * 0.10;
  const paddleZ = 0.50 + rnd() * 0.12;
  const caneJitter = rnd() * 6.283;

  // ── longitudinal profiles (t = z / HL in −1..1) ───────────────────────────
  const tOf = (z) => clamp(z / HL, -1, 1);
  const bOf = (z) => {
    const t = Math.abs(tOf(z));
    return Math.max(0.014, HB * Math.pow(Math.max(0, 1 - Math.pow(t, 2.15)), 0.56));
  };
  const sheerOf = (z) => {
    const t = Math.abs(tOf(z));
    return FB + (STEM - FB) * Math.pow(t, 3.3) * wobble;
  };
  const keelOf = (z) => {
    const t = Math.abs(tOf(z));
    const base = -DRAFT * (1 - Math.pow(t, 2.5));      // rockered bottom
    return lerp(base, sheerOf(z) - 0.10, smoothstep(0.86, 1.0, t));
  };
  // The interior sole — a FALSE floor, and the fix for the review's blocker.
  // The real bilge bottoms out at y≈−0.12, below the y=0 waterline, and the
  // game's water plane happily renders straight through the open hull above
  // it: top-down shots showed lake inside the boat, 3/4 shots a pale sliver
  // of sky-reflecting water over the far gunwale. So the visible interior
  // floor sits well above the static waterline and the volume between it and
  // the true bottom is hidden displacement — the false floor every
  // water-going game prop ships. 0.105, not the first round's 0.05: a
  // BOARDED canoe settles and pitches, and playtesting caught wake foam
  // slivering up between the floorboards near the seats at 0.05.
  const SOLE = 0.105;
  const soleOf = (z) =>
    Math.min(sheerOf(z) - 0.065, Math.max(keelOf(z) + FLOOR, SOLE));

  // ── the section: u in 0..1, keel → sheer ──────────────────────────────────
  // sin^0.88 across, (1−cos)^1.12 up: a shallow-arch bottom rolling through a
  // soft bilge into flared topsides. The same curve serves inside and out.
  const sect = (u, b, yk, ys) => [
    b * Math.pow(Math.sin(u * Math.PI * 0.5), 0.88),
    yk + (ys - yk) * Math.pow(1 - Math.cos(u * Math.PI * 0.5), 1.12),
  ];
  // Sample warp: raw u clusters rows at the keel and starves the topsides —
  // strip colour lives ON the vertices, so rows sparser than the plank pitch
  // interpolate the banding into a smooth gradient (rounds 2 AND 3 shipped
  // exactly that; the colour buffer was right both times, the sampling wasn't).
  // `uy` is the equal-Δy parameter; blending keeps bilge x-resolution too.
  const uy = (f) => Math.acos(1 - Math.pow(Math.max(0, f), 1 / 1.12)) * 2 / Math.PI;
  const sv = (q) => 0.38 * q + 0.62 * uy(q);

  const N = 18;
  const ringAt = (z) => {
    const b = bOf(z), ys = sheerOf(z), yk = keelOf(z);
    const bi = Math.max(0.004, b - WALL), yki = soleOf(z), ysi = ys - 0.005;
    const pts = [], tags = [];
    const push = (x, y, tag) => { pts.push(new THREE.Vector3(x, y, z)); tags.push(tag); };
    for (let k = 0; k <= N; k++) {                     // outer, port sheer → keel
      const [x, y] = sect(sv(1 - k / N), b, yk, ys); push(-x, y, 0);
    }
    for (let k = 1; k <= N; k++) {                     // outer, keel → stbd sheer
      const [x, y] = sect(sv(k / N), b, yk, ys); push(x, y, 0);
    }
    push(Math.max(0.002, b - WALL * 0.5), ys + 0.010, 0.5);   // stbd gunwale lip
    for (let k = 0; k <= N; k++) {                     // inner, stbd sheer → floor
      const [x, y] = sect(sv(1 - k / N), bi, yki, ysi); push(x, y, 1);
    }
    for (let k = 1; k <= N; k++) {                     // inner, floor → port sheer
      const [x, y] = sect(sv(k / N), bi, yki, ysi); push(-x, y, 1);
    }
    push(-Math.max(0.002, b - WALL * 0.5), ys + 0.010, 0.5);  // port gunwale lip
    return { pts, tags };
  };

  // Chebyshev stations: dense at the stems, where the loft actually turns.
  const S = 20;
  const rings = [], ringTags = [];
  for (let i = 0; i <= S; i++) {
    const z = -HL * Math.cos((i / S) * Math.PI) * 0.999;
    const r = ringAt(z);
    rings.push(r.pts); ringTags.push(r.tags);
  }

  // ── colour ────────────────────────────────────────────────────────────────
  const trimC = tintOf(cw.trim);
  const seatC = tintOf(cw.seat);
  const caneC = tintOf(cw.cane);
  const stripLo = cw.stripLo ? tintOf(cw.stripLo) : null;
  const stripHi = cw.stripHi ? tintOf(cw.stripHi) : null;
  const stripDk = cw.stripDk ? tintOf(cw.stripDk) : null;
  const hullC = cw.hullC ? tintOf(cw.hullC) : null;
  const interiorC = cw.interiorC ? tintOf(cw.interiorC) : null;
  const stripeC = cw.stripe ? tintOf(cw.stripe) : null;
  const PALE = [0.62, 0.52, 0.36];                     // pale interior lift, cedar

  /** Cedar strip pattern — planks follow the sheer, ~48 mm to a strip. */
  const strips = (x, y, z) => {
    const idx = Math.floor((y + 0.012 * Math.sin(z * 1.9 + stripPhase)
                              + 0.03 * Math.abs(x)) / 0.082);
    const h = hash01(idx * 3.7 + stripSeed);
    // the odd walnut accent strip is what makes the banding legible at all —
    // adjacent cedar hues alone flatten out under the key light
    let c = h < 0.16 && stripDk ? stripDk.slice()
          : mixRGB(stripLo, stripHi, Math.pow((h - 0.16) / 0.84, 0.8));
    // along-plank scarf joints: a subtle value step every metre or so
    c = mulRGB(c, 0.92 + 0.16 * hash01(idx * 13.1 + Math.floor((z + HL) / lerp(0.8, 1.3, hash01(idx))) * 7.3));
    return c;
  };

  const hullTint = (x, y, z, tag) => {
    let c;
    if (stripLo) {
      c = strips(x, y, z);
      if (tag > 0.75) c = mixRGB(c, PALE, cw.interiorMix);       // interior, paler
    } else {
      c = tag > 0.75 ? interiorC.slice() : hullC.slice();
    }
    if (tag <= 0.75) {
      const enamel = cw.hull === 'enamel';
      if (!stripLo) {
        // Painted skin, so paint it: the review's words for the flat version
        // were "one plastic tone". Three moves, all in the striping trick's
        // family — the rows are already equal-Δy, so banding survives.
        // 1: painterly value drift, low-frequency along the hull…
        let v = 1 + 0.05 * Math.sin(z * 1.35 + stripPhase)
                  + 0.035 * Math.sin(z * 3.1 - y * 9.0 + stripPhase * 1.7);
        // …2: canvas weave / brush rows following the sheer, value-only
        const row = Math.floor((y + 0.010 * Math.sin(z * 2.1 + stripPhase)) / 0.052);
        v *= 0.965 + 0.07 * hash01(row * 5.3 + stripSeed);
        c = mulRGB(c, enamel ? v : 1 + (v - 1) * 0.55);          // royalex milder
        // 3: wear — stems and the sheer line rub pale where hands and rocks go
        if (enamel) {
          const wear = 0.34 * smoothstep(0.80, 0.97, Math.abs(tOf(z)))
                     + 0.22 * smoothstep(sheerOf(z) - 0.055, sheerOf(z) - 0.012, y)
                         * smoothstep(0.06, 0.0, Math.abs(tOf(z)) - 0.94);
          c = mixRGB(c, [c[0] * 1.30 + 0.05, c[1] * 1.28 + 0.05, c[2] * 1.22 + 0.04],
            clamp01(wear));
        }
      }
      // waterline: the wetted band below y=0 goes darker and duller — this is
      // the one read that says "boat" instead of "prop shaped like one".
      // Warm-dark on the painted canvas (a varnished waterline band), cooler
      // damp on wood and poly.
      const wet = smoothstep(0.02, -0.04, y);
      const lum = (c[0] + c[1] + c[2]) / 3;
      c = enamel
        ? mixRGB(c, [lum * 0.70, lum * 0.55, lum * 0.42], wet * 0.44)
        : mixRGB(c, [lum * 0.58, lum * 0.63, lum * 0.62], wet * 0.34);
      // painted waterline stripe — topsides only. Gating on |x| matters: the
      // rockered bottom passes through the stripe's height band near the
      // stems, and an ungated stripe paints a broad cream patch across the
      // whole underside there (round 1 shipped exactly that).
      if (stripeC) {
        const onSide = smoothstep(0.35, 0.6, Math.abs(x) / Math.max(bOf(z), 0.02))
                     * (1 - smoothstep(0.72, 0.92, Math.abs(tOf(z))));
        const s = smoothstep(0.024, 0.032, y) * (1 - smoothstep(0.046, 0.054, y));
        c = mixRGB(c, stripeC, s * onSide * 0.85);
      }
      // sheer-line highlight: topsides catch the sky
      c = mulRGB(c, 1 + 0.07 * smoothstep(sheerOf(z) - 0.16, sheerOf(z), y));
    } else {
      // interior self-shadow: the bilge sees less sky than the sheer — kept
      // gentle, the brief lifts shadows and the old 0.82 floor plus in-hull
      // shadow maps is how the interior read as a tar pit from above
      c = mulRGB(c, 0.90 + 0.10 * smoothstep(soleOf(z), sheerOf(z), y));
    }
    if (tag > 0.25 && tag < 0.75) c = trimC.slice();             // gunwale lip
    return c;
  };

  const P = new BoatParts('canoe');
  P.add(shellFromRings(rings, ringTags), cw.hull, null, hullTint);

  // ── gunwales: outwale + inwale, swept along the real sheer ────────────────
  const trimTint = (x, y, z) =>
    mulRGB(trimC, (0.94 + 0.10 * hash01(Math.floor((z + HL) * 3.1)))
                  * (1 + 0.06 * smoothstep(0.2, 0.45, y)));
  const ZG = HL * 0.985;
  for (const s of [-1, 1]) {
    P.add(sweptArc((t) => {
      const z = -ZG + 2 * ZG * t;
      return new THREE.Vector3(s * (bOf(z) + 0.006), sheerOf(z) + 0.010, z);
    }, 30, 0.016, 6), 'varnish', null, trimTint);
    P.add(sweptArc((t) => {
      const z = -ZG + 2 * ZG * t;
      return new THREE.Vector3(s * Math.max(0.002, bOf(z) - WALL - 0.008), sheerOf(z) + 0.004, z);
    }, 30, 0.011, 6), 'varnish', null, trimTint);
  }

  // ── stem band + keel line: one swept tube, stern stem → keel → bow stem ───
  {
    const ctrl = [];
    const stemSide = (sgn) => {
      const zs = sgn * HL;
      const out = [];
      for (let k = 0; k <= 4; k++) {     // sheer top down the stem face
        const f = k / 4;
        out.push(new THREE.Vector3(0,
          lerp(sheerOf(zs) + 0.012, keelOf(zs * 0.985), f),
          sgn * lerp(HL * 1.002, HL * 0.985, f * 0.6)));
      }
      return out;
    };
    ctrl.push(...stemSide(-1));
    for (let k = 1; k <= 10; k++) {      // along the keel
      const z = lerp(-HL * 0.94, HL * 0.94, k / 11);
      ctrl.push(new THREE.Vector3(0, keelOf(z) - 0.006, z));
    }
    ctrl.push(...stemSide(1).reverse());
    P.add(sweptArc((t) => {
      const i = t * (ctrl.length - 1), i0 = Math.floor(i), f = i - i0;
      const a = ctrl[i0], b = ctrl[Math.min(ctrl.length - 1, i0 + 1)];
      return new THREE.Vector3().lerpVectors(a, b, f);
    }, 44, 0.013, 6), 'varnish', null,
    stripLo ? trimTint : hullTint);      // painted hulls carry a painted keel
  }

  // ── bow / stern decks: crowned wooden panels between the gunwales ─────────
  for (const sgn of [-1, 1]) {
    const z0 = sgn * HL * 0.985, z1 = sgn * (HL * 0.985 - 0.52);
    P.add(patch((u, v, out) => {
      const z = lerp(z0, z1, u);
      const hw = Math.max(0.004, bOf(z) - 0.020);
      return out.set(lerp(-hw, hw, v),
        sheerOf(z) - 0.020 + 0.018 * Math.sin(v * Math.PI) * (0.4 + 0.6 * u), z);
    }, 6, 6, (p, o) => o.set(0, 1, 0)), 'varnish', null, trimTint);
  }

  // ── interior structure: ribs and floorboards ──────────────────────────────
  // The open hull has to read as a BUILT interior, not a void: half-hoop ribs
  // rising from the sole to just under the inwales, and fore-aft floorboard
  // slats on the sole. Both sit on the false floor, so nothing here ever dips
  // toward the waterline.
  const ribTint = (x, y, z) =>
    mulRGB(mixRGB(seatC, PALE, 0.22),
      0.92 + 0.12 * hash01(Math.floor((z + HL) * 2.7) * 3.3 + stripSeed));
  for (let ri = 0; ri < 9; ri++) {
    const zr = -1.8 + ri * 0.45;
    // The centreline is evaluated ON the interior wall curve itself — same
    // sect(), same parameters as ringAt — so the 9.5 mm tube always sits half
    // proud of the surface. (An earlier draft rebuilt the curve with a lower
    // top and the non-parallel offset buried the rib inside the wall.)
    const bi = Math.max(0.03, bOf(zr) - WALL);
    const ySole = soleOf(zr), yTop = sheerOf(zr) - 0.005;
    // stop 5 cm under the inwale: solve sect's height term for that u
    const f = clamp01((sheerOf(zr) - 0.055 - ySole) / Math.max(yTop - ySole, 0.01));
    const uEnd = Math.acos(1 - Math.pow(f, 1 / 1.12)) * 2 / Math.PI;
    P.add(sweptArc((t) => {
      const u = uEnd * Math.abs(2 * t - 1);             // sheer → sole → sheer
      const [sx, sy] = sect(u, bi, ySole, yTop);
      return new THREE.Vector3(t < 0.5 ? -sx : sx, sy, zr);
    }, 18, 0.0095, 5), 'varnish', null, ribTint);
  }
  {
    // The interior is a V-section, not a tub: each slat rides just proud of
    // the interior surface AT ITS OWN x, and its run ends while the OUTER
    // hull at the slat's height is still wider than the slat — the first
    // draft used one flat height and the sheer-width test, and the outboard
    // slats' ends surfaced as pale capsules low on the exterior flank.
    const bi0 = bOf(0) - WALL, ys0 = sheerOf(0) - 0.005;
    const yWallAt = (xa) => {              // interior surface height, amidships
      const th = Math.asin(Math.pow(clamp01(xa / bi0), 1 / 0.88));
      return SOLE + (ys0 - SOLE) * Math.pow(1 - Math.cos(th), 1.12);
    };
    const xOuterAt = (z, y) => {           // outer half-beam at height y
      const b = bOf(z), ys = sheerOf(z), yk = keelOf(z);
      if (y <= yk) return 0;
      const f = clamp01((y - yk) / Math.max(ys - yk, 0.01));
      const u = Math.acos(1 - Math.pow(f, 1 / 1.12)) * 2 / Math.PI;
      return b * Math.pow(Math.sin(u * Math.PI * 0.5), 0.88);
    };
    const slatTint = (x, y, z) => {
      const i = Math.round(x / 0.10);
      const grain = 0.90 + 0.16 * hash01(i * 11.7 + stripSeed)
                  + 0.05 * Math.sin(z * 2.2 + i * 2.0 + stripPhase);
      return mulRGB(mixRGB(seatC, PALE, 0.15), grain);
    };
    // planks all but butt-tight (4 mm groove at a 0.10 pitch): the plank read
    // comes from the per-slat tint, and open gaps are exactly where the
    // playtest saw wake foam slip through on a settled, pitching hull
    for (let i = -2; i <= 2; i++) {
      const xa = i * 0.10;
      const yi = yWallAt(Math.abs(xa) + 0.035) + 0.010;
      let z = 0.3;
      while (z < HL * 0.84 && xOuterAt(z, yi + 0.012) > Math.abs(xa) + 0.070) z += 0.02;
      const ze = Math.max(0.3, z - 0.04);
      P.add(rbox(0.096, 0.014, ze * 2, 0.004, 1), 'varnish',
        at(xa, yi, 0), slatTint, { facet: true });
    }
  }

  // ── thwarts and the carrying yoke ─────────────────────────────────────────
  const bar = (z, w, d, tint) => {
    const half = Math.max(0.03, bOf(z) - WALL - 0.012);
    P.add(shellFromRings([
      rring(new THREE.Vector3(-half, sheerOf(z) - 0.010, z), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), d * 0.5, 0.011, 0.008, 3),
      rring(new THREE.Vector3(-half * 0.4, sheerOf(z) - 0.014, z), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), w * 0.5, 0.011, 0.008, 3),
      rring(new THREE.Vector3(0, sheerOf(z) - 0.016, z), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), w * 0.5, 0.011, 0.008, 3),
      rring(new THREE.Vector3(half * 0.4, sheerOf(z) - 0.014, z), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), w * 0.5, 0.011, 0.008, 3),
      rring(new THREE.Vector3(half, sheerOf(z) - 0.010, z), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), d * 0.5, 0.011, 0.008, 3),
    ]), 'varnish', null, tint);
  };
  bar(0.02, 0.085, 0.055, trimTint);       // the yoke, wider in the middle
  bar(-0.62, 0.045, 0.045, trimTint);      // stern thwart
  bar(1.50, 0.040, 0.040, trimTint);       // bow carry thwart

  // ── seats: varnished frames with a cane panel, hung from the inwales ──────
  const caneTint = (x, y, z) => {
    const weave = 0.90 + 0.10 * Math.sin(x * 210 + caneJitter) * Math.sin(z * 210 - caneJitter);
    return mulRGB(caneC, weave);
  };
  const seat = (z) => {
    const half = Math.max(0.10, bOf(z) - WALL - 0.02);
    const y = sheerOf(z) - 0.155;
    for (const dz of [-0.14, 0.14]) {     // fore/aft rails, full width
      P.add(rod(0.012, half * 2 - 0.01, 6), 'varnish',
        at(0, y, z + dz, 0, 0, Math.PI * 0.5), mulRGB(seatC, 1.0), { facet: true });
    }
    for (const s of [-1, 1]) {            // side rails
      P.add(rod(0.011, 0.26, 6), 'varnish',
        at(s * (half - 0.02), y, z, Math.PI * 0.5, 0, 0), mulRGB(seatC, 0.96), { facet: true });
      for (const dz of [-0.13, 0.13]) {   // hangers up to the gunwale
        const hy = (sheerOf(z + dz) + y) * 0.5;
        P.add(rod(0.0065, sheerOf(z + dz) - y + 0.02, 6), 'varnish',
          at(s * (half - 0.005), hy, z + dz), mulRGB(trimC, 0.9), { facet: true });
      }
    }
    // the woven cane panel
    P.add(shellFromRings([
      rring(new THREE.Vector3(0, y + 0.004, z), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), half - 0.045, 0.115, 0.02, 3),
      rring(new THREE.Vector3(0, y - 0.004, z), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), half - 0.045, 0.115, 0.02, 3),
    ]), 'varnish', null, caneTint);
  };
  seat(0.95);        // bow seat
  seat(-1.28);       // stern seat

  // ── the paddle: single blade, laid ACROSS the gunwales ────────────────────
  // Perpendicular to the hull (user direction, 2026-08-23): shaft resting on
  // both rails just aft of the yoke, blade flat and overhanging one side —
  // the classic "paused paddling" pose. The blade is dead level here, which
  // is what keeps this pose from the fate of the first across-the-gunwales
  // attempt (a drooped blade clipped the hull and poked below the keel).
  // TWO paddles, one per side (user direction, 2026-08-23): the stroke
  // animation dips only the paddle whose side is pulling, so the off-side
  // grip never plunges into the water like a phantom blade. Blade of the
  // first points starboard (+X); the second is yaw-mirrored so its blade
  // hangs over port. Both rest across the rails, one ahead of the yoke and
  // one behind, so they read as a pair and never overlap.
  const diag = 0.04 + paddleYaw * 0.08;               // casual skew off square
  const pz = 0.30 + (paddleZ - 0.5) * 0.2;
  const paddleS = buildCanoePaddle(cw, stripLo ? strips : null, trimC);
  paddleS.position.set(-0.06, sheerOf(pz) + 0.024, pz);
  paddleS.rotation.set(0, diag, 0);                   // blade to starboard
  g.add(paddleS);
  const pz2 = -0.85 - (paddleZ - 0.5) * 0.2;
  const paddleP = buildCanoePaddle(cw, stripLo ? strips : null, trimC);
  paddleP.position.set(0.06, sheerOf(pz2) + 0.024, pz2);
  paddleP.rotation.set(0, Math.PI + diag, 0);         // blade to port
  g.add(paddleP);

  P.flush(g);

  g.userData.dim = { ...CANOE_DIM };
  g.userData.paddle = paddleS;                        // compat: "the" paddle
  g.userData.paddles = { starboard: paddleS, port: paddleP };
  g.userData.colorway = cw.name;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The paddle. Its own Parts flush so it stays a separate, animatable object;
//  pivot at the shaft centre; laid along local X (grip at −X, blade at +X).
// ─────────────────────────────────────────────────────────────────────────────
function buildCanoePaddle(cw, strips, trimC) {
  const grp = new THREE.Group();
  grp.name = 'canoe_paddle';
  const P = new BoatParts('canoe_paddle');
  const bladeC = tintOf(cw.blade);
  const shaftC = mulRGB(tintOf(cw.seat ?? 0xa87c4a), 1.18);   // pale ash shaft

  const SHAFT = 0.86, BLADE = 0.56, GRIP = 0.10;
  // shaft: grip end at −(SHAFT/2+GRIP), throat at +SHAFT/2
  P.add(rod(0.0165, SHAFT + 0.06, 7), 'varnish',
    at(0, 0, 0, 0, 0, Math.PI * 0.5), shaftC);
  // palm grip
  P.add(shellFromRings([0.0, 0.35, 0.75, 1.0].map((f) =>
    rring(new THREE.Vector3(-SHAFT * 0.5 - GRIP * f, 0, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0),
      lerp(0.017, 0.048, Math.pow(f, 0.7)), lerp(0.017, 0.014, f), 0.012, 3),
  )), 'varnish', null, mulRGB(shaftC, 0.94));
  // blade: a lofted leaf, flat side up as it lies stowed
  const bw = [0.022, 0.058, 0.086, 0.100, 0.104, 0.094, 0.060];
  const bt = [0.016, 0.012, 0.010, 0.009, 0.008, 0.007, 0.006];
  P.add(shellFromRings(bw.map((w, i) =>
    rring(new THREE.Vector3(SHAFT * 0.5 + (i / (bw.length - 1)) * BLADE, 0, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), w, bt[i], bt[i] * 0.9, 3),
  )), 'varnish', null, (x, y, z) => {
    let c = strips
      ? mixRGB(strips(z, x * 0.3, x), bladeC, 0.25)     // strip figure on the blade
      : bladeC.slice();
    // the tip takes the wear — a pale rock-worn edge, kept subtle so the
    // blade still reads as one object hanging over the gunwale
    c = mixRGB(c, [0.50, 0.44, 0.34], smoothstep(SHAFT * 0.5 + BLADE - 0.06, SHAFT * 0.5 + BLADE, x) * 0.3);
    // spine highlight down the blade's centre
    return mulRGB(c, 1 + 0.06 * (1 - clamp01(Math.abs(z) / 0.05)));
  });
  P.flush(grp);
  return grp;
}

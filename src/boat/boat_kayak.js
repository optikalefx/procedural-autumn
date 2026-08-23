// ─────────────────────────────────────────────────────────────────────────────
//  boat_kayak — a 4.2 m touring sea kayak.
//
//  One closed monocoque loft: each cross section runs port sheer → keel →
//  starboard sheer (the hull), then jumps to a DUPLICATED sheer point and
//  arches over the deck ridge back to port. The duplication is deliberate —
//  non-indexed duplicates make the hull/deck colour split a real
//  discontinuity instead of a one-quad gradient, and the shared-position seam
//  points are tagged so the tint can draw the seam-tape line exactly on the
//  parting line. Winding by signed volume, smooth normals computed indexed —
//  see boat_materials' header for why both.
//
//  The deck furniture — coaming, hatch domes, perimeter lines, bungees — is
//  what says "sea kayak" at fifteen metres, the way the T-latches say
//  "cooler". The double paddle is a separate object (userData.paddle), pivot
//  at the shaft centre, stowed under the foredeck bungee cross.
//
//  Convention: +Z bow, +Y up, origin at hull centre, static waterline y = 0.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  BoatParts, shellFromRings, rring, ellipseRing, sweptArc, rod, rbox, at,
  tintOf, tintFrom, mixRGB, mulRGB, hash01,
} from './boat_materials.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

export const KAYAK_DIM = { length: 4.2, beam: 0.60, draft: 0.11 };

// ─────────────────────────────────────────────────────────────────────────────
export const KAYAK_COLORWAYS = [
  // Golden-yellow sea kayak, white hull under a charcoal waterline stripe.
  // `coaming` is the bright rim ring, `hatch` the fitted-cover tone, `seat`
  // the pan inside the well — all three exist because the review's read of
  // the accent-black versions was "featureless glossy black blobs … holes
  // filled with tar".
  {
    name: 'Sunrise yellow',
    deck: 0xd9a324, hull: 0xd6d2c6, seam: 0x24262a,
    accent: 0x2a2c2e, stripe: 0x33363a, bungee: 0x2e3033, line: 0xd8cfae,
    coaming: 0xd2ccba, hatch: 0x60646a, seat: 0x74787e,
    blade: 0xd9a324,
  },
  // Deep teal touring deck over a cream hull.
  {
    name: 'Teal touring',
    deck: 0x22585c, hull: 0xd9cfb0, seam: 0x1e2022,
    accent: 0x26282a, stripe: null, bungee: 0xd9cfb0, line: 0x4a4c50,
    coaming: 0xd9cfb0, hatch: 0x577578, seat: 0x777d80,
    blade: 0x22585c,
  },
  // Burnt orange, charcoal deck accents.
  {
    name: 'Ember orange',
    deck: 0xc25a20, hull: 0x9e441b, seam: 0x202224,
    accent: 0x2a2c2e, stripe: null, bungee: 0x232527, line: 0x8c8778,
    coaming: 0xd0b088, hatch: 0x675850, seat: 0x7b7268,
    blade: 0xc25a20,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
export function buildKayak(rnd, opts = {}) {
  const g = new THREE.Group();
  g.name = 'boat_kayak';
  const cw = KAYAK_COLORWAYS[(opts.colorway ?? 0) % KAYAK_COLORWAYS.length];

  const L = KAYAK_DIM.length, HL = L * 0.5;
  const HB = KAYAK_DIM.beam * 0.5;
  const DRAFT = KAYAK_DIM.draft;

  // random character, all drawn up front
  const grimePhase = rnd() * 6.283;
  const paddleYaw = 0.13 + rnd() * 0.06;
  const paddleX = 0.13 + rnd() * 0.03;
  const bungeeSag = 0.9 + rnd() * 0.2;

  // ── longitudinal profiles ─────────────────────────────────────────────────
  const tOf = (z) => clamp(z / HL, -1, 1);
  const bOf = (z) => {
    const t = tOf(z);
    const e = t > 0 ? 1.75 : 2.1;                 // bow finer than the stern
    return Math.max(0.010, HB * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), e)), 0.62));
  };
  const ysOf = (z) => {                            // the sheer / seam line
    const t = tOf(z);
    return 0.085 + 0.045 * Math.pow(Math.abs(t), 2.2) + 0.030 * Math.pow(Math.max(t, 0), 2.5);
  };
  const keelOf = (z) => {
    const t = Math.abs(tOf(z));
    const base = -DRAFT * (1 - Math.pow(t, 2.3));
    return lerp(base, ysOf(z) - 0.025, smoothstep(0.90, 1.0, t));
  };
  const ridgeOf = (z) =>                           // deck peak above the sheer
    0.026
    + 0.078 * Math.exp(-Math.pow((z - 0.42) / 0.95, 2))    // foredeck ridge
    + 0.030 * Math.exp(-Math.pow((z + 1.05) / 0.95, 2));   // low aft deck
  /** Deck surface height at (x, z) — furniture sits ON this. */
  const deckYAt = (z, x) => {
    const b = bOf(z);
    const w = Math.acos(clamp(x / b, -1, 1)) / Math.PI;
    return ysOf(z) + ridgeOf(z) * Math.pow(Math.sin(w * Math.PI), 0.72);
  };

  // ── the ring: hull (tag 0) + seam (tag 2) + deck (tag 1) ─────────────────
  // N=10 so the waterline stripe spans more than one vertex row — colour is
  // per-vertex, and a band thinner than the sample spacing interpolates away.
  const N = 10, MD = 12;
  const ringAt = (z) => {
    const b = bOf(z), ys = ysOf(z), yk = keelOf(z);
    const pts = [], tags = [];
    const push = (x, y, tag) => { pts.push(new THREE.Vector3(x, y, z)); tags.push(tag); };
    // hull: port sheer → keel → starboard sheer (rounded-V, soft chine).
    // `sv` warps the rows toward equal Δy so the waterline stripe spans more
    // than one vertex row — see the canoe's sampling note.
    const hull = (u) => [
      b * Math.pow(Math.sin(u * Math.PI * 0.5), 0.82),
      yk + (ys - yk) * Math.pow(1 - Math.cos(u * Math.PI * 0.5), 1.18),
    ];
    const uy = (f) => Math.acos(1 - Math.pow(Math.max(0, f), 1 / 1.18)) * 2 / Math.PI;
    const sv = (q) => 0.42 * q + 0.58 * uy(q);
    push(-b, ys, 2);                                     // port seam point
    for (let k = 1; k <= N; k++) { const [x, y] = hull(sv(1 - k / N)); push(-x, y, 0); }
    for (let k = 1; k < N; k++) { const [x, y] = hull(sv(k / N)); push(x, y, 0); }
    push(b, ys, 2);                                      // starboard seam point
    // deck: duplicated seam points, then the arch over the ridge
    for (let k = 0; k <= MD; k++) {
      const w = k / MD;                                  // stbd → port
      const x = b * Math.cos(w * Math.PI);
      const y = ys + ridgeOf(z) * Math.pow(Math.sin(w * Math.PI), 0.72);
      push(x, y, k === 0 || k === MD ? 2 : 1);
    }
    return { pts, tags };
  };

  const S = 21;
  const rings = [], ringTags = [];
  for (let i = 0; i <= S; i++) {
    const z = -HL * Math.cos((i / S) * Math.PI) * 0.999;
    const r = ringAt(z);
    rings.push(r.pts); ringTags.push(r.tags);
  }

  // ── colour ────────────────────────────────────────────────────────────────
  const deckC = tintOf(cw.deck);
  const hullC = tintOf(cw.hull);
  const seamC = tintOf(cw.seam);
  const accentC = tintOf(cw.accent);
  const stripeC = cw.stripe ? tintOf(cw.stripe) : null;

  const skinTint = (x, y, z, tag) => {
    if (tag > 1.5) {
      // the parting line — faded out at the stems, where the collapsing ring
      // otherwise concentrates seam colour into a dark blob on the tip
      return mixRGB(seamC, deckC, smoothstep(0.80, 0.95, Math.abs(tOf(z))));
    }
    let c;
    if (tag > 0.5) {
      c = deckC.slice();
      // the ridge catches the sky; the deck edge rolls away from it
      const b = bOf(z);
      c = mulRGB(c, 0.94 + 0.11 * (1 - clamp01(Math.abs(x) / Math.max(b, 0.02))));
      // moulded recess line around the cockpit area — a subtle tone step
      const d = Math.hypot((x) / 0.34, (z + 0.25) / 0.62);
      c = mulRGB(c, 1 - 0.08 * smoothstep(1.15, 0.95, d) * smoothstep(0.7, 1.0, d));
    } else {
      c = hullC.slice();
      // wetted band below the waterline, with a ragged dried edge
      const ragged = 0.012 * Math.sin(z * 7.3 + grimePhase) + 0.006 * Math.sin(z * 17.1 - grimePhase);
      const wet = smoothstep(0.018 + ragged, -0.05, y);
      const lum = (c[0] + c[1] + c[2]) / 3;
      c = mixRGB(c, [lum * 0.52, lum * 0.60, lum * 0.62], wet * 0.34);
      if (stripeC) {
        // topsides only — see the canoe's note on the rockered bottom
        // wandering through the stripe's height band near the stems
        const onSide = smoothstep(0.35, 0.6, Math.abs(x) / Math.max(bOf(z), 0.02))
                     * (1 - smoothstep(0.75, 0.93, Math.abs(tOf(z))));
        const s = smoothstep(0.016, 0.024, y) * (1 - smoothstep(0.038, 0.046, y));
        c = mixRGB(c, stripeC, s * onSide * 0.92);
      }
      // topsides pick up the sky just under the seam
      c = mulRGB(c, 1 + 0.06 * smoothstep(ysOf(z) - 0.07, ysOf(z), y));
    }
    return c;
  };

  const P = new BoatParts('kayak');
  P.add(shellFromRings(rings, ringTags), 'glass', null, skinTint);

  // ── cockpit coaming: raised lip, dark open well ───────────────────────────
  // 0.40 × 0.84 m opening on a 0.60 m beam — round 1 drew it at 0.52 wide and
  // the whole midships read as one black pillow.
  const CX = 0.20, CZ = 0.42, ZC = -0.25;
  {
    const rim = deckYAt(ZC, 0) + 0.048;
    const coamC = tintOf(cw.coaming);
    const seatC = tintOf(cw.seat);
    const ell = (kx, y, yFollow = false) =>
      ellipseRing(0, y, ZC, CX * kx, CZ * kx, 22,
        yFollow ? (x, z) => deckYAt(z, x) - 0.006 : null);
    // tags: 0 riser, 1 the rolled lip (bright), 2 the well
    const rings2 = [
      ell(1.10, 0, true),                    // rooted just under the deck
      ell(1.02, rim - 0.016),
      ell(1.06, rim - 0.004),                // the outward-rolled lip
      ell(1.00, rim),
      ell(0.86, rim - 0.010),                // rolls in and drops…
      ell(0.78, rim - 0.058),                // …into the well
    ];
    const tags2 = [0, 1, 1, 1, 2, 2];
    P.add(shellFromRings(rings2, tags2.map((t) => new Array(22).fill(t))), 'glass', null,
      (x, y, z, tag) => {
        // A cockpit is a rim you can read at fifteen metres, not a hole. The
        // rolled lip takes the colourway's bright coaming tone with a top
        // highlight; the well below it steps down to a legible dark grey
        // instead of the old 0.028 tar.
        if (tag > 1.5) {
          const d = smoothstep(rim - 0.008, rim - 0.052, y);
          return mulRGB([0.105, 0.106, 0.112], 1 - 0.35 * d);
        }
        if (tag > 0.5) return mulRGB(coamC, 0.92 + 0.22 * smoothstep(rim - 0.018, rim, y));
        return mulRGB(accentC, 1.35);
      });
    // the seat pan — one clear value step above the well walls, sitting where
    // a moulded seat sits, aft of the well's centre
    // 'glass', not 'plastic' — plastic's base colour is 0x2a2a2e and a vertex
    // tint multiplies it, which is how the first pan came out tar again
    P.add(shellFromRings([
      ellipseRing(0, rim - 0.034, ZC - 0.055, CX * 0.62, CZ * 0.52, 18),
      ellipseRing(0, rim - 0.046, ZC - 0.035, CX * 0.52, CZ * 0.44, 18),
    ]), 'glass', null,
    (x, y, z) => mulRGB(seatC,
      0.95 + 0.18 * smoothstep(ZC - 0.05, ZC + 0.18, z)      // front edge catches light
            + 0.10 * smoothstep(rim - 0.040, rim - 0.032, y)));
  }

  // ── hatch domes, fore and aft ─────────────────────────────────────────────
  // Fitted covers, not holes: the cover itself carries the colourway's hatch
  // tone with a crown highlight, the gasket ring below it stays dark so the
  // seam reads, and a bright rim bead around the cover edge is the "this is a
  // separate part that comes off" cue the review asked for.
  const hatchC = tintOf(cw.hatch);
  const hatch = (zc, rx, rz) => {
    const yb = deckYAt(zc, 0);
    const dome = [
      ellipseRing(0, 0, zc, rx * 1.14, rz * 1.14, 18, (x, z) => deckYAt(z, x) - 0.004),
      ellipseRing(0, yb + 0.016, zc, rx, rz, 18),
      ellipseRing(0, yb + 0.030, zc, rx * 0.80, rz * 0.80, 18),
      ellipseRing(0, yb + 0.037, zc, rx * 0.42, rz * 0.42, 18),
    ];
    P.add(shellFromRings(dome, [0, 1, 1, 1].map((t) => new Array(18).fill(t))), 'glass', null,
      (x, y, z, tag) => tag < 0.5
        ? mulRGB(hatchC, 0.40)                            // the gasket seam ring
        : mulRGB(hatchC, 0.95 + 0.35 * smoothstep(yb + 0.012, yb + 0.037, y)));
    // rim bead where the cover meets the gasket
    P.add(sweptArc((t) => {
      const th = t * Math.PI * 2;
      return new THREE.Vector3(rx * 1.01 * Math.cos(th), yb + 0.015, zc + rz * 1.01 * Math.sin(th));
    }, 24, 0.0050, 5), 'glass', null, mulRGB(hatchC, 1.45));
    // hold-down strap across the dome
    P.add(rbox(rx * 2.3, 0.008, 0.024, 0.003, 1), 'rubber',
      at(0, yb + 0.030, zc), mulRGB(hatchC, 0.55), { facet: true });
  };
  hatch(1.28, 0.145, 0.215);
  hatch(-1.38, 0.165, 0.245);

  // ── deck rigging ──────────────────────────────────────────────────────────
  const lineC = tintFrom(0xd8cfae, cw.line);
  const bungeeC = tintFrom(0xd8cfae, cw.bungee);
  const fitC = mulRGB(tintOf(0x26282b), 1);
  const fitting = (x, z) => {
    P.add(rbox(0.030, 0.012, 0.020, 0.004, 1), 'plastic',
      at(x, deckYAt(z, x) + 0.004, z, 0, 0, 0), fitC, { facet: true });
  };
  // perimeter static lines, both sides, fore and aft of the cockpit
  const deckLine = (z0, z1) => {
    for (const s of [-1, 1]) {
      P.add(sweptArc((t) => {
        const z = lerp(z0, z1, t);
        const x = s * bOf(z) * 0.84;
        // sags a touch between fittings
        const sag = 0.006 * Math.sin(t * Math.PI * 3) * Math.sin(t * Math.PI);
        return new THREE.Vector3(x, deckYAt(z, x) + 0.012 - sag, z);
      }, 22, 0.0042, 5), 'cord', null, lineC);
      fitting(s * bOf(z0) * 0.85, z0);
      fitting(s * bOf((z0 + z1) / 2) * 0.86, (z0 + z1) / 2);
      fitting(s * bOf(z1) * 0.86, z1);
    }
  };
  deckLine(0.42, 1.86);
  deckLine(-0.78, -1.88);

  // bungee cross on the foredeck. The paddle no longer runs under it (it lies
  // ACROSS the deck now — see below), so the lines lie flat on the deck.
  const bungee = (x0, z0, x1, z1) => {
    P.add(sweptArc((t) => {
      const z = lerp(z0, z1, t);
      const x = lerp(x0, x1, t);
      return new THREE.Vector3(x, deckYAt(z, x) + 0.007, z);
    }, 26, 0.0050, 5), 'cord', null, bungeeC);
    fitting(x0, z0); fitting(x1, z1);
  };
  {
    const xf = (z) => bOf(z) * 0.72;
    bungee(-xf(0.52), 0.52, xf(1.12), 1.12);
    bungee(xf(0.52), 0.52, -xf(1.12), 1.12);
    // aft deck: two parallel bungees over the aft hatch approach
    for (const dz of [-0.72, -0.96]) {
      P.add(sweptArc((t) => {
        const x = lerp(-bOf(dz) * 0.7, bOf(dz) * 0.7, t);
        return new THREE.Vector3(x, deckYAt(dz, x) + 0.007, dz);
      }, 16, 0.0048, 5), 'cord', null, bungeeC);
      fitting(-bOf(dz) * 0.72, dz); fitting(bOf(dz) * 0.72, dz);
    }
  }

  // ── skeg hint at the stern ────────────────────────────────────────────────
  {
    const zs = -1.62;
    P.add(rbox(0.013, 0.11, 0.34, 0.005, 1), 'glass',
      at(0, keelOf(zs) - 0.020, zs, -0.18, 0, 0), mulRGB(seamC, 1.4), { facet: true });
  }

  // ── the double paddle, resting ACROSS the foredeck ────────────────────────
  // Perpendicular to the hull (user direction, 2026-08-23): shaft across the
  // deck between the coaming front (z≈0.17) and the bungee X (z≥0.52), the
  // way a kayaker parks the paddle to pause. The blades' built-in droop lays
  // the tips toward the water on both sides.
  const paddle = buildKayakPaddle(cw);
  const pz = 0.33 + (paddleX - 0.13) * 0.6;           // keeps the rnd variance
  paddle.position.set(0.03, deckYAt(pz, 0) + 0.0155, pz);
  paddle.rotation.set(0, 0.05 + paddleYaw * 0.3, 0);  // shaft across the beam
  g.add(paddle);

  P.flush(g);

  g.userData.dim = { ...KAYAK_DIM };
  g.userData.paddle = paddle;
  g.userData.colorway = cw.name;
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Double-blade paddle. Shaft along local X, pivot at the shaft centre, blades
//  feathered ~60° from each other the way a stowed touring paddle is.
// ─────────────────────────────────────────────────────────────────────────────
function buildKayakPaddle(cw) {
  const grp = new THREE.Group();
  grp.name = 'kayak_paddle';
  const P = new BoatParts('kayak_paddle');
  const bladeC = tintOf(cw.blade);
  const shaftC = tintOf(0x2c2e31);            // carbon shaft on every colourway

  const SHAFT = 2.12, BLADE = 0.46;
  P.add(rod(0.0148, SHAFT, 7), 'plastic', at(0, 0, 0, 0, 0, Math.PI * 0.5), shaftC);
  // drip rings
  for (const s of [-1, 1]) {
    P.add(rod(0.024, 0.014, 8), 'rubber',
      at(s * SHAFT * 0.30, 0, 0, 0, 0, Math.PI * 0.5), mulRGB(shaftC, 0.8), { facet: true });
  }

  const blade = (sgn, feather) => {
    const U = new THREE.Vector3(0, Math.sin(feather), Math.cos(feather));
    const V = new THREE.Vector3(0, Math.cos(feather), -Math.sin(feather));
    const bw = [0.018, 0.048, 0.070, 0.082, 0.086, 0.078, 0.050];
    const bt = [0.014, 0.011, 0.009, 0.008, 0.007, 0.006, 0.005];
    const x0 = SHAFT * 0.5 - 0.06;
    P.add(shellFromRings(bw.map((w, i) => {
      const d = (i / (bw.length - 1)) * BLADE;
      // the droop: blades bend down toward their tips so a paddle whose shaft
      // rides the deck ridge still lays its blades ON the falling deck — the
      // stowed pose is the only pose this asset is ever seen in
      return rring(new THREE.Vector3(sgn * (x0 + d), -0.13 * d, 0), U, V, w, bt[i], bt[i] * 0.9, 3);
    })), 'glass', null, (x, y, z) => {
      let c = bladeC.slice();
      const tip = smoothstep(x0 + BLADE - 0.08, x0 + BLADE, Math.abs(x));
      c = mixRGB(c, [0.50, 0.44, 0.34], tip * 0.45);                   // worn tip
      return mulRGB(c, 1 + 0.07 * (1 - clamp01(Math.hypot(y, z) / 0.05)));
    });
  };
  blade(1, -0.24);                             // aft blade rolls with the deck edge
  blade(-1, 0.06);                             // fore blade flat under the bungee X
  P.flush(grp);
  return grp;
}

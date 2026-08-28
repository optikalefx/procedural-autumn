#!/usr/bin/env node
/**
 * The marshmallow's SILHOUETTE, measured rather than argued about.
 *
 * Round 3's critique is that the object "reads as a BALL, not a squat
 * cylinder", and the two candidate causes — this file's lathe, and
 * `marshmallow_toast.js`'s vertex-shader swell — cannot be separated by looking
 * at a render, because every macro frame from `mallow-1` up has both in it.
 * This separates them: it builds the real geometry out of `buildHeldStick`,
 * optionally applies the toast stage's displacement in closed form, projects it
 * through `roastshot.mjs`'s own macro camera, rasterises the silhouette and
 * measures it.
 *
 *   node tools/_scratch/mallowsil.mjs
 *   node tools/_scratch/mallowsil.mjs --az 1.32 --elev 0.6      # the backlit pose
 *   node tools/_scratch/mallowsil.mjs --seeds 40 --sweep
 *
 * ── the three numbers, and why these three ──────────────────────────────────
 *
 * `aspect` (across / along, in the silhouette's own frame) is the obvious one
 * and it is NOT the discriminator: at a 34-degree three-quarter a 42x26 mm
 * cylinder projects to 42 x 44.6 mm and is already square in bounding box. What
 * separates a cylinder from a ball at that pose is the OUTLINE, so:
 *
 *   fill      silhouette area / bbox area. A circle or any ellipse is pi/4 =
 *             0.785 no matter how it is squashed; a rounded rectangle is more,
 *             and how much more is exactly how much corner is left.
 *   circ      4·pi·A / P^2. 1.000 for a circle, and it falls as an outline
 *             acquires straight runs and corners.
 *   flat      the fraction of the outline whose turning is under a fifth of a
 *             circle's — i.e. how much of the silhouette is a straight edge.
 *             A sphere is 0 by construction. This is the number the eye is
 *             actually reading when it says "cylinder".
 *
 * Rasterised at 1200 px across the subject, which is 10x the 110 px the held
 * view renders it at, so the metrics are the shape's and not the sampler's.
 */
import * as THREE from 'three';
import { buildHeldStick } from '../../src/camp/camp_marshmallow.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : Number(argv[i + 1]);
};
const has = (n) => argv.includes(`--${n}`);

const AZ = arg('az', 0.6);          // roastshot MACRO_AZ
const EL = arg('elev', 0.28);       // roastshot MACRO_ELEV
const SEEDS = arg('seeds', 24);
const RES = 1200;

const mk = (s) => () => {
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
  return ((s >>> 0) % 1e6) / 1e6;
};

/** The toast stage's melt channel at a given doneness (`ToastMap.setDoneness`). */
const meltAt = (t) => Math.min(1, Math.pow(t, 0.85) * 0.95);
/** The view's uSwell (`_publishUniforms`): smoothstep(0.10, 0.66, doneness). */
const swellAt = (t) => {
  const k = Math.max(0, Math.min(1, (t - 0.10) / 0.56));
  return k * k * (3 - 2 * k);
};

/**
 * The silhouette of a mesh, as a boolean raster, plus its metrics.
 *
 * @param pos   Float32Array of positions, in the mallow's own local space
 * @param nrm   matching normals
 * @param idx   triangle indices
 * @param quat  the mallow's own rotation (local -> held space)
 * @param swell metres of displacement along the object normal
 */
function silhouette(pos, nrm, idx, quat, swell, azDir) {
  // Displace, then rotate into the space the camera is described in.
  const n = pos.length / 3;
  const P = new Float32Array(n * 3);
  const q = quat;
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos[i * 3] + nrm[i * 3] * swell,
          pos[i * 3 + 1] + nrm[i * 3 + 1] * swell,
          pos[i * 3 + 2] + nrm[i * 3 + 2] * swell).applyQuaternion(q);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
  }

  // An orthographic basis with `azDir` as the view direction. Orthographic
  // rather than perspective on purpose: the macro is a 12-degree lens at 0.4 m,
  // so perspective contributes about 3% of foreshortening across a 42 mm
  // subject, and an ortho silhouette is a statement about the SHAPE that does
  // not have to carry the harness's distance with it.
  const fwd = azDir.clone().normalize();
  const up0 = Math.abs(fwd.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const ex = new THREE.Vector3().crossVectors(up0, fwd).normalize();
  const ey = new THREE.Vector3().crossVectors(fwd, ex).normalize();

  const X = new Float64Array(n), Y = new Float64Array(n);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const a = px * ex.x + py * ex.y + pz * ex.z;
    const b = px * ey.x + py * ey.y + pz * ey.z;
    X[i] = a; Y[i] = b;
    if (a < x0) x0 = a; if (a > x1) x1 = a;
    if (b < y0) y0 = b; if (b > y1) y1 = b;
  }
  const span = Math.max(x1 - x0, y1 - y0);
  const sc = (RES - 8) / span;
  const ox = -x0 * sc + 4, oy = -y0 * sc + 4;

  const mask = new Uint8Array(RES * RES);
  const tri = (ia, ib, ic) => {
    const ax = X[ia] * sc + ox, ay = Y[ia] * sc + oy;
    const bx = X[ib] * sc + ox, by = Y[ib] * sc + oy;
    const cx = X[ic] * sc + ox, cy = Y[ic] * sc + oy;
    const lo = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const hi = Math.min(RES - 1, Math.ceil(Math.max(ax, bx, cx)));
    const lo2 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const hi2 = Math.min(RES - 1, Math.ceil(Math.max(ay, by, cy)));
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(d) < 1e-12) return;
    for (let py = lo2; py <= hi2; py++) {
      for (let px = lo; px <= hi; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const w0 = ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax)) / d;
        const w1 = ((qx - ax) * (cy - ay) - (qy - ay) * (cx - ax)) / d;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) mask[py * RES + px] = 1;
      }
    }
  };
  for (let t = 0; t < idx.length; t += 3) tri(idx[t], idx[t + 1], idx[t + 2]);

  return measure(mask, sc);
}

/**
 * Metrics of a filled mask. The bbox is taken in the silhouette's OWN principal
 * frame (PCA of the filled pixels), not in raster axes, so `aspect` is a
 * statement about the object rather than about how the harness happened to
 * orient it.
 */
function measure(mask, sc) {
  let A = 0, sx = 0, sy = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) if (mask[y * RES + x]) { A++; sx += x; sy += y; }
  }
  if (!A) return null;
  const cx = sx / A, cy = sy / A;
  let mxx = 0, myy = 0, mxy = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (!mask[y * RES + x]) continue;
      const dx = x - cx, dy = y - cy;
      mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
    }
  }
  mxx /= A; myy /= A; mxy /= A;
  const th = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const ux = Math.cos(th), uy = Math.sin(th);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (!mask[y * RES + x]) continue;
      const a = (x - cx) * ux + (y - cy) * uy;
      const b = -(x - cx) * uy + (y - cy) * ux;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
  }
  const W = a1 - a0, H = b1 - b0;

  // The outline, as an ordered chain, by marching the boundary. Its LENGTH is
  // summed from the actual steps rather than counted: a Moore trace takes
  // diagonal steps, and counting them as 1 shortens the perimeter by up to 30%,
  // which puts 4·pi·A/P^2 above 1 and makes the instrument look broken.
  const out = trace(mask);
  const P = out.length;
  let per = 0;
  for (let i = 0; i < P; i++) {
    const a = out[i], b = out[(i + 1) % P];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  // Turning per unit length, from a chord long enough not to be reading the
  // rasteriser's staircase: 3% of the perimeter either side.
  const k = Math.max(4, Math.round(P * 0.03));
  const isFlat = new Uint8Array(P);
  for (let i = 0; i < P; i++) {
    const a = out[(i - k + P) % P], b = out[i], c = out[(i + k) % P];
    const t0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const t1 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let dt = t1 - t0;
    while (dt > Math.PI) dt -= 2 * Math.PI;
    while (dt < -Math.PI) dt += 2 * Math.PI;
    // A circle of this perimeter turns 2·pi·(2k/P) over the same chord pair.
    const circle = 2 * Math.PI * (2 * k / P);
    if (Math.abs(dt) < circle * 0.35) isFlat[i] = 1;
  }
  let flat = 0;
  for (let i = 0; i < P; i++) flat += isFlat[i];
  // The longest UNBROKEN straight run, as a fraction of the bbox diagonal. This
  // is the one the eye reads: a silhouette can be 30% straight in eight
  // scattered pieces and still read as a lumpy ball. One long edge is an edge.
  let run = 0, best = 0;
  for (let i = 0; i < P * 2; i++) {
    if (isFlat[i % P]) { run++; if (run > best) best = run; } else run = 0;
  }
  best = Math.min(best, P);
  const edge = (best / P) * per / Math.hypot(W, H);

  return {
    aspect: W / H,
    fill: A / (W * H),
    circ: (4 * Math.PI * A) / (per * per),
    flat: flat / P,
    edge,
    wMM: (W / sc) * 1000,
    hMM: (H / sc) * 1000,
  };
}

/** Moore-neighbour boundary trace of the largest blob. */
function trace(mask) {
  let s = -1;
  for (let i = 0; i < RES * RES && s < 0; i++) if (mask[i]) s = i;
  const at = (x, y) => (x < 0 || y < 0 || x >= RES || y >= RES) ? 0 : mask[y * RES + x];
  const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let x = s % RES, y = (s / RES) | 0, d = 0;
  const start = [x, y];
  const chain = [];
  for (let guard = 0; guard < 400000; guard++) {
    chain.push([x, y]);
    let moved = false;
    for (let i = 0; i < 8; i++) {
      const nd = (d + 6 + i) % 8;
      const nx = x + D[nd][0], ny = y + D[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
    }
    if (!moved) break;
    if (x === start[0] && y === start[1]) break;
  }
  return chain;
}

// ── run ─────────────────────────────────────────────────────────────────────

const dirFor = (axis, seatSide) => {
  // roastshot's `macroPose`: side = up x axis (signed toward the player), front
  // = -axis, dir = (side·cos(az) + front·sin(az)) then tilted by elev toward up.
  const UP = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(UP, axis).normalize();
  if (side.dot(seatSide) < 0) side.negate();
  const front = axis.clone().negate();
  const d = side.clone().multiplyScalar(Math.cos(AZ)).addScaledVector(front, Math.sin(AZ));
  d.normalize().multiplyScalar(Math.cos(EL)).addScaledVector(UP, Math.sin(EL));
  return d.normalize();
};

const CASES = has('sweep')
  ? [['raw', 0], ['warmed', 0.2], ['gold', 0.42], ['dark gold', 0.6],
     ['mahogany', 0.78], ['char', 0.95]]
  : [['raw  (lathe alone)', 0], ['dark gold (mallow-3)', 0.6], ['char (mallow-5)', 0.95]];

const acc = new Map();
for (let i = 0; i < SEEDS; i++) {
  const g = buildHeldStick(mk(0x5bd1e995 ^ (i * 2654435761)), {});
  const m = g.userData.held.mallow;
  const pos = m.geometry.attributes.position.array;
  const nrm = m.geometry.attributes.normal.array;
  const idx = m.geometry.index.array;
  const axis = m.position.clone().normalize();          // grip -> mallow
  const seat = new THREE.Vector3(1, 0, 0);              // the player's side
  const dir = dirFor(axis, seat);

  for (const [name, done] of CASES) {
    const swell = swellAt(done) * g.userData.held.radius * 0.20
                * (0.60 + 0.40 * meltAt(done));
    const r = silhouette(pos, nrm, idx, m.quaternion, swell, dir);
    if (!acc.has(name)) acc.set(name, []);
    acc.get(name).push({ ...r, swell });
  }
}

const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log(`marshmallow silhouette — az=${AZ} elev=${EL}, ${SEEDS} seeds, medians\n`);
console.log('  case                     swell   across x along mm    aspect   fill    circ    flat    edge');
for (const [name, rows] of acc) {
  const p = (k) => med(rows.map((r) => r[k]));
  console.log(`  ${name.padEnd(22)}  ${(med(rows.map((r) => r.swell)) * 1000).toFixed(2)}mm  ` +
    `${p('wMM').toFixed(1)} x ${p('hMM').toFixed(1)}      ` +
    `${p('aspect').toFixed(3)}  ${p('fill').toFixed(3)}  ${p('circ').toFixed(3)}  ${p('flat').toFixed(3)}  ${p('edge').toFixed(3)}`);
}
console.log('\n  reference: a sphere is aspect 1.000  fill 0.785  circ 1.000  flat 0.000  edge 0.000');

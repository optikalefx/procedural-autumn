#!/usr/bin/env node
/**
 * Water lab — does the water math survive terrain it was not tuned on?
 *
 *   node tools/waterlab.mjs                            # every case, metrics + sheet
 *   node tools/waterlab.mjs --case talus --zoom
 *   node tools/waterlab.mjs --tag mine                 # write shots/waterlab/mine/
 *   node tools/waterlab.mjs --compare base mine        # A/B two tagged runs
 *
 * ── why this exists ──────────────────────────────────────────────────────────
 *
 * Every water defect this project has logged was found by looking at ONE map,
 * from a handful of frozen camera anchors, in a browser, twenty-five seconds
 * per bake. That instrument cannot answer the only question that matters about
 * a shoreline rule — "does it hold on ground the author did not have in front
 * of them" — and it cannot answer it *quickly*, which is worse, because a rule
 * that has to be judged by eye at half a minute a look gets tuned until the
 * frozen anchors are clean and no further.
 *
 * So: nine terrains, chosen to be hostile in nine different ways, driven
 * through the REAL pipeline — TerrainGen's own _fillDepressions,
 * _flowAccumulation, _carveChannels, _waterSurface, verbatim, no
 * reimplementation — and measured. Two seconds a case. Nothing here is a model
 * of the water code; it is the water code, with a different heightfield handed
 * to it.
 *
 * ── what it measures, and why those quantities ───────────────────────────────
 *
 * The waterline the player sees is NOT the mesh boundary. Water.js cuts the
 * mesh on a contour at SURF_ISO = -1.4 m, deliberately out on the dry side, and
 * the visible edge is the fragment shader's depth test: water exists where
 * `S(x,z) - B(x,z) > 0`, with S the water surface (smooth — a lake is exactly
 * level and a channel drops a few percent) and B the bed sampled bilinearly
 * from the baked heightfield at 2 m texels.
 *
 * So the waterline is the zero set of a smooth function minus a rough one, and
 * ALL of its shape comes from B. That is not a rendering opinion, it is
 * arithmetic: perturb B by a bump of height e where the bed slope is g, and the
 * waterline moves e/g metres. On this map's flat aprons g is 1:30, so eight
 * centimetres of bed noise — a tenth of what erosion leaves — swings the
 * waterline by two and a half metres. That is the scalloped, lobed edge in
 * shots/w0-base/waterfall.png, and it is why `bedRms` below is reported in the
 * same table as the shape metrics: it is the cause and they are the symptom.
 *
 * Every metric is computed on the zero contour of the supersampled depth field,
 * extracted by marching squares at SS x the texel rate, so it measures the
 * curve the shader draws rather than any lattice the mesh happens to use.
 *
 *   crenel    contour length / length of the same contour after its own
 *             positions are Gaussian-smoothed at 4 m. A clean shoreline is
 *             1.00-1.08. A crenellated one runs 1.4-3.
 *   fine      % of contour length whose curvature radius is under 3 m — i.e.
 *             detail finer than the bed texel that produced it. This is the
 *             direct "jagged" number.
 *   stair     excess of contour direction mass at the eight lattice angles over
 *             a uniform distribution. Catches D8 staircases and cell-aligned
 *             polygon edges, which `crenel` alone can score as merely wiggly.
 *   speck     water bodies under 40 m^2, plus dry islands under 40 m^2 inside
 *             water, per km^2 of map. Puddle-shaped bugs and pinholes.
 *   grad10    10th percentile of |grad(depth)| along the contour, m/m. This is
 *             CONDITIONING, not shape: where it is near zero the waterline's
 *             position is hypersensitive to the bed, so it shimmers and crawls
 *             in motion even when a still frame looks fine.
 *   bedRms    RMS of B minus an 8 m box blur of B, over the shallow band
 *             |depth| < 1 m, in metres. The driver.
 *   bedStep   worst single-texel bed jump inside the wet mask, metres.
 *   area      water area as a fraction of the patch. A regression guard: a
 *             "fix" that scores well by deleting water is caught here.
 *
 * A case also FAILS LOUDLY if it produced no water at all — a silent zero is
 * how a harness reports ten clean numbers about nothing.
 */
import { TerrainGen } from '../src/world/TerrainGen.js';
import { NoiseField } from '../src/core/Noise.js';
import { writePNG, canvas, text } from './_png.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const RES = parseInt(arg('res', '512'), 10);
const WORLD = parseFloat(arg('world', String(RES * 2)));   // 2 m texels, as shipped
const TEXEL = WORLD / RES;
const SS = parseInt(arg('ss', '4'), 10);                   // contour supersampling
const TAG = arg('tag', 'run');
const OUTDIR = `shots/waterlab/${TAG}`;
const ONLY = arg('case', null);
const SCALE = parseInt(arg('scale', '2'), 10);   // render pixels per texel

// ── the terrains ─────────────────────────────────────────────────────────────
//
// Each is a landform plus a roughness, and the two are separate on purpose: the
// landform decides where water goes, the roughness decides whether the water
// can cope. A case is named for the roughness it is testing, because that is
// the variable — every one of them drains, because a case that makes no water
// measures nothing.
//
// All of them tilt from +Z to -Z so the priority flood's border seeding has an
// outlet and D8 has somewhere to run. Amplitudes are in metres and were chosen
// against the real bake: `bedRms` on the shipped map's shallow band measures in
// the same range these do, which is the point — a synthetic case nobody could
// meet is not a test, it is an excuse.
const CASES = {
  // A near-flat floodplain. The pathological case for placing a waterline: the
  // bed gradient is 1:60, so every centimetre of bed noise is six centimetres
  // of waterline. Nothing about this is exotic — most of this map's basin is
  // exactly this.
  flat: (n, x, z, u, v) => {
    const tilt = -v * 9.0;
    const swale = n.fbm(u * 2.0, v * 2.0, 3, 2, 0.5) * 5.0;
    const micro = n.fbm(u * 26.0, v * 26.0, 3, 2, 0.5) * 0.35;
    return 40 + tilt + swale + micro - valley(u, 0.5, 0.16) * 5.5;
  },
  // The case in the screenshot: a strong high-frequency roughness on gentle
  // ground. Scree, hummock, boulder field, the debris an erosion pass leaves.
  // The channel through it is real; whether the water's edge survives it is the
  // whole question.
  talus: (n, x, z, u, v) => {
    const tilt = -v * 16.0;
    const swale = n.fbm(u * 2.2, v * 2.2, 3, 2, 0.5) * 7.0;
    const rough = (n.fbm(u * 34.0, v * 34.0, 4, 2.1, 0.55) * 1.9
                 + n.fbm(u * 70.0, v * 70.0, 3, 2.0, 0.5) * 0.9);
    return 46 + tilt + swale + rough - valley(u, 0.5, 0.13) * 7.0;
  },
  // Benched ground — the terrace operator's output, and every lip is a place
  // for a surface to be bridged across two levels.
  bench: (n, x, z, u, v) => {
    const tilt = -v * 30.0;
    const swale = n.fbm(u * 1.8, v * 1.8, 3, 2, 0.5) * 6.0;
    const q = (60 + tilt + swale) / 4.0;
    const stepped = (Math.floor(q) + smooth01(q - Math.floor(q), 0.30, 0.72)) * 4.0;
    return stepped + n.fbm(u * 30.0, v * 30.0, 3, 2, 0.5) * 0.45 - valley(u, 0.5, 0.11) * 6.0;
  },
  // A steep, narrow, incised gorge. Tests the other end: the bed gradient is
  // enormous, so the waterline is well conditioned, and what fails instead is
  // the level-step cull and anything that assumes a level surface.
  gorge: (n, x, z, u, v) => {
    const tilt = -v * 52.0;
    const walls = Math.pow(Math.abs(u - 0.5) * 2, 1.6) * 96.0;
    return 30 + tilt + walls + n.fbm(u * 16.0, v * 16.0, 4, 2, 0.5) * 1.6;
  },
  // A basin with a rough rim: a lake, and a shoreline that has to hold against
  // ground that is not smooth anywhere near it.
  bowl: (n, x, z, u, v) => {
    const r = Math.hypot(u - 0.5, v - 0.45) * 2.1;
    const bowl = smooth01(r, 0.12, 0.92) * 46.0;
    const rim = n.fbm(u * 9.0, v * 9.0, 4, 2, 0.5) * 6.5 * smooth01(r, 0.30, 0.80);
    const rough = n.fbm(u * 40.0, v * 40.0, 4, 2, 0.5) * 1.4;
    // A notch in the rim, so it spills and there is an outlet reach as well.
    const notch = Math.exp(-Math.pow((u - 0.78) / 0.06, 2) - Math.pow((v - 0.95) / 0.22, 2)) * 22.0;
    return 24 + bowl + rim + rough - notch - v * 5.0;
  },
  // Two reaches meeting standing water, which is the junction the whole
  // `mouth` framing exists for — flare, level handover, delta.
  delta: (n, x, z, u, v) => {
    const pond = smooth01(Math.hypot(u - 0.5, v - 0.82) * 2.4, 0.10, 0.62) * 26.0;
    const tilt = -v * 26.0;
    const feedA = valley(u, 0.34, 0.09) * 9.0 * smooth01(v, 0.72, 0.06);
    const feedB = valley(u, 0.68, 0.08) * 8.0 * smooth01(v, 0.70, 0.05);
    return 34 + tilt + pond * 0.0 + Math.min(pond, 26) - feedA - feedB
         + n.fbm(u * 28.0, v * 28.0, 4, 2, 0.5) * 1.1;
  },
  // A wide, shallow, braided run — many threads, none of them deep. The mask
  // that draws it is one texel wide in places and every rejection rule in the
  // splat gets to bite.
  braid: (n, x, z, u, v) => {
    const tilt = -v * 11.0;
    const pan = -smooth01(Math.abs(u - 0.5), 0.34, 0.02) * 4.5;
    const bars = Math.abs(n.fbm(u * 7.0, v * 3.0, 3, 2, 0.5)) * 1.5;
    return 38 + tilt + pan + bars + n.fbm(u * 32.0, v * 32.0, 4, 2, 0.5) * 0.7;
  },
  // A bedrock step across the line of drainage: a waterfall, and the lip and
  // plunge pool either side of it.
  step: (n, x, z, u, v) => {
    const tilt = -v * 18.0;
    const drop = smooth01(v, 0.46, 0.54) * 26.0;
    return 52 + tilt - drop - valley(u, 0.5, 0.12) * 8.0
         + n.fbm(u * 24.0, v * 24.0, 4, 2, 0.5) * 1.6;
  },
  // A meander belt on a flat floor: the case where two limbs of one channel
  // pass within a dilation ring of each other.
  meander: (n, x, z, u, v) => {
    const tilt = -v * 8.0;
    const belt = Math.abs(u - (0.5 + Math.sin(v * 11.0) * 0.16));
    const cut = smooth01(belt, 0.10, 0.01) * 6.0;
    return 42 + tilt - cut + n.fbm(u * 30.0, v * 30.0, 4, 2, 0.5) * 0.6;
  },
};

function smooth01(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** A soft V centred at `c`, half-width `w`, returning 1 at the axis. */
function valley(u, c, w) {
  return Math.max(0, 1 - Math.abs(u - c) / w) ** 1.4;
}

// ── run one case through the real pipeline ───────────────────────────────────
function bake(name) {
  const f = CASES[name];
  const gen = new TerrainGen({ res: RES, worldSize: WORLD, seed: 20261018 });
  const n = new NoiseField(20261018 ^ 0x9e37);
  const N = RES * RES;
  const h = new Float32Array(N);
  for (let z = 0; z < RES; z++) {
    for (let x = 0; x < RES; x++) {
      const u = x / (RES - 1), v = z / (RES - 1);
      h[z * RES + x] = f(n, x * TEXEL, z * TEXEL, u, v);
    }
  }
  gen.height = h;
  gen.hardness = new Float32Array(N).fill(0.5);
  gen.sediment = new Float32Array(N);

  const t0 = Date.now();
  gen._fillDepressions();
  gen._flowAccumulation();
  gen._carveChannels();
  gen._waterSurface();
  gen._flowField();
  const ms = Date.now() - t0;
  return { name, gen, ms };
}

// ── the depth field the shader sees ──────────────────────────────────────────
/**
 * S - B, per texel, with S extended off the wet mask so the contour has ground
 * to cross.
 *
 * `water` is -9999 on dry texels, so a naive difference has a cliff at the mask
 * edge and the contour would trace the MASK rather than the waterline. The
 * extension is a bounded nearest-water propagation, which is what Water.js's
 * dilation ring does with the same justification: those cells are never seen as
 * water unless the ground genuinely lies below the surface there, and without
 * them there is nowhere for the edge to be.
 */
function depthField(gen) {
  const R = gen.res, N = R * R;
  const S = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (gen.water[i] > -9000) S[i] = gen.water[i];

  const RINGS = Math.round(14 / TEXEL);
  let frontier = [];
  for (let i = 0; i < N; i++) if (!Number.isNaN(S[i])) frontier.push(i);
  for (let r = 0; r < RINGS && frontier.length; r++) {
    const next = [];
    for (const k of frontier) {
      const cx = k % R, cz = (k / R) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        const z = cz + dz; if (z < 0 || z >= R) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx; if (x < 0 || x >= R) continue;
          const nk = z * R + x;
          if (!Number.isNaN(S[nk])) continue;
          S[nk] = S[k];
          next.push(nk);
        }
      }
    }
    frontier = next;
  }
  const d = new Float32Array(N).fill(-1e6);
  for (let i = 0; i < N; i++) if (!Number.isNaN(S[i])) d[i] = S[i] - gen.height[i];
  return d;
}

// ── marching squares on the supersampled depth field ─────────────────────────
function contour(d, R, ss) {
  const at = (fx, fz) => {
    const x = Math.min(R - 1.001, Math.max(0, fx)), z = Math.min(R - 1.001, Math.max(0, fz));
    const x0 = x | 0, z0 = z | 0, tx = x - x0, tz = z - z0;
    const a = d[z0 * R + x0], b = d[z0 * R + x0 + 1];
    const c = d[(z0 + 1) * R + x0], e = d[(z0 + 1) * R + x0 + 1];
    if (a < -1e5 || b < -1e5 || c < -1e5 || e < -1e5) return -1e6;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };
  const step = 1 / ss;
  const segs = [];
  const lerpP = (p, q, vp, vq) => {
    const t = vp / (vp - vq);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  for (let z = 0; z < (R - 1) * ss; z++) {
    for (let x = 0; x < (R - 1) * ss; x++) {
      const fx = x * step, fz = z * step;
      const P = [[fx, fz], [fx + step, fz], [fx + step, fz + step], [fx, fz + step]];
      const V = [at(P[0][0], P[0][1]), at(P[1][0], P[1][1]), at(P[2][0], P[2][1]), at(P[3][0], P[3][1])];
      if (V.some((v) => v < -1e5)) continue;
      let code = 0;
      for (let k = 0; k < 4; k++) if (V[k] > 0) code |= 1 << k;
      if (code === 0 || code === 15) continue;
      const E = [];
      for (let k = 0; k < 4; k++) {
        const a = k, b = (k + 1) & 3;
        if ((V[a] > 0) !== (V[b] > 0)) E.push(lerpP(P[a], P[b], V[a], V[b]));
      }
      for (let k = 0; k + 1 < E.length; k += 2) segs.push([E[k], E[k + 1]]);
    }
  }
  return segs;
}

/** Chain marching-squares segments into polylines, welding on a fine grid. */
function chain(segs, weld = 1e-3) {
  const key = (p) => `${Math.round(p[0] / weld)},${Math.round(p[1] / weld)}`;
  const adj = new Map();
  for (const [a, b] of segs) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    if (!adj.has(ka)) adj.set(ka, { p: a, n: [] });
    if (!adj.has(kb)) adj.set(kb, { p: b, n: [] });
    adj.get(ka).n.push(kb);
    adj.get(kb).n.push(ka);
  }
  const seen = new Set();
  const lines = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Walk both ways from an unvisited node.
    const walk = (from) => {
      const out = [];
      let cur = from, prev = null;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        out.push(adj.get(cur).p);
        const nb = adj.get(cur).n.filter((k) => k !== prev && !seen.has(k));
        prev = cur;
        cur = nb[0] ?? null;
      }
      return out;
    };
    const fwd = walk(start);
    if (fwd.length < 2) continue;
    lines.push(fwd);
  }
  return lines;
}

// ── metrics ──────────────────────────────────────────────────────────────────
function boxBlur(src, R, radiusM) {
  const r = Math.max(1, Math.round(radiusM / TEXEL));
  const tmp = new Float32Array(R * R), out = new Float32Array(R * R);
  for (let z = 0; z < R; z++) {
    for (let x = 0; x < R; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(R - 1, Math.max(0, x + k));
        s += src[z * R + xx]; n++;
      }
      tmp[z * R + x] = s / n;
    }
  }
  for (let z = 0; z < R; z++) {
    for (let x = 0; x < R; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const zz = Math.min(R - 1, Math.max(0, z + k));
        s += tmp[zz * R + x]; n++;
      }
      out[z * R + x] = s / n;
    }
  }
  return out;
}

function resample(line, spacingTexels) {
  const out = [line[0]];
  let acc = 0;
  for (let i = 1; i < line.length; i++) {
    const a = out[out.length - 1], b = line[i];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-9) continue;
    while (seg >= spacingTexels - acc) {
      const t = (spacingTexels - acc) / seg;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(p);
      seg -= (spacingTexels - acc);
      acc = 0;
    }
    acc += seg;
  }
  return out;
}

function polyLen(line) {
  let L = 0;
  for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return L;
}

function gaussSmooth(line, sigmaSamples) {
  const r = Math.max(1, Math.round(sigmaSamples * 2.5));
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const out = [];
  for (let i = 0; i < line.length; i++) {
    let sx = 0, sz = 0, sw = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(line.length - 1, Math.max(0, i + k));
      const ww = w[k + r];
      sx += line[j][0] * ww; sz += line[j][1] * ww; sw += ww;
    }
    out.push([sx / sw, sz / sw]);
  }
  return out;
}

function components(mask, R, wanted) {
  const seen = new Uint8Array(R * R);
  const stack = new Int32Array(R * R);
  const sizes = [];
  for (let s = 0; s < R * R; s++) {
    if (seen[s] || mask[s] !== wanted) continue;
    let sp = 0, n = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const k = stack[--sp]; n++;
      const cx = k % R, cz = (k / R) | 0;
      if (cx > 0 && !seen[k - 1] && mask[k - 1] === wanted) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (cx < R - 1 && !seen[k + 1] && mask[k + 1] === wanted) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (cz > 0 && !seen[k - R] && mask[k - R] === wanted) { seen[k - R] = 1; stack[sp++] = k - R; }
      if (cz < R - 1 && !seen[k + R] && mask[k + R] === wanted) { seen[k + R] = 1; stack[sp++] = k + R; }
    }
    sizes.push(n);
  }
  return sizes;
}

function metrics(gen, d) {
  const R = gen.res, N = R * R;
  const wet = new Uint8Array(N);
  for (let i = 0; i < N; i++) wet[i] = d[i] > 0 ? 1 : 0;
  let wetN = 0; for (let i = 0; i < N; i++) wetN += wet[i];
  const area = wetN / N;

  const segs = contour(d, R, SS);
  const lines = chain(segs);
  // Metres per contour sample. 1 m, so curvature is measured at the scale the
  // eye reads a shoreline at rather than at whatever the lattice offers.
  const SPACING = 1.0 / TEXEL;

  // `bedTan` — how bumpy the BANK is as you walk along the waterline, metres RMS.
  //
  // ADDED, not a redefinition of anything. `bedRms` measures the bed's residual
  // against an 8 m box over the shallow band, and a channel narrower than that
  // box is itself most of that residual: measured on talus at res 512, the base
  // bake's 0.526 decomposes as 0.456 outside the river mask and 0.751 inside
  // it, against 0.411 for the raw terrain over the same cells. So the number
  // moves when the CHANNEL changes shape, which is not what any shoreline rule
  // is trying to do, and a pass that takes the terrain residual in the band from
  // 0.53 m to 0.09 m can leave `bedRms` where it found it.
  //
  // What actually scallops a waterline is the BANK going up and down as you walk
  // along the shore: that is the surface the line slides on when the water level
  // wobbles, and it is a purely tangential quantity, so a cross-section — however
  // deep, however steep — must not enter it. Sampled a fixed 3 m out on the dry
  // side of the contour, smoothed along 8 m of arc, RMS of the residual.
  //
  // Sampling ON the contour, which is the obvious thing to do, measures nothing:
  // the bed there IS the water surface by definition, so it returns the
  // smoothness of S — and worse, it is dominated by whatever fraction of the
  // contour is tiny constant-level puddle outlines, which score a perfect zero.
  // Tried, measured, and it ranked a bake with 950 specks per km^2 as smoother
  // than one with 178.
  const bedAt = (fx, fz) => {
    const x = Math.min(R - 1.001, Math.max(0, fx)), z = Math.min(R - 1.001, Math.max(0, fz));
    const x0 = x | 0, z0 = z | 0, tx = x - x0, tz = z - z0;
    const a = gen.height[z0 * R + x0], b = gen.height[z0 * R + x0 + 1];
    const c = gen.height[(z0 + 1) * R + x0], e = gen.height[(z0 + 1) * R + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };
  const depthAt = (fx, fz) => {
    const x = Math.min(R - 1.001, Math.max(0, fx)), z = Math.min(R - 1.001, Math.max(0, fz));
    const x0 = x | 0, z0 = z | 0, tx = x - x0, tz = z - z0;
    const a = d[z0 * R + x0], b = d[z0 * R + x0 + 1];
    const c = d[(z0 + 1) * R + x0], e = d[(z0 + 1) * R + x0 + 1];
    if (a < -1e5 || b < -1e5 || c < -1e5 || e < -1e5) return -1e6;
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  };
  const BANK_OUT = 3.0 / TEXEL;                       // 3 m, in texels
  let tanS = 0, tanN = 0;

  let totLen = 0, smoothLen = 0, fineLen = 0;
  const dirHist = new Float64Array(36);
  const curv = [];
  for (const raw of lines) {
    if (polyLen(raw) * TEXEL < 6) continue;             // ignore crumbs
    const line = resample(raw, SPACING);
    if (line.length < 5) continue;
    const sm = gaussSmooth(line, 4.0 / 1.0);            // sigma 4 m at 1 m spacing
    const L = polyLen(line) * TEXEL;
    totLen += L;
    {
      // Step 3 m along the outward normal — the side the depth field says is dry
      // — and read the bank there. Vertices whose offset lands back in water, as
      // happens across a channel narrower than 6 m, are dropped rather than
      // folded in, because a bank that is not there is not rough.
      const bank = [];
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
        const tx = b[0] - a[0], tz = b[1] - a[1];
        const tl = Math.hypot(tx, tz) || 1;
        let nx = -tz / tl, nz = tx / tl;
        const p = line[i];
        if (depthAt(p[0] + nx, p[1] + nz) > depthAt(p[0] - nx, p[1] - nz)) { nx = -nx; nz = -nz; }
        const qx = p[0] + nx * BANK_OUT, qz = p[1] + nz * BANK_OUT;
        bank.push(depthAt(qx, qz) > 0 ? NaN : bedAt(qx, qz));
      }
      const W = 4;                                   // +/-4 samples = +/-4 m of arc
      for (let i = 0; i < bank.length; i++) {
        if (Number.isNaN(bank[i])) continue;
        let sum = 0, c = 0;
        for (let k = -W; k <= W; k++) {
          const j = i + k; if (j < 0 || j >= bank.length || Number.isNaN(bank[j])) continue;
          sum += bank[j]; c++;
        }
        if (c < 5) continue;
        const e = bank[i] - sum / c;
        tanS += e * e; tanN++;
      }
    }
    smoothLen += polyLen(sm) * TEXEL;
    for (let i = 1; i < line.length; i++) {
      const dx = (line[i][0] - line[i - 1][0]) * TEXEL, dz = (line[i][1] - line[i - 1][1]) * TEXEL;
      const seg = Math.hypot(dx, dz);
      let a = Math.atan2(dz, dx); if (a < 0) a += Math.PI;
      dirHist[Math.min(35, (a / Math.PI * 36) | 0)] += seg;
    }
    // Menger curvature over a 3-sample stencil, i.e. a 2 m chord.
    for (let i = 1; i + 1 < line.length; i++) {
      const a = line[i - 1], b = line[i], c = line[i + 1];
      const ax = (b[0] - a[0]) * TEXEL, az = (b[1] - a[1]) * TEXEL;
      const bx = (c[0] - b[0]) * TEXEL, bz = (c[1] - b[1]) * TEXEL;
      const cross = Math.abs(ax * bz - az * bx);
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      const lc = Math.hypot((c[0] - a[0]) * TEXEL, (c[1] - a[1]) * TEXEL);
      const denom = la * lb * lc;
      const k = denom > 1e-6 ? (2 * cross) / denom : 0;   // 1/radius
      curv.push(k);
      if (k > 1 / 3.0) fineLen += (la + lb) * 0.5;
    }
  }

  // Staircase: the eight lattice directions are 0, 45, 90, 135 degrees, which
  // land in bins 0, 9, 18, 27 of 36. A D8 trace or a cell-aligned polygon edge
  // piles length into those four bins; a natural curve spreads evenly.
  const dirTot = dirHist.reduce((a, b) => a + b, 0) || 1;
  let lattice = 0;
  for (const b of [0, 9, 18, 27]) {
    lattice += dirHist[b] + dirHist[(b + 35) % 36] * 0.5 + dirHist[(b + 1) % 36] * 0.5;
  }
  const stair = Math.max(0, lattice / dirTot - 8 / 36) / (1 - 8 / 36);

  // |grad depth| along the contour, sampled per contour vertex.
  const gradAt = (fx, fz) => {
    const s = (x, z) => {
      const xi = Math.min(R - 1, Math.max(0, Math.round(x))), zi = Math.min(R - 1, Math.max(0, Math.round(z)));
      return d[zi * R + xi];
    };
    const gx = (s(fx + 1, fz) - s(fx - 1, fz)) / (2 * TEXEL);
    const gz = (s(fx, fz + 1) - s(fx, fz - 1)) / (2 * TEXEL);
    return Math.hypot(gx, gz);
  };
  const grads = [];
  for (const raw of lines) {
    if (polyLen(raw) * TEXEL < 6) continue;
    for (let i = 0; i < raw.length; i += 3) grads.push(gradAt(raw[i][0], raw[i][1]));
  }
  grads.sort((a, b) => a - b);
  const grad10 = grads.length ? grads[Math.floor(grads.length * 0.10)] : 0;

  // Bed roughness in the shallow band.
  const blur = boxBlur(gen.height, R, 8);
  let rs = 0, rn = 0, step = 0;
  for (let i = 0; i < N; i++) {
    if (d[i] < -1e5) continue;
    if (Math.abs(d[i]) > 1.0) continue;
    const e = gen.height[i] - blur[i];
    rs += e * e; rn++;
  }
  for (let z = 1; z < R - 1; z++) {
    for (let x = 1; x < R - 1; x++) {
      const i = z * R + x;
      if (!wet[i]) continue;
      const s = Math.max(Math.abs(gen.height[i] - gen.height[i - 1]), Math.abs(gen.height[i] - gen.height[i - R]));
      if (s > step) step = s;
    }
  }
  const bedRms = rn ? Math.sqrt(rs / rn) : 0;

  // Speckle, in bodies per km^2 of patch.
  const cellArea = TEXEL * TEXEL;
  const MIN = 40 / cellArea;
  const bodies = components(wet, R, 1).filter((n) => n < MIN).length;
  const holes = components(wet, R, 0).filter((n) => n < MIN).length;
  const km2 = (WORLD * WORLD) / 1e6;

  // Does the channel the bake TRACED actually hold water? A reach whose mask is
  // painted but whose surface never rises above its own bed draws as two lines
  // of shoreline with dry ground between them — a defect no shape metric can
  // see, because the shape it measures is of the right curve around the wrong
  // thing. `chanWet` is the fraction of confidently-channel texels that are
  // wet; `depth50` is the median depth over the whole wet mask, which catches
  // the other half of it — water that is technically there and a centimetre
  // deep, so every shoreline band in the shader runs across all of it.
  let chanN = 0, chanW = 0;
  for (let i = 0; i < N; i++) {
    if ((gen.riverMask?.[i] ?? 0) < 0.20) continue;
    chanN++; if (wet[i]) chanW++;
  }
  const depths = [];
  for (let i = 0; i < N; i++) if (wet[i]) depths.push(d[i]);
  depths.sort((a, b) => a - b);

  return {
    area: +(area * 100).toFixed(2),
    chanWet: chanN ? +(chanW / chanN * 100).toFixed(1) : 0,
    depth50: depths.length ? +depths[depths.length >> 1].toFixed(2) : 0,
    lenM: Math.round(totLen),
    crenel: smoothLen > 0 ? +(totLen / smoothLen).toFixed(3) : 0,
    fine: totLen > 0 ? +(fineLen * TEXEL / totLen * 100).toFixed(1) : 0,
    stair: +(stair * 100).toFixed(1),
    speck: +((bodies + holes) / km2).toFixed(1),
    grad10: +grad10.toFixed(4),
    bedRms: +bedRms.toFixed(3),
    bedTan: tanN ? +Math.sqrt(tanS / tanN).toFixed(3) : 0,
    bedStep: +step.toFixed(2),
  };
}

// ── render ───────────────────────────────────────────────────────────────────
function render(gen, d, name, m, scale = SCALE) {
  const R = gen.res;
  const W = R * scale;
  const base = canvas(R, R, [18, 18, 22]);
  const blur = boxBlur(gen.height, R, 4);
  for (let z = 0; z < R; z++) {
    for (let x = 0; x < R; x++) {
      const i = z * R + x;
      const xm = z * R + Math.max(0, x - 1), xp = z * R + Math.min(R - 1, x + 1);
      const zm = Math.max(0, z - 1) * R + x, zp = Math.min(R - 1, z + 1) * R + x;
      const gx = (gen.height[xp] - gen.height[xm]) / (2 * TEXEL);
      const gz = (gen.height[zp] - gen.height[zm]) / (2 * TEXEL);
      const len = Math.hypot(gx, 1, gz);
      let l = Math.max(0, (-gx * -0.55 + (1 / len) * 0.62 + -gz * 0.56) / len);
      l = 0.28 + 0.72 * Math.pow(Math.min(1, l), 0.8);
      // A relief residual on top, so texel-scale bed roughness is VISIBLE in the
      // sheet and not only in the table.
      const resid = Math.max(-1, Math.min(1, (gen.height[i] - blur[i]) * 0.9));
      let r = 176, g = 150, b = 92;
      r += resid * 26; g += resid * 22; b += resid * 12;
      const dep = d[i];
      if (dep > 0) {
        const t = Math.min(1, dep / 3.0);
        r = 40 + (1 - t) * 70; g = 92 + (1 - t) * 60; b = 150 + (1 - t) * 50;
        l = 0.55 + l * 0.45;
      } else if (dep > -1e5 && dep > -0.6) {
        r = 120; g = 104; b = 84;   // the damp band, so its width is readable
      }
      base.put(x, z, Math.min(255, r * l), Math.min(255, g * l), Math.min(255, b * l));
    }
  }
  // Nearest-neighbour up, so one texel is `scale` pixels and the waterline can
  // be drawn as a HAIRLINE over it. At 1:1 a 3 m channel is two pixels wide and
  // its own shoreline covers it, which is how a sheet can show a dry channel
  // and a full one as the same picture.
  const img = canvas(W, W, [18, 18, 22]);
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const s = (((z / scale) | 0) * R + ((x / scale) | 0)) * 3;
      img.put(x, z, base.px[s], base.px[s + 1], base.px[s + 2]);
    }
  }
  // The waterline itself, drawn from the same contour the metrics used.
  for (const [a, b] of contour(d, R, SS)) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * scale * 1.6));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      img.put(Math.round((a[0] + (b[0] - a[0]) * t) * scale),
              Math.round((a[1] + (b[1] - a[1]) * t) * scale), 255, 255, 255);
    }
  }
  for (let y = 0; y < 46; y++) for (let x = 0; x < 320; x++) {
    const k = (y * W + x) * 3;
    img.px[k] = img.px[k] * 0.25; img.px[k + 1] = img.px[k + 1] * 0.25; img.px[k + 2] = img.px[k + 2] * 0.25;
  }
  text(img, 5, 4, name, [255, 255, 255], 2);
  text(img, 5, 21, `crenel ${m.crenel} fine ${m.fine}% stair ${m.stair}% speck ${m.speck}`, [235, 232, 170], 1);
  text(img, 5, 30, `grad10 ${m.grad10} bedrms ${m.bedRms} step ${m.bedStep}`, [235, 232, 170], 1);
  text(img, 5, 39, `area ${m.area}% chanwet ${m.chanWet}% d50 ${m.depth50}m`, [200, 205, 215], 1);
  return img;
}

// ── compare mode ─────────────────────────────────────────────────────────────
if (has('compare')) {
  const i = argv.indexOf('--compare');
  const [A, B] = [argv[i + 1], argv[i + 2]];
  const load = (t) => JSON.parse(readFileSync(`shots/waterlab/${t}/metrics.json`, 'utf8'));
  const a = load(A), b = load(B);
  const KEYS = ['crenel', 'fine', 'stair', 'speck', 'grad10', 'bedRms', 'bedTan', 'bedStep', 'area', 'chanWet', 'depth50'];
  // Lower is better for all but grad10 and area, which want to be preserved.
  const BETTER_LOW = new Set(['crenel', 'fine', 'stair', 'speck', 'bedRms', 'bedTan', 'bedStep']);
  console.log(`\n${A}  ->  ${B}\n`);
  const pad = (s, n) => String(s).padStart(n);
  console.log(`${'case'.padEnd(9)}${KEYS.map((k) => pad(k, 10)).join('')}`);
  const totals = {};
  for (const name of Object.keys(a)) {
    if (!b[name]) continue;
    const cells = KEYS.map((k) => {
      const av = a[name][k], bv = b[name][k];
      if (av === undefined || bv === undefined) return pad('-', 10);
      const delta = bv - av;
      if (BETTER_LOW.has(k)) totals[k] = (totals[k] ?? 0) + (av > 0 ? (av - bv) / av : 0);
      const sign = delta > 0 ? '+' : '';
      return pad(`${bv}(${sign}${+delta.toFixed(3)})`, 10);
    });
    console.log(`${name.padEnd(9)}${cells.join('')}`);
  }
  console.log('');
  for (const k of KEYS) {
    if (totals[k] === undefined) continue;
    const pct = (totals[k] / Object.keys(a).length) * 100;
    console.log(`  ${k.padEnd(8)} mean improvement ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
  }
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────
const names = ONLY ? [ONLY] : Object.keys(CASES);
mkdirSync(OUTDIR, { recursive: true });
const all = {};
const tiles = [];
let failed = 0;

for (const name of names) {
  if (!CASES[name]) { console.error(`unknown case: ${name}`); process.exit(2); }
  const { gen, ms } = bake(name);
  const d = depthField(gen);
  const m = metrics(gen, d);
  m.bakeMs = ms;
  all[name] = m;
  // A case that made no water measures nothing, and a table of zeros reads as a
  // pass. Say so, loudly, and fail the run.
  if (m.area < 0.15) {
    console.error(`  !! ${name}: only ${m.area}% of the patch is water — this case is not testing anything`);
    failed++;
  }
  const img = render(gen, d, name, m);
  writePNG(`${OUTDIR}/${name}.png`, img);
  tiles.push({ name, img });
  console.log(`${name.padEnd(9)} crenel ${String(m.crenel).padStart(6)}  fine ${String(m.fine).padStart(5)}%  `
            + `stair ${String(m.stair).padStart(5)}%  speck ${String(m.speck).padStart(5)}  `
            + `grad10 ${String(m.grad10).padStart(7)}  bedRms ${String(m.bedRms).padStart(6)}  `
            + `bedTan ${String(m.bedTan).padStart(6)}  `
            + `bedStep ${String(m.bedStep).padStart(5)}  area ${String(m.area).padStart(5)}%  `
            + `chanWet ${String(m.chanWet).padStart(5)}%  d50 ${String(m.depth50).padStart(5)}m  ${ms}ms`);
}

// Contact sheet.
if (tiles.length > 1) {
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const TS = tiles[0].img.w;
  const sheet = canvas(cols * TS, rows * TS, [12, 12, 15]);
  tiles.forEach((t, i) => sheet.blit(t.img, (i % cols) * TS, ((i / cols) | 0) * TS));
  writePNG(`${OUTDIR}/sheet.png`, sheet);
  console.log(`\nsheet: ${OUTDIR}/sheet.png`);
}

writeFileSync(`${OUTDIR}/metrics.json`, JSON.stringify(all, null, 2));
console.log(`metrics: ${OUTDIR}/metrics.json`);
if (failed) process.exit(3);

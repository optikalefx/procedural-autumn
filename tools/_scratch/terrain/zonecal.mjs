// Replicate the shader's vnoise/fbm/fbmTP exactly and measure the distribution
// of the fields that feed valueZones(), on GENTLE ground and on a WALL.
//
// d451616 established the discipline this exists to follow: quantising a field
// without first measuring its spread does nothing, because "every broad tonal
// term in this file was written as if it spanned 0..1" and the macro field
// actually runs p5 0.410 to p95 0.590. valueZones' smoothstep(0.40, 0.60, f)
// knee is calibrated to exactly that. Any field substituted into it has to be
// scaled to the same spread or the zones depopulate again.
//
//   node tools/_scratch/terrain/zonecal.mjs
const fract = (x) => x - Math.floor(x);
function hash22(px, py) {
  const x = px * 127.1 + py * 311.7, y = px * 269.5 + py * 183.3;
  return [fract(Math.sin(x) * 43758.5453123) * 2 - 1, fract(Math.sin(y) * 43758.5453123) * 2 - 1];
}
function vnoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const d = (gx, gy) => { const h = hash22(ix + gx, iy + gy); return h[0] * (fx - gx) + h[1] * (fy - gy); };
  const a = d(0, 0), b = d(1, 0), c = d(0, 1), e = d(1, 1);
  const ab = a + (b - a) * ux, ce = c + (e - c) * ux;
  return ab + (ce - ab) * uy;
}
function fbm(px, py, oct) {
  let a = 0.5, s = 0, n = 0, x = px, y = py;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y); n += a; a *= 0.5; x *= 2.07; y *= 2.07; }
  return s / n;
}
// tpWeights + fbmTP, verbatim.
function tpWeights(nx, ny, nz) {
  let w = [Math.max(Math.abs(nx) - 0.20, 0), Math.max(Math.abs(ny) - 0.20, 0), Math.max(Math.abs(nz) - 0.20, 0)];
  w = w.map((v) => v * v); w = w.map((v) => v * v);
  const s = Math.max(w[0] + w[1] + w[2], 1e-4);
  return w.map((v) => v / s);
}
function fbmTP(px, py, pz, oct, w) {
  let s = 0;
  if (w[1] > 0.006) s += w[1] * fbm(px, pz, oct);
  if (w[0] > 0.006) s += w[0] * fbm(pz + 61.7, py + 61.7, oct);
  if (w[2] > 0.006) s += w[2] * fbm(px - 24.3, py - 24.3, oct);
  return s;
}
const q = (a, p) => a[Math.floor(p * (a.length - 1))];
const rep = (name, v) => {
  v.sort((a, b) => a - b);
  console.log(`${name.padEnd(30)} p05 ${q(v, 0.05).toFixed(3)}  p50 ${q(v, 0.50).toFixed(3)}`
    + `  p95 ${q(v, 0.95).toFixed(3)}  spread ${(q(v, 0.95) - q(v, 0.05)).toFixed(3)}`);
};

// The proposed zone field: the SAME 240 m octave, sampled triplanar and
// renormalised for the blend. Variance of a weighted sum of decorrelated
// fields of equal variance goes as sum(w^2), so dividing the centred field by
// sqrt(sum(w^2)) makes the spread independent of the surface orientation —
// which is the whole point, since valueZones' 0.40..0.60 knee is calibrated
// to one particular spread. On any surface within ~11.5 degrees of horizontal
// the weights are (0,1,0) exactly, sum(w^2) is 1, and this IS macro to the
// last bit — so nothing that d451616 landed on gentle ground moves.
function macroS(x, y, z, w) {
  const n = 1 / Math.sqrt(Math.max(w[0] * w[0] + w[1] * w[1] + w[2] * w[2], 1e-4));
  return Math.min(1, Math.max(0,
    0.5 + fbmTP(x * 0.0042, y * 0.0042, z * 0.0042, 4, w) * 0.5 * n));
}

// valueZones, verbatim.
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function valueZones(f, n) {
  const qv = smoothstep(0.40, 0.60, f) * n;
  return (Math.floor(qv) + smoothstep(0.30, 0.70, fract(qv))) / n;
}

const N = 60000;
// Three surfaces. GENTLE is the ground peaks and hero look down on; WALL is the
// waterfall massif and every cliff in an eye-level frame; DIAGONAL is the
// worst case for the triplanar blend, where two decorrelated planar samples are
// averaged and the result is narrower than either.
const SURFACES = [
  ['gentle  (N = +y)', [0, 1, 0]],
  ['wall    (N = +x)', [1, 0, 0]],
  ['diagonal(45 deg) ', [0.707, 0.707, 0]],
];

// A face's worth of ground, not the whole world: the question is how much a
// field varies ACROSS ONE MASSIF FACE, which is what decides whether that face
// gets one zone or three. 300 m is about the visible face in `waterfall`.
const FACE = Number(process.argv[2] || 300);
console.log(`per-FACE spread, ${FACE} m of surface, ${N} samples\n`);

for (const [label, nrm] of SURFACES) {
  const w = tpWeights(nrm[0], nrm[1], nrm[2]);
  const mac = [], mac2 = [], mS = [], zGeo = [], zNew = [];
  // Face-local sampling: pick a face centre, then walk over the face. On a WALL
  // the face extends in y and one horizontal axis; on GENTLE it extends in xz.
  for (let i = 0; i < N; i++) {
    const cx = (Math.random() - 0.5) * 6000, cz = (Math.random() - 0.5) * 6000, cy = 60 + Math.random() * 400;
    // two orthogonal in-plane directions
    const up = Math.abs(nrm[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const t1 = [nrm[1] * up[2] - nrm[2] * up[1], nrm[2] * up[0] - nrm[0] * up[2], nrm[0] * up[1] - nrm[1] * up[0]];
    const t2 = [nrm[1] * t1[2] - nrm[2] * t1[1], nrm[2] * t1[0] - nrm[0] * t1[2], nrm[0] * t1[1] - nrm[1] * t1[0]];
    const a = (Math.random() - 0.5) * FACE, b = (Math.random() - 0.5) * FACE;
    const x = cx + t1[0] * a + t2[0] * b, y = cy + t1[1] * a + t2[1] * b, z = cz + t1[2] * a + t2[2] * b;
    const m = fbm(x * 0.0042, z * 0.0042, 4) * 0.5 + 0.5;
    const m2 = fbmTP(x * 0.0155 + 31.4, y * 0.0155 + 31.4, z * 0.0155 + 31.4, 3, w) * 0.5 + 0.5;
    mac.push(m); mac2.push(m2); mS.push(macroS(x, y, z, w));
    zGeo.push(valueZones(m, 3));
    zNew.push(valueZones(macroS(x, y, z, w), 3));
  }
  console.log(label);
  rep('  macro (planar xz, 240 m)', mac);
  rep('  macro2 (triplanar, 65 m)', mac2);
  rep('  macroS (triplanar 240 m, norm)', mS);
  rep('  valueZones(macro,3) TODAY', zGeo);
  rep('  valueZones(macroS,3) PROPOSED', zNew);
  // How many distinct zones a single face actually shows. A face is one patch
  // of ground, not the whole world: the world-wide spread of a field says
  // nothing about whether ONE massif gets three values or one.
  const zoneCount = (vals) => {
    const bins = new Set(vals.map((v) => Math.round(v * 3)));
    return bins.size;
  };
  const one = (fn) => {
    let tot = 0;
    for (let f = 0; f < 300; f++) {
      const cx = (Math.random() - 0.5) * 6000, cz = (Math.random() - 0.5) * 6000, cy = 60 + Math.random() * 400;
      const up = Math.abs(nrm[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
      const t1 = [nrm[1] * up[2] - nrm[2] * up[1], nrm[2] * up[0] - nrm[0] * up[2], nrm[0] * up[1] - nrm[1] * up[0]];
      const t2 = [nrm[1] * t1[2] - nrm[2] * t1[1], nrm[2] * t1[0] - nrm[0] * t1[2], nrm[0] * t1[1] - nrm[1] * t1[0]];
      const vs = [];
      for (let k = 0; k < 240; k++) {
        const a = (Math.random() - 0.5) * FACE, b = (Math.random() - 0.5) * FACE;
        const x = cx + t1[0] * a + t2[0] * b, y = cy + t1[1] * a + t2[1] * b, z = cz + t1[2] * a + t2[2] * b;
        vs.push(fn(x, y, z));
      }
      tot += zoneCount(vs);
    }
    return (tot / 300).toFixed(2);
  };
  console.log(`  distinct zones on ONE ${FACE} m face:  today ${one((x, y, z) => valueZones(fbm(x * 0.0042, z * 0.0042, 4) * 0.5 + 0.5, 3))}`
    + `   proposed ${one((x, y, z) => valueZones(macroS(x, y, z, w), 3))}`);
  console.log('');
}

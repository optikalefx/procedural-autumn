#!/usr/bin/env node
/**
 * A waterline that is PROVABLY PERFECT, in wedge.mjs's own input format.
 *
 * wedge's `fine` is "% of contour whose Menger curvature radius, on a 1 px
 * resampling, is under 3 px". On a straight run of 1 px samples that fires at a
 * lateral deviation of 1/6 px. The shipped frames wobble 0.20-0.30 px RMS off
 * their own smoothed curve at EVERY range from 20 m to 1500 m — which is the
 * signature of something in the extraction, not of anything in the world.
 *
 * So: synthesise the pair wedge eats — <name>.png and <name>-nowater.png —
 * where the water's coverage is computed ANALYTICALLY from a shape whose
 * curvature is known everywhere and is nowhere under 100 px. Same colours,
 * same 8-bit quantisation, same edge widths as the real captures. If wedge
 * reports several percent `fine` on THAT, the number is the tool.
 *
 *   node tools/_scratch/finefixture.mjs --dir shots/finefix --aa 3.0
 */
import { writePNG, canvas } from '../_png.mjs';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/finefix');
const W = 1600, H = 900;
const BANK = [205, 152, 62];    // gold, the real frames' bank
const WATER = [70, 96, 158];    // the real frames' open water

// Signed distance, in px, positive inside the water, for four shapes whose
// curvature is analytic. NOTHING here has a radius under 150 px, so a correct
// instrument must report fine = 0 on all of them.
const shapes = {
  // a straight shore at 7 degrees — backwater's case
  straight: (x, y) => (y - (430 + (x - 800) * Math.tan(7 * Math.PI / 180))),
  // a lake: radius 300 px, curvature radius 300 everywhere
  disc: (x, y) => 300 - Math.hypot(x - 800, y - 450),
  // a meander: a sine of amplitude 60 px and wavelength 700 px. Minimum radius
  // of curvature is (lambda/2pi)^2 / A = (111.4)^2 / 60 = 207 px.
  meander: (x, y) => (y - (450 + 60 * Math.sin((x - 800) * 2 * Math.PI / 700))),
};

// A band-limited lateral wobble of a stated RMS in PIXELS, so the fixture can
// be given exactly the deviation the shipped frames have and the resulting
// `fine` read off. Smoothed white noise, normalised, so its content sits in
// the 2-16 px band that a sigma-4 highpass keeps — which is the band `fine`
// scores.
function wobbleFn(rms, seed) {
  const M = 4096;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  let a = new Float64Array(M); for (let i = 0; i < M; i++) a[i] = rnd();
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float64Array(M);
    for (let i = 0; i < M; i++) b[i] = (a[(i - 1 + M) % M] + a[i] + a[(i + 1) % M]) / 3;
    a = b;
  }
  let m = 0; for (let i = 0; i < M; i++) m += a[i] * a[i];
  const k = rms / Math.sqrt(m / M);
  for (let i = 0; i < M; i++) a[i] *= k;
  return (t) => { const i = ((Math.round(t) % M) + M) % M; return a[i]; };
}

function emit(name, sdf, aa, wob) {
  const nw = canvas(W, H, BANK);
  const wf = canvas(W, H, BANK);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      nw.put(x, y, BANK[0], BANK[1], BANK[2]);
      // Coverage of a pixel by a half-plane at signed distance d, to the same
      // accuracy a good AA resolve gives: a linear ramp over `aa` px centred on
      // the boundary. Sampled at the pixel CENTRE, which is what the renderer
      // writes and what wedge then reads back.
      const d = sdf(x + 0.5, y + 0.5) + (wob ? wob(x + 0.5) : 0);
      const a = Math.min(1, Math.max(0, 0.5 + d / aa));
      wf.put(x, y,
        Math.round(BANK[0] + (WATER[0] - BANK[0]) * a),
        Math.round(BANK[1] + (WATER[1] - BANK[1]) * a),
        Math.round(BANK[2] + (WATER[2] - BANK[2]) * a));
    }
  }
  mkdirSync(DIR, { recursive: true });
  writePNG(`${DIR}/${name}.png`, wf);
  writePNG(`${DIR}/${name}-nowater.png`, nw);
  console.log(`${DIR}/${name}.png   (aa ${aa} px, min curvature radius >= 200 px${wob ? ', wobbled' : ''})`);
}

const WOB = arg('wobble', null);
for (const aa of (arg('aa', '2,3,5')).split(',').map(Number)) {
  for (const [k, f] of Object.entries(shapes)) {
    if (WOB) for (const r of WOB.split(',').map(Number))
      emit(`${k}-aa${aa}-w${String(r).replace('.', '')}`, f, aa, wobbleFn(r, 12345));
    else emit(`${k}-aa${aa}`, f, aa, null);
  }
}

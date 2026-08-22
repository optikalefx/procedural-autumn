#!/usr/bin/env node
/**
 * Does the waterline hold still?
 *
 *   node tools/shot.mjs --views mouth,river --dir shots/x \
 *        --hide Trees,Grass,GroundCover,Weather,Clouds --waterdiff --frames 5
 *   node tools/wcrawl.mjs shots/x/mouth.png shots/x/river.png
 *
 * **Hide Clouds.** The coverage estimate is a colour difference against the
 * water-hidden frame, and water reflects the sky — so a cloud drifting across
 * a lake changes the difference over the whole body without the waterline
 * moving a pixel. Measured on `hero`, which looks down a valley full of
 * distant water: `drift` came back at 31 038 px with the clouds in, against
 * −493 on `mouth` where almost no sky is reflected. That is not crawl and this
 * tool cannot tell the two apart from the pixels alone.
 *
 * ── the defect this exists to catch ──────────────────────────────────────────
 *
 * "Not jagged" and "flowing smoothly" are two requirements and only one of them
 * is visible in a still frame. A waterline can be clean in the capture a round
 * is judged on and crawl in every frame either side of it — and crawl is worse
 * than a visible stair-step, because the eye is far more sensitive to a moving
 * edge than to a static one. Every round of this project so far has judged
 * water from single frames.
 *
 * The waterline is decided by geometry: where a water surface crosses a bed.
 * Neither moves. The vertex swell is two centimetres and is faded to nothing at
 * the bank on purpose. So with the camera static and nothing in frame but
 * water, **a waterline that moves between frames is moving because the way it
 * is computed is unstable at the pixel** — an alpha ramp narrower than a pixel,
 * a depth sampled from an unmipped texture, a threshold on a term that a ripple
 * is modulating. All three are real and all three are invisible in a still.
 *
 * ── how it is measured ───────────────────────────────────────────────────────
 *
 * `shot.mjs --waterdiff --frames N` writes one water-hidden frame and N frames
 * of the same pose over about a second and a half. The water-hidden frame does
 * not change, so the water's own contribution in frame t is `|frame_t − nowater|`
 * — a true coverage field, at exactly the alpha it was composited with.
 *
 *   band     the waterline band: pixels whose coverage is partial (0.15..0.85)
 *            in at least one frame. This is the edge, found without a threshold.
 *   crawl    RMS change in `cov` per frame within that band, as a percentage.
 *            NOT a pure instability measure — this header claimed it was
 *            "close to" one on the argument that foam moves colour and not
 *            coverage, and `cov` IS colour. See the section below.
 *   flip     % of band pixels whose `cov` crosses 0.5 at least once across the
 *            sequence. Read as "blinking between water and land" for three
 *            rounds; it is not that either, for the same reason. See below.
 *   drift    mean signed change in total coverage from first frame to last, in
 *            pixels. Separates a genuine slow movement (a level settling, a
 *            swell) from noise: crawl high and drift near zero is aliasing;
 *            both high means the surface is actually still moving and the
 *            capture settled too early.
 *   ripple   RMS coverage change OUTSIDE the band, over pixels that are fully
 *            wet in every frame. This was written as a determinism control and
 *            it is not one — measured on the baseline it reads 1.18-1.37%,
 *            because a fully covered pixel's COLOUR changes as the ripple field
 *            advects under it, and the coverage estimate is a colour difference.
 *            So it is the animation floor, and it is reported because `crawl`
 *            has to be read against it rather than against zero.
 *   ratio    crawl / ripple. Read it as an UPPER BOUND on instability, not as a
 *            measurement of it — see the limitation below.
 *
 * ── what this tool cannot separate, and what to trust instead ────────────────
 *
 * The coverage estimate is a colour difference, and the water's foam and lace
 * animate hardest exactly where the waterline is. So `crawl` and `ratio` mix
 * two things: an alpha edge that is genuinely unstable at the pixel, and a foam
 * field that is doing what it is supposed to do. A perfect waterline with
 * animated foam on it still scores a ratio above 1. Hiding the clouds removes
 * one confound (a cloud crossing a lake changes its reflected colour over the
 * whole body) but not this one.
 *
 * **`flip` DOES NOT SEPARATE THEM EITHER, and this header said for three rounds
 * that it did.** The claim it made was: a flip is a pixel going from
 * mostly-water to mostly-land and back, "which foam cannot do — foam modulates
 * the colour of a pixel that is fully covered, it does not uncover it". That is
 * a statement about ALPHA, and this tool never sees alpha. What every column
 * here is computed from is
 *
 *       cov = |frame_t - nowater_t| / FULL
 *
 * which is a COLOUR difference normalised by the 90th percentile of itself.
 * Foam changes colour. A fully covered pixel whose water turns from blue to
 * white moves `cov` by most of its range without one photon of ground
 * appearing, and if it crosses 0.5 on the way it is counted as a flip. So what
 * `flip` counts is "band pixels whose colour difference from the dry plate
 * crossed half of this frame's strong-water level", and a travelling foam mark
 * does that on every pixel it passes over.
 *
 * MEASURED, with a synthetic fixture written in this tool's own input format —
 * six frames plus a per-frame `-nowater` twin, so it goes through `analyse`
 * unmodified and nothing is modelled:
 *
 *   case      what moves                                              flip%
 *   still     nothing: fixed alpha edge, no foam                        0.0
 *   wobble    alpha edge jogged +/-0.6 px per frame, NO foam            3.4
 *   colour    alpha BIT-IDENTICAL between frames, foam travels        16.7
 *
 * A provably immobile edge scores five times what a real sub-pixel wobble of
 * that same edge scores, purely from foam. The sign of the error is the
 * dangerous one: it makes correct water look unstable, so a round chasing it
 * removes animation that was supposed to be there.
 *
 * ── what to trust instead: measure the alpha ────────────────────────────────
 *
 * Alpha is available, it just is not in the frame. Patch the surface fragment
 * shader to write its final alpha into the colour channels and composite over
 * black, capture the same sequence, and run this tool on THAT — every column
 * then means what this header used to claim it meant, because coverage is now
 * literally coverage. On the real shader, clouds hidden, engine clock running:
 *
 *   framing   flip% on true alpha    flip% for a real +/-0.6 px wobble of it
 *   hero              0.00                          26
 *   mouth             0.02                          21
 *   river             0.11                          16
 *   plunge            0.00                          19
 *
 * The waterline's alpha is stable to between 150x and 2000x below a sub-pixel
 * wobble of itself. Essentially all of the flip this tool reports at these
 * framings is foam, and `river`'s 6.3% was never a defect: `hero`'s crawl item
 * was closed on exactly this evidence.
 *
 * Baseline for the colour-difference columns, per-frame paired, clouds and
 * falls hidden: `mouth` flip 1.0%, `river` flip 6.3%, `hero` flip 2.4%. Read
 * those as an UPPER BOUND on instability that is mostly foam, the same way
 * `ratio` is read, and NOT against a 1.5% gate — there is no gate on this
 * column any more, because nobody has calibrated one against a frame whose
 * foam is known. Earlier figures of 3.0 and 2.3 were taken before the
 * per-frame pairing below and were inflated 2-3x on top of all of the above.
 *
 * ── the instrument-failure record for this file ─────────────────────────────
 *
 * Kept here because every one of these produced a clean number a reasonable
 * person acted on, and two of them redirected a round.
 *
 *   what it reported                     what was actually true
 *   ---------------------------------    ------------------------------------
 *   hero drifting 31 038 px of water     clouds were in the capture and water
 *                                        reflects sky; the waterline had not
 *                                        moved a pixel. Hide Clouds.
 *   crawl 3.0 / 2.3 at mouth / hero      frame 0's dry twin was reused across
 *                                        a moving sequence, so everything that
 *                                        changed between the frozen and the
 *                                        running state read as coverage. 2-3x.
 *   ripple as a determinism control      it reads 1.18-1.37% on a still
 *                                        baseline, because a fully covered
 *                                        pixel's colour advects. It is the
 *                                        animation floor, not zero.
 *   flip counts coverage crossings,      it counts COLOUR crossings. Foam
 *   "which foam cannot do"               scores 16.7% on a bit-identical
 *                                        alpha edge; the true alpha of the
 *                                        shipped shader scores 0.00-0.11%.
 *
 *   drift    signed change in total coverage from first frame to last, in
 *            pixels. A large drift means the capture had not settled and every
 *            other column is measuring a transient. Read it first.
 */
import { readPNG } from './_pngread.mjs';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node tools/wcrawl.mjs <frame.png> [more.png ...]');
  console.error('       frames must have been captured with --waterdiff --frames N');
  process.exit(2);
}

function analyse(path) {
  const nwPath = path.replace(/\.png$/, '-nowater.png');
  if (!existsSync(nwPath)) return { file: path, err: 'no -nowater.png beside it' };
  const nw = readPNG(nwPath);
  const seq = [path];
  for (let f = 1; f <= 32; f++) {
    const p = path.replace(/\.png$/, `-t${f}.png`);
    if (!existsSync(p)) break;
    seq.push(p);
  }
  if (seq.length < 3) return { file: path, err: `only ${seq.length} frame(s); re-capture with --frames 5` };

  const W = nw.w, H = nw.h, N = W * H;
  // Coverage per frame. The same difference tools/wedge.mjs uses, so the two
  // instruments are talking about the same edge.
  const cov = [];
  for (const p of seq) {
    const im = readPNG(p);
    if (im.w !== W || im.h !== H) return { file: path, err: `${p} size differs` };
    // Each frame's OWN water-hidden twin where one exists. Reusing frame 0's
    // twin across a moving sequence inflates every number here by 1.6-2.1x,
    // because anything that changed between the frozen and running states reads
    // as a coverage change over the whole body rather than as water moving.
    const twin = p.replace(/\.png$/, '-nowater.png');
    const ref = existsSync(twin) && twin !== nwPath ? readPNG(twin) : nw;
    const c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = Math.abs(im.px[i * 3] - ref.px[i * 3])
              + Math.abs(im.px[i * 3 + 1] - ref.px[i * 3 + 1])
              + Math.abs(im.px[i * 3 + 2] - ref.px[i * 3 + 2]);
      // Normalised against the frame's own strong-water level rather than
      // against full scale: how different water is from the ground behind it
      // depends on what that ground is, and a fixed divisor would call a
      // shoreline over pale sand "partial coverage" everywhere.
      c[i] = d / 765;
    }
    cov.push(c);
  }
  // The strong-water level: the 90th percentile of the difference, over pixels
  // the water touched at all. Used as the scale that maps difference to
  // coverage, so `partial` means partial and not merely dim.
  const touched = [];
  for (let i = 0; i < N; i++) if (cov[0][i] > 0.02) touched.push(cov[0][i]);
  touched.sort((a, b) => a - b);
  const FULL = touched.length ? touched[Math.floor(touched.length * 0.90)] : 1;
  for (const c of cov) for (let i = 0; i < N; i++) c[i] = Math.min(1, c[i] / Math.max(FULL, 1e-4));

  const band = new Uint8Array(N), inner = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let partial = 0, full = 0;
    for (const c of cov) {
      if (c[i] > 0.15 && c[i] < 0.85) partial = 1;
      if (c[i] >= 0.85) full++;
    }
    if (partial) band[i] = 1;
    else if (full === cov.length) inner[i] = 1;
  }

  let bandN = 0, crawlS = 0, crawlN = 0, flips = 0;
  let innerN = 0, innerS = 0;
  for (let i = 0; i < N; i++) {
    if (band[i]) {
      bandN++;
      let below = false, above = false;
      for (let f = 0; f < cov.length; f++) {
        if (cov[f][i] < 0.5) below = true; else above = true;
        if (f > 0) { const d = cov[f][i] - cov[f - 1][i]; crawlS += d * d; crawlN++; }
      }
      if (below && above) flips++;
    } else if (inner[i]) {
      innerN++;
      for (let f = 1; f < cov.length; f++) { const d = cov[f][i] - cov[f - 1][i]; innerS += d * d; }
    }
  }
  let sum0 = 0, sumL = 0;
  for (let i = 0; i < N; i++) { sum0 += cov[0][i]; sumL += cov[cov.length - 1][i]; }

  return {
    file: path,
    frames: seq.length,
    bandPx: bandN,
    crawl: crawlN ? +(Math.sqrt(crawlS / crawlN) * 100).toFixed(2) : 0,
    flip: bandN ? +(flips / bandN * 100).toFixed(1) : 0,
    drift: +(sumL - sum0).toFixed(0),
    ripple: innerN ? +(Math.sqrt(innerS / (innerN * (cov.length - 1))) * 100).toFixed(2) : 0,
  };
}

const pad = (s, n) => String(s).padStart(n);
console.log(`${'frame'.padEnd(32)}${['frames', 'bandPx', 'crawl%', 'flip%', 'ratio', 'ripple%', 'drift'].map((k) => pad(k, 10)).join('')}`);
for (const f of files) {
  const m = analyse(f);
  if (m.err) { console.log(`${f.slice(-32).padEnd(32)}  -- ${m.err}`); continue; }
  const ratio = m.ripple > 0 ? +(m.crawl / m.ripple).toFixed(2) : 0;
  console.log(`${m.file.slice(-32).padEnd(32)}${pad(m.frames, 10)}${pad(m.bandPx, 10)}${pad(m.crawl, 10)}`
            + `${pad(m.flip, 10)}${pad(ratio, 10)}${pad(m.ripple, 10)}${pad(m.drift, 10)}`);
}
console.log('\n  EVERY column here is a COLOUR difference, flip included. Foam changes colour,');
console.log('  so all of them are upper bounds on instability and none of them is a gate.');
console.log('  Fixture: foam over a BIT-IDENTICAL alpha edge scores flip 16.7%; a real');
console.log('  +/-0.6 px wobble of that edge with no foam scores 3.4%. See the header.');
console.log('  To measure the edge itself, write the surface shader\'s alpha into colour and');
console.log('  run this on that: the shipped shader reads flip 0.00-0.11% at hero/mouth/river/plunge.');
console.log('  baseline, per-frame paired (shots/w0-crawl-ref): mouth flip 1.0 | river flip 6.3 | hero flip 2.4');

#!/usr/bin/env node
/**
 * Marshmallow contact sheet — the critic loop for `docs/ROAST_CONTRACT.md`.
 *
 *   node tools/roastshot.mjs --dir shots/roast/r1              # the whole sheet
 *   node tools/roastshot.mjs --dir shots/roast/r1 --only prop,held
 *   node tools/roastshot.mjs --dir shots/roast/r1 --hour 20.4
 *   node tools/roastshot.mjs --dir shots/roast/r1 --ladder      # one mallow, 6 steps
 *
 * One browser, one bake, one camp, one marshmallow — then every framing four
 * authors need to judge this mechanic. Section 5 of the contract is the spec;
 * this header says what each framing PROVES, because a frame nobody can say
 * that about is a frame nobody will read.
 *
 * ── the three halves of this tool ────────────────────────────────────────────
 *
 *   · **prop** framings look at the roaststick leaning against the table, with
 *     the camera posed by this harness exactly as `campshot.mjs` poses it: `az`
 *     measured from the PROP's own yaw, so the stick is shot three-quarter
 *     front no matter which way `camp_site.js` happened to turn the table it
 *     leans on. These decide whether the object is findable and readable as an
 *     object. Judge them first — a beautiful first-person view of a prop nobody
 *     ever notices in the camp is a feature nobody ever plays.
 *
 *   · **held** framings are captured with the view ACTIVE and the camera posed
 *     BY THE VIEW. This is the opposite of every other framing in this repo and
 *     it is the single thing to keep straight while reading this file. See the
 *     block comment above the "into the view" section.
 *
 *   · **mallow** framings are macros of the marshmallow, with the camera posed
 *     BY THIS HARNESS AGAIN. See the block comment above the macro section for
 *     why posing the camera is correct there and wrong twenty lines earlier.
 *
 * ── what each frame proves ──────────────────────────────────────────────────
 *
 *   prop-fq / prop-side / prop-back  the stick reads from every side. `back` is
 *       the one that catches a prop modelled as a facade; the player drives
 *       around a camp rather than standing in front of it.
 *   prop-wide  the discovery test. If you cannot pick the stick out of this
 *       frame, nobody will ever click it and the other fifteen frames are moot.
 *   held-enter  0.4 through the step-in. The move has to read as a move and not
 *       as a cut, and a transition is the one thing a still of the endpoints
 *       cannot show. Captured by freezing the engine the instant the view's own
 *       `t` crosses 0.4, so it is the same instant every run.
 *   held  the composed first-person frame — the money shot. Stick low from the
 *       right, marshmallow near centre, the fire NOT hidden behind it, no near
 *       stone clipped. Shot twice: `held` with the view's overlay, which is
 *       what the player sees, and `held-clean` without it, because a caption
 *       across the frame corrupts a blind A/B (`docs/CRITIC_PROTOCOL.md`).
 *   ladder-0..5  raw / warmed / gold / dark gold / mahogany / char, from one
 *       marshmallow, one camera, one frozen fire, IN THE PLAYER'S FRAME. The
 *       only input that changes across the six is the toast map: the camera
 *       does not move and the subject projects to the same pixel and the same
 *       101.5 px diameter in all six (`probe.mallowPx` in ROAST.json says so
 *       rather than asking to be believed).
 *
 *       What they prove is the marshmallow's PLACE IN THE COMPOSITION at each
 *       doneness. They cannot be used to judge the surface, and round 1 has the
 *       number: `ladder-1..5` differed from `ladder-0` inside a box 33x32 to
 *       69x59 px and were bit-identical everywhere else. 2 619 pixels of 1 440
 *       000 — 0.18% of the frame — was the whole evidence base a critic had for
 *       blisters, char cracks, translucency and the shape of the ramp. Hence
 *       `mallow-*`.
 *
 *       Note for whoever reads a pixel diff of these six and expects the rest
 *       of the frame to hold still: as of this round it does not, and that is
 *       the marshmallow rather than the harness. `state().glow` climbs 0.162 ->
 *       0.684 across the ladder and 793 317 pixels OUTSIDE the subject move
 *       with it, at up to 406 of a possible 765. A marshmallow that re-lights
 *       the whole camp as it cooks is a thing to judge (ROAST_CRITIC_ROUND: "if
 *       the marshmallow is the brightest thing in the dusk frame, that is a
 *       REJECT however pretty it is"), not a thing to subtract.
 *   mallow-0..5  THE SAME six rungs as a macro — the marshmallow filling about
 *       half the frame height, from a camera this harness poses. This is the
 *       toast author's only real instrument. Judge blisters, the cream-to-gold
 *       sweep, the sudden arrival of char, the cracked black, here.
 *   mallow-uneven / mallow-burning  the same macro of the two states the ladder
 *       cannot reach: heat from one direction, and alight.
 *   mallow-backlit  the macro with the FIRE dead behind the marshmallow, found
 *       by projecting the fire's world position through candidate poses rather
 *       than by guessing an angle. The one frame that can answer "is there
 *       light coming through the far side, or is this a pill".
 *   uneven  turned on one side only. Produced by holding the stick still over
 *       the flame and stepping the real sim, never by painting the map: the
 *       failure this whole mechanic is about is the sim's directionality, and a
 *       painted frame would prove the painting worked. Asserted, not assumed.
 *   burning  alight. Also asserted — `state().burning` must actually be true or
 *       this frame is a photograph of a marshmallow that is not on fire.
 *   dusk-held  the same money shot at 20.4, lit only by the fire. The frame
 *       this feature lives or dies on: at dusk a white marshmallow is the only
 *       object in the game that can out-value the flame (DESIGN_BRIEF, and
 *       section "The look it is judged against" of the contract).
 *
 * ── the debug surface ────────────────────────────────────────────────────────
 *
 * Everything is driven through `window.__roast`, published by
 * `src/camp/camp_roast_view.js`. Nothing here synthesises a mouse drag: a
 * harness that drives the input mapping breaks the moment the input mapping is
 * touched, and then four authors are debugging a capture tool instead of
 * looking at their work. `tools/_scratch/scopeview.mjs` is the tool that DOES
 * drive the real input path, and it exists to test the input path.
 *
 * Required of `window.__roast` (the view's author owns it; this list is the
 * ask, and the harness fails loudly and by name if any of it is missing):
 *
 *   enter()            enter the view, resolving the camp's own roaststick
 *                      itself. `enter(propObj, campRecord)` is tried as a
 *                      fallback. Must bypass the parked/focus gate.
 *   leave()
 *   state()            { active, t, phase, doneness, evenness, peak, burning,
 *                        alight, slip, result, spin, height, eye, mallow,
 *                        fire }. `mallow` is the marshmallow's WORLD position
 *                        and every macro framing is built on it; `eye` is what
 *                        proves the camera is still the view's.
 *   setT(k)            put the step-in at exactly k. `held-enter` needs this,
 *                      because `enter()` deliberately snaps `t` to 1 (see the
 *                      note in `_publishDebug`) and polling `state().t` for a
 *                      0.4 crossing therefore always catches 1.0. Round 1's
 *                      `held-enter` is a fully-composed frame for that reason.
 *   setDoneness(k)     writes the WHOLE map to k and pushes the texture and the
 *                      material uniforms IMMEDIATELY — not a target consumed by
 *                      the next update(). The ladder is captured with the
 *                      engine stopped, so a deferred write never lands.
 *   setSpin(rad)       absolute roll of the stick about its own axis.
 *   setHeight(m)       metres above the flame top.
 *   ignite()
 *   step(dt)           advance the view and the toast sim by exactly dt, with
 *                      no wall-clock read, and work while the engine is
 *                      stopped. This is the whole determinism story.
 *   paint(u,v,r,a)     optional; probed and reported, not required. (The
 *                      contract calls this `setToast(u,v,amount)`; both names
 *                      are probed. `uneven` is produced physically instead.)
 *   setOverlay(bool)   OPTIONAL BUT WANTED. Suppresses the DOM overlay for the
 *                      art frames. Without it this tool falls back to hiding
 *                      elements whose class begins `pa-roast` (the naming
 *                      `camp_scope_view.js` uses for `pa-scope-mask`), and says
 *                      so on stdout and in ROAST.json — a fallback that hides
 *                      itself is how a harness starts lying.
 *
 * Still owed, and named here because the macro block has to work around each:
 *
 *   state().mallowR    the marshmallow's WORLD radius. Without it the macro
 *                      block reaches through `__roast.view.mallow` for the
 *                      mesh's own bounding sphere, which is a private field
 *                      dressed as a getter. One number on `state()` and this
 *                      tool stops touching the view's object graph at all.
 *   detach()/attach()  the held stick is parented to the CAMERA, so a harness
 *                      that moves the camera to shoot a macro drags the subject
 *                      along with it and photographs the same 40 px forever.
 *                      This tool works around it with
 *                      `scene.attach(camera.getObjectByName('camp_roast_held'))`
 *                      — the group's `name` is the only public handle there is.
 *                      A supported `__roast.detach()` / `attach()` pair would
 *                      make that legitimate instead of merely careful.
 *
 * ── determinism, honestly ───────────────────────────────────────────────────
 *
 * `--ladder` is what `tools/ab.mjs` diffs between rounds, so it must differ
 * only by the art. What this tool pins: the seed, the car, the park, the camp
 * site, the hour AND `cycleSpeed = 0`, the quality tier, the adaptive
 * resolution ladder and `resolutionScale` (all three of which shot.mjs pins for
 * reasons its own header spells out), the spin, the height, and the sim's
 * timestep — every advance of the toast is an exact multiple of 1/60 driven by
 * `step(dt)`, never by wall-clock frames.
 *
 * WITHIN a run that is now measured rather than asserted: in `shots/roast/r1`,
 * `ladder-1..5` differ from `ladder-0` inside a 33x32..69x59 px box around the
 * marshmallow and are bit-identical in all 1 437 000 other pixels. The freeze
 * works. The problem was never within-run.
 *
 * BETWEEN runs, round 1's header said "the fire's particle state cannot be
 * pinned" and left it there. That was half right and the wrong half was the
 * expensive one. `--pin` (on by default) now pins everything in the fire that
 * is a pure function of time or a scalar, and clears what is not:
 *
 *   pinned   `engine.elapsed` and `Firepit._t` are set to a constant, so the
 *            flame body and the ember bed — which are wholly `uTime` shaders
 *            (camp_fire.js flame vertex/frag and the bed's `uTime` term) — are
 *            bit-identical between runs, as is every other shader clocked off
 *            `elapsed`: grass sway, water, sky.
 *   pinned   the camp's PITCH ORIGIN. `pitchNear` is continuous in the point it
 *            is given, and reading the camper's settled position back off the
 *            physics gives a point that depends on wall-clock spring settle:
 *            two consecutive runs put the camp 9 mm apart. Nine millimetres is
 *            invisible in a 46-degree camp framing and is 9% of the frame in a
 *            12-degree macro. Pitched at the POI's own coordinates instead, and
 *            the camp is now bit-identical between runs (-1015.31048,
 *            -1003.14241 twice).
 *   pinned   `RoastView._clock`, the view's own seconds — the idle drift on the
 *            eye and on the stick, and the marshmallow material's `uTime`.
 *            Reset at every reseat, so it is a function of the sim steps this
 *            tool took and not of how long the page has been up.
 *   pinned   `Firepit._flare` / `_nextFlare`. The log-settle flare is the
 *            largest single unpinned term in the frame: an unseeded
 *            `Math.random()` schedules it every 6-13 s and it adds up to +0.30
 *            to the flame's gain with a 1.6 s decay. Two runs that caught it at
 *            different points differ by up to 30% of the flame's brightness,
 *            which in a blind A/B of a fire-lit marshmallow is not a subtle
 *            difference. Held at zero for the frozen blocks, and SAID so here
 *            so nobody grades the flare's absence as a defect in the fire.
 *   cleared  the spark and smoke buffers, then regenerated over exactly
 *            `PIN_STEPS` world steps of exactly `DT`, so their ages and counts
 *            are identical between runs instead of being a function of how long
 *            the bake happened to take.
 *   pinned   the gap between the pin and the freeze. `pinWorld` leaves the
 *            engine STOPPED rather than restarting it for the one page.evaluate
 *            before `freeze()` stops it again; those few milliseconds of wall
 *            clock move `Firepit._t`, and the flicker riding on it is +/-13% of
 *            the fire's light. See the note at the end of `pinWorld` for the
 *            measurement that found it.
 *
 * The residual, MEASURED across two runs against unchanged source, with the
 * camp origin and the view clock pinned: 32 352 - 92 800 differing pixels per
 * macro frame at a maximum delta of 55 of a possible 765 — broad, low
 * amplitude, and weighted to the background (43 261 outside the subject against
 * 14 298 inside it on `mallow-2`). That signature is the fire's point light,
 * and it is what the "gap between the pin and the freeze" line above fixes.
 * That fix has NOT been re-measured: the verification pair was invalidated
 * because a peer saved `camp_roast_view.js` between the two captures and the
 * stick moved (`fireNDC.x` -1.969 -> -1.547 under an identical camp and an
 * identical pin record). `ROAST.json.sources` now records that, so the next
 * round's first job is a two-line diff rather than a re-derivation.
 *
 * What no pin can reach, because a vague residual is worse than none:
 *
 *   · the XY positions of the ~20 live sparks and ~30 smoke puffs. Their
 *     spawn is four unseeded `Math.random()` calls each. A harness cannot pin
 *     that without replacing `Math.random` before the bake, which would also
 *     change the world and the camp layout — a cure worse than the disease.
 *     Each is a few pixels; they are the only thing in a `--pin` frame that
 *     moves between runs at all.
 *   · anything alive that wandered into shot. There is a fox in the left edge
 *     of every `ladder-*` frame in r1. Frozen, so it does not move within a
 *     run; between runs it is somewhere else or absent. The macro framings are
 *     tight enough that this cannot reach them, which is a second reason the
 *     A/B workhorse should be `mallow-*` rather than `ladder-*`.
 *
 * `--nopin` skips all of it, for measuring how much it bought.
 *
 * ── output layout ───────────────────────────────────────────────────────────
 *
 * A flat directory of PNGs plus `ROAST.json`. Flat and flat only, because
 * `tools/ab.mjs` pairs by filename and `tools/sheet.mjs` tiles every PNG in one
 * directory — a subdirectory per hour would silently halve both. The filename
 * set is the same for every invocation that is not `--only`/`--ladder`, so two
 * rounds always pair completely.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// ── prop framings ───────────────────────────────────────────────────────────
//
// `az` is measured from the prop's own yaw, exactly as campshot's PROP table
// does, so `fq` is three-quarter front whichever way the layout turned it.
//
// Further out than the cooler (1.35 m) despite being a smaller object: the
// stick is a metre of diagonal leaning on a table, and framed as tightly as a
// cooler the frame holds the marshmallow and none of the line that leads the
// eye to it. 1.65 m at fov 34 gives about a metre of frame height, which is the
// stick plus the table edge it rests on — and the table edge is half of what
// makes the prop read as placed rather than dropped.
//
// `aim` is a fallback only. When the geometry publishes
// `userData.roast.mallow` (contract section 1) the camera aims at the
// marshmallow's real world position instead of at a guessed height above the
// prop origin — the same reason `camp_telescope.js` publishes `eye`/`aim`, and
// guessing there was wrong by 100 mm and 15 degrees.
const PROP = {
  'prop-fq':   { az: 0.75, dist: 1.65, elev: 0.78, fov: 34, aim: 0.42 },
  'prop-side': { az: 1.57, dist: 1.65, elev: 0.78, fov: 34, aim: 0.42 },
  'prop-back': { az: 3.14, dist: 1.65, elev: 0.78, fov: 34, aim: 0.42 },
};

// The discovery framing. Not a member of PROP because it is not measured from
// the prop's yaw at all: it stands off the line from the fire out through the
// stick, swung 0.55 rad round, so the stick is on the near side of the camp and
// cannot be hidden behind the tent by an unlucky layout. Eye height, and wide
// enough to hold the whole camp — the question is "can you pick it out of a
// camp", and a frame with only the stick in it cannot ask that question.
const WIDE = { swing: 0.55, dist: 7.4, elev: 1.85, fov: 46, aim: 0.75 };

// The six rungs.
//
// Not evenly spaced. The contract's ramp compresses its last two thirds so char
// arrives suddenly ("a single linear ramp reads as a stain"), so evenly spaced
// samples would spend three of six rungs inside the fast part and show the
// slow, beautiful cream-to-gold sweep in one. These are placed on the ramp, not
// on the number: 0.42 and 0.60 straddle the `perfect` band (.55-.80 in
// RESULTS), which is the pair a player is trying to hit.
const LADDER = [
  ['ladder-0', 0.00, 'raw'],
  ['ladder-1', 0.20, 'warmed'],
  ['ladder-2', 0.42, 'gold'],
  ['ladder-3', 0.60, 'dark gold'],
  ['ladder-4', 0.78, 'mahogany'],
  ['ladder-5', 0.95, 'char'],
];

// Pinned pose for every ladder rung, so the six differ by the toast alone.
// A spin of 0 is NOT arbitrary: the geometry contract authors the marshmallow a
// few millimetres off the stick's axis, so roll changes the silhouette, and a
// ladder shot at six different rolls is six different silhouettes.
const LADDER_SPIN = 0.0;
const LADDER_HEIGHT = 0.24;      // mid-range of the 0.10-0.55 m band

// ── the macro ───────────────────────────────────────────────────────────────
//
// How much of the frame's HEIGHT the marshmallow's bounding sphere fills.
// 0.55 rather than 0.5 because the sphere is circumscribed — a 21 mm-radius,
// 12.5 mm-half-length squat cylinder has a 24.4 mm bounding radius, so the body
// itself lands at about 0.47 of frame height, which is what was asked for.
const MACRO_FILL = 0.55;

// Except for the frames whose subject is TALLER than the marshmallow. A burning
// marshmallow carries a candle flame above it, and at 0.55 the frame is 0.10 m
// tall at the subject — the marshmallow fills it and the flame is entirely
// above the top edge. Found by looking at `mallow-burning` and seeing a
// marshmallow that `state().alight` said was on fire and that had no fire on
// it: the harness's framing, not the view's flame. Judged per frame, because
// pulling all nine back to fit one of them would throw away the resolution the
// other eight exist for.
const MACRO_FILL_BY = { 'mallow-burning': 0.30 };

// The camera cannot come closer than this. `Engine.js` builds the camera with
// `near = 0.25`, and the ideal macro distance for a 42 mm object is about
// 0.20 m — inside the near plane, which would clip the marshmallow in half and
// look exactly like a geometry bug in the toast author's file. So the distance
// is clamped and the FOV is solved from it instead: 0.40 m works out at about
// 12.7 degrees, which is a long macro lens, which is what a macro shot is.
const MACRO_DIST = 0.40;

// Pose A — the surface pose. Both angles are struck in a frame built around the
// STICK's own axis (see `macroPose`), not around the player's bearing: `az` = 0
// is a pure profile, square to the stick, and `az` rotates the camera toward
// the marshmallow's near end cap. 0.60 rad is 34 degrees off profile, which is
// three-quarter front of the OBJECT — the framing a product shot uses, and the
// one that shows a curved surface's terminator instead of flattening it.
//
// Elevation is gentle: enough to look slightly down onto the top of the swell,
// not enough to turn the frame into a plan view of the end cap.
const MACRO_AZ = 0.60;
const MACRO_ELEV = 0.28;    // ~16 degrees above the marshmallow

// Pose B — the backlit pose, SOLVED rather than guessed. The camera is swept
// through these bands, the fire's world position is projected through each
// candidate, and the pose whose projection lands nearest `MACRO_BACK_TARGET` in
// NDC wins. Guessing an angle here would be guessing at a stick pose that the
// view's author is actively recomposing; projecting the fire is a measurement
// that re-solves itself every round.
//
// The target is below centre rather than at it: the fire dead behind the
// marshmallow means the camera is on the fire->marshmallow line, which is 70
// degrees above horizontal in the r1 pose and therefore a plan view. Behind and
// low reads as a marshmallow held over a fire, which is the picture.
const MACRO_BACK_TARGET = [0.0, -0.45];
const MACRO_BACK_AZ = [-1.8, 1.8, 0.08];     // radians off profile, same frame as MACRO_AZ
const MACRO_BACK_ELEV = [0.0, 0.85, 0.04];   // radians above the marshmallow
// A mild preference for staying near a three-quarter, so the solve does not buy
// two hundredths of NDC accuracy with an end-on view down the stick. Cost is
// `distance to the target + MACRO_BACK_BIAS * |az|`, both in the same units of
// "how wrong does this look", which is a judgement — stated here rather than
// buried, so it can be argued with.
const MACRO_BACK_BIAS = 0.12;

// The nine macro frames. `k` is doneness; `mode` picks the pose.
const MALLOW = [
  ['mallow-0', 0.00, 'raw'],
  ['mallow-1', 0.20, 'warmed'],
  ['mallow-2', 0.42, 'gold'],
  ['mallow-3', 0.60, 'dark gold'],
  ['mallow-4', 0.78, 'mahogany'],
  ['mallow-5', 0.95, 'char'],
];

// The `burning` states — first-person and macro — share these, because two
// frames of "alight" taken at two different heights are two different amounts
// of sag and slip and cannot be read beside each other.
//
// High in the band, and only a beat of sim. `ignite()` alone puts the view's
// melt term at 0.45, and `slip` then climbs at `0.45 * level * 0.5` per second
// with a stationary stick — 0.225/s at the bottom of the height band, so the
// marshmallow is off the stick in four and a half seconds. Round 1 sat at
// 0.10 m for seven seconds waiting for `toast.burning`, which is a DIFFERENT
// flag (a texel past ignition) from the `alight` this frame is of, and recorded
// `slip: 0.595` for its trouble. At 0.45 m `level` is 0.42 and a 1.2 s settle
// costs 0.11 of slip.
// 0.35, not 0.45: at 0.45 the marshmallow sits 108 px from the top of a 900 px
// frame in `burning` and the candle flame above it is off the edge, which is
// the same mistake as framing the macro at 0.55. `level` is 0.58 here, so slip
// climbs at 0.131/s and a 1.2 s settle costs 0.16 of the 1.0 that drops it.
const BURN_H = 0.35;
const BURN_SETTLE = 1.2;

// ── the pin ─────────────────────────────────────────────────────────────────
//
// See the determinism block in the header. `PIN_T` is arbitrary but must be
// large enough that nothing is still ramping in off a zero clock, and constant
// forever after — changing it invalidates every A/B against an older round.
const PIN_T = 600.0;
const PIN_STEPS = 90;       // 1.5 s of world at DT, enough to refill the sparks

// The default hour.
//
// campshot leaves the clock alone when `--hour` is absent; this tool does not,
// and the difference is deliberate. The clock RUNS in the shipped game, so a
// sheet captured over four minutes of wall time at an unpinned hour is a sheet
// whose last frame is at a different sun angle from its first — which is
// precisely the drift `--ladder` exists to exclude. 16.7 is the hour
// `tools/shot.mjs` grades most of its canonical views at.
const DEFAULT_HOUR = 16.7;
const DUSK_HOUR = 20.4;

// One sim step. Every advance of the toast is an exact multiple of this.
const DT = 1 / 60;

const RES = arg('res', '768');
const DIR = arg('dir', 'shots/roast/r');
const HOUR = parseFloat(arg('hour', String(DEFAULT_HOUR)));
const ONLY = arg('only', null) === true ? null : arg('only', null)?.split(',').map((s) => s.trim());
const LADDER_ONLY = has('ladder');
const PIN = !has('nopin');
const PARK = arg('park', 'meadow') === true ? 'meadow' : arg('park', 'meadow');
const SEED = arg('seed', null);
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
// Pin the car — the page picks at random when nothing does. See AGENTS.md.
const CAR = arg('car', 'camper');
const URL = `${arg('url', (process.env.AUTUMN_URL || 'http://127.0.0.1:5251'))}?res=${RES}&car=${CAR}`;

// Answered before the lock and the page load, not after.
//
// Written the first time `--help` was typed at this tool, which took a capture
// slot, baked a world, pitched a camp and spent about ninety seconds before
// telling anybody anything. An unrecognised flag is not a reason to shoot a
// contact sheet.
if (has('help') || has('h')) {
  console.log(`roastshot — the marshmallow contact sheet (docs/ROAST_CONTRACT.md section 5)

  node tools/roastshot.mjs --dir shots/roast/r1              the whole sheet
  node tools/roastshot.mjs --dir shots/roast/r1 --only prop,held
  node tools/roastshot.mjs --dir shots/roast/r1 --hour 20.4
  node tools/roastshot.mjs --dir shots/roast/r1 --ladder     one mallow, 6 steps

  --dir <path>    where the PNGs and ROAST.json go     (shots/roast/r)
  --only <list>   frame names or groups: prop, held, ladder, mallow, uneven,
                  burning, dusk
  --ladder        ONLY the six doneness rungs — the critic-loop workhorse
  --strip         also shoot strip-0..7: one-sided mallow rolled through a full
                  turn, for judging the twirl (ROAST_CRITIC_ROUND element 5)
  --nopin         do NOT pin the fire's clock/flare or reseed its particles.
                  For measuring what the pin buys; see the header.
  --hour <h>      the hour the sheet is shot at        (${DEFAULT_HOUR}); dusk-held is
                  always additionally shot at ${DUSK_HOUR}
  --park <poi>    where to park before pitching        (meadow)
  --seed <n>      pin the camp layout seed
  --car <id>      camper | roamer | adventurer         (camper)
  --res <n>       heightmap resolution for the bake    (768)
  --w / --h       viewport                             (1600 x 900)
  --url <u>       dev server                           ($AUTUMN_URL or 127.0.0.1:5251)
  --hmr           do NOT stub Vite's HMR socket

Frames: prop-fq prop-side prop-back prop-wide held-enter held held-clean
        ladder-0..5 mallow-0..5 mallow-uneven mallow-burning mallow-backlit
        uneven burning dusk-held dusk-held-clean, plus ROAST.json.
Feed the directory straight to tools/sheet.mjs and tools/ab.mjs --stitch.

Every first-person frame is asserted before the shutter (view active, t as
asked, __forceCamera raised, no HUD anywhere in the DOM, and the marshmallow
actually projecting inside the frame). Failures print '!!' and are collected in
ROAST.json under "failures" — grep that before grading anything.`);
  process.exit(0);
}

/** A frame is wanted if `--only` names it, or names its group. */
function wanted(name) {
  if (LADDER_ONLY) return name.startsWith('ladder-');
  if (!ONLY) return true;
  const group = name.split('-')[0];
  return ONLY.includes(name) || ONLY.includes(group);
}

/**
 * Refuse to capture against a tree that does not parse.
 *
 * Straight out of `tools/shot.mjs`, and more relevant here than anywhere: one
 * of the three peers writing this feature is authoring GLSL in
 * `marshmallow_toast.js` right now, and a backtick inside a shader template
 * literal is the single most common way this build goes down (see
 * `tools/lint.mjs`). It surfaces as a blank page a minute later, after a
 * capture and a lock slot have already been spent.
 */
function assertTreeParses() {
  try {
    execFileSync(process.execPath, [resolve(HERE, 'lint.mjs')],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.error('\n[roastshot] refusing to run — the source tree does not parse:\n');
    console.error(out.trim());
    console.error('\nIf the offending file is not yours, a peer is mid-edit: wait and retry');
    console.error('rather than editing their file.\n');
    process.exit(2);
  }
}

/**
 * The mtime and content hash of every file this round is a photograph of.
 *
 * Written because a determinism measurement went wrong in exactly the way
 * CRITIC_PROTOCOL's table describes. Two runs a minute apart, same commit, same
 * camp to five decimal places, the same pin record — and 500 000 differing
 * pixels per macro frame at a maximum delta of 320. The number was correct and
 * it was about something else: a peer saved `camp_roast_view.js` at 16:04:01,
 * between a capture at 16:03:36 and one at 16:04:43, and the stick moved. The
 * only reason that was diagnosable at all is that ROAST.json records `when` and
 * the solved camera pose, so `fireNDC.x` could be seen to have moved with an
 * identical camp underneath it.
 *
 * Four authors share one dev server and this tool stubs HMR, so a page picks up
 * whatever was on disk WHEN IT LOADED. Hence two snapshots: `sources` is taken
 * the moment the page is ready and is the code that is actually in the frames,
 * and `sourcesAtEnd` is taken when this file is written. The two differing does
 * not invalidate the round — it says a peer saved during it, which is expected
 * and is why HMR is stubbed — but it does mean the frames are of the FIRST
 * snapshot, and a reader comparing rounds should pair on that one.
 */
function sources() {
  const files = ['src/camp/camp_roast_view.js', 'src/camp/camp_marshmallow.js',
                 'src/camp/marshmallow_toast.js', 'src/camp/Camp.js', 'src/camp/camp_site.js',
                 'tools/roastshot.mjs'];
  const out = {};
  for (const f of files) {
    try {
      const p = resolve(ROOT, f);
      out[f] = {
        mtime: statSync(p).mtime.toISOString(),
        sha: createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12),
      };
    } catch { out[f] = null; }
  }
  return out;
}

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT }).toString().trim(); }
  catch { return null; }
}

async function main() {
  assertTreeParses();
  const release = await acquire('roastshot');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  // Five authors share one dev server this round; every save reloads the page
  // and throws out whatever evaluate was in flight. Stub the HMR socket so a
  // contact sheet is not a coin toss. `--hmr` keeps live reload.
  if (!has('hmr')) {
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
          return {
            readyState: 3, url, protocol: '',
            addEventListener() {}, removeEventListener() {}, send() {}, close() {},
            set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
          };
        }
        return new Real(url, protocols);
      };
      window.WebSocket.prototype = Real.prototype;
    });
  }
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const bail = async (code, msg) => {
    console.error(msg);
    if (errors.length) console.error('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
    await browser.close(); release(); process.exit(code);
  };

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle,
    null, { timeout: 30000 });

  // Taken HERE, not at write time: with HMR stubbed the page is running the
  // code that was on disk when it loaded, and a peer saving during the four
  // minutes of capture does not change what is in the frames.
  const srcAtLoad = sources();

  // Pin quality and resolution for the whole run. shot.mjs's header has the
  // argument: a plate captured at two thirds resolution or a tier down against
  // a baseline taken at full is not a comparison, and nothing else in the
  // output would say so. Proved rather than assumed — printed at the end.
  await page.evaluate(() => {
    const e = window.__engine;
    if (!e) return;
    e.autoQuality = false;
    e.adaptive = false;
    e.resolutionScale = 1;
  });

  // Freeze the clock before anything else. Every frame in the sheet is at the
  // same sun angle unless it is deliberately not.
  await page.evaluate((h) => {
    window.__lighting.hour = h;
    window.__lighting.cycleSpeed = 0;
  }, HOUR);

  // Park somewhere open. Judging a camp while the camper is buried in a thicket
  // tells you about the thicket — the same lesson vshot.mjs learned.
  //
  // The POI's own coordinates are kept and used as the PITCH ORIGIN below,
  // instead of reading the camper's settled position back off the physics. This
  // is not tidiness, it is the largest between-run difference this tool has.
  // Measured: two consecutive runs put the camp at (-1014.989, -1002.875) and
  // (-1014.996, -1002.881) — 9 mm apart, because the camper's springs settle
  // over wall-clock time and `pitchNear` is continuous in the point it is given.
  // Nine millimetres is nothing in a 46-degree camp framing and it is 9% of the
  // frame in a 12-degree macro, so every background pixel of `mallow-*` moved
  // and an `ab.mjs` pair of two rounds was a pair of two camps. The POI is a
  // query over the baked world and returns the same point every time.
  const parkAt = await page.evaluate((kind) => {
    const p = window.__poi.best(kind) ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
    return { x: p.x, z: p.z, yaw: p.yaw ?? 0.9 };
  }, PARK);
  await page.waitForTimeout(1600);          // springs settle, streaming catches up

  // ── latch the park brake before pitching ──────────────────────────────────
  //
  // Not decoration, and it matters more to this tool than to campshot. The
  // camper's headlights ramp on at dusk at intensity 190 and reach 68 m;
  // latching the brake is the only way to make a camp and latching it dips
  // them. `dusk-held` is the frame this whole feature is judged on and its
  // entire claim is that the FIRE is the only light in it — captured under an
  // undipped headlight beam it is a photograph of a floodlit marshmallow, and
  // the telescope round spent two passes of albedo work on exactly that
  // mistake (16.8% of the prop's pixels clipped; 0.00% with the brake latched).
  //
  // A real keypress, because `brakeHold` is driven by the physics and assigning
  // it from an evaluate survives exactly one frame.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(2400);        // the dip eases in over ~1.5 s
  const held = await page.evaluate(() => ({
    brakeHold: !!window.__systems.vehicle?.brakeHold,
    beam: +(window.__systems.vehicle?.headlights?.[0]?.intensity ?? -1).toFixed(1),
  }));
  if (!held.brakeHold) {
    console.warn('[roastshot] park brake did NOT latch — the camper was probably still ' +
                 'rolling. Every dusk frame in this run is under full headlights and none ' +
                 'of them is evidence about the fire.');
  }
  console.log(`brake: held=${held.brakeHold} beam=${held.beam}`);

  // ── pitch the camp ────────────────────────────────────────────────────────
  const site = await page.evaluate(({ seed, at }) => {
    const v = window.__systems.vehicle;
    if (seed !== null) window.__camp.__seed = parseInt(seed, 10);
    // Pitched at the POI, not at the camper — see the note by `parkAt`.
    const ox = at ? at.x : v.position.x, oz = at ? at.z : v.position.z;
    const s = window.__camp.pitchNear(ox, oz, { instant: true, radius: 14 });
    if (!s) return null;
    // Explicit fields, never a spread of the camp record: it carries `root`,
    // `fire` and `ground`, which are Object3Ds with parent pointers, and
    // JSON.stringify on that throws on the circular structure rather than
    // writing a site file. (campshot learned this one the hard way.)
    return {
      x: s.x, y: s.y, z: s.z, radius: s.radius,
      vehAxis: Math.atan2(v.position.x - s.x, v.position.z - s.z),
      props: window.__camp.props.map((p) => ({
        kind: p.item.kind, x: p.item.x, y: p.item.y, z: p.item.z, yaw: p.item.yaw })),
    };
  }, { seed: SEED, at: parkAt });

  if (!site) {
    await bail(2, 'roastshot: pitchNear found no valid site near the camper. ' +
                  'Try --park road, or --park vista.');
  }
  console.log(`camp at ${site.x.toFixed(1)}, ${site.z.toFixed(1)} — ` +
              site.props.map((p) => p.kind).join(', '));

  const stick = site.props.find((p) => p.kind === 'roaststick') ?? null;
  if (!stick) {
    await bail(2,
      'roastshot: this camp has no `roaststick` prop.\n' +
      '  That is not necessarily a bug. Since the player ruled that a stick may\n' +
      '  lean ONLY on a table or a woodpile, a camp with neither gets no stick\n' +
      '  and the mechanic is simply unavailable there — compact hillside camps\n' +
      '  never get a table, so those depend on the woodpile roll.\n' +
      '  If this layout HAS a table or a woodpile, then it is a bug, owed by\n' +
      '  src/camp/camp_site.js (the item + its restH/leanYaw opts) or\n' +
      '  src/camp/Camp.js (`roaststick: buildRoastStick` in BUILD).\n' +
      '  Otherwise: re-run with a different --park or --seed.\n' +
      `  This layout placed: ${site.props.map((p) => p.kind).join(', ')}`);
  }

  // ── the debug surface must exist before anything is captured ──────────────
  //
  // Named, not timed out. A harness that waits 30 s and dies with
  // "waitForFunction timeout" sends the reader hunting a hang; the truthful
  // failure is "a file that owes an export has not landed yet".
  const surface = await page.evaluate(() => {
    const r = window.__roast;
    if (!r) return null;
    const seen = {};
    for (const k of ['enter', 'leave', 'state', 'setDoneness', 'setSpin', 'setHeight',
                     'ignite', 'step', 'paint', 'setToast', 'setOverlay']) {
      seen[k] = typeof r[k] === 'function';
    }
    return seen;
  });
  if (!surface) {
    await bail(3,
      'roastshot: window.__roast is missing.\n' +
      '  It is owed by src/camp/camp_roast_view.js (contract section 5: the view\n' +
      '  exposes the debug surface, the harness says what it needs). Nothing in\n' +
      '  this tool can run without it, and it will not synthesise mouse drags\n' +
      '  instead. If that file has not landed yet, this is expected — wait for it.');
  }
  const REQUIRED = ['enter', 'leave', 'state', 'setDoneness', 'setSpin', 'setHeight', 'ignite', 'step'];
  const missing = REQUIRED.filter((k) => !surface[k]);
  if (missing.length) {
    await bail(3,
      `roastshot: window.__roast is missing ${missing.join(', ')}.\n` +
      '  Owed by src/camp/camp_roast_view.js. See the header of this file for the\n' +
      '  exact contract each one has to meet (setDoneness must write immediately;\n' +
      '  step(dt) must work with the engine stopped).');
  }
  if (!surface.paint && !surface.setToast) {
    console.log('note: neither __roast.paint() nor __roast.setToast() is present. Not fatal — ' +
                '`uneven` is produced by stepping the real sim — but the contract lists one.');
  }
  console.log('__roast:', Object.entries(surface).filter(([, v]) => v).map(([k]) => k).join(', '));

  mkdirSync(resolve(DIR), { recursive: true });

  // ── overlay control ───────────────────────────────────────────────────────
  //
  // The clean frames are for judging art, and a line of tip text across the
  // frame corrupts a blind A/B exactly as CRITIC_PROTOCOL describes. Prefer the
  // view's own hook; the DOM fallback is a fallback and announces itself, here
  // and in ROAST.json. A workaround that hides itself is how a harness starts
  // lying about what it photographed.
  let overlayMode = surface.setOverlay ? 'hook' : 'dom-fallback';
  const setOverlay = async (on) => {
    overlayMode = await page.evaluate((v) => {
      if (typeof window.__roast?.setOverlay === 'function') { window.__roast.setOverlay(v); return 'hook'; }
      // Follows `camp_scope_view.js`'s naming: `pa-scope-mask` / `pa-scope-tip`.
      const els = document.querySelectorAll('[class^="pa-roast"],[class*=" pa-roast"]');
      for (const el of els) el.style.visibility = v ? '' : 'hidden';
      return els.length ? 'dom-fallback' : 'nothing-found';
    }, on);
    return overlayMode;
  };

  // ── page-side helpers ─────────────────────────────────────────────────────
  const roastState = () => page.evaluate(() => {
    try { return window.__roast?.state?.() ?? null; } catch (e) { return { error: String(e) }; }
  });

  /**
   * Stop the engine and draw by hand.
   *
   * With the loop stopped nothing updates: not the fire, not the embers, not
   * the smoke, not the sun. That is the point — it is what makes the six ladder
   * rungs differ by the marshmallow and by nothing else. The same trick
   * `tools/shot.mjs --waterdiff` uses, and for the same reason: a pair of
   * frames that must differ by ONE thing cannot be captured a few hundred
   * milliseconds apart with the world running.
   */
  const freeze = () => page.evaluate(() => {
    const e = window.__engine;
    e.stop();
    window.__roastDraw = () => {
      if (e._render) e._render(0, e.elapsed);
      else e.renderer.render(e.scene, e.camera);
    };
    window.__roastDraw();
  });
  const thaw = () => page.evaluate(() => { window.__roastDraw = null; window.__engine.start(); });
  const draw = () => page.evaluate(() => { window.__roastDraw?.(); });

  /** Advance the sim by exactly `secs`, as an integer number of DT steps. */
  const step = (secs) => page.evaluate(({ n, dt }) => {
    for (let i = 0; i < n; i++) window.__roast.step(dt);
    window.__roastDraw?.();
    return window.__roast.state?.() ?? null;
  }, { n: Math.round(secs / DT), dt: DT });

  /**
   * Step the toast sim until a condition holds, or `maxSecs` of sim time runs
   * out — and STOP EARLY if the marshmallow starts sliding off the stick.
   *
   * That last clause is the whole of round 1's failure. `uneven` and `burning`
   * both stepped fifty seconds of sim with the stick level and low over the
   * flame, which is precisely the condition `camp_roast_view.js` melts a
   * marshmallow off the stick for: with `alight` true the melt term is at least
   * 0.45, `level` is 1.0 at the bottom of the height band, a stationary stick
   * removes none of the slip, and `slip` therefore climbs at 0.225/s. Round 1's
   * `burning` frame records `slip: 0.595`. The `--strip` block then ran ANOTHER
   * ninety seconds without re-entering, `slip` passed 1, the view dropped the
   * marshmallow in the fire and stepped back out — and the eight strip frames
   * and both dusk frames are chase-camera aerials of the camp with the full HUD
   * in them. All of that is in r1's ROAST.json, in writing, because nothing was
   * asserting on it.
   *
   * So: `slip` is a stop condition, not a thing to notice afterwards. The
   * caller is told which condition fired.
   */
  const SLIP_STOP = 0.55;
  // `onesided` wants BOTH halves of its name: real toast somewhere (mean
  // doneness past 0.28) AND real directionality (evenness under 0.72). Either
  // alone lies. Round 1 stopped on mean doneness 0.45 alone and got there by
  // charring the hot face to 1.0 and igniting it; the first pass of this round
  // stopped on `peak >= 0.80` alone and got a marshmallow with ONE hot texel, a
  // mean of 0.07 and an evenness of 0.84 — an essentially raw marshmallow in a
  // frame captioned "toasted on one side". Both numbers were correct. Both were
  // about something other than the picture.
  const UNEVEN_DONE = 0.28;
  // 0.60, and it was 0.72 — which disagreed with this tool's OWN warning.
  //
  // The stop said "stop once evenness is at or under 0.72"; the check after the
  // shutter said "warn if evenness is above 0.60". Between those two numbers is
  // a 0.12-wide band in which a perfectly correct one-sided marshmallow gets
  // captured AND complained about, and that is exactly where the doneness half
  // binds first: replayed offline (`tools/_scratch/_unevenchk.mjs`), at the
  // instant doneness reaches 0.28 the evenness is 0.676 / 0.607 / 0.517 at
  // h = 0.10 / 0.16 / 0.24. So the run stopped the moment it had enough TOAST
  // and before it had enough DIRECTION, and then told the reader the simulation
  // might be broken.
  //
  // Fixed by moving the stop rather than the warning, because the frame is the
  // point: keep stepping until the marshmallow is as one-sided as the caption
  // claims. Two more seconds of sim gets there — the same run reads 0.50 by
  // then. The toast sim was never involved; both numbers were this tool's.
  const UNEVEN_EVEN = 0.60;
  const stepUntil = (cond, maxSecs) => page.evaluate(({ cond, n, dt, slipStop, ud, ue }) => {
    const r = window.__roast;
    let i = 0, why = 'timeout';
    for (; i < n; i++) {
      r.step(dt);
      const s = r.state?.() ?? {};
      if ((s.slip ?? 0) >= slipStop) { why = 'slip'; break; }
      if (!s.active) { why = 'view-left'; break; }
      if (cond === 'onesided') {
        if (s.alight) { why = 'alight'; break; }
        if ((s.doneness ?? 0) >= ud && (s.evenness ?? 1) <= ue) { why = cond; break; }
      }
      if (cond === 'toasted' && (s.doneness ?? 0) >= 0.45) { why = cond; break; }
      if (cond === 'burning' && s.burning) { why = cond; break; }
    }
    window.__roastDraw?.();
    return { why, hit: why === cond, sim: +(i * dt).toFixed(3), state: r.state?.() ?? null };
  }, { cond, n: Math.round(maxSecs / DT), dt: DT, slipStop: SLIP_STOP,
       ud: UNEVEN_DONE, ue: UNEVEN_EVEN });

  /**
   * Sit back down with a fresh marshmallow, and prove it took.
   *
   * `leave()` and then `enter()`, in that order, and the order is the whole
   * point. `RoastView.enter` opens with `if (this.prop === prop && this.prop)
   * return;` — re-entering on the SAME stick is deliberately a no-op, which is
   * right for a player who clicks the stick they are already holding and
   * useless to a harness that needs a clean marshmallow. Measured, not assumed:
   * a plain `enter()` between two macro shots left `doneness` at 0.95 and the
   * "uneven" block stopped on its first step. `leave()` runs `_release()`,
   * which nulls the prop and zeroes `alight` and `slip`, and the following
   * `enter()` then does the full reset including `toast.reset()`.
   *
   * Both calls sit inside ONE page.evaluate so `window.__forceCamera` never
   * appears low to a `HUD.update` between them — the HUD's 0.45 s fade would
   * otherwise start over and the next frame would catch a half-visible
   * speedometer, which the assertion below would (correctly) fail.
   *
   * Called before EVERY block, not only after the blocks that can drop the
   * marshmallow. A reseat that only runs where somebody remembered it is a
   * reseat that will be missing from the next block somebody adds — which is
   * exactly how round 1's `--strip` inherited an alight, half-slipped
   * marshmallow, dropped it in the fire four seconds later, and shot eight
   * identical aerials of the camp.
   */
  const reseat = async (label, { spin = LADDER_SPIN, height = LADDER_HEIGHT, t = 1 } = {}) => {
    const r = await page.evaluate(({ spin, height, t, clockT }) => {
      const R = window.__roast;
      try { R.leave(); } catch { /* not seated yet; enter() below does the work */ }
      try { R.enter(); } catch (e) { return { error: String(e) }; }
      if (!R.state().active) {
        // The two-argument form, exactly as the first entry does.
        const camp = window.__camp.camps?.[window.__camp.camps.length - 1] ?? null;
        const p = window.__camp.props.find((q) => q.item.kind === 'roaststick');
        try { R.enter(p?.obj ?? p, camp); } catch (e) { return { error: String(e) }; }
      }
      // The view's own seconds. It drives three things a between-run A/B cannot
      // afford to have free-running: the idle drift on the eye (up to +/-19 mm,
      // which is 19% of a 12-degree macro's frame height), the same drift on the
      // stick, and the marshmallow material's `uTime`. `enter()` does not reset
      // it — it is set once in the constructor — so it is a function of how long
      // the page has been up, and two rounds captured after two different bakes
      // differ by every pixel of background.
      //
      // MEASURED: with the camp's pitch origin already pinned, two consecutive
      // runs differed by 49 750 - 107 798 px per macro frame with this free, and
      // the subject itself was stable — because the marshmallow is parented to
      // the camera, so the bob moves the camera and the subject together and
      // slides the world behind them. Pinned here rather than in `pinWorld`
      // because the `uneven` and `burning` preps reseat without pinning.
      //
      // A private field, like `Firepit._t`. A supported way to pin the idle
      // drift — or a reset in `enter()` — is on the ask list in this file's
      // header.
      const V = R.view;
      const clocked = V && typeof V._clock === 'number';
      if (clocked) V._clock = clockT;
      if (typeof R.setT === 'function') R.setT(t);
      R.setSpin(spin);
      R.setHeight(height);
      R.setDoneness(0);
      R.step(0);
      const s = R.state();
      return { active: s.active, t: s.t, phase: s.phase, slip: s.slip, alight: s.alight,
        doneness: s.doneness, force: !!window.__forceCamera, clocked };
    }, { spin, height, t, clockT: PIN_T });
    if (r && r.clocked === false && !reseatWarned.clock) {
      reseatWarned.clock = true;
      console.log('  !! the view has no `_clock` to pin, so its idle drift on the eye and the ' +
        'stick is free-running. Between-run A/Bs of the macro frames will differ by every ' +
        'background pixel; the subject itself is still comparable.');
    }
    if (r?.error || !r?.active) {
      console.log(`  !! reseat before ${label} did not put the view back: ${JSON.stringify(r)}`);
    } else if ((r.doneness ?? 0) > 0.001 || (r.slip ?? 0) > 0.001 || r.alight) {
      console.log(`  !! reseat before ${label} did not hand back a fresh marshmallow: ` +
        `doneness=${r.doneness} slip=${r.slip} alight=${r.alight}. Every frame in this block ` +
        'inherits the state of the block before it and none of them is what it says it is.');
    }
    return r;
  };

  /**
   * Pin everything in the world that a harness can pin. See the determinism
   * block in this file's header for what each line buys and what is left over.
   *
   * Reaches into `Engine._updaters` / `_lateUpdaters` to advance the world by a
   * fixed dt, because `Engine._loop` takes its dt from a wall clock and there is
   * no other way to run the world a known amount. If that ever stops working it
   * says so and carries on unpinned rather than silently capturing an unpinned
   * round that claims to be pinned.
   */
  const pinWorld = () => page.evaluate(({ t, steps, dt }) => {
    const e = window.__engine;
    const out = { asked: true, elapsed: null, fire: null, steps: 0, notes: [] };
    if (!e) { out.notes.push('no window.__engine'); return out; }

    // The campfire of the camp this view is sitting at. `Camp.js` publishes
    // `camps[].fire`; the roast view resolves its own fire the same way.
    const camps = window.__camp?.camps ?? [];
    const fire = camps.map((c) => c.fire).filter(Boolean).pop() ?? null;

    e.stop();
    e.elapsed = t;
    if (fire) {
      fire._t = t;
      // The log-settle flare: an unseeded Math.random() every 6-13 s, worth up
      // to +0.30 on the flame's gain with a 1.6 s decay. Held down for the
      // frozen blocks. Reported, so its absence is never graded as a defect.
      fire._flare = 0;
      fire._nextFlare = 1e9;
      fire._flareBurst = 0;
      fire.embers?.clear?.();
      fire.smoke?.clear?.();
      out.fire = { pinned: true, cleared: !!fire.embers };
    } else {
      out.notes.push('no camp fire found on window.__camp.camps[].fire — the flame clock, ' +
        'the flare and the spark buffers are all UNPINNED in this run');
    }

    const up = e._updaters, late = e._lateUpdaters;
    if (!Array.isArray(up) || !Array.isArray(late)) {
      out.notes.push('Engine._updaters/_lateUpdaters are not arrays any more — the world ' +
        'could not be stepped at a fixed dt and the particle ages are UNPINNED');
      e.start();
      return out;
    }
    for (let i = 0; i < steps; i++) {
      e.elapsed += dt; e.frame++;
      for (const fn of up) fn(dt, e.elapsed);
      for (const fn of late) fn(dt, e.elapsed);
      e.renderer.info.reset();
      if (e._render) e._render(dt, e.elapsed); else e.renderer.render(e.scene, e.camera);
      out.steps++;
    }
    out.elapsed = +e.elapsed.toFixed(4);
    // LEFT STOPPED, deliberately. Every caller freezes immediately afterwards,
    // and restarting the engine here to stop it again one page.evaluate later
    // hands the world a few milliseconds of WALL CLOCK — which is the one thing
    // this whole function exists to keep out of the frame.
    //
    // Measured: with that gap in place and everything else pinned, two runs
    // still differed by 32 352 - 92 800 px per macro frame, at a maximum delta
    // of 55 of 765 — broad, low-amplitude, and weighted to the background
    // rather than the subject. That is the signature of the fire's POINT LIGHT,
    // not of geometry: `Firepit._flicker` is +/-13% of gain off four sines of
    // `_t`, and a handful of free-running frames moves `_t` by a run-dependent
    // amount and re-lights the whole camp a fraction of a stop differently.
    window.__roastDraw = () => {
      if (e._render) e._render(0, e.elapsed);
      else e.renderer.render(e.scene, e.camera);
    };
    window.__roastDraw();
    return out;
  }, { t: PIN_T, steps: PIN_STEPS, dt: DT });

  // ── the assertion that cannot rationalise ─────────────────────────────────
  //
  // Round 1 shipped `dusk-held-clean.png`: a chase-camera aerial of the whole
  // camp with the speedometer, the compass ribbon and the minimap in it. The
  // audit that ran before that shutter PASSED it, and it passed it honestly —
  // it looked for `.pa-camp-prompt`, for the placement reticle, and for
  // elements classed `pa-roast*`, and none of those was in the frame. It had no
  // opinion about whether the frame was of this feature at all.
  //
  // That is exactly the shape of every row in CRITIC_PROTOCOL's table of
  // instruments that are confidently wrong: a clean measurement attached to the
  // wrong object. The fix is not a longer list of class names. The fix is to
  // assert the things that are TRUE OF THIS FEATURE and cannot be true of an
  // aerial, and the strongest of those is the last one:
  //
  //   1. the view says it is active, and is in the phase asked for. A view that
  //      dropped the marshmallow and stepped back reports `active: false`, and
  //      round 1's strip and dusk frames all do — in ROAST.json, in writing,
  //      unread, because nothing was asserting on it.
  //   2. `state().t` is what was asked for, so `held-enter` is a frame OF the
  //      transition rather than a frame of wherever the transition got to.
  //   3. `window.__forceCamera` is raised. It is the global the HUD, the prompt
  //      and the reticle all key off (`HUD.js`: `hidden = !!__forceCamera &&
  //      !__hudForce`), so it lowering is both the cause of a HUD in frame and
  //      the proof that the view has let the camera go.
  //   4. the camera is where the view says its eye is, within 5 cm. This is the
  //      one that catches a view which reports `active` but has silently lost
  //      the takeover — no DOM check can see that, and no amount of looking at
  //      a contact sheet reliably does either.
  //   5. NO HUD, measured geometrically rather than by name: every element in
  //      the document that is painted, has area, and overlaps the viewport,
  //      minus the view's own overlay when the frame is allowed it. A class
  //      list goes stale the moment somebody adds a widget; a bounding box does
  //      not. Round 1's `dusk-held-clean` scores 8 here.
  //   6. THE MARSHMALLOW IS IN THE FRAME. `state().mallow` is a world position;
  //      project it. If it is not on screen this is not a photograph of a
  //      marshmallow, whatever else is true. This single check would have
  //      caught all three of round 1's bad framings, and it also returns the
  //      subject's diameter in pixels — which is how "the ladder renders the
  //      marshmallow at about 40 px" stops being an impression and becomes a
  //      number in ROAST.json.
  //
  // Everything here returns data. The caller decides what is a failure, because
  // two frames legitimately break rules — `held-enter` at t < 0.52 has no stick
  // in it at all (the view hides it until the pick-up is covered) and the macro
  // frames are posed by this harness, so check 4 does not apply to them. Those
  // exemptions are passed in explicitly and recorded in ROAST.json beside the
  // frame, so an exemption is a thing a reader can see and disagree with rather
  // than a silence.
  const probeFrame = (opts) => page.evaluate(({ allowOverlay, posed, subject }) => {
    const e = window.__engine;
    const st = (() => { try { return window.__roast?.state?.() ?? null; } catch { return null; } })();

    // ── UI, by geometry ─────────────────────────────────────────────────────
    //
    // Effective opacity is the PRODUCT up the ancestor chain, and getting that
    // wrong is how this check would quietly invert. `#pa-hud` is a full-viewport
    // `position:fixed; inset:0` container that hides itself by setting its own
    // opacity to 0 (`hud.css`: `#pa-hud.pa-capture-hidden { opacity: 0 }`); its
    // children keep a computed opacity of 1 the whole time. A check that read
    // each element's own opacity would therefore report a fully hidden HUD as
    // eleven visible widgets on every frame, cry wolf for a round, and get
    // switched off — which is worse than not having it.
    const vw = window.innerWidth, vh = window.innerHeight;
    const effOpacity = (el) => {
      let o = 1;
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === 'hidden' || cs.display === 'none') return 0;
        o *= parseFloat(cs.opacity);
        if (o <= 0.02) return 0;
      }
      return o;
    };
    const ui = [];
    let overlay = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'CANVAS' || el.tagName === 'SCRIPT' ||
          el.tagName === 'STYLE' || el.tagName === 'DEFS') continue;
      const cs = getComputedStyle(el);
      // A container that paints nothing itself is not a thing in the frame; its
      // children are, and they are enumerated on their own. Count an element if
      // it is a leaf, or if it lays down ink of its own.
      const inks = cs.backgroundImage !== 'none'
        || !/^rgba\(.*,\s*0\)$/.test(cs.backgroundColor)
        || cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none';
      if (el.childElementCount > 0 && !inks) continue;
      const o = effOpacity(el);
      if (o <= 0.02) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
      // The view's own overlay, tested up the ANCESTOR chain and not just on
      // the element itself. The tip line is `<span>…<b>A</b>/<b>D</b>…</span>`
      // inside the overlay's root, and those `<b>`s carry no class of their
      // own: an own-class test reports six unexplained UI elements on every
      // frame the overlay is legitimately in, and an assertion that fails on
      // correct frames gets switched off within a round.
      let isOverlay = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const c = String(n.className?.baseVal ?? n.className ?? '');
        if (/(^|\s)pa-roast/.test(c) || /^pa-roast/.test(n.id ?? '')) { isOverlay = true; break; }
      }
      const cls = String(el.className?.baseVal ?? el.className ?? '');
      if (isOverlay) { overlay++; continue; }
      ui.push({ id: el.id || null, cls: cls.slice(0, 48), tag: el.tagName,
        op: +o.toFixed(2), w: Math.round(r.width), h: Math.round(r.height),
        x: Math.round(r.left), y: Math.round(r.top) });
    }
    // Said separately as well as counted, because it is the one statement that
    // needs no heuristic: the HUD root either paints or it does not.
    const hudRoot = document.getElementById('pa-hud');
    const hudOp = hudRoot ? +effOpacity(hudRoot).toFixed(3) : 0;

    const prompt = (() => {
      const p = document.querySelector('.pa-camp-prompt');
      if (!p) return '';
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) <= 0.02) return '';
      return p.textContent.trim();
    })();
    const r = window.__camp?.reticle;

    // ── the subject, projected ──────────────────────────────────────────────
    //
    // Both the centre and the radius, so the answer is "where and how big"
    // rather than "somewhere". The radius is taken off the mesh's own bounding
    // sphere when it can be reached and falls back to the contract's 21 mm,
    // and which of the two happened is reported — a fallback that hides itself
    // is how a harness starts lying.
    //
    // `subject` overrides `state().mallow` for the frames the view is not in.
    // The prop framings had no subject check at all until this round, which is
    // the same hole in a different wall: `prop-fq` is posed at a point read off
    // `userData.roast.mallow` and nothing was asserting that the point landed
    // anywhere near the middle of the frame, or in it.
    let mallowPx = null;
    const subj = subject ?? st?.mallow ?? null;
    if (subj && e?.camera) {
      const THREE = window.__THREE;
      const cam = e.camera;
      cam.updateMatrixWorld(true);
      const world = new THREE.Vector3(subj.x, subj.y, subj.z);
      const ndc = world.clone().project(cam);
      const mesh = subject ? null : (window.__roast?.view?.mallow ?? null);
      let R = 0.021, rSource = subject ? 'prop-userData' : 'contract-default';
      if (mesh) {
        mesh.updateWorldMatrix(true, false);
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const s = new THREE.Vector3();
        mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
        R = mesh.geometry.boundingSphere.radius * Math.max(s.x, s.y, s.z);
        rSource = 'mesh-bounding-sphere';
      }
      // A point R metres to the camera's right of the centre, projected: the
      // honest on-screen radius including perspective, not an atan estimate.
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(R);
      const edge = world.clone().add(right).project(cam);
      const px = Math.abs(edge.x - ndc.x) * vw * 0.5;
      mallowPx = {
        ndc: { x: +ndc.x.toFixed(4), y: +ndc.y.toFixed(4), z: +ndc.z.toFixed(4) },
        x: Math.round((ndc.x * 0.5 + 0.5) * vw),
        y: Math.round((-ndc.y * 0.5 + 0.5) * vh),
        diameter: +(px * 2).toFixed(1),
        worldR: +R.toFixed(4), rSource,
        onScreen: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z < 1,
      };
    }

    // ── the camera, against the view's own claim ────────────────────────────
    let camGap = null;
    if (st?.eye && e?.camera && !posed) {
      const c = e.camera.position;
      camGap = +Math.hypot(c.x - st.eye.x, c.y - st.eye.y, c.z - st.eye.z).toFixed(3);
    }

    return {
      active: !!st?.active,
      t: st?.t ?? null,
      phase: st?.phase ?? null,
      result: st?.result ?? null,
      slip: st?.slip ?? null,
      forceCamera: !!window.__forceCamera,
      camGap,
      overlay,
      overlayOK: allowOverlay ? overlay > 0 : overlay === 0,
      prompt,
      reticle: !!(r?.mesh?.visible && r._fade > 0.01),
      hudOp,
      uiCount: ui.length,
      ui: ui.slice(0, 8),
      mallowPx,
    };
  }, opts);

  // ── one capture ───────────────────────────────────────────────────────────
  //
  // `fail` is a list of strings, one per broken assertion, and it goes into the
  // frame's record AND into a run-level `failures` array. A `!!` on stdout
  // scrolls away under four minutes of capture log; a list in ROAST.json does
  // not, and a critic who greps it before grading cannot normalise a defect the
  // way a reader of a contact sheet can.
  const frames = [];
  const failures = [];
  const macroPoses = {};
  const reseatWarned = {};
  let pin = null;
  const shoot = async (name, opts = {}) => {
    const {
      overlay = false,      // the view's own DOM overlay belongs in this frame
      firstPerson = false,  // assert this is a frame of the active view
      posed = false,        // the camera is posed by this harness, not the view
      t = 1,                // the step-in progress this frame is supposed to be at
      phase = 'roast',
      expectMallow = true,  // the marshmallow is supposed to project into frame
      subject = null,       // world point to project when the view is not active
    } = opts;
    const p = await probeFrame({ allowOverlay: overlay, posed, subject });
    const fail = [];

    if (firstPerson) {
      if (!p.active) {
        fail.push('the view is NOT active — this frame is not of this feature. ' +
          `phase=${p.phase} result=${p.result} slip=${p.slip}`);
      }
      if (p.t === null || Math.abs(p.t - t) > 0.01) {
        fail.push(`state().t is ${p.t}, asked for ${t}`);
      }
      if (p.phase !== phase) fail.push(`state().phase is "${p.phase}", expected "${phase}"`);
      if (!p.forceCamera) {
        fail.push('window.__forceCamera is LOW. The view raises it on the way in and ' +
          'restores it on the way out, so this frame is after a leave() — and the HUD, ' +
          'the prompt and the reticle are all keyed off it.');
      }
      // Only at the end of the step-in. `state().eye` is the SETTLED seat —
      // where the camera is going, not where it is — and `_drive` lerps the
      // camera to it across the transition, so mid-flight the two legitimately
      // differ by however far the chase camera happened to be standing (14.2 m
      // in the shakedown run). Asserting it at t < 1 measures the transition,
      // not the takeover.
      if (!posed && t >= 0.999 && p.camGap !== null && p.camGap > 0.05) {
        fail.push(`the camera is ${p.camGap} m from the eye the view reports. The view says ` +
          'it is active but something else is driving the camera — see CameraRig.takeCamera.');
      }
    }
    if (p.prompt) fail.push(`the camp prompt is visible: ${JSON.stringify(p.prompt)}`);
    if (p.reticle) fail.push('the placement reticle is visible');
    if (p.hudOp > 0.02) {
      fail.push(`#pa-hud is painting at opacity ${p.hudOp} — the speedometer, the compass ` +
        'and the minimap are in this frame. It hides itself off `window.__forceCamera` ' +
        '(HUD.js) and that global is only raised while a view or a capture owns the camera.');
    }
    if (p.uiCount > 0) {
      fail.push(`${p.uiCount} UI element(s) in frame: ` +
        p.ui.map((u) => `${u.tag}${u.id ? '#' + u.id : ''}${u.cls ? '.' + u.cls.split(/\s+/)[0] : ''}` +
          `(${u.w}x${u.h}@${u.x},${u.y})`).join(' '));
    }
    if (!p.overlayOK) {
      fail.push(overlay
        ? "this frame is supposed to include the view's overlay and none is visible"
        : `this frame is supposed to be clean and ${p.overlay} overlay element(s) are ` +
          `visible (overlay mode: ${overlayMode})`);
    }
    if (expectMallow) {
      if (!p.mallowPx) {
        fail.push(subject
          ? 'no subject point to project — the prop publishes no `userData.roast.mallow`'
          : 'state().mallow is null — nothing to frame and nothing to assert');
      } else if (!p.mallowPx.onScreen) {
        fail.push(`the marshmallow projects to NDC ${p.mallowPx.ndc.x},${p.mallowPx.ndc.y} — ` +
          'OFF SCREEN. Whatever this frame is a photograph of, it is not the marshmallow.');
      }
    }

    for (const f of fail) console.log(`  !! ${name}: ${f}`);
    if (fail.length) failures.push({ frame: name, fail });

    const out = resolve(DIR, `${name}.png`);
    await page.screenshot({ path: out });
    const st = await roastState();
    frames.push({
      name, hour: await page.evaluate(() => window.__lighting.hour),
      overlay, firstPerson, posed, expect: { t, phase, mallow: expectMallow },
      probe: { ...p, ui: p.ui }, fail, state: st,
    });
    const size = p.mallowPx ? `  mallow=${p.mallowPx.diameter}px @${p.mallowPx.x},${p.mallowPx.y}` : '';
    console.log(`shot: ${out}${st ? `  doneness=${(st.doneness ?? 0).toFixed(2)} ` +
      `even=${(st.evenness ?? 0).toFixed(2)} burning=${!!st.burning}` : ''}${size}`);
  };

  // ── 1. the prop framings ──────────────────────────────────────────────────
  //
  // Camera posed by this harness, `__forceCamera` raised — the ordinary path
  // every other capture tool in this tree takes.
  const propJobs = Object.entries(PROP).filter(([n]) => wanted(n));
  for (const [name, f] of propJobs) {
    const centre = await page.evaluate(async ({ f }) => {
      const THREE = window.__THREE, e = window.__engine;
      const p = window.__camp.props.find((q) => q.item.kind === 'roaststick');
      const item = p.item;
      // Aim at the marshmallow itself when the geometry publishes it. Guessing
      // a height above the prop origin is how the telescope view was 100 mm and
      // 15 degrees wrong before `userData.telescope` existed.
      const centre = new THREE.Vector3();
      const m = p.obj?.userData?.roast?.mallow;
      if (m) { p.obj.updateMatrixWorld(true); centre.copy(m).applyMatrix4(p.obj.matrixWorld); }
      else centre.set(item.x, item.y + f.aim, item.z);
      const a = item.yaw + f.az;
      const pos = new THREE.Vector3(
        item.x + Math.sin(a) * f.dist, item.y + f.elev, item.z + Math.cos(a) * f.dist);
      e.camera.fov = f.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(centre);
      window.__forceCamera = true;
      // Converged settle, not a fixed frame count. A fixed count is what
      // quietly corrupted every contact sheet in review/ — see __settleStable.
      if (window.__settleStable) await window.__settleStable(600, 24);
      // Handed back so `shoot` can assert the same thing here that it asserts
      // of the first-person frames: the marshmallow is IN the picture. Without
      // it these three are the only frames in the sheet nothing checks.
      return { x: centre.x, y: centre.y, z: centre.z, aimed: !!m };
    }, { f });
    await page.waitForTimeout(500);
    await shoot(name, { subject: centre });
  }

  if (wanted('prop-wide')) {
    const wideSubject = await page.evaluate(async ({ f, site }) => {
      const THREE = window.__THREE, e = window.__engine;
      const p = window.__camp.props.find((q) => q.item.kind === 'roaststick').item;
      // Stand off the line fire -> stick, swung round a little. The stick is
      // then on the near side of the camp and cannot be hidden behind the tent
      // by an unlucky layout, which is the whole question this frame asks.
      const bearing = Math.atan2(p.x - site.x, p.z - site.z) + f.swing;
      // Centre the frame between the fire and the stick, so both the camp and
      // the thing you are meant to find in it are in it.
      const cx = (site.x + p.x) / 2, cz = (site.z + p.z) / 2;
      const centre = new THREE.Vector3(cx, site.y + f.aim, cz);
      const pos = new THREE.Vector3(
        cx + Math.sin(bearing) * f.dist, site.y + f.elev, cz + Math.cos(bearing) * f.dist);
      e.camera.fov = f.fov;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(centre);
      window.__forceCamera = true;
      if (window.__settleStable) await window.__settleStable(600, 24);
      const q = window.__camp.props.find((r) => r.item.kind === 'roaststick');
      const mm = q?.obj?.userData?.roast?.mallow;
      const sub = new THREE.Vector3(p.x, p.y + 0.42, p.z);
      if (mm) { q.obj.updateMatrixWorld(true); sub.copy(mm).applyMatrix4(q.obj.matrixWorld); }
      return { x: sub.x, y: sub.y, z: sub.z };
    }, { f: WIDE, site });
    await page.waitForTimeout(500);
    await shoot('prop-wide', { subject: wideSubject });
  }

  // ── 2. into the view ──────────────────────────────────────────────────────
  //
  // READ THIS BEFORE CHANGING ANYTHING BELOW.
  //
  // Every other framing in this repo, and every other capture tool in tools/,
  // poses the camera itself and raises `window.__forceCamera` to tell the rig
  // to let go. **These frames are the exact opposite.** The view owns the
  // camera: it takes it through `CameraRig.takeCamera()` and raises
  // `__forceCamera` itself, exactly as `camp_scope_view.js` does. So the
  // harness must NOT touch `camera.position`, `camera.fov` or `lookAt` from
  // here on — the composition of the money shot IS the thing under judgement,
  // and a harness that "helpfully" framed it would be photographing its own
  // taste instead of the view's.
  //
  // `__forceCamera` is lowered first so the view raises it from the same state
  // a player's would (it saves and restores the previous value), and so what
  // this tool photographs is what ships rather than a hybrid.
  //
  // The takeover outranks `__forceCamera` inside `CameraRig.lateUpdate` — the
  // order of those two checks is load-bearing and its comment there says why —
  // so the view drives the camera either way; this is about matching state, not
  // about making it work.
  const wantHeld = ['held-enter', 'held', 'held-clean', 'uneven', 'burning',
                    'dusk-held', 'dusk-held-clean', 'mallow-backlit', 'mallow-uneven',
                    'mallow-burning',
                    ...LADDER.map(([n]) => n), ...MALLOW.map(([n]) => n)].some(wanted)
                    || has('strip');
  if (!wantHeld) {
    console.log('no first-person frames requested; skipping the view entirely');
  } else {
    await page.evaluate(() => { window.__forceCamera = false; });
    const entered = await page.evaluate(() => {
      const r = window.__roast;
      try { r.enter(); } catch (e) { /* fall through to the two-argument form */ }
      if (r.state?.().active) return 'enter()';
      // Fallback: the contract's own RoastView signature is enter(prop, camp).
      const camp = window.__camp.camps?.[window.__camp.camps.length - 1] ?? null;
      const p = window.__camp.props.find((q) => q.item.kind === 'roaststick');
      try { r.enter(p?.obj ?? p, camp); } catch (e) { return `threw: ${e}`; }
      return r.state?.().active ? 'enter(prop, camp)' : 'inactive';
    });
    if (entered === 'inactive' || String(entered).startsWith('threw')) {
      await bail(3,
        `roastshot: __roast.enter() did not activate the view (${entered}).\n` +
        '  The debug entry point has to bypass the parked/focus gate that\n' +
        '  Camp._interact applies — the harness IS parked and braked at this camp,\n' +
        '  so if that gate is what refused, say so in camp_roast_view.js rather\n' +
        '  than expecting the harness to synthesise a click.');
    }
    console.log(`entered the view via ${entered}`);

    // Let the HUD notice. `HUD.js` fades itself out off `window.__forceCamera`
    // with a 0.45 s CSS transition, and that fade only runs while the engine is
    // running — so a harness that entered the view and froze on the same tick
    // would photograph a half-faded speedometer and would be right to fail its
    // own assertion. The wait is here, once, rather than in every block.
    await page.waitForTimeout(900);
    await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(600, 24); });

    // held-enter: put the step-in at exactly 0.40 and stop the world there.
    //
    // Round 1 polled `state().t` from a rAF and froze on the first sample at or
    // past 0.4. It always caught 1.0, and it printed `!!` about it, and the `!!`
    // scrolled away. The reason is in the view, documented, and is not a defect:
    // `__roast.enter()` deliberately snaps `V.t = 1` ("The harness wants the
    // composed frame, not the walk to it — `held-enter` is captured by setting
    // `t` by hand instead") and publishes `setT(k)` for exactly this. Round 1's
    // `held-enter` is therefore a second copy of `held`. Using the hook the view
    // put there is the fix, and it is also deterministic, which polling an eased
    // 0.75 s animation across four thermal states never was.
    //
    // The marshmallow is NOT expected in this frame: the view hides the held
    // stick until `t > 0.52` so the pick-up happens off camera. That exemption
    // is passed in explicitly and recorded beside the frame rather than being a
    // silence — a reader can disagree with it, which is the point.
    const ENTER_T = 0.40;
    if (wanted('held-enter')) {
      await reseat('held-enter');
      // Freeze FIRST, then wind `t` back. The other order loses: between the
      // `setT` and the `stop()` the engine runs the eased step-in on for a few
      // milliseconds of wall clock, and `t` is 0.4-something-that-depends-on-
      // the-machine by the time the shutter goes.
      await freeze();
      const st = await page.evaluate((t) => {
        const R = window.__roast;
        if (typeof R.setT !== 'function') return { missing: 'setT' };
        R.setT(t); R.step(0);
        window.__roastDraw?.();
        return R.state();
      }, ENTER_T);
      if (st?.missing) {
        console.log('  !! __roast.setT() is missing, so held-enter cannot be put at a known ' +
                    'point in the step-in. It is owed by camp_roast_view.js — enter() snaps ' +
                    't to 1 by design, so setT is the ONLY way to reach the transition.');
      }
      await draw();
      console.log(`held-enter at t=${(st?.t ?? -1).toFixed(2)} (asked ${ENTER_T}), ` +
                  `phase=${st?.phase}`);
      await shoot('held-enter', {
        overlay: true, firstPerson: true, t: ENTER_T, phase: 'in', expectMallow: false });
      await thaw();
    }

    // The money shot. Re-entered rather than continued, so it does not inherit
    // whatever `held-enter` left behind, and the composition is judged from a
    // marshmallow the player would actually be holding at that moment.
    await reseat('held');
    await page.waitForFunction(() => (window.__roast.state?.().t ?? 1) >= 0.999,
      null, { timeout: 15000 }).catch(() => {
        console.log('  !! the step-in never reached t = 1 within 15 s');
      });
    await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(600, 24); });
    await page.waitForTimeout(500);

    if (wanted('held')) {
      overlayMode = await setOverlay(true);
      await shoot('held', { overlay: true, firstPerson: true });
      const mode = await setOverlay(false);
      if (mode === 'nothing-found') {
        console.log('  !! no overlay element found to suppress: neither __roast.setOverlay() nor ' +
                    'any element classed `pa-roast*`. `held-clean` is the same frame as `held`.');
      }
      await page.waitForTimeout(200);
      await shoot('held-clean', { firstPerson: true });
      await setOverlay(true);
    }

    // ── 3. the ladder ──────────────────────────────────────────────────────
    //
    // One page load, one camp, one marshmallow, six doneness levels, one
    // camera, one frozen instant of the fire. The engine is stopped for the
    // whole of it: the camera cannot drift, the embers cannot move, and the six
    // frames differ by the toast map and by nothing else. That is what makes an
    // `ab.mjs --stitch` pair across two rounds a statement about the ramp.
    if (LADDER.some(([n]) => wanted(n))) {
      await setOverlay(false);
      await reseat('ladder');
      if (PIN) pin = await pinWorld();
      await freeze();
      let last = -1, monotone = true;
      for (const [name, k, label] of LADDER) {
        if (!wanted(name)) continue;
        // setDoneness then a zero-length step: the step is the view's chance to
        // push uSag/uSwell/uGlow for the new state without advancing anything.
        await page.evaluate((k) => { window.__roast.setDoneness(k); window.__roast.step(0); }, k);
        await draw();
        await page.waitForTimeout(120);
        const st = await roastState();
        const d = st?.doneness ?? -1;
        if (d <= last) monotone = false;
        last = d;
        console.log(`  ladder ${label}: asked ${k.toFixed(2)}, state reports ${d.toFixed(3)}`);
        await shoot(name, { firstPerson: true });
      }
      if (!monotone) {
        console.log('  !! doneness did not increase across the ladder. Either setDoneness() is ' +
                    'not writing the map, or state().doneness is not reading it — and either way ' +
                    'these six frames are not six different marshmallows. Do not grade them.');
      }
      await thaw();
      await page.waitForTimeout(300);
    }

    // ── 3b. the macro — mallow-0..5, uneven, burning, backlit ───────────────
    //
    // READ THE BLOCK ABOVE "into the view" FIRST, THEN THIS ONE.
    //
    // Twenty lines up this file says a harness that poses the camera for a
    // `held` frame is photographing its own taste. Here it poses the camera on
    // purpose, and the difference is not a compromise — it is the difference
    // between two questions:
    //
    //   `held` asks "would this be the store page's hero image?". The answer is
    //   a property of the COMPOSITION: where the view chose to put the stick,
    //   how much of the fire it hides, what the fov is. Only the view can
    //   answer that, so only the view may frame it.
    //
    //   `mallow-*` asks "does raw sugar read as sugar and char read as char?".
    //   That is a property of the OBJECT, and it is the same answer from any
    //   camera. It is a studio shot: put the thing on a table, get close, light
    //   it, and look. Framing it from the player's eye is not neutrality, it is
    //   an instrument that cannot resolve the thing it is pointed at — round
    //   1's ladder rungs differ from one another across at most 69x59 pixels,
    //   0.18% of the frame, and that was the entire evidence base for blisters,
    //   char cracks, translucency and the shape of the ramp.
    //
    // Two mechanical notes, both load-bearing:
    //
    //   · **the subject is parented to the camera.** Contract section 3: "The
    //     stick is parented to the camera, not to the world." So moving the
    //     camera moves the marshmallow with it and the macro chases its own
    //     tail forever at the same 40 px. The held group is therefore attached
    //     to the SCENE for the duration of each shot — `Object3D.attach`, which
    //     preserves the world transform, so what is photographed is exactly the
    //     pose the view composed — and put back afterwards. It is reached by
    //     `camera.getObjectByName('camp_roast_held')`, the only public handle
    //     the view offers; a supported detach/attach pair is on the ask list in
    //     this file's header.
    //
    //   · **the near plane.** `Engine.js` builds the camera at `near = 0.25`.
    //     The ideal distance for a 42 mm object to fill half a frame is about
    //     0.20 m, which is inside it, and a marshmallow sliced open by the near
    //     plane looks exactly like a geometry bug in somebody else's file. So
    //     the distance is clamped to `MACRO_DIST` and the fov is solved from it.
    const wantMallow = [...MALLOW.map(([n]) => n),
                        'mallow-uneven', 'mallow-burning', 'mallow-backlit'].some(wanted);
    if (wantMallow) {
      await setOverlay(false);

      // The campfire's world position, taken while the marshmallow is NOT
      // alight. `state().fire` switches to the marshmallow's own flame the
      // moment it catches (camp_roast_view.js `_stepToast`: `if (this.alight)
      // { this.mallow.getWorldPosition(f.pos); f.top = 0 }`), which is correct
      // for the toast sim and useless for aiming a camera at the campfire. So
      // it is read once, here, and cached — reading it inside `mallow-burning`
      // would frame the fire behind the marshmallow at the marshmallow.
      await reseat('macro');
      if (PIN) pin = await pinWorld();
      await freeze();

      const fireW = await page.evaluate(() => {
        const s = window.__roast.state();
        return { x: s.fire.x, y: s.fire.y + (s.fire.top ?? 0), z: s.fire.z, alight: !!s.alight };
      });
      if (fireW.alight) {
        console.log('  !! the campfire position was read while the marshmallow was alight, so ' +
                    'it is the MARSHMALLOW\'s position. The backlit solve below is meaningless.');
      }

      /**
       * Detach the held stick from the camera, pose the camera, draw.
       *
       * `solve` picks the pose. Pose A is fixed and three-quarter front. Pose B
       * sweeps and is chosen by projecting the fire through every candidate and
       * taking the one that lands nearest the target NDC point — a measurement,
       * not an angle somebody liked, and one that re-solves itself when the
       * view's author moves the stick (which is happening this round).
       */
      const macroPose = (mode, fill) => page.evaluate(({ mode, fire, dist, fill, az, elev,
                                                  target, azBand, elevBand, bias }) => {
        const THREE = window.__THREE, e = window.__engine, cam = e.camera;
        const R = window.__roast;
        const held = cam.getObjectByName('camp_roast_held');
        if (!held) return { error: 'no object named camp_roast_held under the camera — the ' +
          'view either renamed the held group or is not parenting it to the camera' };
        cam.updateMatrixWorld(true);
        e.scene.attach(held);          // world transform preserved; put back by the caller

        const st = R.state();
        const M = new THREE.Vector3(st.mallow.x, st.mallow.y, st.mallow.z);
        const E = new THREE.Vector3(st.eye.x, st.eye.y, st.eye.z);
        const F = new THREE.Vector3(fire.x, fire.y, fire.z);

        // The subject's world radius, from the mesh's own bounding sphere so it
        // follows the swell rather than trusting a constant.
        const mesh = R.view?.mallow ?? null;
        let radius = 0.021, rSource = 'contract-default';
        if (mesh) {
          mesh.updateWorldMatrix(true, false);
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          const s = new THREE.Vector3();
          mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
          radius = mesh.geometry.boundingSphere.radius * Math.max(s.x, s.y, s.z);
          rSource = 'mesh-bounding-sphere';
        }
        // Solve the fov from the clamped distance, not the other way round.
        const wantH = (radius * 2) / fill;                 // frame height at the subject
        const fov = 2 * Math.atan((wantH / 2) / dist) * 180 / Math.PI;

        // ── the frame the pose is struck in ───────────────────────────────
        //
        // Around the STICK's axis, not around the player's bearing, and the
        // first shakedown run is the argument: the stick comes in from the
        // lower right and the marshmallow sits at its tip, so the player is
        // looking very nearly ALONG it. Swinging 38 degrees off the player's
        // line therefore lands 38 degrees off axial — a photograph down the
        // barrel at the end cap with the stick pointing at the lens, which is
        // the one angle a marshmallow has no profile from. `mallow-2.png` in
        // `shots/roast/r2-probe` is that frame, and it is why this is bearings
        // off a measured axis rather than a number that sounded like 45.
        //
        // The axis is grip -> marshmallow, both in world space, which needs no
        // knowledge of which local axis the geometry author lathed along.
        const grip = held.getWorldPosition(new THREE.Vector3());
        const axis = M.clone().sub(grip);
        const axisLen = axis.length();
        axis.normalize();
        const UP = new THREE.Vector3(0, 1, 0);
        // `side` is horizontal and square to the stick — the pure profile. Its
        // sign is chosen so the camera sits on the PLAYER's side of the stick,
        // so what is photographed is the face the player is looking at.
        const side = new THREE.Vector3().crossVectors(UP, axis).normalize();
        if (side.dot(E.clone().sub(M)) < 0) side.negate();
        // `front` points back down the stick toward the grip: the marshmallow's
        // near end cap. A three-quarter is `side` rotated `az` toward `front`.
        const front = axis.clone().negate();

        const place = (a, el) => {
          const dir = side.clone().multiplyScalar(Math.cos(a))
            .addScaledVector(front, Math.sin(a));
          dir.normalize().multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el));
          dir.normalize();
          cam.fov = fov;
          cam.position.copy(M).addScaledVector(dir, dist);
          cam.up.set(0, 1, 0);
          cam.lookAt(M);
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld(true);
          return F.clone().project(cam);
        };

        let useAz = az, useEl = elev, best = null;
        if (mode === 'backlit') {
          let bestD = Infinity;
          for (let a = azBand[0]; a <= azBand[1] + 1e-6; a += azBand[2]) {
            for (let el = elevBand[0]; el <= elevBand[1] + 1e-6; el += elevBand[2]) {
              const n = place(a, el);
              if (n.z >= 1) continue;                    // behind the camera
              const d = Math.hypot(n.x - target[0], n.y - target[1]) + bias * Math.abs(a);
              if (d < bestD) { bestD = d; useAz = a; useEl = el; best = { ...n, d }; }
            }
          }
          if (!best) return { error: 'the fire never projected in front of the camera from any ' +
            'candidate macro pose — it may be behind the marshmallow relative to the seat' };
        }
        const ndc = place(useAz, useEl);
        window.__forceCamera = true;
        window.__roastDraw?.();
        return {
          mode, fov: +fov.toFixed(2), dist, radius: +radius.toFixed(4), rSource,
          stickLen: +axisLen.toFixed(3),
          az: +useAz.toFixed(3), elev: +useEl.toFixed(3),
          fireNDC: { x: +ndc.x.toFixed(3), y: +ndc.y.toFixed(3), z: +ndc.z.toFixed(3) },
          fireInFrame: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z < 1,
          solveErr: best ? +best.d.toFixed(3) : null,
        };
      }, { mode, fire: fireW, dist: MACRO_DIST, fill,
           az: MACRO_AZ, elev: MACRO_ELEV, target: MACRO_BACK_TARGET,
           azBand: MACRO_BACK_AZ, elevBand: MACRO_BACK_ELEV, bias: MACRO_BACK_BIAS });

      /** Put the stick back on the camera and the camera back where the view had it. */
      const macroRestore = () => page.evaluate(() => {
        const e = window.__engine, cam = e.camera;
        const held = e.scene.getObjectByName('camp_roast_held');
        if (held) cam.attach(held);
        // `step(0)` is what actually repairs it: `_drive` rewrites the held
        // group's local position and quaternion from the camera every frame, so
        // one zero-length step puts the composition back exactly.
        window.__roast.step(0);
      });

      const macroShot = async (name, poseMode, prep) => {
        if (!wanted(name)) return;
        await macroRestore();
        if (prep) await prep();
        const pose = await macroPose(poseMode, MACRO_FILL_BY[name] ?? MACRO_FILL);
        if (pose?.error) {
          console.log(`  !! ${name}: ${pose.error}`);
          macroPoses[name] = pose;
          await macroRestore();
          return;
        }
        macroPoses[name] = pose;
        await page.waitForTimeout(80);
        console.log(`  macro ${name}: fill=${MACRO_FILL_BY[name] ?? MACRO_FILL} ` +
                    `fov=${pose.fov} d=${pose.dist} r=${pose.radius} ` +
                    `(${pose.rSource}) az=${pose.az} elev=${pose.elev} ` +
                    `fire@ndc ${pose.fireNDC.x},${pose.fireNDC.y} ` +
                    `${pose.fireInFrame ? 'IN FRAME' : 'out of frame'}`);
        // `posed: true` turns off the camera-matches-the-view's-eye assertion
        // and only that one. Everything else still applies, including — and
        // especially — that the marshmallow projects inside the frame, which is
        // what proves the pose solved rather than merely ran.
        await shoot(name, { firstPerson: true, posed: true });
        await macroRestore();
      };

      // The six rungs. Same pose for all six, so they differ by the toast alone
      // exactly as the ladder does, and the pose is chosen once outside the loop
      // — re-solving per rung would let the swell move the camera and the six
      // would be six different framings of six different marshmallows.
      for (const [name, k, label] of MALLOW) {
        await macroShot(name, 'front', async () => {
          await page.evaluate((k) => { window.__roast.setDoneness(k); window.__roast.step(0); }, k);
          const st = await roastState();
          console.log(`  macro ${label}: asked ${k.toFixed(2)}, state reports ` +
                      `${(st?.doneness ?? -1).toFixed(3)}`);
        });
      }

      // The two states the ramp cannot reach, in the same pose, so a critic can
      // put them beside the six rungs and see whether the sim's own output lands
      // anywhere on the ramp the ladder draws.
      await macroShot('mallow-uneven', 'front', async () => {
        await macroRestore();
        await reseat('mallow-uneven', { spin: 0, height: 0.14 });
        await freeze();
        const r = await stepUntil('onesided', 150);
        console.log(`  mallow-uneven: ${r.sim}s of sim, stopped on "${r.why}", ` +
          `doneness=${(r.state?.doneness ?? 0).toFixed(2)} ` +
          `even=${(r.state?.evenness ?? 1).toFixed(2)} peak=${(r.state?.peak ?? 0).toFixed(2)}`);
        if ((r.state?.evenness ?? 1) > UNEVEN_EVEN) {
          console.log('  !! evenness is still above 0.6 after toasting one side with no spin at ' +
            'all. This is NOT the one-sided failure it is named for — the toast map is not ' +
            'reading the direction the heat comes from.');
        }
      });

      await macroShot('mallow-burning', 'front', async () => {
        await macroRestore();
        await reseat('mallow-burning', { spin: 0, height: BURN_H });
        await freeze();
        await page.evaluate(() => { window.__roast.setDoneness(0.62); window.__roast.ignite(); });
        await step(BURN_SETTLE);
        const st = await roastState();
        console.log(`  mallow-burning: ${BURN_SETTLE}s of sim, alight=${!!st?.alight} ` +
          `burning=${!!st?.burning} slip=${(st?.slip ?? 0).toFixed(2)} ` +
          `doneness=${(st?.doneness ?? 0).toFixed(2)}`);
        if (!st?.alight) {
          console.log('  !! ignite() ran and state().alight is false. This frame is a photograph ' +
                      'of a marshmallow that is not on fire; do not grade the flame from it.');
        }
      });

      // The translucency test. Solved, not guessed — see `macroPose`.
      await macroShot('mallow-backlit', 'backlit', async () => {
        await macroRestore();
        await reseat('mallow-backlit');
        if (PIN) pin = await pinWorld();
        await freeze();
        await page.evaluate(() => { window.__roast.setDoneness(0.42); window.__roast.step(0); });
      });
      const bl = macroPoses['mallow-backlit'];
      if (bl && !bl.error && !bl.fireInFrame) {
        console.log('  !! mallow-backlit could not get the fire into the frame behind the ' +
          `marshmallow: the best pose leaves it at NDC ${bl.fireNDC.x},${bl.fireNDC.y}. ` +
          'Either the marshmallow is held much further from the flame than the contract\'s ' +
          '0.10-0.55 m band, or the macro distance is too short to hold both. Nothing in ' +
          'this frame can be graded for back-scatter.');
      }

      await macroRestore();
      await thaw();
      await page.waitForTimeout(300);
    }

    // ── 4. uneven ──────────────────────────────────────────────────────────
    //
    // Produced by the sim, never by painting the map. The failure this whole
    // mechanic is about is that heat arrives from ONE DIRECTION, so the only
    // honest way to photograph it is to hold the stick still over the flame and
    // let the toast map do what it does. A painted frame would prove that the
    // painting worked.
    //
    // Then assert it. A frame called `uneven` that a critic grades as the
    // one-sided failure, taken of a marshmallow that is actually evenly
    // toasted, is exactly the shape of every entry in CRITIC_PROTOCOL's table:
    // a clean result attached to the wrong object.
    // The stop condition is `onesided`, not `toasted`. Round 1 stepped until
    // MEAN doneness reached 0.45 with the stick held still, and that is not
    // reachable one-sided: the mean is over the whole surface, so the hot face
    // has to go to about 0.9 to drag it there, which means the hot face
    // ignites. It took 49.7 s of sim, ended `burning` with `slip` at 0.298, and
    // handed the next block an alight, half-melted marshmallow. The frame's job
    // is to show heat arriving from one direction, so the condition is
    // evenness — the number that says exactly that.
    if (wanted('uneven')) {
      await setOverlay(false);
      await reseat('uneven', { spin: 0, height: 0.14 });  // held still, low: this IS the failure
      if (PIN) pin = await pinWorld();
      await freeze();
      const r = await stepUntil('onesided', 150);
      console.log(`uneven: ${r.sim}s of sim, stopped on "${r.why}", ` +
                  `doneness=${(r.state?.doneness ?? 0).toFixed(2)} ` +
                  `evenness=${(r.state?.evenness ?? 1).toFixed(2)} ` +
                  `peak=${(r.state?.peak ?? 0).toFixed(2)} slip=${(r.state?.slip ?? 0).toFixed(2)}`);
      if (r.why === 'timeout') {
        console.log(`  !! 150 s of sim over the flame never reached doneness ${UNEVEN_DONE} with ` +
                    `evenness under ${UNEVEN_EVEN}. Either the toast sim is not integrating heat, ` +
                    'or step(dt) is not driving it, or the heat is not directional.');
      }
      if (r.why === 'alight') {
        console.log('  !! the marshmallow caught fire before it was one-sided. The hot face ' +
                    'passes ignition sooner than the mean reaches ' + UNEVEN_DONE + ', so there ' +
                    'is no reachable state that is "toasted on one side" and not alight.');
      }
      if (r.why === 'slip' || r.why === 'view-left') {
        console.log(`  !! stopped because the marshmallow was sliding off the stick (${r.why}). ` +
                    'This frame is of a melting marshmallow, not a one-sided one.');
      }
      if ((r.state?.evenness ?? 1) > UNEVEN_EVEN) {
        console.log(`  !! evenness is ${(r.state?.evenness ?? 1).toFixed(2)} after toasting one ` +
                    'side with no spin at all. This frame is NOT the one-sided failure it is ' +
                    'named for — the toast map is not reading the direction the heat comes from.');
      }
      await shoot('uneven', { firstPerson: true });
      await thaw();
      await page.waitForTimeout(300);
    }

    // ── 5. burning — see BURN_H / BURN_SETTLE ───────────────────────────────
    if (wanted('burning')) {
      await setOverlay(false);
      await reseat('burning', { spin: 0, height: BURN_H });
      if (PIN) pin = await pinWorld();
      await freeze();
      await page.evaluate(() => { window.__roast.setDoneness(0.62); window.__roast.ignite(); });
      await step(BURN_SETTLE);
      const st = await roastState();
      if (!st?.alight) {
        console.log('  !! ignite() ran and state().alight is false. This frame is a photograph ' +
                    'of a marshmallow that is not on fire; do not grade the flame from it.');
      }
      console.log(`burning: ${BURN_SETTLE}s of sim, alight=${!!st?.alight} ` +
                  `burning=${!!st?.burning} slip=${(st?.slip ?? 0).toFixed(2)} ` +
                  `ruined=${(st?.ruined ?? 0).toFixed(2)}`);
      await shoot('burning', { firstPerson: true });
      await thaw();
      await page.waitForTimeout(300);
    }

    // ── 5b. --strip: the twirl, as a strip ─────────────────────────────────
    //
    // `docs/ROAST_CRITIC_ROUND.md` element 5: "a still cannot judge motion …
    // capture a stepped sequence through window.__roast.step(dt) and read it as
    // a strip." Opt-in, because it is eight more frames and it answers a
    // different question from the rest of the sheet.
    //
    // The marshmallow is toasted ON ONE SIDE first and then rolled. A strip of
    // an evenly toasted marshmallow rotating is a strip of nothing happening —
    // and rolling a one-sided one is also the only frame in this tool that can
    // catch the toast map being anchored to the VIEW rather than to the
    // surface, which would look perfectly correct in every other frame here.
    //
    // Round 1's eight strip frames were byte-identical — one md5 across all
    // eight — and were aerials of the camp rather than of the view. They were
    // not eight copies of a bad frame by coincidence: the block inherited an
    // alight, half-slipped marshmallow from `burning`, ran ninety more seconds
    // of sim, dropped it in the fire, and the view stepped back. `setSpin` then
    // rolled a stick that was no longer in the scene, eight times, with the
    // engine frozen, so of course nothing moved. Every part of that is fixed by
    // the reseat above and asserted by `firstPerson` below — but the identical
    // md5s are worth keeping in mind as a symptom: a strip whose frames do not
    // differ is a strip of something that is not being rotated.
    if (has('strip')) {
      const N = 8;
      await setOverlay(false);
      await reseat('strip', { spin: 0, height: 0.14 });
      if (PIN) pin = await pinWorld();
      await freeze();
      const r = await stepUntil('onesided', 150);
      console.log(`strip: one side toasted in ${r.sim}s, stopped on "${r.why}", ` +
                  `evenness=${(r.state?.evenness ?? 1).toFixed(2)} ` +
                  `slip=${(r.state?.slip ?? 0).toFixed(2)}`);
      for (let i = 0; i < N; i++) {
        // Roll only. No sim time passes between rungs, so the strip is the
        // twirl and is not also eight more seconds of toasting.
        await page.evaluate((rad) => { window.__roast.setSpin(rad); window.__roast.step(0); },
          (i / N) * Math.PI * 2);
        await draw();
        await page.waitForTimeout(100);
        await shoot(`strip-${i}`, { firstPerson: true });
      }
      await thaw();
      await page.waitForTimeout(300);
    }

    // ── 6. dusk ────────────────────────────────────────────────────────────
    //
    // The frame this feature lives or dies on. Reset to a hittable marshmallow
    // first: the point of the frame is the fire's light through and around the
    // sugar, and a black one has nothing to light. 0.55 is the bottom of the
    // `perfect` band in RESULTS — what a player who did it right is holding.
    //
    // Shot even when `--hour` already put the whole sheet at dusk, so the
    // filename set is identical for every invocation and ab.mjs pairs two
    // rounds completely rather than dropping the frames one of them lacks.
    //
    // Reseated BEFORE the hour change and settled AFTER it, in that order and
    // for two different reasons. The reseat is because this is the last block
    // in the run and it inherits whatever the blocks above left behind — round
    // 1's dusk frames are chase-camera aerials with the speedometer, the
    // compass and the minimap in them, taken of a view that had dropped the
    // marshmallow and stepped back forty seconds earlier, and its UI audit
    // passed them clean. The settle is because the lighting ramp eases and a
    // dusk frame captured mid-ramp is at neither hour.
    if (wanted('dusk-held')) {
      await reseat('dusk-held');
      await page.evaluate(({ dusk }) => {
        window.__roast.setDoneness(0.55);
        window.__roast.step(0);
        window.__lighting.hour = dusk;
        window.__lighting.cycleSpeed = 0;
      }, { dusk: DUSK_HOUR });
      await page.evaluate(async () => { if (window.__settleStable) await window.__settleStable(900, 30); });
      await page.waitForTimeout(900);       // the lighting ramp eases
      // ── re-solve the hold, because the HOUR moved after the reseat ────────
      //
      // `camp_roast_view.js` solves where the hand holds the marshmallow once
      // per seat, on entry, against a measurement of what is actually behind it
      // — and what is behind it is a function of the light. This block reseats
      // at the sheet's default hour and THEN winds the clock to dusk, so
      // without this the dusk frames are shot with a hold chosen under midday
      // sun. A player who sits down at dusk solves at dusk; this is the tool
      // matching them. Optional-chained so a build without the hook still runs.
      await page.evaluate(() => { window.__roast.solveHold?.(); window.__roast.step?.(0); });
      await setOverlay(true);
      await shoot('dusk-held', { overlay: true, firstPerson: true });
      await setOverlay(false);
      await page.waitForTimeout(200);
      await shoot('dusk-held-clean', { firstPerson: true });
      await setOverlay(true);
    }

    // Leave the way a player leaves. Not cosmetic: `leave()` restores
    // `__forceCamera` and hands the camera back to the rig, and a view left
    // open would take the stats/health checks with it.
    await page.evaluate(() => { try { window.__roast.leave(); } catch { /* going away anyway */ } });
    await page.waitForTimeout(600);
  }

  // ── the round's provenance ────────────────────────────────────────────────
  //
  // A critic looking at two directories of PNGs a week apart has no other way
  // to tell which camp, which hour, which commit and which toast state each one
  // was. Written beside the frames, not into them.
  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    calls: window.__engine?.renderer?.info?.render?.calls ?? null,
    tris: window.__engine?.renderer?.info?.render?.triangles ?? null,
    quality: window.__engine?.quality ?? null,
    resScale: window.__engine?.resolutionScale ?? null,
  }));
  writeFileSync(resolve(DIR, 'ROAST.json'), JSON.stringify({
    tool: 'roastshot.mjs',
    when: new Date().toISOString(),
    git: { head: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
           dirty: (git(['status', '--porcelain']) ?? '') !== '' },
    // Diff this between two rounds BEFORE attributing a difference to the
    // harness. See the comment on `sources()`.
    sources: srcAtLoad,
    sourcesAtEnd: sources(),
    url: URL, viewport: { w: W, h: H }, res: RES, car: CAR, park: PARK, parkAt, seed: SEED,
    hour: HOUR, duskHour: DUSK_HOUR,
    ladder: { spin: LADDER_SPIN, height: LADDER_HEIGHT, dt: DT, rungs: LADDER },
    macro: {
      fill: MACRO_FILL, fillBy: MACRO_FILL_BY, dist: MACRO_DIST,
      az: MACRO_AZ, elev: MACRO_ELEV,
      backTarget: MACRO_BACK_TARGET, backBias: MACRO_BACK_BIAS,
      uneven: { doneness: UNEVEN_DONE, evenness: UNEVEN_EVEN }, slipStop: SLIP_STOP,
      burn: { height: BURN_H, settle: BURN_SETTLE },
      rungs: MALLOW, poses: macroPoses,
    },
    // What was pinned this run and what could not be. See the determinism block
    // in this file's header for the residual, which is named rather than waved
    // at: the XY of ~20 sparks and ~30 smoke puffs, and any wildlife in shot.
    pin: PIN ? (pin ?? { asked: true, note: 'no frozen block ran, so nothing was pinned' })
             : { asked: false, note: '--nopin: the fire clock, the log-settle flare and the ' +
                 'particle buffers are all free-running in this round' },
    pinConstants: { t: PIN_T, steps: PIN_STEPS, dt: DT },
    overlayMode,
    surface,
    brake: held,
    camp: { x: site.x, y: site.y, z: site.z, radius: site.radius, props: site.props },
    stick,
    stats,
    failures,
    frames,
    pageErrors: errors.slice(0, 16),
  }, null, 1));

  console.log('stats:', JSON.stringify(stats));
  // Printed unconditionally, and checked: a plate taken at two thirds
  // resolution or a tier down is not comparable with one taken at full, and
  // nothing else in this output would say so.
  if (stats.quality !== 'ultra' || Math.abs((stats.resScale ?? 1) - 1) > 1e-3) {
    console.error(`[roastshot] !! captured at quality=${stats.quality} resScale=${stats.resScale} — ` +
                  'NOT comparable with a baseline taken at ultra / 1.0');
  }
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));

  // The last thing printed, because it is the first thing to read. A `!!` two
  // hundred lines up the log is a `!!` nobody sees, and a contact sheet that
  // silently contains a frame of the wrong thing is the failure this whole
  // round exists to fix.
  console.log(`\n${frames.length} frames + ROAST.json in ${resolve(DIR)}`);
  if (failures.length) {
    console.log(`\n!! ${failures.length} of ${frames.length} frames FAILED their assertions:`);
    for (const f of failures) for (const line of f.fail) console.log(`   ${f.frame}: ${line}`);
    console.log('   None of those frames is evidence about this feature. Full detail is in ' +
                'ROAST.json under "failures".');
  } else {
    const fp = frames.filter((f) => f.firstPerson).length;
    console.log(`all ${frames.length} frames passed their assertions ` +
      `(${fp} first-person: view active, t as asked, __forceCamera raised, camera where the ` +
      `view put it; all ${frames.length}: no UI in frame, subject projecting inside the frame).`);
  }
  const macroPx = frames.filter((f) => f.name.startsWith('mallow-') && f.probe?.mallowPx)
    .map((f) => f.probe.mallowPx.diameter);
  const heldPx = frames.filter((f) => f.name.startsWith('ladder-') && f.probe?.mallowPx)
    .map((f) => f.probe.mallowPx.diameter);
  if (heldPx.length || macroPx.length) {
    const avg = (a) => (a.length ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(0) : '-');
    console.log(`subject size: ladder ${avg(heldPx)} px across, macro ${avg(macroPx)} px across ` +
                `of ${H} px of frame height.`);
  }
  console.log(`next: node tools/sheet.mjs --dir ${DIR} --cols 5 --cell 460`);

  await browser.close();
  release();
}

main().catch((e) => { console.error(e); process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────
//  CampAudio — the fire.
//
//  A camp fire is two sounds and they are almost unrelated. There is a **bed**,
//  which is the roar: a broad low hiss of hot gas that barely changes, and
//  which you stop hearing after about ten seconds. And there are the
//  **crackles**, which are sharp, brief, unpredictable, and are the entire
//  reason a fire is nice to sit next to.
//
//  Almost every synthesised fire gets this backwards and leans on the bed,
//  because the bed is easy — one noise source and a filter — and the result is
//  a hairdryer. The bed here is deliberately quiet and dull; the budget is
//  spent on making the crackles behave, and that means two things:
//
//   1. **Clusters, not a Poisson process.** Real fires pop in bursts: a log
//      shifts, a pocket of sap goes, and three or four snaps arrive inside half
//      a second, then nothing for four seconds. An exponential inter-arrival
//      time produces an even sprinkle that reads as a synthesiser ticking.
//   2. **Every crackle is a different size.** A drawn-from-one-envelope
//      crackle is a rimshot. These span a soft tick, a wooden knock and an
//      occasional loud snap with a short tail on it, and the loud ones are
//      rare enough to be startling in the way a real one is.
//
//  Loudness matters more than usual here. The player's own words about this
//  game's ambience were "very loud. Not calming at all", and a fire is the one
//  sound a player will sit inside for minutes at a time. It is mixed to sit
//  under the wind, not over it.
//
//  **Since the user supplied `public/audio/campfire.mp3`, all of the above is
//  the FALLBACK.** The recording is the fire; the bed and the crackle scheduler
//  are what plays when it cannot be fetched or decoded. Everything the two
//  paragraphs above argue is still why the fallback sounds the way it does, and
//  the recording is measured against it rather than against taste — see the
//  block above `FIRE_URL`.
//
//  This class also *owns* the camp's prop cues (`camp_props.js`) without
//  knowing anything about them beyond where the listener is. They live on this
//  bus rather than on a bus of their own for the same reason the fire does: a
//  tent unfurling is a camp sound, it has to duck with the world's floor, and
//  the `camp` metering tap already exists — a layer nobody can measure is a
//  layer nobody can tune.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, ping, stopLater, panner } from './synth.js';
import { CampProps } from './camp_props.js';

// How far the fire carries. 26 m is generous for a camp fire in still air and
// is chosen from the game rather than from acoustics: the player parks 8–18 m
// away, and the sound has to be there when they arrive rather than switching
// on as they walk in.
const REACH = 26;
const NEAR = 3.0;      // inside this, the fire is at full level

// ── the fire itself: a recording ─────────────────────────────────────────────
//
// `public/audio/campfire.mp3`, a take the user supplied and asked for by name.
// It is the same trade `journal_audio.js` made for the page turn and
// `wildlife_audio.js` made for the frog's dive: **play the recording, keep the
// synthesis as the fallback**, so a 404 or a decode failure costs the fire its
// quality and not its sound. Everything below `_bed` and `_crackle` is still
// live code and still what you hear when this file is missing.
//
// It replaces the WHOLE synthesised fire — the bed *and* the crackle
// scheduler — not just the bed, because a recording of a fire already contains
// both, at a density and a size distribution nobody has to invent. Running the
// scheduler on top would be a second fire in the same pit. `_crackle` stays
// because `roastEvent('eat')` still needs one crackle on demand.
//
// MEASURED off the file (48 kHz stereo, decoded identically by ffmpeg and by
// Chrome's `decodeAudioData` — 53280 frames, so the encoder's gapless tags are
// honoured and there is no padding silence at either end):
//
//   duration    1.1100 s exactly
//   peak        0.1798 (L) / 0.1678 (R); mono 0.1487
//   rms         0.0083 mono, and it never falls silent — the quietest 20 ms
//               window is rms 0.0030, so this is a continuous texture and not
//               a one-shot with a tail
//   L/R corr    0.68 — genuinely stereo, which is why it is fed through the
//               existing `pan` rather than being re-spatialised
//   bands       74% of the energy sits 63–250 Hz (the body), 10% above 8 kHz
//               (the grain). Crest 25 dB, and 16 dB in the low band alone, so
//               the low end is fire and not wind on the microphone — an 80 Hz
//               high-pass costs the whole file only 1.7 dB and was not worth
//               the transients it softens.
//   transients  seven over 0.045 in 1.11 s, the two loudest at **0.080 s
//               (0.1487)** and **1.030 s (0.1406)**
//
// ── 1.11 s is short, and a naive loop ticks ─────────────────────────────────
//
// Two things repeat if this is simply `loop = true`:
//
//  1. **The seam steps.** The last 10 ms is rms 0.0039 and the first 10 ms is
//     0.0078 — 6 dB of jump, once every 1.11 s. Not a click (both ends sit at
//     ~1e-3, so there is no DC step to snap), but an audible pulse at 0.9 Hz.
//  2. **The two loud crackles above become a rhythm** — 0.95 s apart, then
//     0.16 s across the wrap, over and over.
//
// So it is played by TWO voices rather than one, at different playback rates
// and started half a buffer apart. The rates are the whole trick: 1.0 and 0.87
// give loop periods of 1.110 s and 1.276 s, which drift against each other and
// only re-align after ~8.5 s, by which point neither the seam nor the crackle
// figure lands where the ear last heard it. The one seam that does step is 3 dB
// in the sum instead of 6, because only one voice steps at a time.
//
// Detuning also removes the reason two copies of one buffer are normally a bad
// idea: a comb needs a CONSTANT delay between them, and a rate difference makes
// the delay slide continuously, which on a noise-like texture is inaudible.
// 0.87 is about two and a half semitones down — on a fire that reads as a
// slightly bigger fire, not as a pitch artefact.
//
// ── the level ──────────────────────────────────────────────────────────────
//
// FIRE_GAIN is measured, not guessed, and it is measured TWICE because the two
// candidate anchors disagree.
//
// Offline (`tools/_scratch/_firegain.mjs`, one OfflineAudioContext at 48 kHz so
// the bed and the file are on one scale), against the synthesised bed at level
// 1 — its steady state, the loudest it is ever allowed to be:
//
//                      peak      rms      <160Hz   160-2k    >4k
//      synth bed      0.0201   0.00338   0.00214  0.00170  0.00035
//      campfire ×1    0.1798   0.00820   0.00398  0.00329  0.00239
//
//      gain matching the bed:  rms 0.412   low 0.536   mid 0.516   high 0.146
//
// Low and mid agree at ~0.52 and the high band asks for a third of that. The
// high band is not the anchor and the disagreement is the point: this file's
// header calls the synthesised bed "deliberately quiet and dull" because the
// crackles were supposed to carry the top, so matching the recording's grain to
// a bed that has none would throw away exactly what a recording is for.
//
// But the recording stands in for the bed AND the crackles, so the honest
// anchor is the whole synthesised fire measured where the player hears it: the
// `camp` tap in the running game, 8 s a row, three distances, both fires in one
// page load because nothing else is comparable (`tools/_scratch/_firemix.mjs`).
// At the gain below:
//
//      dist   source   level   crackles    peak       rms
//       2.5   synth    1.000       6      0.0172    0.00335
//       2.5   mp3      1.000       0      0.0443    0.00335     rms  0.00 dB
//       8     synth    0.612       7      0.0095    0.00199
//       8     mp3      0.612       0      0.0259    0.00188     rms -0.49 dB
//      16     synth    0.189       3      0.0033    0.00059
//      16     mp3      0.189       0      0.0038    0.00055     rms -0.61 dB
//
// **0.295**, which puts the recording exactly on the synthesised fire's rms at
// the seat and a shade under it further out — the loudness the rest of the mix
// was tuned against, kept. It is below the 0.52 the bed alone asked for
// precisely because the crackles are now inside the file. Two voices are worth
// +1.2 dB over one on their own, and that is in this number.
//
// **The peak is +8 dB and that is the improvement, not an error.** Crest factor
// at the seat: the synthesised fire 14.2 dB, the recording 22.4 dB, a real fire
// 25. This file's header says the crackles "are the entire reason a fire is
// nice to sit next to" and that the bed should be dull — a 22 dB crest at
// unchanged loudness is that intent, finally met by something that did not have
// to be invented. Master peak at 1.6 m from the flames goes 0.0158 → 0.0229,
// which is nowhere near anything (`_firefall.mjs`).
//
// ── and it is checked ───────────────────────────────────────────────────────
//
// `tools/_scratch/_fireloop.mjs` autocorrelates the tap's envelope at the loop
// period, which is the only way to answer "does it tick?" without an ear:
//
//      mode     1.110s   2.220s   3.330s
//      one       0.940    0.936    0.928     ← a single loop. A metronome.
//      two       0.553    0.356    0.232     ← what ships
//      synth     0.457    0.419    0.169     ← no loop at all; the floor
//
// One voice repeats itself perfectly, and goes on doing it at every multiple.
// Two land in the same band as the fire that has no loop in it, and — the part
// that matters — DECAY across the multiples, which a true repeat cannot do.
//
// `tools/_scratch/_firefall.mjs` deletes the asset at the network and measures
// what is left: `_fire` null, no voices, one warning, and a fire on the tap at
// rms 0.00338 with six crackles in nine seconds. A missing file costs the fire
// its grain and nothing else.
const FIRE_URL = '/audio/campfire.mp3';
const FIRE_GAIN = 0.295;
/** Playback rates for the two voices. See the seam block above. */
const FIRE_RATES = [1.0, 0.87];
/** Where in the buffer each voice starts, as a fraction of it. */
const FIRE_OFFSETS = [0.0, 0.5];
/** The distance ceiling, near → far. A far fire loses its top before it loses
 *  its body, which is most of what places one across a meadow — the same job
 *  the synthesised bed's band-pass sweep does, and the reason the crackles no
 *  longer having a distance-thinned rate costs less than it looks. */
const FIRE_LP_NEAR = 7500;
const FIRE_LP_FAR = 900;

// ── the sizzle ───────────────────────────────────────────────────────────────
//
// The one new sound the roasting feature adds, and the argument for it being
// the only one is the same argument this file's header makes about the bed: a
// marshmallow over a fire is mostly the fire, and everything else the mechanic
// needs — the fwoomp when one catches, the crackle when one is eaten — is a
// voice this camp already has (see `roastEvent`).
//
// What it is: sugar boiling out of a skin, which is a fine, dense, HIGH hiss.
// The band matters more than the level. The fire's own bed sweeps 430-780 Hz,
// so anything in that region is simply more fire; two and a half octaves above
// it there is nothing else in the camp at all, and the ear reads a narrow high
// hiss over a broad low roar as a second thing happening rather than as the
// first thing getting louder. It also brightens as it goes — a marshmallow that
// is properly going is hissing higher, not just harder.
//
// Level. 0.026 against the bed's 0.055, and narrow against the bed's broad, so
// it sits perceptibly under a fire the player is sitting 1.55 m from. That is
// the whole intent: the standing note on this game's ambience is "very loud.
// Not calming at all", and this is a sound the player holds a marshmallow in
// front of for a minute at a time.
//
// It is deliberately NOT scaled by the fire's distance level. The roast view
// puts the camera at a fixed 1.55 m from the flames for as long as it is open
// and nowhere else, so distance is a constant while this can be heard at all;
// riding `_level` would only expose the fact that that field tracks the NEWEST
// camp rather than the one being sat at.
const SIZZLE_PEAK = 0.026;
const SIZZLE_F0 = 2300;   // barely warm
const SIZZLE_F1 = 4300;   // properly going

export class CampAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0xf14e);

    this.bus = gain(actx, 1);
    this.bus.connect(bus);
    // A little of the valley's tail, but much less than the wildlife takes: a
    // fire six metres away is a near-field sound and a wet one sounds like it
    // is at the bottom of a well.
    this.wet = gain(actx, 0.16);
    this.bus.connect(this.wet).connect(reverb);

    this.noise = noiseBuffer(actx, 3, 'pink', 0x77c1);

    // ── the bed ───────────────────────────────────────────────────────────
    // Pink noise through a gentle band-pass, plus a low shelf of the same
    // noise for the body. Two filters rather than one because a single
    // band-pass at this Q is either hissy or muddy and never both-ish.
    this.bedSrc = noiseSource(actx, this.noise, 1);
    this.bedBp = filter(actx, 'bandpass', 620, 0.55);
    this.bedLow = filter(actx, 'lowpass', 240, 0.7);
    this.bedGain = gain(actx, 0);
    this.bedLowGain = gain(actx, 0.55);
    this.pan = panner(actx, 0);

    this.bedSrc.connect(this.bedBp).connect(this.bedGain);
    this.bedSrc.connect(this.bedLow).connect(this.bedLowGain).connect(this.bedGain);
    this.bedGain.connect(this.pan).connect(this.bus);
    // No start() here — `noiseSource` already starts the node. Calling it a
    // second time throws, and because every layer is constructed inside
    // `Audio._start`'s try block, that one exception took down the ENTIRE
    // audio graph: no wind, no water, no engine, no music, and the only
    // symptom was a console line reading "[audio] unavailable".

    // ── the sizzle ────────────────────────────────────────────────────────
    // Its own source off the same pink buffer, at a playback rate that has no
    // simple ratio to the bed's, so the two are decorrelated and the sizzle
    // does not phase against the roar it sits on top of. Started by
    // `noiseSource` exactly like the bed — see the note above about calling
    // start() twice.
    this.sizSrc = noiseSource(actx, this.noise, 1.37);
    this.sizBp = filter(actx, 'bandpass', SIZZLE_F0, 0.75);
    this.sizGain = gain(actx, 0);
    this.sizSrc.connect(this.sizBp).connect(this.sizGain).connect(this.bus);
    this._sizzle = 0;         // 0..1, written by Camp each frame

    this._level = 0;          // smoothed distance gain
    this._breath = 0;         // slow swell, so the bed is never a constant
    this._cluster = 0;        // crackles left in the current burst
    this._next = 0.4;         // seconds to the next crackle
    this._t = 0;
    this.state = { crackles: 0, level: 0 };

    // The props share this bus and this noise. Handing the pink buffer down
    // rather than letting it allocate its own saves three seconds of stereo
    // float for a layer that only ever hears it through a moving band-pass.
    this.props = new CampProps(actx, this.bus, this.noise);

    // ── the recording ─────────────────────────────────────────────────────
    // Fetched now rather than on the first camp, so the fire the player lights
    // ninety seconds in is not synthesised for the half second the decode
    // takes. Deliberately not awaited by anything: until it lands — and for
    // ever if it 404s — `update` drives the bed above and the crackle
    // scheduler below, which is the whole reason both are still here.
    /** @type {AudioBuffer|null} */
    this._fire = null;
    /** The two voices, built once the buffer arrives. @see _startFire */
    this._fireSrc = [];
    this.fireLp = filter(actx, 'lowpass', FIRE_LP_NEAR, 0.7);
    this.fireGain = gain(actx, 0);
    this.fireLp.connect(this.fireGain).connect(this.pan);
    /** Harness switch: force the synthesised fire, so the rows measured before
     *  the recording existed keep meaning what they meant. Nothing in the game
     *  sets it. */
    this._noSample = false;
    this._disposed = false;
    this.loadSamples();
  }

  /**
   * Fetch and decode `campfire.mp3` once, and hold the buffer.
   *
   * Every failure path lands in the same place: `_fire` stays null, `_sampled`
   * stays false, and the fire is the synthesised bed and crackles it has always
   * been. Warns once, because a fire that has quietly stopped being the
   * recording the user supplied is worth a line in a console.
   *
   * Idempotent — the promise is cached, so the Sound Lab or a harness joins the
   * first fetch rather than starting a second.
   */
  loadSamples() {
    return (this._sampleLoad ??= (async () => {
      const res = await fetch(FIRE_URL);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this._fire = await this.actx.decodeAudioData(await res.arrayBuffer());
      this._startFire();
      return this._fire;
    })().catch((e) => {
      console.warn(`[camp:audio] ${FIRE_URL} unavailable; synthesising the fire`, e);
      this._fire = null;
      return null;
    }));
  }

  /** Is the recording what the player is hearing? */
  _sampled() { return !!this._fire && !this._noSample; }

  /**
   * Start the two looping voices.
   *
   * They run for the whole session at gain 0 whenever there is no lit camp,
   * exactly as the synthesised bed's noise source does — a buffer source
   * feeding a silent gain costs nothing, and the alternative is starting a
   * loop at the moment the fire is struck, which puts the same 80 ms crackle
   * at the head of every fire the player ever lights.
   */
  _startFire() {
    if (this._disposed || !this._fire || this._fireSrc.length) return;
    const t = this.actx.currentTime;
    for (let i = 0; i < FIRE_RATES.length; i++) {
      const src = this.actx.createBufferSource();
      src.buffer = this._fire;
      src.loop = true;
      src.playbackRate.value = FIRE_RATES[i];
      src.connect(this.fireLp);
      src.start(t, FIRE_OFFSETS[i] * this._fire.duration);
      this._fireSrc.push(src);
    }
  }

  /**
   * Sound a camp prop appearing or disappearing. `Camp._applyRaise` calls this
   * as each prop crosses its reveal threshold.
   *
   * Forwarded rather than exposed directly so callers only ever have to find
   * `audio.camp` — and so this stays a no-op, not a crash, on any frame before
   * the graph exists.
   */
  cue(kind, opts) { this.props.cue(kind, opts); }

  /**
   * How hard the marshmallow is sizzling, 0..1.
   *
   * Written every frame by `Camp._roastAudio`, which polls the roast view — the
   * view itself never touches audio. Zero whenever nobody is holding one over
   * the fire, which is nearly always, and the layer costs one `setTargetAtTime`
   * a frame to be silent.
   */
  setSizzle(k) { this._sizzle = clamp01(k); }

  /**
   * The three one-shots the roasting mechanic needs, all three of them played
   * on voices this camp already had.
   *
   * `ignite` and `drop` are the prop layer's `fire` voice — "the fire catching",
   * a 175 -> 540 Hz sweep with a 140 ms attack, which is a gentle fwoomp and was
   * written to be one. `drop` takes the same voice through the `out` shape,
   * which is shorter, lower and softer-attacked: the difference between a patch
   * of sugar catching and a whole marshmallow going into the coals.
   *
   * `eat` is the fire's own crackle, at a fixed level rather than at whatever
   * the distance gain happens to be — the player is at the fire, and this is the
   * one crackle in the layer that is a response to something they did.
   */
  roastEvent(kind, { x = 0, z = 0 } = {}) {
    if (kind === 'ignite') this.props.cue('fire', { x, z });
    else if (kind === 'drop') this.props.cue('fire', { x, z, out: true });
    else if (kind === 'eat') this._crackle(0.34);
  }

  update(dt, L) {
    const camp = this.ctx.systems?.camp;
    const actx = this.actx;
    // The prop cues fire from Camp.update, which runs BEFORE this one — so
    // they read the previous frame's listener. Sixteen milliseconds of
    // staleness on a distance and a bearing is not a thing anyone can hear,
    // and the alternative is Camp sampling the listener for itself.
    this.props.L = L;
    // `raise` is the camp's build-in, and using it here is free: the fire
    // fades up as it is lit rather than switching on at full volume the
    // instant the player clicks.
    const lit = camp?.fire && camp.site ? clamp01(camp.raise) : 0;

    let target = 0, panTo = 0;
    if (lit) {
      const dx = camp.site.x - L.x, dz = camp.site.z - L.z;
      const d = Math.hypot(dx, dz);
      // Inverse-ish rather than linear: a linear ramp over 26 m spends most of
      // its range on distances where the fire should already be inaudible, so
      // the sound "arrives" far too early and then barely grows.
      const k = clamp01(1 - (d - NEAR) / (REACH - NEAR));
      target = lit * k * k;
      panTo = clamp(Math.sin(Math.atan2(dx, dz) - L.yaw) * 0.7, -0.8, 0.8);
      // The same enclosure multiplier every other outdoor layer uses, so if
      // anything ever starts driving it the fire ducks with the wind and the
      // birds rather than staying loud on its own.
      target *= clamp01(L.indoors ?? 1);
    }

    // Damped, and slowly: the listener's distance changes fast when driving
    // past, and an undamped level swings audibly with the camera boom.
    this._level += (target - this._level) * Math.min(1, dt * 2.4);
    this.state.level = this._level;

    // The bed breathes. Two incommensurable rates, so it never settles into a
    // pulse — the same argument the fire's own flicker light makes.
    this._t += dt;
    this._breath = 0.82 + 0.13 * Math.sin(this._t * 0.37) + 0.05 * Math.sin(this._t * 0.91 + 1.3);

    // ── which fire is playing ─────────────────────────────────────────────
    // BOTH gains are written every frame, on every path. Writing only the one
    // in use would leave the other holding whatever it last had on the frame
    // the recording finished decoding — which is a fire that never quite goes
    // out, and the kind of bug this file has already paid for once (see the
    // note about the sizzle below).
    const sam = this._sampled();

    // 0.055 is quiet on purpose. See the header. The `breath` is the
    // synthesised bed's alone: the recording has its own dynamics, and a slow
    // swell laid over a real fire is a tremolo nobody lit.
    this.bedGain.gain.setTargetAtTime(
      sam ? 0 : this._level * this._breath * 0.055, actx.currentTime, 0.12);
    this.fireGain.gain.setTargetAtTime(
      sam ? this._level * FIRE_GAIN : 0, actx.currentTime, 0.12);
    this.pan.pan.setTargetAtTime(panTo, actx.currentTime, 0.15);
    // A near fire is brighter as well as louder — you hear the hiss, not just
    // the roar. Sweeping the band-pass with distance does more for the sense of
    // proximity than the level does. The recording gets the same idea as a
    // ceiling coming down rather than a band opening up, which is what distance
    // actually does to a broadband sound and what `_splash` uses for the same
    // reason.
    this.bedBp.frequency.setTargetAtTime(lerp(430, 780, this._level), actx.currentTime, 0.2);
    this.fireLp.frequency.setTargetAtTime(
      lerp(FIRE_LP_FAR, FIRE_LP_NEAR, this._level), actx.currentTime, 0.2);

    // The sizzle. Written before the level gate below, not after: a marshmallow
    // is held over a fire the player is sitting at, so the gate would never
    // stop it — but a sizzle whose gain is only ever written on frames where
    // some OTHER condition holds is a layer that gets stuck on the day that
    // condition changes. Its own smoothing is short (60 ms) because the heat at
    // the marshmallow really does move that fast when it is turned.
    this.sizGain.gain.setTargetAtTime(
      this._sizzle * SIZZLE_PEAK * clamp01(L.indoors ?? 1), actx.currentTime, 0.06);
    this.sizBp.frequency.setTargetAtTime(
      lerp(SIZZLE_F0, SIZZLE_F1, this._sizzle), actx.currentTime, 0.12);

    if (this._level < 0.015) return;

    // ── crackles ──────────────────────────────────────────────────────────
    // The scheduler is the SYNTHESISED fire's, and it stops when the recording
    // is playing: `campfire.mp3` carries seven transients of its own per 1.11 s
    // and running this on top of them is two fires in one pit. `_crackle`
    // itself stays — `roastEvent('eat')` still asks for one.
    if (sam) return;
    this._next -= dt;
    if (this._next > 0) return;

    this._crackle();
    if (this._cluster > 0) {
      // Inside a burst: 40–150 ms apart.
      this._cluster--;
      this._next = 0.04 + this.rnd() * 0.11;
    } else {
      // Between bursts. The gap is long — a fire this size pops a few times a
      // second at most and is often silent for several. Scaled by level so a
      // distant fire is also a sparser one, which is what the loud crackles
      // being the only ones that carry actually sounds like.
      this._next = (0.55 + this.rnd() * 2.6) / lerp(0.45, 1, this._level);
      // One burst in three has a tail of two to five more.
      if (this.rnd() < 0.34) this._cluster = 2 + Math.floor(this.rnd() * 4);
    }
  }

  /**
   * One crackle.
   *
   * Three sizes, drawn with very different weights. `size` picks the envelope
   * and the filter together, because a big crackle is not just a loud small
   * one — it is lower, longer, and has a short woody ring on the end of it.
   *
   * `level` defaults to the fire's own distance gain, which is what every
   * crackle the fire makes on its own should use. `roastEvent` passes a fixed
   * one instead: the player is at the fire and that crackle is an answer to
   * something they just did, so it must not be quiet because some other camp
   * happens to be the one this layer is tracking.
   *
   * It used to take the listener, and never read it. Removed rather than left,
   * because an unused parameter is a promise the next reader has to disprove.
   */
  _crackle(level = this._level) {
    const actx = this.actx;
    const t = actx.currentTime + 0.005;
    const r = this.rnd();
    // 62% ticks, 30% knocks, 8% snaps.
    const size = r < 0.62 ? 0 : r < 0.92 ? 1 : 2;

    const dur = size === 0 ? 0.018 + this.rnd() * 0.02
              : size === 1 ? 0.05 + this.rnd() * 0.06
              : 0.11 + this.rnd() * 0.13;
    const freq = size === 0 ? 1900 + this.rnd() * 2600
               : size === 1 ? 780 + this.rnd() * 900
               : 300 + this.rnd() * 420;
    const q = size === 0 ? 1.6 : size === 1 ? 3.2 : 5.5;
    const peak = (size === 0 ? 0.055 : size === 1 ? 0.13 : 0.26)
               * (0.6 + this.rnd() * 0.7) * level;

    const src = noiseSource(actx, this.noise, 0.8 + this.rnd() * 0.5);
    const bp = filter(actx, 'bandpass', freq, q);
    const g = gain(actx, 0);
    // Each crackle gets its own small pan offset around the fire's bearing.
    // A fire is a metre across and the pops come from all over it; pinning
    // every one to the same point is the tell that they are synthetic.
    const p = panner(actx, clamp(this.pan.pan.value + (this.rnd() - 0.5) * 0.22, -0.9, 0.9));

    src.connect(bp).connect(g).connect(p).connect(this.bus);
    // Near-instant attack. A crackle with a millisecond of ramp is a click; a
    // crackle with ten is a thump. The source is already running (see the note
    // in the constructor) — the envelope is what makes this a crackle, so
    // there is nothing to start, only something to stop.
    ping(actx, g, t, Math.max(peak, 0.0004), 0.0015, dur);
    src.stop(t + dur + 0.1);
    stopLater([src, bp, g, p], actx, t + dur + 0.3);
    this.state.crackles++;
  }

  dispose() {
    this.props.dispose();
    // Set before anything is torn down, so a decode that lands after this
    // point does not start two loops into a graph that is already gone.
    this._disposed = true;
    for (const s of [this.bedSrc, this.sizSrc, ...this._fireSrc]) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    for (const n of [this.bedSrc, this.bedBp, this.bedLow, this.bedGain,
                     this.bedLowGain, this.sizSrc, this.sizBp, this.sizGain,
                     ...this._fireSrc, this.fireLp, this.fireGain,
                     this.pan, this.bus, this.wet]) {
      try { n.disconnect(); } catch { /* already gone */ }
    }
    this._fireSrc = [];
  }
}

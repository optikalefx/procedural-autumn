// ─────────────────────────────────────────────────────────────────────────────
//  JournalAudio — the three sounds the scavenger-hunt journal makes.
//
//    cover  the front board of the book swung open
//    page   a page turning
//    cross  a pencil struck through a line
//    slap   a photograph put down on the page, and taped
//
//  Synthesised, like everything else in this game — there are no sample assets
//  and there will not be. `camp_props.js` is the worked example this is built
//  in the shape of, and its three rules apply here with one change of emphasis.
//
//  ── these are not camp props, and the difference is distance ────────────────
//
//  Every one-shot in `camp_props.js` is an object somewhere ELSE: it has a
//  world position, it is attenuated over thirty metres, it is panned by its
//  bearing from the listener, and it ducks its neighbours because eight of them
//  arrive inside half a second. None of that applies to a book you are holding.
//  A journal cue has no distance, no bearing worth computing and no reverb send
//  — it is dry, close, and in front of your face. So this hangs straight off
//  the master bus beside `Audio._tickCue` rather than off a world layer, and
//  the only thing borrowed from `camp_props` is its synthesis discipline:
//  timbral separation, a normalised `peak`, and a jitter so two of the same cue
//  are never bit-identical.
//
//  ── the level, and what it is measured against ──────────────────────────────
//
//  The reference is `Audio._tickCue`, the menu click, because it is the only
//  other thing in this game that plays dry into the master with no world
//  position: it peaks at 0.032 (move) and 0.05 (select). These sit above it,
//  because a page turn is a bigger physical event than a click and because the
//  world is paused behind the journal — the wind bed is still running but
//  nothing is competing.
//
//  Rendered through an OfflineAudioContext at 48 kHz and measured at the bus,
//  which is the version of these numbers worth having:
//
//      cover  peak 0.230   rms 0.0372   273 ms
//      page   peak 0.114   rms 0.0212   372 ms
//      cross  peak 0.097   rms 0.0099   125 ms
//      slap   peak 0.269   rms 0.0197   205 ms
//
//  The whole ceremony, cover → page → cross → slap on the journal's own
//  spacing, peaks at 0.316. That is a DRAW rather than a constant: every cue
//  takes ±5% of pitch and ±7% of length per firing, so the same four sounds
//  land anywhere inside about 1.5 dB of each other run to run. Quoting the
//  ceremony peak to three figures would be quoting a random number.
//
//  The first draft measured 0.056 / 0.047 / 0.094 — level with the menu click
//  — and that was the `camp_props` mistake made a second time: a level reasoned
//  against a number rather than measured against a listener. Every voice went
//  up 6 dB, which is the step that reads as "louder" rather than as "did that
//  change?". They are still nowhere near loud: the slap peaks 11.4 dB under
//  full scale and the whole layer leaves the limiter nothing to do.
//
//  The ladder is the design, and it is read top to bottom in time: the cover
//  opens the ceremony loud (+6.1 dB on the page), the page and the cross are
//  the quiet middle, and the slap ends it 7.5 dB over the page, 8.8 over the
//  cross and 1.4 over the cover. The slap being last AND loudest is the whole
//  shape — a payoff the same size as the beat before it is not one — and the
//  cover sitting just under it is deliberate too: the first sound should
//  announce that something is happening without spending the ending.
//
//  The slap's margin used to be 4.6 dB, and it used to be a lie on anything
//  smaller than a monitor — see the next block.
//
//  Three page turns fired inside one crowd window peak at 0.151, which is
//  2.4 dB over one turn alone — the ducking in `_crowd` holds, so a player
//  flicking through the book gets a book rather than a roar. This line used to
//  claim 0.194; 0.194 is the SLAP's old figure, pasted into the wrong
//  paragraph. A critic re-rendering `pagex3` measured 0.1486 and was right.
//
//  ── the small speaker, which inverted the whole ceremony ────────────────────
//
//  Nobody plays this on a monitor. Through a 2nd-order 200 Hz high-pass — a
//  laptop, a phone, the speaker in a desk lamp — the first version of these
//  three cues came out in the WRONG ORDER (mono sum, peak):
//
//                    full     HP 200 Hz    change
//      page          0.100      0.115      +1.2 dB
//      cross         0.063      0.073      +1.2 dB
//      slap          0.164      0.074      -6.9 dB
//
//  (`cover` did not exist yet. It was written afterwards, against this
//  measurement, which is why its loudest single element is a 1050 Hz burst and
//  not the low thud a cover "should" be.)
//
//  The page and the cross are band-passed noise living well above 200 Hz, so
//  the filter costs them nothing and taking the rumble off even lifts their
//  peak. The slap's identity was its 150 → 78 Hz body glide, and a small
//  speaker does not have that note at all; what was left was the paper burst,
//  which sat about 15 dB under the body throughout. So the deliberate "the
//  slap is the payoff" became "the slap is the quietest thing in the ceremony"
//  on the hardware almost everybody has.
//
//  The fix is a rebalance inside the cue, not a trim on the bus: the paper
//  band up 9.3 dB, the body glide down 2.6 dB, about 12 dB of relative shift.
//  That is far more than the 4–5 dB a first pass suggested, and the reason to
//  go past it is that 4–5 dB only brings the slap level with the CROSS through
//  the high-pass. The order is not restored until it clears the PAGE:
//
//                    full     HP 200 Hz    change
//      cover         0.172      0.132      -2.3 dB
//      page          0.100      0.115      +1.2 dB
//      cross         0.063      0.073      +1.2 dB
//      slap          0.184      0.136      -2.6 dB
//
//  Slap over page: +7.5 dB full range, +1.5 dB through the high-pass. The
//  margin still narrows on a small speaker — it cannot not, the body really is
//  gone — but the payoff is a payoff on both, which is the requirement. And
//  the ORDER of all four survives the filter, which is the property that was
//  actually broken: cover and slap at the top, page under them, cross at the
//  bottom, on a monitor and on a phone.
//
//  ── cover: leather and board, and not the same book twice ───────────────────
//
//  This voice was missing for the whole of the first round, and missing in the
//  worst possible way. `Journal.js` cues `'cover'` when the front board swings
//  open — the biggest movement in the ceremony and the first thing the player
//  hears — and there was no such voice, so the beat borrowed `page`. The
//  journal's own critic named it exactly: "the loudest beat has a paper voice."
//  Two rustles where there should be a creak and then a rustle.
//
//  (There is a second edition of that story. For most of the round `Audio.cue`
//  was dispatching on `JOURNAL_CUES.includes(name)` while the journal asked for
//  `journal.page` / `journal.cross` / `journal.slap`, so NOTHING in this file
//  reached the game at all. Every number in this header was rendered offline
//  and every one of them was correct; not one of them had ever been heard. The
//  names now match, which is also why `cover` only has to be added to the array
//  above to be wired.)
//
//  **What separates leather from paper here is Q, not level.** The page's sheet
//  is one band at Q 0.85 — broad, airy, a rustle. The cover's hinge is the same
//  gesture, one band that rises and comes back, at **Q 2.4 and an octave
//  lower** (760 → 1450 → 980 Hz). A rustle is broadband; a creak is a
//  RESONANCE, a stiff thing complaining at one pitch as it bends. Same shape,
//  same book, different material — which is the point, because these two
//  sounds play 0.6 s apart and a listener has to hear them as one object.
//
//  Over it, eight stick-slip grabs at Q 5–7.5, 16–31 ms apart and unevenly
//  spaced. That is the part that reads as leather rather than as a filter
//  sweep: a creak is not smooth, it is a fast sequence of grip-and-release, and
//  a smooth version of this band is a synthesiser doing an impression.
//
//  Under it, a 210 → 108 Hz swell with a 45 ms attack. It is the only voice in
//  this file whose first 50 ms are meant to be nearly inaudible — a cover has
//  mass and does not click when you START to lift it — and the creak arrives on
//  top of something already moving.
//
//  Then the board arriving on its face, at 0.21: a 132 → 64 Hz drop for the
//  weight and, louder, a broad Q 1.3 burst at 1050 → 470 Hz for the leather
//  slapping the table. The mid one being the loud one is the small-speaker
//  measurement above applied at the point of writing rather than in a rescue:
//  through a 200 Hz high-pass this cue loses 2.3 dB, against the 6.9 dB the
//  slap lost before it was rebalanced.
//
//  The join between the creak and the landing was the same 40 ms hole the page
//  had, caught by the same 10 ms windows and fixed the same way — shoulder 0.80
//  on the creak, landing pulled back to 0.21. Measured through the handover:
//  200 ms 0.0469, 220 ms 0.0361, 240 ms 0.0613 (the board), 260 ms 0.0192. No
//  gap; one object moving.
//
//  ── page: a sweep, not a whoosh, and definitely not a click ─────────────────
//
//  This is the one the user singled out, and the first version was wrong in the
//  most ordinary way: a single band-passed noise burst with a falling filter.
//  That is a "shh" — the same failure `camp_props.tent` documents, where one
//  filtered burst reads as a sample of cloth rather than as a tent.
//
//  A page turn is three things happening in order, and it is the ORDER that
//  makes it legible:
//
//   1. the sheet is picked up and bends — air moving through a narrowing gap,
//      so the band RISES, 700 Hz to about 3.4 kHz
//   2. it goes over and releases — the band falls again, back to ~950 Hz, and
//      this half is louder, because a page makes its noise on the way down
//   3. it lands on the stack — a soft low settle at 200 Hz with a 55 ms attack
//      and no transient at all
//
//  The rise and the fall are ONE noise source through ONE filter with three
//  scheduled frequency points, not two burst voices crossfaded. Two voices
//  played as a rise and a fall are heard as two events; one band that turns
//  round is heard as one object moving, which is the whole difference between
//  a page turn and a synthesiser patch.
//
//  Over the top of that, seven micro-ticks of white noise between 2.6 and
//  6.4 kHz, scattered non-uniformly across the sweep. That is the paper's own
//  grain and it is what stops the result being a whoosh.
//
//  Measured, in 10 ms windows of the offline render — the arc is legible in the
//  spectral centroid and this is what "a sweep, not a whoosh" looks like as a
//  number:
//
//      20 ms   1066 Hz    the sheet lifting
//     100 ms   2437 Hz
//     160 ms   3508 Hz    the top of the arc
//     220 ms   2696 Hz    coming back down
//     280 ms   1182 Hz
//     320 ms    353 Hz    landing — and the low band goes 0.01 -> 0.64 of the
//     340 ms    304 Hz    frame's energy here, which is the settle arriving
//
//  The table that used to sit here read 2398 / 3558 / 4496 / 1607 Hz, and it
//  did not survive a re-render by anybody — not by a critic and not by this
//  file's own harness. It was taken off a draft of the voice and never
//  refreshed. Everything above comes out of `tools`-style offline renders on
//  the shipping one: render, then 10 ms windows, energy-weighted centroid.
//
//  It also PANS, -0.51 to +0.08 measured across the first 160 ms, because the
//  page travels across the book. It is a small thing and it is most of what
//  makes two page turns in a row feel like a book rather than like a button.
//
//  ── the 40 ms hole between the sweep and the landing ────────────────────────
//
//  Three parts are one gesture only if they overlap, and these did not. With
//  the sweep's shoulder at 0.42 and the landing scheduled at 0.300 of the cue,
//  the render had a FLOOR between them: rms 0.0018 at 320 ms, against a sweep
//  that peaked at 0.0363 and a landing that reached 0.031. Twenty-five dB down
//  for about forty milliseconds is not a quiet moment inside a gesture, it is
//  silence — and the cue read as two events with a gap, a "shhp" and then a
//  separate thud, which is precisely the failure the one-band-that-turns-round
//  design was chosen to avoid. The parts were right and the JOIN was missing.
//
//  Both halves of the fix were needed. The shoulder went 0.42 -> 0.70, so the
//  sweep is still sounding while it is still falling in pitch; and the landing
//  moved 0.300 -> 0.252, so its 58 ms attack is already climbing underneath
//  that tail. Measured through the handover, 10 ms windows:
//
//      260 ms  0.0264      280 ms  0.0194      300 ms  0.0192
//      320 ms  0.0255      340 ms  0.0182
//
//  The minimum is now 0.0192 — 5.5 dB under the sweep's peak and 2.5 dB under
//  the landing's, where it used to be 26 dB under both. One object moving.
//
//  ── cross: it has to have a direction ───────────────────────────────────────
//
//  A pencil struck through a line is not symmetrical: the point bites, the hand
//  accelerates, the stroke thins and leaves. Three things carry that here and
//  none of them alone is enough — the band rises (1150 → 2500 Hz, the stroke
//  speeding up), the level falls, and the pan travels left to right. Plus four
//  micro-ticks of graphite catching the tooth of the paper, unevenly spaced,
//  because evenly spaced is a machine.
//
//  All three are monotone in the render, which is the whole test: over
//  20 → 90 ms the centroid runs 3153 → 3902 Hz, the rms runs 0.017 → 0.001,
//  and the pan runs -0.21 → +0.20. Nothing about this cue is symmetrical in
//  time, which is what having a direction means.
//
//  Under it, a quiet 420 Hz band: the sheet and the page beneath it taking the
//  pressure. Without it the stroke floats — it is a scratch happening in the
//  air rather than on top of a book.
//
//  ── slap: a soft broadband thump with paper in it, not a snare ──────────────
//
//  The failure mode named in the brief is real and it is easy to walk into, so
//  it is worth writing down what actually separates the two. A snare is (a) a
//  broadband noise burst with a *tail*, and (b) a tuned shell resonance around
//  180–250 Hz that RINGS for a couple of hundred milliseconds. So:
//
//   · the low body is a sine gliding 150 → 78 Hz and gone in 100 ms. A glide
//     with no resonator cannot ring, and the pitch drop is what says "a flat
//     thing trapped some air" rather than "a drum was struck".
//   · the paper is a 75 ms noise burst at Q 1.1 — deliberately LOW Q, so it is
//     broad and dull. It is also, since the rebalance above, the LOUD half of
//     the cue: it is the part of a slap a laptop can actually reproduce. Every
//     high-Q mid band was removed; that is the snare, and none of the extra
//     level went into one.
//   · there is no tail at all. The longest thing in the cue is the 140 ms
//     board underneath. Measured: the rms is 25 dB under its peak by 80 ms and
//     28 dB by 100 ms. A snare's shell is still within 12 dB of its peak at
//     90 ms; that gap is the whole difference, and it is the one number to
//     re-check if anybody ever retunes this cue.
//
//  The band split across the render tells the same story, and it is a
//  different set of numbers from the ones this block used to carry because the
//  rebalance moved them: the onset is now half body and half paper (0.51 low /
//  0.38 mid at 20 ms, where it was 0.99 low), the low fraction holds 0.55-0.60
//  through the board's decay out to 80 ms, and then the tape ticks come in
//  alone — 0.40 high at 100 ms and 0.98 at 160 ms.
//
//  Then the tape: three tiny high ticks at 85, 145 and 195 ms, 3.4 / 4.6 /
//  2.8 kHz, each about 6 ms and each quieter than the last. Two would read as
//  a double-click; three unevenly spaced and falling reads as a fingertip
//  running along a strip. It is the smallest amount of energy in the whole file
//  and it is the detail that makes the cue "photo taped in" instead of "photo
//  dropped".
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, stopLater, panner } from './synth.js';

/**
 * The one trim for the whole layer, in the `camp_props.CUE_GAIN` spirit: the
 * level of these three sounds is a single decision in a single place, not three
 * numbers spread through the voice table. Set to 1.0 because the voices below
 * were tuned against the master directly; it exists so the Sound Lab and the
 * integrator have a knob that means something.
 */
export const JOURNAL_GAIN = 1.0;

/** The cue names this module answers to. Exported so `Audio.cue` can dispatch
 *  on membership rather than on three hard-coded string compares, and so the
 *  Sound Lab can list them. */
export const JOURNAL_CUES = ['cover', 'page', 'cross', 'slap'];

// Two of these fire inside a second during the journal's award ceremony (the
// page turn, then the cross, then the slap). Not eight in half a second like a
// camp raising, so this is much gentler than `CampProps._crowd` — but a player
// flicking through the book can hold the page turn down, and un-ducked that
// stacks into a roar.
const CROWD_WINDOW = 0.30;
const CROWD_K = 0.22;
const CROWD_MAX = 3;

// ── the voices ───────────────────────────────────────────────────────────────
//
// One function per cue, each taking the cue context `c` (start time, level,
// per-cue pitch/length jitter, node list) and scheduling its own graph through
// the helpers on the class. `this` is the JournalAudio instance, exactly as in
// `camp_props.js`, so the two files read the same way.
//
// Offsets, durations and attacks are in seconds and are scaled by `c.dur`, so a
// cue can be sped up or slowed as a whole without editing eleven numbers.

const VOICES = {
  cover(c) {
    // ── the board coming up ───────────────────────────────────────────────
    // Pink, low, broad, and with a 45 ms attack, because a cover has mass and
    // does not click when you START to lift it. This is the only voice in the
    // file whose first 50 ms are meant to be almost inaudible: the creak
    // arrives on top of a swell that is already moving.
    this._arc(c, 0.000, {
      f0: 210, f1: 150, f2: 108, turn: 0.5, q: 0.7,
      peak: 0.150, attack: 0.045, hold: 0.10, dur: 0.28, shoulder: 0.64,
      pan: -0.10, pan2: 0.05,
    });

    // ── the hinge ─────────────────────────────────────────────────────────
    // Q 2.4 against the page's 0.85, and that ratio is the whole difference
    // between leather and paper: a rustle is broadband and a creak is a
    // RESONANCE — a stiff thing complaining at one pitch as it bends. The band
    // rises and comes back for the same reason the page's does, one object
    // moving through one gesture, but over half the excursion and an octave
    // lower, so the two are unmistakably the same book and not the same
    // material.
    this._arc(c, 0.018, {
      f0: 760, f1: 1450, f2: 980, turn: 0.42, q: 2.4,
      peak: 0.480, attack: 0.018, hold: 0.11, dur: 0.29, shoulder: 0.80,
      pan: -0.14, pan2: 0.10, white: true,
    });

    // ── stick-slip ────────────────────────────────────────────────────────
    // Eight grabs of the hinge, 16–31 ms apart and accelerating slightly, high
    // Q and short. A creak is not a smooth sweep — it is a fast sequence of
    // grip-and-release, and this is the part of the cue that a listener hears
    // as leather rather than as a synthesiser. Spacings are uneven for the
    // same reason as everywhere else in this file: even is a machine.
    const grip = [
      [0.030, 1250, 5.5, 0.120],
      [0.056, 1680, 6.5, 0.092],
      [0.075, 980, 4.5, 0.104],
      [0.101, 1880, 7.0, 0.080],
      [0.122, 1420, 5.5, 0.088],
      [0.152, 2150, 7.5, 0.062],
      [0.170, 1150, 5.0, 0.072],
      [0.201, 1620, 6.0, 0.048],
    ];
    for (const [at, f, q, peak] of grip) {
      this._tick(c, at, {
        f: f * (0.88 + this.rnd() * 0.24), q,
        peak: peak * (0.72 + this.rnd() * 0.56),
        dur: 0.006 + this.rnd() * 0.005,
        pan: -0.10 + (this.rnd() - 0.5) * 0.4,
      });
    }

    // ── the board arriving on its face ────────────────────────────────────
    // Two things at once, and the mid one is the loud one on purpose — see the
    // header's small-speaker block. The low is what a cover weighs; the mid is
    // what anybody actually hears. Both are dry and short: this is the opening
    // of the ceremony, not its payoff, and it must leave the `slap` somewhere
    // to go.
    this._tone(c, 0.214, { f0: 132, f1: 64, peak: 0.115, attack: 0.005, dur: 0.11 });
    this._arc(c, 0.212, {
      f0: 1050, f1: 700, f2: 470, turn: 0.42, q: 1.3,
      peak: 0.430, attack: 0.003, hold: 0.014, dur: 0.075,
      pan: 0.06, pan2: 0.02, white: true,
    });
  },

  page(c) {
    // ── the sheet: one band that turns round ──────────────────────────────
    // 0.36 s, rising through the first 40% and falling through the rest. The
    // gain has a plateau rather than a spike so the loud part of the cue is
    // the FALL, which is where a page actually makes its noise.
    this._arc(c, 0.000, {
      f0: 700, f1: 3400, f2: 950, turn: 0.32, q: 0.85,
      peak: 0.320, attack: 0.030, hold: 0.13, dur: 0.40, shoulder: 0.70,
      pan: -0.22, pan2: 0.20,
    });

    // ── the grain ─────────────────────────────────────────────────────────
    // Seven ticks, unevenly spaced on purpose: the offsets below are not a
    // grid and not a random draw either, they are weighted toward the middle
    // of the sweep where the sheet is actually sliding across the one below.
    const grain = [
      [0.038, 5200, 9.0, 0.110],
      [0.061, 3100, 7.5, 0.085],
      [0.093, 6400, 11.0, 0.097],
      [0.128, 2600, 8.0, 0.072],
      [0.171, 4300, 9.5, 0.080],
      [0.214, 3500, 8.5, 0.055],
      [0.268, 5800, 10.5, 0.040],
    ];
    for (const [at, f, q, peak] of grain) {
      // ±14% on the frequency and ±30% on the level, drawn per tick. Without
      // it the same seven ticks land in the same seven places every turn and
      // the ear names the loop after four pages.
      this._tick(c, at, {
        f: f * (0.86 + this.rnd() * 0.28), q,
        peak: peak * (0.7 + this.rnd() * 0.6),
        dur: 0.005 + this.rnd() * 0.004,
        pan: (this.rnd() - 0.5) * 0.5,
      });
    }

    // ── landing ───────────────────────────────────────────────────────────
    // A 58 ms attack, which is long enough that there is no onset to point at.
    // The page does not hit the stack, it arrives on it. It starts at 0.252
    // rather than 0.300 so that the attack is already underway while the sweep
    // above is still falling — the two overlap by design now; see the header's
    // block on the hole that opened up when they did not.
    this._arc(c, 0.252, {
      f0: 260, f1: 200, f2: 118, turn: 0.35, q: 0.7,
      peak: 0.140, attack: 0.058, hold: 0.03, dur: 0.17, pan: 0.16, pan2: 0.10,
    });
  },

  cross(c) {
    // ── the drag ──────────────────────────────────────────────────────────
    // White rather than pink: graphite on paper is a high, dry, thin noise and
    // pink through this band is a rumble. Band rises as the hand accelerates,
    // level falls as the stroke thins, pan travels. Three cues of direction,
    // because one is not enough to hear.
    this._arc(c, 0.000, {
      f0: 1150, f1: 2050, f2: 2500, turn: 0.55, q: 1.5,
      peak: 0.270, attack: 0.004, hold: 0.035, dur: 0.135,
      pan: -0.16, pan2: 0.16, white: true,
    });

    // ── the tooth of the paper ────────────────────────────────────────────
    // Four catches, spacing 36 / 38 / 32 ms — close to even and never even,
    // which is what a hand does and a metronome does not.
    const catches = [[0.012, 2200, 0.115], [0.048, 3100, 0.090],
                     [0.086, 4400, 0.063], [0.118, 3600, 0.038]];
    for (const [at, f, peak] of catches) {
      this._tick(c, at, {
        f: f * (0.9 + this.rnd() * 0.2), q: 6.5,
        peak: peak * (0.75 + this.rnd() * 0.5),
        dur: 0.003 + this.rnd() * 0.002, pan: (this.rnd() - 0.5) * 0.3,
      });
    }

    // ── the board ─────────────────────────────────────────────────────────
    // The sheet and the page under it taking the pressure. Quiet, and the cue
    // falls apart without it — a stroke with no board is a scratch happening
    // in mid-air.
    this._arc(c, 0.004, {
      f0: 430, f1: 400, f2: 330, turn: 0.5, q: 1.2,
      peak: 0.100, attack: 0.006, hold: 0.02, dur: 0.10, pan: -0.05, pan2: 0.05,
    });
  },

  slap(c) {
    // ── the trapped air ───────────────────────────────────────────────────
    // A glide, not a note, and gone in 100 ms. See the header for why this is
    // the line between a photograph landing and a snare drum. It is the
    // IDENTITY of the cue and no longer the LEVEL of it: 0.160 rather than the
    // 0.215 it shipped at, because a body nobody's speaker can play is not
    // allowed to be the thing that sets how loud the slap is.
    this._tone(c, 0.000, { f0: 150, f1: 78, peak: 0.160, attack: 0.003, dur: 0.10 });

    // ── the paper ─────────────────────────────────────────────────────────
    // Q 1.1 is the whole point: broad and dull. Every version of this with a
    // resonant mid band sounded like a rimshot.
    //
    // This is the loudest voice in the cue, and that is deliberate rather than
    // a slip of a decimal point: it is the only part of a slap that reaches a
    // laptop speaker. It went up 9.3 dB and the body below went down 2.6 dB —
    // the header's "small speaker" block is the measurement that bought it.
    // Note the extra level went into WIDTH, not into Q; a louder narrow band
    // here is the snare this cue spent three drafts avoiding.
    this._arc(c, 0.000, {
      f0: 1400, f1: 900, f2: 600, turn: 0.45, q: 1.1,
      peak: 0.760, attack: 0.002, hold: 0.012, dur: 0.075,
      pan: -0.04, pan2: 0.02, white: true,
    });

    // ── the book underneath ───────────────────────────────────────────────
    // What says the photograph landed on a stack of pages rather than on a
    // table. The longest thing in the cue, and inaudible on its own.
    this._arc(c, 0.018, {
      f0: 300, f1: 240, f2: 165, turn: 0.4, q: 0.75,
      peak: 0.105, attack: 0.020, hold: 0.02, dur: 0.14,
    });

    // ── the tape ──────────────────────────────────────────────────────────
    // Three, falling, unevenly spaced. Two is a double-click.
    const tape = [[0.085, 3400, 5.5, 0.125], [0.145, 4600, 6.5, 0.084],
                  [0.195, 2800, 5.0, 0.050]];
    for (const [at, f, q, peak] of tape) {
      this._tick(c, at, {
        f: f * (0.92 + this.rnd() * 0.16), q,
        peak: peak * (0.8 + this.rnd() * 0.4),
        dur: 0.005 + this.rnd() * 0.003,
        pan: 0.10 + (this.rnd() - 0.5) * 0.3,
      });
    }
  },
};

export class JournalAudio {
  /**
   * @param {AudioContext} actx
   * @param {AudioNode} dest  where the cues land. The master bus — these are
   *   dry UI sounds with no world position, so they do NOT go through the
   *   ambience or camp buses and they take no reverb send. See the header.
   */
  constructor(actx, dest) {
    this.actx = actx;
    this.bus = gain(actx, JOURNAL_GAIN);
    if (dest) this.bus.connect(dest);
    // Seeded, like every other noise source in this game: an unrepeatable page
    // turn is an unrepeatable audio test.
    this.rnd = mulberry32(0x7a9e13);
    // Two beds. Pink for anything with a body — the sheet, the book, the board
    // under the pencil — because white through those wide low bands is tape
    // hiss and nothing else. White for the grain, the graphite and the tape,
    // where the band is high and narrow and pink has nothing left to give it.
    // 1.4 s of each is plenty of decorrelated material for cues this short.
    this.pink = noiseBuffer(actx, 1.4, 'pink', 0x3c11);
    this.hiss = noiseBuffer(actx, 1.4, 'white', 0x91b7);
    // Levelled to the same rms so a `peak` in the voice table means one thing
    // whichever bed the voice reaches for — Kellet's pink filter ends on a
    // x0.11 trim, so the two are an order of magnitude apart before any filter
    // sees them. Same correction, and same reason, as `CampProps._srcNorm`.
    this._norm = { pink: 0.5 / rmsOf(this.pink), hiss: 0.5 / rmsOf(this.hiss) };
    this._recent = [];
    this._warned = null;
    this.state = { cues: 0, last: '' };
  }

  /**
   * Sound one of `JOURNAL_CUES`.
   *
   * @param {'cover'|'page'|'cross'|'slap'} name
   * @param {object} [opts]
   * @param {number} [opts.level=1]  a trim for this one cue, 0..1. The journal
   *   uses it for the flick-through, where a page turn should be smaller than
   *   the one that opens the book.
   * @param {number} [opts.rate=1]   speed. Under 1 is a slower, bigger page.
   */
  cue(name, { level = 1, rate = 1 } = {}) {
    const voice = VOICES[name];
    if (!voice) {
      // The courtesy `CampProps.cue` extends to a missing prop kind: silence
      // with no explanation is how a renamed cue ships mute.
      if (!(this._warned ??= new Set()).has(name)) {
        this._warned.add(name);
        console.warn('[journal:audio] no voice for', name);
      }
      return;
    }
    const actx = this.actx;
    const c = {
      // 6 ms of latency plus up to 14 ms of jitter. The jitter is smaller than
      // `camp_props`' 22 ms because nothing here lands on a grid — but the
      // journal's ceremony DOES schedule cross-then-slap on fixed delays, and
      // two events on an exact interval read as a machine.
      t: actx.currentTime + 0.006 + this.rnd() * 0.014,
      level: clamp(level, 0, 1.5) * this._crowd(),
      // Per-cue variation, in the range `camp_props` argues for: far too little
      // to hear as a different object, far too much to hear as a repeat.
      pitch: (0.95 + this.rnd() * 0.10),
      dur: (0.93 + this.rnd() * 0.14) / clamp(rate, 0.25, 4),
      nodes: [],
      end: 0,
    };
    voice.call(this, c);
    stopLater(c.nodes, actx, c.end + 0.12);
    this.state.cues++;
    this.state.last = name;
  }

  /** Masking, not limiting — see `CampProps._crowd`, which this is a gentler copy of. */
  _crowd() {
    const now = this.actx.currentTime;
    while (this._recent.length && now - this._recent[0] > CROWD_WINDOW) this._recent.shift();
    const n = Math.min(this._recent.length, CROWD_MAX);
    this._recent.push(now);
    return 1 / (1 + CROWD_K * n);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Noise through a band that goes one way and then the other, under an
   * envelope with a plateau.
   *
   * This is the only helper `camp_props.js` does not already have, and it is
   * the whole reason this file is not four lines of that one. `_sweep` there
   * ramps a filter from f0 to f1 and `ping` gives an attack and an exponential
   * decay — between them they can make a rise or a fall but not a rise AND a
   * fall, and they always put the loudest instant at the very start.
   *
   * A page turn is neither. Its band goes up and comes back down (`turn` is
   * where it reverses, as a fraction of the length), and its loudest moment is
   * in the middle of the gesture, which is what `hold` buys — the gain holds at
   * `peak` from the end of the attack until `hold`, and only then decays. With
   * `f2 === f1` and `hold === 0` this degenerates to exactly `_sweep`.
   *
   * The pan travels too, `pan` to `pan2`, which is how a page crosses a book.
   */
  _arc(c, at, { f0, f1, f2 = f1, turn = 0.45, q = 0.9, peak, attack = 0.02,
                hold = 0, dur = 0.3, shoulder = 0, pan = 0, pan2 = null, white = false }) {
    const actx = this.actx;
    const t = c.t + at * c.dur;
    const d = Math.max(0.02, dur * c.dur);
    const P = c.pitch;
    const buf = white ? this.hiss : this.pink;
    const src = noiseSource(actx, buf, 0.88 + this.rnd() * 0.28);
    const bp = filter(actx, 'bandpass', f0 * P, q);
    bp.frequency.setValueAtTime(f0 * P, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(30, f1 * P), t + d * turn);
    bp.frequency.exponentialRampToValueAtTime(Math.max(30, f2 * P), t + d);

    const g = gain(actx, 0);
    const p = panner(actx, clamp(pan, -0.92, 0.92));
    if (pan2 !== null) {
      p.pan.setValueAtTime(clamp(pan, -0.92, 0.92), t);
      p.pan.linearRampToValueAtTime(clamp(pan2, -0.92, 0.92), t + d);
    }
    src.connect(bp).connect(g).connect(p).connect(this.bus);

    // Level correction for the band's own width, the same first-order model
    // `camp_props.bwGain` uses and for the same reason: a change of Q must not
    // silently become a change of level. Struck against the GEOMETRIC mean of
    // the whole excursion, because the ramps are exponential — the arithmetic
    // mean of 700, 3400 and 950 sits well above where this band actually
    // spends its time.
    const mid = Math.cbrt(f0 * f1 * f2) * P;
    const a = peak * c.level * (white ? this._norm.hiss : this._norm.pink) * bwGain(mid, q);
    this._env(g, t, Math.max(a, 0.0004), attack * c.dur, hold * c.dur, d, shoulder);

    src.stop(t + d + 0.08);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** A short band-passed white tick — grain, graphite, a fingertip on tape. */
  _tick(c, at, { f, q = 8, peak, dur = 0.006, pan = 0 }) {
    const actx = this.actx;
    const t = c.t + at * c.dur;
    const d = Math.max(0.002, dur * c.dur);
    const src = noiseSource(actx, this.hiss, 0.8 + this.rnd() * 0.5);
    const bp = filter(actx, 'bandpass', f * c.pitch, q);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(pan, -0.92, 0.92));
    src.connect(bp).connect(g).connect(p).connect(this.bus);
    const a = peak * c.level * this._norm.hiss * bwGain(f * c.pitch, q);
    // 1 ms rather than the usual 3–4: these are meant to be transients, and at
    // 6 ms long an attack of 4 would be most of the tick. Still never zero —
    // a step from 0 is a click, which is a different sound from a crackle.
    this._env(g, t, Math.max(a, 0.0004), 0.001, 0, d);
    src.stop(t + d + 0.05);
    this._own(c, [src, bp, g, p], t + d);
  }

  /** A gliding oscillator — the slap's trapped air, and nothing else. */
  _tone(c, at, { f0, f1 = null, peak, attack = 0.003, dur = 0.1, type = 'sine', pan = 0 }) {
    const actx = this.actx;
    const t = c.t + at * c.dur;
    const d = Math.max(0.01, dur * c.dur);
    const o = actx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * c.pitch, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * c.pitch), t + d);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(pan, -0.92, 0.92));
    o.connect(g).connect(p).connect(this.bus);
    this._env(g, t, Math.max(peak * c.level, 0.0004), attack * c.dur, 0, d);
    o.start(t);
    o.stop(t + d + 0.05);
    this._own(c, [o, g, p], t + d);
  }

  /**
   * Attack, plateau, exponential release.
   *
   * `synth.ping` is attack-then-decay and is right for a knock. It is wrong for
   * a gesture: the loudest instant of a page turn is halfway through it, not at
   * the start, and `ping` cannot put it there. `hold` is the length of the
   * plateau measured from the START of the cue, not from the end of the attack,
   * so writing `attack: 0.03, hold: 0.16` reads as "up over 30 ms, level until
   * 160 ms, then away" — which is how the gesture is actually described.
   */
  _env(node, t, peak, attack, hold, dur, shoulder = 0) {
    const g = node.gain;
    const a = Math.max(0.001, attack);
    const h = Math.max(a, Math.min(hold, dur - 0.005));
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + a);
    if (h > a) g.setValueAtTime(peak, t + h);
    // The shoulder. An exponential straight from `peak` to silence is the right
    // shape for a knock and it was killing the page turn: measured, the band's
    // whole descent from 3.4 kHz back to 950 Hz was happening under a gain that
    // had already fallen to a tenth, so the cue rose and then simply stopped.
    // Dropping to `shoulder` of peak partway through the release and only then
    // decaying keeps the fall audible without making the cue longer.
    if (shoulder > 0) g.linearRampToValueAtTime(peak * shoulder, t + h + (dur - h) * 0.45);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Register a voice's nodes for the cue's single cleanup. */
  _own(c, nodes, end) {
    for (const n of nodes) c.nodes.push(n);
    if (end > c.end) c.end = end;
  }

  dispose() {
    try { this.bus.disconnect(); } catch { /* already gone */ }
  }
}

// ── level bookkeeping ────────────────────────────────────────────────────────
//
// Both of these are lifted verbatim in intent from `camp_props.js`, which
// explains them at length. The short version: a band-pass throws away most of a
// noise source and how much depends on its own bandwidth, and pink and white
// are an order of magnitude apart before either reaches a filter. Neither is a
// taste question, so neither belongs in the voice table — otherwise a `peak` of
// 0.05 means one thing in the page's Q 0.85 sweep and something ten times
// louder in the tape's Q 6.5 tick.

const NOISE_REF = 900;   // Hz of pass-band that needs no correction
const bwGain = (f, q) => Math.sqrt(NOISE_REF / clamp((Math.PI / 2) * f / q, 30, 6000));

/** RMS of a buffer's first channel. Once per buffer, at construction. */
function rmsOf(buf) {
  const d = buf.getChannelData(0);
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 17) { sum += d[i] * d[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}

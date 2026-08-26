// ─────────────────────────────────────────────────────────────────────────────
//  JournalAudio — the three sounds the scavenger-hunt journal makes.
//
//    cover  the front board of the book swung open
//    page   a page turning
//    cross  a pencil struck through a line
//    slap   a photograph put down on the page, and taped
//
//  Synthesised, like everything else in this game, WITH ONE EXCEPTION: the page
//  turn is played from `public/audio/page.mp3`, a recording the user made and
//  asked for by name. That is a real departure from the repo's rule — before it,
//  `public/audio/` had held exactly one asset ever, the music loop — and it is
//  handled as a departure rather than as a new normal: the synthesised page
//  voice is still here and is still what plays if the fetch or the decode
//  fails. The whole argument, the two takes inside the file, and the measured
//  level are in the block above `PAGE_SAMPLE_URL`. The other three voices are
//  synthesised and are not up for negotiation.
//
//  `camp_props.js` is the worked example this is built
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
//      cover  peak 0.230   rms 0.0360   292 ms
//      page   peak 0.114   rms 0.0212   372 ms
//      cross  peak 0.097   rms 0.0099   124 ms
//      slap   peak 0.269   rms 0.0197   206 ms
//
//  **Every column of that table needs its definition, and the cover's duration
//  is why.** The row used to read `273 ms`, and two independent re-renders got
//  308 and 315. All three were measuring the cover; none of them was measuring
//  the same thing. So, stated once:
//
//   · **peak** is max |sample| over both channels of the whole render.
//   · **duration** is first to last sample whose mono sum clears 0.0015 — about
//     -56 dBFS. It is a threshold, it has to be quoted, and the cover is the
//     cue that proves it: the same render is 298 ms at 0.001, 292 at 0.0015,
//     279 at 0.003 and 247 at 0.01. A duration with no threshold is not a
//     measurement, and 273 was somewhere on that curve with nobody left to say
//     where.
//   · The 308/315 ms figures are the same cue measured from **t = 0** rather
//     than from its onset, and the cover's onset is 17 ms in (`cue()` schedules
//     at `currentTime + 0.006 + rnd * 0.014`). 292 + 17 = 309, which is the
//     whole of the disagreement.
//   · **rms** is over that same window, not over the buffer. Over the 1.5 s
//     buffer the cover reads 0.0216 instead of 0.0360, and the difference is
//     just how much silence you included.
//
//  **And every peak in that table is one draw.** They are the FIRST firing on a
//  fresh `JournalAudio`, which is why they reproduce bit-for-bit: `this.rnd` is
//  `mulberry32(0x7a9e13)` and a fresh instance always starts there. In play a
//  cue is the k-th firing, the rng has moved on, and the peak is a draw.
//  Measured over 24 draws (advancing the rng only — firing throwaway cues to
//  advance it also fills `_recent` and lets `_crowd` duck the cue under test,
//  which is a different measurement and gave a 5 dB "spread" the first time):
//
//               min      median     max      spread
//      cover   0.1933    0.2298    0.2829    3.3 dB
//      page    0.1095    0.1154    0.1341    1.8
//      cross   0.0770    0.0911    0.1251    4.2
//      slap    0.2037    0.2426    0.2736    2.6
//      whole ceremony    0.2195 / 0.2520 / 0.2829
//
//  So the ceremony peaks around 0.25, not the 0.316 this header used to claim —
//  0.316 is outside the range of 24 draws and did not survive a re-render by
//  anybody. Quote 0.22 to 0.28 or quote nothing.
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
//  the quiet middle, and the slap ends it 7.5 dB over the page and 8.8 over the
//  cross. The slap being last AND loudest is the whole shape — a payoff the
//  same size as the beat before it is not one — and the cover sitting just
//  under it is deliberate too: the first sound should announce that something
//  is happening without spending the ending.
//
//  (Those two figures are from the stereo-peak table above. The small-speaker
//  block below quotes ITS margins off the mono sum, where the same slap-over-
//  page gap is 5.3 dB rather than 7.5, because summing two channels that are
//  panned apart costs the wider cue more. Two definitions, both fine, and the
//  file used to slide between them inside one sentence.)
//
//  **The top two rungs are not really two rungs.** The cover-to-slap margin was
//  quoted here as 1.4 dB, and 1.4 dB is the gap between two particular draws —
//  the first firing of each on a fresh instance. Over the 24 draws in the table
//  above the two cues have means 0.2363 and 0.2403, which is **0.15 dB apart**,
//  and their ranges overlap almost completely: pairing every cover draw against
//  every slap draw, **the cover is the louder of the two on 43% of firings**.
//  So the honest statement of the design is that the ceremony has three levels,
//  not four — cover and slap together at the top, the page under them, the
//  cross at the bottom — and which of the top two is loudest on any given
//  opening of the book is a coin weighted slightly towards the slap. The shape
//  survives that (the payoff is never the QUIET one, and it is always last),
//  and it is worth knowing before somebody spends an afternoon retuning a
//  1.4 dB gap that is not there.
//
//  The slap's margin used to be 4.6 dB, and it used to be a lie on anything
//  smaller than a monitor — see the next block.
//
//  Three page turns fired 0.12 s apart — a player holding the key down — peak
//  at 0.151, which is 2.4 dB over one turn alone: the ducking in `_crowd`
//  holds, so flicking through the book gets you a book rather than a roar. This
//  line used to claim 0.194; 0.194 is the SLAP's old figure, pasted into the
//  wrong paragraph. A critic re-rendering `pagex3` measured 0.1486 and was
//  right. **The spacing is part of the number**: three fired at the SAME
//  instant peak at 0.194, because ducking cannot separate what is already
//  simultaneous — that is a stress test rather than a thing the journal does,
//  and two runs of "pagex3" that disagree by 2 dB are usually this.
//
//  ── the small speaker, which inverted the whole ceremony ────────────────────
//
//  Nobody plays this on a monitor. Through a **4th-order 200 Hz high-pass —
//  two cascaded biquads, 24 dB/oct** — a laptop, a phone, the speaker in a desk
//  lamp — the first version of these three cues came out in the WRONG ORDER
//  (mono sum, peak):
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
//  Slap over page: +5.3 dB on the full-range mono sum, **+1.5 dB through the
//  4th-order filter, +0.3 dB through a 2nd-order one**. The margin still
//  narrows on a small speaker — it cannot not, the body really is gone — but
//  the payoff is a payoff on both, which is the requirement. And the ORDER of
//  all four survives the filter, which is the property that was actually
//  broken: cover and slap at the top, page under them, cross at the bottom, on
//  a monitor and on a phone.
//
//  **That +1.5 dB is filter-dependent and the header used to misname the
//  filter.** The table above was measured through `hp(hp(x))` — two cascaded
//  Q-0.707 biquads, 24 dB/oct — while the prose called it 2nd-order, and a
//  critic who took the prose at its word and ran ONE biquad measured the slap
//  at 0.1122 against the page's 0.1084: a margin of 0.30 dB, not 1.5. Both
//  numbers are right for their own filter and the 12 dB/oct one is the harsher
//  reading, because a gentler slope lets more of the page's low end through
//  than it lets of the slap's. So: the order is restored under both, the
//  rebalance is justified under both, and the margin it buys is somewhere
//  between a third of a decibel and one and a half depending on what you think
//  a phone speaker does. Do not quote 1.5 dB without the "24 dB/oct" next to
//  it.
//
//  Every peak in these two tables is a mono sum of the first firing on a fresh
//  instance, for the reason the level block gives: that is the reproducible
//  draw. The per-firing spread is ~±1.3 dB on the slap and ~±1.65 on the cover,
//  which is wider than either high-pass margin — so on any single firing the
//  order can invert. What the rebalance fixed is the systematic 12 dB, not the
//  draw.
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
//  **This voice is now the FALLBACK** — `page.mp3` plays instead whenever the
//  buffer is there. Everything below still holds and still ships: it is what a
//  player hears if the asset does not arrive, and it is the row every level in
//  this file is pegged to. Do not delete it to tidy up.
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

// ─────────────────────────────────────────────────────────────────────────────
//  The one recording in the game, and everything it has to survive
//
//  The rule this file's header states — "synthesised, like everything else in
//  this game; there are no sample assets and there will not be" — was overruled
//  by the user for this one cue: they recorded a page turn and asked for it.
//  `public/audio/` has held exactly one asset ever (the music loop), so this is
//  a departure and it is handled as one:
//
//   · **The synthesised page voice stays.** It is not dead code and it is not
//     kept for sentiment: it is the fallback. `page.mp3` is a network fetch and
//     a decode, either of which can fail — an old browser with no promise-form
//     `decodeAudioData`, a cache miss on a flaky connection, a deploy that
//     drops the file. A missing asset must never mean a SILENT page turn, which
//     is the failure mode a `try { play } catch {}` around a sample gives you.
//     `VOICES.page` is what runs until the buffer arrives and forever if it
//     never does.
//   · **The level is measured, not eyeballed**, against the same four-column
//     table the synthesised voices are quoted in. See the ladder block below.
//   · Loaded ONCE, lazily, cached as an `AudioBuffer` on the instance. The
//     fetch is kicked off from the constructor rather than from the first
//     `cue('page')`, because `Audio` builds this class on the first journal cue
//     of the session and that cue is `cover` — which buys the load the 0.6 s
//     before the first page turn instead of racing it.
//
//  ── it is TWO takes, not one, and playing the file would play both ──────────
//
//  Measured off the decode in 20 ms windows (mono, `tools/_scratch/_jaudio.mjs`
//  and its envelope pass): the 1.000 s file is a lift and a snap at
//  **0 → 215 ms** (peak 0.1680 at 160 ms), then 380 ms of room tone at
//  rms 0.002–0.005, then a SECOND turn at **585 → 700 ms** (peak 0.1565), then
//  280 ms of near-silence. Fired whole it is two page turns half a second
//  apart for one call, with a long dead tail — so the cue plays ONE take,
//  chosen by the rng, and the second take is the variation the file's own
//  discipline asks for ("a jitter so two of the same cue are never
//  bit-identical") without a pitch trick. Both cuts land in the room tone
//  50 dB down, and each take still gets a 4 ms in / 14 ms out ramp: a cut at
//  the noise floor is not silence, and a step from it is a click.
//
//  ── the level ──────────────────────────────────────────────────────────────
//
//  Rendered through the same `OfflineAudioContext` at 48 kHz as the four
//  synthesised voices, measured with the same definitions this file's header
//  states (peak = max |sample| over both channels; mono = (L+R)/2; rms over the
//  0.0015-threshold window; hp200 = mono peak through TWO cascaded Q-0.707
//  biquads, 24 dB/oct). The harness reproduces the existing table to the last
//  digit — cover 0.2298 / page 0.1139 / cross 0.0973 / slap 0.2689 — which is
//  what makes the new row comparable rather than merely adjacent:
//
//                      peak     mono     rms     rms200   hp200    ms
//      synth page     0.1139   0.1002   0.0212   0.0252   0.1146   372
//      page.mp3 raw   0.1682   0.1680   0.0112   0.0169   0.1662   737
//      cue, take 0    0.1187   0.1155   0.0110   0.0118   0.1119   232
//      cue, take 1    0.1258   0.1151   0.0113   0.0091   0.1075   132
//
//  **Four columns wanted four different gains and they do not agree**, so which
//  one is the anchor has to be argued rather than assumed:
//
//      match peak    0.677      match hp200   0.690
//      match mono    0.596      match rms200  1.491
//
//  `hp200` decides it, because the small-speaker block above is a rule and not
//  a preference: cover and slap on top, page under them, cross at the bottom,
//  through a 4th-order 200 Hz high-pass. The recording is almost entirely above
//  200 Hz — the filter costs it 0.1 dB where it costs the cover 2.3 — so a gain
//  chosen for loudness sails straight past cover (0.1319) and slap (0.1356) on
//  a laptop speaker and inverts the ceremony. Any gain over **0.794** does. And
//  it agrees with the full-range peak to 0.16 dB, so the two honest anchors
//  point at the same number. **0.68**, and the ladder holds on both readings.
//
//  What that costs, stated rather than buried: `rms200` — the loudest 200 ms,
//  which is the column to compare cues of different lengths on — lands **6.6 dB
//  under** the synthesised page on take 0 and 8.9 under on take 1. The
//  recording's crest factor is 20 dB against the synth's 13, so at matched peak
//  it has less body. That is what a real close-mic'd page turn is, and the
//  alternative is a page turn that is louder than the cover on the hardware
//  most people have.
//
//  Two more rows, from the same pass:
//
//   · **A player holding the key down.** Three turns 0.12 s apart peak at
//     0.1279 — **+0.7 dB** over one turn, against the synthesised voice's
//     +2.4 dB, so `_crowd`'s ducking holds and riffling gets you a book.
//     Fired SIMULTANEOUSLY they reach 0.1422 (hp200 0.1428, which does clear
//     the cover), and that is the same stress test the header's 0.194 row is:
//     ducking cannot separate what is already coincident, and `Journal.leaf()`
//     refuses a turn while one is in flight, so the journal cannot produce it.
//   · **The asset missing.** With the fetch rejected, `cue('page')` measures
//     0.1139 / 0.0212 / 372 ms / hp200 0.1146 — bit-identical to `synth page`,
//     which is the whole claim: no asset, no silence, same page turn as before.
// ─────────────────────────────────────────────────────────────────────────────
// ── the cover: the file, played ──────────────────────────────────────────────
//
// `public/audio/journal.mp3`, whole, at one gain. No window, no shelf, no pitch
// jitter, no pan.
//
// It got all four, and the user's verdict was that it was not the sound they
// loaded. They were right. What "levelling a recording into the ladder" had
// quietly turned into:
//
//   · **half the file was never played.** A take detector with a 2% floor found
//     one burst from 0.02 to 0.52 s in a one-second recording and treated the
//     rest as room tone, so whatever decay it had was cut off at 0.52.
//   · **the pitch moved every firing.** `c.pitch` is 0.95-1.05 and it is right
//     for a synthesised voice, where it stops a repeat sounding like a repeat.
//     On a recording of a real object it is just detuning it.
//   · a high shelf, and a pan, both arguing with the room already in the file.
//
// Each was defensible alone; the stack of them was not a recording any more.
//
// **6.2, and it deliberately breaks the ladder.** `slap > cover > page > cross`
// through a 200 Hz high-pass was a rule this file held, and the cover is now
// the loudest beat instead of the slap. That is a considered trade, not an
// oversight: the user could not hear their own recording in the ceremony and
// said so three times, and being audible beats being balanced.
//
// The reason it needs so much is the file itself. Measured against the page
// recording sitting beside it in `public/audio/`:
//
//                 peak     body (rms per 100 ms, at its loudest)
//   page.mp3     0.1680    0.0217
//   journal.mp3  0.0391    0.0073
//
// The cover take is about 13 dB quieter in peak and 9 dB quieter in body than
// the page take. A gain of 6.2 is what closes that, and it is amplifying the
// recording's own noise floor along with it. A louder take would let this
// number come down and the ladder go back.
//
// What plays is the file: verified by correlating the rendered cue against the
// raw mp3, 0.9994 over the full second.
const COVER_SAMPLE_URL = '/audio/journal.mp3';
const COVER_SAMPLE_GAIN = 6.2;

const PAGE_SAMPLE_URL = '/audio/page.mp3';
const PAGE_SAMPLE_GAIN = 0.68;
/** [start, end] in seconds. See the two-takes block above. */
const PAGE_TAKES = [[0.000, 0.235], [0.578, 0.720]];
const TAKE_FADE_IN = 0.004;
const TAKE_FADE_OUT = 0.014;

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

    // The recording. Kicked off here rather than from the first `cue('page')`
    // — `Audio` builds this class on the journal's FIRST cue of the session and
    // that cue is `cover`, so starting the fetch now buys it the 0.6 s of
    // ceremony before the first page turn instead of racing it. Deliberately
    // not awaited by anything: until it lands, `cue('page')` synthesises.
    /** @type {AudioBuffer|null} */
    this._page = null;
    this._cover = null;
    /** Harness switch: force the synthesised voice so its row keeps meaning
     *  what it has always meant. Nothing in the game sets it. */
    this._noSample = false;
    this.loadSamples();
  }

  /**
   * Fetch and decode `page.mp3` once, and hold the buffer.
   *
   * Every failure path lands in the same place: `this._page` stays null and
   * `cue('page')` keeps using `VOICES.page`. That is the whole reason the
   * synthesised voice is still in this file — see the block above
   * `PAGE_SAMPLE_URL`. Warns once, because a page turn that has quietly
   * stopped being the sound the user recorded is worth one line in a console.
   *
   * Idempotent: the promise is cached, so a second call (the Sound Lab, a
   * harness) joins the first rather than fetching twice.
   */
  loadSamples() {
    return (this._sampleLoad ??= Promise.all([
      this._loadOne(PAGE_SAMPLE_URL, 'page', 'the page turn'),
      this._loadOne(COVER_SAMPLE_URL, 'cover', 'the cover opening'),
    ]));
  }

  /**
   * One sample. Independent of the others on purpose: a 404 on the cover must
   * not cost the page its recording, so each has its own catch and its own
   * null, and `cue()` asks per name.
   */
  _loadOne(url, key, what) {
    return (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // `decodeAudioData` is given a fresh ArrayBuffer and detaches it; nothing
      // else reads `bytes` afterwards, which is why this is not `.slice(0)`.
      this[`_${key}`] = await this.actx.decodeAudioData(await res.arrayBuffer());
      return this[`_${key}`];
    })().catch((e) => {
      console.warn(`[journal:audio] ${url} unavailable; synthesising ${what}`, e);
      this[`_${key}`] = null;
      return null;
    });
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
    // The page turn is the one cue with a recording behind it, and the choice
    // is made per FIRING rather than once at load: the buffer arrives partway
    // through a session, and a cue that had already bound itself to the synth
    // would keep synthesising for the rest of it.
    const SAMPLED = { page: this._page, cover: this._cover };
    const sampled = !this._noSample && !!SAMPLED[name];
    // Say which path fired, once per cue name. Three rounds of this feature
    // were spent on "is it playing my file?" with no way to answer it from the
    // machine that could hear it — every check I could run said yes and the
    // person listening said no. One line in a console settles that in seconds,
    // and it costs nothing after the first firing of each cue.
    if (SAMPLED[name] !== undefined) {
      (this._said ??= new Set()).has(name) || (this._said.add(name),
        console.info(`[journal:audio] ${name}: ${sampled ? SAMPLED[name] ? 'playing the recording' : '?' : 'synthesised (no recording loaded)'}`));
    }
    const voice = sampled
      ? (name === 'page' ? this._sampledPage : this._sampledCover)
      : VOICES[name];
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
      // The caller's speed, kept whole. Every synthesised voice reads it folded
      // into `dur`, which is right for a graph of scheduled ramps and useless
      // to a buffer source — that needs one `playbackRate`, and dividing it
      // back out of `dur` would also divide out the per-cue length jitter.
      rate: clamp(rate, 0.25, 4),
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

  // ── voices ─────────────────────────────────────────────────────────────────

  /**
   * The page turn, played from the recording.
   *
   * A method rather than an entry in `VOICES` because it needs `this._page`,
   * and because it is the one voice whose availability is decided at runtime —
   * `cue()` picks between this and `VOICES.page` on every firing.
   *
   * Three things it keeps from the synthesised voice, all of them properties
   * that were argued for and signed off rather than incidental:
   *
   *  · **the per-cue jitter.** `c.pitch` (0.95–1.05) becomes `playbackRate`, so
   *    two turns are never the same length or the same pitch. Combined with the
   *    two takes, "the ear names the loop after four pages" needs a lot more
   *    than four pages.
   *  · **the pan travel.** The synthesised page runs -0.51 → +0.08 across its
   *    first 160 ms "because the page travels across the book", and the file's
   *    header calls that most of what makes two turns in a row feel like a book
   *    rather than a button. The recording is effectively mono (L-R rms is 3.9%
   *    of L), so it has no travel of its own and would lose the property
   *    outright. Half the excursion, because a recording already carries some
   *    room and a hard sweep on top of that reads as an effect.
   *  · **`c.level`**, which is `_crowd()`'s ducking. A player holding the page
   *    key down is the case that ducking exists for and a buffer source is no
   *    less capable of stacking into a roar than a noise burst is.
   */
  _sampledPage(c) {
    const actx = this.actx;
    const [t0, t1] = PAGE_TAKES[this.rnd() < 0.5 ? 0 : 1];
    const rate = c.pitch * c.rate;
    const d = (t1 - t0) / rate;
    const t = c.t;

    const src = actx.createBufferSource();
    src.buffer = this._page;
    src.playbackRate.value = rate;
    const g = gain(actx, 0);
    const p = panner(actx, -0.26);
    p.pan.setValueAtTime(-0.26, t);
    p.pan.linearRampToValueAtTime(0.04, t + d);
    src.connect(g).connect(p).connect(this.bus);

    // A trapezoid, not `_env`: `_env`'s shape (attack, plateau, exponential
    // release) is a synthesis envelope and the recording brings its own. All
    // this has to do is not click at the two cuts — see the two-takes block.
    const a = Math.max(PAGE_SAMPLE_GAIN * c.level, 0.0004);
    const fin = Math.min(TAKE_FADE_IN, d * 0.2);
    const fout = Math.min(TAKE_FADE_OUT, d * 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(a, t + fin);
    g.gain.setValueAtTime(a, t + d - fout);
    g.gain.linearRampToValueAtTime(0.0001, t + d);

    // `start(when, offset, duration)` — the take, and only the take. The
    // duration is in BUFFER seconds, so it is `t1 - t0` and not `d`; passing
    // the rate-scaled figure plays a different amount of tape at every jitter.
    src.start(t, t0, t1 - t0);
    src.stop(t + d + 0.02);
    this._own(c, [src, g, p], t + d);
  }

  /**
   * The recorded cover, opening: the buffer, whole, at one gain.
   *
   * Deliberately the plainest voice in this file — see the note by
   * COVER_SAMPLE_GAIN for what this used to do to the recording and why none of
   * it survived. `_sampledPage` above still windows and pans and detunes, and
   * should: that file is two takes and needs choosing between them, and a page
   * turn genuinely sweeps across the frame. This is a board hinging away from
   * you on the spot.
   */
  _sampledCover(c) {
    const actx = this.actx;
    const t = c.t;
    const src = actx.createBufferSource();
    src.buffer = this._cover;
    // No `playbackRate`. The jitter every other voice gets is right for a
    // synthesised one and detunes a recording.
    const g = gain(actx, 0);
    src.connect(g).connect(this.bus);

    // `c.level` so `_crowd()` can still duck a cue fired on top of itself.
    // `setValueAtTime` rather than a ramp: the recording has its own attack and
    // 4 ms of fade-in on top of it is 4 ms of somebody else's idea.
    g.gain.setValueAtTime(Math.max(COVER_SAMPLE_GAIN * c.level, 0.0004), t);

    // The whole buffer. No offset, no duration.
    src.start(t);
    src.stop(t + this._cover.duration + 0.05);
    c.nodes.push(src, g);
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

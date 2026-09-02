// ─────────────────────────────────────────────────────────────────────────────
//  Wildlife — occasional, distant, and mostly absent.
//
//  Animals in a cozy game are punctuation. A deer that calls every twenty
//  seconds is a cuckoo clock; one that calls twice in a drive is a memory. So
//  the rate here is deliberately low and the cooldown long, and the only sound
//  that fires reliably is the one the player *caused*: a flock going up out of
//  a tree as the camper passes.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, clamp01, lerp, mulberry32 } from '../core/MathUtils.js';
import { noiseBuffer, noiseSource, filter, gain, ping, stopLater, panner } from './synth.js';

// One row per animal that has a voice. See `_call`.
const VOICE = {
  deer: { wave: 'triangle', f: 380, spread: 90, dur: 0.28, sag: 0.88, throat: 1400, level: 1 },
  bear: { wave: 'sawtooth', f: 96, spread: 26, dur: 0.42, sag: 0.82, throat: 320, level: 1.25 },
  // Higher and shorter than the deer, and it falls further: a goat's bleat is
  // a nasal complaint that runs out halfway through, not a call across a
  // meadow. The narrow high throat band is the nose in it.
  goat: { wave: 'triangle', f: 470, spread: 120, dur: 0.22, sag: 0.80, throat: 1900, level: 0.85 },
  // The ram, where the yak's grunt used to be, and it is a different animal in
  // the throat as well as on the hill. A yak's call was chest and almost no
  // edge (f 74, throat 240); a bighorn is a sheep, so this is the goat's bleat
  // dropped an octave and a half and given time to sag — coarse rather than
  // nasal, because the ram is four times the goat's mass and its voice is the
  // one thing about it that says so. `throat` sits just above the tone, which
  // is the rasp; the goat's sits an octave and a half above, which is the nose.
  ram: { wave: 'sawtooth', f: 205, spread: 45, dur: 0.34, sag: 0.78, throat: 620, level: 1.05 },
  // The moose, and it is the one call in the table whose CHARACTER is its
  // length rather than its pitch. A cow moose's call is a long open moan that
  // runs out slowly — nothing else here is half a second, and the header's rule
  // ("a short call reads as an exclamation, a long one as a complaint") is what
  // makes 0.62 the whole animal. Pitched between the ram and the bear, which is
  // also where the animal sits by mass; `sag` is the deepest in the table
  // because the moan genuinely falls away rather than stopping.
  moose: { wave: 'sawtooth', f: 168, spread: 30, dur: 0.62, sag: 0.70, throat: 480, level: 1.20 },
};

// ── the frog's dive: a recording ─────────────────────────────────────────────
//
// `public/audio/frog_splash.mp3`, a take the user supplied after the
// synthesised splash was rejected twice — first as too sharp, then, softened,
// as still not good enough. A real body going into real water carries the
// grain and the secondary droplets that a noise band and a sine plop cannot,
// and this is the same trade `journal_audio.js` made for the page turn: play
// the recording, keep the synthesis as the fallback so a missing asset is a
// worse splash rather than no splash.
//
// MEASURED off the file, because all three numbers below are properties of
// this take and not taste:
//
//   duration        2.000 s, 48 kHz stereo
//   onset           0.2015 s — a fifth of a second of room tone at the head
//   peak            1.3735 in the decoded float (the mp3 overshoots full
//                   scale; ffmpeg's integer max reads -0.1 dBFS)
//   body            0.19-1.30 s, rms 0.090; nothing over 0.004 past 1.52 s
//
// SPLASH_OFFSET skips the room tone. It is 15 ms AHEAD of the measured onset,
// which is deliberate: starting exactly on the first sample over threshold
// clips the attack transient, and the 15 ms of near-silence in front is
// inaudible where the event fires. Without it every dive would be heard a
// fifth of a second after the frog vanished.
//
// SPLASH_GAIN is set against the file's decoded peak, and then MEASURED on the
// wildlife bus rather than predicted from it — the arithmetic is wrong because
// the distance lowpass takes the top off the transient. Peaks on the bus, in
// the running game:
//
//   this recording, close, size 0.74 ....... 0.114
//   the same, the bull frog at size 0.92 ... 0.125
//   the same, far (far 0.70, ~42 m) ........ 0.065
//   `_splashSynth`, the fallback, close .... 0.045
//   the deer bleat at 8 m, for scale ....... 0.099
//
// So it sits a hair above the deer, which is the intent: a splash is a sound
// the player CAUSED, like the flock takeoff, and those are allowed to be
// present. The fallback is quieter than the thing it stands in for, which is
// the right way round for a substitute nobody chose.
const SPLASH_URL = '/audio/frog_splash.mp3';
const SPLASH_OFFSET = 0.186;
const SPLASH_GAIN = 0.116;

export class WildlifeAudio {
  constructor(actx, bus, reverb, ctx) {
    this.actx = actx;
    this.ctx = ctx;
    this.rnd = mulberry32(0x0deb);

    this.bus = gain(actx, 1);
    this.bus.connect(bus);
    // Animals are always outdoors and usually far; the tail places them.
    this.wet = gain(actx, 0.4);
    this.bus.connect(this.wet).connect(reverb);

    this.noise = noiseBuffer(actx, 2, 'pink', 0x1c9f);
    // The frog's dive is a RECORDING (see SPLASH_URL). Fetched now rather than
    // on the first dive, so the frog that startles ten seconds into a paddle
    // does not splash silently while the decode runs; `_splash` falls back to
    // the synth until this lands, and for ever if it 404s.
    this._splashBuf = null;
    this.loadSamples();
    this._callCool = 20 + this.rnd() * 40;
    // The owl runs its own clock, an order of magnitude slower than the
    // mammals' — see _owl.
    this._hootCool = 50 + this.rnd() * 70;
    this._burstLife = [];
    this._tick = 0;
    this.state = { calls: 0, wingbeats: 0 };
  }

  update(dt, L) {
    const w = this.ctx.systems?.wildlife;
    if (!w) return;

    // ── flock takeoff ───────────────────────────────────────────────────────
    // Birds.js keeps a fixed pool of startle bursts and sets `life > 0` when
    // one fires. Watching that transition is the cheapest possible hook and
    // needs nothing from its author.
    const bursts = w.birds?.bursts;
    if (bursts) {
      for (let i = 0; i < bursts.length; i++) {
        const live = (bursts[i].life ?? 0) > 0;
        const was = this._burstLife[i] ?? false;
        this._burstLife[i] = live;
        if (live && !was) {
          const b = bursts[i].birds?.[0];
          this._wingbeats(b ? b.x : L.x, b ? b.z : L.z, L, bursts[i].n ?? 6);
        }
      }
    }

    // ── the owl ─────────────────────────────────────────────────────────────
    // Ahead of the mammal cooldown's early return, because the two are
    // unrelated clocks and a deer that has just bleated must not be able to
    // silence the night for the next minute.
    this._owl(dt, L);

    // ── the frogs ───────────────────────────────────────────────────────────
    // Also ahead of it, and not on a clock at all: the frog system pushes an
    // event when a frog it is drawing croaks, lands, or goes into the water,
    // so every sound here has a frog under it and none is on a timer.
    this._frogs(L);

    // ── occasional calls ────────────────────────────────────────────────────
    this._callCool -= dt;
    if (this._callCool > 0) return;
    this._tick++;
    let animals = null;
    try { animals = w.debugState?.(); } catch { animals = null; }
    if (!animals || !animals.length) { this._callCool = 12; return; }

    // Only animals that are settled call — a fleeing deer is silent, which is
    // what makes the alarm-free ones feel calm.
    const cands = [];
    for (const a of animals) {
      // Rabbits are silent because they are; foxes because their one real
      // call is a scream, and a scream has no place in this valley; squirrels
      // because their chatter is a scold on a timer — exactly the cuckoo
      // clock the header forbids. Raccoons because their churr is a
      // conversation rather than a call: the sound is a run of overlapping
      // trills between animals, and the generator below makes single events,
      // so the honest options were "build a new one" or "nothing", and the
      // header sets the bar for the first. Falling through would give any of
      // them the deer's bleat, which is worse than nothing.
      if (a.key === 'rabbit' || a.key === 'fox' || a.key === 'squirrel'
        || a.key === 'raccoon') continue;
      if (a.state === 'flee') continue;
      const d = Math.hypot(a.x - L.x, a.z - L.z);
      if (d > 240) continue;
      cands.push({ a, d });
    }
    if (!cands.length) { this._callCool = 15; return; }
    const pick = cands[(this.rnd() * cands.length) | 0];
    this._call(pick.a, pick.d, L);
    this._callCool = 26 + this.rnd() * 55;
  }

  /**
   * The frogs' events, drained. A croak while it sits on the pad, a splash when
   * it dives, and a faint pat when it lands on a leaf. Each is placed and
   * attenuated by distance from the listener; past 60 m a frog is inaudible,
   * which is also about where it stops being visible.
   */
  _frogs(L) {
    const fr = this.ctx.systems?.wildlife?.frogs;
    const ev = fr?.events;
    if (!ev || !ev.length) return;
    for (const e of ev) {
      const d = Math.hypot(e.x - L.x, e.z - L.z);
      if (d > 60) continue;
      const pan = clamp(Math.sin(Math.atan2(e.x - L.x, e.z - L.z) - L.yaw), -0.9, 0.9);
      const far = clamp01(d / 60);
      if (e.kind === 'croak') this._croak(e, far, pan);
      else if (e.kind === 'splash') this._splash(e, far, pan);
      else if (e.kind === 'land') this._padPat(e, far, pan);
    }
    ev.length = 0;
  }

  /**
   * A croak: a pulsed low tone — the "rrr" is amplitude tremolo at ~24 Hz on
   * a sawtooth, which is what a vocal sac does to a glottal buzz — through a
   * nasal band, then for the smaller frogs a short upward "-bit". Pitch and
   * length scale with the frog's size: the bull variant is an octave down and
   * says one long syllable.
   */
  _croak(e, far, pan) {
    const actx = this.actx;
    const t0 = actx.currentTime + 0.01;
    const size = e.size ?? 0.75;
    const big = size > 0.85;
    const f0 = (big ? 62 : 108) * (0.94 + this.rnd() * 0.12) / (size / 0.75);
    const dur = big ? 0.55 + this.rnd() * 0.2 : 0.30 + this.rnd() * 0.12;
    const level = lerp(0.085, 0.006, far * far) * (big ? 1.15 : 1);

    const o = actx.createOscillator();
    o.type = 'sawtooth';
    const trem = gain(actx, 0.5);
    const tl = actx.createOscillator(); tl.type = 'sine'; tl.frequency.value = big ? 19 : 26;
    const tg = gain(actx, 0.5); tl.connect(tg).connect(trem.gain);
    const g = gain(actx, 0.0001);
    const nose = filter(actx, 'bandpass', big ? 320 : 640, 1.6);
    const body = filter(actx, 'lowpass', lerp(2400, 700, far), 0.8);
    const p = panner(actx, pan);
    o.connect(trem).connect(nose).connect(g).connect(body).connect(p).connect(this.bus);

    const fp = o.frequency, gp = g.gain;
    fp.setValueAtTime(f0 * 0.92, t0);
    fp.linearRampToValueAtTime(f0, t0 + dur * 0.25);
    fp.linearRampToValueAtTime(f0 * 0.90, t0 + dur);
    gp.setValueAtTime(0.0001, t0);
    gp.linearRampToValueAtTime(level, t0 + 0.05);
    gp.setValueAtTime(level, t0 + dur * 0.75);
    gp.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let end = t0 + dur;
    const nodes = [o, tl, tg, trem, nose, g, body, p];
    if (!big) {
      // "-bit": a short rising triangle after a hair of silence.
      const o2 = actx.createOscillator(); o2.type = 'triangle';
      const g2 = gain(actx, 0.0001);
      const n2 = filter(actx, 'bandpass', 900, 1.2);
      o2.connect(n2).connect(g2).connect(body);
      const t1 = end + 0.05, d2 = 0.11;
      o2.frequency.setValueAtTime(f0 * 1.6, t1);
      o2.frequency.linearRampToValueAtTime(f0 * 2.4, t1 + d2);
      g2.gain.setValueAtTime(0.0001, t1);
      g2.gain.linearRampToValueAtTime(level * 0.9, t1 + 0.02);
      g2.gain.exponentialRampToValueAtTime(0.0001, t1 + d2);
      o2.start(t1); o2.stop(t1 + d2 + 0.05);
      nodes.push(o2, g2, n2);
      end = t1 + d2;
    }
    o.start(t0); o.stop(end + 0.1); tl.start(t0); tl.stop(end + 0.1);
    stopLater(nodes, actx, end + 0.5);
    this.state.calls++;
  }

  /**
   * Fetch and decode the frog splash once, and hold the buffer.
   *
   * Every failure path lands in the same place: `_splashBuf` stays null and
   * `_splash` uses `_splashSynth`. Idempotent — the promise is cached, so the
   * Sound Lab or a harness joins the first fetch rather than starting a second.
   */
  loadSamples() {
    return (this._sampleLoad ??= (async () => {
      const res = await fetch(SPLASH_URL);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this._splashBuf = await this.actx.decodeAudioData(await res.arrayBuffer());
      return this._splashBuf;
    })().catch((e) => {
      console.warn(`[wildlife:audio] ${SPLASH_URL} unavailable; synthesising the frog splash`, e);
      this._splashBuf = null;
      return null;
    }));
  }

  /**
   * A frog going into the water.
   *
   * The recording, played from `SPLASH_OFFSET` so the sound starts on the
   * frame the frog enters, panned and attenuated exactly as the synthesised
   * one was. Two things scale it by the animal:
   *
   *   · PLAYBACK RATE. A bigger body makes a bigger, slower splash, so the
   *     bull frog plays a little under speed and the small one a little over.
   *     This is the honest lever for a recording — it moves the pitch AND the
   *     length together, which is what body size does to a splash.
   *   · LEVEL, on the same `0.6 + 0.6·size` weighting the synth used.
   *
   * The lowpass closing with distance is doing the same job it does for every
   * other animal here: distance eats the top of a sound before it eats its
   * body, and that is most of what places one across a lake.
   */
  _splash(e, far, pan) {
    if (!this._splashBuf) { this._splashSynth(e, far, pan); return; }
    const actx = this.actx;
    const t0 = actx.currentTime + 0.01;
    const size = e.size ?? 0.75;
    const level = SPLASH_GAIN * lerp(1.0, 0.08, far * far) * (0.6 + 0.6 * size);

    const src = actx.createBufferSource();
    src.buffer = this._splashBuf;
    // 0.60 (leaf) plays 1.10x, 0.92 (bull) plays 0.90x.
    src.playbackRate.value = lerp(1.10, 0.90, clamp01((size - 0.60) / 0.32));
    const g = gain(actx, level);
    const body = filter(actx, 'lowpass', lerp(7000, 900, far), 0.7);
    const p = panner(actx, pan);
    src.connect(g).connect(body).connect(p).connect(this.bus);
    src.start(t0, SPLASH_OFFSET);
    const dur = (this._splashBuf.duration - SPLASH_OFFSET) / src.playbackRate.value;
    stopLater([src, g, body, p], actx, t0 + dur + 0.1);
    this.state.calls++;
  }

  /**
   * The splash, synthesised — the FALLBACK, used only when the recording
   * above could not be fetched or decoded.
   *
   * A soft "plup": pink noise through a wide band that starts at 1.3 kHz and
   * sinks to 380 Hz as the water closes, under a 3 kHz ceiling, 25 ms attack,
   * half a second of tail, with a low sine plop under it. It is kept because
   * a missing asset should cost the dive its quality and not its sound; it is
   * not what the game plays when `public/audio/frog_splash.mp3` is in place.
   */
  _splashSynth(e, far, pan) {
    const actx = this.actx;
    const t0 = actx.currentTime + 0.01;
    const size = e.size ?? 0.75;
    const level = lerp(0.10, 0.008, far * far) * (0.6 + 0.6 * size);
    const n = noiseSource(actx, this.noise);
    const band = filter(actx, 'bandpass', 1300, 0.7);
    const g = filter(actx, 'lowpass', lerp(3000, 1100, far), 0.6);
    const ng = gain(actx, 0.0001);
    const p = panner(actx, pan);
    n.connect(band).connect(ng).connect(g).connect(p).connect(this.bus);
    band.frequency.setValueAtTime(1300 + 300 * size, t0);
    band.frequency.exponentialRampToValueAtTime(380, t0 + 0.45);
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(level, t0 + 0.025);
    ng.gain.exponentialRampToValueAtTime(level * 0.4, t0 + 0.14);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    const o = actx.createOscillator(); o.type = 'sine';
    const og = gain(actx, 0.0001);
    o.connect(og).connect(g);
    const fp = 260 - 80 * size;
    o.frequency.setValueAtTime(fp, t0 + 0.03);
    o.frequency.exponentialRampToValueAtTime(fp * 0.4, t0 + 0.2);
    og.gain.setValueAtTime(0.0001, t0 + 0.03);
    og.gain.linearRampToValueAtTime(level * 0.4, t0 + 0.06);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
    o.start(t0); o.stop(t0 + 0.3);
    stopLater([n, band, ng, g, p, o, og], actx, t0 + 0.9);
    this.state.calls++;
  }

  /** A frog landing on a leaf: a very quiet, very short pat. Only close up. */
  _padPat(e, far, pan) {
    if (far > 0.25) return;
    const actx = this.actx;
    const t0 = actx.currentTime + 0.01;
    const level = lerp(0.03, 0.0, far / 0.25);
    const n = noiseSource(actx, this.noise);
    const band = filter(actx, 'bandpass', 780, 1.4);
    const ng = gain(actx, 0.0001);
    const p = panner(actx, pan);
    n.connect(band).connect(ng).connect(p).connect(this.bus);
    ping(actx, ng, t0, level, 0.004, 0.06);
    stopLater([n, band, ng, p], actx, t0 + 0.3);
  }

  /**
   * The great horned owl.
   *
   * The hook is the one the flock takeoff above uses in spirit: instead of a
   * timer that fires into an empty valley, ask the system that owns the bird
   * whether there IS one — TreeBirds.nearestPerched('owl', …) answers only
   * while an owl is actually settled in a tree within earshot, which by
   * construction only happens at night (the `nocturnal` row in
   * TREE_BIRD_SPECIES). So there is no clock here that needs to know the hour,
   * and there is never a hoot with no bird under it.
   *
   * Rate: a minute and a half to three minutes between calls, and only when
   * one is near. This is the rarest sound in the file on purpose. An owl you
   * hear twice in a night is a night with an owl in it; one you hear every
   * thirty seconds is a sound effect.
   */
  _owl(dt, L) {
    this._hootCool -= dt;
    if (this._hootCool > 0) return;
    const tb = this.ctx.systems?.wildlife?.treeBirds;
    if (!tb?.nearestPerched) { this._hootCool = 30; return; }
    const owl = tb.nearestPerched('owl', L.x, L.z, 260);
    // No owl out there: check again shortly, but don't bank credit — the next
    // one to arrive should not be greeted by an instant hoot.
    if (!owl) { this._hootCool = 18 + this.rnd() * 14; return; }
    this._hoot(owl, L);
    this._hootCool = 95 + this.rnd() * 85;
  }

  /**
   * hoo — hoo-hoo — hoo — hoo.
   *
   * Five notes on one soft sine, around 200–290 Hz, with the second and third
   * run together: that stuttered pair in the middle is the whole signature,
   * and a metronomic five would read as a foghorn. Everything else here is
   * about keeping it *breathy and far*: a slow attack (an owl has no consonant
   * at the front of the note), a band of pink noise under the tone for the
   * throat, and a lowpass that closes with distance so the far ones are all
   * body and no edge.
   *
   * One oscillator, one gain, one noise chain — the envelope is scheduled by
   * hand across the whole series rather than through ping(), which cancels the
   * node's schedule on every call and would leave only the last note.
   */
  _hoot(owl, L) {
    const actx = this.actx;
    const t0 = actx.currentTime + 0.02;
    const f0 = 200 + this.rnd() * 90;
    const far = clamp01(owl.dist / 260);
    // Softer than any mammal in this file, and it falls away faster.
    const level = lerp(0.070, 0.011, far * far);

    // start, length, pitch ratio. The pair at 0.85/1.16 is the stutter.
    const NOTES = [
      [0.00, 0.42, 1.00],
      [0.85, 0.26, 1.06],
      [1.16, 0.24, 1.02],
      [1.80, 0.36, 0.98],
      [2.45, 0.40, 0.94],
    ];

    const o = actx.createOscillator();
    o.type = 'sine';
    const g = gain(actx, 0.0001);
    const n = noiseSource(actx, this.noise);
    const nb = filter(actx, 'bandpass', lerp(620, 380, far), 1.4);
    const ng = gain(actx, 0.0001);
    const body = filter(actx, 'lowpass', lerp(1300, 430, far), 1.0);
    const p = panner(actx, clamp(Math.sin(Math.atan2(owl.x - L.x, owl.z - L.z) - L.yaw), -0.9, 0.9));
    o.connect(g);
    n.connect(nb).connect(ng);
    ng.connect(g);
    g.connect(body).connect(p).connect(this.bus);

    const gp = g.gain, np = ng.gain, fp = o.frequency;
    gp.setValueAtTime(0.0001, t0);
    np.setValueAtTime(0.0001, t0);
    fp.setValueAtTime(f0, t0);
    let end = t0;
    for (const [at, dur, ratio] of NOTES) {
      const t = t0 + at;
      const f = f0 * ratio * (0.99 + this.rnd() * 0.02);
      // Each note sags a little across its length; a flat one sounds sampled.
      fp.setValueAtTime(f * 1.012, t);
      fp.linearRampToValueAtTime(f, t + dur * 0.30);
      fp.linearRampToValueAtTime(f * 0.975, t + dur);
      // Slow in, slow out — no click at either end, which is most of "soft".
      gp.setValueAtTime(0.0001, t);
      gp.linearRampToValueAtTime(level, t + Math.min(0.09, dur * 0.35));
      gp.setValueAtTime(level, t + dur * 0.72);
      gp.exponentialRampToValueAtTime(0.0001, t + dur);
      np.setValueAtTime(0.0001, t);
      np.linearRampToValueAtTime(0.42, t + 0.05);
      np.exponentialRampToValueAtTime(0.0002, t + dur * 0.85);
      end = t + dur;
    }
    o.start(t0); o.stop(end + 0.2);
    stopLater([o, n, nb, ng, body, g, p], actx, end + 0.6);
    this.state.calls++;
  }

  /**
   * One generator, one row of numbers per animal.
   *
   * It was `bear ? this : that` while there were two voices, and the two were
   * the extremes of the same instrument: a short bright triangle bleat and a
   * long low sawtooth huff. Adding the alpine pair made that a table, because
   * both of them sit *between* those extremes rather than beside either — a
   * goat's bleat is a deer's pushed up and shortened until it is nasal, and a
   * ram's is the goat's dropped an octave and a half and let sag.
   *
   *   wave   sawtooth is a chest, triangle is a throat
   *   f      base pitch, hz, plus `spread` of jitter
   *   dur    seconds. A short call reads as an exclamation, a long one as a
   *          complaint, and that is most of the character
   *   sag    where the pitch falls to by the end, as a ratio of `f`
   *   throat centre of the breath band under the tone
   *   level  multiplier on the distance-scaled gain
   *
   * An unlisted key falls through to `deer`, which is a real hazard rather
   * than a convenience — see the skip list in `update()`, and add a species to
   * one place or the other rather than letting it inherit a bleat it does not
   * have.
   */
  _call(a, dist, L) {
    const actx = this.actx;
    const V = VOICE[a.key] ?? VOICE.deer;
    const t = actx.currentTime + 0.02;
    const f = V.f + this.rnd() * V.spread;
    const dur = V.dur;
    const far = clamp01(dist / 240);
    const level = lerp(0.10, 0.022, far) * V.level;

    const o = actx.createOscillator();
    o.type = V.wave;
    o.frequency.setValueAtTime(f * 0.94, t);
    o.frequency.linearRampToValueAtTime(f, t + dur * 0.25);
    o.frequency.linearRampToValueAtTime(f * V.sag, t + dur);

    // Breath. A pure tone reads as a synth; the noise is what makes it a throat.
    const n = noiseSource(actx, this.noise);
    const nb = filter(actx, 'bandpass', V.throat, 1.1);
    const ng = gain(actx, 0);

    const body = filter(actx, 'lowpass', lerp(4200, 900, far), 1.0);
    const g = gain(actx, 0);
    const p = panner(actx, clamp(Math.sin(Math.atan2(a.x - L.x, a.z - L.z) - L.yaw), -0.9, 0.9));
    o.connect(g);
    n.connect(nb).connect(ng);
    ng.connect(g);
    g.connect(body).connect(p).connect(this.bus);

    ping(actx, g, t, level, 0.02, dur);
    ping(actx, ng, t, 0.5, 0.03, dur * 0.8);
    o.start(t); o.stop(t + dur + 0.2);
    stopLater([o, n, nb, ng, body, g, p], actx, t + dur + 0.6);
    this.state.calls++;
  }

  /**
   * Wingbeats: filtered noise pulsed at wing rate, decelerating as the flock
   * gets away. This is the sound the player will connect to something they saw,
   * so it is worth the handful of nodes.
   */
  _wingbeats(x, z, L, n = 6) {
    const actx = this.actx;
    const d = Math.hypot(x - L.x, z - L.z);
    if (d > 190) return;
    const far = clamp01(d / 190);
    const level = lerp(0.16, 0.02, far) * clamp01(0.4 + n / 13);

    const t0 = actx.currentTime + 0.02;
    const src = noiseSource(actx, this.noise);
    const bp = filter(actx, 'bandpass', lerp(900, 380, far), 0.9);
    const g = gain(actx, 0.0001);
    const p = panner(actx, clamp(Math.sin(Math.atan2(x - L.x, z - L.z) - L.yaw) * 0.8, -0.9, 0.9));
    src.connect(bp).connect(g).connect(p).connect(this.bus);

    // ~11 Hz at the panicked start, slowing to ~7 Hz as they settle into flight.
    let t = t0;
    let rate = 11;
    const gp = g.gain;
    gp.setValueAtTime(0.0001, t0);
    for (let i = 0; i < 16 && t < t0 + 1.7; i++) {
      const amp = level * (1 - i / 18) * (0.75 + this.rnd() * 0.5);
      gp.linearRampToValueAtTime(Math.max(amp, 0.0002), t + 0.018);
      gp.exponentialRampToValueAtTime(0.0002, t + 1 / rate * 0.8);
      t += 1 / rate;
      rate = Math.max(6.5, rate - 0.28);
    }
    gp.linearRampToValueAtTime(0.0001, t + 0.15);
    stopLater([src, bp, g, p], actx, t + 0.4);
    this.state.wingbeats++;
  }
}

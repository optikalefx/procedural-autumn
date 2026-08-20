// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO — everything you hear, synthesised at runtime. No asset files.
//
//  Structure:
//
//    ambience ┐
//    water    ├─→ master ─→ limiter ─→ analyser ─→ speakers
//    vehicle  │      ↑
//    wildlife │   reverb (shared, synthesised impulse)
//    music    ┘
//
//  Three rules the whole system obeys:
//
//   1. **Never throw, never assume.** Browsers refuse to start audio without a
//      gesture, some machines have no output device at all, and every peer
//      system this reads from may be missing or mid-init. Audio failing must
//      never be able to take a frame with it.
//   2. **One listener sample per frame.** Biome, moisture and surface lookups
//      are shared by every layer and smoothed, so driving across a boundary
//      cross-fades instead of switching.
//   3. **Mix by exclusion.** Layers are faded *against* each other. Ambience
//      that plays everything everywhere is wallpaper.
// ─────────────────────────────────────────────────────────────────────────────
import { System } from '../core/System.js';
import { clamp, clamp01, damp, smoothstep } from '../core/MathUtils.js';
import { BIOME } from '../world/WorldConfig.js';
import { gain, valleyImpulse } from './synth.js';
import { Ambience } from './ambience.js';
import { WaterAudio } from './water.js';
import { VehicleAudio } from './vehicle_audio.js';
import { WildlifeAudio } from './wildlife_audio.js';
import { CampAudio } from './camp_audio.js';
import { Music } from './music.js';
import { Soundtrack } from './soundtrack.js';

const STORE = 'pa.audio';

export class Audio extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Audio';
    this.loadLabel = 'Tuning the valley';

    this.actx = null;
    this.started = false;
    this.failed = false;
    this.volume = 0.75;
    this.muted = false;

    // The shared listener sample. Allocated once; `update` only writes fields.
    this.L = {
      x: 0, y: 0, z: 0, yaw: 0,
      hour: 16.6, wind: 1, speed: 0,
      open: 0.6, forest: 0.2, altitude: 0, indoors: 1,
      moisture: 0.4, biome: BIOME.MEADOW,
    };
    this._surf = {};
    this._targets = { open: 0.6, forest: 0.2, altitude: 0 };
    this._tick = 0;
    this._probe = null;
    this._hidden = false;

    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
      if (saved) {
        this.volume = clamp01(saved.volume ?? 0.75);
        this.muted = !!saved.muted;
      }
    } catch { /* private mode, or a corrupt entry — defaults are fine */ }
  }

  async init() {
    // The context is *not* created here. Creating one before a gesture leaves a
    // suspended context that some browsers never let you resume, and it logs a
    // warning on every load. It is built on the first real input instead.
    const start = () => this._start();
    this._gesture = start;
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
      window.addEventListener(ev, start, { passive: true });
    }

    // Tab-away: duck rather than suspend. Suspending races with the
    // resume-on-gesture path above and can leave the context stuck; a ducked
    // graph costs a fraction of a millisecond and always comes back.
    this._onVis = () => { this._hidden = document.visibilityState === 'hidden'; this._applyVolume(); };
    document.addEventListener('visibilitychange', this._onVis);

    window.__audio = this;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Build the graph. Safe to call repeatedly; only the first call does work. */
  _start() {
    if (this.started || this.failed) { this._resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.failed = true; return; }
    try {
      const actx = new AC({ latencyHint: 'interactive' });
      this.actx = actx;

      // ── master chain ────────────────────────────────────────────────────
      // Headroom: buses are mixed to peak around -12 dBFS, the master trims to
      // -3, and the limiter only ever catches transients (a splash landing on
      // top of a waterfall). It is not being used as a mix tool.
      this.master = gain(actx, 0);
      this.limiter = actx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 14;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.18;
      this.analyser = actx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3;
      this.master.connect(this.limiter).connect(this.analyser).connect(actx.destination);

      // Shared reverb. One convolver for the whole game: birds, animals and
      // music all sit in the same valley, and they should share its tail.
      this.reverb = valleyImpulse(actx, 2.8, 2.4);
      this.reverbOut = gain(actx, 0.5);
      this.reverb.connect(this.reverbOut).connect(this.master);

      // ── buses ───────────────────────────────────────────────────────────
      // Water and the wind bed were the two things the player singled out as
      // "very loud. Not calming at all." In a game whose whole proposition is a
      // quiet drive, ambience is a floor you notice when it stops, not a
      // presence you have to talk over.
      this.buses = {
        ambience: gain(actx, 0.55),
        water: gain(actx, 0.55),
        vehicle: gain(actx, 0.75),
        wildlife: gain(actx, 0.9),
        music: gain(actx, 0.8),
      };
      for (const b of Object.values(this.buses)) b.connect(this.master);

      // ── layers ──────────────────────────────────────────────────────────
      this.ambience = new Ambience(actx, this.buses.ambience, this.reverb);
      this.water = new WaterAudio(actx, this.buses.water, this.ctx.world);
      this.vehicle = new VehicleAudio(actx, this.buses.vehicle, this.ctx);
      this.wildlife = new WildlifeAudio(actx, this.buses.wildlife, this.reverb, this.ctx);
      // The camp fire rides the ambience bus rather than getting its own. It
      // IS ambience — a bed you stop hearing plus occasional punctuation — and
      // more importantly it has to duck with the rest of the world's floor
      // rather than sitting on top of it. A fire that stays loud while the
      // wind bed is turned down is a fire in a different mix.
      this.camp = new CampAudio(actx, this.buses.ambience, this.reverb, this.ctx);
      this.music = new Music(actx, this.buses.music, this.reverb, this.ctx);
      // The authored bed shares the music bus, so one volume control governs
      // both and the mix meter already accounts for it.
      this.soundtrack = new Soundtrack(actx, this.buses.music, this.ctx);

      // Metering taps, added after the layers so the water sub-buses exist.
      // An analyser only runs if it is reachable from the destination, so each
      // is followed by a silent gain into the master.
      this.taps = {};
      const tapPoints = {
        water: this.buses.water,
        falls: this.water.fallBus,
        rivers: this.water.riverBus,
        vehicle: this.buses.vehicle,
        ambience: this.buses.ambience,
        wildlife: this.buses.wildlife,
        music: this.buses.music,
        // The camp fire shares the ambience BUS but gets its own TAP. Without
        // one it cannot be measured: the ambience bus carries a wind bed that
        // swells over tens of seconds and birds that fire at random, and in a
        // back-to-back test those swamped a fire that was audibly there — one
        // reading even came back with the lit camp QUIETER than the unlit one.
        // A layer you cannot measure is a layer nobody can tune.
        camp: this.camp.bus,
      };
      for (const [name, node] of Object.entries(tapPoints)) {
        const a = actx.createAnalyser();
        // 16384 rather than the master's 2048. At 48 kHz that is a 2.9 Hz bin.
        // The engine's firing frequency is 25 Hz at idle, so its harmonics are
        // 25 Hz apart: at the default 23 Hz bin they land in adjacent bins, and
        // even at 5.9 Hz the analyser's own spectral leakage fills the gaps
        // between them. Metering only — the FFT is computed on request.
        a.fftSize = 16384;
        a.smoothingTimeConstant = 0.2;
        const sink = gain(actx, 0);
        node.connect(a).connect(sink).connect(this.master);
        this.taps[name] = a;
      }

      this.started = true;
      this._applyVolume(0.9);          // fade in, never a step
      this._resume();
      for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
        window.removeEventListener(ev, this._gesture);
      }
    } catch (e) {
      // No output device, blocked context, anything: the game keeps running.
      console.warn('[audio] unavailable:', e?.message ?? e);
      this.failed = true;
      this.actx = null;
    }
  }

  _resume() {
    if (!this.actx) return;
    if (this.actx.state === 'suspended') this.actx.resume().catch(() => {});
  }

  // ── public mix control (the HUD drives these) ──────────────────────────────

  setVolume(v) {
    this.volume = clamp01(v);
    this._applyVolume();
    this._save();
  }

  setMuted(m) {
    this.muted = !!m;
    this._applyVolume();
    this._save();
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  _applyVolume(ramp = 0.12) {
    if (!this.master || !this.actx) return;
    // -3 dBFS ceiling before the limiter, so a full-scale moment still has
    // somewhere to go.
    const target = this.muted || this._hidden ? 0 : this.volume * 0.71;
    this.master.gain.setTargetAtTime(target, this.actx.currentTime, ramp);
  }

  _save() {
    try { localStorage.setItem(STORE, JSON.stringify({ volume: this.volume, muted: this.muted })); }
    catch { /* nothing important lost */ }
  }

  /** One-shots the HUD asks for by name. */
  cue(name) {
    if (!this.started) return;
    try {
      if (name === 'shutter') this.vehicle.shutter();
      else if (name === 'door') this.vehicle.door();
      else if (name === 'tick' || name === 'select') this._tickCue(name === 'select');
    } catch { /* a UI click is never worth an exception */ }
  }

  /** A soft wooden tick for menu movement — deliberately not a digital beep. */
  _tickCue(select) {
    const actx = this.actx;
    const t = actx.currentTime + 0.005;
    const o = actx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(select ? 880 : 660, t);
    o.frequency.exponentialRampToValueAtTime(select ? 560 : 470, t + 0.06);
    const g = gain(actx, 0);
    const f = this._tickFilter ??= (() => {
      const bp = actx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.9;
      bp.connect(this.master);
      return bp;
    })();
    o.connect(g).connect(f);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(select ? 0.05 : 0.032, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.start(t); o.stop(t + 0.14);
    setTimeout(() => { try { o.disconnect(); g.disconnect(); } catch { /* gone */ } }, 260);
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  update(dt) {
    if (!this.started || !this.actx || this.actx.state !== 'running') return;
    // A stalled tab hands us a huge dt; scheduling a phrase against that would
    // put notes in the past.
    dt = Math.min(dt, 0.1);
    this._sample(dt);
    const L = this.L;
    try { this.ambience.update(dt, L); } catch (e) { this._layerFail('ambience', e); }
    try { this.water.update(dt, L); } catch (e) { this._layerFail('water', e); }
    try { this.vehicle.update(dt, L); } catch (e) { this._layerFail('vehicle', e); }
    try { this.wildlife.update(dt, L); } catch (e) { this._layerFail('wildlife', e); }
    try { this.camp.update(dt, L); } catch (e) { this._layerFail('camp', e); }
    try { this.music.update(dt, L); } catch (e) { this._layerFail('music', e); }
    // The bed ducks while a generative phrase is sounding, so the two layers
    // never occupy the same moment.
    try {
      const phraseActive = (this.music?.state?.since ?? 99) < 9;
      this.soundtrack?.update(dt, phraseActive);
    } catch (e) { this._layerFail('soundtrack', e); }
  }

  _layerFail(name, e) {
    // One bad layer must not silence the rest, and must not spam the console.
    if (!this._failed) this._failed = new Set();
    if (this._failed.has(name)) return;
    this._failed.add(name);
    console.warn(`[audio:${name}] disabled after`, e);
    const l = this[name];
    if (l) l.update = () => {};
  }

  /**
   * Build the shared listener sample.
   *
   * The world lookups are staggered over four frames and then damped, because
   * they are the only per-frame cost in the audio system that scales with the
   * world, and because a hard biome switch across a boundary is audible as a
   * click in the ambience mix.
   */
  _sample(dt) {
    const cam = this.ctx.camera;
    const L = this.L;
    L.x = cam.position.x;
    L.y = cam.position.y;
    L.z = cam.position.z;

    // Camera forward azimuth, straight off the view matrix — no allocation.
    const e = cam.matrixWorld.elements;
    L.yaw = Math.atan2(-e[8], -e[10]);

    const lighting = this.ctx.lighting;
    if (lighting) L.hour = lighting.hour ?? L.hour;

    const weather = this.ctx.systems?.weather;
    L.wind = clamp(weather?.windScale ?? weather?.wind?.gust ?? 1, 0.35, 2.2);

    const veh = this.ctx.systems?.vehicle;
    L.speed = Math.abs(veh?.speed ?? 0);

    if ((++this._tick & 3) === 0) {
      const W = this.ctx.world;
      const x = L.x, z = L.z;
      if (W.isInBounds(x, z)) {
        const s = W.getSurfaceWeights(x, z, this._surf);
        const biome = W.getBiome(x, z);
        const moist = W.getMoisture(x, z);
        L.moisture = moist;
        L.biome = biome;
        // Trees follow moisture in this world, so moisture is the honest proxy
        // for canopy — and it is continuous, which the biome enum is not.
        const wooded = smoothstep(0.44, 0.72, moist) * (biome === BIOME.FOREST ? 1 : 0.55);
        this._targets.forest = clamp01(wooded);
        this._targets.open = clamp01(((s.grass ?? 0) + (s.dry ?? 0) * 1.1) * (1 - wooded * 0.7));
        // Ground height, not camera height: an orbiting photo camera 60 m up in
        // the meadow is not at altitude.
        const ground = W.getHeight(x, z);
        this._targets.altitude = smoothstep(150, 265, ground);
      }
    }
    // ~1.5 s to cross a biome boundary: slow enough to be a transition, fast
    // enough that driving out of a wood does not trail the picture.
    L.open = damp(L.open, this._targets.open, 2.2, dt);
    L.forest = damp(L.forest, this._targets.forest, 2.2, dt);
    L.altitude = damp(L.altitude, this._targets.altitude, 1.4, dt);
  }

  // ── measurement (used by tools/audiotest.mjs) ─────────────────────────────

  /** Time-domain peak and RMS on a bus, in linear amplitude. */
  measure(which = 'master') {
    const a = which === 'master' ? this.analyser : this.taps?.[which];
    if (!a) return null;
    const buf = this._probe ??= new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let peak = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / buf.length) };
  }

  /**
   * Raw FFT for a bus, in dBFS per bin. Used by the audio test to prove the
   * engine's partials really do sit on harmonics of the modelled firing
   * frequency — the single loudest bin is not enough, because which order
   * dominates legitimately changes with load.
   */
  spectrumBins(which = 'vehicle') {
    const a = which === 'master' ? this.analyser : this.taps?.[which];
    if (!a || !this.actx) return null;
    const bins = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(bins);
    return { hzPerBin: this.actx.sampleRate / a.fftSize, db: Array.from(bins) };
  }

  /**
   * Dominant frequency on a bus, below `maxHz`. Used to prove that engine pitch
   * really does track speed rather than merely being asserted to.
   */
  spectrum(which = 'vehicle', maxHz = 900) {
    const a = which === 'master' ? this.analyser : this.taps?.[which];
    if (!a || !this.actx) return null;
    const bins = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(bins);
    const hzPerBin = this.actx.sampleRate / a.fftSize;
    const last = Math.min(bins.length - 1, Math.floor(maxHz / hzPerBin));
    let best = -Infinity, bestI = 0, total = 0;
    for (let i = 1; i <= last; i++) {
      total += Math.pow(10, bins[i] / 20);
      if (bins[i] > best) { best = bins[i]; bestI = i; }
    }
    // Parabolic interpolation across the peak: the FFT is 21 Hz per bin here
    // and the engine fundamental moves in smaller steps than that.
    let refine = bestI;
    if (bestI > 1 && bestI < last) {
      const l = bins[bestI - 1], c = bins[bestI], r = bins[bestI + 1];
      const d = (l - r) / (2 * (l - 2 * c + r) || 1e-6);
      if (Math.abs(d) < 1) refine = bestI + d;
    }
    return { hz: refine * hzPerBin, db: best, energy: total };
  }

  /** Everything a test or the HUD might want, in one readable object. */
  debugState() {
    return {
      started: this.started,
      failed: this.failed,
      state: this.actx?.state ?? 'none',
      time: this.actx?.currentTime ?? 0,
      sampleRate: this.actx?.sampleRate ?? 0,
      volume: this.volume,
      muted: this.muted,
      listener: { ...this.L },
      ambience: this.ambience?.state ?? null,
      water: this.water?.state ?? null,
      vehicle: this.vehicle?.state ?? null,
      wildlife: this.wildlife?.state ?? null,
      music: this.music?.state ?? null,
      nodes: this.started ? {
        buses: Object.keys(this.buses).length,
        fallVoices: this.water.falls.length,
        riverVoices: this.water.rivers.length,
        limiterReduction: this.limiter.reduction,
      } : null,
      master: this.started ? this.measure('master') : null,
    };
  }

  dispose() {
    document.removeEventListener('visibilitychange', this._onVis);
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
      window.removeEventListener(ev, this._gesture);
    }
    try { this.actx?.close(); } catch { /* already closed */ }
    this.started = false;
  }
}

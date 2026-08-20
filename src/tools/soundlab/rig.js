// ─────────────────────────────────────────────────────────────────────────────
//  Sound Lab — the rig.
//
//  This page runs the *real* audio system. `Audio` is constructed against a
//  synthetic ctx — a fake world holding one waterfall and one river, a fake
//  camper, a fake listener — and then the layers are driven by hand from the
//  UI instead of by the game loop. Nothing here reimplements any DSP: every
//  sound you hear is the shipping module, so a number tuned on this page means
//  the same thing when it is pasted back into `src/audio/*`.
//
//  Three deliberate departures from the game:
//
//   · **The renderer, the world bake and physics are never loaded.** The page
//     opens in well under a second and costs nothing.
//   · **`Audio.init()` is not called**, so no global gesture handlers are
//     installed and `window.__audio` is not claimed. The context is built on an
//     explicit click instead (Web Audio will not start without one, and audio
//     silently failing to start is a failure this project has shipped before).
//   · **`localStorage` is never written.** `setVolume`/`setMuted` persist to the
//     key the game reads, so the lab writes `master.gain` directly. Opening the
//     lab must not change how the game sounds.
//
//  Per-layer trim nodes are inserted *after* each layer's own gain, which is
//  what makes solo/mute possible without touching the modules: the model keeps
//  writing its own gain every frame, and the trim scales the result.
// ─────────────────────────────────────────────────────────────────────────────
import { Audio } from '../../audio/Audio.js';
import { Soundtrack } from '../../audio/soundtrack.js';
import { valleyImpulse, gain } from '../../audio/synth.js';
import { BIOME } from '../../world/WorldConfig.js';

/** Surface keys `WorldData.getSurfaceWeights` produces, in menu order. */
export const SURFACES = ['grass', 'dry', 'dirt', 'rock', 'sand', 'litter', 'snow'];

/** A pure surface mix, as the world would hand one to the vehicle. */
export function surfaceWeights(name, out = {}) {
  for (const k of SURFACES) out[k] = 0;
  out[name] = 1;
  // Litter is never zero in the real world — `getSurfaceWeights` returns
  // `clamp01(m * 0.6 + 0.2)` for it everywhere — so a "pure" surface still
  // carries the floor the tyre model actually sees.
  if (name !== 'litter') out.litter = 0.2;
  return out;
}

export class Rig {
  constructor() {
    this.audio = null;
    this.actx = null;
    this.trims = {};             // name -> GainNode inserted after a layer
    this.trimDb = {};            // name -> dB
    this.muted = {};             // name -> bool
    this.solo = null;            // name | null
    this.active = new Set();     // layers the selected sound is currently playing
    this._extra = {};            // name -> extra multiplier (distance overrides)

    // The shared listener sample, same shape as `Audio.L`.
    this.L = {
      x: 0, y: 0, z: 0, yaw: 0,
      hour: 13, wind: 1, speed: 0,
      open: 0.8, forest: 0.1, altitude: 0, indoors: 1,
      moisture: 0.4, biome: BIOME.MEADOW,
    };

    // Fake camper. `VehicleAudio.update` reads exactly these fields.
    this.veh = {
      phys: { ready: true },
      speed: 0,
      throttle: 0,
      forward: { y: 0 },
      position: { x: 0, y: 0, z: 0 },
      waterDepth: 0,
      wheels: [0, 1, 2, 3].map(() => ({ slip: 0, compression: 0, grounded: true })),
    };
    this.surface = 'dirt';
    this._surfOut = surfaceWeights(this.surface);

    // The single waterfall and the single river the fake world contains. Both
    // are rebuilt into `WaterAudio`'s tables when their size changes.
    this.fall = { height: 18, discharge: 0.45 };
    this.river = { flow: 0.5 };

    this.ctx = {
      camera: null,
      renderer: null,
      input: { axes: { handbrake: 0 } },
      poi: null,
      lighting: { hour: 13 },
      quality: 'high',
      systems: { vehicle: this.veh, wildlife: null, weather: null },
      world: {
        waterfalls: [this._fallRecord(), ...this._decoyFalls()],
        riverPolylines: [this._riverLine()],
        isInBounds: () => true,
        getBiome: () => BIOME.MEADOW,
        getMoisture: () => this.L.moisture,
        getHeight: () => 0,
        getSurfaceWeights: (x, z, out = {}) => Object.assign(out, this._surfOut),
        getWaterDepth: () => 0,
      },
    };
  }

  _fallRecord() {
    const h = this.fall.height;
    // Source at the origin; the listener is moved away from it by the distance
    // slider. `WaterAudio` listens a third of the way up the drop.
    return { top: [0, h, 0], bottom: [0, 0, 0], height: h, discharge: this.fall.discharge };
  }

  /**
   * Two inaudible waterfalls three kilometres away.
   *
   * Not padding for its own sake. `WaterAudio._assign` keeps the three loudest
   * falls, and with fewer falls than voices the "keep what you already have"
   * pass matches every idle voice against the `-1` in its wanted list and holds
   * all three on nothing — so a world with one waterfall in it is silent. That
   * cannot happen in the game (there are 28) and it is not this page's business
   * to change `water.js`, so the lab hands it a world it recognises: one fall
   * you are listening to, and two at 4.2 km that measure -110 dBFS.
   */
  _decoyFalls() {
    return [
      { top: [3000, 1, 3000], bottom: [3000, 0, 3000], height: 1, discharge: 0 },
      { top: [-3000, 1, -3000], bottom: [-3000, 0, -3000], height: 1, discharge: 0 },
    ];
  }

  _riverLine() {
    // Three points so the polyline is valid; `WaterAudio` thins by three, so
    // exactly one river point survives and the second voice stays silent. That
    // is what makes "one river, one distance" a measurable thing.
    const f = this.river.flow;
    return [{ x: 0, z: 0, flow: f }, { x: 2, z: 0, flow: f }, { x: 4, z: 0, flow: f }];
  }

  /**
   * Build the graph. Must be called from a real user gesture.
   * @returns {string} '' on success, or a human-readable reason.
   */
  start() {
    if (this.audio?.started) return '';
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return 'This browser has no Web Audio support.';

    const audio = new Audio(this.ctx);
    // The game persists volume/mute under `pa.audio`. Whatever the player last
    // set in the game is not what they want in a measurement tool, and writing
    // it back would change the game — so override in memory only.
    audio.volume = 0.8;
    audio.muted = false;

    // `Soundtrack` fetches a 5 MB mp3 from its constructor. The lab is meant to
    // open instantly, so the fetch is refused here and a fresh Soundtrack is
    // built on demand when its sound is selected.
    const realFetch = window.fetch;
    window.fetch = (...a) => (
      String(a[0]).includes('/audio/')
        ? Promise.reject(new Error('soundlab: deferred until selected'))
        : realFetch.apply(window, a)
    );
    try {
      audio._start();
    } finally {
      window.fetch = realFetch;
    }

    if (!audio.started) return 'The audio context refused to start (no output device?).';
    this.audio = audio;
    this.actx = audio.actx;
    window.__soundlab = this;          // for the headless harness

    this._insertTrims();
    return '';
  }

  /** Insert a trim gain after every layer output that solo/mute needs to reach. */
  _insertTrims() {
    const a = this.audio, actx = this.actx;
    const add = (name, node, dest) => {
      const t = gain(actx, 1);
      try { node.disconnect(dest); } catch { /* not connected the way we think */ }
      node.connect(t);
      t.connect(dest);
      this.trims[name] = t;
      this.trimDb[name] = 0;
      this.muted[name] = false;
    };

    const amb = a.ambience, bus = a.buses;
    add('grass', amb.grassGain, bus.ambience);
    add('conifer', amb.coniferGain, bus.ambience);
    add('hush', amb.hushGain, bus.ambience);
    add('cricket', amb.cricketGain, bus.ambience);
    add('birds', amb.birdBus, bus.ambience);

    add('falls', a.water.fallBus, a.water.bus);
    add('rivers', a.water.riverBus, a.water.bus);
    // Per-voice, so the distance-model override has somewhere to land.
    a.water.falls.forEach((v, i) => add(`fallVoice${i}`, v.out, v.pan));
    a.water.rivers.forEach((v, i) => add(`riverVoice${i}`, v.out, v.pan));

    const v = a.vehicle;
    add('engine', v.gEngine, v.bus);
    add('intake', v.gIntake, v.bus);
    add('overrun', v.gOver, v.bus);
    add('tyres', v.gTyre, v.bus);
    add('grit', v.gGrit, v.bus);
    add('ford', v.gWater, v.bus);

    add('wildlife', a.wildlife.bus, bus.wildlife);
    add('music', a.music.bus, bus.music);
  }

  /** Lazily build the authored bed — a 5 MB fetch nobody asked for on load. */
  async loadSoundtrack() {
    const a = this.audio;
    if (a.soundtrack && !a.soundtrack.failed) return a.soundtrack;
    const st = new Soundtrack(this.actx, a.buses.music, this.ctx);
    a.soundtrack = st;
    if (!this.trims.soundtrack) {
      const t = gain(this.actx, 1);
      try { st.duck.disconnect(a.buses.music); } catch { /* fresh node */ }
      st.duck.connect(t);
      t.connect(a.buses.music);
      this.trims.soundtrack = t;
      this.trimDb.soundtrack = 0;
      this.muted.soundtrack = false;
    } else {
      st.duck.disconnect();
      st.duck.connect(this.trims.soundtrack);
    }
    for (let i = 0; i < 120 && !st.state.loaded && !st.failed; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return st;
  }

  // ── solo / mute / trim ──────────────────────────────────────────────────

  setTrim(name, db) {
    this.trimDb[name] = db;
    this.applyTrims();
  }

  setMute(name, on) {
    this.muted[name] = !!on;
    this.applyTrims();
  }

  setSolo(name) {
    this.solo = this.solo === name ? null : name;
    this.applyTrims();
  }

  /**
   * One place decides a trim's realised value, so the four controls compose:
   * whether the selected sound is playing this layer at all, the player's mute,
   * the player's solo, and the trim itself.
   */
  applyTrims(names = Object.keys(this.trims)) {
    const t = this.actx?.currentTime ?? 0;
    for (const n of names) {
      const node = this.trims[n];
      if (!node) continue;
      const off = !this.active.has(n)
        || this.muted[n]
        || (this.solo && this.solo !== n && this._sibling(n));
      const v = off ? 0 : 10 ** ((this.trimDb[n] ?? 0) / 20) * (this._extra[n] ?? 1);
      node.gain.setTargetAtTime(v, t, 0.02);
    }
  }

  /** Which layers are audible right now. Everything else is trimmed to zero. */
  setActive(names) {
    this.active = new Set(names);
    this.applyTrims();
  }

  /**
   * Solo only silences layers in the same rig — soloing the grass bed should
   * not silence the waterfall you deliberately have running beside it.
   */
  _sibling(name) {
    const groupOf = (n) => {
      if (['grass', 'conifer', 'hush', 'cricket', 'birds'].includes(n)) return 'ambience';
      if (n.startsWith('fall') || n.startsWith('river')) return 'water';
      if (['engine', 'intake', 'overrun', 'tyres', 'grit', 'ford'].includes(n)) return 'vehicle';
      return n;
    };
    return groupOf(name) === groupOf(this.solo);
  }

  /** Extra multipliers a sound applies on top of the trim (distance overrides). */
  setExtra(name, mul) {
    if (this._extra[name] === mul) return;
    this._extra[name] = mul;
    this.applyTrims([name]);
  }

  // ── world mutation ──────────────────────────────────────────────────────

  setSurface(name) {
    this.surface = name;
    surfaceWeights(name, this._surfOut);
  }

  /**
   * Rebuild the waterfall/river tables in place.
   *
   * `WaterAudio` flattens the world into typed arrays in its constructor, so
   * changing a fall's height means recomputing those entries — with the same
   * two expressions the constructor uses, which is the one piece of arithmetic
   * this file mirrors rather than calls. It is two lines and it is commented at
   * both ends; the alternative is rebuilding the whole voice pool (and its
   * noise buffers) on every drag of a slider.
   */
  refreshWater() {
    const w = this.audio?.water;
    if (!w) return;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const { height, discharge } = this.fall;
    const h = Math.max(1, Math.min(60, height));
    const disc = clamp01(discharge);
    if (w.wfN > 0) {
      w.wfX[0] = 0; w.wfY[0] = h * 0.33; w.wfZ[0] = 0;
      // Mirrors src/audio/water.js:127-130. Keep in step with it.
      w.wfSize[0] = clamp01(disc * 0.62 + (h / 40) * 0.5);
      w.wfRef[0] = 26 + h * 1.7 + disc * 44;
    }
    if (w.rvN > 0) w.rvF[0] = clamp01(this.river.flow);
    this.ctx.world.waterfalls[0] = this._fallRecord();
  }

  /**
   * The voice currently pointed at the fall you are listening to, and its
   * index — which is what the trim node is named after. The pool re-points
   * itself, so neither is assumed.
   */
  fallVoiceIndex() {
    const i = this.audio?.water?.falls?.findIndex((v) => v.target === 0) ?? -1;
    return i < 0 ? 0 : i;
  }
  fallVoice() { return this.audio.water.falls[this.fallVoiceIndex()]; }
  riverVoiceIndex() {
    const i = this.audio?.water?.rivers?.findIndex((v) => v.target === 0) ?? -1;
    return i < 0 ? 0 : i;
  }
  riverVoice() { return this.audio.water.rivers[this.riverVoiceIndex()]; }

  /** The reference distance the fall currently carries, for the UI readout. */
  fallRef() { return this.audio?.water?.wfRef?.[0] ?? 0; }
  riverRef() { return 16 + Math.max(0, Math.min(1, this.river.flow)) * 34; }

  /** Rebuild the shared reverb impulse (not a live-settable param otherwise). */
  setReverb(seconds, decay) {
    if (!this.audio?.reverb) return;
    const c = valleyImpulse(this.actx, seconds, decay);
    this.audio.reverb.buffer = c.buffer;
  }

  setMasterVolume(v) {
    // Deliberately not `audio.setVolume`, which persists to localStorage.
    this.audio.volume = v;
    this.audio._applyVolume(0.05);
  }

  /** Stop everything audible right now, without tearing the graph down. */
  panic() {
    const a = this.audio;
    if (!a) return;
    this.active.clear();
    this.applyTrims();
    a.soundtrack?._stop?.();
    if (a.music) a.music._queue.length = 0;
  }
}

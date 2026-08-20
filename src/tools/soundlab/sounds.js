// ─────────────────────────────────────────────────────────────────────────────
//  Sound Lab — the catalogue.
//
//  Every generated sound in the game, with every parameter this page can
//  actually reach on the running graph. Two rules held throughout:
//
//   1. **The names are the real names.** A control labelled `coniferBand.Hz`
//      writes `Ambience.coniferBand.frequency`, and the JSON this page emits
//      uses that path — so a config pasted back into `src/audio/*` means
//      exactly what it says. Where a value is a hard-coded constant the page
//      cannot reach, it is marked `needs:` and listed in
//      `docs/INTEGRATION_REQUESTS.md` rather than quietly faked.
//   2. **Conditions and parameters are different things.** A distance, a
//      surface, a wind strength, an hour: those are the *situation* the sound
//      is being judged in, not settings to paste anywhere. They are emitted
//      under `conditions`, so a config you hand to someone says both what you
//      changed and what you were listening to when you changed it.
//
//  Two kinds of transport, because the sounds are two kinds of thing: beds get
//  play/stop and are driven by their module's own `update()` every frame,
//  one-shots get a trigger button and call the module's own generator.
// ─────────────────────────────────────────────────────────────────────────────
import { SURFACES } from './rig.js';
import { tanhCurve } from '../../audio/synth.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ── little builders, so the table below reads as data ────────────────────────

/** A continuous control. `def` is the value the code ships with. */
const range = (key, label, min, max, def, opt = {}) => ({
  type: 'range', kind: 'param', key, label, min, max, def,
  step: opt.step ?? (max - min) / 200,
  unit: opt.unit ?? '',
  src: opt.src ?? null,
  needs: opt.needs ?? null,
  group: opt.group ?? 'Voice',
  apply: opt.apply ?? null,
  fmt: opt.fmt ?? null,
});

/** A control that describes the listening situation rather than the code. */
const cond = (key, label, min, max, def, opt = {}) =>
  ({ ...range(key, label, min, max, def, opt), kind: 'condition', group: opt.group ?? 'Situation' });

const toggle = (key, label, def, opt = {}) => ({
  type: 'toggle', kind: opt.kind ?? 'param', key, label, def,
  group: opt.group ?? 'Voice', src: opt.src ?? null, needs: opt.needs ?? null,
  apply: opt.apply ?? null,
});

const select = (key, label, options, def, opt = {}) => ({
  type: 'select', kind: opt.kind ?? 'condition', key, label, options, def,
  group: opt.group ?? 'Situation', src: opt.src ?? null, needs: opt.needs ?? null,
  apply: opt.apply ?? null,
});

/** A number the model computes. Shown, never set. */
const readout = (key, label, read, opt = {}) => ({
  type: 'readout', kind: 'readout', key, label, read,
  unit: opt.unit ?? '', group: opt.group ?? 'Model', src: opt.src ?? null,
});

// Shorthand for the common "write an AudioParam" apply.
const P = (path) => (rig, v) => {
  const node = path.split('.').reduce((o, k) => o?.[k], rig.audio);
  if (node && typeof node === 'object' && 'value' in node) node.value = v;
};

// ── shared condition sets ───────────────────────────────────────────────────

const WIND = cond('wind', 'Weather wind / gust', 0.35, 2.2, 1.0, {
  step: 0.01, src: 'Audio.L.wind — Weather.windScale, clamped 0.35 … 2.2',
});
const HOUR = cond('hour', 'Hour of day', 0, 24, 13, { step: 0.1, unit: 'h' });
const OPEN = cond('open', 'Open ground weight', 0, 1, 0.8, { step: 0.01, src: 'Audio.L.open' });
const FOREST = cond('forest', 'Forest weight', 0, 1, 0.1, { step: 0.01, src: 'Audio.L.forest' });
const ALT = cond('altitude', 'Altitude weight', 0, 1, 0, { step: 0.01, src: 'Audio.L.altitude' });
const INDOORS = cond('indoors', 'Indoors factor', 0, 1, 1, { step: 0.01, src: 'Audio.L.indoors' });

/** Push the lab's condition sliders into the shared listener sample. */
function applyListener(rig, v) {
  const L = rig.L;
  if (v.wind !== undefined) L.wind = v.wind;
  if (v.hour !== undefined) L.hour = v.hour;
  if (v.open !== undefined) L.open = v.open;
  if (v.forest !== undefined) L.forest = v.forest;
  if (v.altitude !== undefined) L.altitude = v.altitude;
  if (v.indoors !== undefined) L.indoors = v.indoors;
}

const ambienceFrame = (rig, dt, v) => {
  applyListener(rig, v);
  rig.audio.ambience.update(dt, rig.L);
};

// The ambience bed's five layers, as the mixer names them.
//
// `model` is only ever filled in where the module's state field is *the same
// quantity* as the AudioParam beside it — the gain the mixer asked for. That is
// the comparison that catches an LFO eating a layer's level, and it is worth
// nothing if it is allowed to compare a call rate or a load fraction to a gain
// and cry wolf. Where they are different quantities the layer carries `null`
// and the reading is the meter's job.
const AMB_LAYERS = [
  { name: 'grass', label: 'wind / dry grass', model: (a) => a.state.grass, param: (a) => a.grassGain.gain },
  { name: 'conifer', label: 'wind / conifers', model: (a) => a.state.conifer, param: (a) => a.coniferGain.gain },
  { name: 'hush', label: 'altitude hush', model: (a) => a.state.hush, param: (a) => a.hushGain.gain },
  { name: 'cricket', label: 'crickets', model: (a) => a.state.cricket, param: (a) => a.cricketGain.gain },
  // state.birdRate is calls per second, not a gain — see the note above.
  { name: 'birds', label: 'birdsong (bus)', model: null, param: (a) => a.birdBus.gain },
];

const ambLayer = (n) => AMB_LAYERS.filter((l) => (n ? l.name === n : true))
  .map((l) => ({ ...l, get: (rig) => rig.audio.ambience }));

// ── water helpers ───────────────────────────────────────────────────────────

/** Distance from the listener to the one waterfall, exactly as water.js takes it. */
function fallDistance(rig) {
  const w = rig.audio.water, L = rig.L;
  if (!w.wfN) return 0;
  const dx = w.wfX[0] - L.x, dy = (w.wfY[0] - L.y) * 0.6, dz = w.wfZ[0] - L.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function riverDistance(rig) {
  const w = rig.audio.water, L = rig.L;
  if (!w.rvN) return 0;
  const dx = w.rvX[0] - L.x, dz = w.rvZ[0] - L.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Place the listener at `d` metres and `az` radians from the origin source. */
function placeListener(rig, d, azDeg) {
  const az = (azDeg * Math.PI) / 180;
  rig.L.x = -Math.sin(az) * d;
  rig.L.z = -Math.cos(az) * d;
  rig.L.y = 0;
  rig.L.yaw = 0;
}

/**
 * The distance-curve overrides.
 *
 * `water.js` computes `0.42 * size * (ref/(ref+d))^1.5` and writes it straight
 * into the voice's own gain, so neither the base nor the exponent can be set
 * from outside. Rather than reimplement the model (which would drift the moment
 * anyone touched it), the lab re-exponentiates: the trim node after the voice
 * carries `(base/0.42) * (ref/(ref+d))^(exp-1.5)`, which is algebraically the
 * same signal the module would produce with those constants. Both are listed as
 * needing exposure.
 */
function fallOverride(rig, v) {
  const ref = rig.fallRef();
  const d = fallDistance(rig);
  const shape = Math.pow(ref / (ref + d), (v.fallExp ?? 1.5) - 1.5);
  rig.setExtra(`fallVoice${rig.fallVoiceIndex()}`, ((v.fallBase ?? 0.42) / 0.42) * shape);
}
function riverOverride(rig, v) {
  const ref = rig.riverRef();
  const d = riverDistance(rig);
  const shape = Math.pow(ref / (ref + d), (v.riverExp ?? 2.6) - 2.6);
  rig.setExtra(`riverVoice${rig.riverVoiceIndex()}`, ((v.riverBase ?? 0.20) / 0.20) * shape);
}

// ── vehicle helpers ─────────────────────────────────────────────────────────

function applyVehicle(rig, v) {
  const veh = rig.veh;
  veh.speed = v.speed ?? 0;
  veh.throttle = v.throttle ?? 0;
  veh.forward.y = v.grade ?? 0;
  veh.waterDepth = v.depth ?? 0;
  for (const w of veh.wheels) w.slip = v.slip ?? 0;
  if (v.surface) rig.setSurface(v.surface);
}
const vehicleFrame = (rig, dt, v) => {
  applyVehicle(rig, v);
  rig.audio.vehicle.update(dt, rig.L);
};

const VEH_LAYERS = [
  { name: 'engine', label: 'combustion', model: null, param: (a) => a.gEngine.gain },
  { name: 'intake', label: 'intake', model: null, param: (a) => a.gIntake.gain },
  { name: 'overrun', label: 'overrun', model: null, param: (a) => a.gOver.gain },
  { name: 'tyres', label: 'tyre roll', model: null, param: (a) => a.gTyre.gain },
  { name: 'grit', label: 'grit', model: null, param: (a) => a.gGrit.gain },
  { name: 'ford', label: 'fording', model: null, param: (a) => a.gWater.gain },
];
const vehLayer = (...names) => VEH_LAYERS.filter((l) => names.includes(l.name))
  .map((l) => ({ ...l, get: (rig) => rig.audio.vehicle }));

// ─────────────────────────────────────────────────────────────────────────────
//  The catalogue
// ─────────────────────────────────────────────────────────────────────────────

export const SOUNDS = [
  // ── ambience ──────────────────────────────────────────────────────────────
  {
    id: 'ambience.grass',
    group: 'Ambience',
    label: 'Wind over dry grass',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'Layer 1. A band around 820 Hz is the dry rustle; the shelf under it '
      + 'is the body of moving air. Level is 0.235 · openness · strength · indoors.',
    layers: ['grass'],
    meterLayers: ambLayer('grass'),
    frame: ambienceFrame,
    params: [
      WIND, { ...OPEN, def: 0.9 }, ALT, INDOORS,
      readout('mGrass', 'model gain', (r) => r.audio.ambience.state.grass, { src: 'ambience.js:191' }),
      readout('mGrassF', 'grassLow cutoff', (r) => r.audio.ambience.grassLow.frequency.value, { unit: 'Hz', src: 'ambience.js:219 — 740 + breeze·540' }),
      range('grassBandHz', 'grassBand centre', 200, 2200, 820, { unit: 'Hz', step: 1, src: 'ambience.js:98', apply: P('ambience.grassBand.frequency') }),
      range('grassBandQ', 'grassBand Q', 0.1, 4, 0.55, { step: 0.01, src: 'ambience.js:98', apply: P('ambience.grassBand.Q') }),
      range('grassLow2Hz', 'grassLow2 cutoff', 300, 6000, 1500, { unit: 'Hz', step: 1, src: 'ambience.js:103', apply: P('ambience.grassLow2.frequency') }),
      range('grassLow2Q', 'grassLow2 Q', 0.1, 4, 0.5, { step: 0.01, src: 'ambience.js:103', apply: P('ambience.grassLow2.Q') }),
      range('grassLowQ', 'grassLow Q', 0.1, 4, 0.7, { step: 0.01, src: 'ambience.js:102', apply: P('ambience.grassLow.Q') }),
      range('grassRate', 'noise playback rate', 0.4, 1.6, 1.0, { step: 0.01, src: 'ambience.js:97', apply: (r, v) => { r.audio.ambience.grassSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js:191 — the 0.235 grass level constant is inline in update().',
      'ambience.js:104 — grassSwell rate 0.037 Hz / depth 0.55: swell() discards its LFO handle.',
      'ambience.js:108 — the 0.061 Hz / 210 Hz band LFO handle is discarded.',
      'ambience.js:185-186 — the breeze curve (0.32, 0.94, 0.26 + 0.88·b²).',
    ],
  },
  {
    id: 'ambience.conifer',
    group: 'Ambience',
    label: 'Wind through conifers',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'Layer 2. Needles hiss higher than grass and have almost no low end. '
      + 'The most fatigue-prone layer in the game — watch the ≥2 kHz bite.',
    layers: ['conifer'],
    meterLayers: ambLayer('conifer'),
    frame: ambienceFrame,
    params: [
      WIND, { ...FOREST, def: 0.85 }, INDOORS,
      readout('mConifer', 'model gain', (r) => r.audio.ambience.state.conifer, { src: 'ambience.js:195' }),
      range('coniferBandHz', 'coniferBand centre', 400, 5000, 1850, { unit: 'Hz', step: 1, src: 'ambience.js:117', apply: P('ambience.coniferBand.frequency') }),
      range('coniferBandQ', 'coniferBand Q', 0.1, 4, 0.7, { step: 0.01, src: 'ambience.js:117', apply: P('ambience.coniferBand.Q') }),
      range('coniferHiHz', 'coniferHi cutoff', 100, 2000, 620, { unit: 'Hz', step: 1, src: 'ambience.js:118', apply: P('ambience.coniferHi.frequency') }),
      range('coniferCapHz', 'coniferCap cutoff', 800, 12000, 3200, { unit: 'Hz', step: 10, src: 'ambience.js:119', apply: P('ambience.coniferCap.frequency') }),
      range('coniferRate', 'noise playback rate', 0.4, 1.6, 0.93, { step: 0.01, src: 'ambience.js:116', apply: (r, v) => { r.audio.ambience.coniferSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js:195 — the 0.165 conifer level constant is inline in update().',
      'ambience.js:120 — coniferSwell rate 0.029 Hz / depth 0.58.',
    ],
  },
  {
    id: 'ambience.hush',
    group: 'Ambience',
    label: 'Hush at altitude',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'Layer 3. Nearly all sub-500 Hz, where the ear gives up 9 dB — so it '
      + 'carries a higher number for the same loudness. Check it A-weighted.',
    layers: ['hush'],
    meterLayers: ambLayer('hush'),
    frame: ambienceFrame,
    params: [
      WIND, { ...ALT, def: 0.85 }, 
      readout('mHush', 'model gain', (r) => r.audio.ambience.state.hush, { src: 'ambience.js:199' }),
      range('hushLowHz', 'hushLow cutoff', 80, 1200, 320, { unit: 'Hz', step: 1, src: 'ambience.js:131', apply: P('ambience.hushLow.frequency') }),
      range('hushLowQ', 'hushLow Q', 0.1, 4, 0.8, { step: 0.01, src: 'ambience.js:131', apply: P('ambience.hushLow.Q') }),
      range('hushRate', 'noise playback rate', 0.3, 1.4, 0.61, { step: 0.01, src: 'ambience.js:130', apply: (r, v) => { r.audio.ambience.hushSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js:199 — the 0.180 hush level constant and its lerp(0.55, 1.15, breeze).',
      'ambience.js:132 — hushSwell rate 0.023 Hz / depth 0.48.',
    ],
  },
  {
    id: 'ambience.crickets',
    group: 'Ambience',
    label: 'Crickets',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'Layer 4. Nine individuals rendered once into an 8 s seamless bed. '
      + 'Dusk and the hour before dawn only — set the hour to 18.5 to hear them.',
    layers: ['cricket'],
    meterLayers: ambLayer('cricket'),
    frame: ambienceFrame,
    params: [
      { ...HOUR, def: 20.0 }, { ...OPEN, def: 1 }, FOREST, ALT, INDOORS,
      readout('mCricket', 'model gain', (r) => r.audio.ambience.state.cricket, { src: 'ambience.js:210' }),
      range('cricketBandHz', 'cricketBand centre', 1500, 8000, 4300, { unit: 'Hz', step: 10, src: 'ambience.js:139', apply: P('ambience.cricketBand.frequency') }),
      range('cricketBandQ', 'cricketBand Q', 0.1, 6, 1.1, { step: 0.01, src: 'ambience.js:139', apply: P('ambience.cricketBand.Q') }),
      range('cricketRate', 'bed playback rate', 0.6, 1.4, 1.0, { step: 0.01, src: 'ambience.js:138', apply: (r, v) => { r.audio.ambience.cricketSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js:210 — the 0.075 cricket level constant.',
      'ambience.js:43-49 — cricketBed(): 9 individuals, 3900-5400 Hz, period 0.30-0.72 s.',
      'ambience.js:204-205 — the dusk / pre-dawn smoothstep windows.',
    ],
  },
  {
    id: 'ambience.birds',
    group: 'Ambience',
    label: 'Birdsong',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'Layer 5, and the only scheduled one: four species as (pitch, bend, '
      + 'shape) recipes. Play to hear the modelled call rate, or trigger one.',
    layers: ['birds'],
    meterLayers: ambLayer('birds'),
    frame: ambienceFrame,
    trigger: (rig, v) => rig.audio.ambience._call(rig.L, v.chorus ?? 0.5),
    triggerLabel: 'Trigger one call',
    params: [
      { ...HOUR, def: 6.2 }, { ...FOREST, def: 0.9 }, OPEN, ALT, INDOORS,
      cond('chorus', 'Dawn-chorus weight (trigger)', 0, 1, 0.5, { step: 0.01, src: 'ambience.js:253 — raises the chance of a near call' }),
      readout('mRate', 'model call rate', (r) => r.audio.ambience.state.birdRate, { unit: '/s', src: 'ambience.js:233' }),
      range('birdBus', 'birdBus gain', 0, 2, 0.78, { step: 0.01, src: 'ambience.js:147', apply: P('ambience.birdBus.gain') }),
      range('birdWet', 'birdWet reverb send', 0, 1, 0.34, { step: 0.01, src: 'ambience.js:149', apply: P('ambience.birdWet.gain') }),
    ],
    needs: [
      'ambience.js:20-25 — the BIRDS species table (f, bend, n, dur, gap, kind).',
      'ambience.js:233 — the call-rate curve (0.20 + chorus·1.5)·(0.35 + day·0.65).',
      'ambience.js:255 — near/far call levels 0.16 / 0.055.',
    ],
  },
  {
    id: 'ambience.bed',
    group: 'Ambience',
    label: 'Full ambience bed',
    kind: 'bed',
    bus: 'ambience',
    module: 'src/audio/ambience.js',
    blurb: 'All five layers together, with the mix as the game builds it. This '
      + 'is the page to take the bed apart on: solo one layer, or zero them all '
      + 'and confirm the bus really does go quiet.',
    layers: ['grass', 'conifer', 'hush', 'cricket', 'birds'],
    meterLayers: ambLayer(),
    frame: ambienceFrame,
    params: [WIND, HOUR, OPEN, FOREST, ALT, INDOORS,
      range('ambienceBus', 'ambience bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:129', apply: P('buses.ambience.gain') })],
    needs: [],
  },

  // ── water ─────────────────────────────────────────────────────────────────
  {
    id: 'water.waterfall',
    group: 'Water',
    label: 'Waterfall',
    kind: 'bed',
    bus: 'falls',
    module: 'src/audio/water.js',
    blurb: 'One fall, one listener, one distance. Size sets the character and '
      + 'distance sets the level and the air absorption — drag the distance '
      + 'slider and watch both the meter and the spectrum tilt fall away.',
    layers: ['falls', 'fallVoice0', 'fallVoice1', 'fallVoice2'],
    meterLayers: [{
      name: 'falls', label: 'fall voice 0',
      get: (rig) => rig.audio.water,
      model: (w) => w.falls.find((x) => x.target === 0)?.level ?? 0,
      param: (w) => w.falls[0].out.gain,
    }],
    frame: (rig, dt, v) => {
      placeListener(rig, v.distance, v.azimuth);
      rig.audio.water.update(dt, rig.L);
      fallOverride(rig, v);
    },
    onParam: (rig, key, v) => { if (key === 'height' || key === 'discharge') { rig.fall.height = v.height; rig.fall.discharge = v.discharge; rig.refreshWater(); } },
    params: [
      cond('distance', 'Distance to the fall', 2, 700, 60, { unit: 'm', step: 1 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 35, { unit: '°', step: 1 }),
      cond('height', 'Fall height', 1, 60, 18, { unit: 'm', step: 0.5, src: 'world waterfall.height — drives wfSize and wfRef' }),
      cond('discharge', 'Fall discharge', 0, 1, 0.45, { step: 0.01, src: 'world waterfall.discharge' }),
      readout('ref', 'reference distance', (r) => r.fallRef(), { unit: 'm', src: 'water.js:130 — 26 + h·1.7 + disc·44' }),
      readout('size', 'wfSize', (r) => r.audio.water.wfSize[0], { src: 'water.js:127' }),
      readout('vlevel', 'voice gain (model)', (r) => r.fallVoice().level, { src: 'water.js:256' }),
      readout('air', 'air-absorption cutoff', (r) => r.fallVoice().air.frequency.value, { unit: 'Hz', src: 'water.js:263 — 17000·e^(-d/210)' }),
      range('fallBase', 'distance-curve base', 0.05, 1.2, 0.42, { step: 0.005, group: 'Distance model', src: 'water.js:256', needs: 'inline constant — the lab re-exponentiates the voice trim to match' }),
      range('fallExp', 'distance-curve exponent', 0.6, 3.2, 1.5, { step: 0.02, group: 'Distance model', src: 'water.js:256', needs: 'inline constant — moved 1.6 → 1.42 → 2.4 → 1.5 already' }),
      range('lowHz', 'low band cutoff', 60, 600, 190, { unit: 'Hz', step: 1, src: 'water.js:30', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.low.frequency.value = v; }); } }),
      range('bodyHz', 'body band centre', 200, 2500, 620, { unit: 'Hz', step: 1, src: 'water.js:31', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.body.frequency.value = v; }); } }),
      range('bodyQ', 'body band Q', 0.1, 3, 0.5, { step: 0.01, src: 'water.js:31', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.body.Q.value = v; }); } }),
      range('hissHz', 'hiss highpass', 800, 8000, 2600, { unit: 'Hz', step: 10, src: 'water.js:32', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.hiss.frequency.value = v; }); } }),
      range('gBody', 'body band gain', 0, 2, 0.8, { step: 0.01, src: 'water.js:34', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.gBody.gain.value = v; }); } }),
      range('fallBus', 'fallBus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'water.js:90', apply: P('water.fallBus.gain') }),
      range('waterBus', 'water bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:130', apply: P('buses.water.gain') }),
    ],
    needs: [
      'water.js:256 — the 0.42 base and 1.5 exponent of the fall distance curve.',
      'water.js:263 — air absorption 17000·e^(-d/210), clamped 620 … 16000.',
      'water.js:266-267 — the low/hiss distance blends.',
      'water.js:54 — the per-voice swell (0.043 Hz + rand, depth 0.34).',
      'water.js:22 — FALL_VOICES = 3.',
    ],
  },
  {
    id: 'water.river',
    group: 'Water',
    label: 'River / creek',
    kind: 'bed',
    bus: 'rivers',
    module: 'src/audio/water.js',
    blurb: 'The same voice with different numbers: white noise instead of pink, '
      + 'almost no low band, a much steeper falloff (2.6) so a creek is gone in '
      + 'eighty metres rather than six hundred.',
    layers: ['rivers', 'riverVoice0', 'riverVoice1'],
    meterLayers: [{
      name: 'rivers', label: 'river voice 0',
      get: (rig) => rig.audio.water,
      model: (w) => w.rivers.find((x) => x.target === 0)?.level ?? 0,
      param: (w) => w.rivers[0].out.gain,
    }],
    frame: (rig, dt, v) => {
      placeListener(rig, v.distance, v.azimuth);
      rig.audio.water.update(dt, rig.L);
      riverOverride(rig, v);
    },
    onParam: (rig, key, v) => { if (key === 'flow') { rig.river.flow = v.flow; rig.refreshWater(); } },
    params: [
      cond('distance', 'Distance to the water', 1, 200, 25, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 20, { unit: '°', step: 1 }),
      cond('flow', 'Flow at this point', 0.05, 1, 0.5, { step: 0.01, src: 'river polyline point .flow' }),
      readout('ref', 'reference distance', (r) => r.riverRef(), { unit: 'm', src: 'water.js:281 — 16 + flow·34' }),
      readout('vlevel', 'voice gain (model)', (r) => r.riverVoice().level, { src: 'water.js:282' }),
      readout('air', 'air-absorption cutoff', (r) => r.riverVoice().air.frequency.value, { unit: 'Hz', src: 'water.js:287' }),
      range('riverBase', 'distance-curve base', 0.02, 0.8, 0.20, { step: 0.005, group: 'Distance model', src: 'water.js:282', needs: 'inline constant' }),
      range('riverExp', 'distance-curve exponent', 0.8, 4.5, 2.6, { step: 0.02, group: 'Distance model', src: 'water.js:282', needs: 'inline constant' }),
      range('bodyHz', 'body band centre', 300, 4000, 1150, { unit: 'Hz', step: 5, src: 'water.js:31', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.body.frequency.value = v; }); } }),
      range('bodyQ', 'body band Q', 0.1, 3, 0.7, { step: 0.01, src: 'water.js:31', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.body.Q.value = v; }); } }),
      range('hissHz', 'hiss highpass', 1000, 9000, 3400, { unit: 'Hz', step: 10, src: 'water.js:32', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.hiss.frequency.value = v; }); } }),
      range('gLow', 'low band gain', 0, 1, 0.12, { step: 0.005, src: 'water.js:33 — rivers start at 0.12', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.gLow.gain.value = v; }); } }),
      range('gBody', 'body band gain', 0, 2, 0.8, { step: 0.01, src: 'water.js:34', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.gBody.gain.value = v; }); } }),
      range('riverBus', 'riverBus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'water.js:91', apply: P('water.riverBus.gain') }),
      range('waterBus', 'water bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:130', apply: P('buses.water.gain') }),
    ],
    needs: [
      'water.js:282 — the 0.20 base and 2.6 exponent of the river distance curve.',
      'water.js:23 — RIVER_VOICES = 2.',
      'water.js:209 — the 2500 m² "same stretch" rejection radius.',
    ],
  },

  // ── vehicle ───────────────────────────────────────────────────────────────
  {
    id: 'vehicle.engine',
    group: 'Vehicle',
    label: 'Engine (combustion, intake, overrun)',
    kind: 'bed',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Nothing here is driven by speed: an rpm runs through a five-speed '
      + 'box, load knows whether you are climbing, and the firing frequency '
      + 'falls out of that. Lift the throttle at revs for the overrun.',
    layers: ['engine', 'intake', 'overrun'],
    meterLayers: vehLayer('engine', 'intake', 'overrun'),
    frame: vehicleFrame,
    params: [
      cond('throttle', 'Throttle', 0, 1, 0.35, { step: 0.01 }),
      cond('speed', 'Road speed', 0, 30, 8, { unit: 'm/s', step: 0.1 }),
      cond('grade', 'Gradient (forward.y)', -0.6, 0.6, 0, { step: 0.01, src: 'vehicle_audio.js:231' }),
      readout('rpm', 'rpm', (r) => r.audio.vehicle.state.rpm, { src: 'vehicle_audio.js:25 — idle 760, max 4200' }),
      readout('gear', 'gear', (r) => r.audio.vehicle.state.gear, { src: 'vehicle_audio.js:29 — 15.2 / 9.4 / 6.3 / 4.5 / 3.4' }),
      readout('f0', 'firing frequency', (r) => r.audio.vehicle.state.f0, { unit: 'Hz' }),
      readout('load', 'load', (r) => r.audio.vehicle.state.load, { src: 'vehicle_audio.js:232' }),
      readout('lp', 'engineLP cutoff', (r) => r.audio.vehicle.engineLP.frequency.value, { unit: 'Hz', src: 'vehicle_audio.js:243 — 340 + rpmN·2600 + load·1500' }),
      readout('cab', 'cabLP cutoff', (r) => r.audio.vehicle.cabLP.frequency.value, { unit: 'Hz', src: 'vehicle_audio.js:258 — 520 + rpmN·640 + load·1050' }),
      range('gOsc1', 'fundamental gain', 0, 2, 0.9, { step: 0.01, src: 'vehicle_audio.js:71', apply: P('vehicle.gOsc1.gain') }),
      range('gOsc2', 'octave gain', 0, 2, 0.35, { step: 0.01, src: 'vehicle_audio.js:72', apply: P('vehicle.gOsc2.gain') }),
      range('detune', 'osc2 detune', -50, 50, 9, { unit: 'cents', step: 1, src: 'vehicle_audio.js:70', apply: (r, v) => { r.audio.vehicle.osc2.detune.value = v; } }),
      range('engineHP', 'engineHP cutoff', 10, 200, 30, { unit: 'Hz', step: 1, src: 'vehicle_audio.js:83', apply: P('vehicle.engineHP.frequency') }),
      range('engineLPQ', 'engineLP Q', 0.1, 6, 1.3, { step: 0.01, src: 'vehicle_audio.js:77', apply: P('vehicle.engineLP.Q') }),
      range('cabQ', 'cabLP Q', 0.1, 3, 0.5, { step: 0.01, src: 'vehicle_audio.js:94', apply: P('vehicle.cabLP.Q') }),
      range('driveSoft', 'saturation, unloaded', 0.5, 5, 1.5, { step: 0.05, src: 'vehicle_audio.js:86 / 252', apply: (r, v) => { const x = r.audio.vehicle; x._softCurve = tanhCurve(v); if (!x._hardOn) x.drive.curve = x._softCurve; } }),
      range('driveHard', 'saturation, loaded', 0.5, 6, 2.6, { step: 0.05, src: 'vehicle_audio.js:251', apply: (r, v) => { const x = r.audio.vehicle; x._hardCurve = tanhCurve(v); if (x._hardOn) x.drive.curve = x._hardCurve; } }),
      range('intakeQ', 'intakeBand Q', 0.2, 8, 2.6, { step: 0.05, src: 'vehicle_audio.js:111', apply: P('vehicle.intakeBand.Q') }),
      range('overHz', 'overrun lowpass', 200, 3000, 700, { unit: 'Hz', step: 5, src: 'vehicle_audio.js:117', apply: P('vehicle.overLP.frequency') }),
      range('overRate', 'overrun noise rate', 0.4, 1.6, 0.83, { step: 0.01, src: 'vehicle_audio.js:116', apply: (r, v) => { r.audio.vehicle.overSrc.playbackRate.value = v; } }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: [
      'vehicle_audio.js:273 — the engine level curve 0.0105 + rpmN·0.021 + load·0.030.',
      'vehicle_audio.js:25-29 — IDLE_RPM, MAX_RPM and the GEARS table are module-private.',
      'vehicle_audio.js:205-206 — the 3050 / 1250 rpm shift points.',
      'vehicle_audio.js:278 — intake level 0.016; :283 — overrun level 0.017.',
      'vehicle_audio.js:41-47 — engineWave(): 16 harmonics at 1/h^1.9, even orders ×1.5.',
    ],
  },
  {
    id: 'vehicle.tyres',
    group: 'Vehicle',
    label: 'Tyres on a surface',
    kind: 'bed',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Two bands: a soft roll under the van and a grit layer that only '
      + 'exists on loose ground. Switch between grass and rock at a fixed speed '
      + 'and compare the A-weighted total — grass should be the quieter one.',
    layers: ['tyres', 'grit'],
    meterLayers: vehLayer('tyres', 'grit'),
    frame: vehicleFrame,
    params: [
      select('surface', 'Surface under the wheels', SURFACES, 'dirt', { src: 'WorldData.getSurfaceWeights' }),
      cond('speed', 'Road speed', 0, 30, 10, { unit: 'm/s', step: 0.1 }),
      cond('slip', 'Wheel slip (scrub)', 0, 1, 0, { step: 0.01, src: 'vehicle_audio.js:291' }),
      readout('roll', 'roll model', (r) => r.audio.vehicle.state.tyre, { src: 'vehicle_audio.js:294' }),
      readout('tyreF', 'tyreBand centre', (r) => r.audio.vehicle.tyreBand.frequency.value, { unit: 'Hz', src: 'vehicle_audio.js:302' }),
      readout('surfClass', 'surface class', (r) => r.audio.vehicle.state.surface),
      range('tyreQ', 'tyreBand Q', 0.1, 4, 0.8, { step: 0.01, src: 'vehicle_audio.js:131', apply: P('vehicle.tyreBand.Q') }),
      range('tyreLP', 'tyre lowpass', 300, 6000, 1500, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:132', apply: P('vehicle.tyreLP.frequency') }),
      range('tyreRate', 'tyre noise rate', 0.4, 1.6, 0.9, { step: 0.01, src: 'vehicle_audio.js:130', apply: (r, v) => { r.audio.vehicle.tyreSrc.playbackRate.value = v; } }),
      range('gritHP', 'grit highpass', 500, 8000, 2000, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:140', apply: P('vehicle.gritHP.frequency') }),
      range('gritCap', 'grit lowpass cap', 2000, 16000, 6500, { unit: 'Hz', step: 50, src: 'vehicle_audio.js:141', apply: P('vehicle.gritCap.frequency') }),
      range('gritRate', 'grit noise rate', 0.5, 2, 1.31, { step: 0.01, src: 'vehicle_audio.js:139', apply: (r, v) => { r.audio.vehicle.gritSrc.playbackRate.value = v; } }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: [
      'vehicle_audio.js:294 — roll = smoothstep(0.4, 5, speed)·(0.016 + speedN·0.026).',
      'vehicle_audio.js:300 — the soft-ground term lerp(1.0, 0.62, soft), which used to be lerp(0.7, 1.15, soft) and made grass 4.3 dB louder than rock.',
      'vehicle_audio.js:302 — tyreF = 260 + speedN·380 + loose·420 - soft·90.',
      'vehicle_audio.js:303 — grit level 0.55.',
      'vehicle_audio.js:287-288 — the loose/soft surface weightings.',
    ],
  },
  {
    id: 'vehicle.ford',
    group: 'Vehicle',
    label: 'Fording water',
    kind: 'bed',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Continuous hiss while the wheels are in water. Crossing 0.12 of the '
      + 'ford depth also fires the entry splash.',
    layers: ['ford'],
    meterLayers: vehLayer('ford'),
    frame: vehicleFrame,
    params: [
      cond('depth', 'Water depth', 0, 1, 0.4, { unit: 'm', step: 0.01, src: 'vehicle_audio.js:306 — normalised by 0.8 m' }),
      cond('speed', 'Road speed', 0, 30, 4, { unit: 'm/s', step: 0.1 }),
      range('waterHz', 'ford band centre', 400, 5000, 1600, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:147', apply: P('vehicle.waterBand.frequency') }),
      range('waterQ', 'ford band Q', 0.1, 3, 0.5, { step: 0.01, src: 'vehicle_audio.js:147', apply: P('vehicle.waterBand.Q') }),
      range('waterRate', 'ford noise rate', 0.5, 2, 1.07, { step: 0.01, src: 'vehicle_audio.js:146', apply: (r, v) => { r.audio.vehicle.waterSrc.playbackRate.value = v; } }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: ['vehicle_audio.js:307 — ford level depth·(0.04 + speedN·0.12).'],
  },
  {
    id: 'vehicle.knock',
    group: 'Vehicle',
    label: 'Suspension knock',
    kind: 'oneshot',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'A short low thump with the rattle of everything in the back of a '
      + 'camper on top. Fired on axle rate, not wheel position.',
    layers: [],
    trigger: (rig, v) => rig.audio.vehicle.knock(v.strength),
    params: [
      cond('strength', 'Strength', 0.02, 1, 0.5, { step: 0.01, src: 'vehicle_audio.js:354' }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: ['vehicle_audio.js:356-372 — 120 → 46 Hz sweep, level ·0.13, rattle band 1400 + rnd·700, level 0.05.'],
  },
  {
    id: 'vehicle.splash',
    group: 'Vehicle',
    label: 'Water entry splash',
    kind: 'oneshot',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Bright and short, sweeping 3000 → 700 Hz as the bow wave collapses.',
    layers: [],
    trigger: (rig, v) => rig.audio.vehicle.splash(v.strength),
    params: [
      cond('strength', 'Strength', 0, 1, 0.6, { step: 0.01, src: 'vehicle_audio.js:377' }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: ['vehicle_audio.js:381-386 — the 3000 → 700 Hz sweep over 0.42 s and the 0.22 peak level.'],
  },
  {
    id: 'vehicle.ratchet',
    group: 'Vehicle',
    label: 'Handbrake ratchet',
    kind: 'oneshot',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Four hard clicks 52 ms apart, each 180 Hz above the last.',
    layers: [],
    trigger: (rig) => rig.audio.vehicle.ratchet(),
    params: [range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') })],
    needs: ['vehicle_audio.js:395-402 — click count 4, spacing 0.052 s, band 2300 + i·180 at Q 5.5, level 0.075.'],
  },
  {
    id: 'vehicle.door',
    group: 'Vehicle',
    label: 'Camper door',
    kind: 'oneshot',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'A soft thunk plus the rattle of a latch, panned slightly left. Used '
      + 'by photo mode.',
    layers: [],
    trigger: (rig) => rig.audio.cue('door'),
    params: [range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') })],
    needs: ['vehicle_audio.js:412-426 — 160 → 72 Hz thunk at 0.10, latch band 1900 Q 3.0 at 0.05, pan -0.25.'],
  },
  {
    id: 'vehicle.shutter',
    group: 'Vehicle',
    label: 'Camera shutter',
    kind: 'oneshot',
    bus: 'vehicle',
    module: 'src/audio/vehicle_audio.js',
    blurb: 'Two mechanical clicks, 3200 Hz then 2400 Hz — deliberately not a '
      + 'digital beep.',
    layers: [],
    trigger: (rig) => rig.audio.cue('shutter'),
    params: [range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') })],
    needs: ['vehicle_audio.js:435 — the [[0, 3200, 0.09], [0.055, 2400, 0.07]] click table.'],
  },

  // ── wildlife ──────────────────────────────────────────────────────────────
  {
    id: 'wildlife.deer',
    group: 'Wildlife',
    label: 'Deer bleat',
    kind: 'oneshot',
    bus: 'wildlife',
    module: 'src/audio/wildlife_audio.js',
    blurb: 'A 380-470 Hz triangle with a breath of banded noise behind it. '
      + 'Level falls from 0.10 to 0.022 across 240 m and the body filter closes '
      + 'from 4200 to 900 Hz with it.',
    layers: ['wildlife'],
    meterLayers: [{ name: 'wildlife', label: 'wildlife bus', get: (rig) => rig.audio.wildlife, model: null, param: (w) => w.bus.gain }],
    trigger: (rig, v) => {
      const az = (v.azimuth * Math.PI) / 180;
      rig.audio.wildlife._call({ key: 'deer', x: Math.sin(az) * v.distance, z: Math.cos(az) * v.distance }, v.distance, rig.L);
    },
    params: [
      cond('distance', 'Distance to the animal', 1, 240, 60, { unit: 'm', step: 1, src: 'wildlife_audio.js:84 — normalised by 240 m' }),
      cond('azimuth', 'Bearing from the listener', -180, 180, -40, { unit: '°', step: 1 }),
      range('wildlifeBusGain', 'wildlife sub-bus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'wildlife_audio.js:19', apply: P('wildlife.bus.gain') }),
      range('wildlifeWet', 'reverb send', 0, 1, 0.4, { step: 0.01, group: 'Mix', src: 'wildlife_audio.js:22', apply: P('wildlife.wet.gain') }),
      range('wildlifeBus', 'wildlife bus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'Audio.js:132', apply: P('buses.wildlife.gain') }),
    ],
    needs: [
      'wildlife_audio.js:82-85 — pitch 380 + rnd·90, duration 0.28 s, level lerp(0.10, 0.022, far).',
      'wildlife_audio.js:95 — the breath band at 1400 Hz Q 1.1, and its 0.5 level.',
      'wildlife_audio.js:73-74 — the 26-81 s call cooldown and the 240 m candidate radius.',
    ],
  },
  {
    id: 'wildlife.bear',
    group: 'Wildlife',
    label: 'Bear huff',
    kind: 'oneshot',
    bus: 'wildlife',
    module: 'src/audio/wildlife_audio.js',
    blurb: 'Same generator, very different numbers: a 96-122 Hz sawtooth, 0.42 s '
      + 'long, 1.25× the level, with the breath band down at 320 Hz.',
    layers: ['wildlife'],
    meterLayers: [{ name: 'wildlife', label: 'wildlife bus', get: (rig) => rig.audio.wildlife, model: null, param: (w) => w.bus.gain }],
    trigger: (rig, v) => {
      const az = (v.azimuth * Math.PI) / 180;
      rig.audio.wildlife._call({ key: 'bear', x: Math.sin(az) * v.distance, z: Math.cos(az) * v.distance }, v.distance, rig.L);
    },
    params: [
      cond('distance', 'Distance to the animal', 1, 240, 90, { unit: 'm', step: 1 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 25, { unit: '°', step: 1 }),
      range('wildlifeBusGain', 'wildlife sub-bus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'wildlife_audio.js:19', apply: P('wildlife.bus.gain') }),
      range('wildlifeWet', 'reverb send', 0, 1, 0.4, { step: 0.01, group: 'Mix', src: 'wildlife_audio.js:22', apply: P('wildlife.wet.gain') }),
      range('wildlifeBus', 'wildlife bus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'Audio.js:132', apply: P('buses.wildlife.gain') }),
    ],
    needs: ['wildlife_audio.js:82-91 — the bear branch: 96 + rnd·26 Hz, sawtooth, ×1.25 level, 0.82 fall.'],
  },
  {
    id: 'wildlife.wingbeats',
    group: 'Wildlife',
    label: 'Flock takeoff (wingbeats)',
    kind: 'oneshot',
    bus: 'wildlife',
    module: 'src/audio/wildlife_audio.js',
    blurb: 'Filtered noise pulsed at wing rate — 11 Hz panicked, decelerating to '
      + '6.5 Hz as the flock settles into flight. The one wildlife sound the '
      + 'player causes, so it is the one they will connect to something they saw.',
    layers: ['wildlife'],
    meterLayers: [{ name: 'wildlife', label: 'wildlife bus', get: (rig) => rig.audio.wildlife, model: null, param: (w) => w.bus.gain }],
    trigger: (rig, v) => {
      const az = (v.azimuth * Math.PI) / 180;
      rig.audio.wildlife._wingbeats(Math.sin(az) * v.distance, Math.cos(az) * v.distance, rig.L, v.flock);
    },
    params: [
      cond('distance', 'Distance to the flock', 1, 190, 30, { unit: 'm', step: 1, src: 'wildlife_audio.js:121 — silent beyond 190 m' }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      cond('flock', 'Birds in the flock', 1, 14, 6, { step: 1, src: 'wildlife_audio.js:123 — clamp01(0.4 + n/13)' }),
      range('wildlifeBusGain', 'wildlife sub-bus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'wildlife_audio.js:19', apply: P('wildlife.bus.gain') }),
      range('wildlifeBus', 'wildlife bus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'Audio.js:132', apply: P('buses.wildlife.gain') }),
    ],
    needs: ['wildlife_audio.js:132-142 — start rate 11 Hz, deceleration 0.28 Hz per beat, floor 6.5 Hz, 16 beats or 1.7 s.'],
  },

  // ── music ─────────────────────────────────────────────────────────────────
  {
    id: 'music.phrase',
    group: 'Music',
    label: 'Generative phrase',
    kind: 'oneshot',
    bus: 'music',
    module: 'src/audio/music.js',
    blurb: 'Three to five notes of F major pentatonic with a low root entering '
      + 'late. Register is set by the moment: a ridge is high and bright, a '
      + 'waterfall answers low. In the game this cannot repeat inside 92 s.',
    layers: ['music'],
    meterLayers: [{ name: 'music', label: 'music sub-bus', get: (rig) => rig.audio.music, model: null, param: (m) => m.bus.gain }],
    frame: (rig, dt) => rig.audio.music.update(dt, rig.L),
    trigger: (rig, v) => { rig.audio.music._since = 1e6; rig.audio.music._play(v.trigger, rig.L); },
    triggerLabel: 'Play a phrase',
    params: [
      select('trigger', 'Moment', ['vista', 'ridge', 'waterfall', 'sun'], 'ridge', { src: 'music.js:125 — base index 3 / 3 / 0 / 1' }),
      readout('since', 'seconds since last phrase', (r) => r.audio.music.state.since, { unit: 's', src: 'music.js:22 — MIN_GAP 92 s' }),
      range('musicBusGain', 'music sub-bus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'music.js:30', apply: P('music.bus.gain') }),
      range('musicWet', 'reverb send', 0, 1, 0.55, { step: 0.01, group: 'Mix', src: 'music.js:32', apply: P('music.wet.gain') }),
      range('musicBus', 'music bus gain', 0, 2, 0.8, { step: 0.01, group: 'Mix', src: 'Audio.js:133', apply: P('buses.music.gain') }),
    ],
    needs: [
      'music.js:18-22 — ROOT (F3, 174.61 Hz), the STEPS table and MIN_GAP are module-private.',
      'music.js:132 — note levels 0.115 / 0.085 with a 0.09-per-note decay; :139 — the low root at 0.055.',
      'music.js:152 — the per-note 2600 Hz tone filter; :157 — the [mul, amp, detune] partial table.',
      'music.js:171-172 — the 0.28 s attack and 5.6 s tail.',
    ],
  },
  {
    id: 'music.note',
    group: 'Music',
    label: 'Single music note',
    kind: 'oneshot',
    bus: 'music',
    module: 'src/audio/music.js',
    blurb: 'One note of the glass-harmonica voice: four sines at 1×, 2×, 3× and '
      + 'a detuned unison, a soft mallet attack and a 5.6 s tail.',
    layers: ['music'],
    meterLayers: [{ name: 'music', label: 'music sub-bus', get: (rig) => rig.audio.music, model: null, param: (m) => m.bus.gain }],
    trigger: (rig, v) => rig.audio.music._note(v.freq, rig.actx.currentTime + 0.05, v.level, v.pan),
    params: [
      cond('freq', 'Pitch', 80, 900, 174.61, { unit: 'Hz', step: 0.01, src: 'music.js:18 — ROOT is F3 = 174.61 Hz' }),
      cond('level', 'Note level', 0, 0.3, 0.115, { step: 0.001, src: 'music.js:132' }),
      cond('pan', 'Pan', -1, 1, 0, { step: 0.01 }),
      range('musicBusGain', 'music sub-bus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'music.js:30', apply: P('music.bus.gain') }),
      range('musicWet', 'reverb send', 0, 1, 0.55, { step: 0.01, group: 'Mix', src: 'music.js:32', apply: P('music.wet.gain') }),
      range('musicBus', 'music bus gain', 0, 2, 0.8, { step: 0.01, group: 'Mix', src: 'Audio.js:133', apply: P('buses.music.gain') }),
    ],
    needs: ['music.js:157 — the partial table, and :152 the 2600 Hz tone filter, are built per note.'],
  },
  {
    id: 'soundtrack.bed',
    group: 'Music',
    label: 'Authored soundtrack bed',
    kind: 'bed',
    bus: 'music',
    module: 'src/audio/soundtrack.js',
    blurb: 'The one sound in the game that is not synthesised. Loaded on demand '
      + 'here — 5 MB — so the lab still opens instantly. The duck node is the '
      + 'one that spent a while connected to nothing: pull the duck slider with '
      + 'the bed playing and the meter should move.',
    layers: ['soundtrack'],
    meterLayers: [{ name: 'soundtrack', label: 'bed (out · duck)', get: (rig) => rig.audio.soundtrack, model: null, param: (s) => s.out.gain }],
    lazy: true,
    start: async (rig, v) => {
      const st = await rig.loadSoundtrack();
      if (st.failed) return 'The soundtrack mp3 could not be loaded.';
      st.setLevel(v.level);
      st.duck.gain.value = v.ducked ? v.duckAmount : 1;
      st._start();
      return '';
    },
    stop: (rig) => rig.audio.soundtrack?._stop(),
    params: [
      range('level', 'Bed level', 0, 1, 0.21, { step: 0.005, src: 'soundtrack.js:64', apply: (r, v) => r.audio.soundtrack?.setLevel(v) }),
      toggle('ducked', 'Duck as if a phrase were sounding', false, { kind: 'condition', src: 'soundtrack.js:143', apply: (r, v, vals) => { if (r.audio.soundtrack) r.audio.soundtrack.duck.gain.value = v ? vals.duckAmount : 1; } }),
      range('duckAmount', 'Duck depth', 0.05, 1, 0.6, { step: 0.01, src: 'soundtrack.js:143 — 0.6 is 4.4 dB', apply: (r, v, vals) => { if (r.audio.soundtrack && vals.ducked) r.audio.soundtrack.duck.gain.value = v; } }),
      range('musicBus', 'music bus gain', 0, 2, 0.8, { step: 0.01, group: 'Mix', src: 'Audio.js:133', apply: P('buses.music.gain') }),
    ],
    needs: [
      'soundtrack.js:22 — the TRACK path is module-private.',
      'soundtrack.js:26-32 — PLAY_MIN/MAX 95-165 s, REST_MIN/MAX 70-130 s, FADE_IN 6 s, FADE_OUT 7.5 s.',
    ],
  },

  // ── interface ─────────────────────────────────────────────────────────────
  {
    id: 'ui.tick',
    group: 'Interface',
    label: 'Menu tick',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/Audio.js',
    blurb: 'A soft wooden tick for menu movement — 660 → 470 Hz through a 900 Hz '
      + 'bandpass. Goes straight to the master, not through a bus.',
    layers: [],
    trigger: (rig) => rig.audio.cue('tick'),
    params: [],
    needs: ['Audio.js:238-249 — the tick/select pitches (660/470, 880/560), the 900 Hz Q 0.9 band and the 0.032 / 0.05 levels.'],
  },
  {
    id: 'ui.select',
    group: 'Interface',
    label: 'Menu select',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/Audio.js',
    blurb: 'The same generator a fifth higher and half as loud again: '
      + '880 → 560 Hz at 0.05.',
    layers: [],
    trigger: (rig) => rig.audio.cue('select'),
    params: [],
    needs: [],
  },
];

/**
 * The master chain. Shown beside every sound rather than as a sound of its own,
 * because it is downstream of all of them and a change here means something
 * different from a change to a layer.
 */
export const MASTER_PARAMS = [
  range('masterVolume', 'Master volume', 0, 1, 0.8, { step: 0.01, group: 'Master', src: 'Audio.js:46 (lab default; the game persists its own)', apply: (r, v) => r.setMasterVolume(v) }),
  range('limiterThreshold', 'Limiter threshold', -40, 0, -6, { unit: 'dB', step: 0.5, group: 'Master', src: 'Audio.js:108', apply: P('limiter.threshold') }),
  range('limiterKnee', 'Limiter knee', 0, 40, 6, { unit: 'dB', step: 0.5, group: 'Master', src: 'Audio.js:109', apply: P('limiter.knee') }),
  range('limiterRatio', 'Limiter ratio', 1, 20, 14, { step: 0.5, group: 'Master', src: 'Audio.js:110', apply: P('limiter.ratio') }),
  range('limiterAttack', 'Limiter attack', 0.001, 0.05, 0.004, { unit: 's', step: 0.001, group: 'Master', src: 'Audio.js:111', apply: P('limiter.attack') }),
  range('limiterRelease', 'Limiter release', 0.01, 1, 0.18, { unit: 's', step: 0.01, group: 'Master', src: 'Audio.js:112', apply: P('limiter.release') }),
  range('reverbSeconds', 'Reverb length', 0.5, 6, 2.8, { unit: 's', step: 0.1, group: 'Reverb', src: 'Audio.js:119', apply: (r, v, vals) => r.setReverb(v, vals.reverbDecay) }),
  range('reverbDecay', 'Reverb decay exponent', 0.5, 6, 2.4, { step: 0.1, group: 'Reverb', src: 'Audio.js:119', apply: (r, v, vals) => r.setReverb(vals.reverbSeconds, v) }),
  range('reverbOut', 'Reverb return gain', 0, 1.5, 0.5, { step: 0.01, group: 'Reverb', src: 'Audio.js:120', apply: P('reverbOut.gain') }),
];

export const MASTER_NEEDS = [
  'Audio.js:128-134 — the five bus default gains are inline in _start().',
  'Audio.js:213 — the 0.71 (-3 dBFS) master ceiling.',
];

/** Defaults for one sound, as a flat key → value object. */
export function defaultsFor(sound) {
  const out = {};
  for (const p of [...sound.params, ...MASTER_PARAMS]) {
    if (p.type === 'readout') continue;
    out[p.key] = p.def;
  }
  return out;
}

export const byId = (id) => SOUNDS.find((s) => s.id === id);

export { clamp01 };

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
import { AMBIENCE_LEVELS } from '../../audio/ambience.js';
import { JournalAudio, JOURNAL_CUES, JOURNAL_GAIN } from '../../audio/journal_audio.js';

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

// ── the journal's own voice, for the three entries at the bottom ─────────────
//
// `Audio.cue` builds a JournalAudio lazily and keeps it in `_journal`, and the
// obvious thing is to drive that one. It is the wrong thing here for two
// reasons: `cue(name)` takes no arguments, so `level` and `rate` — the only two
// knobs the ceremony actually turns — would be unreachable from the lab; and
// reaching into `_journal` means the lab silently does nothing until something
// else in the app has already made a sound.
//
// So the lab builds its own, onto the same master bus, which is the same graph
// the game gets: these cues are dry and positionless (see the module header),
// so "on the master" is the whole of their routing. One per rig, cached,
// because the constructor fills two 1.4 s noise buffers and a trigger button
// is something people press forty times in a row.
const _labJournal = new WeakMap();
const journalOf = (rig) => {
  let j = _labJournal.get(rig);
  if (!j) _labJournal.set(rig, (j = new JournalAudio(rig.actx, rig.audio.master)));
  return j;
};

// Shorthand for the common "write an AudioParam" apply.
const P = (path) => (rig, v) => {
  const node = path.split('.').reduce((o, k) => o?.[k], rig.audio);
  if (node && typeof node === 'object' && 'value' in node) node.value = v;
};

// One-shots have no live AudioParam to write — they build their graph at
// trigger time — so a splash slider parks its value on the model and the next
// trigger picks it up.
const SP = (key) => (rig, v) => { (rig.audio.vehicle.splashPatch ??= {})[key] = v; };

/**
 * Shorthand for the tyre model's `tune` block.
 *
 * These are plain numbers rather than AudioParams because most of them are
 * *model* terms — an impact rate, a stone-size distribution, a count of tread
 * blocks — that feed arithmetic in `update()` rather than settings on a node.
 * `P` cannot reach them, and faking them with a node would break rule 1 at the
 * top of this file. The path a pasted config names is the real one:
 * `vehicle.tyres.tune.<key>`.
 */
const T = (key) => (rig, v) => { rig.audio.vehicle.tyres.tune[key] = v; };

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
  // The contact patch, four layers. `model` is filled in here because the tyre
  // model publishes the gain it *asked* for beside the AudioParam it wrote it
  // to — the same quantity on both sides, which is exactly the comparison that
  // catches a layer whose parameter is being written while nothing reaches it.
  { name: 'tyreGrain', label: 'stone impacts', model: (a) => a.tyres.state.grain, param: (a) => a.tyres.gGrain.gain },
  { name: 'tyreBed', label: 'contact bed', model: (a) => a.tyres.state.bed, param: (a) => a.tyres.gBed.gain },
  { name: 'tyreTread', label: 'tread hum', model: (a) => a.tyres.state.tread, param: (a) => a.tyres.gTread.gain },
  { name: 'tyreBody', label: 'carcass', model: (a) => a.tyres.state.body, param: (a) => a.tyres.gBody.gain },
  { name: 'ford', label: 'fording', model: null, param: (a) => a.gWater.gain },
];
const vehLayer = (...names) => VEH_LAYERS.filter((l) => names.includes(l.name))
  .map((l) => ({ ...l, get: (rig) => rig.audio.vehicle }));

// ─────────────────────────────────────────────────────────────────────────────
//  The catalogue
// ─────────────────────────────────────────────────────────────────────────────

// ── camp helpers ────────────────────────────────────────────────────────────

// `CampAudio.update` is what hands the listener sample down to the prop cues,
// and the lab's fake world has no camp system in it — so the fire stays silent
// and the meter shows nothing but the cue under test. Which is what you want
// from a page for auditioning a 40 ms clack.
const campFrame = (rig, dt, v) => {
  applyListener(rig, v);
  rig.audio.camp.update(dt, rig.L);
};

const CAMP_MIX = [
  range('cueGain', 'prop cue trim', 0, 8, 3.6, { step: 0.01, group: 'Mix', src: 'camp_props.js:55 — CUE_GAIN, the one level for the whole layer', apply: P('camp.props.bus.gain') }),
  range('campWet', 'reverb send', 0, 1, 0.16, { step: 0.01, group: 'Mix', src: 'camp_audio.js:52', apply: P('camp.wet.gain') }),
  range('ambienceBus', 'ambience bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:128 — the camp rides the ambience bus', apply: P('buses.ambience.gain') }),
];

/**
 * One prop cue.
 *
 * `distance` and `out` are the two things that actually change what you hear,
 * and both are conditions rather than parameters: one is where you are
 * standing and the other is which half of the event this is. Neither is a
 * setting anybody would paste into `camp_props.js`.
 */
const campCue = (kind, label, blurb, needs) => ({
  id: `camp.${kind}`,
  group: 'Camp',
  label,
  kind: 'oneshot',
  bus: 'camp',
  module: 'src/audio/camp_props.js',
  blurb,
  layers: [],
  frame: campFrame,
  trigger: (rig, v) => {
    // Offset from wherever the listener currently IS, not from the origin. The
    // lab's listener is shared across sounds and nothing puts it back: select
    // the waterfall, drag its distance to 500 m, then select a camp cue, and
    // an origin-relative trigger places the prop half a kilometre away and
    // `CampProps.cue` correctly declines to schedule it. Which reads on the
    // meter as a broken sound rather than as a stale condition — and did,
    // for eight entries at once, until `soundlab-check` ran the full list.
    const az = (v.azimuth * Math.PI) / 180;
    const L = rig.L;
    rig.audio.camp.cue(kind, {
      x: L.x + Math.sin(az) * v.distance, z: L.z + Math.cos(az) * v.distance, out: !!v.out,
    });
  },
  triggerLabel: 'Pop',
  params: [
    cond('distance', 'Distance to the prop', 0.5, 34, 10, { unit: 'm', step: 0.5, src: 'camp_props.js:41 — 30 m reach, 3 m near field, falloff exponent 1.4' }),
    cond('azimuth', 'Bearing from the listener', -180, 180, -35, { unit: '°', step: 1 }),
    toggle('out', 'Packing away (rather than pitching)', false, { kind: 'condition', src: 'camp_props.js:57 — pitch ×0.86, length ×0.72, level ×0.6, attack ×1.7' }),
    ...CAMP_MIX,
  ],
  needs,
});

const CAMP_CUES = [
  campCue('ground', 'Clearing opening', 
    'Dry earth easing open under the grass. A 90 ms attack and a band falling '
    + '700 → 215 Hz — the only cue with no transient, because the ground swells '
    + 'open over 0.6 s rather than popping. Reverses to 420 → 150 Hz on the way out.',
    ['camp_props.js:206-213 — the two sweep bands, the 96 → 72 Hz body and their 0.075 / 0.022 peaks.']),
  campCue('fire', 'Fire catching',
    'A low whoosh rising 175 → 540 Hz over half a second. Reverses AND adds a '
    + 'hiss on the way out, because a fire going out is a different event from '
    + 'one being lit rather than the same one backwards. Mixed under the fire '
    + 'bed it introduces.',
    ['camp_props.js:227-234 — the in/out sweep pairs and their 0.062 / 0.055 / 0.020 peaks.']),
  campCue('tent', 'Tent — nylon',
    'Three fabric ruffles 48 ms apart, each darker and quieter than the last '
    + '(2700 → 950, 2100 → 700, 1500 → 520 Hz), over a 124 → 68 Hz thump of '
    + 'displaced air. The thump is the only reason a tent reads as bigger than '
    + 'a chair rather than merely as more cloth.',
    ['camp_props.js:88-97 — the three ruffle bands, their offsets and the body sweep.']),
  campCue('chair', 'Chair — tube and sling',
    'Two aluminium ticks 55 ms apart at 2850 and 2050 Hz — a folding chair has '
    + 'four legs and they never land together — with the seat taking the '
    + "frame's shape between them.",
    ['camp_props.js:107-112 — the two tick bands and the 1900 → 900 Hz sling sweep.']),
  campCue('cooler', 'Cooler — hollow plastic',
    'A triangle at 205 → 168 Hz rather than a resonant noise band: the '
    + 'odd-harmonic series is what makes moulded plastic sound like plastic and '
    + 'not like a small drum. The lid lands on the rim 12 ms later.',
    ['camp_props.js:123-128 — the triangle body and the two rim bands.']),
  campCue('table', 'Table — wood and legs',
    'A 380 Hz band at Q 9 is the woody ring, and it is the whole difference '
    + 'between this and the cooler — which frequently pops within 70 ms of it. '
    + 'A leg finds the ground at 1520 Hz.',
    ['camp_props.js:140-145 — the ring band, the 188 Hz body and the leg clack.']),
  campCue('woodpile', 'Woodpile — logs settling',
    'The only cue with a random shape, and the only one that needs it: a stack '
    + 'of logs is a NUMBER of impacts. Four to six clacks, 250-770 Hz, each '
    + 'quieter and further left or right than the last.',
    ['camp_props.js:158-176 — the clack count, the 250 + rnd·520 Hz spread, the settling falloff and the 0.028 + rnd·0.05 s spacing.']),
  campCue('telescope', 'Telescope — tripod and glass',
    'Two inharmonic partials at 1180 and 1735 Hz. Deliberately not an octave '
    + 'or a fifth: a tuned interval is a bell and a bell is a UI sound. The '
    + 'longest cue in the camp, because it is the one prop worth something.',
    ['camp_props.js:188-194 — the two partials, the 3200 Hz tripod tick and the 430 Hz mount.']),
];

// ── boat helpers ────────────────────────────────────────────────────────────

/** Write a term of the boat's `tune` block — the tyre `T` pattern: these are
 *  model numbers read by `update()`, not AudioParams, and the path a pasted
 *  config names is the real one: `boat.tune.<key>`. */
const B = (key) => (rig, v) => { rig.audio.boat.tune[key] = v; };

const BOAT_MIX = [
  range('boatCueGain', 'boat cue trim', 0, 8, 2.0, { step: 0.01, group: 'Mix', src: 'boat_audio.js — CUE_GAIN, one level for every boat one-shot', apply: P('boat.cueBus.gain') }),
  range('boatWet', 'reverb send', 0, 1, 0.14, { step: 0.01, group: 'Mix', src: 'boat_audio.js — this.wet', apply: P('boat.wet.gain') }),
  range('waterBus', 'water bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:130 — the boat rides the water bus', apply: P('buses.water.gain') }),
];

const HULLS = ['canoe', 'kayak'];

/**
 * Stand a fake boat in the water, exactly the shape `BoatAudio.update` reads
 * from `ctx.systems.boat`. `on` is gated on the rig's active-layer set, which
 * is what Play/Stop drive — the boat layers have no trim nodes (they are
 * gains inside the module, listed by `BoatAudio.layers()`), so presence of
 * the boat itself is the transport.
 */
function fakeBoat(rig, v, on) {
  const az = ((v.azimuth ?? 0) * Math.PI) / 180;
  rig.ctx.systems.boat = on ? {
    active: v.aboard !== false,
    current: {
      kind: v.hull ?? 'canoe', colorway: 0,
      x: rig.L.x + Math.sin(az) * (v.distance ?? 4),
      z: rig.L.z + Math.cos(az) * (v.distance ?? 4),
      heading: 0, speed: v.speed ?? 0,
    },
  } : null;
}

const boatBedFrame = (layer, extra = null) => (rig, dt, v) => {
  applyListener(rig, v);
  fakeBoat(rig, v, rig.active.has(layer));
  extra?.(rig, v);
  rig.audio.boat.update(dt, rig.L);
};
const boatBedStop = (rig) => {
  rig.ctx.systems.boat = null;
  rig.audio.boat.update(0.016, rig.L);   // one frame, so the glide fades out
};
// One-shots carry their own position and hull in `opts`; no boat needs to
// exist. The update keeps the layer's listener sample fresh for cue pan.
const boatCueFrame = (rig, dt, v) => {
  applyListener(rig, v);
  fakeBoat(rig, v, false);
  rig.audio.boat.update(dt, rig.L);
};

const boatCue = (kind, label, blurb, extraParams = [], needs = []) => ({
  id: `boat.${kind}`,
  group: 'Boat',
  label,
  kind: 'oneshot',
  bus: 'boat',
  module: 'src/audio/boat_audio.js',
  blurb,
  layers: [],
  frame: boatCueFrame,
  trigger: (rig, v) => {
    const az = (v.azimuth * Math.PI) / 180;
    rig.audio.boat.cue(kind, {
      x: rig.L.x + Math.sin(az) * v.distance,
      z: rig.L.z + Math.cos(az) * v.distance,
      hull: v.hull,
      side: v.side ?? 0,
      strength: v.strength ?? 0.7,
    });
  },
  triggerLabel: 'Trigger',
  params: [
    select('hull', 'Hull', HULLS, 'canoe', { src: 'boat_audio.js — HULL: kayak brighter/higher, poly knocks; canoe deeper, wood' }),
    cond('distance', 'Distance to the boat', 0.5, 44, 8, { unit: 'm', step: 0.5, src: 'boat_audio.js — 40 m reach, 4 m near field, falloff 1.5' }),
    cond('azimuth', 'Bearing from the listener', -180, 180, -25, { unit: '°', step: 1 }),
    ...extraParams,
    ...BOAT_MIX,
  ],
  needs,
});

const BOAT_SOUNDS = [
  {
    id: 'boat.glide',
    group: 'Boat',
    label: 'Hull glide',
    kind: 'bed',
    bus: 'boat',
    module: 'src/audio/boat_audio.js',
    blurb: 'Water on a moving hull: the water.js three-band pink voice with the '
      + 'band centre swept by speed — a burble barely moving, a laminar "shhh" '
      + 'with a bubbly undertone at cruise. Silent at rest (below ~0.3 m/s the '
      + 'moored lapping takes over). The kayak sits a fifth brighter than the '
      + 'canoe. Drag speed and the meter must rise monotonically.',
    layers: ['boatGlide'],
    frame: boatBedFrame('boatGlide'),
    stop: boatBedStop,
    params: [
      select('hull', 'Hull', HULLS, 'canoe', { src: 'boat_audio.js — HULL.bright 1.0 / 1.22' }),
      cond('speed', 'Boat speed', 0, 3.8, 2.6, { unit: 'm/s', step: 0.05, src: 'boat_physics.js — maxSpeed 3.2 canoe / 3.8 kayak' }),
      cond('distance', 'Distance to the boat', 0.5, 60, 4, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('mGlide', 'model glide gain', (r) => r.audio.boat.state.glide, { src: 'boat_audio.js — gate · (0.3 + 0.7·sp) · glideDrive · distance' }),
      readout('mBody', 'body band centre', (r) => r.audio.boat.glide.body.frequency.value, { unit: 'Hz', src: 'boat_audio.js — 520 · bright · (1 + sp·0.5), ±110 Hz gurgle LFO' }),
      readout('mAir', 'air-absorption cutoff', (r) => r.audio.boat.glide.air.frequency.value, { unit: 'Hz', src: 'boat_audio.js — 7000·e^(-d/70)' }),
      range('glideDrive', 'glide level at full speed', 0, 0.4, 0.14, { step: 0.002, src: 'boat_audio.js — boat.tune.glideDrive', apply: B('glideDrive') }),
      range('glideRef', 'glide reference distance', 4, 40, 14, { unit: 'm', step: 0.5, src: 'boat_audio.js — boat.tune.glideRef', apply: B('glideRef') }),
      range('brightness', 'band-centre scale', 0.5, 2, 1.0, { step: 0.01, src: 'boat_audio.js — boat.tune.brightness', apply: B('brightness') }),
      range('bodyQ', 'body band Q', 0.1, 3, 0.6, { step: 0.01, src: 'boat_audio.js — glide.body', apply: P('boat.glide.body.Q') }),
      range('gBody', 'body band gain', 0, 2, 1.2, { step: 0.01, src: 'boat_audio.js — glide.gBody', apply: P('boat.glide.gBody.gain') }),
      range('hissHz', 'top band highpass', 1000, 8000, 2400, { unit: 'Hz', step: 10, src: 'boat_audio.js — glide.hiss', apply: P('boat.glide.hiss.frequency') }),
      ...BOAT_MIX.slice(1),      // wet + water bus; the cue trim is not in this path
    ],
    needs: [
      'boat_audio.js — the speed gate smoothstep(0.12, 0.85, speed) and the /3.8 normalisation.',
      'boat_audio.js — distance exponent 2.2 and the 7000·e^(-d/70) air model.',
      'boat_audio.js — the gurgle LFO (0.21 Hz, ±110 Hz) and the 0.06 Hz depth-0.28 swell.',
      'boat_audio.js — hull low/hiss band scales (HULL.lowG, HULL.hissG, hiss ∝ sp²).',
    ],
  },
  {
    id: 'boat.lapping',
    group: 'Boat',
    label: 'Idle lapping',
    kind: 'bed',
    bus: 'boat',
    module: 'src/audio/boat_audio.js',
    blurb: 'A moored hull: sparse soft plips on a 0.8–2.5 s clock (camp-style '
      + 'crowding, so they never machine-gun), sometimes doubled, sometimes '
      + 'with the hull\'s own resonance answering very quietly — wood for the '
      + 'canoe, hollow poly for the kayak. Only below 0.3 m/s.',
    layers: ['boatLap'],
    frame: boatBedFrame('boatLap'),
    stop: boatBedStop,
    params: [
      select('hull', 'Hull', HULLS, 'canoe', { src: 'boat_audio.js — HULL.knock 178/318 sine vs 152/264 triangle' }),
      cond('speed', 'Boat speed (moored < 0.3)', 0, 0.3, 0, { unit: 'm/s', step: 0.01 }),
      cond('distance', 'Distance to the boat', 0.5, 44, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('nLaps', 'laps sounded', (r) => r.audio.boat.state.laps, { src: 'boat_audio.js — state.laps' }),
      range('lapRate', 'lap clock ×', 0.2, 4, 1.0, { step: 0.01, src: 'boat_audio.js — boat.tune.lapRate', apply: B('lapRate') }),
      range('lapDrive', 'lap level ×', 0, 3, 1.0, { step: 0.01, src: 'boat_audio.js — boat.tune.lapDrive', apply: B('lapDrive') }),
      ...BOAT_MIX,
    ],
    needs: [
      'boat_audio.js — the 0.8 + rnd·1.7 s inter-lap clock and the 0.4 / 0.35 double-tap / resonance odds.',
      'boat_audio.js — lap bands 780–1100 → 420–560 Hz at Q 1.2, peaks 0.030–0.052.',
    ],
  },
  {
    id: 'boat.drips',
    group: 'Boat',
    label: 'Paddle drips',
    kind: 'bed',
    bus: 'boat',
    module: 'src/audio/boat_audio.js',
    blurb: 'Tiny 2–4 kHz plips off the lifted blade for ~2.4 s after a stroke, '
      + 'aboard only. This page holds "just stroked" true continuously so the '
      + 'bed is auditionable; in the game it decays away after each stroke.',
    layers: ['boatDrip'],
    frame: boatBedFrame('boatDrip', (rig) => { rig.audio.boat._sinceStroke = 0; }),
    stop: boatBedStop,
    params: [
      select('hull', 'Hull', HULLS, 'canoe'),
      cond('distance', 'Distance to the boat', 0.5, 20, 2, { unit: 'm', step: 0.5, src: 'aboard, the camera is on the boat' }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('nDrips', 'drips sounded', (r) => r.audio.boat.state.drips, { src: 'boat_audio.js — state.drips' }),
      range('dripDrive', 'drip level ×', 0, 3, 1.0, { step: 0.01, src: 'boat_audio.js — boat.tune.dripDrive', apply: B('dripDrive') }),
      ...BOAT_MIX,
    ],
    needs: [
      'boat_audio.js — the 0.14 + rnd·0.42 s drip clock and the 2.4 s post-stroke window.',
      'boat_audio.js — drip bands 2000–4000 Hz at Q 9, peaks 0.012–0.026 fading with the window.',
    ],
  },
  boatCue('stroke', 'Paddle stroke',
    'The hero sound, three phases of one gesture: the catch (a soft plunk '
    + 'falling 250 → 120 Hz as the blade goes in), the drive (0.4 s of pink '
    + 'swash sliding 680 → 330 Hz), and two or three release drips off the '
    + 'lifted blade. Panned to its side. The canoe digs deeper and rounder; '
    + 'the kayak is lighter and a sixth higher.',
    [
      cond('side', 'Stroke side (-1 left, 1 right)', -1, 1, 1, { step: 2, src: 'boat_physics.js — onStroke(side, strength)' }),
      cond('strength', 'Stroke strength', 0, 1, 0.7, { step: 0.01 }),
    ],
    ['boat_audio.js — VOICES.stroke: the catch/drive/release offsets, peaks and the ±0.30 side pan.']),
  boatCue('launch', 'Launch — hull into water',
    'The keel dragging off the bank (brown noise under a 520 Hz lowpass, '
    + '0.6 s), then a generous splash on the vehicle-splash recipe (pink, '
    + '1400 → 380 Hz over half a second) with a low body of displaced water, '
    + 'and two settle-laps as the hull stops bobbing.',
    [],
    ['boat_audio.js — VOICES.launch: the scrape/splash/settle offsets and peaks.']),
  boatCue('board', 'Boarding knock',
    'A knee and a hand on the hull: two knocks on the hull\'s own partials — '
    + '178/318 Hz near-pure for the canoe\'s wood, 152/264 Hz odd-harmonic '
    + 'triangle for the kayak\'s rotomoulded poly — the water answering '
    + 'underneath, and the creak of the hull taking weight (the one band in '
    + 'this module swept upward).',
    [],
    ['boat_audio.js — VOICES.board and the HULL knock table.']),
  boatCue('beach', 'Beaching scrape',
    'Sand and gravel under the keel: a decelerating hiss-scrape falling '
    + '1500 → 620 Hz over half a second, three gravel ticks spacing out as '
    + 'the hull slows, and a low grounding thump.',
    [],
    ['boat_audio.js — VOICES.beach: the tick spacings 0.07/0.13/0.22 s.']),
  boatCue('bump', 'Shoreline bump',
    'A single nudge: one hull knock on the hull\'s lowest partial and the '
    + 'plip of the water it displaced.',
    [],
    ['boat_audio.js — VOICES.bump.']),
];

// ─────────────────────────────────────────────────────────────────────────────
//  Bike
//
//  Same shape as the boat's block above and the same reasoning behind it. The
//  one thing worth saying out loud: the bike's two loudest voices are GATED ON
//  OPPOSITE THINGS, and that is the layer's whole design. `effort` runs the
//  drivetrain and silences the freewheel; letting go runs the freewheel and
//  silences the drivetrain. So the pedalling slider below is not a level, it
//  is the crossfade between two different bicycles, and auditioning either one
//  without moving it is auditioning half the layer.
// ─────────────────────────────────────────────────────────────────────────────
const K = (key) => (rig, v) => { rig.audio.bike.tune[key] = v; };

const BIKE_MIX = [
  range('bikeCueGain', 'bike cue trim', 0, 6, 1.5, { step: 0.01, group: 'Mix', src: 'bike_audio.js — CUE_GAIN, one level for every bike one-shot', apply: P('bike.cueBus.gain') }),
  range('bikeWet', 'reverb send', 0, 1, 0.09, { step: 0.01, group: 'Mix', src: 'bike_audio.js — this.wet', apply: P('bike.wet.gain') }),
  range('vehicleBus', 'vehicle bus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'Audio.js — the bike rides the vehicle bus', apply: P('buses.vehicle.gain') }),
];

const BIKE_STYLES = ['trail', 'packer'];

/**
 * Stand a fake bike on the ground, exactly the shape `BikeAudio.update` reads
 * off `ctx.systems.bike.current`. `wheelRate` and `cadence` are DERIVED from
 * the speed rather than exposed as sliders, because in the game they are —
 * a freewheel rate that does not match the speed is a sound that cannot happen.
 */
function fakeBike(rig, v, on) {
  const az = ((v.azimuth ?? 0) * Math.PI) / 180;
  const speed = v.speed ?? 0;
  rig.ctx.systems.bike = on ? {
    active: true,
    current: {
      style: v.style ?? 'trail',
      x: rig.L.x + Math.sin(az) * (v.distance ?? 4),
      z: rig.L.z + Math.cos(az) * (v.distance ?? 4),
      heading: 0,
      speed,
      riding: true,
      effort: v.effort ?? 0,
      braking: v.braking ?? 0,
      wheelRate: speed / 0.348,          // bike_model.js — WHEEL_R
      cadence: Math.min(1, speed / 4.5) * 8.2 * (v.effort ?? 0),
      wading: v.wading ?? 0,
      wade: Math.min(1, (v.wading ?? 0) / 0.90),   // bike_physics.js — WADE_REF
      grassiness: v.grassiness ?? 0.5,
      blocked: false, grade: 0,
    },
  } : null;
}

const bikeBedFrame = (layer) => (rig, dt, v) => {
  applyListener(rig, v);
  fakeBike(rig, v, rig.active.has(layer));
  rig.audio.bike.update(dt, rig.L);
};
const bikeBedStop = (rig) => {
  rig.ctx.systems.bike = null;
  rig.audio.bike.update(0.016, rig.L);   // one frame, so the beds fade out
};
const bikeCueFrame = (rig, dt, v) => {
  applyListener(rig, v);
  fakeBike(rig, v, false);
  rig.audio.bike.update(dt, rig.L);
};

const bikeCue = (kind, label, blurb, needs = [], extraParams = []) => ({
  id: `bike.${kind}`,
  group: 'Bike',
  label,
  kind: 'oneshot',
  bus: 'bike',
  module: 'src/audio/bike_audio.js',
  blurb,
  layers: [],
  frame: bikeCueFrame,
  trigger: (rig, v) => {
    const az = (v.azimuth * Math.PI) / 180;
    rig.audio.bike.cue(kind, {
      x: rig.L.x + Math.sin(az) * v.distance,
      z: rig.L.z + Math.cos(az) * v.distance,
      strength: v.strength ?? 1,
    });
  },
  triggerLabel: 'Trigger',
  params: [
    cond('distance', 'Distance to the bike', 0.5, 30, 4, { unit: 'm', step: 0.5, src: 'bike_audio.js — 26 m reach, 3 m near field, falloff 1.5' }),
    cond('azimuth', 'Bearing from the listener', -180, 180, -25, { unit: '°', step: 1 }),
    ...extraParams,
    ...BIKE_MIX,
  ],
  needs,
});

const BIKE_SOUNDS = [
  {
    id: 'bike.roll',
    group: 'Bike',
    label: 'Tyres on bare ground',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'Knobbly tyre on dirt, scree and gravel: the water.js three-band pink '
      + 'voice, granular and bright when dry, duller when wet. Silent below '
      + 'about 0.15 m/s. It also fades out as the ground turns to meadow — pull '
      + 'the SURFACE slider to 1 and this voice must go to the floor, because '
      + 'the grass bed is what takes over. Drag speed and the meter must rise '
      + 'monotonically.',
    layers: ['bikeRoll'],
    frame: bikeBedFrame('bikeRoll'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 6, { unit: 'm/s', step: 0.05, src: 'bike_physics.js — about 8 m/s on the flat, more downhill' }),
      cond('grassiness', 'Surface (0 bare, 1 meadow)', 0, 1, 0, { step: 0.01, src: 'bike_physics.js — from getSurfaceWeights, the terrain material\'s own field' }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('mRoll', 'model roll gain', (r) => r.audio.bike.state.roll, { src: 'bike_audio.js — gate · (0.25 + 0.75·sp) · (1 − grassy) · rollDrive · build · distance' }),
      readout('mBody', 'body band centre', (r) => r.audio.bike.roll.body.frequency.value, { unit: 'Hz', src: 'bike_audio.js — 700 · bright · (1 + sp·0.55), ±190 Hz wander' }),
      range('rollDrive', 'roll level at full speed', 0, 0.5, 0.16, { step: 0.002, src: 'bike_audio.js — bike.tune.rollDrive', apply: K('rollDrive') }),
      range('rollRef', 'reference distance', 3, 30, 9, { unit: 'm', step: 0.5, src: 'bike_audio.js — bike.tune.rollRef', apply: K('rollRef') }),
      range('brightness', 'band-centre scale', 0.5, 2, 1.0, { step: 0.01, src: 'bike_audio.js — bike.tune.brightness', apply: K('brightness') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: [
      'bike_audio.js — the speed gate smoothstep(0.15, 1.0) and the /8 normalisation.',
      'bike_audio.js — the (1 − grassiness) crossfade against the grass bed.',
    ],
  },
  {
    id: 'bike.grass',
    group: 'Bike',
    label: 'Tyres through grass',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'Blades, not ground — and a genuinely different voice rather than the '
      + 'rumble with a filter on it. Two bright bands and no low end at all: a '
      + 'wide one for the whip against the spokes and a narrower higher one for '
      + 'the tips catching the fork and the bag, fluttering at 6–9 Hz over a '
      + 'slower swell. Steeper in speed than the rumble (sp², because a stalk '
      + 'hits harder AND more of them hit per second). Wet grass lies down and '
      + 'hisses; dry autumn grass stands up and rattles, which is most of what '
      + 'this valley is. The counterpart of `bike.roll`: the two crossfade on '
      + 'the SURFACE slider and should never both be up.',
    layers: ['bikeGrass'],
    frame: bikeBedFrame('bikeGrass'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 6, { unit: 'm/s', step: 0.05 }),
      cond('grassiness', 'Surface (0 bare, 1 meadow)', 0, 1, 1, { step: 0.01, src: 'bike_physics.js — from getSurfaceWeights' }),
      select('style', 'Build', BIKE_STYLES, 'trail', { src: 'bike_audio.js — BUILD.grass 1.00 trail / 1.22 packer, a loaded rack gives the grass more to hit' }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('mGrass', 'model grass gain', (r) => r.audio.bike.state.grass, { src: 'bike_audio.js — min(GROUND_CEIL 0.085, gate · (0.18 + 0.82·sp^1.7) · grassy · grassDrive · build · distance)' }),
      readout('mGBody', 'whip band centre', (r) => r.audio.bike.grass.body.frequency.value, { unit: 'Hz', src: 'bike_audio.js — 2300 · wetness lerp · (1 + sp·0.28), ±620 Hz flutter' }),
      range('grassDrive', 'grass level at full speed', 0, 0.6, 0.14, { step: 0.002, src: 'bike_audio.js — bike.tune.grassDrive; the peak is held by GROUND_CEIL, not by this', apply: K('grassDrive') }),
      range('gBodyQ', 'whip band Q', 0.2, 3, 0.55, { step: 0.01, src: 'bike_audio.js — grass.body', apply: P('bike.grass.body.Q') }),
      range('gTips', 'tips band gain', 0, 1.5, 0.45, { step: 0.01, src: 'bike_audio.js — grass.gTips', apply: P('bike.grass.gTips.gain') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: [
      'bike_audio.js — the 6.4 Hz / 9.1 Hz flutter LFOs and the 1.4 Hz depth-0.34 swell.',
      'bike_audio.js — the sp^1.7 speed law, which is what makes fast grass a rush rather than a louder hiss.',
      'bike_audio.js — GROUND_CEIL 0.085, the hard cap on both ground beds. Drag speed to 10 with the surface at 1 and the meter must FLATTEN, not keep climbing.',
    ],
  },
  {
    id: 'bike.freewheel',
    group: 'Bike',
    label: 'Freewheel ratchet',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'The hero sound, and the only one carrying information nothing else '
      + 'can: it plays while the rider is COASTING and stops dead the instant '
      + 'they pedal. Not a scheduled click train — a high band of white noise '
      + 'amplitude-modulated by a sawtooth at the tick rate (wheel revs × 30 '
      + 'teeth), so it crosses on its own from countable clicks at walking pace '
      + 'to a hard buzz at speed. Push the pedalling slider up and it must '
      + 'vanish; the drivetrain bed is what replaces it.',
    layers: ['bikeFree'],
    frame: bikeBedFrame('bikeFree'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 5, { unit: 'm/s', step: 0.05 }),
      cond('effort', 'Pedalling', 0, 1, 0, { step: 0.01, src: 'bike_audio.js — coasting = clamp01(1 − effort·2.2)' }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('mFree', 'model ratchet gain', (r) => r.audio.bike.state.free, { src: 'bike_audio.js — coasting · freeDrive · distance' }),
      readout('mTick', 'tick rate', (r) => r.audio.bike.free.tick.osc.frequency.value, { unit: 'Hz', src: 'bike_audio.js — revs × 30 teeth, clamped 4–320' }),
      range('freeDrive', 'ratchet level', 0, 0.3, 0.055, { step: 0.001, src: 'bike_audio.js — bike.tune.freeDrive', apply: K('freeDrive') }),
      range('freeQ', 'ratchet band Q', 0.3, 8, 1.6, { step: 0.05, src: 'bike_audio.js — free.band', apply: P('bike.free.band.Q') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: [
      'bike_audio.js — the sawtooth depth 0.92 on a gain centred at 1 (the swell construction).',
      'bike_audio.js — the coasting gate, which is `effort` and NOT inferred from speed.',
    ],
  },
  {
    id: 'bike.drive',
    group: 'Bike',
    label: 'Drivetrain under load',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'Chain and cranks while pedalling: low, dull, and wobbling once per '
      + 'pedal stroke. The wobble is the whole tell — a steady mutter at this '
      + 'pitch reads as a motor. The exact opposite gate to the freewheel, so '
      + 'the two should never both be up.',
    layers: ['bikeDrive'],
    frame: bikeBedFrame('bikeDrive'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 5, { unit: 'm/s', step: 0.05 }),
      cond('effort', 'Pedalling', 0, 1, 1, { step: 0.01 }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      readout('mDrive', 'model drivetrain gain', (r) => r.audio.bike.state.drive, { src: 'bike_audio.js — effort · gate · driveDrive · distance' }),
      readout('mBeat', 'stroke wobble rate', (r) => r.audio.bike.drive.beat.osc.frequency.value, { unit: 'Hz', src: 'bike_audio.js — cadence / 2π' }),
      range('driveDrive', 'drivetrain level', 0, 0.3, 0.045, { step: 0.001, src: 'bike_audio.js — bike.tune.driveDrive', apply: K('driveDrive') }),
      range('driveHz', 'drivetrain band centre', 120, 900, 320, { unit: 'Hz', step: 5, src: 'bike_audio.js — drive.band', apply: P('bike.drive.band.frequency') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: ['bike_audio.js — the cadence wobble depth 0.42 and the 0.4–4.0 Hz clamp.'],
  },
  {
    id: 'bike.brake',
    group: 'Bike',
    label: 'Disc brake',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'Disc rub: high, narrow and deliberately unstable — the band centre '
      + 'wanders ±260 Hz at 5.3 Hz, because a squeal that holds one pitch is a '
      + 'test tone. Scaled by brake AND speed, so a lever held at a standstill '
      + 'makes no sound at all. Drop the speed to zero with the brake at 1 and '
      + 'the meter must go to the floor.',
    layers: ['bikeBrake'],
    frame: bikeBedFrame('bikeBrake'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 6, { unit: 'm/s', step: 0.05 }),
      cond('braking', 'Brake', 0, 1, 1, { step: 0.01 }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      range('brakeDrive', 'brake level', 0, 0.4, 0.075, { step: 0.002, src: 'bike_audio.js — bike.tune.brakeDrive', apply: K('brakeDrive') }),
      range('brakeQ', 'squeal Q', 2, 30, 9, { step: 0.5, src: 'bike_audio.js — brake.band', apply: P('bike.brake.band.Q') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: ['bike_audio.js — the speed gate smoothstep(0.6, 4.0), which is what silences a held lever at rest.'],
  },
  {
    id: 'bike.wade',
    group: 'Bike',
    label: 'Wheels through water',
    kind: 'bed',
    bus: 'bike',
    module: 'src/audio/bike_audio.js',
    blurb: 'Riding a ford. A mid pink band swelling at 1.7 Hz, faded in with the '
      + 'depth — and the bed is only half of it. Entering fires one full-strength '
      + 'splash, and then the wheel-splash clock keeps firing quieter ones for as '
      + 'long as the bike is in the water, tightening from 0.40 s to 0.12 s apart '
      + 'as it speeds up. Raise the speed and the crossing should turn from a few '
      + 'discrete plops into a continuous churn without either one stacking into a '
      + 'peak — the crowding duck is what holds that.',
    layers: ['bikeWade'],
    frame: bikeBedFrame('bikeWade'),
    stop: bikeBedStop,
    params: [
      cond('speed', 'Bike speed', 0, 10, 4, { unit: 'm/s', step: 0.05 }),
      cond('wading', 'Water depth', 0, 1.2, 0.35, { unit: 'm', step: 0.01, src: 'bike_physics.js — WADE_REF 0.90; water is drag, never a wall, so this runs past it' }),
      cond('distance', 'Distance to the bike', 0.5, 30, 3, { unit: 'm', step: 0.5 }),
      cond('azimuth', 'Bearing from the listener', -180, 180, 0, { unit: '°', step: 1 }),
      range('wadeDrive', 'wade level', 0, 0.5, 0.14, { step: 0.005, src: 'bike_audio.js — bike.tune.wadeDrive', apply: K('wadeDrive') }),
      ...BIKE_MIX.slice(1),
    ],
    needs: [
      'bike_audio.js — the entry edge at wade 0.12 and its 0.06 release.',
      'bike_audio.js — the splash clock: lerp(0.40, 0.12) on speed, strength 0.22 + wade·0.42.',
    ],
  },
  bikeCue('mount', 'Getting on',
    'Three things in 300 ms, in the order they happen: the kickstand spring '
    + 'snapping the leg up (a bright 3.1 kHz tick with a shorter one behind it '
    + '— a spring, not a hinge), the frame taking a rider\'s weight (a narrow '
    + 'band swept UP, the only rising gesture in the module), and the tyres '
    + 'settling into the ground under the load.',
    ['bike_audio.js — VOICES.mount: the 0/0.035/0.010/0.090/0.120 s offsets.']),
  bikeCue('dismount', 'Getting off',
    'The reverse gesture and heavier on purpose: the stand comes down under '
    + 'gravity rather than up under a spring, so it is a clunk with a dull '
    + 'triangle body under it, and the frame then rocks onto it and stops.',
    ['bike_audio.js — VOICES.dismount and why it is not `mount` reversed.']),
  bikeCue('bump', 'Running into something',
    'A bank the wheel will not climb, a trunk, a boulder: a dull tyre-on-solid '
    + 'thud at 118 → 74 Hz, the fork loading, and a scuff of the knobs skating '
    + 'sideways as the bike is turned off it.',
    ['bike_audio.js — VOICES.bump; fired on the blocked EDGE above 1.6 m/s, from Bike.update.']),
  bikeCue('splash', 'Wheel into water',
    'The vehicle-splash recipe (pink, 1600 → 460 Hz) twice, a fifth of a second '
    + 'apart, because a bicycle puts two wheels in. STRENGTH is what makes this '
    + 'one voice do two jobs: at 1 it is the entry, a real event; below 0.6 it '
    + 'is one of the repeats that sound all the way across a ford, and the '
    + 'second wheel is dropped because at that level it is not a separate sound, '
    + 'only twice the density.',
    ['bike_audio.js — VOICES.splash; c.strength scales the peaks and gates the second wheel.'],
    [cond('strength', 'Splash strength', 0, 1, 1, { step: 0.01, src: 'bike_audio.js — 1 on entry, 0.22 + wade·0.42 for the repeats' })]),
];

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
      + `is the body of moving air. Level is ${AMBIENCE_LEVELS.grass} · openness · `
      + 'strength · indoors, and strength is a 4.4 dB span — this bed swells, it '
      + 'does not gust.',
    layers: ['grass'],
    meterLayers: ambLayer('grass'),
    frame: ambienceFrame,
    params: [
      WIND, { ...OPEN, def: 0.9 }, ALT, INDOORS,
      readout('mGrass', 'model gain', (r) => r.audio.ambience.state.grass, { src: 'ambience.js — AMBIENCE_LEVELS.grass x openness x strength' }),
      readout('mGrassF', 'grassLow cutoff', (r) => r.audio.ambience.grassLow.frequency.value, { unit: 'Hz', src: 'ambience.js — 760 + breeze·330' }),
      range('grassBandHz', 'grassBand centre', 200, 2200, 820, { unit: 'Hz', step: 1, src: 'ambience.js — grassBand', apply: P('ambience.grassBand.frequency') }),
      range('grassBandQ', 'grassBand Q', 0.1, 4, 0.55, { step: 0.01, src: 'ambience.js — grassBand', apply: P('ambience.grassBand.Q') }),
      range('grassLow2Hz', 'grassLow2 cutoff', 300, 6000, 1500, { unit: 'Hz', step: 1, src: 'ambience.js — grassLow2', apply: P('ambience.grassLow2.frequency') }),
      range('grassLow2Q', 'grassLow2 Q', 0.1, 4, 0.5, { step: 0.01, src: 'ambience.js — grassLow2', apply: P('ambience.grassLow2.Q') }),
      range('grassLowQ', 'grassLow Q', 0.1, 4, 0.7, { step: 0.01, src: 'ambience.js — grassLow', apply: P('ambience.grassLow.Q') }),
      range('grassRate', 'noise playback rate', 0.4, 1.6, 1.0, { step: 0.01, src: 'ambience.js — grassSrc', apply: (r, v) => { r.audio.ambience.grassSrc.playbackRate.value = v; } }),
    ],
    needs: [
      // (the level constant itself is exported as AMBIENCE_LEVELS.grass and read
      //  by main.js, so a trim emitted here is against the live value)
      'ambience.js — grassSwell rate 0.037 Hz / depth 0.13: swell() discards its LFO handle.',
      'ambience.js — the 0.061 Hz / 210 Hz band LFO handle is discarded.',
      'ambience.js — the breeze curve (0.32, 0.94, 0.30 + 0.20·b).',
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
      readout('mConifer', 'model gain', (r) => r.audio.ambience.state.conifer, { src: 'ambience.js — AMBIENCE_LEVELS.conifer x forest x strength' }),
      range('coniferBandHz', 'coniferBand centre', 400, 5000, 1850, { unit: 'Hz', step: 1, src: 'ambience.js — coniferBand', apply: P('ambience.coniferBand.frequency') }),
      range('coniferBandQ', 'coniferBand Q', 0.1, 4, 0.7, { step: 0.01, src: 'ambience.js — coniferBand', apply: P('ambience.coniferBand.Q') }),
      range('coniferHiHz', 'coniferHi cutoff', 100, 2000, 620, { unit: 'Hz', step: 1, src: 'ambience.js — coniferHi', apply: P('ambience.coniferHi.frequency') }),
      range('coniferHiQ', 'coniferHi Q', 0.1, 4, 0.5, { step: 0.01, src: 'ambience.js — coniferHi', apply: P('ambience.coniferHi.Q') }),
      range('coniferCapHz', 'coniferCap cutoff', 800, 12000, 3200, { unit: 'Hz', step: 10, src: 'ambience.js — coniferCap', apply: P('ambience.coniferCap.frequency') }),
      range('coniferCapQ', 'coniferCap Q', 0.1, 4, 0.6, { step: 0.01, src: 'ambience.js — coniferCap', apply: P('ambience.coniferCap.Q') }),
      range('coniferRate', 'noise playback rate', 0.4, 1.6, 0.93, { step: 0.01, src: 'ambience.js — coniferSrc', apply: (r, v) => { r.audio.ambience.coniferSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js — coniferSwell rate 0.029 Hz / depth 0.13.',
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
      readout('mHush', 'model gain', (r) => r.audio.ambience.state.hush, { src: 'ambience.js — AMBIENCE_LEVELS.hush x altitude x lerp(0.80, 1.05, breeze)' }),
      range('hushLowHz', 'hushLow cutoff', 80, 1200, 320, { unit: 'Hz', step: 1, src: 'ambience.js — hushLow', apply: P('ambience.hushLow.frequency') }),
      range('hushLowQ', 'hushLow Q', 0.1, 4, 0.8, { step: 0.01, src: 'ambience.js — hushLow', apply: P('ambience.hushLow.Q') }),
      range('hushRate', 'noise playback rate', 0.3, 1.4, 0.61, { step: 0.01, src: 'ambience.js — hushSrc', apply: (r, v) => { r.audio.ambience.hushSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js — the hush weather term lerp(0.80, 1.05, breeze) is inline in update().',
      'ambience.js — hushSwell rate 0.023 Hz / depth 0.14.',
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
      readout('mCricket', 'model gain', (r) => r.audio.ambience.state.cricket, { src: 'ambience.js — AMBIENCE_LEVELS.cricket x dusk x habitat' }),
      range('cricketBandHz', 'cricketBand centre', 1500, 8000, 4300, { unit: 'Hz', step: 10, src: 'ambience.js — cricketBand', apply: P('ambience.cricketBand.frequency') }),
      range('cricketBandQ', 'cricketBand Q', 0.1, 6, 1.1, { step: 0.01, src: 'ambience.js — cricketBand', apply: P('ambience.cricketBand.Q') }),
      range('cricketRate', 'bed playback rate', 0.6, 1.4, 1.0, { step: 0.01, src: 'ambience.js — cricketSrc', apply: (r, v) => { r.audio.ambience.cricketSrc.playbackRate.value = v; } }),
    ],
    needs: [
      'ambience.js — the dusk / habitat curve around AMBIENCE_LEVELS.cricket is inline in update().',
      'ambience.js — cricketBed(): 9 individuals, 3900-5400 Hz, period 0.30-0.72 s.',
      'ambience.js — update(), the dusk / pre-dawn smoothstep windows.',
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
      cond('chorus', 'Dawn-chorus weight (trigger)', 0, 1, 0.5, { step: 0.01, src: 'ambience.js — _call(), raises the chance of a near call' }),
      readout('mRate', 'model call rate', (r) => r.audio.ambience.state.birdRate, { unit: '/s', src: 'ambience.js — update(), rate' }),
      range('birdBus', 'birdBus gain', 0, 2, 0.78, { step: 0.01, src: 'ambience.js — birdBus', apply: P('ambience.birdBus.gain') }),
      range('birdWet', 'birdWet reverb send', 0, 1, 0.34, { step: 0.01, src: 'ambience.js — birdWet', apply: P('ambience.birdWet.gain') }),
    ],
    needs: [
      'ambience.js — the BIRDS species table (f, bend, n, dur, gap, kind).',
      'ambience.js — update(), the call-rate curve (0.20 + chorus·1.5)·(0.35 + day·0.65).',
      'ambience.js — _call(), near/far call levels 0.16 / 0.055.',
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
      readout('ref', 'reference distance', (r) => r.fallRef(), { unit: 'm', src: 'water.js:146 — 26 + h·1.7 + disc·44' }),
      readout('size', 'wfSize', (r) => r.audio.water.wfSize[0], { src: 'water.js:143' }),
      readout('vlevel', 'voice gain (model)', (r) => r.fallVoice().level, { src: 'water.js:277' }),
      readout('air', 'air-absorption cutoff', (r) => r.fallVoice().air.frequency.value, { unit: 'Hz', src: 'water.js:284 — 17000·e^(-d/210)' }),
      range('fallBase', 'distance-curve base', 0.05, 1.2, 0.42, { step: 0.005, group: 'Distance model', src: 'water.js:277', needs: 'inline constant — the lab re-exponentiates the voice trim to match' }),
      range('fallExp', 'distance-curve exponent', 0.6, 3.2, 1.5, { step: 0.02, group: 'Distance model', src: 'water.js:277', needs: 'inline constant — moved 1.6 → 1.42 → 2.4 → 1.5 already' }),
      range('lowHz', 'low band cutoff', 60, 600, 190, { unit: 'Hz', step: 1, src: 'water.js:30', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.low.frequency.value = v; }); } }),
      range('lowQ', 'low band Q', 0.1, 3, 0.9, { step: 0.01, src: 'water.js:30', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.low.Q.value = v; }); } }),
      range('airQ', 'air-absorption Q', 0.1, 3, 0.6, { step: 0.01, src: 'water.js:36 — the cutoff is modelled, the Q is not', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.air.Q.value = v; }); } }),
      range('bodyHz', 'body band centre', 200, 2500, 620, { unit: 'Hz', step: 1, src: 'water.js:31', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.body.frequency.value = v; }); } }),
      range('bodyQ', 'body band Q', 0.1, 3, 0.5, { step: 0.01, src: 'water.js:31', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.body.Q.value = v; }); } }),
      range('hissHz', 'hiss highpass', 800, 8000, 2600, { unit: 'Hz', step: 10, src: 'water.js:32', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.hiss.frequency.value = v; }); } }),
      range('gBody', 'body band gain', 0, 2, 0.8, { step: 0.01, src: 'water.js:34', apply: (r, v) => { r.audio.water.falls.forEach((x) => { x.gBody.gain.value = v; }); } }),
      range('fallBus', 'fallBus gain', 0, 2, 1.0, { step: 0.01, group: 'Mix', src: 'water.js:97', apply: P('water.fallBus.gain') }),
      range('waterBus', 'water bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:130', apply: P('buses.water.gain') }),
    ],
    needs: [
      'water.js:277 — the 0.42 base and 1.5 exponent of the fall distance curve.',
      'water.js:284 — air absorption 17000·e^(-d/210), clamped 620 … 16000.',
      'water.js:287-288 — the low/hiss distance blends.',
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
    blurb: 'The same voice with different numbers: a higher body band that '
      + 'wanders, a 7.2 kHz air ceiling, a top band kept to a garnish, and a '
      + 'much steeper falloff (2.6) so a creek is gone in eighty metres rather '
      + 'than six hundred. It ran on white noise until the close range measured '
      + 'a 9 kHz centroid with 90% of its energy above 3 kHz — hiss, not water.',
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
      readout('ref', 'reference distance', (r) => r.riverRef(), { unit: 'm', src: 'water.js:302 — 16 + flow·34' }),
      readout('vlevel', 'voice gain (model)', (r) => r.riverVoice().level, { src: 'water.js:303' }),
      readout('air', 'air-absorption cutoff', (r) => r.riverVoice().air.frequency.value, { unit: 'Hz', src: 'water.js:313 — 7200·e^(-d/90)' }),
      readout('vlow', 'low band gain (driven)', (r) => r.riverVoice().gLow.gain.value, { src: 'water.js:318' }),
      readout('vhiss', 'top band gain (driven)', (r) => r.riverVoice().gHiss.gain.value, { src: 'water.js:319' }),
      range('riverBase', 'distance-curve base', 0.02, 0.8, 0.20, { step: 0.005, group: 'Distance model', src: 'water.js:303', needs: 'inline constant' }),
      range('riverExp', 'distance-curve exponent', 0.8, 4.5, 2.6, { step: 0.02, group: 'Distance model', src: 'water.js:303', needs: 'inline constant' }),
      range('lowHz', 'low band cutoff', 100, 900, 300, { unit: 'Hz', step: 1, src: 'water.js:30', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.low.frequency.value = v; }); } }),
      range('bodyHz', 'body band centre', 300, 4000, 900, { unit: 'Hz', step: 5, src: 'water.js:31 — an LFO wanders ±240 Hz around this', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.body.frequency.value = v; }); } }),
      range('bodyQ', 'body band Q', 0.1, 3, 0.5, { step: 0.01, src: 'water.js:31', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.body.Q.value = v; }); } }),
      range('hissHz', 'top band highpass', 1000, 9000, 2300, { unit: 'Hz', step: 10, src: 'water.js:32', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.hiss.frequency.value = v; }); } }),
      range('airQ', 'air-absorption Q', 0.1, 3, 0.6, { step: 0.01, src: 'water.js:36', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.air.Q.value = v; }); } }),
      range('gBody', 'body band gain', 0, 2, 1.45, { step: 0.01, src: 'water.js:34', apply: (r, v) => { r.audio.water.rivers.forEach((x) => { x.gBody.gain.value = v; }); } }),
      range('riverBus', 'riverBus gain', 0, 2, 0.9, { step: 0.01, group: 'Mix', src: 'water.js:98', apply: P('water.riverBus.gain') }),
      range('waterBus', 'water bus gain', 0, 2, 0.55, { step: 0.01, group: 'Mix', src: 'Audio.js:130', apply: P('buses.water.gain') }),
    ],
    needs: [
      'water.js:303 — the 0.20 base and 2.6 exponent of the river distance curve.',
      'water.js:313 — the 7200 Hz air ceiling and its 90 m decay length.',
      'water.js:318-319 — the low and top band distance blends. Both are '
        + 'written every frame now, so they are readouts here, not sliders.',
      'water.js:62 — the burble LFO (0.09-0.15 Hz, ±240 Hz on the body band).',
      'water.js:23 — RIVER_VOICES = 2.',
      'water.js:230 — the 2500 m² "same stretch" rejection radius.',
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
      range('overQ', 'overrun lowpass Q', 0.1, 3, 0.9, { step: 0.01, src: 'vehicle_audio.js:117', apply: P('vehicle.overLP.Q') }),
      select('oversample', 'Waveshaper oversampling', ['none', '2x', '4x'], '2x', { kind: 'param', group: 'Voice', src: 'vehicle_audio.js:87 — aliasing from saturation lands as a shelf up top', apply: (r, v) => { r.audio.vehicle.drive.oversample = v; } }),
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
    blurb: 'Four layers, of which only one is a noise bed: a stream of scheduled '
      + 'stone impacts whose *rate* follows wheel rotation, the tread-block hum '
      + 'at speed·blocks/circumference, the struck carcass, and the sliding '
      + 'contact residual. Drag "Road speed" and listen to the impacts get '
      + 'closer together, not just louder — that is the whole difference between '
      + 'gravel and wind. Solo one layer at a time to hear what each contributes. '
      + 'Grass should still be the quieter surface than rock at a fixed speed.',
    layers: ['tyreGrain', 'tyreBed', 'tyreTread', 'tyreBody'],
    meterLayers: vehLayer('tyreGrain', 'tyreBed', 'tyreTread', 'tyreBody'),
    frame: vehicleFrame,
    params: [
      select('surface', 'Surface under the wheels', SURFACES, 'dirt', { src: 'WorldData.getSurfaceWeights' }),
      cond('speed', 'Road speed', 0, 30, 10, { unit: 'm/s', step: 0.1 }),
      cond('slip', 'Wheel slip (scrub)', 0, 1, 0, { step: 0.01, src: 'vehicle_audio.js — scrub, adds impact rate as well as gain' }),

      // ── what the model is doing right now ──────────────────────────────────
      readout('roll', 'roll model', (r) => r.audio.vehicle.state.tyre, { src: 'vehicle_audio.js — smoothstep(0.4,5,speed)·(0.016+speedN·0.026)' }),
      readout('impactRate', 'impact rate', (r) => r.audio.vehicle.tyres.state.rate, { unit: '/s', src: 'tyre.js:370 — wheelRps · stonesPerRev · surface.rate' }),
      readout('scheduled', 'grains scheduled last frame', (r) => r.audio.vehicle.tyres.state.scheduled, { src: 'tyre.js:_schedule' }),
      readout('treadHz', 'tread block rate', (r) => r.audio.vehicle.tyres.state.treadHz, { unit: 'Hz', src: 'tyre.js:406 — wheelRps · treadBlocks' }),
      readout('grainHz', 'impact ring centre', (r) => r.audio.vehicle.tyres.state.grainHz, { unit: 'Hz', src: 'tyre.js:421 — surface.hz · hzScale' }),
      readout('surfClass', 'surface class', (r) => r.audio.vehicle.state.surface),

      // ── the granular layer: the fix ────────────────────────────────────────
      range('stonesPerRev', 'stones per wheel revolution', 4, 140, 46, {
        step: 1, group: 'Grain', src: 'tyre.js:127 — vehicle.tyres.tune.stonesPerRev',
        apply: T('stonesPerRev'),
      }),
      range('rateScale', 'impact density ×', 0.1, 3, 1, {
        step: 0.01, group: 'Grain', src: 'tyre.js:128 — vehicle.tyres.tune.rateScale',
        apply: T('rateScale'),
      }),
      range('maxRate', 'impact rate ceiling', 60, 900, 460, {
        unit: '/s', step: 10, group: 'Grain', src: 'tyre.js:129 — vehicle.tyres.tune.maxRate (frame budget)',
        apply: T('maxRate'),
      }),
      range('sizeSkew', 'stone size skew', 0.5, 8, 3.0, {
        step: 0.05, group: 'Grain', src: 'tyre.js:130 — vehicle.tyres.tune.sizeSkew; higher = mostly small stones, and it is the long tail that *is* the crest factor',
        apply: T('sizeSkew'),
      }),
      range('jitter', 'spacing irregularity', 0, 1, 0.55, {
        step: 0.01, group: 'Grain', src: 'tyre.js:134 — vehicle.tyres.tune.jitter; 0 is a metronome',
        apply: T('jitter'),
      }),
      range('hzScale', 'impact brightness ×', 0.25, 3, 1, {
        step: 0.01, group: 'Grain', src: 'tyre.js:131 — vehicle.tyres.tune.hzScale',
        apply: T('hzScale'),
      }),
      range('qScale', 'impact resonance ×', 0.2, 4, 1, {
        step: 0.01, group: 'Grain', src: 'tyre.js:132 — vehicle.tyres.tune.qScale; how pitched each stone is',
        apply: T('qScale'),
      }),
      range('decayScale', 'impact ring length ×', 0.2, 4, 1, {
        step: 0.01, group: 'Grain', src: 'tyre.js:133 — vehicle.tyres.tune.decayScale',
        apply: T('decayScale'),
      }),
      range('spread', 'impact stereo width', 0, 1, 0.55, {
        step: 0.01, group: 'Grain', src: 'tyre.js:142 — vehicle.tyres.tune.spread',
        apply: (r, v) => { r.audio.vehicle.tyres.tune.spread = v; r.audio.vehicle.tyres._spreadPan(); },
      }),

      // ── the tread: what makes it knobbly rather than a road tyre ───────────
      range('treadBlocks', 'tread blocks round the tyre', 4, 48, 17, {
        step: 1, group: 'Tread', src: 'tyre.js:139 — vehicle.tyres.tune.treadBlocks; hum = wheelRps · blocks',
        apply: T('treadBlocks'),
      }),
      range('treadDrive', 'tread level', 0, 1.2, 0.30, {
        step: 0.005, group: 'Tread', src: 'tyre.js:137 — vehicle.tyres.tune.treadDrive',
        apply: T('treadDrive'),
      }),

      // ── the carcass ────────────────────────────────────────────────────────
      range('bodyHz', 'carcass resonance', 30, 220, 68, {
        unit: 'Hz', step: 1, group: 'Carcass', src: 'tyre.js:140 — vehicle.tyres.tune.bodyHz',
        apply: T('bodyHz'),
      }),
      range('bodyQ', 'carcass Q', 0.4, 12, 3.0, {
        step: 0.05, group: 'Carcass', src: 'tyre.js:141 — vehicle.tyres.tune.bodyQ',
        apply: T('bodyQ'),
      }),
      range('bodyDrive', 'carcass level', 0, 2, 0.55, {
        step: 0.005, group: 'Carcass', src: 'tyre.js:138 — vehicle.tyres.tune.bodyDrive',
        apply: T('bodyDrive'),
      }),
      range('bodyLP', 'carcass lowpass', 90, 800, 220, {
        unit: 'Hz', step: 5, group: 'Carcass', src: 'tyre.js — bodyLP',
        apply: P('vehicle.tyres.bodyLP.frequency'),
      }),

      // ── the layer balance ──────────────────────────────────────────────────
      range('grainDrive', 'impact level', 0, 2, 0.62, {
        step: 0.005, group: 'Balance', src: 'tyre.js:135 — vehicle.tyres.tune.grainDrive',
        apply: T('grainDrive'),
      }),
      range('bedDrive', 'contact bed level', 0, 1.5, 0.42, {
        step: 0.005, group: 'Balance', src: 'tyre.js:136 — vehicle.tyres.tune.bedDrive; the only continuous layer left, and it is most of the sound on grass and snow',
        apply: T('bedDrive'),
      }),
      range('bedQ', 'contact bed Q', 0.1, 4, 0.8, {
        step: 0.01, group: 'Balance', src: 'tyre.js — bedBand.Q', apply: P('vehicle.tyres.bedBand.Q'),
      }),
      range('bedLP', 'contact bed lowpass', 300, 6000, 1500, {
        unit: 'Hz', step: 10, group: 'Balance', src: 'tyre.js — bedLP', apply: P('vehicle.tyres.bedLP.frequency'),
      }),

      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: [
      'vehicle_audio.js — roll = smoothstep(0.4, 5, speed)·(0.016 + speedN·0.026), the one place the speed/level relationship for the whole contact patch is decided.',
      'tyre.js:98-107 — SURFACE_CHARACTER, the per-surface table (rate, ring Hz, Q, decay, and the four layer levels). Seven surfaces × eight numbers is a spreadsheet, not a slider; the per-layer trims plus the surface selector are how it gets judged.',
      'tyre.js:292 — _rateComp exponent 0.35, which divides out the sqrt(rate) incoherent-sum rise so that density and loudness stay two separate controls.',
      'tyre.js:383 — the tread fade smoothstep(4, 9, speed): below a walking pace the block rate is a flutter rather than a pitch.',
      'tyre.js:317-322 — the grain size→amplitude/pitch/decay mapping constants (0.10+size·0.90, 1.45-size·0.85, 0.65+size·1.6).',
      'tyre.js:73 — CHANNELS = 12, the impact voice pool size.',
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
      range('waterHz', 'ford band centre', 400, 5000, 900, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:150', apply: P('vehicle.waterBand.frequency') }),
      range('waterQ', 'ford band Q', 0.1, 3, 0.9, { step: 0.01, src: 'vehicle_audio.js:150 — below ~0.7 the band leaks its source', apply: P('vehicle.waterBand.Q') }),
      range('waterRate', 'ford noise rate', 0.5, 2, 0.85, { step: 0.01, src: 'vehicle_audio.js:149', apply: (r, v) => { r.audio.vehicle.waterSrc.playbackRate.value = v; } }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
    needs: ['vehicle_audio.js:309 — ford level depth·(0.06 + speedN·0.18).'],
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
      cond('strength', 'Strength', 0, 1, 0.6, { step: 0.01, src: 'vehicle_audio.js:379' }),
      // These three were the reason a player could not tune the splash: it is
      // the sound you hear on entry, but every slider on this page moved the
      // continuous bed instead. `splashPatch` is read by `splash()` on the next
      // trigger, so a one-shot does not need a live AudioParam to be tunable.
      range('splashHz', 'sweep from', 300, 3000, 1400, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:389', apply: SP('f0') }),
      range('splashTo', 'sweep to', 150, 1200, 380, { unit: 'Hz', step: 10, src: 'vehicle_audio.js:390', apply: SP('f1') }),
      range('splashPeak', 'peak level', 0, 1, 0.4, { step: 0.01, src: 'vehicle_audio.js:395', apply: SP('peak') }),
      range('splashAttack', 'attack', 0.002, 0.08, 0.022, { unit: 's', step: 0.001, src: 'vehicle_audio.js:395', apply: SP('attack') }),
      range('vehicleBus', 'vehicle bus gain', 0, 2, 0.75, { step: 0.01, group: 'Mix', src: 'Audio.js:131', apply: P('buses.vehicle.gain') }),
    ],
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

  // ── camp ──────────────────────────────────────────────────────────────────
  //
  // The pop-in / pop-out cues, one entry per object kind. They share a single
  // generator because they share a single *model*: distance, bearing and a
  // direction. What differs between them is the voice, and a voice is code in
  // `camp_props.js` rather than a slider — so each entry says exactly which
  // numbers it cannot reach, in `needs`, rather than offering fake ones.
  //
  // Everything here meters on the `camp` tap, which the fire also uses. That is
  // deliberate: these sit on the fire's bus, and if a cue is loud enough to
  // bury the fire it is loud enough to see it happen on one meter.
  ...CAMP_CUES,

  // ── boat ──────────────────────────────────────────────────────────────────
  //
  // Three continuous layers and five cues, all metering on the `boat` tap.
  // The beds stand a fake boat into `ctx.systems.boat` — the exact shape the
  // layer reads defensively in the game — gated on the rig's active set, so
  // Play/Stop work without trim nodes. The tune sliders write the module's
  // real `boat.tune` block, the tyre pattern.
  ...BOAT_SOUNDS,
  ...BIKE_SOUNDS,

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

  // ── the journal ───────────────────────────────────────────────────────────
  //
  // The scavenger hunt's award ceremony, in the order it plays: the cover
  // swings open, a page turns, the line is crossed off, the photograph is taped
  // in.
  // They belong beside `ui.tick` rather than under a bus, because that is
  // literally where they land — dry into the master, no world position, no
  // reverb send (`journal_audio.js`, "these are not camp props").
  //
  // Judge them in that order and against each other, not one at a time: the
  // whole design argument is a level ladder (the slap is the payoff) and a
  // shape argument (one gesture, not two events), and neither is audible in a
  // single press. `level` is the trim the journal itself uses for a
  // flick-through page as against the one that opens the book.
  {
    id: 'journal.cover',
    group: 'Interface',
    label: 'Journal cover',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/journal_audio.js',
    blurb: 'The front board swung open: a Q 2.4 hinge creak 760 → 1450 → '
      + '980 Hz with eight stick-slip grabs across it, a low swell underneath, '
      + 'and the board arriving on its face. Peak 0.230, 292 ms (first firing '
      + 'on a fresh instance; the peak is a draw spanning 0.193-0.283, and the '
      + 'duration is measured above 0.0015) — the same gesture as the page '
      + 'turn, an octave down and four times as resonant.',
    layers: [],
    trigger: (rig, v) => journalOf(rig).cue('cover', { level: v.level, rate: v.rate }),
    params: [
      range('level', 'Cue level', 0, 1.5, 1, { step: 0.01, src: 'JournalAudio.cue opts.level' }),
      range('rate', 'Speed', 0.5, 2, 1, { step: 0.01, src: 'JournalAudio.cue opts.rate' }),
      range('journalGain', 'journal bus gain', 0, 2, JOURNAL_GAIN, { step: 0.01, group: 'Mix', src: 'journal_audio.js — JOURNAL_GAIN', apply: (r, v) => { journalOf(r).bus.gain.value = v; } }),
    ],
    needs: ['journal_audio.js — VOICES.cover: the hinge arc (Q 2.4, shoulder 0.80), the eight-grab stick-slip table, and the landing at 0.212. Audition it back to back with journal.page — the pair is the test, not either one alone.'],
  },
  {
    id: 'journal.page',
    group: 'Interface',
    label: 'Journal page turn',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/journal_audio.js',
    blurb: 'One band that goes up and comes back down — 700 → 3400 → 950 Hz — '
      + 'with seven ticks of paper grain over it and a soft 200 Hz landing '
      + 'underneath the end of it. Peak 0.114, 372 ms — first firing on a '
      + 'fresh instance; per-firing the peak draws 0.110-0.134.',
    layers: [],
    trigger: (rig, v) => journalOf(rig).cue('page', { level: v.level, rate: v.rate }),
    params: [
      range('level', 'Cue level', 0, 1.5, 1, { step: 0.01, src: 'JournalAudio.cue opts.level — the journal passes < 1 for a flick-through' }),
      range('rate', 'Speed', 0.5, 2, 1, { step: 0.01, src: 'JournalAudio.cue opts.rate — under 1 is a slower, bigger page' }),
      range('journalGain', 'journal bus gain', 0, 2, JOURNAL_GAIN, { step: 0.01, group: 'Mix', src: 'journal_audio.js — JOURNAL_GAIN', apply: (r, v) => { journalOf(r).bus.gain.value = v; } }),
    ],
    needs: ['journal_audio.js — VOICES.page: the arc (f0/f1/f2 700/3400/950, turn 0.32, shoulder 0.70), the seven-tick grain table, and the landing at 0.252.'],
  },
  {
    id: 'journal.cross',
    group: 'Interface',
    label: 'Journal cross-off',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/journal_audio.js',
    blurb: 'A pencil struck through a line: the band rises 1150 → 2500 Hz, the '
      + 'level falls, the pan travels left to right, and four graphite catches '
      + 'land unevenly along it. Peak 0.097, 124 ms — first firing on a fresh '
      + 'instance; per-firing the peak draws 0.077-0.125, the widest of the '
      + 'four, because a four-tick table is mostly transients.',
    layers: [],
    trigger: (rig, v) => journalOf(rig).cue('cross', { level: v.level, rate: v.rate }),
    params: [
      range('level', 'Cue level', 0, 1.5, 1, { step: 0.01, src: 'JournalAudio.cue opts.level' }),
      range('rate', 'Speed', 0.5, 2, 1, { step: 0.01, src: 'JournalAudio.cue opts.rate' }),
      range('journalGain', 'journal bus gain', 0, 2, JOURNAL_GAIN, { step: 0.01, group: 'Mix', src: 'journal_audio.js — JOURNAL_GAIN', apply: (r, v) => { journalOf(r).bus.gain.value = v; } }),
    ],
    needs: ['journal_audio.js — VOICES.cross: the drag arc, the four-catch table, and the 430 Hz board under it.'],
  },
  {
    id: 'journal.slap',
    group: 'Interface',
    label: 'Journal photo slap',
    kind: 'oneshot',
    bus: 'master',
    module: 'src/audio/journal_audio.js',
    blurb: 'A photograph put down and taped: a 150 → 78 Hz body glide, a broad '
      + 'Q 1.1 paper burst that carries the level, and three falling tape ticks. '
      + 'Peak 0.269 — the loudest of the three, and it stays that way through a '
      + '200 Hz high-pass, which took a rebalance. Level with the cover rather '
      + 'than over it: across 24 draws the two have the same mean and the cover '
      + 'is louder on 43% of firings.',
    layers: [],
    trigger: (rig, v) => journalOf(rig).cue('slap', { level: v.level, rate: v.rate }),
    params: [
      range('level', 'Cue level', 0, 1.5, 1, { step: 0.01, src: 'JournalAudio.cue opts.level' }),
      range('rate', 'Speed', 0.5, 2, 1, { step: 0.01, src: 'JournalAudio.cue opts.rate' }),
      range('journalGain', 'journal bus gain', 0, 2, JOURNAL_GAIN, { step: 0.01, group: 'Mix', src: 'journal_audio.js — JOURNAL_GAIN', apply: (r, v) => { journalOf(r).bus.gain.value = v; } }),
    ],
    needs: ['journal_audio.js — VOICES.slap: body 0.160, paper 0.760 at Q 1.1, board, and the three-tick tape table. The paper/body ratio is the small-speaker fix and is the thing to re-measure if it moves.'],
  },
];

// A guard rather than a comment: the lab lists the cues by hand above (each
// wants its own blurb and its own knobs), so a fourth voice added to
// `JOURNAL_CUES` would otherwise just quietly not appear here.
if (JOURNAL_CUES.some((n) => !SOUNDS.some((s) => s.id === `journal.${n}`))) {
  console.warn('[soundlab] journal cue with no entry:', JOURNAL_CUES.filter((n) => !SOUNDS.some((s) => s.id === `journal.${n}`)));
}

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

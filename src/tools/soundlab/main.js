// ─────────────────────────────────────────────────────────────────────────────
//  Sound Lab — the page.
//
//  Pick a sound, hear it, take it apart, and get a config out. The page holds
//  one `Rig` (the real `Audio` system against a synthetic world) and one
//  `Meter`, and everything else is a control surface over the catalogue in
//  `sounds.js`.
//
//  Nothing in `src/audio/*` is edited or imported-and-copied: this page only
//  drives it. If a value it wants is a hard-coded constant, the control is
//  marked and the request is filed rather than the value being faked.
// ─────────────────────────────────────────────────────────────────────────────
import { Rig } from './rig.js';
import { Meter, fmtDb } from './meter.js';
import { SOUNDS, MASTER_PARAMS, MASTER_NEEDS, defaultsFor, byId } from './sounds.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * The single level constant behind each layer, where there is one.
 *
 * A trim in dB is only half an answer — what someone pasting this back into the
 * code needs is the number to type. Where a layer's level is one scalar in one
 * place, the emitted config carries the new value of that scalar; where it is a
 * composite expression it carries the trim and says so.
 */
const LEVEL_CONST = {
  grass: { name: 'grass level', value: 0.235, site: 'src/audio/ambience.js:191' },
  conifer: { name: 'conifer level', value: 0.165, site: 'src/audio/ambience.js:195' },
  hush: { name: 'hush level', value: 0.180, site: 'src/audio/ambience.js:199' },
  cricket: { name: 'cricket level', value: 0.075, site: 'src/audio/ambience.js:210' },
  birds: { name: 'birdBus gain', value: 0.78, site: 'src/audio/ambience.js:147' },
  falls: { name: 'fallBus gain', value: 1.0, site: 'src/audio/water.js:90' },
  rivers: { name: 'riverBus gain', value: 0.9, site: 'src/audio/water.js:91' },
  intake: { name: 'intake level', value: 0.016, site: 'src/audio/vehicle_audio.js:278' },
  overrun: { name: 'overrun level', value: 0.017, site: 'src/audio/vehicle_audio.js:283' },
  grit: { name: 'grit level', value: 0.55, site: 'src/audio/vehicle_audio.js:303' },
  wildlife: { name: 'wildlife sub-bus gain', value: 1.0, site: 'src/audio/wildlife_audio.js:19' },
  music: { name: 'music sub-bus gain', value: 0.9, site: 'src/audio/music.js:30' },
  soundtrack: { name: 'bed level', value: 0.21, site: 'src/audio/soundtrack.js:64' },
};

const state = {
  rig: new Rig(),
  meter: null,
  sound: null,
  vals: new Map(),          // sound id -> values object
  playing: false,
  auto: false,
  autoEvery: 2.5,
  _autoT: 0,
  last: performance.now(),
};

// ── boot ─────────────────────────────────────────────────────────────────────

function boot() {
  buildSoundSelect();
  select(SOUNDS[0].id);

  $('#start').addEventListener('click', onStart);
  $('#play').addEventListener('click', () => (state.playing ? stop() : play()));
  $('#trigger').addEventListener('click', () => trigger());
  $('#auto').addEventListener('change', (e) => { state.auto = e.target.checked; state._autoT = 0; });
  $('#panic').addEventListener('click', () => { stop(); state.rig.panic(); note('Everything stopped.'); });
  $('#meterBus').addEventListener('change', (e) => state.meter?.setBus(e.target.value));
  $('#meterReset').addEventListener('click', () => state.meter?.reset());
  $('#zeroTest').addEventListener('click', zeroTest);
  $('#copyJson').addEventListener('click', copyJson);
  $('#applyJson').addEventListener('click', applyJson);
  $('#resetAll').addEventListener('click', resetAll);
  $('#soundSelect').addEventListener('change', (e) => select(e.target.value));

  requestAnimationFrame(frame);
}

function onStart() {
  const err = state.rig.start();
  const overlay = $('#gate');
  if (err) {
    $('#gateMsg').textContent = err;
    $('#gateMsg').classList.add('bad');
    return;
  }
  overlay.classList.add('gone');
  state.meter = new Meter(state.rig.audio, $('#spectrum'));
  document.body.classList.add('live');
  select(state.sound.id, true);
  note('Context running at ' + state.rig.actx.sampleRate + ' Hz.');
}

// ── sound selection ──────────────────────────────────────────────────────────

function buildSoundSelect() {
  const sel = $('#soundSelect');
  let group = null, og = null;
  for (const s of SOUNDS) {
    if (s.group !== group) {
      group = s.group;
      og = el('optgroup');
      og.label = group;
      sel.appendChild(og);
    }
    const o = el('option', null, s.label);
    o.value = s.id;
    og.appendChild(o);
  }
}

function valsFor(sound) {
  if (!state.vals.has(sound.id)) state.vals.set(sound.id, defaultsFor(sound));
  return state.vals.get(sound.id);
}

function select(id, force = false) {
  const s = byId(id);
  if (!s) return;
  if (s === state.sound && !force && state.rig.audio) return;
  stop();
  // The master chain is downstream of everything, so it is one setting, not one
  // per sound. Values live in each sound's `vals` (that is what the config
  // emitter reads) but they are carried across a switch: turning the volume
  // down and picking a different sound should not turn it back up.
  const prev = state.sound ? valsFor(state.sound) : null;
  state.sound = s;
  if (prev) for (const p of MASTER_PARAMS) valsFor(s)[p.key] = prev[p.key];
  $('#soundSelect').value = id;
  $('#blurb').textContent = s.blurb;
  $('#moduleName').textContent = s.module;
  $('#kind').textContent = s.kind === 'bed' ? 'continuous bed' : 'one-shot';

  const isOne = s.kind === 'oneshot';
  $('#play').hidden = isOne;
  $('#trigger').hidden = !s.trigger;
  $('#autoWrap').hidden = !s.trigger;
  $('#trigger').textContent = s.triggerLabel ?? 'Trigger';

  renderParams();
  renderLayers();
  if (state.rig.audio) {
    applyAll();
    state.rig.setActive([]);
    state.meter.setBus(s.bus);
    $('#meterBus').value = s.bus;
  }
  renderJson();
}

// ── transport ────────────────────────────────────────────────────────────────

async function play() {
  const s = state.sound;
  if (!state.rig.audio) return note('Click "Start audio" first.');
  if (s.start) {
    $('#play').textContent = 'Loading…';
    const err = await s.start(state.rig, valsFor(s));
    if (err) { $('#play').textContent = 'Play'; return note(err, true); }
  }
  state.playing = true;
  state.rig.setActive(s.layers);
  $('#play').textContent = 'Stop';
  $('#play').classList.add('on');
}

function stop() {
  const s = state.sound;
  state.playing = false;
  state.rig.setActive([]);
  if (s?.stop) { try { s.stop(state.rig); } catch { /* nothing playing */ } }
  const b = $('#play');
  if (b) { b.textContent = 'Play'; b.classList.remove('on'); }
}

function trigger() {
  const s = state.sound;
  if (!state.rig.audio) return note('Click "Start audio" first.');
  // A one-shot's own layers have to be audible for the length of the shot.
  state.rig.setActive(s.layers);
  try { s.trigger(state.rig, valsFor(s)); } catch (e) { note(String(e?.message ?? e), true); }
}

// ── parameters ───────────────────────────────────────────────────────────────

function renderParams() {
  const s = state.sound;
  const v = valsFor(s);
  const host = $('#params');
  host.textContent = '';

  const groups = new Map();
  for (const p of [...s.params, ...MASTER_PARAMS]) {
    const g = p.group ?? 'Voice';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  for (const [name, list] of groups) {
    const sec = el('section', 'grp');
    sec.appendChild(el('h3', null, name));
    for (const p of list) sec.appendChild(control(p, v));
    host.appendChild(sec);
  }

  // The master chain is on every sound's panel, so its unreachable constants
  // belong on every sound's list too.
  const needs = [...(s.needs ?? []), ...MASTER_NEEDS];
  const nbox = $('#needs');
  nbox.textContent = '';
  if (needs.length) {
    nbox.appendChild(el('h3', null, 'Not reachable from this page'));
    const ul = el('ul');
    for (const n of needs) ul.appendChild(el('li', null, n));
    nbox.appendChild(ul);
    nbox.appendChild(el('p', 'hint', 'These are hard-coded constants inside src/audio/*. '
      + 'They are filed in docs/INTEGRATION_REQUESTS.md; this page will not refactor '
      + 'someone else’s live module to reach them.'));
  }
}

function control(p, v) {
  const row = el('div', `row ${p.kind}`);
  row.dataset.key = p.key;
  const lab = el('label', 'lab');
  lab.appendChild(el('span', 'name', p.label));
  if (p.unit) lab.appendChild(el('span', 'unit', p.unit));
  if (p.needs) lab.appendChild(el('span', 'flag', 'not exposed'));
  if (p.src) lab.title = p.src;
  row.appendChild(lab);

  if (p.type === 'readout') {
    const out = el('output', 'ro', '—');
    out.dataset.readout = p.key;
    row.appendChild(out);
    row._read = p;
    return row;
  }

  if (p.type === 'toggle') {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!v[p.key];
    cb.addEventListener('change', () => setVal(p, cb.checked));
    row.appendChild(cb);
    row.appendChild(el('span', 'ro', ''));
    return row;
  }

  if (p.type === 'select') {
    const sel = el('select');
    for (const o of p.options) {
      const opt = el('option', null, o);
      opt.value = o;
      sel.appendChild(opt);
    }
    sel.value = v[p.key];
    sel.addEventListener('change', () => setVal(p, sel.value));
    row.appendChild(sel);
    row.appendChild(el('span', 'ro', ''));
    return row;
  }

  const r = el('input');
  r.type = 'range';
  r.min = p.min; r.max = p.max; r.step = p.step;
  r.value = v[p.key];
  const out = el('output', 'ro', fmtVal(v[p.key], p));
  // The shipped default, marked on the track: the number you are moving away
  // from is the number someone already argued about.
  const mark = el('span', 'def', `def ${fmtVal(p.def, p)}`);
  mark.title = p.src ?? '';
  r.addEventListener('input', () => {
    const x = +r.value;
    out.textContent = fmtVal(x, p);
    setVal(p, x);
  });
  r.addEventListener('dblclick', () => { r.value = p.def; out.textContent = fmtVal(p.def, p); setVal(p, p.def); });
  row.appendChild(r);
  row.appendChild(out);
  row.appendChild(mark);
  if (v[p.key] !== p.def) row.classList.add('changed');
  return row;
}

function fmtVal(x, p) {
  if (typeof x !== 'number') return String(x);
  const span = (p.max ?? 1) - (p.min ?? 0);
  const d = span >= 500 ? 0 : span >= 20 ? 1 : span >= 2 ? 2 : 3;
  return x.toFixed(d);
}

function setVal(p, x) {
  const s = state.sound;
  const v = valsFor(s);
  v[p.key] = x;
  if (state.rig.audio) {
    try { p.apply?.(state.rig, x, v); } catch (e) { note(String(e?.message ?? e), true); }
    try { s.onParam?.(state.rig, p.key, v); } catch { /* rebuild refused */ }
  }
  renderJson();
  // Highlight anything that no longer sits on its default.
  const row = $('#params').querySelector(`.row[data-key="${p.key}"]`);
  row?.classList.toggle('changed', x !== p.def);
}

function applyAll() {
  const s = state.sound;
  const v = valsFor(s);
  for (const p of [...s.params, ...MASTER_PARAMS]) {
    if (p.type === 'readout' || !p.apply) continue;
    try { p.apply(state.rig, v[p.key], v); } catch { /* node not built yet */ }
  }
  try { s.onParam?.(state.rig, '*', v); } catch { /* no rebuild hook */ }
  // Water sizes live in the world tables, not on a node.
  if (v.height !== undefined) { state.rig.fall.height = v.height; state.rig.fall.discharge = v.discharge; }
  if (v.flow !== undefined) state.rig.river.flow = v.flow;
  if (v.height !== undefined || v.flow !== undefined) state.rig.refreshWater();
}

// ── layers: solo, mute, trim ─────────────────────────────────────────────────

function renderLayers() {
  const s = state.sound;
  const host = $('#layers');
  host.textContent = '';
  const list = s.meterLayers ?? [];
  $('#layerPanel').hidden = list.length === 0;
  if (!list.length) return;

  for (const L of list) {
    const row = el('div', 'lrow');
    const solo = el('button', 'mini', 'S');
    solo.title = 'Solo this layer within its rig';
    solo.addEventListener('click', () => {
      state.rig.setSolo(L.name);
      renderLayerStates();
    });
    const mute = el('button', 'mini', 'M');
    mute.title = 'Mute this layer';
    mute.addEventListener('click', () => {
      state.rig.setMute(L.name, !state.rig.muted[L.name]);
      renderLayerStates();
      renderJson();
    });
    row.appendChild(solo);
    row.appendChild(mute);
    row.appendChild(el('span', 'lname', L.label));

    const trim = el('input');
    trim.type = 'range';
    trim.className = 'trim';
    trim.min = -36; trim.max = 12; trim.step = 0.5;
    trim.value = state.rig.trimDb[L.name] ?? 0;
    const tout = el('output', 'ro', '0.0 dB');
    trim.addEventListener('input', () => {
      state.rig.setTrim(L.name, +trim.value);
      tout.textContent = `${(+trim.value).toFixed(1)} dB`;
      renderJson();
    });
    row.appendChild(trim);
    row.appendChild(tout);

    const nums = el('span', 'lnums', '—');
    row.appendChild(nums);
    row._layer = L;
    row._solo = solo; row._mute = mute; row._nums = nums;
    host.appendChild(row);
  }
  renderLayerStates();
}

function renderLayerStates() {
  for (const row of $('#layers').children) {
    const n = row._layer.name;
    row._solo.classList.toggle('on', state.rig.solo === n);
    row._mute.classList.toggle('on', !!state.rig.muted[n]);
  }
}

/**
 * The routing check, done by measurement rather than by reading the graph.
 *
 * Mute every layer of the rig for a moment and watch the bus. If the bus does
 * not fall away, something is reaching the mix around the mixer — which is
 * exactly how the ambience LFO bug was caught: zeroing every gain in the bed
 * left it playing within 0.3 dB.
 */
async function zeroTest() {
  const s = state.sound;
  const list = s.meterLayers ?? [];
  if (!state.rig.audio || !list.length) return note('Nothing to zero on this sound.');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const meanRms = async (ms) => {
    const t0 = performance.now();
    let sum = 0, n = 0;
    while (performance.now() - t0 < ms) {
      const m = state.rig.audio.measure(s.bus);
      if (m) { sum += m.rms; n++; }
      await wait(16);
    }
    return n ? sum / n : 0;
  };
  $('#zeroTest').disabled = true;
  const before = await meanRms(1200);
  const saved = list.map((L) => !!state.rig.muted[L.name]);
  for (const L of list) state.rig.setMute(L.name, true);
  await wait(250);
  const after = await meanRms(1200);
  list.forEach((L, i) => state.rig.setMute(L.name, saved[i]));
  renderLayerStates();
  $('#zeroTest').disabled = false;
  const drop = 20 * Math.log10(Math.max(after, 1e-9) / Math.max(before, 1e-9));
  const verdict = before < 1e-5
    ? 'the bus was already silent — nothing was playing'
    : drop < -30 ? 'clean: the mixer owns this bus'
      : `only ${(-drop).toFixed(1)} dB — something is reaching the bus around the layer gains`;
  note(`Zero test on ${s.bus}: ${fmtDb(20 * Math.log10(Math.max(before, 1e-9)))} → `
    + `${fmtDb(20 * Math.log10(Math.max(after, 1e-9)))} dBFS. ${verdict}`, drop > -30 && before >= 1e-5);
}

// ── frame ────────────────────────────────────────────────────────────────────

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - state.last) / 1000);
  state.last = now;
  const rig = state.rig;
  if (!rig.audio) return;

  const s = state.sound;
  const v = valsFor(s);
  if (s.frame) {
    try { s.frame(rig, dt, v); } catch (e) { note(`${s.id}: ${e?.message ?? e}`, true); }
  }

  if (state.auto && s.trigger) {
    state._autoT -= dt;
    if (state._autoT <= 0) { state._autoT = +$('#autoEvery').value; trigger(); }
  }

  state.meter.sample(now);
  state.meter.draw();
  if ((frame._n = (frame._n ?? 0) + 1) % 6 === 0) renderNumbers();
}

function renderNumbers() {
  const st = state.meter.stats;
  if (!st) return;
  const set = (id, txt, bad = false) => {
    const n = $(id);
    n.textContent = txt;
    n.classList.toggle('bad', bad);
  };
  set('#nRms', `${fmtDb(st.rms)} dBFS`);
  set('#nPeak', `${fmtDb(st.hold)} dBFS`, st.hold > -0.5);
  set('#nDba', `${fmtDb(st.dBA)} dBA`);
  set('#nTilt', `${st.tilt >= 0 ? '+' : ''}${fmtDb(st.tilt)} dB`);
  set('#nBite', `${st.bite.toFixed(1)} %`, st.bite > 35);
  set('#nCentroid', `${st.centroid.toFixed(0)} Hz`);
  set('#nFloor', fmtDb(st.floor));
  set('#nP50', fmtDb(st.p50));
  set('#nP90', fmtDb(st.p90));
  set('#nRange', `${fmtDb(st.range)} dB`);
  const silent = st.silent && (state.playing || state.sound.kind === 'oneshot');
  $('#silence').hidden = !(st.silent && state.playing);
  set('#nState', state.rig.actx.state, state.rig.actx.state !== 'running');
  void silent;

  // Readouts
  for (const row of $('#params').querySelectorAll('.row')) {
    const p = row._read;
    if (!p) continue;
    let val;
    try { val = p.read(state.rig); } catch { val = null; }
    const out = row.querySelector('output');
    out.textContent = typeof val === 'number'
      ? (Math.abs(val) >= 100 ? val.toFixed(0) : Math.abs(val) >= 1 ? val.toFixed(2) : val.toFixed(4))
      : String(val ?? '—');
  }

  // Layer model vs realised
  for (const row of $('#layers').children) {
    const L = row._layer;
    let obj = null;
    try { obj = L.get(state.rig); } catch { obj = null; }
    if (!obj) { row._nums.textContent = '—'; continue; }
    let txt = '';
    try {
      const pv = L.param(obj)?.value;
      const mv = L.model ? L.model(obj) : null;
      txt = mv === null
        ? `param ${pv.toFixed(4)}`
        : `model ${mv.toFixed(4)} → param ${pv.toFixed(4)}`;
      if (mv !== null && mv > 1e-6 && pv > 1e-6) {
        const d = 20 * Math.log10(pv / mv);
        if (Math.abs(d) > 1.5) txt += `  (${d > 0 ? '+' : ''}${d.toFixed(1)} dB)`;
        row._nums.classList.toggle('bad', Math.abs(d) > 6);
      } else {
        row._nums.classList.remove('bad');
      }
    } catch { txt = '—'; }
    row._nums.textContent = txt;
  }
}

// ── JSON in / out ────────────────────────────────────────────────────────────

function buildConfig() {
  const s = state.sound;
  const v = valsFor(s);
  const conditions = {}, params = {}, master = {};
  const sites = {}, needs = [];

  for (const p of s.params) {
    if (p.type === 'readout') continue;
    if (v[p.key] === p.def) continue;
    (p.kind === 'condition' ? conditions : params)[p.key] = v[p.key];
    // Where the value lives in the code, so it can be pasted back without a
    // search — and, separately, whether it can be reached from this page at
    // all. A `src` is not a complaint; only a `needs` is.
    if (p.src) sites[p.key] = p.src;
    if (p.needs) needs.push(`${p.key}: ${p.src ?? '?'} — ${p.needs}`);
  }
  for (const p of MASTER_PARAMS) {
    if (v[p.key] !== p.def) master[p.key] = v[p.key];
  }

  const layers = {};
  for (const L of s.meterLayers ?? []) {
    const db = state.rig.trimDb[L.name] ?? 0;
    const muted = !!state.rig.muted[L.name];
    if (!db && !muted) continue;
    const entry = { trimDb: db };
    if (muted) entry.muted = true;
    const c = LEVEL_CONST[L.name];
    if (c && db) {
      entry.suggested = {
        what: c.name,
        site: c.site,
        current: c.value,
        value: +(c.value * 10 ** (db / 20)).toPrecision(3),
      };
    }
    layers[L.name] = entry;
  }

  const st = state.meter?.stats;
  // `-inf` is a real reading, but it is not a number JSON can carry; null says
  // "measured, and it was silence" rather than quietly becoming 0.
  const num = (x, d = 1) => (Number.isFinite(x) ? +x.toFixed(d) : null);
  const cfg = {
    tool: 'procedural-autumn/soundlab',
    sound: s.id,
    module: s.module,
    captured: new Date().toISOString(),
  };
  if (Object.keys(conditions).length) cfg.conditions = conditions;
  if (Object.keys(params).length) cfg.params = params;
  if (Object.keys(layers).length) cfg.layers = layers;
  if (Object.keys(master).length) cfg.master = master;
  if (Object.keys(sites).length) cfg.sites = sites;
  if (st && Number.isFinite(st.rms)) {
    cfg.measured = {
      bus: state.meter.bus,
      rms: num(st.rms),
      peak: num(st.hold),
      dBA: num(st.dBA),
      tilt: num(st.tilt),
      bitePct: num(st.bite),
      centroidHz: num(st.centroid, 0),
      floor: num(st.floor),
      p50: num(st.p50),
      windowSeconds: num(st.samples / 60),
    };
  }
  if (needs.length) cfg.needsExposing = needs;
  if (!cfg.conditions && !cfg.params && !cfg.layers && !cfg.master) {
    cfg.note = 'Everything is on its shipped default.';
  }
  return cfg;
}

function renderJson() {
  $('#json').value = JSON.stringify(buildConfig(), null, 2);
}

async function copyJson() {
  const text = $('#json').value;
  try {
    await navigator.clipboard.writeText(text);
    note('Config copied.');
  } catch {
    $('#json').select();
    note('Select-all done — press ⌘C.');
  }
}

function applyJson() {
  let cfg;
  try { cfg = JSON.parse($('#json').value); } catch (e) { return note(`Not valid JSON: ${e.message}`, true); }
  if (cfg.sound && cfg.sound !== state.sound.id) {
    if (!byId(cfg.sound)) return note(`Unknown sound "${cfg.sound}".`, true);
    select(cfg.sound);
  }
  const s = state.sound;
  const v = valsFor(s);
  const incoming = { ...(cfg.conditions ?? {}), ...(cfg.params ?? {}), ...(cfg.master ?? {}) };
  let n = 0;
  for (const p of [...s.params, ...MASTER_PARAMS]) {
    if (p.type === 'readout') continue;
    v[p.key] = p.key in incoming ? incoming[p.key] : p.def;
    if (p.key in incoming) n++;
  }
  for (const L of s.meterLayers ?? []) {
    const e = cfg.layers?.[L.name];
    state.rig.trimDb[L.name] = e?.trimDb ?? 0;
    state.rig.muted[L.name] = !!e?.muted;
  }
  state.rig.solo = null;
  state.rig.applyTrims();
  renderParams();
  renderLayers();
  applyAll();
  renderJson();
  note(`Applied ${n} value(s) to ${s.id}.`);
}

function resetAll() {
  const s = state.sound;
  state.vals.set(s.id, defaultsFor(s));
  for (const L of s.meterLayers ?? []) { state.rig.trimDb[L.name] = 0; state.rig.muted[L.name] = false; }
  state.rig.solo = null;
  state.rig._extra = {};
  state.rig.applyTrims();
  renderParams();
  renderLayers();
  applyAll();
  renderJson();
  note('Back to the shipped defaults.');
}

function note(msg, bad = false) {
  const n = $('#note');
  n.textContent = msg;
  n.classList.toggle('bad', bad);
}

// ── headless harness hook ────────────────────────────────────────────────────
// tools/_scratch/soundlab-check.mjs drives the page through this.
window.__lab = {
  start: onStart,
  select: (id) => select(id),
  play, stop, trigger,
  sounds: () => SOUNDS.map((s) => s.id),
  setParam: (key, x) => {
    const p = [...state.sound.params, ...MASTER_PARAMS].find((q) => q.key === key);
    if (!p) throw new Error(`no param ${key} on ${state.sound.id}`);
    setVal(p, x);
    renderParams();
  },
  setTrim: (name, db) => { state.rig.setTrim(name, db); renderJson(); },
  vals: () => ({ ...valsFor(state.sound) }),
  trims: () => ({ ...state.rig.trimDb }),
  stats: () => state.meter?.stats ?? null,
  json: () => $('#json').value,
  setJson: (t) => { $('#json').value = t; },
  applyJson,
  ready: () => !!state.rig.audio,
};

boot();

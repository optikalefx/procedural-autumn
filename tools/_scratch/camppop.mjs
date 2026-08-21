#!/usr/bin/env node
/**
 * Camp pop cue check.
 *
 *   node tools/_scratch/camppop.mjs
 *
 * Every number below is read off the running `camp` analyser tap, not off the
 * source. What it has to prove:
 *
 *   1. every kind sounds at all, and none is buried
 *   2. pitching a real camp raises the camp bus over its own silence
 *   3. striking it does too, and is quieter than pitching
 *   4. distance attenuates
 *   5. eight props at once do not exceed the fire's own crackle headroom
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const KINDS = ['ground', 'fire', 'tent', 'chair', 'cooler', 'table', 'woodpile', 'telescope'];
const lin = (v) => (typeof v === 'object' && v ? v.rms : v);
const dB = (v) => (lin(v) > 1e-9 ? 20 * Math.log10(lin(v)) : -Infinity);
const dBp = (v) => (v?.pk > 1e-9 ? 20 * Math.log10(v.pk) : -Infinity);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf');
let fails = 0;
const check = (name, pass, detail = '') => {
  if (!pass) fails++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const release = await acquire('camppop');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
// Vite reloads the page the moment anything is saved, and a reload halfway
// through a two-minute measurement invalidates every number in it.
await page.addInitScript(() => {
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
      return { readyState: 3, url, protocol: '', addEventListener() {}, removeEventListener() {},
               send() {}, close() {}, set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {} };
    }
    return new Real(url, protocols);
  };
  window.WebSocket.prototype = Real.prototype;
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto('http://127.0.0.1:5178/?res=640', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.mouse.click(450, 260);
await page.waitForFunction(() => window.__audio?.started && window.__audio.actx.state === 'running',
  null, { timeout: 20000, polling: 100 });
await page.waitForTimeout(600);

await page.evaluate(() => {
  // Peak of the rms envelope over a window. One analyser read is a 340 ms
  // slice and a 40 ms clack can fall entirely between two of them.
  window.__peak = (bus, ms) => new Promise((resolve) => {
    const a = window.__audio;
    let rms = 0, pk = 0;
    const t0 = performance.now();
    const tick = () => {
      const m = a.measure(bus);
      if (m) { if (m.rms > rms) rms = m.rms; if (m.peak > pk) pk = m.peak; }
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve({ rms, pk });
    };
    requestAnimationFrame(tick);
  });
});

// ── 0. the graph exists ─────────────────────────────────────────────────────
const wired = await page.evaluate(() => {
  const c = window.__audio.camp;
  return { hasProps: !!c?.props, hasCue: typeof c?.cue === 'function', L: !!c?.props?.L };
});
check('CampProps is wired to CampAudio', wired.hasProps && wired.hasCue, JSON.stringify(wired));
check('the listener sample reaches the cues', wired.L);

// ── 1. every kind sounds ────────────────────────────────────────────────────
const floor = await page.evaluate(() => window.__peak('camp', 700));
console.log(`\n  camp bus floor (no camp, nothing triggered): ${f(dBp(floor))} dBFS peak\n`);

const per = {};
for (const kind of KINDS) {
  const at = { in: null, out: null };
  for (const out of [false, true]) {
    at[out ? 'out' : 'in'] = await page.evaluate(async ({ kind, out }) => {
      const L = window.__audio.L;
      const p = window.__peak('camp', 900);
      window.__audio.camp.cue(kind, { x: L.x, z: L.z + 8, out });
      return p;
    }, { kind, out });
    await page.waitForTimeout(200);
  }
  per[kind] = at;
  const din = dBp(at.in), dout = dBp(at.out);
  const audible = din > dBp(floor) + 12;
  const quieter = dout < din + 0.5;
  check(`${kind.padEnd(10)} sounds, and packs away quieter`, audible && quieter,
    `in ${f(din).padStart(7)} pk / ${f(dB(at.in)).padStart(7)} rms   ` +
    `out ${f(dout).padStart(7)} pk / ${f(dB(at.out)).padStart(7)} rms  (${f(dout - din)} dB)`);
}

// ── 2. spread across kinds ──────────────────────────────────────────────────
const levels = KINDS.map((k) => dBp(per[k].in));
const spread = Math.max(...levels) - Math.min(...levels);
check('no kind is buried under the others', spread < 14, `${f(spread)} dB between loudest and quietest`);

// ── 3. distance attenuates ──────────────────────────────────────────────────
const near = await page.evaluate(async () => {
  const L = window.__audio.L; const p = window.__peak('camp', 800);
  window.__audio.camp.cue('tent', { x: L.x, z: L.z + 4 }); return p;
});
await page.waitForTimeout(200);
const far = await page.evaluate(async () => {
  const L = window.__audio.L; const p = window.__peak('camp', 800);
  window.__audio.camp.cue('tent', { x: L.x, z: L.z + 26 }); return p;
});
check('distance attenuates', dBp(near) - dBp(far) > 8,
  `4 m ${f(dBp(near))} dBFS → 26 m ${f(dBp(far))} dBFS  (${f(dBp(near) - dBp(far))} dB)`);
const gone = await page.evaluate(async () => {
  const L = window.__audio.L; const p = window.__peak('camp', 700);
  window.__audio.camp.cue('tent', { x: L.x, z: L.z + 60 }); return p;
});
check('past the reach, nothing is scheduled at all', gone.pk < 1e-5,
  `60 m ${f(dBp(gone))} dBFS peak (floor ${f(dBp(floor))})`);

// ── 4. a real camp ──────────────────────────────────────────────────────────
await page.waitForTimeout(400);
const pitch = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  camp.strike();
  await new Promise((r) => setTimeout(r, 400));
  const L = window.__audio.L;
  const quiet = await window.__peak('camp', 700);
  const p = window.__peak('camp', 1700);
  // Walk outward looking for a FULL camp. The ground round the start is
  // cluttered enough that the nearest site is often the compact two-prop
  // layout, and two props is not a test of a cue system built for eight — but
  // a two-prop camp still beats no camp, so take the best on offer rather than
  // insisting.
  let c = null;
  for (const [ox, oz] of [[0, 0], [16, 0], [0, 16], [-16, 0], [0, -16], [12, 12], [-12, -12], [24, 8]]) {
    const t = camp.pitchNear(L.x + ox, L.z + oz, { instant: false, radius: 14 });
    if (!t) continue;
    if (c) camp._strike(c.queue.length > t.queue.length ? t : c, true);
    if (!c || t.queue.length > c.queue.length) c = t;
    if (c.queue.length >= 6) break;
  }
  const peak = await p;
  await new Promise((r) => setTimeout(r, 500));
  const props = c ? c.props.map((q) => q.item.kind) : [];
  const dist = c ? Math.hypot(c.x - L.x, c.z - L.z) : -1;
  return { quiet, peak, props, dist, cues: window.__audio.camp.props.state.cues,
           dropped: window.__audio.camp.props.state.dropped };
});
check('pitching a camp raises the camp bus', dBp(pitch.peak) - dBp(pitch.quiet) > 12,
  `silence ${f(dBp(pitch.quiet))} dBFS → raise ${f(dBp(pitch.peak))} dBFS ` +
  `(${f(dBp(pitch.peak) - dBp(pitch.quiet))} dB), ${pitch.props.length} props ` +
  `[${pitch.props.join(' ')}] at ${f(pitch.dist)} m`);

const strike = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  const c = camp.camps[camp.camps.length - 1];
  const before = window.__audio.camp.props.state.cues;
  if (c) await new Promise((r) => setTimeout(r, 300));
  const p = window.__peak('camp', 1400);
  if (c) c.striking = true;
  const peak = await p;
  return { peak, fired: window.__audio.camp.props.state.cues - before };
});
check('striking it sounds too, and is quieter than pitching',
  dBp(strike.peak) - dBp(pitch.quiet) > 8 && dBp(strike.peak) < dBp(pitch.peak),
  `strike ${f(dBp(strike.peak))} dBFS vs pitch ${f(dBp(pitch.peak))} dBFS, ${strike.fired} cues`);

// ── 4c. the harness path stays silent ───────────────────────────────────────
//
// `pitchAt(instant)` is how every capture in `campshot.mjs` builds its camp,
// and it slams eight props in on one frame. If `_applyRaise` sounded from
// there, every contact sheet would fire eight cues at once — inaudible in a
// headless run, and a burst of noise the first time anyone ran it headed.
const instant = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  camp.strike();
  await new Promise((r) => setTimeout(r, 700));
  const L = window.__audio.L;
  const before = window.__audio.camp.props.state.cues;
  const c = camp.pitchNear(L.x, L.z, { instant: true, radius: 14 });
  await new Promise((r) => setTimeout(r, 700));
  return { fired: window.__audio.camp.props.state.cues - before, props: c ? c.props.length : 0 };
});
check('an instantly-pitched camp fires no cues at all', instant.fired === 0,
  `${instant.props} props built in one frame, ${instant.fired} cues`);

// Striking THAT camp — one the cue system has never seen a raise for — must
// still sound, and must not announce its fire lighting on the way down.
const strikeInstant = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  const c = camp.camps[camp.camps.length - 1];
  const before = window.__audio.camp.props.state.cues;
  const p = window.__peak('camp', 1400);
  if (c) c.striking = true;
  const peak = await p;
  return { peak, fired: window.__audio.camp.props.state.cues - before };
});
check('packing up a harness-pitched camp still sounds', strikeInstant.fired > 0 && strikeInstant.peak.pk > 1e-4,
  `${strikeInstant.fired} cues, ${f(dBp(strikeInstant.peak))} dBFS`);

// ── 4d. the density case ────────────────────────────────────────────────────
//
// The meadow `campshot.mjs` parks in builds the full eight — chair, chair,
// chair, chair, woodpile, table, cooler, tent — which is the case this whole
// file is mixed for and the one the sites near the spawn never produce. Four
// chairs land inside a quarter of a second there.
const dense = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  camp.strike();
  window.__vehicleTeleport?.(823, 551, 0.9);
  await new Promise((r) => setTimeout(r, 1800));
  const L = window.__audio.L;
  const before = window.__audio.camp.props.state.cues;
  const quiet = await window.__peak('camp', 700);
  const p = window.__peak('camp', 1900);
  const c = camp.pitchNear(L.x, L.z, { instant: false, radius: 14 });
  const peak = await p;
  return { quiet, peak, n: c ? c.queueN : 0,
           kinds: c ? c.props.map((q) => q.item.kind).join(' ') : '',
           fired: window.__audio.camp.props.state.cues - before };
});
// The invariant, not the prop count: exactly one cue per prop, plus the
// clearing and the fire. Asserting on the count instead would be asserting on
// which site `pitchNear` happened to like — it hands back anything from three
// props to eight depending on where the boom left the camera.
check('a full camp sounds every prop it builds, once each',
  dense.n >= 5 && dense.fired === dense.n + 2,
  `${dense.n} props [${dense.kinds}], ${dense.fired} cues = ${dense.n} props + clearing + fire`);
check('a full camp stays inside the same level as a small one', dBp(dense.peak) < -18,
  `every prop at once peaks ${f(dBp(dense.peak))} dBFS on the camp tap`);

// ── 4e. the level, in absolute terms, at a reference distance ──────────────
//
// This started as "compare it to the fire" — the fire's crackles being the one
// layer here whose loudness had supposedly already been argued out. Two
// measurements killed that idea, and both are worth keeping:
//
//  1. `Camp` had no `fire` getter, and `CampAudio.update` gates its whole
//     layer on `camp?.fire`. The camp fire has never made a sound in this
//     game. It cannot have been tuned by ear, so it is not a reference.
//  2. Its crackle gains are nominal, not resulting amplitudes — pink noise
//     through a Q 5.5 band, the same two losses `camp_props.js` corrects for
//     in `bwGain` and `_srcNorm`. Forty forced crackles at level 0.166 peak
//     at about -51 dBFS where the numbers in `_crackle` imply -25.
//
// So the assertion is an absolute band at a fixed distance, and the fire
// comparison is printed as a finding for whoever owns `camp_audio.js`.
//
// The band: -28 to -16 dBFS peak on the camp tap at 8 m, which is where
// CUE_GAIN 3.6 puts them. This band moved once already — it was -34 to -22,
// set from "a few dB under the ambience floor", and the player heard that as
// "low". The band follows the ear; it does not lead it. What it is FOR is
// catching a voice that drifts away from its neighbours, not deciding how
// loud the layer should be.
const REF_M = 8;
const vsFire = await page.evaluate(async (refM) => {
  const camp = window.__systems.camp;
  const audio = window.__audio;
  const props = audio.camp.props;
  const trim = props.bus.gain.value;
  camp.strike();
  await new Promise((r) => setTimeout(r, 700));
  const L0 = audio.L;
  const c = camp.pitchNear(L0.x, L0.z, { instant: true, radius: 14 });
  await new Promise((r) => setTimeout(r, 2000));
  const dist = c ? Math.hypot(c.x - audio.L.x, c.z - audio.L.z) : -1;
  const level = audio.camp.state.level;

  // The fire, SAMPLED rather than waited for: its crackles are a random
  // process with a long tail (62% ticks, 30% knocks, 8% snaps, 1-6 s apart at
  // this distance), and a fourteen second window caught three ticks and called
  // them the loudest crackle. Forty forced draws reach the snaps.
  let fire = { pk: 0 };
  if (c) {
    props.bus.gain.value = 0;
    const p = window.__peak('camp', 5400);
    for (let i = 0; i < 40; i++) {
      setTimeout(() => { try { audio.camp._crackle(audio.L); } catch { /* ignore */ } }, 60 + i * 125);
    }
    fire = await p;
    props.bus.gain.value = trim;
  }

  // Every cue at exactly `refM` straight ahead of the listener, so the band
  // below is a property of the voices and not of where a camp happened to fit.
  const cue = {};
  for (const kind of ['tent', 'chair', 'woodpile', 'table', 'cooler', 'telescope', 'ground', 'fire']) {
    const L = audio.L;
    const p = window.__peak('camp', 800);
    props.cue(kind, { x: L.x, z: L.z + refM });
    cue[kind] = (await p).pk;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { fire, cue, dist, level };
}, REF_M);

const fireDb = dBp(vsFire.fire);
const entries = Object.entries(vsFire.cue).map(([k, v]) => [k, dB(v)]).sort((a, b) => a[1] - b[1]);
const lo = entries[0][1], hi = entries[entries.length - 1][1];
console.log(`\n  every cue at ${REF_M} m, camp tap peak:`);
for (const [k, d] of entries) console.log(`    ${k.padEnd(10)} ${f(d).padStart(7)} dBFS`);
check(`every cue lands in the -28 .. -16 dBFS band at ${REF_M} m`, lo > -28 && hi < -16,
  `${f(lo)} .. ${f(hi)} dBFS, spread ${f(hi - lo)} dB`);

console.log(`\n  FINDING for camp_audio.js — the fire, now that it plays at all:`);
console.log(`    40 forced crackles at ${f(vsFire.dist)} m (level ${f(vsFire.level, 3)}) peak ${f(fireDb)} dBFS.`);
console.log(`    _crackle's own numbers imply about -25 dBFS there. Pink noise through`);
console.log(`    a Q 5.5 band loses the difference; camp_props.js corrects the same two`);
console.log(`    losses in bwGain / _srcNorm. The fire is ~${f(-25 - fireDb)} dB under its intent.`);

// ── 5. headroom ─────────────────────────────────────────────────────────────
const master = await page.evaluate(async () => {
  const camp = window.__systems.camp;
  const L = window.__audio.L;
  await new Promise((r) => setTimeout(r, 600));
  const p = window.__peak('master', 1800);
  camp.pitchNear(L.x, L.z, { instant: false, radius: 10 });
  const peak = await p;
  return { peak, reduction: window.__audio.limiter.reduction };
});
check('a camp raising does not clip the master', master.peak.pk < 0.98,
  `master peak ${f(dBp(master.peak))} dBFS, limiter reduction ${f(master.reduction)} dB`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n${fails ? `${fails} FAILED` : 'all checks passed'}`);
await browser.close();
await release();
process.exit(fails ? 1 : 0);

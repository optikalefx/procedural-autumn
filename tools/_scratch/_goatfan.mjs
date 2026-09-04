#!/usr/bin/env node
/**
 * The probe fan on a mountain, and what it costs the goat.
 *
 * Steps `Wildlife.update` ONLY — no renderer, no `e._loop()` — so 600 sim-s
 * costs seconds of wall clock instead of a quarter of an hour. Everything the
 * brain does is in that call; the rig and the draw are not, and nothing here
 * reads them.
 *
 * Reports, per species:
 *   fan histogram   which of the seven bearings the fan chose, as a share of
 *                   probe ticks. A healthy fan sits on 0 and reaches for the
 *                   wings occasionally; one that lives on +-1.7 is not
 *                   avoiding anything, it is being driven by the terrain.
 *   flips/min       `_avoid` changing by more than 1 rad between ticks
 *   faces/min       heading reversed > `--deg` inside `--window` s
 *   slope stats     what ground the animal is actually standing on
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatfan.mjs
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '600'));
const SPECS = arg('species', 'goat,ram,deer').split(',');
const WANT_ROCK = arg('rock', 'any');
const DEG = parseFloat(arg('deg', '150'));
const WINDOW = parseFloat(arg('window', '2.5'));

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0;
  wl.debugClear(); wl.debugThreat(null);
  e.stop();                                  // nothing renders; we drive wildlife directly

  const FAN = [0, -0.42, 0.42, -0.95, 0.95, -1.7, 1.7];
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const B = wl.pool.deer[0][0].brain.constructor.prototype;
  const steer = B._steer;
  const seen = new Map();                    // brain -> record
  B._steer = function (dt, Wd, Sc) {
    const a0 = this._avoid;
    const probed = this._probeT - dt <= 0 && (this.wantSpeed > 0.05 || this.speed > 0.05);
    steer.call(this, dt, Wd, Sc);
    const r = seen.get(this); if (!r) return;
    if (probed) {
      r.ticks++;
      const i = FAN.indexOf(this._avoid);
      if (i >= 0) r.fan[i]++; else r.fanOther++;      // +-2.2 is the saturation escape
      if (Math.abs(this._avoid - a0) > 1.0) r.flips++;
    }
  };

  const res = {};
  for (const SPEC of P.SPECS) {
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const cfg = wl.pool[SPEC][0][0].brain.cfg.rock;
    let bands = 0, withRock = 0, pick = null;
    for (let i = 0; i < S.n; i++) {
      if (S.spec[i] !== ki) continue;
      bands++;
      let has = false;
      if (cfg) { const g = { rocks: null }; wl._findPerches(g, S.x[i], S.z[i], cfg); has = g.rocks.length > 0; }
      if (has) withRock++;
      const want = !cfg || P.WANT_ROCK === 'any' || (P.WANT_ROCK === 'yes') === has;
      if (want && pick === null) pick = i;
    }
    if (pick === null) { res[SPEC] = { error: 'no site' }; continue; }

    // Despawn everything, park beside the chosen site, and let `_scan` wake it.
    wl.debugClear();
    window.__forceCamera = true;
    const cx = S.x[pick] + 14, cz = S.z[pick] + 14;
    e.camera.position.set(cx, W.getHeight(cx, cz) + 3.2, cz);
    e.camera.lookAt(cx + 14, W.getHeight(cx, cz) + 3.2, cz + 14);
    e.camera.updateMatrixWorld(true);

    const DT = 1 / 30, steps = Math.round(P.SECONDS / DT);
    const lag = Math.max(1, Math.round(P.WINDOW / DT));
    const LIM = P.DEG * Math.PI / 180;
    seen.clear();
    const agg = { fan: FAN.map(() => 0), fanOther: 0, ticks: 0, flips: 0 };
    let frames = 0, faces = 0, slopeSum = 0, slopeMax = 0, rockFrames = 0, pinMax = 0;
    const where = {}, stateFrames = {};
    let t = 0;
    for (let s = 0; s < steps; s++) {
      t += DT;
      wl.update(DT, t);
      for (const per of wl.pool[SPEC]) for (const a of per) {
        if (!a.active) continue;
        const b = a.brain;
        let r = seen.get(b);
        if (!r) seen.set(b, r = { fan: FAN.map(() => 0), fanOther: 0, ticks: 0, flips: 0, h: [], st: [], cool: 0 });
        frames++;
        stateFrames[NM[b.state]] = (stateFrames[NM[b.state]] || 0) + 1;
        if (b.rock) rockFrames++;
        pinMax = Math.max(pinMax, b._pinned);
        const sl = W.getSlope(b.pos.x, b.pos.z);
        slopeSum += sl; if (sl > slopeMax) slopeMax = sl;
        r.h.push(b.heading); r.st.push(b.state);
        if (r.h.length > lag + 1) { r.h.shift(); r.st.shift(); }
        if (r.h.length === lag + 1 && r.cool <= 0
            && Math.abs(wrap(r.h[r.h.length - 1] - r.h[0])) > LIM) {
          faces++; r.cool = lag;
          const tag = `${NM[r.st[0]]}->${NM[r.st[r.st.length - 1]]}`;
          where[tag] = (where[tag] || 0) + 1;
        }
        if (r.cool > 0) r.cool--;
      }
    }
    for (const r of seen.values()) {
      agg.ticks += r.ticks; agg.flips += r.flips; agg.fanOther += r.fanOther;
      for (let i = 0; i < FAN.length; i++) agg.fan[i] += r.fan[i];
    }
    const mins = frames / 30 / 60;
    const pct = (n) => +(100 * n / Math.max(agg.ticks, 1)).toFixed(1);
    res[SPEC] = {
      bands, withRock, site: pick, animals: seen.size,
      animalMinutes: +mins.toFixed(2),
      facesPerMin: +(faces / Math.max(mins, 1e-6)).toFixed(2),
      flipsPerMin: +(agg.flips / Math.max(mins, 1e-6)).toFixed(1),
      fanPct: Object.fromEntries(FAN.map((a, i) => [a.toFixed(2), pct(agg.fan[i])])),
      fanEscapePct: pct(agg.fanOther),
      fanStraightPct: pct(agg.fan[0]),
      slopeMean: +(slopeSum / Math.max(frames, 1)).toFixed(2),
      slopeMax: +slopeMax.toFixed(2),
      rockPct: +(100 * rockFrames / Math.max(frames, 1)).toFixed(1),
      pinMax: +pinMax.toFixed(1),
      where, stateFrames,
    };
  }
  return res;
}, { SECONDS, SPECS, WANT_ROCK, DEG, WINDOW });

console.log(JSON.stringify(out, null, 2));
await browser.close();

#!/usr/bin/env node
/**
 * How much of a goat's life is spent TURNING, against the deer's.
 *
 * `_aboutface.mjs`'s reversal counter is saturated at zero since the turn
 * radius started growing with speed: nothing in the cast can now move 150
 * degrees inside a 2.5 s window, so a metric written against that threshold
 * says every species is perfect while the report says otherwise. These
 * measure the shape of the motion instead, which is what the eye reads:
 *
 *   yawDegPerMin   integral of |yawRate|. A goat that walks a straight line
 *                  and a goat that circles cover the same ground; only this
 *                  separates them.
 *   windingMax     the largest NET heading change inside `--wind` seconds.
 *                  360 here is a literal spin.
 *   reversalsPerMin  a sustained turn one way (>= 0.6 s, >= 25 deg) followed
 *                  by a sustained turn the other. This is "switching
 *                  directions all the time" as a number.
 *   pathEff        net displacement / distance walked over `--wind` s, over
 *                  moving frames only. 1.0 is a straight line.
 *   stallPct       moving frames whose speed is under 55% of the animal's own
 *                  cruising walk -- the band where the walk clip is being
 *                  crossfaded against Stand instead of played, which is what
 *                  "the walk doesn't loop properly" looks like from here.
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatturn.mjs
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '600'));
const SPECS = arg('species', 'goat,ram,deer').split(',');
const WIND = parseFloat(arg('wind', '6'));
const SITES = parseInt(arg('sites', '4'), 10);
// Park a pretend camper this far from the site. The no-threat run measures the
// animal alone on its hillside; the report is about an animal being WATCHED,
// and every threat state (ALERT / WATCH / a held PERCH) is unreachable without
// one. 0 means no threat.
const THREAT = parseFloat(arg('threat', '0'));
const THREAT_SPEED = parseFloat(arg('threatSpeed', '0'));
// Only bands that do / do not have a boulder. A third of goat bands get one
// (83 of 247) and the two halves are different animals: the rock branches of
// `_pickWander` only exist for the half that has one.
const WANT_ROCK = arg('rock', 'any');

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0;
  e.stop();
  window.__forceCamera = true;

  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const DT = 1 / 30;
  const res = {};

  for (const SPEC of P.SPECS) {
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const cruise = wl.pool[SPEC][0][0].brain.gait.walk;
    const rcfg = wl.pool[SPEC][0][0].brain.cfg.rock;
    const picks = [];
    for (let i = 0; i < S.n && picks.length < P.SITES; i++) {
      if (S.spec[i] !== ki) continue;
      if (rcfg && P.WANT_ROCK !== 'any') {
        const g = { rocks: null };
        wl._findPerches(g, S.x[i], S.z[i], rcfg);
        if ((g.rocks.length > 0) !== (P.WANT_ROCK === 'yes')) continue;
      }
      picks.push(i);
    }

    const acc = {
      frames: 0, moving: 0, stall: 0, yaw: 0, reversals: 0, windMax: 0,
      effN: 0, effSum: 0, turnFrames: 0, byState: {}, sites: [],
    };
    const per = Math.round(P.SECONDS / P.SITES / DT);

    for (const si of picks) {
      wl.debugClear();
      if (P.THREAT > 0) wl.debugThreat(S.x[si] + P.THREAT, S.z[si], P.THREAT_SPEED);
      else wl.debugThreat(null);
      const cx = S.x[si] + 14, cz = S.z[si] + 14, cy = W.getHeight(cx, cz) + 3.2;
      e.camera.position.set(cx, cy, cz);
      e.camera.lookAt(cx + 14, cy, cz + 14);
      e.camera.updateMatrixWorld(true);
      const seen = new Map();
      let t = 0, siteFrames = 0;
      const win = Math.round(P.WIND / DT);
      for (let s = 0; s < per; s++) {
        t += DT;
        wl.update(DT, t);
        for (const grp of wl.pool[SPEC]) for (const a of grp) {
          if (!a.active) continue;
          const b = a.brain;
          let r = seen.get(b);
          if (!r) seen.set(b, r = { h: [], x: [], z: [], path: [], dir: 0, run: 0, amt: 0 });
          acc.frames++; siteFrames++;
          const st = NM[b.state];
          const bs = (acc.byState[st] ||= { frames: 0, yaw: 0 });
          bs.frames++;
          const yr = b.yawRate || 0;
          acc.yaw += Math.abs(yr) * DT;
          bs.yaw += Math.abs(yr) * DT;
          if (Math.abs(yr) > 0.05) acc.turnFrames++;
          if (b.speed > 0.05) {
            acc.moving++;
            // Against the BRAIN's scale, not the rig's. `rig.scale` is the GLB fit
            // (goat 1.37-1.62, deer 0.70-0.91) and has nothing to do with how fast
            // the animal was asked to walk; dividing by it made the goat look
            // stalled and the deer look fast for no reason but their model units.
            if (b.speed < cruise * b._scale * 0.55) acc.stall++;
          }
          // Sustained-turn reversal.
          const d = yr > 0.05 ? 1 : yr < -0.05 ? -1 : 0;
          if (d !== 0 && d === r.dir) { r.run += DT; r.amt += Math.abs(yr) * DT; }
          else if (d !== 0) {
            if (r.dir !== 0 && r.run >= 0.6 && r.amt >= 25 * Math.PI / 180) {
              if (r.armed) acc.reversals++;
              r.armed = true;
            } else if (r.dir !== 0) r.armed = false;
            r.dir = d; r.run = DT; r.amt = Math.abs(yr) * DT;
          }
          // Winding + path efficiency over the window.
          r.h.push(b.heading); r.x.push(b.pos.x); r.z.push(b.pos.z);
          r.path.push(b.speed * DT);
          if (r.h.length > win) { r.h.shift(); r.x.shift(); r.z.shift(); r.path.shift(); }
          if (r.h.length === win) {
            let net = 0;
            for (let i = 1; i < win; i++) net += wrap(r.h[i] - r.h[i - 1]);
            acc.windMax = Math.max(acc.windMax, Math.abs(net));
            let walked = 0;
            for (const p of r.path) walked += p;
            if (walked > 0.5) {
              const disp = Math.hypot(r.x[win - 1] - r.x[0], r.z[win - 1] - r.z[0]);
              acc.effSum += disp / walked; acc.effN++;
            }
          }
        }
      }
      acc.sites.push({ site: si, animals: seen.size, frames: siteFrames });
    }
    const mins = acc.frames / 30 / 60;
    const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
    res[SPEC] = {
      animalMinutes: +mins.toFixed(2),
      cruiseWalk: +cruise.toFixed(3),
      yawDegPerMin: deg(acc.yaw / Math.max(mins, 1e-6)),
      windingMaxDeg: deg(acc.windMax),
      reversalsPerMin: +(acc.reversals / Math.max(mins, 1e-6)).toFixed(2),
      pathEff: +(acc.effSum / Math.max(acc.effN, 1)).toFixed(3),
      movingPct: +(100 * acc.moving / Math.max(acc.frames, 1)).toFixed(1),
      stallPctOfMoving: +(100 * acc.stall / Math.max(acc.moving, 1)).toFixed(1),
      turningPct: +(100 * acc.turnFrames / Math.max(acc.frames, 1)).toFixed(1),
      yawDegPerMinByState: Object.fromEntries(Object.entries(acc.byState)
        .map(([k, v]) => [k, deg(v.yaw / Math.max(v.frames / 30 / 60, 1e-6))])),
      stateFrames: Object.fromEntries(Object.entries(acc.byState).map(([k, v]) => [k, v.frames])),
      sites: acc.sites,
    };
  }
  return res;
}, { SECONDS, SPECS, WIND, SITES, THREAT, THREAT_SPEED, WANT_ROCK });

console.log(JSON.stringify(out, null, 2));
await browser.close();

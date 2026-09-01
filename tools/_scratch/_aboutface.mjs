#!/usr/bin/env node
/**
 * Who turns round, and why — goats against the rest of the cast.
 *
 * Reported: "the goats do this 360 about-face a lot of the time. No other
 * animal seems to do that." Only two species have a `rock` block, so the
 * suspect is the CLIMB/PERCH cycle rather than the steering everything shares.
 *
 * Drives the real sim on a granted clock with no threat, samples every animal
 * every step, and counts two things per species:
 *
 *   about-face   heading reversed by more than `--deg` (default 150) inside
 *                `--window` seconds. Normalised to turns per animal-minute so
 *                a species with more individuals awake does not win by volume.
 *   re-take      `_maybeClimb` chose the SAME boulder the animal had just let
 *                go of. That is the shape a goat pacing on and off one rock
 *                makes, and it is invisible in a state histogram because every
 *                state in it is legitimate.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_aboutface.mjs
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '420'));
const DEG = parseFloat(arg('deg', '150'));
const WINDOW = parseFloat(arg('window', '2.5'));
// Which species' perch site to park at. The default camera wakes whatever it
// happens to wake, and a first run measured ZERO rock takes — the goats near it
// had no boulder, so the case under test never ran. Park deliberately.
const AT = arg('at', 'goat');

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?res=768';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife;
  window.__lighting.cycleSpeed = 0;
  wl.debugClear();
  wl.debugThreat(null);                 // nobody is being frightened into a turn

  // Park at a site of `AT` that actually has a boulder in it, the way
  // goatperch.mjs does — and look AWAY, because `_scan`'s frustum guard will
  // not wake a site inside the view cone.
  const S = wl.sites, ki = wl.keys.indexOf(P.AT);
  const cfg = wl.pool[P.AT][0][0].brain.cfg.rock;
  let rock = null;
  for (let i = 0; i < S.n && !rock; i++) {
    if (S.spec[i] !== ki) continue;
    const g = { rocks: null };
    wl._findPerches(g, S.x[i], S.z[i], cfg);
    if (g.rocks.length) rock = g.rocks[0];
  }
  if (!rock) return { error: `no ${P.AT} site with a perch` };
  window.__forceCamera = true;
  const cx = rock.x + 11, cz = rock.z + 11;
  const cy = window.__world.getHeight(cx, cz) + 3.2;
  e.camera.position.set(cx, cy, cz);
  e.camera.lookAt(cx + (cx - rock.x), cy, cz + (cz - rock.z));

  e.stop();
  const DT = 1 / 30;
  e.clock.getDelta = () => DT;
  const steps = Math.round(P.SECONDS / DT);
  const lag = Math.max(1, Math.round(P.WINDOW / DT));
  const LIM = P.DEG * Math.PI / 180;

  // Per animal: a ring of recent headings, the rock it last held, and tallies.
  const st = new Map();
  const tally = {};
  const bump = (k, f, n = 1) => { (tally[k] ||= { faces: 0, retakes: 0, takes: 0, frames: 0 })[f] += n; };
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  for (let s = 0; s < steps; s++) {
    e._loop();
    for (const key of Object.keys(wl.pool)) {
      for (const per of wl.pool[key]) {
        for (const a of per) {
          if (!a.active) continue;
          let r = st.get(a);
          if (!r) st.set(a, r = { h: [], s: [], lastRock: null, freed: null, cool: 0 });
          bump(key, 'frames');
          r.h.push(a.brain.heading);
          r.s.push(a.brain.state);
          if (r.h.length > lag + 1) { r.h.shift(); r.s.shift(); }
          if (r.h.length === lag + 1 && r.cool <= 0
              && Math.abs(wrap(r.h[r.h.length - 1] - r.h[0])) > LIM) {
            bump(key, 'faces');
            // WHERE the turn happened. A reversal is legitimate in some states
            // (a wander target behind you) and a bug in others, and the counter
            // alone cannot tell them apart — which is how a spurious
            // correlation with rock re-takes survived two rounds of "fixes".
            const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol',
                        'watch', 'climb', 'perch'];
            const tag = `${NM[r.s[0]]}->${NM[r.s[r.s.length - 1]]}`;
            const w = (tally[key].where ||= {});
            w[tag] = (w[tag] || 0) + 1;
            r.cool = lag;               // one reversal is one event, not `lag` of them
          }
          if (r.cool > 0) r.cool--;
          // Which boulder is held, and whether taking it was a re-take.
          const rock = a.brain.rock;
          if (rock !== r.lastRock) {
            if (rock) {
              bump(key, 'takes');
              if (rock === r.freed) bump(key, 'retakes');
            } else if (r.lastRock) r.freed = r.lastRock;
            r.lastRock = rock;
          }
        }
      }
    }
  }
  const rows = [];
  for (const [k, t] of Object.entries(tally)) {
    const mins = t.frames * DT / 60;
    rows.push({
      species: k,
      animalMinutes: +mins.toFixed(1),
      aboutFacesPerMin: +(t.faces / Math.max(1e-6, mins)).toFixed(2),
      rockTakes: t.takes,
      retakesOfTheSameRock: t.retakes,
      retakePct: t.takes ? +(100 * t.retakes / t.takes).toFixed(0) : null,
      where: Object.fromEntries(Object.entries(t.where || {}).sort((a, b) => b[1] - a[1])),
    });
  }
  rows.sort((a, b) => b.aboutFacesPerMin - a.aboutFacesPerMin);
  return { at: P.AT, seconds: P.SECONDS, deg: P.DEG, window: P.WINDOW, rows };
}, { SECONDS, DEG, WINDOW, AT });

console.log(JSON.stringify(out, null, 1));
await browser.close();

#!/usr/bin/env node
/**
 * An autopsy on the goat's about-face, rather than a count of them.
 *
 * `_aboutface.mjs` says WHERE the reversals land (all of them `wander->wander`)
 * and cannot say WHY, because every state in the window is legitimate. This
 * replays the same detector and, on each hit, dumps the per-frame record around
 * it: leader or follower, the destination, how far it is, whether the animal was
 * pinned or its probe fan was slammed, and which boulder the destination belongs
 * to. Three causes are distinguishable in that trace and only in that trace —
 *
 *   the target MOVED           a follower's station swinging round its leader
 *   the target was BEHIND      an orbit pick on the far side of the outcrop
 *   the target never changed   the fan or the blocked-step escape turned it
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatpick.mjs
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '420'));
const DEG = parseFloat(arg('deg', '150'));
const WINDOW = parseFloat(arg('window', '2.5'));
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
  wl.debugThreat(null);

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
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];

  const st = new Map();
  const events = [];

  // ── attribute every destination to the method that chose it ──────────────
  // The census above cannot tell an `_offRock` dismount from an orbit lap, and
  // the two want completely different fixes. Patch the three methods that
  // adopt a destination and record the turn each one demands. Nothing here
  // draws from `rnd()`, so the sim is bit-identical to an unpatched run.
  const B = Object.getPrototypeOf(wl.pool[P.AT][0][0].brain);
  const src = {};
  const wrapM = (name) => {
    const f = B[name];
    B[name] = function (...a) {
      const b4 = { x: this.target.x, z: this.target.z, s: this.state };
      const r = f.apply(this, a);
      if (this.cfg.rock && (this.target.x !== b4.x || this.target.z !== b4.z || this.state !== b4.s)) {
        const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
        const t = (src[name] ||= { n: 0, turn: [], dist: [] });
        t.n++;
        t.turn.push(Math.round(Math.abs(wrap(Math.atan2(dx, dz) - this.heading)) * 180 / Math.PI));
        t.dist.push(+Math.hypot(dx, dz).toFixed(1));
      }
      return r;
    };
  };
  ['_pickWander', '_offRock', '_maybeClimb'].forEach(wrapM);

  // How strung out the band is, sampled once a second.
  const spread = [];
  // Also a plain census of adopted destinations, leaders only (a follower has
  // no destination of its own), so the orbit's shape is visible without the
  // station-keeping traffic on top of it.
  const picks = { n: 0, turnSum: 0, over90: 0, over150: 0, rockHist: {}, hops: [], sameRock: 0, otherRock: 0, open: 0 };

  for (let s = 0; s < steps; s++) {
    e._loop();
    for (const key of Object.keys(wl.pool)) {
      if (!wl.pool[key][0][0].brain.cfg.rock) continue;
      if (key !== P.AT) continue;
      for (const per of wl.pool[key]) {
        for (const a of per) {
          if (!a.active) continue;
          const b = a.brain;
          let r = st.get(a);
          if (!r) st.set(a, r = { ring: [], cool: 0, tx: null, tz: null, lastRock: null });
          const list = b.group?.rocks || [];
          let bi = -1, bd = Infinity;
          for (let i = 0; i < list.length; i++) {
            const d = Math.hypot(list[i].x - b.target.x, list[i].z - b.target.z);
            if (d < bd) { bd = d; bi = i; }
          }
          const onRing = bi >= 0 && bd < list[bi].r * 2.6;
          const dx = b.target.x - b.pos.x, dz = b.target.z - b.pos.z;
          const rec = {
            t: +(s * DT).toFixed(1),
            st: NM[b.state],
            lead: b.leader ? 1 : 0,
            h: +(b.heading * 180 / Math.PI).toFixed(0),
            tx: +b.target.x.toFixed(1), tz: +b.target.z.toFixed(1),
            td: +Math.hypot(dx, dz).toFixed(1),
            tb: +(wrap(Math.atan2(dx, dz) - b.heading) * 180 / Math.PI).toFixed(0),
            av: +(b._avoid * 180 / Math.PI).toFixed(0),
            pin: +b._pinned.toFixed(1),
            stk: b._stuck | 0,
            sp: +b.speed.toFixed(2),
            rk: onRing ? bi : null,
          };
          // How far a follower is from the station it is keeping. A band
          // strung out over sixty metres is not a band, and the chase back is
          // where the reversals live.
          if (!b.leader && s % 30 === 0 && (b.state === 2)) spread.push(+rec.td.toFixed(0));
          r.ring.push(rec);
          if (r.ring.length > lag + 1) r.ring.shift();

          // Destination census, leaders only and only when it changes.
          const tx = +b.target.x.toFixed(2), tz = +b.target.z.toFixed(2);
          if (b.leader && (b.state === 2 || b.state === 7) && (tx !== r.tx || tz !== r.tz)) {
            picks.n++; picks.turnSum += Math.abs(rec.tb);
            if (Math.abs(rec.tb) > 90) picks.over90++;
            if (Math.abs(rec.tb) > 150) picks.over150++;
            if (!onRing) picks.open++;
            else {
              picks.rockHist[bi] = (picks.rockHist[bi] || 0) + 1;
              if (r.lastRock == null || r.lastRock === bi) picks.sameRock++;
              else { picks.otherRock++; picks.hops.push(+rec.td.toFixed(0)); }
              r.lastRock = bi;
            }
            r.tx = tx; r.tz = tz;
          }

          if (r.cool > 0) { r.cool--; continue; }
          if (r.ring.length === lag + 1
              && Math.abs(wrap((r.ring[r.ring.length - 1].h - r.ring[0].h) * Math.PI / 180)) > LIM) {
            // Thin the trace: every fifth frame is plenty to read a 2.5 s turn.
            events.push({ rocks: list.length, trace: r.ring.filter((_, i) => i % 5 === 0 || i === r.ring.length - 1) });
            r.cool = lag;
          }
        }
      }
    }
  }
  return {
    at: P.AT, seconds: P.SECONDS,
    picks: {
      n: picks.n,
      meanTurnToNewTargetDeg: picks.n ? +(picks.turnSum / picks.n).toFixed(0) : null,
      pctOver90: picks.n ? +(100 * picks.over90 / picks.n).toFixed(0) : null,
      pctOver150: picks.n ? +(100 * picks.over150 / picks.n).toFixed(0) : null,
      atARock: picks.sameRock + picks.otherRock, openGround: picks.open,
      stayedOnRock: picks.sameRock, changedRock: picks.otherRock,
      hopDistances: picks.hops, whichRock: picks.rockHist,
    },
    bySource: Object.fromEntries(Object.entries(src).map(([k, t]) => {
      const st2 = [...t.turn].sort((a, b) => a - b);
      const sd = [...t.dist].sort((a, b) => a - b);
      return [k, {
        n: t.n,
        meanTurn: Math.round(t.turn.reduce((a, b) => a + b, 0) / t.n),
        medianTurn: st2[st2.length >> 1],
        pctOver90: Math.round(100 * t.turn.filter((v) => v > 90).length / t.n),
        pctOver150: Math.round(100 * t.turn.filter((v) => v > 150).length / t.n),
        medianDist: sd[sd.length >> 1], maxDist: sd[sd.length - 1],
      }];
    })),
    followerSpread: (() => {
      if (!spread.length) return null;
      const q = [...spread].sort((a, b) => a - b);
      return { n: q.length, median: q[q.length >> 1], p90: q[Math.floor(q.length * 0.9)], max: q[q.length - 1],
               pctOver20m: Math.round(100 * q.filter((v) => v > 20).length / q.length) };
    })(),
    events,
  };
}, { SECONDS, DEG, WINDOW, AT });

console.log(JSON.stringify(out, null, 1));
await browser.close();

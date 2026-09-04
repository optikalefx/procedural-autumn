#!/usr/bin/env node
/**
 * Where the goat's wander legs come from, and how long each one lasts.
 *
 * The steering is not the problem: measured per frame the goat's heading error,
 * brake and speed are the deer's to two figures (`_goatwhy.mjs`). What differs
 * is how OFTEN it is given a new place to be, and how near that place is —
 * goat median leg 10.6 m against the deer's 20.1, and twice as many legs in the
 * same time. A leg shorter than a stride is a turn with a step in it.
 *
 * Attributes every adopted WANDER target to the branch that chose it, and
 * reports the leg's length, its duration, and how many walk cycles the animal
 * gets to complete inside it.
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatleg.mjs
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '480'));
const SPECS = arg('species', 'goat,ram,deer').split(',');
const SITES = parseInt(arg('sites', '4'), 10);

const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5188') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife, W = window.__world;
  window.__lighting.cycleSpeed = 0; e.stop(); window.__forceCamera = true;
  const DT = 1 / 30;
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  // Which branch of `_pickWander` adopted the target. The orbit branch returns
  // from inside its own loop, so it is separated by watching `target` land on
  // the rock ring rather than by a second wrapper.
  const B = wl.pool.deer[0][0].brain.constructor.prototype;
  const src = new WeakMap();
  const tagWrap = (name, tag) => {
    const f = B[name];
    B[name] = function (...a) {
      const before = this.state;
      const r = f.apply(this, a);
      if (this.state === 2) {                                  // ST.WANDER
        let t = tag;
        if (name === '_pickWander' && this.cfg.rock && this.group?.rocks?.length) {
          let best = null, bd = Infinity;
          for (const rk of this.group.rocks) {
            const d = (rk.x - this.target.x) ** 2 + (rk.z - this.target.z) ** 2;
            if (d < bd) { bd = d; best = rk; }
          }
          if (best && Math.sqrt(bd) <= best.r * 2.2) t = 'orbit';
          else t = 'open';
        }
        src.set(this, { tag: t, x: this.pos.x, z: this.pos.z, h: this.heading,
                        tx: this.target.x, tz: this.target.z, t: 0, walked: 0, moving: 0 });
      }
      void before;
      return r;
    };
  };
  tagWrap('_pickWander', 'pick');
  tagWrap('_offRock', 'offRock');

  const res = {};
  for (const SPEC of P.SPECS) {
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const cruise = wl.pool[SPEC][0][0].brain.gait.walk;
    const stride = 1.64;                       // goat's authored walk stride, m
    const picks = [];
    for (let i = 0; i < S.n && picks.length < P.SITES; i++) if (S.spec[i] === ki) picks.push(i);
    const per = Math.round(P.SECONDS / P.SITES / DT);
    const legs = [];
    for (const si of picks) {
      wl.debugClear(); wl.debugThreat(null);
      const cx = S.x[si] + 14, cz = S.z[si] + 14, cy = W.getHeight(cx, cz) + 3.2;
      e.camera.position.set(cx, cy, cz); e.camera.lookAt(cx + 14, cy, cz + 14);
      e.camera.updateMatrixWorld(true);
      let t = 0;
      const open = new Map();
      for (let s = 0; s < per; s++) {
        t += DT; wl.update(DT, t);
        for (const grp of wl.pool[SPEC]) for (const a of grp) {
          if (!a.active) continue;
          const b = a.brain;
          const rec = src.get(b);
          if (rec && open.get(b) !== rec) {
            const prev = open.get(b);
            if (prev) legs.push(prev);
            open.set(b, rec);
            rec.turn = Math.abs(wrap(Math.atan2(rec.tx - rec.x, rec.tz - rec.z) - rec.h));
            rec.reach = Math.hypot(rec.tx - rec.x, rec.tz - rec.z);
          }
          const cur = open.get(b);
          if (cur) {
            cur.t += DT;
            cur.walked += b.speed * DT;
            if (b.speed > 0.05) cur.moving += DT;
            if (b.state !== 2) { legs.push(cur); open.delete(b); src.delete(b); }
          }
        }
      }
      for (const l of open.values()) legs.push(l);
    }
    const by = {};
    for (const l of legs) {
      const g = (by[l.tag] ||= { n: 0, reach: [], walked: [], t: [], turn: [] });
      g.n++; g.reach.push(l.reach); g.walked.push(l.walked); g.t.push(l.t); g.turn.push(l.turn);
    }
    const med = (a) => { a.sort((x, y) => x - y); return +(a[Math.floor(a.length / 2)] || 0).toFixed(2); };
    res[SPEC] = { cruise: +cruise.toFixed(3), legs: legs.length,
      by: Object.fromEntries(Object.entries(by).map(([k, g]) => [k, {
        n: g.n, pct: +(100 * g.n / legs.length).toFixed(1),
        medReachM: med(g.reach), medWalkedM: med(g.walked),
        medSecs: med(g.t), medTurnDeg: +(med(g.turn) * 180 / Math.PI).toFixed(0),
        medWalkCycles: +(med(g.walked.slice()) / stride).toFixed(2),
      }])) };
  }
  return res;
}, { SECONDS, SPECS, SITES });
console.log(JSON.stringify(out, null, 2));
await browser.close();

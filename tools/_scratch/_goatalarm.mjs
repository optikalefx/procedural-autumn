#!/usr/bin/env node
/**
 * Who keeps re-freezing the band. Counts every `_enterAlert` by the state it
 * interrupted: only the herd-alarm branch can interrupt WATCH, so a nonzero
 * `from watch` is the deadlock this was written to catch (324 of 330 before the
 * fix, 0 after). The gate for that regression.
 *
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/_scratch/_goatalarm.mjs --threat 18
 */
import { chromium } from 'playwright';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '480'));
const SPECS = arg('species', 'goat,ram,deer').split(',');
const SITES = parseInt(arg('sites', '4'), 10);
const THREAT = parseFloat(arg('threat', '18'));

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
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  const B = wl.pool.deer[0][0].brain.constructor.prototype;
  const entered = {};
  const ea = B._enterAlert;
  B._enterAlert = function () { const k = NM[this.state]; entered[k] = (entered[k] || 0) + 1; return ea.call(this); };

  const res = {};
  for (const SPEC of P.SPECS) {
    for (const k of Object.keys(entered)) delete entered[k];
    const S = wl.sites, ki = wl.keys.indexOf(SPEC);
    const picks = [];
    for (let i = 0; i < S.n && picks.length < P.SITES; i++) if (S.spec[i] === ki) picks.push(i);
    const per = Math.round(P.SECONDS / P.SITES / DT);
    let frames = 0, alarmSum = 0, alarmHigh = 0;
    const st = {};
    for (const si of picks) {
      wl.debugClear();
      wl.debugThreat(S.x[si] + P.THREAT, S.z[si], 0);
      const cx = S.x[si] + 20, cz = S.z[si] + 20, cy = W.getHeight(cx, cz) + 4;
      e.camera.position.set(cx, cy, cz); e.camera.lookAt(S.x[si], cy, S.z[si]);
      e.camera.updateMatrixWorld(true);
      let t = 0;
      for (let s = 0; s < per; s++) {
        t += DT; wl.update(DT, t);
        for (const grp of wl.pool[SPEC]) for (const a of grp) {
          if (!a.active) continue;
          const b = a.brain;
          frames++;
          st[NM[b.state]] = (st[NM[b.state]] || 0) + 1;
          const al = b.group?.alarm ?? 0;
          alarmSum += al; if (al > 0.5) alarmHigh++;
        }
      }
    }
    const pc = (n) => +(100 * n / Math.max(frames, 1)).toFixed(1);
    res[SPEC] = {
      frames,
      alertPct: pc(st.alert || 0), watchPct: pc(st.watch || 0), fleePct: pc(st.flee || 0),
      movingStatePct: pc((st.wander || 0) + (st.graze || 0) + (st.climb || 0)),
      alarmMean: +(alarmSum / Math.max(frames, 1)).toFixed(2),
      alarmHighPct: pc(alarmHigh),
      enterAlertFrom: { ...entered },
      stateFrames: { ...st },
    };
  }
  return res;
}, { SECONDS, SPECS, SITES, THREAT });
console.log(JSON.stringify(out, null, 2));
await browser.close();

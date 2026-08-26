#!/usr/bin/env node
/**
 * roastrungs — did scoring the backdrop at BOTH ends of the cook cost anything?
 *
 *   node tools/_scratch/roastrungs.mjs --hour 16.7
 *
 * Round 7 made `_solveHold` score every candidate twice — against a golden
 * marshmallow (HOLD_JUDGED) and against a nearly-charred one
 * (HOLD_JUDGED_DARK) — and take the worse of the two. That rule is strictly
 * STRICTER than round 6's, so it can only ever reduce the number of candidates
 * that clear, and the honest question is whether it reduces it to zero at seats
 * that used to be fixable.
 *
 * This asks the solve directly instead of guessing: it runs one real solve and
 * dumps every candidate with its per-rung scores, so the two rules can be
 * counted against the SAME measurement — no second capture, no second material,
 * no chance of the toast ramp moving in between.
 *
 * Reports, per seat: how many candidates clear on the light rung alone (round
 * 6's rule), how many clear on both (round 7's), and what each rule would have
 * chosen.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOURS = String(arg('hours', '16.7,20.4')).split(',').map(Number);
const SEATS = parseInt(arg('seats', '8'), 10);
const DIR = arg('dir', 'shots/roast/r7-rungs');
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=1600&car=camper`;

mkdirSync(DIR, { recursive: true });
const release = await acquire('roastrungs');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
const out = [];
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  await page.evaluate(() => { const e = window.__engine; if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; } });
  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  await page.evaluate(({ at }) => {
    const s = window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 });
    return s ? { x: s.x, z: s.z } : null;
  }, { at: parkAt });
  await page.waitForTimeout(1200);

  await page.evaluate(() => { window.__roast.enter(); window.__roast.setOverlay(false); });
  await page.waitForFunction(() => (window.__roast.state().t ?? 0) >= 0.999, null, { timeout: 20000, polling: 60 });

  for (const hour of HOURS) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.waitForTimeout(900);
    for (let seat = 0; seat < SEATS; seat++) {
      const r = await page.evaluate(({ seat, seats }) => {
        const R = window.__roast, V = R.view;
        V._bearing = (seat / seats) * Math.PI * 2;
        V._measureSeatY();
        R.setHeight(0.24); R.setSpin(0); R.setClock(3.0);
        R.solveHold();
        const cands = R.holdCandidates() ?? [];
        const s = R.state();
        return { cands, chosen: s.hold, bar: s.backdrop?.bar ?? 0.85 };
      }, { seat, seats: SEATS });

      const LOST = 0.06;
      const light = r.cands.filter((c) => c.framed && (c.lostPer?.[0] ?? 1) <= LOST && (c.per?.[0] ?? -9) >= r.bar);
      const both = r.cands.filter((c) => c.framed && c.lost <= LOST && c.margin >= r.bar);
      const seedC = r.cands.find((c) => c.seed);
      const near = (list) => list.slice().sort((a, b) =>
        Math.abs(a.phi - seedC.phi) - Math.abs(b.phi - seedC.phi))[0] ?? null;
      const l = near(light), b = near(both);
      const deg = (x) => x == null ? '   -  ' : (x * 180 / Math.PI).toFixed(1).padStart(6);
      const row = {
        hour, seat,
        n: r.cands.length,
        framed: r.cands.filter((c) => c.framed).length,
        clearsLight: light.length,
        clearsBoth: both.length,
        seedLight: seedC?.per?.[0] ?? null,
        seedDark: seedC?.per?.[1] ?? null,
        pickLight: l ? +(l.phi * 180 / Math.PI).toFixed(1) : null,
        pickBoth: b ? +(b.phi * 180 / Math.PI).toFixed(1) : null,
        pickLightDark: l?.per?.[1] ?? null,
        chosen: +(r.chosen.phi * 180 / Math.PI).toFixed(1),
      };
      out.push(row);
      console.log(`h${hour} seat${seat}  framed=${String(row.framed).padStart(2)}  ` +
        `clears light=${String(row.clearsLight).padStart(2)} both=${String(row.clearsBoth).padStart(2)}  ` +
        `seed L/D = ${String(row.seedLight).padStart(6)}/${String(row.seedDark).padStart(6)}  ` +
        `pick light=${deg(l?.phi)} (its dark ${String(row.pickLightDark).padStart(6)})  both=${deg(b?.phi)}`);
    }
  }
  writeFileSync(`${DIR}/RUNGS.json`, JSON.stringify({ hours: HOURS, rows: out }, null, 2));
  console.log(`\nwrote ${DIR}/RUNGS.json`);
} finally {
  await browser.close();
  await release();
}

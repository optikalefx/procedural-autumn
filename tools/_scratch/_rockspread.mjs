#!/usr/bin/env node
/**
 * How far apart are the boulders a band is offered?
 *
 * `Wildlife._findPerches` searches a `search`-metre disc round the stand point
 * and keeps the four with the most rise. Nothing in it asks whether those four
 * are the same OUTCROP — and `_maybeClimb` (nearest free, `reach` 45 m) and the
 * orbit wander (uniformly random) both treat the list as interchangeable. If
 * the list is wide, the band splits across the hillside and its followers spend
 * their lives sprinting between the halves.
 *
 * Runs over every alpine site on the map. No sim stepping: this is a question
 * about the rock scatter, not about behaviour.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_rockspread.mjs
 */
import { chromium } from 'playwright';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?res=768';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(() => {
  const wl = window.__systems.wildlife, S = wl.sites;
  const res = {};
  for (const key of Object.keys(wl.pool)) {
    const cfg = wl.pool[key][0][0].brain.cfg.rock;
    if (!cfg) continue;
    const ki = wl.keys.indexOf(key);
    const spans = [], counts = [], fromStand = [];
    for (let i = 0; i < S.n; i++) {
      if (S.spec[i] !== ki) continue;
      const g = { rocks: null };
      wl._findPerches(g, S.x[i], S.z[i], cfg);
      if (!g.rocks.length) { counts.push(0); continue; }
      counts.push(g.rocks.length);
      let span = 0;
      for (let a = 0; a < g.rocks.length; a++) {
        fromStand.push(+Math.hypot(g.rocks[a].x - S.x[i], g.rocks[a].z - S.z[i]).toFixed(0));
        for (let b = a + 1; b < g.rocks.length; b++) {
          span = Math.max(span, Math.hypot(g.rocks[a].x - g.rocks[b].x, g.rocks[a].z - g.rocks[b].z));
        }
      }
      spans.push(+span.toFixed(0));
    }
    const q = (v) => { const s2 = [...v].sort((a, b) => a - b); return s2.length ? { median: s2[s2.length >> 1], p90: s2[Math.floor(s2.length * 0.9)], max: s2[s2.length - 1] } : null; };
    const hist = {};
    for (const c of counts) hist[c] = (hist[c] || 0) + 1;
    res[key] = {
      sites: counts.length, rocksPerSite: hist,
      widestPairInList: q(spans),
      distFromStandPoint: q(fromStand),
      pctSitesWithAPairOver30m: +(100 * spans.filter((v) => v > 30).length / Math.max(1, spans.length)).toFixed(0),
    };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

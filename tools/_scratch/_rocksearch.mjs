#!/usr/bin/env node
/**
 * What a band gives up by only being offered boulders it can actually reach.
 *
 * `search` is 48 m and `snap` is 25, so `_standAtRock` refuses to move the band
 * to most of what `_findPerches` finds — measured, the median perch is 38 m from
 * the stand point. The band therefore commutes, which is the one thing
 * `_standAtRock`'s own header says it exists to prevent.
 *
 * Sweeps the search radius over every alpine site and reports the yield: how
 * many bands still get a rock, and how far it is. The number to choose is the
 * smallest radius that does not visibly cost yield.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_rocksearch.mjs
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
    const base = wl.pool[key][0][0].brain.cfg.rock;
    if (!base) continue;
    const ki = wl.keys.indexOf(key);
    const rows = [];
    for (const search of [48, 40, 32, 26, 22, 18]) {
      const cfg = { ...base, search };
      let withRock = 0, sites = 0, spanOver30 = 0, lists = 0;
      const dists = [], spans = [];
      for (let i = 0; i < S.n; i++) {
        if (S.spec[i] !== ki) continue;
        sites++;
        const g = { rocks: null };
        wl._findPerches(g, S.x[i], S.z[i], cfg);
        if (!g.rocks.length) continue;
        withRock++; lists++;
        dists.push(Math.hypot(g.rocks[0].x - S.x[i], g.rocks[0].z - S.z[i]));
        let span = 0;
        for (let a = 0; a < g.rocks.length; a++) for (let b = a + 1; b < g.rocks.length; b++) {
          span = Math.max(span, Math.hypot(g.rocks[a].x - g.rocks[b].x, g.rocks[a].z - g.rocks[b].z));
        }
        spans.push(span); if (span > 30) spanOver30++;
      }
      const med = (v) => { const s2 = [...v].sort((a, b) => a - b); return s2.length ? +s2[s2.length >> 1].toFixed(0) : null; };
      rows.push({
        search, sites, sitesWithARock: withRock,
        pctWithARock: +(100 * withRock / sites).toFixed(0),
        medianBestRockFromStand: med(dists),
        withinSnap25: +(100 * dists.filter((d) => d <= base.snap).length / Math.max(1, dists.length)).toFixed(0),
        medianListSpan: med(spans),
        pctListSpanOver30: +(100 * spanOver30 / Math.max(1, lists)).toFixed(0),
      });
    }
    res[key] = rows;
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

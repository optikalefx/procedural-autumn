#!/usr/bin/env node
/**
 * What the time-of-flight fix did to the horizontal step, per fall.
 *
 * The paths store `flight` per point and the horizontal step `dsH` is constant
 * along a fall, so the horizontal speed the integrator actually used is
 * dsH / (flight[i] - flight[i-1]) and needs no instrumentation in the shipping
 * code. The old integration held that speed at the lip's `v0` for the whole
 * descent; this prints v0, the speed at the foot, and the ratio, for every fall
 * with a horizontal run — which is what "dt is now N times smaller" means.
 *
 *   node tools/_scratch/chutespeed.mjs
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?seed=20261018';
await acquire('chutespeed');
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(() => {
  const list = window.__systems;
  const arr = Array.isArray(list) ? list : Object.values(list || {});
  const wfs = arr.find(s => s && Array.isArray(s.falls) && s.falls.length && s.falls[0].pts);
  const falls = wfs?.falls;
  if (!falls?.length) return { err: 'no falls on the system' };
  const rows = [];
  for (const fl of falls) {
    const p = fl.pts;
    const hor = Math.hypot(p[p.length-1].x - p[0].x, p[p.length-1].z - p[0].z);
    if (hor < 0.6) continue;                       // vertical drop, different branch
    const dsH = hor / (p.length - 1);
    const dtAt = (i) => p[i].flight - p[i-1].flight;
    const vFirst = dsH / dtAt(1);
    const vLast  = dsH / dtAt(p.length - 1);
    rows.push({ h: fl.height, hor, vFirst, vLast, ratio: vLast / vFirst,
                flight: p[p.length-1].flight });
  }
  rows.sort((a,b) => b.h - a.h);
  const rs = rows.map(r => r.ratio).sort((a,b) => a-b);
  const med = rs[rs.length >> 1];
  return { n: rows.length, medianRatio: med, maxRatio: rs[rs.length-1],
           rows: rows.slice(0, 8) };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

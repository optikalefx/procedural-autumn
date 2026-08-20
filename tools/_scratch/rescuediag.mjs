#!/usr/bin/env node
/**
 * rescuediag — why does a rescue decline?
 *
 * Samples the 20 m ring from many places across the map and reports which
 * check is actually doing the rejecting. Tuning the thresholds without this is
 * guesswork.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const URL = `${arg('url', 'http://localhost:5178')}?res=${arg('res', '640')}`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const release = await acquire('rescuediag');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => typeof window.__vehicleRescue === 'function', null, { timeout: 20000 });
await page.waitForTimeout(1200);

const r = await page.evaluate(() => {
  const W = window.__world, v = window.__vehicle;
  // Only origins a camper could physically BE in. A uniform sample of the map
  // is mostly cliff face and lake bed, and the decline rate over that says
  // nothing about a player pressing R.
  const KEEP = (x, z) => W.getWaterDepth(x, z) < 1.25 && W.getSlope(x, z) < 1.25;
  const origins = [];
  for (let i = 0; i < 20000 && origins.length < 500; i++) {
    const x = (Math.random() * 2 - 1) * W.half * 0.92;
    const z = (Math.random() * 2 - 1) * W.half * 0.92;
    if (!W.isInBounds(x, z) || !KEEP(x, z)) continue;
    origins.push({ x, z, slope: W.getSlope(x, z), water: W.getWaterDepth(x, z) });
  }

  // Drive the SHIPPED search, not a copy of it: move the read-only position
  // vector, ask for a site, and put it back. No teleport, no physics.
  const save = v.position.clone();
  const rings = {}; let declines = 0, stuckDeclines = 0, stuckish = 0, ideal = 0;
  let worstT0 = 0, sumMs = 0;
  for (const o of origins) {
    const hard = o.slope > 0.7 || o.water > 0.1;
    if (hard) stuckish++;
    v.position.set(o.x, W.getHeight(o.x, o.z), o.z);
    const t0 = performance.now();
    const s = v._rescueSite();
    const ms = performance.now() - t0;
    sumMs += ms; worstT0 = Math.max(worstT0, ms);
    if (!s) { declines++; if (hard) stuckDeclines++; continue; }
    rings[s.range] = (rings[s.range] ?? 0) + 1;
    if (!s.relaxed) ideal++;
  }
  v.position.copy(save);
  return { n: origins.length, stuckish, declines, stuckDeclines, ideal, rings,
           meanMs: sumMs / origins.length, worstMs: worstT0 };
});

console.log(`reachable origins ${r.n} (${r.stuckish} of them steep or wet)`);
console.log(`declines            ${r.declines}  (${f(100 * r.declines / r.n, 1)}%)`);
console.log(`  from steep/wet    ${r.stuckDeclines}  (${f(100 * r.stuckDeclines / Math.max(1, r.stuckish), 1)}%)`);
console.log(`ideal-tier landings ${f(100 * r.ideal / Math.max(1, r.n - r.declines), 1)}% of successful rescues`);
console.log('ring used: ' + Object.entries(r.rings).sort((a, b) => a[0] - b[0])
  .map(([k, n]) => `${k} m ${f(100 * n / Math.max(1, r.n - r.declines), 0)}%`).join('   '));
console.log(`search cost         mean ${f(r.meanMs)} ms   worst ${f(r.worstMs)} ms`);

process.exit(await browser.close().then(() => { release(); return 0; }));
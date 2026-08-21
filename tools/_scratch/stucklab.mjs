#!/usr/bin/env node
/**
 * stucklab — the place the rescue button exists for.
 *
 * Not "somewhere awkward": somewhere with no way out. Origins are scored for
 * how walled in they are — steep ground or a boulder on every bearing — and
 * only the worst survive, which is the gorge in the bug report rather than the
 * merely inconvenient verge that rescuediag samples.
 *
 * For each one: does the search answer at all, which pass answered, and is
 * what it found somewhere the camper could drive away from?
 *
 *   node tools/_scratch/stucklab.mjs [--n 120]
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const N = parseInt(arg('n', '120'), 10);
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const release = await acquire('stucklab');
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://localhost:5178?res=640', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => typeof window.__vehicleRescue === 'function', null, { timeout: 20000 });
await page.waitForTimeout(1500);

const r = await page.evaluate((N) => {
  const W = window.__world, v = window.__vehicle;

  // How boxed in is this spot? Walk 16 bearings out to 26 m and count the ones
  // that hit a wall (a slope no camper climbs) or water before they get there.
  const boxed = (x, z) => {
    let walls = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const sx = Math.sin(a), sz = Math.cos(a);
      for (let d = 4; d <= 26; d += 4) {
        const px = x + sx * d, pz = z + sz * d;
        if (!W.isInBounds(px, pz) || W.getSlope(px, pz) > 1.0 || W.getWaterDepth(px, pz) > 0.6) { walls++; break; }
      }
    }
    return walls;
  };

  // Candidate origins the camper could have got into: standable ground with as
  // many walls around it as the map can produce.
  const cands = [];
  for (let i = 0; i < 90000 && cands.length < N * 6; i++) {
    const x = (Math.random() * 2 - 1) * W.half * 0.92;
    const z = (Math.random() * 2 - 1) * W.half * 0.92;
    if (!W.isInBounds(x, z)) continue;
    if (W.getWaterDepth(x, z) > 0.35 || W.getSlope(x, z) > 1.0) continue;
    const b = boxed(x, z);
    if (b < 10) continue;                       // not a trap; rescuediag has those
    cands.push({ x, z, walls: b });
  }
  cands.sort((a, b) => b.walls - a.walls);
  const origins = cands.slice(0, N);

  const save = v.position.clone();
  const out = { n: origins.length, walls: 0, declines: 0, pass: {}, ranges: [], open: [], tiers: {} };
  for (const o of origins) {
    out.walls += o.walls;
    v.position.set(o.x, W.getHeight(o.x, o.z), o.z);
    const s = v._rescueSite();
    if (!s) { out.declines++; continue; }
    const pass = s.landmark ? 'landmark' : s.lastResort ? 'last resort' : s.relaxed ? 'acceptable' : 'ideal';
    out.pass[pass] = (out.pass[pass] ?? 0) + 1;
    out.tiers[s.tier] = (out.tiers[s.tier] ?? 0) + 1;
    out.ranges.push(Math.hypot(s.x - o.x, s.z - o.z));
    // Independent read of the landing: how walled in is *it*?
    out.open.push(boxed(s.x, s.z));
  }
  v.position.copy(save);
  return out;
}, N);

r.ranges.sort((a, b) => a - b);
r.open.sort((a, b) => a - b);
console.log(`${r.n} walled-in origins (mean ${f(r.walls / r.n, 1)} of 16 bearings blocked)`);
console.log(`declines            ${r.declines}`);
console.log('pass used:          ' + Object.entries(r.pass).map(([k, n]) => `${k} ${n}`).join('   '));
console.log(`hop distance        median ${f(r.ranges[r.ranges.length >> 1])} m   p90 ${f(r.ranges[Math.floor(r.ranges.length * 0.9)])}   worst ${f(r.ranges[r.ranges.length - 1])}`);
console.log(`landing walls       median ${f(r.open[r.open.length >> 1], 1)} of 16   worst ${f(r.open[r.open.length - 1], 1)}`);

// The floor under everything: ask for a landmark directly, from a corner.
const lm = await page.evaluate(() => {
  const v = window.__vehicle, W = window.__world;
  const save = v.position.clone();
  v.position.set(-W.half * 0.95, 0, -W.half * 0.95);
  const s = v._rescueLandmark();
  v.position.copy(save);
  return s && { x: +s.x.toFixed(1), z: +s.z.toFixed(1), range: +s.range.toFixed(0), tier: s.tier,
                slope: +(s.slope ?? -1).toFixed(2), landmark: !!s.landmark };
});
console.log('landmark fallback   ' + JSON.stringify(lm));

await browser.close(); release();

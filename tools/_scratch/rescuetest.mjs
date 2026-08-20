#!/usr/bin/env node
/**
 * rescuetest — hammer the rescue button and assert every landing is somewhere a
 * camper could actually be parked.
 *
 *   node tools/_scratch/rescuetest.mjs                # 100 rescues
 *   node tools/_scratch/rescuetest.mjs --n 200
 *   node tools/_scratch/rescuetest.mjs --spam         # also the spam test
 *
 * Every tenth rescue starts from a deliberately hostile place — mid-river, on
 * the steepest ground within reach, in the densest trees — because the whole
 * point of the button is the places you should not have been able to reach.
 *
 * After each landing the camper is left to settle for a moment and then
 * checked: upright, on the ground, dry, on drivable slope, not inside a trunk
 * or a boulder, and no NaN. Exit 0 = every landing passed.
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
const N = parseInt(arg('n', '100'), 10);
const RES = arg('res', '640');
const SPAM = argv.includes('--spam');
const URL = `${arg('url', 'http://localhost:5178')}?res=${RES}`;
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

async function main() {
  const release = await acquire('rescuetest');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return {
          readyState: 3, url, protocol: '',
          addEventListener() {}, removeEventListener() {}, send() {}, close() {},
          set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
        };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log(`booting ${URL} …`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => typeof window.__vehicleRescue === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // ── the whole cycle, in one page call ──────────────────────────────────────
  // start (optionally hostile) → rescue → settle → judge.
  await page.evaluate(() => {
    const W = window.__world;

    // Deliberately awful places to be rescued *from*.
    window.__hostile = (kind) => {
      const v = window.__vehicle;
      const p = v.position;
      let best = null;
      // Hostile, but reachable: a place the camper could actually have driven
      // or slid into. Aiming at the global extremes instead put it in the
      // middle of a 39 m lake, which no player can reach and from which every
      // rescue correctly declines — that measured the test, not the feature.
      for (let i = 0; i < 2500; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 10 + Math.random() * 340;
        const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
        if (!W.isInBounds(x, z)) continue;
        const depth = W.getWaterDepth(x, z), slope = W.getSlope(x, z);
        if (depth > 1.1 || slope > 1.2) continue;         // not reachable
        let s;
        if (kind === 'water') s = depth;
        else if (kind === 'steep') s = slope;
        else s = W.getMoisture(x, z) * (depth > 0 ? 0 : 1);   // forest
        if (!best || s > best.s) best = { x, z, s };
      }
      if (!best) return null;
      window.__vehicleTeleport(best.x, best.z, Math.random() * Math.PI * 2);
      return best;
    };

    // Judge where the camper has ended up. Mirrors the acceptance criteria and
    // is written independently of the rescue's own search so it is a check and
    // not an echo of it.
    window.__judge = () => {
      const v = window.__vehicle;
      const p = v.position;
      const bad = [];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) bad.push('NaN position');
      if (!W.isInBounds(p.x, p.z)) bad.push('out of bounds');
      // Upright: the body's own up axis against world up.
      if (v.up.y < 0.90) bad.push(`not upright (up.y ${v.up.y.toFixed(3)})`);
      // On the ground, not floating and not buried.
      const g = W.getHeight(p.x, p.z);
      const clear = p.y - g;
      if (clear < -0.4) bad.push(`buried (${clear.toFixed(2)} m)`);
      if (clear > 2.2) bad.push(`floating (${clear.toFixed(2)} m)`);
      // Two wheels down is a normal articulated pose on undulating ground and
      // happens in ordinary driving too — the camper is still upright, still
      // parked, and still drives away on 4WD. One or none means it is balanced
      // on something, which is a bad landing.
      const grounded = v.wheels.filter((w) => w.grounded).length;
      if (grounded < 2) bad.push(`only ${grounded} wheels on the ground`);

      // Dry.
      if (W.getWaterDepth(p.x, p.z) > 0.05) bad.push(`in water (${W.getWaterDepth(p.x, p.z).toFixed(2)} m)`);
      // Drivable, over the whole footprint.
      let slope = W.getSlope(p.x, p.z);
      for (let k = 0; k < 8; k++) {
        const b = (k / 8) * Math.PI * 2;
        slope = Math.max(slope, W.getSlope(p.x + Math.sin(b) * 2.2, p.z + Math.cos(b) * 2.2));
      }
      // The contract the implementation states: no sample in the footprint
      // over RESCUE_SLOPE_OK. Judged here independently of the search.
      // 0.05 of tolerance because this re-samples the footprint ring at a
      // different phase from the search, so the two read the same ground a
      // percent or two apart.
      if (slope > 0.70) bad.push(`slope ${slope.toFixed(2)}`);
      // Not inside geometry. Independent of the rescue's own query: this walks
      // the live scene's instanced trunks and rocks.
      const gap = Math.min(v._treeGap(p.x, p.z), v._rockGap(p.x, p.z));
      // The camper's footprint is 1.86 x 4.36 m, so its half-diagonal is 2.4 m:
      // below that a corner of the body can be inside the obstacle.
      if (gap < 2.0) bad.push(`inside geometry (gap ${gap.toFixed(2)} m)`);
      // The teleport must not have carried momentum across.
      const lv = v.phys.body.linvel(), av = v.phys.body.angvel();
      return {
        bad, x: p.x, z: p.z, slope, gap, clear, upY: v.up.y,
        speed: Math.hypot(lv.x, lv.y, lv.z), spin: Math.hypot(av.x, av.y, av.z),
        nan: v.phys.nanEvents ?? 0, rescues: v.rescues, grounded,
      };
    };
  });

  const kinds = ['water', 'steep', 'forest'];
  let fails = 0, declined = 0, moved = [], slides = [], slide = 0;
  const pairs = [];
  let twoWheel = 0;
  const worst = { slope: 0, gapMin: Infinity, clearMax: 0, upMin: 1 };
  let velAfter = 0, spinAfter = 0;

  for (let i = 0; i < N; i++) {
    if (i % 10 === 0) {
      await page.evaluate((k) => window.__hostile(k), kinds[(i / 10) % kinds.length]);
      await page.waitForTimeout(500);
    }
    const before = await page.evaluate(() => {
      const p = window.__vehicle.position;
      return { x: p.x, z: p.z };
    });
    const site = await page.evaluate(() => window.__vehicleRescue(true));
    if (!site) { declined++; continue; }

    // Straight after the teleport, before physics has had a chance to move it:
    // this is where a carried-over velocity would show.
    const imm = await page.evaluate(() => {
      const lv = window.__vehicle.phys.body.linvel(), av = window.__vehicle.phys.body.angvel();
      return { v: Math.hypot(lv.x, lv.y, lv.z), s: Math.hypot(av.x, av.y, av.z) };
    });
    velAfter = Math.max(velAfter, imm.v);
    spinAfter = Math.max(spinAfter, imm.s);

    await page.waitForTimeout(650);                  // let it settle on its springs
    const settled = await page.evaluate(() => {
      const p = window.__vehicle.position;
      return { x: p.x, z: p.z };
    });
    // Does it stay put? "Not on a slope so steep it slides straight back" is a
    // claim about the next two seconds, not about a height sample.
    await page.waitForTimeout(2000);
    const j = await page.evaluate(() => window.__judge());
    const slid = Math.hypot(j.x - settled.x, j.z - settled.z);
    slide = Math.max(slide, slid);
    slides.push(slid);
    if (slid > 2.5) { j.bad.push(`slid ${slid.toFixed(1)} m in 2 s`); }
    if (j.grounded < 4) twoWheel++;
    pairs.push({ slid, worst: site.slope, mean: site.mean, step: site.step, gap: site.gap, relaxed: site.relaxed, range: site.range });
    const d = Math.hypot(j.x - before.x, j.z - before.z);
    moved.push(d);
    worst.slope = Math.max(worst.slope, j.slope);
    worst.gapMin = Math.min(worst.gapMin, j.gap);
    worst.clearMax = Math.max(worst.clearMax, j.clear);
    worst.upMin = Math.min(worst.upMin, j.upY);
    if (j.bad.length) {
      fails++;
      console.log(`  FAIL ${i} at ${f(j.x, 1)},${f(j.z, 1)} (moved ${f(d, 1)} m): ${j.bad.join('; ')}`);
    }
  }

  // ── spam: hold the key down and make sure nothing detonates ───────────────
  let spamNan = 0;
  if (SPAM) {
    const nan0 = await page.evaluate(() => window.__vehicle.phys.nanEvents ?? 0);
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('KeyR');             // no cooldown bypass here
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => window.__judge());
    spamNan = s.nan - nan0;
    console.log(`\nspam: 120 presses in 3 s → ${s.rescues} rescues total, ${spamNan} NaN events, ` +
      `landed upright ${f(s.upY, 3)}, ${s.bad.length ? 'BAD: ' + s.bad.join('; ') : 'clean'}`);
    if (s.bad.length || spamNan) fails++;
  }

  const avg = moved.reduce((a, b) => a + b, 0) / Math.max(1, moved.length);
  console.log(`\n${N} rescues: ${fails} failed, ${declined} declined (no valid site)`);
  console.log(`  distance moved     mean ${f(avg, 1)} m   min ${f(Math.min(...moved), 1)}   max ${f(Math.max(...moved), 1)}`);
  console.log(`  worst slope        ${f(worst.slope)} (limit 0.70)`);
  console.log(`  tightest clearance ${f(worst.gapMin)} m to a trunk or boulder`);
  console.log(`  worst ride height  ${f(worst.clearMax)} m above ground`);
  console.log(`  least upright      up.y ${f(worst.upMin, 3)}`);
  console.log(`  articulated (<4 wheels down) ${twoWheel} of ${pairs.length}`);
  slides.sort((a, b) => a - b);
  console.log(`  slide in 2 s idle  median ${f(slides[slides.length >> 1] ?? NaN)} m   p90 ${f(slides[Math.floor(slides.length * 0.9)] ?? NaN)}   worst ${f(slide)} (limit 2.5)`);
  console.log(`  velocity carried across the teleport: ${f(velAfter, 4)} m/s, ${f(spinAfter, 4)} rad/s`);
  // Where does sliding actually begin? This is the number the slope limits
  // should be set from.
  const bins = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.1], [1.1, 2]];
  console.log('\n  slide vs the site\'s worst footprint slope:');
  for (const [lo, hi] of bins) {
    const b = pairs.filter((p) => p.worst >= lo && p.worst < hi).map((p) => p.slid).sort((a, c) => a - c);
    if (!b.length) continue;
    console.log(`    worst ${lo.toFixed(1)}-${hi.toFixed(1)}  n=${String(b.length).padStart(3)}  ` +
      `median ${f(b[b.length >> 1])} m  p90 ${f(b[Math.floor(b.length * 0.9)])}  max ${f(b[b.length - 1])}  ` +
      `slid>2.5m ${(100 * b.filter((x) => x > 2.5).length / b.length).toFixed(0)}%`);
  }
  console.log(`  (${pairs.filter((p) => p.relaxed).length} of ${pairs.length} landings used the fallback tier)`);
  const rings = {};
  for (const p of pairs) rings[p.range] = (rings[p.range] ?? 0) + 1;
  console.log('  ring used: ' + Object.entries(rings).map(([r, n]) =>
    `${r} m ${(100 * n / pairs.length).toFixed(0)}%`).join('   '));
  if (errors.length) console.log('\npage errors:\n  ' + errors.slice(0, 8).join('\n  '));

  await browser.close();
  release();
  process.exit(fails || errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

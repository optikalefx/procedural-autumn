#!/usr/bin/env node
/**
 * What the round's post additions cost, measured inside ONE page load.
 *
 * tools/perf.mjs is the right tool for "does the build hold 60 fps" and the
 * wrong one for "what did this change cost" when four authors are running
 * headless captures on the same machine: its two arms are two separate
 * processes minutes apart, and this box's throughput drifts by 2-3x over that
 * window. The note in PostFX.js about how the per-effect cost table was
 * measured says the same thing.
 *
 * So alternate the arms inside one boot, every N frames, and pair them. The
 * machine's load hits both arms equally and cancels in the ratio.
 *
 * Arms:
 *   ship  — the round's chain: 7 bloom mip levels, veil live
 *   prev  — the pre-round shape: 5 levels (MIN_BLOOM_MIP 12 at 900p), veil off
 *
 *   node tools/_scratch/veilcost.mjs [url] [blocks]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5180?res=1024';
const BLOCKS = parseInt(process.argv[3] ?? '14', 10);
const PER = 45;         // frames per arm block
const WARM = 12;        // frames dropped at each arm switch

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const res = await page.evaluate(async ({ BLOCKS, PER, WARM }) => {
  const p = window.__postfx;
  const mm = p.bloom.mipmapBlurPass;
  const shipLevels = mm.levels;
  const out = { ship: [], prev: [], shipLevels, prevLevels: Math.max(1, shipLevels - 2) };

  const setArm = (arm) => {
    if (arm === 'ship') {
      mm.levels = out.shipLevels;
      p.look.veilHi = 0.10; p.look.veilLo = 0.25; p.look.veilNight = 0.30;
    } else {
      mm.levels = out.prevLevels;
      p.look.veilHi = 0; p.look.veilLo = 0; p.look.veilNight = 0;
    }
  };

  const frame = () => new Promise((r) => requestAnimationFrame(r));

  for (let b = 0; b < BLOCKS; b++) {
    for (const arm of ['ship', 'prev']) {
      setArm(arm);
      for (let i = 0; i < WARM; i++) await frame();
      let t0 = performance.now();
      for (let i = 0; i < PER; i++) { await frame(); }
      const dt = (performance.now() - t0) / PER;
      out[arm].push(dt);
    }
  }
  setArm('ship');
  return out;
}, { BLOCKS, PER, WARM });

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
// Pair block-by-block so the machine's drift cancels.
const ratios = res.ship.map((s, i) => s / res.prev[i]);
const f = (x) => x.toFixed(2);
console.log(`bloom levels: ship ${res.shipLevels}  prev ${res.prevLevels}`);
console.log(`ship  median ${f(med(res.ship))} ms   blocks ${res.ship.map(f).join(' ')}`);
console.log(`prev  median ${f(med(res.prev))} ms   blocks ${res.prev.map(f).join(' ')}`);
console.log(`paired ratio median ${med(ratios).toFixed(4)}   ` +
            `delta ${((med(ratios) - 1) * 100).toFixed(2)}%   ` +
            `d_ms ${(med(res.ship) - med(res.prev)).toFixed(3)}`);
await browser.close();

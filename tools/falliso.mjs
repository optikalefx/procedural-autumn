#!/usr/bin/env node
/**
 * Isolate one waterfall layer at a time, from a single page load.
 *
 *   node tools/falliso.mjs --view plunge --dir shots/iso --url http://127.0.0.1:5205
 *
 * The falls are five meshes stacked on each other — curtain, spray, ballistic
 * burst, mist and the plunge apron — and in a composite frame it is impossible
 * to say which one is drawing the pale smear at the foot, or whether a layer is
 * drawing anything at all. Every round of notes in `Waterfalls.js` that begins
 * "isolating this mesh showed..." was produced by hand; this does it in one
 * boot, which is the difference between checking it and not.
 *
 * Writes `<view>-all.png` plus one `<view>-<layer>.png` per layer, and
 * `<view>-none.png` with the whole group hidden — the last is the control that
 * says which defects at the foot of a fall are not the falls at all.
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { VIEWS } from './shot.mjs';
import { POSE_SRC } from './_pose.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const VIEW = arg('view', 'plunge');
const DIR = arg('dir', 'shots/falliso');
const W = parseInt(arg('w', '1000'), 10);
const H = parseInt(arg('h', '620'), 10);
const HOUR = arg('hour', null);
const SEED = arg('seed', '20261018');
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178') + `/?seed=${SEED}`;

const LAYERS = ['WaterfallSheets', 'WaterfallSpray', 'WaterfallBurst',
                'WaterfallMist', 'PlungePools'];

const v = VIEWS[VIEW];
if (!v) { console.error(`no such view: ${VIEW}`); process.exit(1); }

await acquire('falliso');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
if (existsSync('review/anchors.json')) {
  try { frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8')); } catch { frozen = null; }
}
await page.evaluate((h) => {
  window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; window.__forceCamera = true;
}, parseFloat(HOUR ?? v.hour ?? 16.2));
await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: [] });
await page.evaluate(() => window.__settleStable ? window.__settleStable() : window.__settle?.(60));
await page.waitForTimeout(900);

mkdirSync(resolve(DIR), { recursive: true });

const show = async (only) => {
  await page.evaluate(({ names, only: o }) => {
    const s = window.__engine.scene;
    const g = s.getObjectByName('Waterfalls');
    if (g) g.visible = o !== 'none';
    for (const n of names) {
      const m = s.getObjectByName(n);
      if (m) m.visible = (o === 'all' || o === 'none' || n === o);
    }
    return window.__settle?.(20);
  }, { names: LAYERS, only });
  await page.waitForTimeout(420);
};

for (const only of ['all', ...LAYERS, 'none']) {
  await show(only);
  const out = resolve(DIR, `${VIEW}-${only}.png`);
  await page.screenshot({ path: out });
  console.log(`falliso: ${out}`);
}
await browser.close();

#!/usr/bin/env node
/**
 * Test the filed hypothesis for the hard horizontal bar across the curtain
 * (docs/INTEGRATION_REQUESTS.md, FALLS item 2).
 *
 * That note guesses the bar is a `wSteps` quantisation boundary whose softness
 * `lanesWide` is driven off `sheetDist`, so a boundary lands at a fixed height
 * on a fall receding from the camera and is drawn as a horizontal edge. It
 * says, in as many words, that anyone testing it should freeze `lanesWide` at a
 * constant and capture before and after. This does that, plus the two other
 * distance-driven terms the note names, from one page load.
 *
 *   node tools/_scratch/seamprobe.mjs --view waterfall --hour 16.2
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const VIEW = arg('view', 'waterfall');
const DIR = arg('dir', 'shots/r2/seamprobe');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const HOUR = arg('hour', '16.2');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?seed=' + arg('seed', '20261018');

const v = VIEWS[VIEW];
if (!v) { console.error('no such view: ' + VIEW); process.exit(1); }

await acquire('seamprobe');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
if (existsSync('review/anchors.json')) { try { frozen = JSON.parse(readFileSync('review/anchors.json','utf8')); } catch {} }
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; window.__forceCamera = true; }, parseFloat(HOUR));
await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: [] });
await page.evaluate(() => window.__settleStable ? window.__settleStable() : window.__settle?.(60));
await page.waitForTimeout(900);

// UI in a comparison frame silently corrupts it — docs/CRITIC_PROTOCOL.md.
// A stale vite HMR error overlay is pushed on connect and looks exactly like a
// legitimate frame to a harness that does not look.
const assertNoUI = async (tag) => {
  const ui = await page.evaluate(() => {
    const o = document.querySelector('vite-error-overlay');
    const hud = document.querySelector('#hud, .hud');
    return { overlay: !!o, hud: !!hud && getComputedStyle(hud).display !== 'none' };
  });
  if (ui.overlay) { console.error(`!! ${tag}: vite error overlay is in frame — capture is void`); process.exit(1); }
  if (ui.hud) console.error(`!! ${tag}: HUD is visible in frame`);
};
await assertNoUI('boot');

const setup = await page.evaluate(() => {
  let m = null;
  window.__engine.scene.traverse(o => { if (o.name === 'WaterfallSheets') m = o; });
  if (!m) return 'no WaterfallSheets mesh';
  window.__sheet = m; window.__sheetSrc = m.material.fragmentShader;
  return 'ok';
});
if (setup !== 'ok') { console.error(setup); process.exit(1); }

const variants = {
  all: null,
  // The note's own hypothesis: freeze the step softness.
  lanesWideConst: (s) => s.replace(
    'float lanesWide = mix(0.17, 0.5, smoothstep(60.0, 200.0, sheetDist));',
    'float lanesWide = 0.33;'),
  // The other two terms the note names as sharing the same distance driver.
  fadesConst: (s) => s
    .replace('float fineFade = 1.0 - smoothstep(45.0, 130.0, sheetDist);', 'float fineFade = 1.0;')
    .replace('float hairFade = 1.0 - smoothstep(22.0, 70.0, sheetDist);', 'float hairFade = 1.0;'),
  // Everything distance-driven in the sheet at once, lodFar included.
  allDistConst: (s) => s
    .replace('float lanesWide = mix(0.17, 0.5, smoothstep(60.0, 200.0, sheetDist));', 'float lanesWide = 0.33;')
    .replace('float fineFade = 1.0 - smoothstep(45.0, 130.0, sheetDist);', 'float fineFade = 1.0;')
    .replace('float hairFade = 1.0 - smoothstep(22.0, 70.0, sheetDist);', 'float hairFade = 1.0;')
    .replace('float lodFar = smoothstep(140.0, 460.0, sheetDist);', 'float lodFar = 0.0;'),
};

mkdirSync(resolve(DIR), { recursive: true });
const src = await page.evaluate(() => window.__sheetSrc);
for (const [name, patch] of Object.entries(variants)) {
  const patched = patch ? patch(src) : src;
  if (patch && patched === src) { console.error(`!! ${name}: patch matched nothing — variant is a no-op`); process.exit(1); }
  await page.evaluate((fs) => {
    window.__sheet.material.fragmentShader = fs;
    window.__sheet.material.needsUpdate = true;
  }, patched);
  await page.evaluate(() => window.__settle?.(8));
  await page.waitForTimeout(400);
  await assertNoUI(name);
  const out = resolve(DIR, `${VIEW}-${name}.png`);
  await page.screenshot({ path: out });
  console.log('seamprobe:', out);
}
await browser.close();

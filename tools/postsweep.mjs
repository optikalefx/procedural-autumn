#!/usr/bin/env node
/**
 * Sweep the post chain's look record in ONE browser boot.
 *
 * Every other capture tool in this harness pays a world bake per candidate, so
 * a five-value sweep is five bakes and about four minutes, and the notes in
 * PostFX.js and Atmosphere.js show what that costs: most of them record three
 * data points where they wanted fifteen. `PostFX.look` and `Atmosphere.params`
 * are plain writable records precisely so a value decision can be made against
 * a measured ladder instead of against a guess.
 *
 * This poses a camera once per (view, hour), then for each named variant writes
 * the overrides, lets a few frames settle, screenshots, and measures the frame
 * in-page with the same statistics colorstats.mjs reports. One bake, N variants.
 *
 *   node tools/postsweep.mjs --views sunvista,camp --hours 19,0 \
 *     --set 'base:{}' \
 *     --set 'hot:{"post":{"veilLo":0.8}}' \
 *     --set 'cool:{"post":{"threshLo":0.9},"atmos":{"onset":180}}'
 *
 * A variant is `name:{json}` where the JSON may carry:
 *   post   — merged into window.__postfx.look
 *   atmos  — merged into window.__atmosphere.params
 *   exp    — written to window.__postfx.setExposure()'s base
 *
 * `--png <dir>` also writes each variant's frame out, so a promising row can be
 * looked at rather than only measured. A histogram can be right while the frame
 * is ugly; this tool exists to shorten the loop, not to replace looking.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';
import { POSE_SRC } from './_pose.mjs';
import { VIEWS } from './shot.mjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

// The sun/moon-facing and sky-filling framings this round is judged on. Kept in
// step with tools/tod.mjs by hand — importing it would run its capture.
const EXTRA_VIEWS = {
  dome:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.55, fov: 62 },
  moon:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.42, fov: 56, faceMoon: true },
  camp:    { anchor: 'meadow', height: 1.7, dist: 8,  pitch: -0.06, fov: 60 },
  ridge:   { anchor: 'peak',   height: 90, dist: 380, pitch: 0.02, fov: 48 },
  sunvista:{ anchor: 'vista',  height: 62, dist: 150, pitch: 0.03, fov: 52, faceSun: true },
  sunlow:  { anchor: 'meadow', height: 2.0, dist: 10, pitch: 0.05, fov: 56, faceSun: true },
  sunwater:{ anchor: 'mouth',  height: 3.0, dist: 20, pitch: 0.02, fov: 54, faceSun: true },
};
const ALL_VIEWS = { ...VIEWS, ...EXTRA_VIEWS };

const OUT_W = parseInt(arg('w', '1280'), 10);
const OUT_H = parseInt(arg('h', '720'), 10);
const RES = arg('res', '640');
const PNG = arg('png', null);
const params = new URLSearchParams();
if (RES) params.set('res', RES);
const qs = params.toString();
const URL = (arg('url', 'http://localhost:5180')) + (qs ? `?${qs}` : '');
const TIMEOUT = parseInt(arg('timeout', '300000'), 10);

const viewNames = String(arg('views', 'sunvista')).split(',').map((s) => s.trim()).filter(Boolean);
const hours = String(arg('hours', '19')).split(',').map(Number);

const variants = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--set' || !argv[i + 1]) continue;
  const raw = argv[i + 1];
  const k = raw.indexOf(':');
  const name = k === -1 ? raw : raw.slice(0, k);
  let spec = {};
  if (k !== -1) {
    try { spec = JSON.parse(raw.slice(k + 1)); }
    catch (e) { console.error(`bad --set json for "${name}": ${e.message}`); process.exit(1); }
  }
  variants.push({ name, spec });
}
if (!variants.length) variants.push({ name: 'base', spec: {} });

try {
  execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('[postsweep] refusing to run — the source tree does not parse:\n');
  console.error(((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim());
  process.exit(2);
}

await acquire('postsweep');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });

// A sweep wants a frozen build for its whole run; Vite HMR would reload it
// halfway through and silently change what the later rows measure.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: TIMEOUT, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
if (PNG) mkdirSync(resolve(PNG), { recursive: true });

// Snapshot the shipping values so each variant starts from them rather than
// from whatever the previous variant left behind.
await page.evaluate(() => {
  window.__sweepBase = {
    post: { ...window.__postfx.look },
    atmos: { ...window.__atmosphere.params },
    exp: window.__postfx.getExposure(),
  };
});

const hTag = (h) => 'h' + String(h).replace('.', 'p');

/**
 * The same statistics colorstats.mjs reports, computed on a screenshot.
 *
 * NOT on the live canvas. drawImage() of a WebGL canvas without
 * preserveDrawingBuffer returns a cleared buffer once the frame has been
 * presented, and it does so silently — the first run of this tool reported
 * every variant as 100% neutral at luma 0.000, which reads as "the build is
 * broken" rather than "the readback is empty". Going through the compositor
 * costs a PNG encode per variant and is what shot.mjs and tod.mjs both do.
 */
const MEASURE = async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const W = 480, H = Math.max(1, Math.round(img.height / img.width * W));
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const lumas = [];
  let cs = 0, neutral = 0, n = 0, cool = 0, mgnt = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
    lumas.push(0.2126 * r + 0.7152 * gg + 0.0722 * b);
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    const ch = mx - mn;
    cs += ch; n++;
    if (ch < 0.06) neutral++;
    else if (mx === gg || (mx === b && gg >= r)) cool++;
    else if (mx === b || (mx === r && b > gg)) mgnt++;
  }
  lumas.sort((a, b2) => a - b2);
  const q = (p) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
  const mean = lumas.reduce((a, b2) => a + b2, 0) / lumas.length;
  const sd = Math.sqrt(lumas.reduce((a, b2) => a + (b2 - mean) ** 2, 0) / lumas.length);
  return {
    p05: q(0.05), p95: q(0.95), range: q(0.95) - q(0.05), mean, std: sd,
    chroma: cs / n, neutral: (neutral / n) * 100,
    cool: (cool / n) * 100, mgnt: (mgnt / n) * 100,
  };
};

const poseFn = new Function('P', POSE_SRC);
const f3 = (x) => x.toFixed(3);

for (const name of viewNames) {
  const v = ALL_VIEWS[name];
  if (!v) { console.error(`unknown view: ${name}`); continue; }
  for (const hour of hours) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
    await page.evaluate(async () => {
      if (window.__settleStable) await window.__settleStable();
      else if (window.__settle) await window.__settle(60);
    });

    // sin(elevation) is the argument every ramp in PostFX is written against,
    // so print it: "which row of EXPOSURE_LOW is this hour on" is otherwise a
    // guess, and it is the first thing you need when reading the table below.
    const elev = await page.evaluate(() => window.__lighting?.sunDir?.y ?? NaN);
    console.log(`\n── ${name} h${hour}   sunElev ${elev.toFixed(3)}`);
    console.log('variant           p05    p95   range   std   chroma  neut%  cool%  mgnt%');
    for (const { name: vn, spec } of variants) {
      await page.evaluate((s) => {
        const b = window.__sweepBase;
        Object.assign(window.__postfx.look, b.post, s.post ?? {});
        Object.assign(window.__atmosphere.params, b.atmos, s.atmos ?? {});
        window.__postfx.setExposure(s.exp ?? b.exp);
      }, spec);
      await page.evaluate(async () => { await window.__settle(8); });
      const buf = await page.screenshot();
      const m = await page.evaluate(MEASURE, buf.toString('base64'));
      console.log(
        `${vn.padEnd(16)} ${f3(m.p05)}  ${f3(m.p95)}  ${f3(m.range)}  ${f3(m.std)}  ` +
        `${f3(m.chroma)}  ${m.neutral.toFixed(1).padStart(5)}  ` +
        `${m.cool.toFixed(1).padStart(5)}  ${m.mgnt.toFixed(1).padStart(5)}`);
      if (PNG) writeFileSync(resolve(PNG, `${name}-${hTag(hour)}-${vn}.png`), buf);
    }
  }
}

// Leave the page on the shipping values, so a human who opens the same tab
// after a sweep is not looking at the last variant.
await page.evaluate(() => {
  const b = window.__sweepBase;
  Object.assign(window.__postfx.look, b.post);
  Object.assign(window.__atmosphere.params, b.atmos);
  window.__postfx.setExposure(b.exp);
});

if (errors.length) console.log('\npage-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();

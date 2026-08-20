#!/usr/bin/env node
/**
 * Star crawl / aliasing test.
 *
 * A starfield is the one thing in this project that a still frame cannot
 * validate. The two failure modes are invisible in any single capture:
 *
 *   * **crawl** — the field is anchored to the screen or to the camera's
 *     *position* rather than to world direction, so stars slide or swim as the
 *     player drives. `skystrip.mjs` cannot see this because it deliberately
 *     holds the camera still.
 *   * **aliasing** — stars are drawn smaller than a pixel with a hard edge, so
 *     each one pops in and out as the camera turns by a fraction of a pixel.
 *     This is the defect that reads as "the sky is fizzing" in motion and it is
 *     completely absent from every still.
 *
 * So: pose one view, then rotate the camera by a few *sub-pixel* yaw steps and
 * a couple of large ones, and report per-frame star statistics.
 *
 *   node tools/starpan.mjs --view dome --hour 0 --dir shots/pan
 *
 * How to read it:
 *   * count and magnitude p50/max should be **stable** across the sub-pixel
 *     steps. A count that swings by more than a few percent between a 0.02 deg
 *     and a 0.04 deg turn is aliasing — the field is not band-limited.
 *   * the statistics should also be stable across the large steps, because the
 *     sky is statistically homogeneous. A big change there means the density is
 *     not even over the dome.
 *   * crawl is checked by eye from the frames: at 0.02 deg (well under a pixel)
 *     the frames must be near-identical, and at 4 deg every star must have
 *     moved by the *same* screen distance.
 *
 * Deliberately does NOT step time: `uTime` is frozen so scintillation cannot be
 * mistaken for instability. Anything that changes here changes because of the
 * camera.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';
import { POSE_SRC } from './_pose.mjs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const VIEWS = {
  dome: { anchor: 'vista', height: 60, dist: 150, pitch: 0.55, fov: 62 },
  moon: { anchor: 'vista', height: 60, dist: 150, pitch: 0.42, fov: 56, faceMoon: true },
};

const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const HOUR = parseFloat(arg('hour', '0'));
const NAME = String(arg('view', 'dome'));
const DIR = resolve(arg('dir', 'shots/pan'));
const RES = arg('res', null);
const params = new URLSearchParams();
if (RES) params.set('res', RES);
const qs = params.toString();
const URL = (arg('url', 'http://localhost:5180')) + (qs ? `?${qs}` : '');

// Degrees of yaw. The first four are sub-pixel at this framing (one pixel is
// about 0.04 deg at fov 62 over 1600 px), the last two are gross motion.
const STEPS = String(arg('steps', '0,0.01,0.02,0.04,1.0,4.0')).split(',').map(Number);

try {
  execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('[starpan] refusing to run — the source tree does not parse:\n');
  console.error(((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim());
  process.exit(2);
}

await acquire('starpan');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
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
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}

mkdirSync(DIR, { recursive: true });
const poseFn = new Function('P', POSE_SRC);
const base = VIEWS[NAME] ?? VIEWS.dome;

await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);

const rows = [];
for (const deg of STEPS) {
  const v = { ...base, yawOffset: (base.yawOffset ?? 0) + deg * Math.PI / 180 };
  await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(60);
  });
  await page.waitForTimeout(500);

  const tag = String(deg).replace('.', 'p').replace('-', 'm');
  const out = `${DIR}/${NAME}-yaw${tag}.png`;
  await page.screenshot({ path: out });

  const st = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const Wp = img.width, y1 = Math.floor(img.height * 0.45);
    const d = g.getImageData(0, 0, Wp, y1).data;
    const lum = new Float32Array(Wp * y1);
    for (let i = 0, n = Wp * y1; i < n; i++) {
      const j = i * 4;
      lum[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    }
    let count = 0; const mags = [];
    for (let y = 2; y < y1 - 2; y++) for (let x = 2; x < Wp - 2; x++) {
      const v = lum[y * Wp + x];
      let localMax = true, ring = 0, rn = 0;
      for (let dy = -2; dy <= 2 && localMax; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const u = lum[(y + dy) * Wp + (x + dx)];
        if (u > v) { localMax = false; break; }
        if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { ring += u; rn++; }
      }
      if (!localMax) continue;
      if (v - ring / Math.max(1, rn) > 0.045) { count++; mags.push(v - ring / Math.max(1, rn)); }
    }
    mags.sort((a, b) => b - a);
    const q = (p) => mags.length ? mags[Math.min(mags.length - 1, Math.floor(p * mags.length))] : 0;
    return { count, p50: q(0.5), max: mags[0] ?? 0 };
  }, readFileSync(out).toString('base64'));

  rows.push({ deg, ...st });
  console.log(`yaw ${String(deg).padStart(6)} deg   stars ${String(st.count).padStart(5)}   ` +
              `p50 ${st.p50.toFixed(3)}   max ${st.max.toFixed(3)}`);
}

const c = rows.map((r) => r.count);
const spread = (Math.max(...c) - Math.min(...c)) / Math.max(1, Math.min(...c));
console.log(`\ncount spread across all yaws: ${(spread * 100).toFixed(1)}%` +
            (spread > 0.12 ? '   ** unstable — the field is aliasing **' : '   (stable)'));
console.log(`starpan: ${DIR}`);
await browser.close();

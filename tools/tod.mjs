#!/usr/bin/env node
/**
 * Time-of-day sweep.
 *
 * The harness could shoot one hour per boot. A 25-second world bake per frame
 * meant nobody ever looked at the whole arc, and it shows: the night keys, the
 * blue hour and the two twilight keys have never been judged as a *sequence*,
 * only as isolated stills months apart. This poses a camera once and then walks
 * `hour` across it, so a whole day comes out of a single bake.
 *
 *   node tools/tod.mjs --views hero,drive --hours 0,6.3,7.4,17.1,19,21 --dir shots/tod-r1
 *   node tools/tod.mjs --views night --hours 22 --url http://localhost:5180
 *
 * Frames are named `<view>-h<hour>.png` with the dot replaced by `p`, so
 * ab.mjs can pair two sweeps by filename.
 *
 * Unlike shot.mjs this does NOT reject a dark frame. shot.mjs treats >60% near
 * black as a failed capture, which is a correct guard for a daylight still and
 * exactly wrong for midnight — it was silently deleting every night frame and
 * leaving an empty directory that read as "the tool is broken".
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';
import { POSE_SRC } from './_pose.mjs';
import { VIEWS } from './shot.mjs';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// Extra framings this round needs and shot.mjs has no reason to carry: a sky
// that fills the frame, and a camp-height view that judges "can I see by
// moonlight" rather than "is the dome pretty".
const EXTRA_VIEWS = {
  // Pitched up so the dome — stars, moon, the whole gradient — is most of the
  // frame. Every existing view sees under ~15 deg of sky, which is why the
  // starfield has never actually been looked at.
  dome:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.55, fov: 62 },
  // Same, facing the moon.
  moon:    { anchor: 'vista',  height: 60, dist: 150, pitch: 0.42, fov: 56, faceMoon: true },
  // Standing in the meadow at human height: the "can I navigate by moonlight"
  // test. Ground must be readable, not a black plate.
  camp:    { anchor: 'meadow', height: 1.7, dist: 8,  pitch: -0.06, fov: 60 },
  // A ridge line against the sky — the silhouette/value-separation test.
  ridge:   { anchor: 'peak',   height: 90, dist: 380, pitch: 0.02, fov: 48 },
  // FACING THE SUN. Every framing this project has ever judged looks away from
  // it — `hero`, `drive`, `meadow`, `peaks` all put the key behind the camera —
  // so the sun disc, the aureole and the whole horizon wedge have never once
  // appeared in a reviewed frame. The brief asks for "beautiful golden glows"
  // and no capture in the archive contains the thing being asked for.
  sunvista:{ anchor: 'vista',  height: 62, dist: 150, pitch: 0.03, fov: 52, faceSun: true },
  // Eye level into the sun: the reference sunset plates are shot from the floor
  // of a canyon looking straight down the light.
  sunlow:  { anchor: 'meadow', height: 2.0, dist: 10, pitch: 0.05, fov: 56, faceSun: true },
  // Over water, into the sun — morning.jpg's exact setup, and the one that
  // shows whether the warm sky and the cool water actually complement.
  sunwater:{ anchor: 'mouth',  height: 3.0, dist: 20, pitch: 0.02, fov: 54, faceSun: true },
};
const ALL_VIEWS = { ...VIEWS, ...EXTRA_VIEWS };

const OUT_W = parseInt(arg('w', '1600'), 10);
const OUT_H = parseInt(arg('h', '900'), 10);
const RES = arg('res', null);
const QUALITY = arg('quality', null);
const SEED = arg('seed', null);
const params = new URLSearchParams();
if (RES) params.set('res', RES);
if (QUALITY) params.set('quality', QUALITY);
if (SEED) params.set('seed', SEED);
const qs = params.toString();
const URL = (arg('url', 'http://localhost:5180')) + (qs ? `?${qs}` : '');
const TIMEOUT = parseInt(arg('timeout', '240000'), 10);
const DIR = resolve(arg('dir', 'shots/tod'));

const viewNames = String(arg('views', 'hero,camp,dome')).split(',').map((s) => s.trim()).filter(Boolean);
const hours = String(arg('hours', '0,6.3,7.4,17.1,19,21')).split(',').map(Number);

const hTag = (h) => 'h' + String(h).replace('.', 'p');

try {
  execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('[tod] refusing to run — the source tree does not parse:\n');
  console.error(((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim());
  process.exit(2);
}

await acquire('tod');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: OUT_W, height: OUT_H }, deviceScaleFactor: 1 });

// Vite HMR reloads the page when a peer saves; a capture wants a frozen build.
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

mkdirSync(DIR, { recursive: true });
const poseFn = new Function('P', POSE_SRC);

for (const name of viewNames) {
  const v = ALL_VIEWS[name];
  if (!v) { console.error(`unknown view: ${name} (have ${Object.keys(ALL_VIEWS).join(', ')})`); continue; }

  for (const hour of hours) {
    // Set the hour BEFORE posing: faceSun/faceMoon need the right sun.
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
    await page.evaluate(async () => {
      if (window.__settleStable) await window.__settleStable();
      else if (window.__settle) await window.__settle(60);
    });
    await page.waitForTimeout(900);

    const out = `${DIR}/${name}-${hTag(hour)}.png`;
    await page.screenshot({ path: out });

    // Report the frame's own tone so a caller can tell "correctly dark" from
    // "failed to render". No frame is rejected on darkness here.
    const q = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const W = 160, H = Math.max(1, Math.round(img.height / img.width * W));
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      let sum = 0, n = 0, mx = 0;
      const colDark = new Array(W).fill(0);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        sum += l; n++; if (l > mx) mx = l;
        if (l < 0.02) colDark[x]++;
      }
      return { mean: sum / n, max: mx, deadCols: colDark.filter((c) => c >= H * 0.98).length / W };
    }, readFileSync(out).toString('base64'));

    const flag = q.deadCols > 0.25 ? '  ** DEAD COLUMNS — capture failed **' : '';
    console.log(`${name} h${hour}  mean ${q.mean.toFixed(4)}  max ${q.max.toFixed(3)}${flag}`);
  }
}

console.log(`tod: ${DIR}`);
if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));
await browser.close();

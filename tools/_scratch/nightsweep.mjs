#!/usr/bin/env node
/**
 * One boot, the whole night value decision.
 *
 * Sweeps `lighting.ambientScale` and `lighting.moonScale` together across a
 * range and reports the ladder points that the brief scores — ground luma
 * against sky luma — for several views. The grade's response below ~0.05
 * linear is steep enough (contrast about a 0.18 pivot, then a soft toe) that
 * guessing a night key is hopeless; this is the transfer curve, measured.
 *
 * With `--skysweep` it instead neutralises Sky.js's NIGHT_KEY_OVERRIDE (a
 * runtime uniform poke, not an edit) and sweeps `keyOverride.zen/hor` so the
 * dome's own colours can be chosen against the plate.
 *
 *   node tools/_scratch/nightsweep.mjs --views camp,hero --hour 0 \
 *        --vals 1.0,0.5,0.28,0.16,0.09 --dir shots/nsweep
 *   node tools/_scratch/nightsweep.mjs --skysweep --views hero --hour 0 \
 *        --zens 0x6e5a80,0x8a6070,0x9a6a72 --dir shots/nsweep
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);
const HOUR = parseFloat(arg('hour', '0'));
const DIR = resolve(arg('dir', 'shots/nsweep'));
const URL = (arg('url', 'http://localhost:5180')) + '?res=' + arg('res', '512');
const VALS = String(arg('vals', '1.0,0.5,0.28,0.16,0.09')).split(',').map(Number);
const ZENS = String(arg('zens', '0x6e5a80')).split(',').map((s) => parseInt(s, 16));
const HORS = String(arg('hors', '')).split(',').filter(Boolean).map((s) => parseInt(s, 16));

const EXTRA = {
  camp:  { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 },
  ridge: { anchor: 'peak', height: 90, dist: 380, pitch: 0.02, fov: 48 },
  dome:  { anchor: 'vista', height: 60, dist: 150, pitch: 0.55, fov: 62 },
};
const ALL = { ...VIEWS, ...EXTRA };
const NAMES = String(arg('views', 'camp,hero')).split(',');

await acquire('nightsweep');
mkdirSync(DIR, { recursive: true });
let frozen = {};
for (const p of ['review/anchors.json', 'shots/_anchors.json'])
  if (existsSync(p)) { try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...frozen }; } catch { /* */ } }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', String(e)));
// Four authors are saving files while this runs; Vite's HMR socket would
// reload the page mid-sweep and destroy the execution context. Same guard
// tod.mjs uses.
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
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const PTS = [['sky', 0.50, 0.05], ['sky12', 0.50, 0.12], ['skyLo', 0.50, 0.22],
             ['far', 0.50, 0.55], ['mid', 0.50, 0.72], ['near', 0.50, 0.92],
             ['nearL', 0.16, 0.86]];

const shoot = async (tag) => {
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(40);
  });
  await page.waitForTimeout(420);
  const path = `${DIR}/${tag}.png`;
  await page.screenshot({ path });
  return page.evaluate(async ({ b64, PTS }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const W = img.width, H = img.height;
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return PTS.map(([label, px, py]) => {
      const cx = Math.round(px * (W - 1)), cy = Math.round(py * (H - 1));
      let r = 0, gq = 0, b = 0, n = 0;
      for (let y = cy - 7; y <= cy + 7; y++) for (let x = cx - 7; x <= cx + 7; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4; r += d[i]; gq += d[i + 1]; b += d[i + 2]; n++;
      }
      r /= n; gq /= n; b /= n;
      const lr = toLin(r), lg = toLin(gq), lb = toLin(b);
      const mxs = Math.max(r, gq, b) / 255, mns = Math.min(r, gq, b) / 255;
      return { label, hex: '#' + [r, gq, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
        ratio: `1:${(lg / (lr || 1e-6)).toFixed(2)}:${(lb / (lr || 1e-6)).toFixed(2)}`,
        luma: 0.2126 * lr + 0.7152 * lg + 0.0722 * lb, chroma: mxs - mns };
    });
  }, { b64: readFileSync(path).toString('base64'), PTS });
};

for (const name of NAMES) {
  const v = ALL[name];
  if (!v) { console.error('unknown view', name); continue; }
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
  await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: ['vehicle'] });

  if (has('skysweep')) {
    {
      const rows = await shoot(`${name}-control`);
      console.log(`\n── ${name} h${HOUR}  CONTROL (Sky.js override as shipped, B keys as authored)`);
      for (const r of rows) console.log(`   ${r.label.padEnd(6)} ${r.hex}  ${r.ratio.padEnd(14)} luma ${r.luma.toFixed(4)}  chroma ${r.chroma.toFixed(3)}`);
    }
    await page.evaluate(() => {
      const u = window.__sky?.uniforms;
      if (u?.uNightKeyMix) { u.uNightKeyMix.value = 0; Object.defineProperty(u.uNightKeyMix, 'value',
        { get: () => 0, set: () => {}, configurable: true }); }
    });
    for (let i = 0; i < ZENS.length; i++) {
      const zen = ZENS[i], hor = HORS[i] ?? ZENS[i];
      await page.evaluate(({ zen, hor }) => { window.__lighting.keyOverride = { zen, hor }; }, { zen, hor });
      const rows = await shoot(`${name}-zen${zen.toString(16)}`);
      console.log(`\n── ${name} h${HOUR}  zen #${zen.toString(16)} hor #${hor.toString(16)}`);
      for (const r of rows) console.log(`   ${r.label.padEnd(6)} ${r.hex}  ${r.ratio.padEnd(14)} luma ${r.luma.toFixed(4)}  chroma ${r.chroma.toFixed(3)}`);
    }
    await page.evaluate(() => { window.__lighting.keyOverride = null; });
    continue;
  }

  for (const val of VALS) {
    await page.evaluate((v2) => {
      const L = window.__lighting;
      L.ambientScale = v2; L.moonScale = v2;
    }, val);
    const rows = await shoot(`${name}-a${String(val).replace('.', 'p')}`);
    const sky = rows[0].luma;
    console.log(`\n── ${name} h${HOUR}  ambient/moon x${val}`);
    for (const r of rows) {
      console.log(`   ${r.label.padEnd(6)} ${r.hex}  ${r.ratio.padEnd(14)} luma ${r.luma.toFixed(4)}` +
        `  chroma ${r.chroma.toFixed(3)}  /sky ${(r.luma / Math.max(sky, 1e-5)).toFixed(2)}`);
    }
  }
  await page.evaluate(() => { const L = window.__lighting; L.ambientScale = 1; L.moonScale = 1; });
}
await browser.close();

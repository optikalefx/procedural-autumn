#!/usr/bin/env node
/**
 * Is the orange patch in `camp-h0` the grass shader's backlit translucency?
 *
 * grass_material.js adds `mix(uGlowCol, uSunColor, 0.35) * trans * uTrans` with
 * uGlowCol a fixed hot amber (0xffa235) and uTrans a fixed 2.10, and neither
 * that term nor the fixed-blue `uSkyFill` is scaled by the sun's *intensity* or
 * by dayFactor. So at midnight the field can still glow as if it were golden
 * hour. This shoots the same posed frame with each term zeroed in turn.
 *
 *   node tools/_scratch/grassleak.mjs --hour 0 --dir shots/diag
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const HOUR = parseFloat(arg('hour', '0'));
const DIR = resolve(arg('dir', 'shots/diag'));
const URL = (arg('url', 'http://localhost:5180')) + '?res=' + arg('res', '640');
const VIEW = { anchor: 'meadow', height: 1.7, dist: 8, pitch: -0.06, fov: 60 };

await acquire('grassleak');
mkdirSync(DIR, { recursive: true });
let frozen = {};
for (const p of ['review/anchors.json', 'shots/_anchors.json'])
  if (existsSync(p)) { try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...frozen }; } catch { /* */ } }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[page]', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
await page.evaluate(new Function('P', POSE_SRC), { v: VIEW, frozen, dynamic: ['vehicle'] });

const shoot = async (tag) => {
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(40);
  });
  await page.waitForTimeout(500);
  const path = `${DIR}/leak-${tag}.png`;
  await page.screenshot({ path });
  const rows = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const W = img.width, H = img.height;
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const pts = [['grass', 0.20, 0.80], ['ground', 0.86, 0.88], ['sky', 0.5, 0.06]];
    return pts.map(([label, px, py]) => {
      const cx = Math.round(px * (W - 1)), cy = Math.round(py * (H - 1));
      let r = 0, gq = 0, b = 0, n = 0;
      for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) {
        const i = (y * W + x) * 4; r += d[i]; gq += d[i + 1]; b += d[i + 2]; n++;
      }
      r /= n; gq /= n; b /= n;
      const lr = toLin(r), lg = toLin(gq), lb = toLin(b);
      return { label, srgb: [Math.round(r), Math.round(gq), Math.round(b)],
        ratio: `1 : ${(lg / (lr || 1e-6)).toFixed(2)} : ${(lb / (lr || 1e-6)).toFixed(2)}`,
        luma: (0.2126 * lr + 0.7152 * lg + 0.0722 * lb).toFixed(4) };
    });
  }, readFileSync(path).toString('base64'));
  console.log(`\n── ${tag}`);
  for (const s of rows) console.log(`   ${s.label.padEnd(8)} ${String(s.srgb).padEnd(14)} ${s.ratio}   luma ${s.luma}`);
};

const findGrass = () => {
  if (window.__grassU) return window.__grassU;
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || d > 3 || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    if (o.uniforms?.uGlowCol) return o.uniforms;
    for (const k of Object.keys(o)) {
      const r = walk(o[k], d + 1);
      if (r) return r;
    }
    return null;
  };
  return (window.__grassU = walk({ s: window.__systems, c: window.__ctx }, 0));
};

const setU = (name, val) => page.evaluate(({ name, val, src }) => {
  // eslint-disable-next-line no-new-func
  const u = new Function('return (' + src + ')()')();
  if (!u) return 'no grass uniforms';
  window.__leakSaved ??= {};
  if (!(name in window.__leakSaved)) window.__leakSaved[name] = u[name].value;
  u[name].value = val;
  return 'ok';
}, { name, val, src: findGrass.toString() });

console.log('grass handle:', await page.evaluate((src) => {
  // eslint-disable-next-line no-new-func
  const u = new Function('return (' + src + ')()')();
  return u ? 'found, uTrans=' + u.uTrans.value + ' uSkyFill=' + u.uSkyFill.value : 'NOT FOUND';
}, findGrass.toString()));

await shoot('asis');
console.log('setU uTrans ->', await setU('uTrans', 0));
await shoot('notrans');
console.log('setU uSkyFill ->', await setU('uSkyFill', 0));
await shoot('notrans-nosky');
await setU('uTrans', 2.10);
await shoot('nosky-only');
await browser.close();

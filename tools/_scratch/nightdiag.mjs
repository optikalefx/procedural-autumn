#!/usr/bin/env node
/**
 * What is actually lighting the ground at midnight?
 *
 * Three questions this answers in one boot, which is the whole point:
 *   1. Is the orange patch in `camp-h0` the camper's headlights? (force them
 *      to zero and re-shoot the identical frame)
 *   2. What is the ground's *albedo ratio* — i.e. what does it come back as
 *      under a known neutral light? Everything about choosing a moon colour
 *      depends on this and it has never been measured.
 *   3. How much of the frame is the hemisphere fill vs the key?
 *
 *   node tools/_scratch/nightdiag.mjs --hour 0 --dir shots/diag
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

await acquire('nightdiag');
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

const settle = async () => {
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(60);
  });
  await page.waitForTimeout(700);
};

// Sample a patch of the frame from the live canvas.
const sample = async (tag) => {
  const path = `${DIR}/camp-${tag}.png`;
  await page.screenshot({ path });
  const rows = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const W = img.width, H = img.height;
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const toLin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const pts = [['sky', 0.5, 0.06], ['nearL-grass', 0.20, 0.80], ['nearC', 0.50, 0.88],
                 ['nearR', 0.86, 0.88], ['mid', 0.5, 0.62], ['far', 0.5, 0.50]];
    return pts.map(([label, px, py]) => {
      const cx = Math.round(px * (W - 1)), cy = Math.round(py * (H - 1));
      let r = 0, gq = 0, b = 0, n = 0;
      for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4; r += d[i]; gq += d[i + 1]; b += d[i + 2]; n++;
      }
      r /= n; gq /= n; b /= n;
      const lr = toLin(r), lg = toLin(gq), lb = toLin(b);
      const luma = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      return { label, srgb: [Math.round(r), Math.round(gq), Math.round(b)],
        ratio: [1, lg / (lr || 1e-6), lb / (lr || 1e-6)], luma };
    });
  }, readFileSync(path).toString('base64'));
  console.log(`\n── ${tag}`);
  for (const s of rows) {
    console.log(`   ${s.label.padEnd(12)} ${String(s.srgb).padEnd(14)}  1 : ${s.ratio[1].toFixed(3)} : ${s.ratio[2].toFixed(3)}   luma ${s.luma.toFixed(4)}`);
  }
};

await settle();
await sample('asis');

// 1. Headlights off.
const lampReport = await page.evaluate(() => {
  const out = [];
  const e = window.__engine;
  window.__diagOff = [];
  e.scene.traverse((o) => {
    if (o.isSpotLight || o.isPointLight) {
      out.push({ type: o.type, intensity: o.intensity, color: o.color.getHexString(),
                 pos: [o.position.x.toFixed(2), o.position.y.toFixed(2), o.position.z.toFixed(2)] });
      window.__diagOff.push([o, o.intensity]);
      o.intensity = 0;
    }
  });
  return out;
});
console.log('\npoint/spot lights in scene:', JSON.stringify(lampReport, null, 1));
await settle();
await sample('nolamp');

// 2. Neutral-light albedo probe: white hemi, key off, everything else off.
await page.evaluate(() => {
  const L = window.__lighting;
  window.__diagSaved = {
    hemiC: L.hemi.color.clone(), hemiG: L.hemi.groundColor.clone(), hemiI: L.hemi.intensity,
    sunI: L.sun.intensity, fillI: L.fill.intensity,
  };
  L.hemi.color.setRGB(1, 1, 1); L.hemi.groundColor.setRGB(1, 1, 1); L.hemi.intensity = 3.0;
  L.sun.intensity = 0; L.fill.intensity = 0;
  // Freeze: update() would overwrite these next frame.
  L.__frozen = true;
  const orig = L.update.bind(L);
  L.update = () => {};
  window.__diagRestore = () => { L.update = orig; };
});
await settle();
await sample('albedo-white-hemi');

console.log('\nnote: albedo-white-hemi is albedo x geometry x post, key off.');
await browser.close();

// KEY-vs-FILL on the lit world, per hour.
//
// The question this round is about is not "how bright is the frame" — every
// whole-frame statistic in this project is dominated by the sky dome, which is
// lit independently of any light in the scene. The question is how much of the
// LIT WORLD's radiance comes from the directional key and how much from the
// hemisphere fill, because a frame whose key has collapsed into the fill has no
// terminator, no cast-shadow read and no form, however bright it measures.
//
// Method. One boot, one pose, three captures per hour:
//   A  normal
//   B  sun.intensity forced to 0     -> fill only
//   C  hemi + counter-key forced to 0 -> key only
// forced by wrapping Lighting.update AFTER it runs, so SKY_STATE — and
// therefore the dome, the aureole, the haze colour and every published value —
// is bit-identical across all three. That matters: driving this off
// `keyOverride: { sunI: 0 }` would also rewrite `SKY_STATE.sunIntensity` and
// change the sky, and the measurement would then be of a different picture.
//
// The ground mask is self-calibrating and is the reason no framing constant
// appears here: a pixel is GROUND if it changed between A and B. The dome
// cannot change, so every sky pixel is excluded by construction, and so is any
// pixel the key never reached.
//
// WHAT THIS TOOL NO LONGER REPORTS, AND WHY. It used to print `groundPx%`,
// `keyChroma` and `keyHue` alongside the shares. Those three were wrong, and
// the wrong `keyHue` is what sent round 1 of the sunrise work chasing a tint
// the key did not actually have.
//
// The mask assumes the ONLY thing that differs between captures A and B is the
// key. Nothing here freezes time, so the clouds drift between the three
// screenshots and their shadows sweep across the ground. Those pixels change
// for a reason that has nothing to do with the sun, and the mask swallows them
// whole. Measured on an A/A control — same build, same hour, both arms
// identical — `groundPx%` came back anywhere between 2.8% and 56%. A statistic
// that moves by a factor of twenty when the answer must be zero is not noisy,
// it is meaningless, and `keyChroma`/`keyHue` are means taken over that same
// mask so they inherit all of it.
//
// The share columns survive because they are ratios of means over ONE mask:
// whatever the mask wrongly includes, it includes in the numerator and the
// denominator alike, and it mostly divides out. Same A/A control returns
// keyShare -0.014…+0.014, which is the tolerance to read them at.
//
// If a future author needs the hue of the key, do not resurrect these columns
// on top of this mask — freeze the clock across all three captures first
// (there is no hook for that today; src/main.js would need one), then a
// difference mask means what it claims to.
//
//   node tools/_scratch/keyfill.mjs --views hero,drive --hours 7,17.5 --url http://127.0.0.1:5203
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const URL = arg('url', 'http://localhost:5180');
const NAMES = arg('views', 'hero,drive').split(',');
const HOURS = arg('hours', '7,17.5').split(',').map(Number);

await acquire('keyfill');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
for (const p of ['review/anchors.json', 'shots/_anchors.json']) {
  if (!existsSync(p)) continue;
  try { frozen = { ...JSON.parse(readFileSync(p, 'utf8')), ...(frozen ?? {}) }; } catch { /* corrupt */ }
}
const poseFn = new Function('P', POSE_SRC);

// Wrap update once. `__kfMode` selects which lights survive the frame.
await page.evaluate(() => {
  const L = window.__lighting;
  const inner = L.update.bind(L);
  window.__kfMode = 'A';
  L.update = (dt, focus) => {
    inner(dt, focus);
    if (window.__kfMode === 'B') L.sun.intensity = 0;
    if (window.__kfMode === 'C') { L.hemi.intensity = 0; L.fill.intensity = 0; }
  };
});

const grab = async (mode) => {
  await page.evaluate((m) => { window.__kfMode = m; }, mode);
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(30);
  });
  await page.waitForTimeout(350);
  return (await page.screenshot()).toString('base64');
};

console.log('view       hour   keyShare  fillShare   lit/fill');
for (const name of NAMES) {
  const v = { ...VIEWS[name] };
  if (!v) { console.error('unknown view', name); continue; }
  for (const hour of HOURS) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
    const A = await grab('A'), B = await grab('B'), C = await grab('C');
    const r = await page.evaluate(async ({ A, B, C }) => {
      const dec = async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const w = 400, h = Math.round(img.height / img.width * w);
        const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
        g.drawImage(img, 0, 0, w, h);
        return { d: g.getImageData(0, 0, w, h).data, w, h };
      };
      const a = await dec(A), b = await dec(B), c = await dec(C);
      // display sRGB -> linear, so the shares are radiance shares.
      const lin = (u) => { const x = u / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      let n = 0, sumA = 0, sumB = 0, sumC = 0;
      for (let i = 0; i < a.d.length; i += 4) {
        const dl = Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
        if (dl < 4) continue;               // sky, or a surface the key never reached
        const L = (o, j) => 0.2126 * lin(o.d[j]) + 0.7152 * lin(o.d[j + 1]) + 0.0722 * lin(o.d[j + 2]);
        sumA += L(a, i); sumB += L(b, i); sumC += L(c, i);
        n++;
      }
      if (!n) return null;
      const mA = sumA / n, mB = sumB / n, mC = sumC / n;
      return { keyShare: (mA - mB) / mA, fillShare: mB / mA, litFill: mC / mB };
    }, { A, B, C });
    if (!r) { console.log(`${name.padEnd(10)} ${String(hour).padStart(5)}   (no lit pixels)`); continue; }
    console.log(`${name.padEnd(10)} ${String(hour).padStart(5)} ${r.keyShare.toFixed(3).padStart(9)} ${r.fillShare.toFixed(3).padStart(10)} ${r.litFill.toFixed(3).padStart(10)}`);
  }
}
await browser.close();

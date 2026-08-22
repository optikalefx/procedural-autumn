// WHERE DOES THE NON-KEY LIGHT ACTUALLY COME FROM?
//
// `keyfill.mjs` says the sun is under half the lit world's radiance at every
// low-sun hour. The obvious next step — cut the hemisphere fill — moved the
// number by 2%, which means the hemisphere is not what is filling the frame.
// This takes the remaining light apart one term at a time on the SAME posed
// frame, so the answer is attribution rather than inference.
//
// Arms, each cumulative on the one above:
//   A   shipping
//   -sun    sun.intensity 0
//   -hemi   …and hemisphere 0
//   -fill   …and the counter-key 0
//   -haze   …and Atmosphere density 0
// Reported as mean LINEAR luma over the whole frame and over the lit world
// (pixels that changed when the sun went out).
//
//   node tools/_scratch/filldecomp.mjs --views hero,drive --hours 7.4,17.5 --url …
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1280'), 10), H = parseInt(arg('h', '720'), 10);
const URL = arg('url', 'http://localhost:5180');
const NAMES = arg('views', 'hero').split(',');
const HOURS = arg('hours', '7.4').split(',').map(Number);

await acquire('filldecomp');
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

await page.evaluate(() => {
  const L = window.__lighting;
  const inner = L.update.bind(L);
  window.__fd = { sun: 1, hemi: 1, fill: 1 };
  L.update = (dt, focus) => {
    inner(dt, focus);
    L.sun.intensity *= window.__fd.sun;
    L.hemi.intensity *= window.__fd.hemi;
    L.fill.intensity *= window.__fd.fill;
  };
});

const ARMS = [
  ['A', { sun: 1, hemi: 1, fill: 1 }, false],
  ['-sun', { sun: 0, hemi: 1, fill: 1 }, false],
  ['-hemi', { sun: 0, hemi: 0, fill: 1 }, false],
  ['-fill', { sun: 0, hemi: 0, fill: 0 }, false],
  ['-haze', { sun: 0, hemi: 0, fill: 0 }, true],
];

const shoot = async (fd, noHaze) => {
  await page.evaluate(({ fd, noHaze }) => {
    window.__fd = fd;
    // fogScale, not atmosphere.params.density: main.js copies Lighting's
    // fogDensity into Atmosphere every frame, so writing the param directly is
    // overwritten before the next draw and the arm measures nothing.
    window.__lighting.fogScale = noHaze ? 0 : 1;
  }, { fd, noHaze });
  await page.evaluate(async () => {
    if (window.__settleStable) await window.__settleStable();
    else if (window.__settle) await window.__settle(30);
  });
  await page.waitForTimeout(300);
  return (await page.screenshot()).toString('base64');
};

for (const name of NAMES) {
  const v = { ...VIEWS[name] };
  for (const hour of HOURS) {
    await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, hour);
    await page.evaluate(poseFn, { v, frozen, dynamic: ['vehicle'] });
    const shots = [];
    for (const [, fd, nh] of ARMS) shots.push(await shoot(fd, nh));
    const out = await page.evaluate(async ({ shots }) => {
      const dec = async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const w = 400, h = Math.round(img.height / img.width * w);
        const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
        g.drawImage(img, 0, 0, w, h);
        return g.getImageData(0, 0, w, h).data;
      };
      const lin = (u) => { const x = u / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      const fr = [];
      for (const s of shots) fr.push(await dec(s));
      const mask = [];
      for (let i = 0; i < fr[0].length; i += 4) {
        const d = Math.abs(fr[0][i] - fr[1][i]) + Math.abs(fr[0][i + 1] - fr[1][i + 1]) + Math.abs(fr[0][i + 2] - fr[1][i + 2]);
        mask.push(d >= 4);
      }
      return fr.map((f) => {
        let all = 0, na = 0, lit = 0, nl = 0;
        for (let i = 0, p = 0; i < f.length; i += 4, p++) {
          const L = 0.2126 * lin(f[i]) + 0.7152 * lin(f[i + 1]) + 0.0722 * lin(f[i + 2]);
          all += L; na++;
          if (mask[p]) { lit += L; nl++; }
        }
        return { all: all / na, lit: lit / nl };
      });
    }, { shots });
    console.log(`\n${name} h${hour}   (lit-world mean linear luma; each arm cumulative)`);
    let prev = null;
    ARMS.forEach(([label], i) => {
      const d = prev == null ? '' : `   removed ${((prev - out[i].lit) / out[0].lit * 100).toFixed(1)}% of A`;
      console.log(`  ${label.padEnd(7)} lit ${out[i].lit.toFixed(4)}   whole ${out[i].all.toFixed(4)}${d}`);
      prev = out[i].lit;
    });
  }
}
await browser.close();

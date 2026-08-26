#!/usr/bin/env node
/**
 * cookcurve — measure the roasting mini-game's cook curve IN THE LIVE GAME, at
 * the real pose, the real hold and the real fire.
 *
 * Every other instrument in this family measures the toast simulation on a
 * synthesised transform (toastsim.mjs) or measures a picture (roastshot.mjs).
 * Neither answers the only question a player asks — "how long until it is
 * golden?" — because the sim drives an on-axis pose the view does not use and
 * the shot sheet paints absolute doneness rather than integrating any.
 *
 * So: sit down at a real camp, pin the step-in, set a height, spin at a fixed
 * rate, and step the whole view at 60 Hz reading `state()` as it goes. What
 * comes out is the curve the player is on.
 *
 *   node tools/_scratch/cookcurve.mjs
 *   node tools/_scratch/cookcurve.mjs --seconds 120 --heights 0.10,0.24,0.50
 *   node tools/_scratch/cookcurve.mjs --spin 0            (the never-turn case)
 *
 * It also dumps the geometry each height puts the marshmallow at — distance to
 * the fire's hot point, height above it, radius off its axis — because that is
 * the input the rates in marshmallow_toast.js are derived against and it is not
 * the on-axis 0.25 m the file's tuning table quotes.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const HOUR = parseFloat(arg('hour', '20.4'));
const SECONDS = parseFloat(arg('seconds', '120'));
const SPIN = parseFloat(arg('spin', '2.0'));
const HEIGHTS = String(arg('heights', '0.10,0.24,0.50')).split(',').map(Number);
const OUT = arg('out', '');
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=900&car=camper`;

const release = await acquire('cookcurve');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
const rows = {};
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  await page.evaluate(() => { const e = window.__engine; if (e) { e.autoQuality = false; e.adaptive = false; e.resolutionScale = 1; } });
  await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, HOUR);
  const parkAt = await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); return { x: p.x, z: p.z };
  });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  await page.evaluate(({ at }) => { window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 }); }, { at: parkAt });

  for (const H of HEIGHTS) {
    const r = await page.evaluate(async ({ H, SECONDS, SPIN }) => {
      const R = window.__roast;
      R.enter();
      R.setOverlay(false);
      R.setT(1);
      R.setHeight(H);
      // Geometry of the pose, as the toast map sees it.
      const V = R.view;
      const THREE = window.__THREE ?? window.THREE;
      const mp = V.mallow.getWorldPosition(new THREE.Vector3());
      const fp = V._firePos(new THREE.Vector3());
      const hot = { x: fp.x, y: fp.y + 0.26, z: fp.z };
      const dx = mp.x - hot.x, dy = mp.y - hot.y, dz = mp.z - hot.z;
      const geo = {
        dist: Math.hypot(dx, dy, dz),
        above: dy,
        rho: Math.hypot(dx, dz),
        power: V._fire?.power ?? null,
      };
      const samples = [];
      const marks = {};
      const DT = 1 / 60;
      const N = Math.round(SECONDS / DT);
      let next = 0;
      // The map's own getters, NOT `state()`. `state()` recomputes the
      // clearance raycasts and renders the backdrop probe twice, so calling it
      // sixty times a second turns a two-minute roast into a twenty-minute
      // capture. `state()` is sampled at the print points, where it is cheap
      // enough and where its extra assertions are worth having.
      for (let i = 0; i <= N; i++) {
        const t = i * DT;
        const T = V.toast;
        const s = { doneness: T.doneness, evenness: T.evenness, peak: T.peak, ruined: T.ruined, burning: T.burning };
        if (t >= next - 1e-9) {
          samples.push({ t: +t.toFixed(2), d: s.doneness, e: s.evenness, p: s.peak, r: s.ruined, b: !!s.burning });
          next += 5;
        }
        if (marks.gold === undefined && s.doneness >= 0.55) marks.gold = t;
        if (marks.past === undefined && s.doneness > 0.80) marks.past = t;
        if (marks.eat === undefined && s.doneness >= 0.15) marks.eat = t;
        if (marks.black === undefined && s.peak >= 0.995) marks.black = t;
        if (marks.charred === undefined && s.ruined >= 0.16) marks.charred = t;
        if (marks.alight === undefined && s.burning) marks.alight = t;
        R.setSpinVel(SPIN);
        R.step(DT);
        // The height eases toward heightCmd; re-assert so a long run cannot
        // drift off the height it is supposed to be measuring.
        R.setHeight(H);
      }
      const g = R.state();
      return { geo, samples, marks, final: { d: g.doneness, e: g.evenness, p: g.peak, grade: g.result },
        clear: g.clear, distinct: g.distinct };
    }, { H, SECONDS, SPIN });
    rows[H] = r;
    console.log('\n' + '─'.repeat(84));
    console.log(`height ${H.toFixed(2)} m   spin ${SPIN} rad/s   ` +
      `dist ${r.geo.dist.toFixed(3)} m  above ${r.geo.above.toFixed(3)}  rho ${r.geo.rho.toFixed(3)}  power ${r.geo.power}`);
    console.log('─'.repeat(84));
    console.log('    t   doneness  evenness    peak   ruined  burn');
    for (const s of r.samples) {
      console.log(String(s.t.toFixed(0)).padStart(5) + '   ' +
        s.d.toFixed(3).padStart(7) + '   ' + s.e.toFixed(3).padStart(7) + '  ' +
        s.p.toFixed(3).padStart(6) + '  ' + s.r.toFixed(3).padStart(7) + '  ' + (s.b ? 'YES' : ' . '));
    }
    const m = r.marks;
    const fm = (v) => (v === undefined ? 'never' : v.toFixed(1) + ' s');
    console.log(`  eat-gate(.15) ${fm(m.eat)}   golden(.55) ${fm(m.gold)}   past(.80) ${fm(m.past)}   ` +
      `black texel ${fm(m.black)}   charred ${fm(m.charred)}   alight ${fm(m.alight)}`);
  }
} finally {
  await browser.close();
  release();
}
if (OUT) { mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true }); writeFileSync(OUT, JSON.stringify(rows, null, 2)); }

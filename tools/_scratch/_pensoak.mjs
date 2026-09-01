#!/usr/bin/env node
/**
 * The steering soak — does anything get stuck?
 *
 * `animal_brain.js` has frozen the cast twice, and both times the tell was the
 * same pair of numbers rather than anything visible in a screenshot: an animal
 * wanting to move and going nowhere (`_pinned`), and an animal not moving at
 * all for longer than any of its states legitimately stand still for. The
 * Habitat Pen reproduces it in minutes where the valley takes hours, because
 * its rock footprints are hard circles packed close together.
 *
 * Run this after ANY change to `_pickWander`, `_climb`, `_offRock`, `_steer` or
 * `_standable`. Healthy, from the last time this was chased down:
 *
 *   max _pinned        <= ~3 s
 *   longest still run  <= the species' own idle/perch times
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_pensoak.mjs [--seconds 400]
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '400'));
const BEHAVIOUR = arg('behaviour', 'roam');

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });

const out = await page.evaluate(async ({ SECONDS, BEHAVIOUR }) => {
  const g = window.__gallery;
  const built = await g.byId.get('animal:pen')
    .build(20261018, { species: 'all', herds: 3, behaviour: BEHAVIOUR });

  const DT = 1 / 30;
  const steps = Math.round(SECONDS / DT);
  const NM = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  const rec = new Map();

  for (let s = 0; s < steps; s++) {
    built.update(DT);
    for (const a of built._animals ?? []) {
      const b = a.brain;
      let r = rec.get(a);
      if (!r) rec.set(a, r = { key: a.key ?? b.key, pin: 0, still: 0, maxPin: 0, maxStill: 0, stillState: '' });
      if (b._pinned > r.maxPin) r.maxPin = b._pinned;
      if (b.speed < 0.02) {
        r.still += DT;
        if (r.still > r.maxStill) { r.maxStill = r.still; r.stillState = NM[b.state]; }
      } else r.still = 0;
    }
  }

  const by = {};
  for (const r of rec.values()) {
    const k = r.key || '?';
    const t = (by[k] ||= { n: 0, maxPin: 0, maxStill: 0, stillState: '' });
    t.n++;
    if (r.maxPin > t.maxPin) t.maxPin = r.maxPin;
    if (r.maxStill > t.maxStill) { t.maxStill = r.maxStill; t.stillState = r.stillState; }
  }
  return {
    seconds: SECONDS, behaviour: BEHAVIOUR, animals: rec.size,
    rows: Object.entries(by).map(([k, t]) => ({
      species: k, n: t.n,
      maxPinnedS: +t.maxPin.toFixed(1),
      longestStillS: +t.maxStill.toFixed(1),
      stillIn: t.stillState,
    })).sort((a, b) => b.maxPinnedS - a.maxPinnedS),
  };
}, { SECONDS, BEHAVIOUR });

console.log(JSON.stringify(out, null, 1));
const worstPin = Math.max(...out.rows.map((r) => r.maxPinnedS));
console.log(worstPin <= 3.5
  ? `\nPASS — worst _pinned ${worstPin}s, inside the ~3 s healthy band.`
  : `\nFAIL — worst _pinned ${worstPin}s. Something is wanting to move and going nowhere.`);
for (const l of logs) console.log(l);
await browser.close();

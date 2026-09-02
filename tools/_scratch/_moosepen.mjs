/** Habitat-pen soak for the moose: does the Brain drive the GlbRig cleanly? */
import { chromium } from 'playwright';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 900, height: 600 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/gallery.html`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__gallery?.byId?.size > 0, null, { timeout: 180000, polling: 300 });
const SPECIES = (process.argv[2] || 'moose').split(',');
for (const sp of SPECIES) for (const mode of ['roam', 'spook']) {
  console.log(sp, mode, JSON.stringify(await p.evaluate(async ({ mode, sp }) => {
    const built = await window.__gallery.byId.get('animal:pen')
      .build(20261018, { species: sp, herds: 3, behaviour: mode });
    const states = new Set(), gaits = new Set();
    let maxPin = 0, still = new Map(), maxStill = 0;
    for (let i = 0; i < 400 * 60; i++) {
      built.update(1 / 60);
      if (i % 15) continue;
      for (const a of built._animals ?? []) {
        maxPin = Math.max(maxPin, a.brain?._pinned ?? 0);
        states.add(a.brain?.state); gaits.add(a.rig?.gaitName);
        const k = a.brain;
        const moving = (k?.speed ?? 0) > 0.05;
        const t = moving ? 0 : (still.get(a) ?? 0) + 0.25;
        still.set(a, t); maxStill = Math.max(maxStill, t);
      }
    }
    return { n: built._animals?.length ?? 0, maxPinned: +maxPin.toFixed(2),
             maxStill: +maxStill.toFixed(1), states: [...states].sort(),
             gaits: [...gaits].sort() };
  }, { mode, sp })));
}
await b.close();

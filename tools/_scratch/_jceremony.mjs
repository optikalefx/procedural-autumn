#!/usr/bin/env node
/**
 * Film the journal's opening ceremony as a strip of stills.
 *
 * The clock is stepped by hand (`__runTo`) rather than left to real time, so
 * every frame in the strip lands on exactly the same beat every run — which is
 * the only way an A/B of a timing change means anything.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const dir = arg('dir', '/tmp/ceremony');
const award = arg('award', 'fox');
const times = (arg('t', '0.30,0.80,1.20,1.50,1.85,2.35,2.75,3.10,3.60')).split(',').map(Number);
const w = +arg('w', 1400), h = +arg('h', 880);

mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[error]', m.text()); });
await p.goto(`http://127.0.0.1:5199/tools/_scratch/_journal_lab.html?award=${award}`, { waitUntil: 'load' });
await p.waitForFunction('window.__ready', null, { timeout: 60_000 });

await p.evaluate(() => { window.__manual = true; window.__j.open({ award: { id: new URLSearchParams(location.search).get('award'), photoDataURL: window.__photo } }); });
let at = 0;
for (const t of times) {
  await p.evaluate(async (target) => {
    const j = window.__j;
    for (let i = 0; i < 6000 && j._t < target; i++) {
      j.update(1 / 60);
      // Let the microtask queue drain so `_armAward`'s promises can land.
      await Promise.resolve();
    }
  }, t);
  await p.waitForTimeout(120);              // one rAF, so the frame is drawn
  const name = `${dir}/t${String(t.toFixed(2)).replace('.', '_')}.png`;
  await p.screenshot({ path: name });
  console.log('wrote', name, 'at', await p.evaluate(() => window.__j._t.toFixed(2)));
  at = t;
}
console.log('cues:', await p.evaluate(() => (window.__cues || []).join(' ')));
await b.close();

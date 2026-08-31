import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('POSTHOG')) errs.push(m.text()); });
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });

// Write a target the way the store would, then reload and see if it survives.
await page.evaluate(() => localStorage.setItem('pa.hunt',
  JSON.stringify({ v: 1, items: {}, target: 'baldEagle' })));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });

const r1 = await page.evaluate(async () => {
  const j = window.__systems.hud.journal;
  j.open();
  for (let i = 0; i < 400; i++) await new Promise(r => requestAnimationFrame(r));
  const ringed = [];
  for (const p of j._pages) for (const row of p.spec.rows ?? []) if (row.target) ringed.push(row.id);
  return { ringed, persisted: JSON.parse(localStorage.getItem('pa.hunt')).target };
});
console.log('restored after reload:', JSON.stringify(r1));

// A target naming an already-ticked line must be dropped on load.
await page.evaluate(() => localStorage.setItem('pa.hunt',
  JSON.stringify({ v: 1, items: { bear: { at: 1, photo: null } }, target: 'bear' })));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });
console.log('stale target dropped:', JSON.stringify(await page.evaluate(async () => {
  const j = window.__systems.hud.journal;
  j.open();
  for (let i = 0; i < 400; i++) await new Promise(r => requestAnimationFrame(r));
  const ringed = [];
  for (const p of j._pages) for (const row of p.spec.rows ?? []) if (row.target) ringed.push(row.id);
  return { ringed, paw: !!window.__systems.wildlife.nearestHint(0, 0, null) };
})));

// And the ambient paw is untouched when nothing is targeted.
await page.evaluate(() => localStorage.removeItem('pa.hunt'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });
console.log('ambient still works:', JSON.stringify(await page.evaluate(() => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  window.__forceCamera = true; e.stop(); e.clock.getDelta = () => 1 / 30;
  const roads = W.roads ?? [];
  let found = 0, steps = 0;
  for (const road of roads.slice(0, 3)) {
    for (let i = 0; i < road.length - 1; i += 6) {
      const p = road[i];
      e.camera.position.set(p.x, W.getHeight(p.x, p.z) + 2.2, p.z);
      e._loop(); e._loop();
      steps++;
      if (wl.nearestHint(p.x, p.z, null)) found++;
    }
  }
  return { steps, pawShown: found };
})));
console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
await browser.close();

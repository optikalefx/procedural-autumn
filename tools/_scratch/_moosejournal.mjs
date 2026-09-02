/** The moose line in the real journal, and its gallery card. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = process.env.AUTUMN_URL || 'http://localhost:5178';
const OUT = 'shots/moosejournal';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });

const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`${BASE}/?seed=20261018&car=camper&quality=high`, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

const info = await p.evaluate(async () => {
  const S = window.__systems;
  const j = S.hud?.journal;
  j?.close();
  for (let i = 0; i < 200 && j?._visible; i++) j.update(0.05);
  const { HUNT_SHEET, ROWS = 4 } = await import('/src/game/hunt_items.js');
  const idx = HUNT_SHEET.findIndex((x) => x.id === 'moose');
  void ROWS;
  j.open();
  for (let i = 0; i < 400; i++) j.update(1 / 60);
  return { sheets: j._sheets, pages: j._pages?.length, mooseIndex: idx, sheetLen: HUNT_SHEET.length };
});
console.log('journal', JSON.stringify(info));
// The moose is row 6 of the sheet, so page 2 (0-based), leaf 1.
for (let leaf = 0; leaf <= 2; leaf++) {
  await p.evaluate(({ leaf }) => {
    const j = window.__systems.hud.journal;
    j._leafFrom = j._pose.leaf; j._leafTo = leaf; j._leafT = 0;
    for (let i = 0; i < 300; i++) j.update(1 / 60);
  }, { leaf });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/leaf_${leaf}.png` });
  console.log('  wrote', `${OUT}/leaf_${leaf}.png`);
}

const g = await b.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 1 });
g.on('pageerror', (e) => console.log('GALLERY ERR', e.message));
await g.goto(`${BASE}/gallery.html#animal%3Amoose%3A0`, { waitUntil: 'load', timeout: 180000 });
await g.waitForFunction(() => window.__gallery?.byId?.size > 0, null, { timeout: 180000, polling: 300 });
await g.waitForTimeout(2500);
// rAF does not run while the pane is hidden in an automated browser — render by hand.
await g.evaluate(() => {
  const st = window.__gallery?.stage;
  for (let i = 0; i < 30; i++) { st?.update?.(1 / 60); st?.renderer?.render?.(st.scene, st.camera); }
});
await g.waitForTimeout(600);
await g.screenshot({ path: `${OUT}/gallery_card.png` });
console.log('  wrote', `${OUT}/gallery_card.png`);
await b.close();

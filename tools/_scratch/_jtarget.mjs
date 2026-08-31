// Does clicking an empty photo slot in the journal set the hunt target, and
// does the compass paw follow it?
//
// TRAP, paid for once: the book keeps easing for ~20 frames after `_leafT`
// reaches 1, so a slot scanned immediately after the page turn has MOVED by the
// time the click lands. Settle on frames, scan, and click the CENTROID of the
// hit region rather than its first pixel.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/jtarget';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', String(e)));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('POSTHOG')) console.log('CONSOLE', m.text()); });
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });

const scan = await page.evaluate(async () => {
  localStorage.removeItem('pa.hunt');
  const j = window.__systems.hud.journal; window.__j = j;
  j.open();
  const s = j._seat.get('bear');
  for (let i = 0; i < 900; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const sp = Math.floor(j._pose.leaf + 1e-6);
    const facing = [2 * sp - 1, 2 * sp];
    if (facing.includes(s.page) && j._leafT >= 1 && j._seekQueue === 0) break;
    if (!facing.includes(s.page) && j._leafT >= 1 && j._seekQueue === 0) j.leaf(+1);
  }
  for (let i = 0; i < 45; i++) await new Promise(r => requestAnimationFrame(r));  // let it stop moving
  const acc = new Map();
  for (let y = 60; y < 880; y += 4) for (let x = 40; x < 1560; x += 4) {
    const r = j._rowAt(x, y);
    if (!r) continue;
    const id = j._pages[r.page].spec.rows[r.row].id;
    const k = `${id}:${r.kind}`;
    const a = acc.get(k) ?? { id, kind: r.kind, n: 0, sx: 0, sy: 0 };
    a.n++; a.sx += x; a.sy += y; acc.set(k, a);
  }
  return [...acc.values()].map(a => ({ id: a.id, kind: a.kind, n: a.n,
    x: Math.round(a.sx / a.n), y: Math.round(a.sy / a.n) }));
});
console.log('seats:', scan.map(s => `${s.id}/${s.kind}`).join(', '));
const hit = scan.find(s => s.id === 'bear' && s.kind === 'target');
console.log('bear slot centre:', hit.x, hit.y, `(${hit.n} px)`);

await page.screenshot({ path: `${OUT}/before.png` });
const click = async (shot) => {
  await page.mouse.move(hit.x, hit.y);
  await page.mouse.down(); await page.mouse.up();
  await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
  if (shot) await page.screenshot({ path: `${OUT}/${shot}` });   // toast still up
  console.log('  toast:', JSON.stringify(await page.evaluate(() => {
    const t = document.querySelector('.pa-toast');
    return { text: t?.textContent, shown: !!t?.classList.contains('pa-show') };
  })));
  await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
};
const state = () => page.evaluate(() => {
  const j = window.__j, s = j._seat.get('bear');
  const rows = [];
  for (const p of j._pages) for (const r of p.spec.rows ?? []) if (r.target) rows.push(r.id);
  return { persisted: JSON.parse(localStorage.getItem('pa.hunt') ?? '{}').target ?? null,
           ringedRows: rows,
           bearRow: { target: j._pages[s.page].spec.rows[s.row].target,
                      track: j._pages[s.page].spec.rows[s.row].track },
           zoom: j.zoomLevel, leaf: +j._pose.leaf.toFixed(2), cursor: j._cursor };
});

await click('toast_on.png');
console.log('after 1st click:', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/targeted.png` });
await click('toast_off.png');
console.log('after 2nd click:', JSON.stringify(await state()));
await page.screenshot({ path: `${OUT}/cleared.png` });
await browser.close();

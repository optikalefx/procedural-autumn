// Staged gallery captures of the great horned owl's two pose cards.
//
// A yaw sweep rather than a handful of named angles: an owl is judged from the
// front (the face is the whole animal), from the side (the folded wing and the
// tail are where this rig's failure modes live) and from behind.
//
//   node tools/_scratch/owlshots.mjs <outdir> [perched|glide] [port]
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/owl';
const POSE = process.argv[3] ?? 'perched';
const PORT = process.argv[4] ?? '5193';
const URL = `http://127.0.0.1:${PORT}/gallery.html`;

const YAWS = [0, 0.6, 1.2, 1.57, 2.2, 2.8, 3.14];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 2 });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

const found = await page.evaluate((p) => {
  const g = window.__gallery;
  const e = g.entries.find((x) => x.id.includes(`GreatHornedOwl:${p}`));
  if (!e) return null;
  g.select(e.id);
  return e.id;
}, POSE);
if (!found) { console.error(`no owl card for pose ${POSE}`); process.exit(1); }
console.log('card:', found);
await page.waitForTimeout(800);

for (const yaw of YAWS) {
  await page.evaluate(({ yaw: y, p }) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.yaw = y;
    st.pitch = p === 'perched' ? 0.05 : 0.24;
    st.dist = 2.2;
  }, { yaw, p: POSE });
  await page.waitForTimeout(320);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${POSE}-y${yaw.toFixed(2)}.png` });
  console.log(`${OUT}/${POSE}-y${yaw.toFixed(2)}.png`);
}
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 6), null, 1));
await browser.close();

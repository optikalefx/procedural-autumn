// Generic gallery yaw sweep for any tree-bird / water-bird card.
//
// The four birds share treeBirdMaterial's fold, so a change to it has to be
// judged on all four. owlshots.mjs is the owl-only original; this is the same
// sweep with the card id as an argument.
//
//   node tools/_scratch/_birdshots.mjs <outdir> <card-substring> [port] [pitch] [dist]
//
// dist defaults to `auto` — the stage's own fit, which frames each bird whole.
// owlshots.mjs pins 2.2, which is right for a 2.8 m owl and crops a heron.
//
// card-substring is matched against gallery entry ids, e.g.
//   GreatHornedOwl:perched   BaldEagle:glide   BlueHeron   Flamingo
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/bird';
const CARD = process.argv[3] ?? 'GreatHornedOwl:perched';
const PORT = process.argv[4] ?? '5193';
const PITCH = parseFloat(process.argv[5] ?? '0.10');
const DIST = process.argv[6] ?? 'auto';
const URL = `http://127.0.0.1:${PORT}/gallery.html`;

const YAWS = [0, 0.6, 1.2, 1.57, 2.2, 2.8, 3.14];
const TAG = CARD.replace(/[^A-Za-z0-9]+/g, '_');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

const found = await page.evaluate((c) => {
  const g = window.__gallery;
  const e = g.entries.find((x) => x.id.includes(c));
  if (!e) return null;
  g.select(e.id);
  return e.id;
}, CARD);
if (!found) { console.error(`no card matching ${CARD}`); process.exit(1); }
console.log('card:', found);
await page.waitForTimeout(800);

for (const yaw of YAWS) {
  await page.evaluate(({ yaw: y, p, d }) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.yaw = y;
    st.pitch = p;
    if (d !== 'auto') st.dist = parseFloat(d);
  }, { yaw, p: PITCH, d: DIST });
  await page.waitForTimeout(320);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${TAG}-y${yaw.toFixed(2)}.png` });
}
console.log(`${OUT}/${TAG}-y*.png`);
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 4)));
await browser.close();

// Close-in gallery stills of one card at named (yaw, pitch, dist) triples.
// owlshots.mjs pins dist 2.2 for the whole sweep, which frames the whole bird
// and leaves the head about 200 px tall — fine for silhouette, useless for
// deciding whether a facet or a seam is real.
//
//   node tools/_scratch/_owlzoom.mjs <outdir> <card-substring> [port]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/owlzoom';
const CARD = process.argv[3] ?? 'GreatHornedOwl:perched';
const PORT = process.argv[4] ?? '5193';
const URL = `http://127.0.0.1:${PORT}/gallery.html`;

const VIEWS = [
  ['side-head', 1.57, 0.10, 1.1, 0.10],
  ['side-full', 1.57, 0.05, 1.9, -0.02],
  ['back-hi', 2.20, 0.45, 1.7, 0.00],
  ['back-flat', 3.14, 0.10, 1.7, 0.00],
  ['three-q', 0.60, 0.10, 1.4, 0.06],
];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 820 }, deviceScaleFactor: 2 });
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

for (const [name, yaw, pitch, dist, ty] of VIEWS) {
  await page.evaluate((v) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.yaw = v.yaw; st.pitch = v.pitch; st.dist = v.dist;
    st.target.y += v.ty;
  }, { yaw, pitch, dist, ty });
  await page.waitForTimeout(300);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${name}.png` });
  await page.evaluate((v) => { window.__gallery.stage.target.y -= v; }, ty);
}
console.log(`${OUT}/*.png`);
await browser.close();

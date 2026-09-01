// Staged gallery captures of the four wader pose cards.
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/waders';
const URL = 'http://127.0.0.1:5199/gallery.html';

const SHOTS = [
  { q: 'buildBlueHeron:flight', name: 'heron-flight', yaw: 2.15, pitch: 0.32, dist: 2.9 },
  { q: 'buildBlueHeron:wading', name: 'heron-wading', yaw: 2.2, pitch: 0.10, dist: 2.5 },
  // One row, not two: the flamingo is a GLB card whose pose is a control on
  // the stage rather than a suffix on its id.
  { q: 'bird:flamingo', name: 'flamingo-wading', yaw: 2.2, pitch: 0.10, dist: 2.2 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(URL);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

for (const s of SHOTS) {
  const ok = await page.evaluate((sh) => {
    const g = window.__gallery;
    const e = g.entries.find((x) => x.id.includes(sh.q));
    if (!e) return false;
    g.select(e.id);
    return true;
  }, s);
  if (!ok) { console.error(`no entry for ${s.q}`); continue; }
  // let the build land, then freeze the framing
  await page.waitForTimeout(600);
  await page.evaluate((sh) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.yaw = sh.yaw; st.pitch = sh.pitch; st.dist = sh.dist;
  }, s);
  await page.waitForTimeout(400);
  const canvas = page.locator('#stagecap');
  await canvas.screenshot({ path: `${OUT}/${s.name}.png` });
  console.log(`${OUT}/${s.name}.png`);
}
await browser.close();

// Tight head-join captures — the neck/skull joint at walk-up distance.
//
// Heron only. The flamingo's three shots were removed with the lofted model:
// their camera targets were written from that mesh's own footY and neck
// stations, and there is nothing to re-aim them at — the flamingo is a GLB now
// and its head-join is the pack's, not ours to judge station by station.
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/waders';
const URL = 'http://127.0.0.1:5199/gallery.html';

const SHOTS = [
  {
    id: 'prop:blue_heron.js:buildBlueHeron:wading', name: 'heron-head-wading',
    target: [0, 0.271 * 1.9 + 0.30 * 1.9, 0.16 * 1.9], yaw: 1.55, pitch: 0.05, dist: 0.42,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await page.goto(URL);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

for (const s of SHOTS) {
  await page.evaluate((sh) => window.__gallery.select(sh.id), s);
  await page.waitForTimeout(600);
  await page.evaluate((sh) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.target.set(...sh.target);
    st.yaw = sh.yaw; st.pitch = sh.pitch; st.dist = sh.dist;
  }, s);
  await page.waitForTimeout(350);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${s.name}.png` });
  console.log(`${OUT}/${s.name}.png`);
}
await browser.close();

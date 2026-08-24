// Tight head-join captures — the neck/skull joint at walk-up distance.
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/waders';
const URL = 'http://127.0.0.1:5199/gallery.html';

const SHOTS = [
  {
    id: 'prop:water_birds.js:buildFlamingo:wading', name: 'flamingo-head-wading',
    target: [0, 0.436 * 1.45 + 0.39 * 1.45, 0.13 * 1.45], yaw: 1.55, pitch: 0.05, dist: 0.34,
  },
  {
    id: 'prop:water_birds.js:buildFlamingo:wading', name: 'flamingo-head-rear',
    target: [0, 0.436 * 1.45 + 0.39 * 1.45, 0.13 * 1.45], yaw: 4.9, pitch: 0.30, dist: 0.34,
  },
  {
    id: 'prop:water_birds.js:buildFlamingo:flight', name: 'flamingo-head-flight',
    target: [0, 1.3 + 0.16 * 1.45, 0.40 * 1.45], yaw: 1.55, pitch: 0.05, dist: 0.40,
  },
  {
    id: 'prop:water_birds.js:buildBlueHeron:wading', name: 'heron-head-wading',
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

// Scratch: does swapping cars leak, and does the drop actually bounce?
//
//   node tools/_scratch/carswap.mjs        (AUTUMN_URL to point it at your port)
//
// Cycles every car in CARS twice. `geos` has to come back to the same number
// for a given car every time round — a model whose geometry is not freed shows
// up here as a staircase.
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?res=768&car=camper';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__vehicle, null, { timeout: 30000 });
await page.evaluate(() => { const p = window.__poi.best('meadow') ?? {x:0,z:0}; window.__vehicleTeleport(p.x,p.z,p.yaw ?? 0.9); });
await page.waitForTimeout(4000);   // let the world finish streaming in

const mem = () => page.evaluate(() => ({
  geos: window.__engine.renderer.info.memory.geometries,
  tex: window.__engine.renderer.info.memory.textures,
  car: window.__carId(),
}));
console.log('settled ', JSON.stringify(await mem()));
const ids = await page.evaluate(() => window.__vehicle.constructor
  && Array.from(document.querySelectorAll('.pa-group')).length ? null : null)
  ?? ['roamer', 'adventurer', 'camper', 'roamer', 'adventurer', 'camper'];
for (let i = 0; i < ids.length; i++) {
  await page.evaluate((c) => window.__setCar(c), ids[i]);
  await page.waitForTimeout(1600);
  console.log(`swap ${i} -> ${ids[i]}`, JSON.stringify(await mem()));
}
console.log('errors:', JSON.stringify(errs.slice(0,8)));
await browser.close();

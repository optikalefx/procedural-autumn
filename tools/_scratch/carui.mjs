// Scratch: drive the car switch from the settings sheet and film the landing.
//
//   node tools/_scratch/carui.mjs /tmp/carui [buttonIndex]
//
// Opens Settings the way a player does (Esc), clicks the second Vehicle button,
// and shoots six frames across the drop plus one after it settles. Exists
// because the swap has two halves that can each work alone: the sheet wiring
// and the drop itself.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?res=768&car=camper';
const DIR = process.argv[2] || '/tmp/carui';
mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.waitForFunction(() => !!window.__vehicle, null, { timeout: 30000 });
await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? {x:0,z:0};
  window.__vehicleTeleport(p.x,p.z,p.yaw ?? 0.9);
  window.__lighting.hour = 16.2; window.__lighting.cycleSpeed = 0;
});
await page.waitForTimeout(2500);

// open settings the way a player does
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: `${DIR}/settings.png` });

const seg = page.locator('.pa-group', { hasText: 'Vehicle' }).locator('button');
console.log('vehicle buttons:', await seg.allTextContents());
await seg.nth(Number(process.argv[3] ?? 1)).click();
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(i === 0 ? 60 : 130);
  await page.screenshot({ path: `${DIR}/drop${i}.png` });
}
await page.waitForTimeout(1400);
await page.screenshot({ path: `${DIR}/landed.png` });
console.log('car now:', await page.evaluate(() => window.__carId()));
console.log('errors:', JSON.stringify(errs.slice(0,6)));
await browser.close();

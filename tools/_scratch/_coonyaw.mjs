// Scratch: yaw sweep of one gallery animal card, one PNG per angle.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? '/tmp/coonyaw';
const PORT = process.argv[3] ?? '5210';
const POSE = process.argv[4] ?? 'stand';
mkdirSync(OUT, { recursive: true });
const YAWS = [0, 0.5, 1.0, 1.57, 2.4, 3.14];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });
await page.evaluate(() => window.__gallery.select('animal:raccoon:0'));
await page.waitForTimeout(600);
await page.evaluate((p) => { window.__gallery.setPose?.(p) ?? (window.__gallery.pose = p); }, POSE);
await page.waitForTimeout(500);
for (const yaw of YAWS) {
  await page.evaluate((y) => { const st = window.__gallery.stage; st.turntable = false; st.yaw = y; st.pitch = 0.12; st.dist = 1.5; }, yaw);
  await page.waitForTimeout(320);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/y${yaw.toFixed(2)}.png` });
  console.log(`${OUT}/y${yaw.toFixed(2)}.png`);
}
await browser.close();

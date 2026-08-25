// The waders at their new size next to the gallery's 1.70 m figure, which is
// the only honest way to judge "3x larger".
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/waders';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:5199/gallery.html');
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

// Turn the human figure on — it is a checkbox in the stage's control bar.
await page.evaluate(() => {
  for (const el of document.querySelectorAll('input[type=checkbox]')) {
    const t = el.closest('label')?.textContent ?? '';
    if (/figure/i.test(t) && !el.checked) el.click();
  }
});

for (const [id, name, dist] of [
  ['prop:water_birds.js:buildBlueHeron:wading', 'scale-heron', 13],
  ['prop:water_birds.js:buildFlamingo:wading', 'scale-flamingo', 13],
  ['prop:tree_birds.js:buildBaldEagle:perched', 'scale-eagle', 15],
]) {
  await page.evaluate((i) => window.__gallery.select(i), id);
  await page.waitForTimeout(700);
  await page.evaluate((d) => {
    const s = window.__gallery.stage;
    s.turntable = false;
    s.target.set(0, 2.0, 0);
    s.yaw = 2.15; s.pitch = 0.06; s.dist = d;
  }, dist);
  await page.waitForTimeout(400);
  // The stage's own info panel reports size and height — measured, not asserted.
  const dims = await page.evaluate(() => {
    const t = document.body.innerText;
    const size = t.match(/size\s+([\d.]+ × [\d.]+ × [\d.]+ m)/);
    const height = t.match(/height\s+([\d.]+ m)/);
    return { size: size?.[1], height: height?.[1] };
  });
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${name}: size ${dims.size}, height ${dims.height} -> ${OUT}/${name}.png`);
}
await browser.close();

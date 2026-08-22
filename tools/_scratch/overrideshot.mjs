// Does fx.flatShade really keep every fragment? overrideMaterial replaces the
// VERTEX shader too, and grass/cover/trees build their geometry there.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

await acquire('ablate', { exclusive: true });
const OUT = 'shots/override';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', String(e.message).slice(0,200)));
await page.goto('http://127.0.0.1:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await page.evaluate(() => {
  const a = window.__cameraAnchors.meadow ?? window.__cameraAnchors;
  window.__engine.adaptive = false; window.__engine.autoQuality = false;
});
await page.evaluate(() => window.__settleStable(1500, 30));

const modes = {
  baseline: () => { window.__engine.scene.overrideMaterial = null; },
  basic:    () => { const T = window.__THREE; window.__engine.scene.overrideMaterial = new T.MeshBasicMaterial({ color: 0x808080 }); },
  lambert:  () => { const T = window.__THREE; window.__engine.scene.overrideMaterial = new T.MeshLambertMaterial({ color: 0x808080 }); },
  standard: () => { const T = window.__THREE; window.__engine.scene.overrideMaterial = new T.MeshStandardMaterial({ color: 0x808080, roughness: 0.9, metalness: 0 }); },
};
for (const name of Object.keys(modes)) {
  await page.evaluate(`(${modes[name].toString()})()`);
  await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const info = await page.evaluate(() => ({ calls: window.__engine.renderer.info.render.calls, tris: window.__engine.renderer.info.render.triangles }));
  console.log(name, JSON.stringify(info));
}
await browser.close();

import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0,300)));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0,300)); });
await page.goto('http://127.0.0.1:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await page.evaluate(() => window.__settleStable(1500, 30));

const before = await page.evaluate(() => {
  const st = window.__stylize;
  st.harvest();
  const mats = [...st._materials];
  return {
    total: mats.length,
    std: mats.filter(m => m.isMeshStandardMaterial).length,
    eligible: mats.filter(m => !window.__stylize.constructor.wantsPhysicalSpecular(m)).length,
    kept: mats.filter(m => m.isMeshStandardMaterial && window.__stylize.constructor.wantsPhysicalSpecular(m))
              .map(m => `${m.name||'?'} metal=${m.metalness} env=${!!m.envMap}`).slice(0, 20),
  };
});
console.log('registry', JSON.stringify(before, null, 2));

const n = await page.evaluate(() => window.__stylize.setMatteSpecular(true));
console.log('materials flipped:', n);
await page.evaluate(() => new Promise(r => setTimeout(r, 4000)));
await page.evaluate(() => window.__settleStable(600, 20));

const after = await page.evaluate(() => {
  const st = window.__stylize;
  const mats = [...st._materials].filter(m => m.defines && m.defines.STYLIZE_MATTE !== undefined);
  const withShader = mats.filter(m => m.userData?.shader);
  const src = withShader[0]?.userData?.shader?.fragmentShader || '';
  return {
    defined: mats.length,
    sample: withShader[0]?.type,
    hasIfdef: /#ifdef STYLIZE_MATTE/.test(src),
    programs: window.__engine.renderer.info.programs?.length,
  };
});
console.log('after', JSON.stringify(after, null, 2));
console.log('errors:', errs.length ? errs.slice(0,10) : 'none');
await browser.close();

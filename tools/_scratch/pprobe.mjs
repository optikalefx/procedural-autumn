import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('NAV', f.url()); });
page.on('pageerror', e => console.log('PAGEERROR', String(e.stack||e.message).slice(0,800)));
page.on('console', m => { console.log('C:'+m.type(), m.text().slice(0,300)); });
await page.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
console.log('ready');
await page.waitForTimeout(3000);
for (let i=0;i<12;i++){
  await page.waitForTimeout(2000);
  const v = await page.evaluate(() => {
    const r = window.__engine.renderer;
    return { fps: window.__fps, geo: r.info.memory.geometries, tex: r.info.memory.textures,
      prog: r.info.programs?.length, calls: r.info.render.calls, tris: +(r.info.render.triangles/1e6).toFixed(2),
      objs: (()=>{let n=0;window.__engine.scene.traverse(()=>n++);return n;})() };
  });
  console.log(i, JSON.stringify(v));
}
await browser.close();

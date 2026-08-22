// Scratch: the lowest point any waterfall geometry occupies, and the lowest
// burst/mist instance origin. A fall whose plunge point carries the water
// grid's -9999 sentinel drags all three to -9998 and below.
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?seed=20261018';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const out = await page.evaluate(() => {
  const s = window.__engine.scene;
  const minAttrY = (name) => {
    const o = s.getObjectByName(name);
    if (!o) return null;
    const a = o.geometry.attributes.position ?? null;
    let m = Infinity;
    if (a) for (let i = 1; i < a.array.length; i += 3) m = Math.min(m, a.array[i]);
    return Number.isFinite(m) ? +m.toFixed(1) : null;
  };
  const minInst = (name, attr) => {
    const o = s.getObjectByName(name);
    const a = o?.geometry?.attributes?.[attr];
    if (!a) return null;
    let m = Infinity;
    for (let i = 1; i < a.array.length; i += 3) m = Math.min(m, a.array[i]);
    return +m.toFixed(1);
  };
  const sys = window.__systems.waterfalls;
  let pathMin = Infinity, nBad = 0;
  for (const f of sys.falls) for (const p of f.pts) {
    pathMin = Math.min(pathMin, p.y);
    if (p.y < -100) nBad++;
  }
  // The audio emitter, a third of the way up each drop.
  let audMin = Infinity;
  for (const wf of window.__world.waterfalls) audMin = Math.min(audMin, wf.bottom[1] + (wf.top[1] - wf.bottom[1]) * 0.33);
  return {
    sheetMinY: minAttrY('WaterfallSheets'),
    burstMinOriginY: minInst('WaterfallBurst', 'aOrigin'),
    mistMinCentreY: minInst('WaterfallMist', 'aCentre'),
    poolMinY: minAttrY('PlungePools'),
    pathMinY: +pathMin.toFixed(1),
    pathPointsBelow100m: nBad,
    audioEmitterMinY: +audMin.toFixed(1),
    worldMinHeight: +window.__world.minHeight.toFixed(1),
  };
});
console.log(JSON.stringify(out));
await browser.close();

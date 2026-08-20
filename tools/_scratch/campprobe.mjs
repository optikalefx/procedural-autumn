#!/usr/bin/env node
// Why is the grass still standing inside the camp clearing?
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('ERR', m.text()); });
await page.goto('http://localhost:5178?res=768', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { const p = window.__poi.best('meadow') ?? {x:0,z:0}; window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9); });
await page.waitForTimeout(1600);
const r = await page.evaluate(() => {
  const v = window.__systems.vehicle;
  const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
  const grass = window.__systems.grass;
  const gu = grass?.uniforms;
  const mats = [];
  window.__engine.scene.traverse((o) => {
    if (o.material && !Array.isArray(o.material) && (o.material.userData?.uniforms?.uCampSite || /grass/i.test(o.material.name||o.name||''))) {
      const u = o.material.userData?.shader?.uniforms;
      mats.push({ name: o.name, hasU: !!u?.uCampSite, val: u?.uCampSite?.value?.toArray?.() ?? null,
                  inSrc: !!o.material.userData?.shader?.vertexShader?.includes('campCover'), visible: o.visible, count: o.count ?? null });
    }
  });
  return {
    site: s,
    sharedVal: gu?.uCampSite?.value?.toArray?.() ?? 'MISSING',
    sameRef: gu?.uCampSite === undefined ? 'no-uniforms' : 'ok',
    grassMeshes: mats.slice(0, 4),
    coverU: window.__systems.groundCover?.uniforms?.uCampSite?.value?.toArray?.() ?? 'MISSING',
  };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();

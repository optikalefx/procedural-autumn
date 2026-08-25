#!/usr/bin/env node
// dogbedstat — why are beds failing? sample the real pick loop's numbers.
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://127.0.0.1:5299/?res=640&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.evaluate(() => { window.__forceCamera = true; });
const out = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle;
  let camp = null;
  for (let attempt = 0; attempt < 8 && !camp?.dog; attempt++) {
    const c = C.pitchAt(V.position.x + 20 + attempt * 30, V.position.z + 10, { instant: true });
    if (!c) continue;
    for (let i = 0; i < 240 && !(c.hasDog && c.dog); i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!c.hasDog) break;
    }
    if (c.dog) camp = c;
  }
  if (!camp) return { err: 'no dog' };
  const dog = camp.dog;
  // Sample rest-ring ground stats through the dog's own plane fitter.
  const slopes = [], reliefs = [];
  for (let k = 0; k < 200; k++) {
    const a = k / 200 * Math.PI * 2, r = 1.7 + (k % 6) * 0.22;
    const x = camp.x + Math.sin(a) * r, z = camp.z + Math.cos(a) * r;
    const g = dog._surfaceAt(x, z, a);
    slopes.push(g.slope); reliefs.push(g.relief);
  }
  slopes.sort((p, q) => p - q); reliefs.sort((p, q) => p - q);
  const pick = dog._pickRestSpot();
  return {
    slope: { p50: +slopes[100].toFixed(3), p90: +slopes[180].toFixed(3) },
    relief: { p50: +reliefs[100].toFixed(3), p90: +reliefs[180].toFixed(3), min: +reliefs[0].toFixed(3) },
    pickWorks: !!pick,
  };
});
console.log(JSON.stringify(out));
await browser.close();

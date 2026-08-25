#!/usr/bin/env node
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
await page.goto('http://127.0.0.1:5299/?res=640&seed=20261018', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
const out = await page.evaluate(async () => {
  const C = window.__camp, V = window.__vehicle, W = window.__world;
  const c = C.pitchAt(V.position.x + 20, V.position.z + 10, { instant: true });
  for (let i = 0; i < 60; i++) await new Promise((r) => requestAnimationFrame(r));
  const g = c.ground;
  const rows = [];
  for (let i = 0; i <= 20; i++) {
    const x = c.x + 1.7 + i * 0.05, z = c.z;
    rows.push({
      dx: +(x - c.x).toFixed(2),
      field: +W.getHeight(x, z).toFixed(3),
      lat: +g._surfaceY(x, z).toFixed(3),
      surf: +g.surfaceAt(x, z).toFixed(3),
    });
  }
  return { campY: +c.y.toFixed(2), rows };
});
console.log(JSON.stringify(out.campY), out.rows.map(r => `${r.dx}: field ${r.field} lat ${r.lat} surf ${r.surf}`).join('\n'));
await browser.close();

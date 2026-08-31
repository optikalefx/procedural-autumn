#!/usr/bin/env node
/**
 * How tall is the deer the valley actually has, before it is replaced?
 *
 * `glb.height` scales a model by its whole bounding box, so replacing an animal
 * "at the same size" means matching the box, not the withers. Measured off a
 * live spawn rather than read off the blueprint, because the blueprint's numbers
 * are joint positions and the mesh is what the player sees.
 */
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5212') + '?seed=20261018&car=camper&quality=high';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text().slice(0, 200)); });
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 240000 });
await page.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));
const out = await page.evaluate(() => {
  const S = window.__systems; S.hud?.journal?.close();
  const w = S.wildlife;
  const r = { species: [], notes: [] };
  for (const key of ['deer', 'bear', 'fox']) {
    const sp = w.SPECIES?.[key] ?? window.__SPECIES?.[key];
    const rows = [];
    // Every prototype the pool built, per variant.
    const protos = w.protos?.[key] || w._protos?.[key] || [];
    for (const p of protos) {
      const g = p.geoms?.[0];
      const bb = g?.boundingBox;
      rows.push({
        variant: p.variant?.name, scale: p.scale, size: p.size,
        boxH: bb ? +(bb.max.y - bb.min.y).toFixed(3) : null,
        height: p.height ?? null,
      });
    }
    r.species.push({ key, glb: !!sp?.glb, variants: rows });
  }
  return r;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();

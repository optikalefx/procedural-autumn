#!/usr/bin/env node
/**
 * How tall is the procedural goat the valley has today, before it is replaced?
 *
 * `glb.height` scales a model by its whole bounding box, so replacing an animal
 * "at the same size" means matching the box — and matching the WITHERS is what
 * makes it land in the same place in the frame. Both are measured off the built
 * geometry rather than read off the blueprint, because the blueprint's numbers
 * are joint positions and the mesh is what the player sees.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatheight.mjs
 */
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('console', (m) => { if (m.type() === 'error') console.error('  [page]', m.text().slice(0, 300)); });
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });
const out = await page.evaluate(async () => {
  const mod = await import('/src/wildlife/animal_species.js');
  const rig = await import('/src/wildlife/animal_rig.js');
  const rows = [];
  for (const key of ['goat', 'deer']) {
    const sp = mod.SPECIES[key];
    if (sp.glb) { rows.push({ key, glb: true }); continue; }
    const protos = mod.buildSpecies(key, 20261018);
    sp.variants.forEach((v, i) => {
      const p = protos[i];
      const hide = mod.createHideMaterial(v.col);
      const inst = rig.instantiate(p, hide, 0);
      inst.mesh.updateMatrixWorld(true);
      const g = p.geoms?.[0];
      g?.computeBoundingBox?.();
      const bb = g?.boundingBox;
      rows.push({
        key, variant: v.name, scale: v.scale,
        // proto geometry box is in model units before the per-variant scale
        boxH: bb ? +(bb.max.y - bb.min.y).toFixed(4) : null,
        boxHScaled: bb ? +((bb.max.y - bb.min.y) * (v.scale ?? 1)).toFixed(4) : null,
        tris: p.tris,
      });
      hide.dispose();
    });
  }
  return rows;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();

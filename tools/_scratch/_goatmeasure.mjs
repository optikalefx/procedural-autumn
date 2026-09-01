#!/usr/bin/env node
/**
 * Read the goat GLB's clips the way `glb_rig.loadGlbSpecies` does, at rate 1,
 * so the cadences in `mammals/goat.js` can be chosen against real numbers
 * instead of being guessed and then discovered in the game.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatmeasure.mjs
 */
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('console', (m) => console.log(`  [page:${m.type()}]`, m.text().slice(0, 400)));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });
const out = await page.evaluate(async () => {
  const { loadGlbSpecies } = await import('/src/wildlife/glb_rig.js');
  const rows = {};
  for (const mode of ['contact', 'excursion']) {
    const sp = {
      variants: [{ name: 'x', scale: 1 }],
      gait: {},
      glb: {
        url: '/models/goat_pack.glb',
        height: 1.306,
        feet: ['toeL', 'toeR', 'front_toeL', 'front_toeR'],
        measure: mode,
        clips: {
          stand: { name: 'idle' },
          walk: { name: 'walk', rate: 1.0 },
          trot: { name: 'trot', rate: 1.0 },
          run: { name: 'run', rate: 1.0 },
          graze: { name: 'graze' },
          alert: { name: 'alert' },
        },
      },
    };
    try {
      const protos = await loadGlbSpecies('goat', sp, false);
      rows[mode] = {
        gait: sp.gait, stride: protos[0].stride, fit: protos[0].scale,
        modelBox: +(1.306 / protos[0].scale).toFixed(4),
        clips: Object.fromEntries(Object.entries(protos[0].clips)
          .map(([k, c]) => [k, +c.duration.toFixed(4)])),
        bones: (() => { const b = []; protos[0].scene.traverse((o) => { if (o.isBone && /toe/i.test(o.name)) b.push(o.name); }); return b; })(),
      };
    } catch (e) { rows[mode] = { error: String(e.message || e) }; }
  }
  return rows;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();

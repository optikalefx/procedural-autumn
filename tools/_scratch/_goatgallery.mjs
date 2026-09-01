#!/usr/bin/env node
/**
 * The gallery card itself: drive the real page, select the goat entries and the
 * Habitat Pen, and screenshot. `requestAnimationFrame` is not something to rely
 * on in an automated tab, so the built object is stepped and `stage.update` is
 * called by hand — otherwise the turntable and the pen sim sit frozen and the
 * card looks broken when it is not.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatgallery.mjs shots/goatlook
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const OUT = process.argv[2] || 'shots/goatlook';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });

const ids = await page.evaluate(() => [...window.__gallery.byId.keys()].filter((k) => k.includes('goat')));
console.log('goat entries:', ids);

const jobs = [
  ['animal:goat:0', { pose: 'stand' }, 'nanny_stand'],
  ['animal:goat:0', { pose: 'trot' }, 'nanny_trot'],
  ['animal:goat:0', { pose: 'graze' }, 'nanny_graze'],
  ['animal:goat:3', { pose: 'stand' }, 'smoke_stand'],
  ['animal:pen', { species: 'goat', herds: 3, behaviour: 'climb' }, 'pen_climb'],
];

const notes = {};
for (const [id, opts, name] of jobs) {
  const info = await page.evaluate(async ({ id, opts, steps }) => {
    const g = window.__gallery;
    g.state.set(id, { seed: 20261018, opts });
    await g.select(id);
    const built = await g.acquire(id);
    for (let i = 0; i < steps; i++) {
      built.update?.(1 / 60, g.stage.camera);
      if (i % 10 === 0) g.stage.update(1 / 60);
    }
    g.stage.update(1 / 60);
    return { notes: built.notes ?? [], tris: built.stats?.tris, meshes: built.stats?.meshes,
      materials: built.stats?.materials,
      size: built.stats?.size && [+built.stats.size.x.toFixed(2), +built.stats.size.y.toFixed(2), +built.stats.size.z.toFixed(2)] };
  }, { id, opts, steps: id === 'animal:pen' ? 3600 : 180 });
  notes[name] = info;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/gallery_${name}.png` });
  console.log('wrote', `${OUT}/gallery_${name}.png`);
}
console.log(JSON.stringify(notes, null, 2));
console.log('--- console ---');
for (const l of logs) console.log(l);
await browser.close();

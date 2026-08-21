#!/usr/bin/env node
/**
 * Drive gallery.html headless: build every object, report anything that fails,
 * and write a contact sheet. This is the gallery's own smoke test — 123 builders
 * called for real, in a browser, with the real materials.
 *
 *   node tools/_scratch/galcheck.mjs
 *   node tools/_scratch/galcheck.mjs --shot shots/gallery.png --pick tree:oak:0
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', 'http://127.0.0.1:5178/gallery.html');
const SHOT = arg('shot', null);
const PICK = arg('pick', null);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
// deviceScaleFactor 2, deliberately. The thumbnail path mixes CSS and device
// pixels and a dpr-1 harness cannot see the difference — see docs/STATE.md on
// the last time a capture ran at a pixel ratio the player does not have.
const DPR = parseInt(arg('dpr', '2'), 10);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: DPR });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__gallery, null, { timeout: 60000 });

const head = await page.evaluate(() => ({
  entries: window.__gallery.entries.length,
  notShown: window.__gallery.notShown.filter((n) => !n.soft).length,
}));
console.log(`discovered ${head.entries} objects, ${head.notShown} hard "not shown"`);

const t0 = Date.now();
await page.waitForFunction(() => window.__gallery.thumbs.remaining === 0, null, { timeout: 300000 });
console.log(`all thumbnails built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Every object, measured. A zero-triangle or zero-height object is a builder
// that ran without producing anything, which a thumbnail alone would not show.
const report = await page.evaluate(async () => {
  const g = window.__gallery;
  const rows = [];
  for (const e of g.entries) {
    try {
      const b = await g.acquire(e.id);
      rows.push({ id: e.id, tris: b.stats.tris, h: +b.stats.size.y.toFixed(3), ok: b.stats.tris > 0 });
    } catch (err) {
      rows.push({ id: e.id, err: String(err.message) });
    }
  }
  return rows;
});

const failed = report.filter((r) => r.err);
const empty = report.filter((r) => !r.err && !r.ok);
const tiny = report.filter((r) => !r.err && r.ok && r.h < 0.01);

console.log(`built ${report.length - failed.length}/${report.length}`);
console.log(`total triangles ${report.reduce((n, r) => n + (r.tris ?? 0), 0).toLocaleString()}`);
for (const r of failed) console.log(`  FAIL  ${r.id}  ${r.err}`);
for (const r of empty) console.log(`  EMPTY ${r.id}  built with 0 triangles`);
for (const r of tiny) console.log(`  FLAT  ${r.id}  ${r.h} m tall`);
if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 12)) console.log(`  ${e}`);
}

if (PICK) {
  await page.evaluate((id) => window.__gallery.select(id), PICK);
  await page.waitForTimeout(1200);
}
if (SHOT) {
  mkdirSync(dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });
  console.log(`wrote ${SHOT}`);
}

await browser.close();
process.exit(failed.length || empty.length ? 1 : 0);

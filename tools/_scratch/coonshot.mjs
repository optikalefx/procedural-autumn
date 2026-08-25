#!/usr/bin/env node
/**
 * Scratch: shoot one gallery animal in every pose, one PNG per pose.
 *   node tools/_scratch/coonshot.mjs --url http://127.0.0.1:5196/gallery.html \
 *        --id animal:raccoon:0 --out /tmp/coon
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = arg('url', 'http://127.0.0.1:5196/gallery.html');
const ID = arg('id', 'animal:raccoon:0');
const OUT = arg('out', '/tmp/coon');
const POSES = (arg('poses', 'stand,graze,alert,walk,trot,run')).split(',');

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__gallery, null, { timeout: 60000 });

for (const pose of POSES) {
  await page.evaluate(async ([id, p]) => {
    const g = window.__gallery;
    const s = g.state.get(id) ?? { seed: 0, opts: {} };
    s.opts = { ...s.opts, pose: p };
    g.state.set(id, s);
    await g.select(id);
  }, [ID, pose]);
  await page.waitForTimeout(1400);
  const stage = await page.$('#stage') ?? page;
  const file = `${OUT}/${ID.replace(/:/g, '_')}_${pose}.png`;
  await stage.screenshot({ path: file });
  console.log(`wrote ${file}`);
}

const notes = await page.evaluate(() => [...document.querySelectorAll('#stats *')].map((n) => n.textContent).join(' | '));
console.log('stats:', notes.slice(0, 400));
if (errors.length) console.log('errors:', [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();

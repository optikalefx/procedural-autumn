#!/usr/bin/env node
/**
 * Butt any images together at a shared seam, at the same scale, with labels.
 *
 * `ab.mjs --stitch` does this for a *blind* pair out of two capture
 * directories. This does it for anything — a frame against a reference plate,
 * three rounds of one view, a crop against its source — which is the comparison
 * the critic protocol asks for in step 2 ("read the reference plates") and
 * which has always been done by reading two files and holding one in memory.
 * Memory is exactly what normalises a defect.
 *
 *   node tools/vs.mjs shots/BASELINE/dome-h0.png shots/r1/dome-h0.png \
 *        reference-art/morning-night-dawn-dusk/night.jpg --out shots/cmp.png
 *   node tools/vs.mjs a.png b.jpg --labels "BEFORE,AFTER" --width 900 --stack
 *
 * Panels are scaled to a common width, so plates and captures of different
 * aspect ratios line up on their long edge rather than on their pixel count.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);
// A positional is any token that is not a flag and is not the value of one.
// Filtering on the extension alone is not enough: `--labels "OURS,REF night.jpg"`
// ends in .jpg and was being opened as an image.
const FLAGS_WITH_VALUES = new Set(['--out', '--labels', '--width']);
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (FLAGS_WITH_VALUES.has(a)) i++; continue; }
  files.push(a);
}

if (files.length < 2) {
  console.error('usage: vs.mjs <image> <image> [image…] --out out.png [--labels "A,B"] [--width N] [--stack]');
  process.exit(1);
}

const W = parseInt(arg('width', '820'), 10);
const OUT = resolve(arg('out', 'shots/vs.png'));
const labels = arg('labels') ? String(arg('labels')).split(',') : files.map((f) => basename(f));

await acquire('vs');
const browser = await chromium.launch();

const panels = files.map((f, i) => {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return { b64: readFileSync(f).toString('base64'), ext, label: (labels[i] ?? '').toUpperCase() };
});

const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0c0a10;font:12px ui-monospace,Menlo,monospace}
  .row{display:flex;flex-direction:${has('stack') ? 'column' : 'row'};gap:3px;align-items:flex-start}
  figure{position:relative;flex:0 0 ${W}px}
  img{display:block;width:${W}px;height:auto}
  figcaption{position:absolute;left:0;top:0;padding:5px 12px;background:#000c;
    color:#ffd9a8;letter-spacing:.2em;font-size:13px;max-width:100%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style><div class="row">${panels.map((p) =>
  `<figure><img src="data:image/${p.ext};base64,${p.b64}">` +
  `<figcaption>${p.label}</figcaption></figure>`).join('')}</div>`;

const page = await browser.newPage({
  viewport: { width: has('stack') ? W : W * files.length + 3 * files.length, height: 400 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
console.log(`vs: ${OUT}  (${files.length} panels at ${W}px)`);

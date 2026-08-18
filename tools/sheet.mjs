#!/usr/bin/env node
/**
 * Contact sheet — tile a directory of captures into one image with captions.
 *
 *   node tools/sheet.mjs --dir shots/base --out shots/base-sheet.png --cols 3
 *
 * Judging ten separate PNGs one at a time makes it easy to normalise a defect
 * you have already seen. Seeing the whole game on one page makes inconsistency
 * between views — colour, contrast, density — impossible to miss.
 */
import { chromium } from 'playwright';
import { readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const DIR = arg('dir', 'shots/base');
const OUT = arg('out', null) ?? `${DIR.replace(/\/$/, '')}-sheet.png`;
const COLS = parseInt(arg('cols', '3'), 10);
const CELL = parseInt(arg('cell', '620'), 10);
const TITLE = arg('title', DIR);

if (!existsSync(DIR)) { console.error(`no such dir: ${DIR}`); process.exit(1); }
const files = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
if (!files.length) { console.error(`no PNGs in ${DIR}`); process.exit(1); }

// Preferred ordering so sheets from different rounds line up visually.
const ORDER = ['hero', 'peaks', 'vista', 'drive', 'meadow', 'backlit', 'forest', 'river', 'waterfall', 'vehicle', 'dawn'];
files.sort((a, b) => {
  const ia = ORDER.indexOf(basename(a, '.png')), ib = ORDER.indexOf(basename(b, '.png'));
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
});

const cells = files.map((f) => {
  const b64 = readFileSync(join(DIR, f)).toString('base64');
  return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${basename(f, '.png')}</figcaption></figure>`;
}).join('\n');

const rows = Math.ceil(files.length / COLS);
const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#141018;font:13px ui-monospace,Menlo,monospace;color:#e8dcd0;padding:14px}
  h1{font-size:15px;font-weight:600;letter-spacing:.04em;margin:2px 4px 12px;color:#f0c89a}
  .grid{display:grid;grid-template-columns:repeat(${COLS},${CELL}px);gap:10px}
  figure{position:relative;background:#000;border-radius:6px;overflow:hidden;box-shadow:0 2px 14px #0009}
  img{display:block;width:${CELL}px;height:${Math.round(CELL * 9 / 16)}px;object-fit:cover}
  figcaption{position:absolute;left:0;bottom:0;padding:4px 9px;background:#000a;
    font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#ffd9a8;border-top-right-radius:6px}
</style><h1>${TITLE} — ${files.length} views</h1><div class="grid">${cells}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: COLS * CELL + COLS * 10 + 28, height: rows * (Math.round(CELL * 9 / 16) + 10) + 60 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(dirname(resolve(OUT)), { recursive: true });
await page.screenshot({ path: resolve(OUT), fullPage: true });
await browser.close();
console.log(`sheet: ${OUT}  (${files.length} views, ${COLS}x${rows})`);

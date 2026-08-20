#!/usr/bin/env node
/**
 * Blind A/B harness for the visual critics.
 *
 *   node tools/ab.mjs --a shots/before --b shots/after --out shots/ab
 *
 * Copies matching frames from two directories into an output directory under
 * neutral names (`<view>-left.png` / `<view>-right.png`) with the assignment
 * randomly flipped per view, and writes `KEY.json` mapping neutral name ->
 * source. A critic reads only the images, records a verdict per view, and then
 * `--reveal` prints the key.
 *
 * The point is that "which of these is better" is a much sharper question than
 * "is this good", and it is only honest if the judge cannot see the labels.
 */
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { acquire } from './_lock.mjs';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const OUT = arg('out', 'shots/ab');

if (has('reveal')) {
  const key = JSON.parse(readFileSync(join(OUT, 'KEY.json'), 'utf8'));
  console.log(JSON.stringify(key, null, 2));
  process.exit(0);
}

const A = arg('a'), B = arg('b');
if (!A || !B) { console.error('need --a <dir> --b <dir>'); process.exit(1); }

const pngs = (d) => existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.png')) : [];
const aFiles = new Set(pngs(A));
const bFiles = new Set(pngs(B));
const shared = [...aFiles].filter((f) => bFiles.has(f));

if (!shared.length) {
  console.error(`no matching filenames.\n  ${A}: ${[...aFiles].join(', ') || '(empty)'}\n  ${B}: ${[...bFiles].join(', ') || '(empty)'}`);
  process.exit(1);
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Deterministic per-view coin flip, seeded by the run so it is reproducible
// but not guessable from the filename alone.
const salt = arg('salt', String(Date.now()));
const key = { salt, a: A, b: B, views: {} };

for (const f of shared) {
  const view = basename(f, '.png');
  const bit = parseInt(createHash('sha256').update(salt + view).digest('hex').slice(0, 8), 16) & 1;
  const leftSrc = bit ? join(B, f) : join(A, f);
  const rightSrc = bit ? join(A, f) : join(B, f);
  copyFileSync(leftSrc, join(OUT, `${view}-left.png`));
  copyFileSync(rightSrc, join(OUT, `${view}-right.png`));
  key.views[view] = { left: bit ? 'b' : 'a', right: bit ? 'a' : 'b' };
}

writeFileSync(join(OUT, 'KEY.json'), JSON.stringify(key, null, 2));

// ── stitched pairs ───────────────────────────────────────────────────────────
// Two separate files make the judge hold one frame in memory while looking at
// the other, and memory is exactly what normalises a defect. Butting them
// against a shared edge turns "is this better" into a difference the eye finds
// on its own — a value step across the seam, a shoreline that lines up on one
// side and stairsteps on the other. Same pixels, same scale, no labels but
// LEFT and RIGHT.
if (has('stitch')) {
  const { chromium } = await import('playwright');
  const W = parseInt(arg('stitch-width', '1500'), 10);   // per panel
  await acquire('ab-stitch');
  const browser = await chromium.launch();
  for (const f of shared) {
    const view = basename(f, '.png');
    const enc = (side) =>
      readFileSync(join(OUT, `${view}-${side}.png`)).toString('base64');
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#0c0a10;font:12px ui-monospace,Menlo,monospace}
      .pair{display:flex;gap:4px}
      figure{position:relative;flex:0 0 ${W}px}
      img{display:block;width:${W}px;height:auto}
      figcaption{position:absolute;left:0;top:0;padding:5px 12px;background:#000c;
        color:#ffd9a8;letter-spacing:.22em;font-size:13px}
    </style><div class="pair">
      <figure><img src="data:image/png;base64,${enc('left')}"><figcaption>LEFT</figcaption></figure>
      <figure><img src="data:image/png;base64,${enc('right')}"><figcaption>RIGHT</figcaption></figure>
    </div>`;
    const page = await browser.newPage({ viewport: { width: W * 2 + 4, height: 200 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: resolve(join(OUT, `${view}-PAIR.png`)), fullPage: true });
    await page.close();
  }
  await browser.close();
  console.log(`stitched ${shared.length} pair(s): ${OUT}/<view>-PAIR.png`);
}

console.log(`paired ${shared.length} view(s) into ${OUT}`);
console.log('views:', shared.map((f) => basename(f, '.png')).join(', '));
console.log('Judge the -PAIR (or -left / -right) images WITHOUT reading KEY.json.');
console.log(`Reveal with: node tools/ab.mjs --out ${OUT} --reveal`);

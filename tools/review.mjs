#!/usr/bin/env node
/**
 * Archive a capture round to review/ so visual progression is reviewable later.
 *
 *   node tools/review.mjs --label "clouds and weather"
 *   node tools/review.mjs --dir shots/critic/now --label "critic pass" --capture
 *
 * shots/ is gitignored scratch churned by a dozen concurrent authors, so it is
 * no use as a record. review/ is numbered, dated and never overwritten, and
 * carries an INDEX.md so the whole trajectory reads at a glance.
 */
import { readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const REVIEW = 'review';
const LABEL = arg('label', 'round');
const DIR = arg('dir', null);
const slug = LABEL.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

mkdirSync(REVIEW, { recursive: true });

// Next sequence number, so ordering survives any date collision.
const seq = readdirSync(REVIEW)
  .map((f) => parseInt(f.slice(0, 3), 10))
  .filter((n) => Number.isFinite(n))
  .reduce((a, b) => Math.max(a, b), 0) + 1;

const stamp = arg('date') ?? new Date().toISOString().slice(0, 10);
const num = String(seq).padStart(3, '0');

let sheetSrc = arg('sheet', null);

if (has('capture')) {
  const shotDir = DIR ?? `shots/review-${num}`;
  console.log(`capturing → ${shotDir}`);
  execFileSync(process.execPath,
    ['tools/shot.mjs', '--all', '--dir', shotDir, '--w', '1280', '--h', '720'],
    { stdio: 'inherit' });
  sheetSrc = `${REVIEW}/.tmp-${num}.png`;
  execFileSync(process.execPath,
    ['tools/sheet.mjs', '--dir', shotDir, '--out', sheetSrc,
     '--cols', '4', '--cell', '520', '--title', `${num} · ${LABEL}`],
    { stdio: 'inherit' });
} else if (!sheetSrc) {
  if (!DIR) { console.error('need --dir <shots dir>, --sheet <png>, or --capture'); process.exit(1); }
  sheetSrc = `${REVIEW}/.tmp-${num}.png`;
  execFileSync(process.execPath,
    ['tools/sheet.mjs', '--dir', DIR, '--out', sheetSrc,
     '--cols', '4', '--cell', '520', '--title', `${num} · ${LABEL}`],
    { stdio: 'inherit' });
}

const dest = join(REVIEW, `${num}-${stamp}-${slug}.png`);
copyFileSync(sheetSrc, dest);
try { if (sheetSrc.includes('.tmp-')) execFileSync('rm', ['-f', sheetSrc]); } catch { /* fine */ }

const INDEX = join(REVIEW, 'INDEX.md');
if (!existsSync(INDEX)) {
  writeFileSync(INDEX,
`# Procedural Autumn — visual progression

Each entry is a contact sheet of the ten canonical camera views at that point in
development, newest last. Framings are pinned via \`shots/_anchors.json\`, so the
same places are photographed every round and the sheets are directly comparable.

| # | date | what changed | sheet |
|---|------|--------------|-------|
`);
}
appendFileSync(INDEX, `| ${num} | ${stamp} | ${LABEL} | [${num}](${dest.replace('review/', '')}) |\n`);

console.log(`archived: ${dest}  (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
console.log(`index:    ${INDEX}`);

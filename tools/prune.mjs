#!/usr/bin/env node
/**
 * Keep shots/ from filling the disk during long unattended runs.
 *
 * A dozen concurrent authors each write a capture round per iteration, and a
 * full round is ~20 MB. Overnight that is tens of gigabytes. review/ is the
 * permanent record and is never touched; shots/ is scratch.
 *
 *   node tools/prune.mjs            # keep the 3 newest rounds per author dir
 *   node tools/prune.mjs --keep 5
 */
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const KEEP = parseInt((argv[argv.indexOf('--keep') + 1] ?? '3'), 10);
const ROOT = 'shots';
// Never prune these: pinned anchors and anything an author is mid-comparison on.
const PROTECT = new Set(['_anchors.json']);

if (!existsSync(ROOT)) process.exit(0);

let freed = 0;
const du = (p) => {
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    n += e.isDirectory() ? du(f) : statSync(f).size;
  }
  return n;
};

for (const author of readdirSync(ROOT, { withFileTypes: true })) {
  if (!author.isDirectory()) continue;
  const dir = join(ROOT, author.name);
  const rounds = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !PROTECT.has(e.name))
    .map((e) => ({ name: e.name, path: join(dir, e.name), t: statSync(join(dir, e.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  for (const old of rounds.slice(KEEP)) {
    freed += du(old.path);
    rmSync(old.path, { recursive: true, force: true });
  }
}

// Loose top-level round dirs (wip1, wip2 …) — keep the newest few.
const loose = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^(wip|review-)/.test(e.name))
  .map((e) => ({ path: join(ROOT, e.name), t: statSync(join(ROOT, e.name)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (const old of loose.slice(4)) {
  freed += du(old.path);
  rmSync(old.path, { recursive: true, force: true });
}

console.log(`pruned ${(freed / 1e9).toFixed(2)} GB from ${ROOT}/ (kept ${KEEP} rounds per author, review/ untouched)`);

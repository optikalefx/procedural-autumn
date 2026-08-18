#!/usr/bin/env node
/**
 * Pre-bake worlds to public/bakes/ so the browser never pays the ~25 s CPU
 * cost. Run once per (seed, res) you care about; captures then load instantly.
 *
 *   node tools/bake.mjs                       # default seed, 1536 + 768 + 512
 *   node tools/bake.mjs --res 1536 --seed 42
 *   node tools/bake.mjs --force               # re-bake even if present
 */
import { TerrainGen } from '../src/world/TerrainGen.js';
import { encodeBake, bakeFilename, sourceHash } from '../src/world/bakeFormat.js';
import { writeFileSync, existsSync, mkdirSync, statSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const SEED = parseInt(arg('seed', '20261018'), 10);
const ALT = parseFloat(arg('alt', '340'));
const WORLD = parseFloat(arg('world', '3072'));
const resList = arg('res') ? [parseInt(arg('res'), 10)] : [1536, 768, 512];

// Cache key tracks the generator source, so editing TerrainGen.js invalidates
// every existing bake instead of silently serving the previous algorithm.
const GEN_HASH = sourceHash(readFileSync('src/world/TerrainGen.js', 'utf8'));
console.log(`generator hash: ${GEN_HASH}`);

// Sweep bakes from older generator versions so public/bakes/ does not grow.
try {
  for (const f of readdirSync('public/bakes')) {
    if (f.endsWith('.pab') && !f.includes(GEN_HASH)) {
      rmSync(join('public/bakes', f));
      console.log(`pruned stale ${f}`);
    }
  }
} catch { /* no bakes dir yet */ }

// One bake at a time, machine-wide: the file watcher and a hand-run
// `--force` would otherwise generate the same world twice concurrently.
await acquire('bake', { pool: 'bake', slots: 1 });

for (const res of resList) {
  const out = join('public', bakeFilename(SEED, res, GEN_HASH));
  if (existsSync(out) && !has('force')) {
    console.log(`skip  ${out}  (${(statSync(out).size / 1e6).toFixed(1)} MB, use --force to rebuild)`);
    continue;
  }
  const t0 = Date.now();
  let lastPct = -1;
  const gen = new TerrainGen({
    res, worldSize: WORLD, seed: SEED, maxAltitude: ALT,
    onProgress: (p, label) => {
      const pct = Math.round(p * 100);
      if (pct >= lastPct + 10) { lastPct = pct; process.stderr.write(`  ${String(pct).padStart(3)}%  ${label}\n`); }
    },
  });
  const data = gen.generate();
  const buf = encodeBake(data);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(buf));
  console.log(`baked ${out}  ${(buf.byteLength / 1e6).toFixed(1)} MB  in ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
              `(${data.waterfalls.length} falls, ${data.riverPolylines.length} rivers)`);
}

// A manifest, because the browser cannot list a directory. When the exact
// generator hash is missing, the client falls back to the newest bake here and
// flags itself stale rather than paying a 25 s live bake on every capture.
writeManifest();

function writeManifest() {
  let entries = [];
  try {
    entries = readdirSync('public/bakes')
      .filter((f) => f.endsWith('.pab'))
      .map((f) => {
        const m = /^world-(\d+)-(\d+)-([0-9a-f]+)\.pab$/.exec(f);
        if (!m) return null;
        return { file: f, seed: +m[1], res: +m[2], hash: m[3], mtime: statSync(join('public/bakes', f)).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* no dir */ }
  writeFileSync(join('public/bakes', 'manifest.json'),
    JSON.stringify({ current: GEN_HASH, entries }, null, 1));
  console.log(`manifest: ${entries.length} bake(s), current ${GEN_HASH}`);
}

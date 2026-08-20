#!/usr/bin/env node
/**
 * Fast whole-tree syntax gate.
 *
 * Several authors write large GLSL blocks inside JS template literals, and a
 * stray backtick in a shader comment silently terminates the literal and takes
 * the whole app down. `node --check` catches that in milliseconds; a headless
 * capture takes a minute and reports it as a mysterious blank page.
 *
 *   node tools/lint.mjs
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
})('src');
try { walk('tools'); } catch { /* optional */ }

// GLSL ES keywords that look like perfectly ordinary variable names in JS.
// Declaring one is a shader compile error, which surfaces at runtime as a black
// object rather than as a build failure — `float flat` and `patch` have both
// already cost us time here.
const GLSL_RESERVED = [
  'flat', 'smooth', 'noperspective', 'patch', 'sample', 'shared', 'layout',
  // `cast` joins `flat` and `patch` on the list of words that read as perfectly
  // ordinary shading vocabulary and are reserved anyway. `vec3 cast = ...` in a
  // rock material blanked the rocks and failed tools/health.mjs while lint said
  // the tree was clean; it costs one word here to catch it in milliseconds.
  'cast', 'namespace', 'using', 'typedef', 'template', 'this', 'goto', 'asm',
  'precision', 'invariant', 'centroid', 'buffer', 'active', 'filter',
  'resource', 'common', 'partition', 'subroutine', 'input', 'output',
  'attribute', 'varying', 'uniform', 'in', 'out', 'inout', 'const',
  'lowp', 'mediump', 'highp', 'discard', 'struct', 'coherent', 'volatile',
  'restrict', 'readonly', 'writeonly', 'atomic_uint', 'packed',
];
const TYPE = '(?:float|int|uint|bool|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](?:x[234])?)';
const DECL_RE = new RegExp(`\\b${TYPE}\\s+(${GLSL_RESERVED.join('|')})\\b\\s*[=;,)\\[]`, 'g');

let bad = 0, warned = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    bad++;
    console.error(`\n✗ ${f}`);
    console.error(String(e.stderr).split('\n').slice(0, 6).join('\n'));
    continue;
  }

  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(DECL_RE)) {
    const line = src.slice(0, m.index).split('\n').length;
    console.error(`\n⚠ ${f}:${line} declares GLSL reserved word "${m[1]}" — ` +
                  `if this is inside a shader it will fail to compile at runtime.`);
    warned++;
  }
}

if (bad) console.log(`\n${bad} file(s) failed to parse`);
else console.log(`✓ ${files.length} files parse cleanly${warned ? `, ${warned} GLSL warning(s)` : ''}`);
process.exit(bad ? 1 : 0);

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
import { readdirSync, statSync } from 'node:fs';
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

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    bad++;
    console.error(`\n✗ ${f}`);
    console.error(String(e.stderr).split('\n').slice(0, 6).join('\n'));
  }
}
console.log(bad ? `\n${bad} file(s) failed to parse` : `✓ ${files.length} files parse cleanly`);
process.exit(bad ? 1 : 0);

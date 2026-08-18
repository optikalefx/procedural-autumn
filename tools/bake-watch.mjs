#!/usr/bin/env node
/**
 * Watches the terrain generator and re-bakes the world cache when it changes,
 * so every author's captures stay both fast and correct without anyone having
 * to remember to run the baker.
 *
 *   node tools/bake-watch.mjs &
 *
 * Debounced, and it bakes cheapest-first so low-res captures unblock quickly.
 */
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';

const WATCH = ['src/world/TerrainGen.js', 'src/world/WorldConfig.js'];
const RES = ['512', '768', '1536'];
let timer = null, running = false, again = false;

function bake() {
  if (running) { again = true; return; }
  running = true;
  const t0 = Date.now();
  const run = (i) => {
    if (i >= RES.length) {
      running = false;
      console.log(`[bake-watch] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      if (again) { again = false; schedule(); }
      return;
    }
    const p = spawn('node', ['tools/bake.mjs', '--res', RES[i], '--force'], { stdio: ['ignore', 'inherit', 'ignore'] });
    p.on('exit', () => run(i + 1));
  };
  console.log('[bake-watch] generator changed — re-baking');
  run(0);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(bake, 15000);   // let an author finish a burst of edits
}

for (const f of WATCH) {
  try { watch(f, schedule); console.log(`[bake-watch] watching ${f}`); }
  catch (e) { console.warn(`[bake-watch] cannot watch ${f}: ${e.message}`); }
}
console.log('[bake-watch] idle');

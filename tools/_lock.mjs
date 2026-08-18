/**
 * Machine-wide concurrency limiter for the capture tools.
 *
 * Several system authors run captures at once, and every capture launches a
 * headless Chromium that bakes the world. Unbounded, that pins every core and
 * makes each individual run slower than if they had queued. This is a simple
 * file-slot semaphore: acquire a slot, do the work, release on exit.
 *
 * Override with CAPTURE_SLOTS=n. Set CAPTURE_SLOTS=0 to disable.
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(tmpdir(), 'procedural-autumn-locks');
const DEFAULT_SLOTS = process.env.CAPTURE_SLOTS !== undefined ? parseInt(process.env.CAPTURE_SLOTS, 10) : 2;
const STALE_MS = 12 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reapStale(DIR) {
  let live = 0;
  for (const f of readdirSync(DIR)) {
    const p = join(DIR, f);
    let dead = false;
    try {
      if (Date.now() - statSync(p).mtimeMs > STALE_MS) dead = true;
      else {
        const pid = parseInt(readFileSync(p, 'utf8'), 10);
        // Signal 0 just tests for existence.
        try { process.kill(pid, 0); } catch { dead = true; }
      }
    } catch { dead = true; }
    if (dead) { try { rmSync(p, { force: true }); } catch { /* raced */ } }
    else live++;
  }
  return live;
}

/**
 * Blocks until a slot is free. Returns a release function.
 *
 * `pool` names an independent semaphore. Captures share one pool of 2; baking
 * gets its own pool of 1, because the file watcher and an author running
 * `bake.mjs --force` will otherwise generate the same world twice at once.
 */
export async function acquire(label = 'capture', { pool = 'capture', slots = DEFAULT_SLOTS } = {}) {
  const SLOTS = slots;
  if (!SLOTS) return () => {};
  const DIR = join(ROOT, pool);
  mkdirSync(DIR, { recursive: true });
  const mine = join(DIR, `${process.pid}.lock`);
  const t0 = Date.now();
  let announced = false;

  for (;;) {
    if (reapStale(DIR) < SLOTS) {
      writeFileSync(mine, String(process.pid));
      // Re-check: two processes can pass the count at the same instant. The
      // lowest pid among the current holders wins; the rest back off.
      const holders = readdirSync(DIR).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
      if (holders.slice(0, SLOTS).includes(process.pid)) break;
      try { rmSync(mine, { force: true }); } catch { /* raced */ }
    }
    if (!announced && Date.now() - t0 > 3000) {
      console.error(`[${label}] waiting for a ${pool} slot (${SLOTS} concurrent max)…`);
      announced = true;
    }
    await sleep(400 + Math.random() * 700);
  }

  const release = () => { try { rmSync(mine, { force: true }); } catch { /* already gone */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
  return release;
}

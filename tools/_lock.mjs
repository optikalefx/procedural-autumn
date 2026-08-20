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
 *
 * `exclusive: true` takes EVERY slot in the pool and is what any timing
 * measurement must use. See `acquireExclusive` below for why.
 */
export async function acquire(label = 'capture', { pool = 'capture', slots = DEFAULT_SLOTS, exclusive = false } = {}) {
  if (exclusive) return acquireExclusive(label, { pool, slots });
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


/**
 * Take every slot in the pool, so nothing else renders while we measure.
 *
 * A capture can share the machine: it wants one settled frame, and a co-tenant
 * costs it wall-clock but not correctness. **A timing run cannot.** The pool
 * holds 2 slots, so every perf measurement ever taken on this project ran
 * alongside another headless Chromium rendering — and the two share a GPU.
 *
 * That is invisible to the check everyone was told to make. `uptime` reports a
 * CPU run-queue average; this workload is GPU-bound, and a second browser
 * holding a GPU context does not move the load average much at all. So authors
 * saw "load is 6, that's fine" and concluded a FAIL was real. Measured here on
 * one unchanged commit: 54.3 fps with the machine to itself, 36.1 and then
 * 30-32 fps with two other GPU contexts live, at a *lower* load average each
 * time. Four separate authors independently reported the same 0.667-scaler FAIL
 * signature today and each correctly refused to accept it; none could name the
 * cause, because the instrument they were told to check could not see it.
 *
 * Acquiring exclusively is slower — a timing run now queues behind every
 * outstanding capture — and that is the correct trade. A number that cannot be
 * attributed is worth less than no number.
 */
async function acquireExclusive(label, { pool, slots }) {
  const DIR = join(ROOT, pool);
  mkdirSync(DIR, { recursive: true });
  // One file per slot, all named for this pid so reapStale() can verify them
  // and so an ordinary acquire() counting the directory sees the pool as full.
  const mine = Array.from({ length: slots }, (_, i) => join(DIR, `${process.pid}.x${i}.lock`));
  const drop = () => { for (const f of mine) { try { rmSync(f, { force: true }); } catch { /* raced */ } } };
  const t0 = Date.now();
  let announced = false;

  for (;;) {
    if (reapStale(DIR) === 0) {
      for (const f of mine) writeFileSync(f, String(process.pid));
      // Re-check for the race where two processes both saw an empty directory.
      // Lowest pid wins the whole pool; anyone else drops everything and retries.
      const holders = readdirSync(DIR).map((f) => parseInt(f, 10));
      if (holders.every((h) => h === process.pid)) break;
      if (Math.min(...holders) === process.pid) break;
      drop();
    }
    if (!announced && Date.now() - t0 > 3000) {
      console.error(`[${label}] waiting for the machine to itself (${pool}, ${slots} slots)…`);
      announced = true;
    }
    await sleep(500 + Math.random() * 900);
  }

  process.on('exit', drop);
  process.on('SIGINT', () => { drop(); process.exit(130); });
  process.on('SIGTERM', () => { drop(); process.exit(143); });
  return drop;
}

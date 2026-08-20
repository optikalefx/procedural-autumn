#!/usr/bin/env node
/**
 * How often does the chase camera end up inside a tree trunk?
 *
 * The rock half of this (`camrock.mjs`) runs with no browser at all, because
 * `RockScatter` regenerates headlessly from the bake. Tree placement does not:
 * it needs the grown prototypes, so the only place the placement table exists
 * is in a live page. So this is a browser tool — but it is still an audit and
 * not a screenshot, and it obeys the two rules that cost this project time:
 *
 *   · **both arms inside one page load.** `poi.anchor()` was unstable across
 *     page loads until 731d2c9 (P3), and two captures of the same tree 34
 *     minutes apart differed in half their pixels. Nothing here is compared
 *     across processes: one load, one forest, both arms, alternating which arm
 *     runs first at each pose.
 *   · **the real code.** The page dynamically imports `CameraRig.js` and
 *     `BoomClearance.js` off the dev server and poses and fits with the rig's
 *     own exported `chaseDesired` / `boomFree` / `TrunkField`. The two arms
 *     differ only in whether `boomFree` is handed the trunk pass.
 *
 * Poses are drawn from the tree table itself — a point a few metres from a
 * trunk, on ground a camper could be on — because a uniform sample of the world
 * is mostly not forest and would dilute the number being measured. Both arms
 * see the identical pose list.
 *
 *   node tools/_scratch/camtree.mjs
 *   node tools/_scratch/camtree.mjs --keep        # sweep the keep-out radius
 *   node tools/_scratch/camtree.mjs --poses 400
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const KEEPSWEEP = argv.includes('--keep');
const NPOSE = parseInt(arg('poses', '900'), 10);
const RES = arg('res', '1536');

try {
  execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('[camtree] the tree does not parse; fix that first');
  console.error(((e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')).trim());
  process.exit(2);
}

await acquire('camtree');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
// Neuter Vite HMR: a peer saving a file mid-run would reload the page and take
// the forest with it.
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(url, protocols);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });
await page.waitForTimeout(800);

await page.evaluate((k) => { if (k) window.__keepList = k; }, arg('list', null)?.split(',').map(Number) ?? null);
const out = await page.evaluate(async ({ NPOSE, KEEPSWEEP }) => {
  const rig = await import('/src/vehicle/CameraRig.js');
  const bc = await import('/src/vehicle/BoomClearance.js');
  const THREE = window.__THREE;
  const W = window.__world;
  const S = window.__systems;
  const T = S?.trees?.trees;
  if (!T?.n) return { error: 'trees.trees is not built' };

  const terrainFloor = (x, z) => Math.max(W.getHeight(x, z), W.getWaterHeight(x, z) ?? -1e9);

  // ── poses: beside a trunk, on ground a camper could be on ──────────────────
  const poses = [];
  const step = Math.max(1, Math.floor(T.n / NPOSE));
  for (let i = 0; i < T.n && poses.length < NPOSE; i += step) {
    // A few metres off the bole, so the camper is *in* the wood rather than
    // standing in the tree. Angle from the index, so it is deterministic.
    const a = (i % 17) * 0.37;
    const x = T.px[i] + Math.cos(a) * 6, z = T.pz[i] + Math.sin(a) * 6;
    if (W.getWaterDepth(x, z) > 0.3) continue;
    const gx = (W.getHeight(x + 2, z) - W.getHeight(x - 2, z)) / 4;
    const gz = (W.getHeight(x, z + 2) - W.getHeight(x, z - 2)) / 4;
    if (Math.hypot(gx, gz) > 0.62) continue;
    poses.push({ x, y: W.getHeight(x, z) + 0.9, z });
  }

  const rocks = new bc.RockField().attach(S.rocks);
  const trunks = new bc.TrunkField().attach(S.trees);
  const anchor = new THREE.Vector3(), desired = new THREE.Vector3();
  const YAWS = [0, 1.05, 2.09, Math.PI, -2.09, -1.05];
  const ZOOMS = [5.5, 19, 68];

  function shoot(pose, yaw, zoom, useTrunks, keep) {
    const floorAt = (x, z) => rocks.lift(x, z, terrainFloor(x, z));
    const clearAt = useTrunks ? (a, d, m) => trunks.retract(a, d, keep, m) : null;
    rig.chaseDesired(anchor, desired, {
      x: pose.x, y: pose.y, z: pose.z, yaw, zoom, pitch: rig.restPitch(zoom), fast: 0,
    });
    const frac = rig.boomFree(anchor, desired, zoom, floorAt, clearAt);
    desired.lerpVectors(anchor, desired, frac);
    // `_liftEnd` then the rig's undamped hard floor, both through `floorAt`.
    const clr = rig.camClearance(zoom);
    desired.y = Math.max(desired.y, floorAt(desired.x, desired.z) + clr);
    return { frac, x: desired.x, y: desired.y, z: desired.z };
  }

  /** Nearest trunk *surface*, in metres, from wherever the camera ended up. */
  function nearestBole(x, y, z) {
    let best = Infinity;
    for (let i = 0; i < trunks.n; i++) {
      if (y > trunks.tt[i]) continue;
      const d = Math.hypot(x - trunks.tx[i], z - trunks.tz[i]) - trunks.tr[i];
      if (d < best) best = d;
    }
    return best;
  }

  function run(keep) {
    const tally = () => ({ shots: 0, inBole: 0, within1: 0, withinKeep: 0, clamped: 0, frac: 0, nearest: Infinity });
    const off = tally(), on = tally();
    let flip = 0;
    for (const pose of poses) {
      rocks.prime(pose.x, pose.z, 82);
      trunks.prime(pose.x, pose.z, 80);
      if (!trunks.n) continue;
      for (const zoom of ZOOMS) {
        for (const yaw of YAWS) {
          // Alternate which arm goes first. Nothing here is stateful, but the
          // last two before/afters this project trusted were not either.
          const order = (flip++ & 1) ? [[on, true], [off, false]] : [[off, false], [on, true]];
          for (const [arm, useTrunks] of order) {
            const c = shoot(pose, yaw, zoom, useTrunks, keep);
            const d = nearestBole(c.x, c.y, c.z);
            arm.shots++;
            arm.frac += c.frac;
            if (d < 0) arm.inBole++;
            if (d < 1.0) arm.within1++;
            if (d < keep) { arm.withinKeep++; if (c.frac <= 0.341) arm.clamped++; }
            if (d < arm.nearest) arm.nearest = d;
          }
        }
      }
    }
    return { off, on };
  }

  if (KEEPSWEEP) {
    const rows = [];
    for (const keep of (window.__keepList ?? [0.6, 1.2, 1.8, 2.4, 3.2])) rows.push({ keep, ...run(keep) });
    return { poses: poses.length, trees: T.n, rows };
  }
  return { poses: poses.length, trees: T.n, ...run(bc.TRUNK_KEEP), keep: bc.TRUNK_KEEP };
}, { NPOSE, KEEPSWEEP });

await browser.close();

if (out.error) { console.error(out.error); process.exit(1); }
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;
const row = (tag, t, keep) => console.log(
  `${tag.padEnd(20)} shots ${String(t.shots).padStart(6)}`
  + `   inside a bole ${String(t.inBole).padStart(5)} (${pct(t.inBole, t.shots).padStart(6)})`
  + `   within 1 m ${String(t.within1).padStart(5)} (${pct(t.within1, t.shots).padStart(6)})`
  + `   within ${keep} m ${String(t.withinKeep).padStart(5)} (${t.clamped} at the 0.34 clamp)`
  + `   nearest ${t.nearest.toFixed(2)} m   mean boom ${(t.frac / Math.max(1, t.shots)).toFixed(3)}`,
);

console.log(`forest ${out.trees} trees   poses ${out.poses} (beside a trunk)   6 yaws x 3 zooms   one page load`);
console.log('');
if (out.rows) {
  for (const r of out.rows) {
    row(`TRUNK_KEEP ${r.keep} OFF`, r.off, r.keep);
    row(`TRUNK_KEEP ${r.keep} ON`, r.on, r.keep);
  }
} else {
  row('trunk fit OFF', out.off, out.keep);
  row('trunk fit ON', out.on, out.keep);
}

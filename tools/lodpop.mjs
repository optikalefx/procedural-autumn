#!/usr/bin/env node
/**
 * Drive through the forest and count what changes at the LOD radii.
 *
 * `lodstrip.mjs` measures ONE tree across ONE boundary. This measures the
 * thing the player complained about: a whole forest going past at driving
 * speed, with trees crossing LOD radii all over the frame.
 *
 * ── two instruments this replaced, and why they were wrong ─────────────────
 *
 * 1. Frame-to-frame silhouette difference over the whole frame. At 0.22 m a
 *    frame (13 m/s) the nearest trunk is two metres away and its parallax
 *    alone changes 9-11% of the tree pixels EVERY frame. Against that floor
 *    the LOD pop is invisible: the identical drive, before and after a change
 *    that moved single-tree boundary IoU from 0.365 to 0.680, reported a "pop
 *    ratio" of 0.91x and 0.90x. Two clean, repeatable numbers about parallax.
 *
 * 2. Differencing against a reference arm with the LOD switched off
 *    (`_lodScale` 4, near radius 336 m). The reference draws real geometry
 *    where the shipping frame draws billboards, so the reference has MORE
 *    parallax than the thing it is the control for, and "pop = raw minus
 *    reference" came out reliably negative.
 *
 * What this does instead: it clips the camera to a SLAB across the boundary —
 * `camera.near = 62`, `camera.far = 106` for the 84 m near/mid radius — so the
 * frame contains only the trees that are about to change LOD, with every
 * foreground trunk clipped away. Parallax across 0.22 m at 84 m is 0.26% of
 * the distance and the floor collapses to a fraction of a percent, which is
 * what makes the pop legible. Trees re-bin every `rebuildMove` metres, so the
 * pops are periodic; the tool counts `_rebuild` calls directly rather than
 * inferring them from instance counts, which misses every re-bin where as many
 * trees left a band as entered it.
 *
 * Reported per slab: the change on a re-bin frame, the change on every other
 * frame, and the ratio. A LOD with continuity of identity has a ratio near 1.
 *
 *   node tools/lodpop.mjs --dir shots/lodpop/after --url http://127.0.0.1:5204
 */
import { chromium } from 'playwright';
import { acquire } from './_lock.mjs';
import { readPNG } from './_pngread.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
const DIR = resolve(arg('dir', 'shots/lodpop/run'));
const W = +arg('w', 640), H = +arg('h', 360);
const STEPS = +arg('steps', 400);
const STEP_M = +arg('step', 0.22);           // 13 m/s at 60 fps
const ANCHORS = arg('anchors', 'drive,forest').split(',');
const HOUR = +arg('hour', 12.0);
const KEEP = argv.includes('--keep');
// Slabs, in metres, one per LOD boundary. Wide enough that a tree is inside
// the slab for the whole 11 m re-bin quantum on either side of the radius.
const SLABS = [{ name: 'near|mid 84 m', near: 62, far: 106 },
               { name: 'mid|far 255 m', near: 230, far: 282 }];

const CLEAR = [0, 0, 255];

function maskOf(path) {
  const { w, h, px } = readPNG(path);
  const m = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    const d = Math.abs(px[o] - CLEAR[0]) + Math.abs(px[o + 1] - CLEAR[1]) + Math.abs(px[o + 2] - CLEAR[2]);
    if (d > 96) { m[i] = 1; n++; }
  }
  return { m, n, w, h };
}

function jac(a, b) {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.m.length; k++) {
    const p = a.m[k], q = b.m[k];
    if (p | q) uni++;
    if (p & q) inter++;
  }
  return uni ? 1 - inter / uni : 0;
}

await acquire('lodpop');
mkdirSync(DIR, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
// The seed is PINNED. `public/bakes/` holds worlds for 20261018 while
// `WorldConfig.SEED` is 20262018, so an unpinned boot misses the bake cache
// and grows a different forest — different trees, different variants, and a
// before/after comparison of different objects.
await p.goto(`${URL}/?res=${arg('res', '768')}&seed=${arg('seed', '20261018')}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

await p.evaluate(({ hour }) => {
  const e = window.__engine, scene = e.scene, renderer = e.renderer;
  e.adaptive = false; e.autoQuality = false;
  window.__lighting.hour = hour; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  for (const n of Array.from(document.body.children)) if (n.id !== 'app') n.remove();
  document.body.style.background = '#00f';
  for (const c of scene.children) if (c.name !== 'Trees') c.visible = false;
  renderer.autoClear = true;
  e.setRenderCallback(() => {
    scene.background = null;
    renderer.autoClear = true;
    renderer.setClearColor(0x0000ff, 1);
    renderer.render(scene, e.camera);
  });
  const t = window.__systems.trees;
  // Count re-bins at the source. Comparing per-LOD instance COUNTS between
  // frames misses a re-bin in which as many trees left a band as entered it,
  // which is most of them on a straight drive.
  window.__rebins = 0;
  const rb = t._rebuild.bind(t);
  t._rebuild = (pos) => { window.__rebins++; return rb(pos); };
  const orig = t.update.bind(t);
  t.update = (dt) => { orig(dt, 0); t.shared.uWindStrength.value = 0; t.shared.uTime.value = 0; };

  window.__drive = {
    seed(anchor) {
      const a = (window.__cameraAnchors[anchor] || window.__cameraAnchors.vista)();
      const yaw = a.yaw ?? 0;
      this.x = a.x; this.z = a.z; this.dx = Math.sin(yaw); this.dz = Math.cos(yaw);
      return { x: a.x, z: a.z, yaw };
    },
    // NOTE: this never touches `_lastRebuildPos`. The re-bin cadence under
    // test is the shipped one; forcing a rebuild per frame measures a
    // different game.
    step(i, m) {
      const wd = window.__world, cam = e.camera;
      const x = this.x + this.dx * i * m, z = this.z + this.dz * i * m;
      const y = wd.getHeight(x, z) + 3.0;
      cam.position.set(x, y, z);
      cam.lookAt(x + this.dx * 20, y + 1.0, z + this.dz * 20);
    },
    slab(n, f) {
      const cam = e.camera;
      cam.fov = 55; cam.near = n; cam.far = f; cam.updateProjectionMatrix();
    },
    rebins() { return window.__rebins; },
  };
}, { hour: HOUR });

const out = [];
for (const anchor of ANCHORS) {
  const start = await p.evaluate((a) => window.__drive.seed(a), anchor);
  const shots = SLABS.map(() => []);
  const reb = [];
  for (let i = 0; i < STEPS; i++) {
    const r = await p.evaluate(async ({ i, m }) => {
      window.__drive.step(i, m); await window.__settle(3); return window.__drive.rebins();
    }, { i, m: STEP_M });
    reb.push(r);
    for (let s = 0; s < SLABS.length; s++) {
      await p.evaluate(async (sl) => { window.__drive.slab(sl.near, sl.far); await window.__settle(1); }, SLABS[s]);
      const f = `${DIR}/${anchor}-s${s}-${String(i).padStart(4, '0')}.png`;
      await p.screenshot({ path: f });
      shots[s].push(f);
    }
  }

  for (let s = 0; s < SLABS.length; s++) {
    let prev = maskOf(shots[s][0]);
    const rows = [];
    for (let i = 1; i < shots[s].length; i++) {
      const cur = maskOf(shots[s][i]);
      rows.push({ i, change: jac(cur, prev), cover: cur.n / (cur.w * cur.h), rebin: reb[i] !== reb[i - 1] });
      prev = cur;
    }
    const cov = rows.reduce((a, r) => a + r.cover, 0) / rows.length;
    if (cov < 0.002) throw new Error(`!! ${anchor} ${SLABS[s].name}: the slab is empty (${(cov * 100).toFixed(2)}%)`);
    const rbF = rows.filter((r) => r.rebin), nb = rows.filter((r) => !r.rebin);
    if (!rbF.length) throw new Error(`!! ${anchor}: no re-bin happened in ${STEPS} steps — nothing was measured`);
    const mean = (xs) => xs.reduce((a, x) => a + x.change, 0) / (xs.length || 1);
    const worst = Math.max(...rbF.map((r) => r.change));
    console.log(`\n── ${anchor}  ${SLABS[s].name}  (${STEPS} frames, ${(STEPS * STEP_M).toFixed(0)} m,` +
      ` slab coverage ${(cov * 100).toFixed(1)}%)`);
    console.log(`   re-bin frames   n=${rbF.length}   mean ${(mean(rbF) * 100).toFixed(2)}%   worst ${(worst * 100).toFixed(2)}%`);
    console.log(`   other frames    n=${nb.length}   mean ${(mean(nb) * 100).toFixed(2)}%    <- parallax floor`);
    console.log(`   POP RATIO = ${(mean(rbF) / mean(nb)).toFixed(2)}x`);
    out.push({ anchor, slab: SLABS[s].name, start, rows });
  }
  if (!KEEP) for (const list of shots) for (const f of list) rmSync(f, { force: true });
}

await b.close();
writeFileSync(`${DIR}/series.json`, JSON.stringify(out, null, 1));
console.log(`\nwrote ${DIR}/series.json`);

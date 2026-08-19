#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 *   node tools/shot.mjs --out shots/x.png --view valley
 *   node tools/shot.mjs --out shots/x.png --pos 12,40,80 --look 0,20,0 --hour 17
 *   node tools/shot.mjs --all --dir shots/run1
 *
 * Boots the game in headless Chromium with a real GPU-ish backend (SwiftShader
 * fallback), waits for the world bake, poses the camera and writes a PNG.
 * Deterministic: same seed + same view = comparable frames.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { acquire } from './_lock.mjs';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// POI ranking shifts whenever the terrain bake changes, so `--view meadow` can
// frame a different place between runs and quietly invalidate a before/after
// comparison. Anchors are resolved once into this file and reused; delete it or
// pass --refresh-views after a deliberate terrain change.
//
// Deliberately NOT under shots/: that directory is gitignored scratch and is
// pruned during long runs, so the pins vanished and every view silently
// re-resolved to a different place — which destroys the whole point of the
// review archive. review/ is tracked and never pruned.
const VIEWS_CACHE = 'review/anchors.json';
const LEGACY_VIEWS_CACHE = 'shots/_anchors.json';

// Anchors that track a moving object must never be frozen — pinning the camper's
// position from an earlier run just aims the camera at empty meadow.
const DYNAMIC_ANCHORS = new Set(['vehicle']);

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

// ── Canonical camera views. Every critic compares the same framings. ────────
export const VIEWS = {
  // Wide establishing shot over the valley — the "box art" frame.
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  // Eye-level drive shot: what the player actually stares at for hours.
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  // Down in the meadow, grass in the foreground.
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  // Forest interior — canopy, trunks, dappled light.
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  // River bank, water in frame.
  // Sits on a shoreline, which is exactly where the grass system grows its
  // tallest reed fringe — at 5 m the camera was inside the reeds.
  river:     { anchor: 'river',    height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  // The tallest waterfall, framed from below.
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  // High peaks and aerial perspective.
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  // The vehicle, three-quarter hero framing.
  vehicle:   { anchor: 'vehicle',  height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0, subject: true },
  // Golden-hour backlit shot — the money frame for foliage translucency.
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  // Dawn cool pass, checks the grade does not fall apart off-golden-hour.
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const OUT_W = parseInt(arg('w', '1600'), 10);
const OUT_H = parseInt(arg('h', '900'), 10);
// --res lowers the heightmap resolution for a much faster world bake (the full
// 1536 bake costs ~25 s). Use it for fast iteration; capture final frames at
// full res. --quality forces a preset instead of auto-detecting.
const RES = arg('res', null);
const QUALITY = arg('quality', null);
const SEED = arg('seed', null);
const params = new URLSearchParams();
if (RES) params.set('res', RES);
if (QUALITY) params.set('quality', QUALITY);
if (SEED) params.set('seed', SEED);
const qs = params.toString();
const URL = arg('url', 'http://localhost:5178') + (qs ? `?${qs}` : '');
const TIMEOUT = parseInt(arg('timeout', '180000'), 10);

async function main() {
/**
 * Refuse to capture against a broken tree.
 *
 * Six separate authors have taken the build down by putting a backtick inside a
 * GLSL template literal. The failure surfaces as a blank page or a confusing
 * runtime error a minute later, after a capture has already been spent. Linting
 * first costs ~1 s and names the file and line.
 */
function assertTreeParses() {
  try {
    execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.error('\n[capture] refusing to run — the source tree does not parse:\n');
    console.error(out.trim());
    console.error('\nFix the syntax error and re-run. If the offending file is not yours, a peer is');
    console.error('mid-edit: wait a moment and retry rather than editing their file.\n');
    process.exit(2);
  }
}

assertTreeParses();
await acquire('shot');
  const browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--enable-webgl', '--enable-webgl2-compute-context',
      '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: OUT_W, height: OUT_H },
    deviceScaleFactor: 1,
  });

  // Neuter Vite's HMR client before any page script runs.
  //
  // A dozen authors edit this tree concurrently, so a peer saving a file mid
  // capture reloads the page and the run dies with "Execution context was
  // destroyed". It has cost several authors an entire round, and worse, a
  // partially-reloaded page can produce a frame that looks fine and is not what
  // was asked for. A capture wants a frozen build, not a live one.
  await page.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
        // A silent stub: never connects, never errors, never reloads.
        return {
          readyState: 3, url, close() {}, send() {},
          addEventListener() {}, removeEventListener() {},
          set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
        };
      }
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, RealWS);
  });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: TIMEOUT, polling: 250 });

  const views = has('all')
    ? Object.keys(VIEWS)
    : [arg('view', 'hero')].filter(Boolean);

  const dir = arg('dir', 'shots');
  const results = [];

  // Frozen anchors keep --view framings identical across runs, so a before/after
  // comparison measures the change and not a different patch of the map.
  let frozen = null;
  if (!has('refresh-views')) {
    for (const p of [VIEWS_CACHE, LEGACY_VIEWS_CACHE]) {
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        frozen = { ...(j ?? {}), ...(frozen ?? {}) };   // new location wins
      } catch { /* ignore a corrupt cache */ }
    }
  }
  const resolvedAll = { ...(frozen ?? {}) };

  for (const name of views) {
    const v = VIEWS[name];
    if (!v && !has('pos')) { console.error(`unknown view: ${name}`); continue; }

    await page.evaluate(async ({ v, name, posStr, lookStr, hourArg, frozen, dynamicAnchors }) => {
      const THREE = window.__THREE;
      const e = window.__engine, wd = window.__world;
      const api = window.__cameraAnchors || {};

      const hour = hourArg ? parseFloat(hourArg) : (v ? v.hour : 16.7);
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;

      let pos, look;
      if (posStr) {
        const p = posStr.split(',').map(Number);
        const l = (lookStr || '0,0,0').split(',').map(Number);
        pos = new THREE.Vector3(p[0], p[1], p[2]);
        look = new THREE.Vector3(l[0], l[1], l[2]);
      } else {
        const cached = (frozen && !dynamicAnchors.includes(v.anchor)) ? frozen[v.anchor] : null;
        const anchor = cached ?? (
          (v.index && window.__anchorAt)
            ? window.__anchorAt(v.anchor, v.index)
            : (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))()
        );
        window.__lastResolvedAnchor = (cached || dynamicAnchors.includes(v.anchor)) ? null : {
          key: v.anchor,
          value: { x: anchor.x, z: anchor.z, yaw: anchor.yaw, lookY: anchor.lookY },
        };
        let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
        if (v.faceSun) {
          const sd = window.__lighting.sunDir;
          yaw = Math.atan2(sd.x, sd.z);
        }
        if (v.subject) {
          // Subject framing: orbit the landmark and look AT it. Standing on the
          // anchor puts the camera *inside* the thing we came to photograph —
          // which is exactly why the `vehicle` view rendered pure black.
          const gx = anchor.x - Math.sin(yaw) * v.dist;
          const gz = anchor.z - Math.cos(yaw) * v.dist;
          const gy = wd.getHeight(gx, gz) + v.height;
          pos = new THREE.Vector3(gx, gy, gz);
          const ty = wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4);
          look = new THREE.Vector3(anchor.x, ty, anchor.z);
        } else {
          // Landscape framing: stand at the landmark and look along its yaw,
          // optionally stepped back so the camera is not inside the camper
          // parked on the same road node.
          const back = v.standOff ?? 0;
          const gx = anchor.x - Math.sin(yaw) * back;
          const gz = anchor.z - Math.cos(yaw) * back;
          const gy = wd.getHeight(gx, gz) + v.height;
          pos = new THREE.Vector3(gx, gy, gz);
          look = new THREE.Vector3(
            gx + Math.sin(yaw) * v.dist,
            gy + Math.tan(v.pitch) * v.dist,
            gz + Math.cos(yaw) * v.dist
          );
        }
      }

      // ── clear the near field ────────────────────────────────────────────
      // Landmark anchors are scored on terrain, so they happily land inside a
      // thicket, a lake, or behind a conifer — the `forest`, `waterfall` and
      // `river` views have each been ruined that way, and an author judging a
      // blocked frame is judging nothing. Raycast along the view direction and,
      // if something is in our face, lift and step back until it is not.
      if (!posStr && window.__THREE) {
        const T = window.__THREE;
        const ray = new T.Raycaster();
        ray.far = 6;
        const dir = new T.Vector3();
        const MIN_CLEAR = 3.0;
        for (let attempt = 0; attempt < 6; attempt++) {
          dir.copy(look).sub(pos).normalize();
          ray.set(pos, dir);
          const hits = ray.intersectObjects(e.scene.children, true)
            .filter((h) => h.distance > 0.05 && h.object.visible &&
                           h.object.name !== 'Sky' && !h.object.isPoints);
          if (!hits.length || hits[0].distance > MIN_CLEAR) break;
          // Rise first — most obstructions here are vegetation rooted below us.
          pos.y += 2.2;
          pos.addScaledVector(dir, -2.0);
          look.y += 0.7;
        }
        // Never end up under the ground after lifting.
        const g = wd.getHeight(pos.x, pos.z) + 1.4;
        if (pos.y < g) pos.y = g;
      }

      e.camera.fov = v ? v.fov : 50;
      e.camera.updateProjectionMatrix();
      e.camera.position.copy(pos);
      e.camera.lookAt(look);
      window.__forceCamera = true;

      // Force a renderer resize before settling. Playwright's viewport is set
      // after the page loads, and if the resize handler has not propagated to
      // the renderer by capture time the screenshot comes back as a narrow
      // strip of scene on a black field — which reads as "the camera is inside
      // something" and sends you hunting the wrong bug.
      window.dispatchEvent(new Event('resize'));

      // Let streaming, LOD and any temporal effects settle.
      if (window.__settle) await window.__settle(60);
      void name;
    }, { v, name, posStr: arg('pos'), lookStr: arg('look'), hourArg: arg('hour'), frozen, dynamicAnchors: [...DYNAMIC_ANCHORS] });

    // Record whatever this run had to resolve fresh.
    const justResolved = await page.evaluate(() => window.__lastResolvedAnchor ?? null);
    if (justResolved) resolvedAll[justResolved.key] = justResolved.value;

    // Optional page-side setup: toggling systems, debug masks, etc.
    const evalSrc = arg('eval');
    if (evalSrc) await page.evaluate((src) => eval(src), evalSrc);

    await page.waitForTimeout(1400);

    // A capture that comes back black, or as the loading screen, silently
    // poisons any measurement taken from the batch — and it happened often
    // enough that authors were re-running whole rounds. Verify the frame is
    // real before writing it.
    //
    // Note: reading the WebGL canvas back through a 2D context does NOT work
    // here — the context is created without preserveDrawingBuffer, so outside
    // of a frame it reads as empty and every frame looks blank. Check the
    // renderer's own state instead.
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await page.evaluate(() => ({
        ready: window.__ready === true,
        hidden: document.getElementById('loader')?.classList.contains('hidden') ?? true,
        calls: window.__engine?.renderer?.info?.render?.calls ?? 0,
        // The drawing buffer must cover the viewport, or the capture is a strip.
        sized: (() => {
          const c = document.getElementById('gl');
          if (!c) return false;
          const dpr = window.__engine?.renderer?.getPixelRatio?.() ?? 1;
          return Math.abs(c.width / dpr - window.innerWidth) < 4 &&
                 Math.abs(c.height / dpr - window.innerHeight) < 4;
        })(),
        err: window.__bootError ?? null,
      }));
      if (state.ready && state.hidden && state.calls > 10 && state.sized) break;
      console.error(`[shot] ${name} not renderable yet ` +
                    `(ready=${state.ready} calls=${state.calls} sized=${state.sized}` +
                    `${state.err ? ` err=${state.err}` : ''}); retrying (${attempt + 1}/3)`);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        return window.__settle?.(90);
      });
      await page.waitForTimeout(1200);
    }

    const out = has('all') || !arg('out')
      ? resolve(dir, `${name}.png`)
      : resolve(arg('out'));
    if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });

    // Capture, then verify the PNG we actually wrote.
    //
    // Renderer-side checks are not enough: this harness intermittently produces
    // a frame where only a narrow strip down one edge is drawn and the rest is
    // black, while the renderer reports a correctly-sized canvas and a healthy
    // draw-call count. The only thing that reliably detects it is measuring the
    // written image. Reading it back through an <img> works fine — unlike the
    // WebGL canvas, which has no preserveDrawingBuffer and always reads blank.
    let wrote = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.screenshot({ path: out });
      const q = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const W = 160, H = Math.max(1, Math.round(img.height / img.width * W));
        const c = new OffscreenCanvas(W, H);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let dark = 0, n = 0;
        // Column coverage catches the partial-strip case, which a whole-image
        // mean would not: a bright strip can drag the average above any floor.
        const colDark = new Array(W).fill(0);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
            if (l < 12) { dark++; colDark[x]++; }
            n++;
          }
        }
        const deadCols = colDark.filter((c) => c >= H * 0.98).length;
        return { darkFrac: dark / n, deadColFrac: deadCols / W };
      }, readFileSync(out).toString('base64'));

      if (q.darkFrac < 0.6 && q.deadColFrac < 0.25) { wrote = true; break; }
      console.error(`[shot] ${name} came back ${(q.darkFrac * 100).toFixed(0)}% black ` +
                    `(${(q.deadColFrac * 100).toFixed(0)}% dead columns); re-rendering (${attempt}/4)`);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'));
        return window.__settle?.(120);
      });
      await page.waitForTimeout(900);
    }
    if (!wrote) {
      console.error(`[shot] ${name} never produced a usable frame; removing so it ` +
                    `cannot be mistaken for a result`);
      try { unlinkSync(out); } catch { /* nothing written */ }
      continue;
    }

    results.push(out);
    console.log(`shot: ${out}`);
  }

  // Write monotonically: never overwrite an anchor that is already pinned.
  //
  // Several authors run captures concurrently. Each process read the cache at
  // start and wrote its own resolved set at the end, so the last writer won and
  // framings silently drifted between rounds — which quietly weakened every
  // before/after comparison made that day. First resolution wins now, and
  // --refresh-views is the only way to move a framing. Dynamic anchors are
  // never persisted at all.
  {
    let onDisk = {};
    if (existsSync(VIEWS_CACHE)) {
      try { onDisk = JSON.parse(readFileSync(VIEWS_CACHE, 'utf8')); } catch { onDisk = {}; }
    }
    // Carry over anything still pinned only in the old scratch location.
    if (existsSync(LEGACY_VIEWS_CACHE)) {
      try {
        const legacy = JSON.parse(readFileSync(LEGACY_VIEWS_CACHE, 'utf8'));
        for (const [k, v] of Object.entries(legacy)) if (onDisk[k] === undefined) onDisk[k] = v;
      } catch { /* ignore */ }
    }
    const merged = has('refresh-views') ? {} : { ...onDisk };
    for (const [k, v] of Object.entries(resolvedAll)) {
      if (DYNAMIC_ANCHORS.has(k)) continue;
      if (merged[k] === undefined) merged[k] = v;
    }
    for (const k of [...DYNAMIC_ANCHORS]) delete merged[k];

    if (Object.keys(merged).length) {
      mkdirSync(dirname(resolve(VIEWS_CACHE)), { recursive: true });
      // Write via a temp file so a concurrent reader never sees a partial JSON.
      const tmp = resolve(VIEWS_CACHE) + `.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 1));
      renameSync(tmp, resolve(VIEWS_CACHE));
    }
  }

  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    drawCalls: window.__engine?.renderer?.info?.render?.calls ?? null,
    triangles: window.__engine?.renderer?.info?.render?.triangles ?? null,
    textures: window.__engine?.renderer?.info?.memory?.textures ?? null,
  }));
  console.log('stats:', JSON.stringify(stats));
  if (errors.length) console.log('page-errors:', JSON.stringify(errors.slice(0, 8), null, 1));

  await browser.close();
  return results;
}

// Only run when invoked directly. Importing this module for its VIEWS table
// used to fire a whole extra capture and sit on a semaphore slot — it cost one
// author ~20 minutes of a blocked slot before they spotted it.
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

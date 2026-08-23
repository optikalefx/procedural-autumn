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
  // The zoomed-OUT drive shot, and the framing the player's shadow complaint is
  // about. Every other view here is eye level or a vista; none of them is the
  // chase camera at the far end of its wheel, which is where a shadow-map defect
  // is worst — the camera is 22 m up, so Lighting's extent ramp opens the
  // frustum to ~410 m, a texel is 20 cm, and a tree's crown dapple lands at
  // about that size. Posed off CameraRig's own numbers at zoom 48 of 68:
  // restPitch(48) = 0.467 rad, boom height 48*sin = 21.6 m, ground distance
  // 48*cos = 42.8 m, fov 50 - wide*9 = 44.5.
  chase:     { anchor: 'road',     height: 22,  dist: 60,  pitch: -0.42, fov: 45, hour: 16.7, standOff: 43 },
  // Down in the meadow, grass in the foreground.
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  // Forest interior — canopy, trunks, dappled light.
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  // River bank, water in frame.
  // Sits on a shoreline, which is exactly where the grass system grows its
  // tallest reed fringe — at 5 m the camera was inside the reeds.
  river:     { anchor: 'river',    height: 6.0, dist: 30, pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  // The junction: a channel arriving at standing water. The framing this round
  // is actually about, and the one no other view covers — `river` scores dry
  // flowing bank and scores lakes *down*, and hero/peaks are too far off to
  // read a waterline.
  mouth:     { anchor: 'mouth',    height: 5.0, dist: 26, pitch: -0.16, fov: 54, hour: 16.9 },
  // ── the falls ──────────────────────────────────────────────────────────────────────
  //
  // RETUNED, and the waterfall anchor in review/anchors.json with them. Read
  // this before comparing anything here against review/048..051.
  //
  // 1. The pinned anchor had gone stale. It stood at (-787.3, 90.8); the live
  //    `__cameraAnchors.waterfall()` on the shipped bake resolves to
  //    (-743.1, 37.9), seventy metres away. This is the integrator queue item
  //    in docs/WATER_CONTRACT.md item 3 ("the carve follows a smoothed
  //    centreline now, so channels have moved"), never applied.
  //
  //    CORRECTION, and it is the kind docs/CRITIC_PROTOCOL.md's table is
  //    about. This note previously read "the nearest waterfall on the shipped
  //    bake is 657 m away … a critic grading waterfall was grading a
  //    shoreline". That is false and it was checked: on seed 20261018 the
  //    nearest fall to the old anchor is #13 — 42.1 m tall, 4.1 m wide — at
  //    **77.4 m**, which is a framing distance, not a miss. 657 m is what you
  //    get by booting with no `?seed`, which bakes WorldConfig's 20262018 and
  //    puts the falls somewhere else entirely; the tool's own header warns
  //    about exactly that trap two screens down and the note fell into it. The
  //    old framing was bad for reason 2 below, which is measured on the right
  //    world. It was not empty.
  //
  // 2. The anchor is no longer the POI stand-off point. It is the FALL ITSELF
  //    — the foot of the 94 m fall at (-732, 10) on seed 20261018 — and all
  //    four views below are subject framings that orbit it.
  //
  //    The old `waterfall` had no `subject`, so it took the landscape branch
  //    of _pose.mjs: stand ON the anchor, look along its yaw at a fixed pitch.
  //    That branch never reads `lookY` at all — only the subject branch does —
  //    so the aim point was `pitch 0.08` off the horizon and had no knowledge
  //    of where the water was, vertically or horizontally. It is a framing for
  //    a landscape, and a fall is a 40-90 m vertical subject: on the shipped
  //    bake the nearest fall to the old anchor is 77 m away and 46 m tall,
  //    which at that stand-off subtends most of the vertical frame from an aim
  //    point that is not aimed at it. Orbiting the subject cannot have that
  //    failure mode, and the four views can then differ in what they are ABOUT
  //    rather than in where they happen to point.
  //
  //    Consequence for review/anchors.json: since every view below passes its
  //    own `lookY`, the `lookY: 46` stored on the anchor is never read. The
  //    live change is x, z and yaw.
  //
  // 3. yawOffset -0.55 is gone. The yaw already points along the fall; a
  //    32-degree offset on top of it put the water against the left edge.
  //
  // Seed matters here more than anywhere else in this table, because the falls
  // come out of the bake: capture with --seed 20261018, which is the world
  // public/bakes/ holds and WorldConfig.SEED is not, or these anchors frame
  // open hillside again.
  //
  // The whole fall from the bank below it: what a player standing at the foot
  // sees, the drop spanning about two thirds of the frame height.
  waterfall: { anchor: 'waterfall', height: 6,  dist: 112, fov: 45, hour: 16.2, subject: true, lookY: 36 },
  // Down into the base from above. The one framing where the plunge — boil,
  // foam ring, spray, wet rock — is the subject rather than a detail at the
  // bottom of a tall thin thing.
  plunge:    { anchor: 'waterfall', height: 30, dist: 72,  fov: 45, hour: 16.2, subject: true, lookY: 6 },
  // Tight on the foot at eye level, at the range a player driving the valley
  // floor actually gets.
  fallbase:  { anchor: 'waterfall', height: 4,  dist: 34,  fov: 50, hour: 16.2, subject: true, lookY: 5 },
  // Tight on the crest, long lens. A lip that simply switches the water on is
  // as bad a tell as a base that simply stops, and nothing in this harness has
  // ever framed one.
  falllip:   { anchor: 'waterfall', height: 30, dist: 78,  fov: 20, hour: 16.2, subject: true, lookY: 76 },
  // High peaks and aerial perspective.
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  // The vehicle, three-quarter hero framing.
  vehicle:   { anchor: 'vehicle',  height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0, subject: true },
  // Golden-hour backlit shot — the money frame for foliage translucency.
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  // The same key, over water. `backlit` is anchored on `meadow` and has no
  // water in frame at all, so every translucent thing that grows at a
  // waterline — the reed and sedge stands, the lace, spray — has never once
  // been judged against a low sun, which is the only light that shows them.
  // The banks author had to verify its stands by hand at `--view mouth
  // --hour 17.9` because the harness had no framing for it.
  backwater: { anchor: 'mouth',    height: 2.2, dist: 14,  pitch: 0.02,  fov: 54, hour: 17.9, faceSun: true },
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
// Which car is parked in the frame. Pinned by default so two captures of the
// same view are comparable; --car roamer for the other one.
const CAR = arg('car', 'camper');
const params = new URLSearchParams();
if (RES) params.set('res', RES);
if (QUALITY) params.set('quality', QUALITY);
if (SEED) params.set('seed', SEED);
if (CAR) params.set('car', CAR);
const qs = params.toString();
const URL = arg('url', (process.env.AUTUMN_URL || 'http://localhost:5178')) + (qs ? `?${qs}` : '');
const TIMEOUT = parseInt(arg('timeout', '180000'), 10);
// Scene groups to hide before capture, by name — Trees, Grass, GroundCover,
// Rocks, Wildlife, Camp, Water. See the note at the call site.
const HIDE = typeof arg('hide') === 'string' ? arg('hide').split(',').map((s) => s.trim()).filter(Boolean) : [];
// Also write <view>-nowater.png per view. See the note at the call site.
const WATERDIFF = has('waterdiff');
// Extra frames of the same pose, for the crawl measurement. Needs --waterdiff.
const FRAMES = parseInt(arg('frames', '0'), 10) || 0;

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

  // ── pin quality and resolution for the whole run ────────────────────────
  //
  // Engine now steps the quality tier down on its own, and it is gated on
  // `!navigator.webdriver` so it cannot fire under automation. `adaptive` — the
  // RESOLUTION ladder — is not gated, and nothing here set either.
  //
  // At dpr 1 that was harmless by accident: the rungs collapse to [1] and
  // nothing can move. At dpr 2 a slow capture still walks the resolution down
  // to 0.667 mid-run, and this project does capture at dpr 2. A plate taken at
  // two thirds resolution against a baseline taken at full is not a comparison,
  // and nothing in the output would say so. Six separate instruments in this
  // round produced clean, confident, wrong numbers; this is the same shape of
  // failure one layer down, so pin it explicitly rather than relying on a
  // collapse that only holds at one dpr.
  await page.evaluate(() => {
    const e = window.__engine;
    if (!e) return;
    e.autoQuality = false;   // no tier change
    e.adaptive = false;      // no resolution ladder — `_adapt` returns immediately
    e.resolutionScale = 1;
  });

  // --views a,b,c captures a named subset in ONE page load. Every invocation of
  // this tool re-bakes the world (~25 s at full res), so capturing four
  // framings as four processes pays that four times and, worse, serialises
  // behind the capture lock. A subset is the common case for a system author:
  // the water round wants river/mouth/backwater/waterfall and nothing else.
  const viewList = arg('views', null);
  const views = has('all')
    ? Object.keys(VIEWS)
    : (typeof viewList === 'string'
        ? viewList.split(',').map((s) => s.trim()).filter(Boolean)
        : [arg('view', 'hero')].filter(Boolean));

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
          const ty = wd.getHeight(anchor.x, anchor.z) + (v.lookY ?? anchor.lookY ?? 1.4);
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

      // Let streaming, LOD and any temporal effects settle. Convergence, not a
      // frame count — see __settleStable in main.js. A fixed 60 frames left
      // every batch view at roughly half its triangles.
      if (window.__settleStable) window.__settleReport = await window.__settleStable();
      else if (window.__settle) await window.__settle(60);
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

    // --hide Trees,Grass,GroundCover
    //
    // Not a cheat: a measurement of a shoreline that is 70% hidden behind
    // birch trunks is a measurement of birch trunks. tools/wedge.mjs finds the
    // waterline by colour, and in the `river` framing the boundary it found was
    // mostly canopy silhouette — a hard alpha-tested edge, which it duly
    // reported as an aliased waterline. Hiding the occluders does not move the
    // shoreline by a millimetre; it is the only way to see the whole of it.
    // Keep it OUT of any frame that is judged for LOOK.
    if (HIDE.length) {
      await page.evaluate((names) => {
        for (const n of names) {
          const o = window.__engine.scene.getObjectByName(n);
          if (o) o.visible = false;
        }
        return window.__settle?.(30);
      }, HIDE);
      await page.waitForTimeout(400);
    }

    // ── --waterdiff: freeze the clock so the PAIR is exact ──────────────────
    //
    // The water frame and the water-hidden frame have to differ by the water
    // and by nothing else. Captured a few hundred milliseconds apart with the
    // engine running, they also differ by every other animated thing in the
    // scene — and the clouds are the killer. Their drift makes the whole sky a
    // difference, which is one enormous connected component, and on `river` it
    // touched the water and merged with it: the largest component in the frame
    // was 210 383 px of sky-plus-river, it touched row 0, it was correctly
    // rejected as sky, and tools/wedge.mjs then reported 0.38% of a frame with
    // a river across the middle of it.
    //
    // Hiding the clouds fixes that one confound and not the class. Stopping the
    // engine and calling its render path directly with dt = 0 fixes the class:
    // no updater runs, so clouds, leaves, ripples and the sun are all bit-
    // identical between the two, and the difference IS the water.
    if (WATERDIFF) {
      await page.evaluate(() => {
        const e = window.__engine;
        e.stop();
        window.__frozenDraw = () => {
          if (e._render) e._render(0, e.elapsed);
          else e.renderer.render(e.scene, e.camera);
        };
        window.__frozenDraw();
      });
      await page.waitForTimeout(120);
    }

    const out = has('all') || views.length > 1 || !arg('out')
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
        if (window.__frozenDraw) { window.__frozenDraw(); return null; }
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

    // ── --waterdiff: the water's own contribution, exactly ──────────────────
    //
    // tools/wedge.mjs used to find the waterline with a colour rule, and a
    // colour rule cannot tell water from pale cool rock: on `waterfall` it
    // found the cliff face and reported twelve percent of it as a jagged
    // shoreline. There is no threshold that fixes that, because the two really
    // are the same colour.
    //
    // So do not guess. Capture the same pose twice, once with the Water group
    // hidden, and difference them. Every pixel the water changed IS a water
    // pixel, weighted by exactly the alpha it was composited with — which makes
    // the difference a true antialiased coverage field rather than a
    // thresholded mask, and makes the extracted waterline the real one, to the
    // sub-pixel.
    //
    // Time advances between the two frames, so anything else that MOVES also
    // differs. Capture with --hide Trees,Grass,GroundCover,Weather and the only
    // animated thing left in frame is the water itself.
    if (WATERDIFF) {
      const nw = out.replace(/\.png$/, '-nowater.png');
      await page.evaluate(() => {
        const o = window.__engine.scene.getObjectByName('Water');
        if (o) o.visible = false;
        window.__frozenDraw();
      });
      await page.waitForTimeout(200);
      await page.screenshot({ path: nw });
      console.log(`shot: ${nw}`);
      // Water back, clock back. The --frames sequence below needs time to run.
      await page.evaluate(() => {
        const o = window.__engine.scene.getObjectByName('Water');
        if (o) o.visible = true;
        window.__frozenDraw();
        window.__frozenDraw = null;
        window.__engine.start();
      });
      await page.waitForTimeout(200);

      // ── --frames N: the same pose, over time, for tools/wcrawl.mjs ────────
      //
      // A still frame cannot tell a clean shoreline from one that is clean in
      // that instant and crawling in the next. The waterline is decided by
      // geometry, and the geometry does not move — the vertex swell is two
      // centimetres and is faded to nothing at the bank — so a waterline that
      // MOVES between two frames of a static camera is moving because
      // something about how it is computed is unstable at the pixel, which is
      // exactly the failure that survives a good-looking capture.
      //
      // EVERY frame gets its own water-hidden twin, captured at the same frozen
      // instant. The first version captured one twin and differenced the whole
      // sequence against it, and that is a real bias, not a nicety: frame 0 and
      // its twin were an exact frozen pair, but t1..t5 were captured with the
      // engine RUNNING, so anything that changed between the frozen and running
      // states read as a coverage change over the entire body. Measured both
      // ways on the same pose by a critic: `mouth` 0.20% with per-step pairing
      // against 0.43% reusing one (2.1x), `river` 3.6% -> 5.9% (1.6x). The
      // round's headline temporal number was inflated by its own harness.
      for (let f = 1; f <= FRAMES; f++) {
        // Let time advance with the engine running, then freeze again so the
        // pair is exact. The advance is what the measurement is OF.
        await page.evaluate(() => window.__engine.start());
        await page.waitForTimeout(240);
        await page.evaluate(() => {
          const e = window.__engine;
          e.stop();
          window.__frozenDraw = () => {
            if (e._render) e._render(0, e.elapsed);
            else e.renderer.render(e.scene, e.camera);
          };
          window.__frozenDraw();
        });
        await page.waitForTimeout(80);
        const fp = out.replace(/\.png$/, `-t${f}.png`);
        await page.screenshot({ path: fp });
        await page.evaluate(() => {
          const o = window.__engine.scene.getObjectByName('Water');
          if (o) o.visible = false;
          window.__frozenDraw();
        });
        await page.waitForTimeout(80);
        await page.screenshot({ path: fp.replace(/\.png$/, '-nowater.png') });
        await page.evaluate(() => {
          const o = window.__engine.scene.getObjectByName('Water');
          if (o) o.visible = true;
          window.__frozenDraw();
        });
        console.log(`shot: ${fp}`);
      }
      await page.evaluate(() => { window.__frozenDraw = null; window.__engine.start(); });
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

  // `quality` and `resScale` are printed on EVERY run, unconditionally, because
  // a plate captured at two thirds resolution or a tier down against a baseline
  // taken at full is not a comparison and nothing else in the output would say
  // so. They are pinned above; this is the proof, not the intention.
  const stats = await page.evaluate(() => ({
    fps: window.__fps ?? null,
    drawCalls: window.__engine?.renderer?.info?.render?.calls ?? null,
    triangles: window.__engine?.renderer?.info?.render?.triangles ?? null,
    textures: window.__engine?.renderer?.info?.memory?.textures ?? null,
    quality: window.__engine?.quality ?? null,
    resScale: window.__engine?.resolutionScale ?? null,
  }));
  console.log('stats:', JSON.stringify(stats));
  if (stats.quality !== 'ultra' || Math.abs((stats.resScale ?? 1) - 1) > 1e-3) {
    console.error(`[shot] !! captured at quality=${stats.quality} resScale=${stats.resScale} — ` +
                  `NOT comparable with a baseline taken at ultra / 1.0`);
  }
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

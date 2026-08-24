// ─────────────────────────────────────────────────────────────────────────────
//  Camping Season — entry point.
//
//  main.js owns *integration only*. Every world system lives in its own module
//  behind the System interface (src/core/System.js) and is constructed here in
//  a fixed order. System authors never edit this file.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { posthog } from './posthog.js';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { WORLD, SEED, QUALITY_PRESETS, AUTOPICK_REFERENCE_RATIO } from './world/WorldConfig.js';
import { WorldData } from './world/WorldData.js';
import { PointsOfInterest } from './world/PointsOfInterest.js';
import { decodeBake, bakeFilename, sourceHash } from './world/bakeFormat.js';
// Raw source of the generator, purely so the bake cache key tracks it.
import terrainGenSource from './world/TerrainGen.js?raw';

const GEN_HASH = sourceHash(terrainGenSource);
import { Terrain } from './world/Terrain.js';
import { Atmosphere } from './render/Atmosphere.js';
import { Stylize } from './render/Stylize.js';
import { setOcclusionSubject } from './render/Occlusion.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';
import { Sky } from './sky/Sky.js';
import { PerfOverlay } from './ui/PerfOverlay.js';
import { TouchControls, touchCapable } from './ui/TouchControls.js';

// ── world systems, in construction order ─────────────────────────────────────
import { Clouds }      from './sky/Clouds.js';
import { Weather }     from './sky/Weather.js';
import { Rocks }       from './rocks/Rocks.js';
import { Water }       from './world/Water.js';
import { Waterfalls }  from './world/Waterfalls.js';
import { Trees }       from './vegetation/Trees.js';
import { GroundCover } from './vegetation/GroundCover.js';
import { Grass }       from './vegetation/Grass.js';
import { Wildlife }    from './wildlife/Wildlife.js';
import { Vehicle }     from './vehicle/Vehicle.js';
import { Boat }        from './boat/Boat.js';
import { Camp }        from './camp/Camp.js';
import { CameraRig }   from './vehicle/CameraRig.js';
import { Audio }       from './audio/Audio.js';
import { HUD }         from './ui/HUD.js';
import { Stats }       from './game/Stats.js';

const SYSTEMS = [
  ['clouds',      Clouds],
  ['weather',     Weather],
  ['rocks',       Rocks],
  ['water',       Water],
  ['waterfalls',  Waterfalls],
  ['trees',       Trees],
  ['groundCover', GroundCover],
  ['grass',       Grass],
  ['wildlife',    Wildlife],
  ['vehicle',     Vehicle],
  // After Vehicle (Boat reads `vehicle.brakeHold` and the camper's pose on the
  // frame they are written) and BEFORE Camp: Camp arbitrates clicks against
  // `boat.pointerClaim`, and registering Boat first makes that claim
  // same-frame rather than a frame stale. See Camp._interact.
  ['boat',        Boat],
  // After Vehicle: Camp reads `vehicle.brakeHold` and the camper's position on
  // the same frame they are written, and before CameraRig so the reticle has
  // been placed by the time the boom decides what it is looking at.
  ['camp',        Camp],
  ['cameraRig',   CameraRig],
  ['audio',       Audio],
  ['hud',         HUD],
  // Last, and that IS its contract: Stats only watches, so everything it
  // samples has already run this frame. See src/game/Stats.js.
  ['stats',       Stats],
];

const loaderEl = document.getElementById('loader');
const barEl = document.querySelector('#bar > i');
const statusEl = document.getElementById('status');
const setProgress = (p, label) => {
  if (barEl) barEl.style.width = `${Math.round(Math.min(1, p) * 100)}%`;
  if (label && statusEl) statusEl.textContent = label;
};

/**
 * Choose a quality tier from what the machine has to do, not only from what it
 * has.
 *
 * The original version looked at memory and core count alone, so a Retina
 * laptop was handed `ultra` no matter how many pixels its display demanded —
 * and the renderer then drew up to four times the pixels the tier was tuned
 * against. The player's machine reported eight cores, took `ultra`, and ran at
 * 4 fps. Pixel load belongs in this decision.
 */
function pickQuality() {
  const q = new URLSearchParams(location.search).get('quality');
  if (q && QUALITY_PRESETS[q]) return q;

  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;

  // Megapixels this display would ask for, using the window rather than the
  // screen — a small window on a big monitor is cheap.
  //
  // Measured against AUTOPICK_REFERENCE_RATIO, NOT against Ultra's cap. It used
  // to read Ultra's cap, which was fine while that cap was 1.5 and Ultra was a
  // tier the picker could reasonably hand out. Ultra now means native (2.0), and
  // leaving this reading it doubled every megapixel figure and silently walked
  // the DEFAULT tier on a Retina laptop from high down to medium — a change
  // nobody asked for, in the name of a tier the picker is no longer going to
  // choose. The thresholds below were calibrated against 1.5; the yardstick
  // stays 1.5.
  const cssPx = (window.innerWidth || 1280) * (window.innerHeight || 720);
  const dpr = Math.min(window.devicePixelRatio || 1, AUTOPICK_REFERENCE_RATIO);
  const megapixels = (cssPx * dpr * dpr) / 1e6;

  let tier = mem >= 8 && cores >= 8 ? 'ultra'
           : mem >= 6 && cores >= 6 ? 'high'
           : cores >= 4 ? 'medium'
           : 'low';

  // Step down for heavy pixel loads. Adaptive resolution is an emergency
  // margin, not a substitute for choosing an affordable effect tier: it has a
  // firm 0.90 effective-ratio floor to keep a large display from turning soft.
  const ORDER = ['ultra', 'high', 'medium', 'low'];
  let steps = 0;
  if (megapixels > 6.0) steps = 2;
  else if (megapixels > 3.5) steps = 1;
  if (steps) tier = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + steps)];

  // Ultra is opt-in on any display where it means something expensive.
  //
  // Ultra is now "one rendered pixel per device pixel", measured at roughly 2x
  // the frame cost of the tier it replaced. Handing that to any machine that
  // merely reports 8 cores is the exact failure `pickQuality` exists to prevent
  // — a player ran this game at 4 fps because a Retina laptop was auto-assigned
  // a tier tuned at deviceScaleFactor 1. A player who wants native picks it, and
  // the Resolution slider is there for the finer grip.
  //
  // On a 1x display none of that applies: `min(1, 2.0)` is 1.0, so Ultra costs
  // exactly what it always did there and the picker may still choose it.
  //
  // AFTER the pixel-load step-down, not before: run first, this clamps Ultra to
  // High and then the step-down demotes that AGAIN, stacking two cuts into one.
  // A 1728x1000 Retina window came out at `medium` where it had always been
  // `high` — caught by tabulating the picker's real output at three viewports.
  const clamped = tier === 'ultra' && (window.devicePixelRatio || 1) > 1;
  if (clamped) tier = 'high';

  console.log(`[quality] ${tier} — ${megapixels.toFixed(2)} MP at dpr ${dpr}, ` +
              `${cores} cores, ${mem} GB` + (steps ? ` (stepped down ${steps} for pixel load)` : '') +
              (clamped ? ' (ultra is opt-in above dpr 1)' : ''));
  return tier;
}

/** 'PAB1', little-endian — the first four bytes of every valid bake. */
const MAGIC = 0x31424150;

/** Where a bake for this (seed, res) lives, on the network and in the cache. */
const bakeUrl = (seed, res) => `/${bakeFilename(seed, res, GEN_HASH)}`;

/**
 * Persist live-baked worlds, so a seed is generated at most once per device.
 *
 * Only the seed the deploy baked ships as a file. Anything else — the Seed box
 * in settings, a shared `?seed=` link — has no file to fetch, so every load
 * paid a full worker bake: 72 s measured on production, and paid again on
 * every reload and every return visit. A player who finds a valley they like
 * and bookmarks it was the worst case.
 *
 * The key is the same URL the network path would have used, so the generator
 * hash is already baked into it and a change to TerrainGen.js orphans these
 * entries rather than serving a world from the previous algorithm. `pruneBakes`
 * then collects them.
 *
 * Entries are gzipped: a world is 44.5 MB raw and 17.3 MB gzipped, and this is
 * the player's disk, not ours. The whole layer is best-effort — no cache, an
 * insecure context, a full disk and a corrupt entry all degrade to the bake
 * that would have happened anyway.
 */
const BAKE_CACHE = 'pab-bakes-v1';
const BAKE_CACHE_KEEP = 3;

/** null whenever caching is unavailable, which is not an error. */
async function openBakeCache() {
  // `caches` needs a secure context, and the streams need a browser new enough
  // to have them; the game's WebGL2/WASM floor is well above both, but a file://
  // open or an http:// LAN address would land here.
  if (typeof caches === 'undefined' || typeof CompressionStream === 'undefined') return null;
  try { return await caches.open(BAKE_CACHE); } catch { return null; }
}

async function readBakeCache(url) {
  const cache = await openBakeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit?.body) return null;
    const buf = await new Response(hit.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    // Same standard as the network path: believe the format, not the envelope.
    // A half-written entry from a tab closed mid-store lands here.
    if (buf.byteLength >= 4 && new DataView(buf).getUint32(0, true) === MAGIC) return buf;
    await cache.delete(url);
    return null;
  } catch { return null; }
}

async function writeBakeCache(url, buf) {
  const cache = await openBakeCache();
  if (!cache) return;
  try {
    const t0 = performance.now();
    const gz = await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await cache.put(url, new Response(gz));
    await pruneBakes(cache);
    console.log(`[world] cached this bake (${(gz.byteLength / 1048576).toFixed(1)} MB gzipped, ` +
                `${(performance.now() - t0).toFixed(0)} ms) — this seed will load instantly from now on`);
  } catch (e) {
    // QuotaExceededError is the expected one. Nothing is broken; the next load
    // of this seed simply bakes again.
    console.warn(`[world] could not cache this bake (${e.name}) — this seed will bake again next time`);
  }
}

/** Drop other generator hashes outright, then trim to the newest KEEP seeds. */
async function pruneBakes(cache) {
  const keys = await cache.keys();          // insertion order, oldest first
  const live = [];
  for (const k of keys) {
    if (k.url.includes(GEN_HASH)) live.push(k);
    else await cache.delete(k);
  }
  for (const k of live.slice(0, Math.max(0, live.length - BAKE_CACHE_KEEP))) await cache.delete(k);
}

/**
 * Load a pre-baked world if one exists, otherwise bake in a worker.
 *
 * Baking costs ~25 s of CPU. During development that is paid on every reload
 * and on every headless capture, which is the single largest cost in the whole
 * project. `node tools/bake.mjs` writes the result to public/bakes/ and this
 * picks it up; ?nocache=1 forces a live bake.
 */
async function loadCachedBake(seed, res) {
  if (new URLSearchParams(location.search).has('nocache')) return null;
  try {
    const t0 = performance.now();

    // A world this device has already baked, from a seed the deploy does not
    // ship. Checked before the network because for those seeds there is no
    // file to find — the fetch below would only rediscover that.
    const stored = await readBakeCache(bakeUrl(seed, res));
    if (stored) {
      setProgress(0.30, 'Loading the valley');
      return { data: decodeBake(stored), ms: performance.now() - t0, cached: true, fromDevice: true };
    }

    // `r.ok` is NOT an existence test, and a cache hit is not a valid bake.
    //
    // A dev server answers a missing path with index.html at status 200, so a
    // bake that is not there yet returns `ok` with a body of HTML. Worse, this
    // request used `cache: 'force-cache'`, so that HTML got stored under the
    // bake's own URL and was then served from cache forever — including after
    // `tools/bake.mjs` had written the real file. The symptom is a permanent
    // "cached bake unusable, baking live: not a Camping Season bake" and a
    // 35-50 s live bake on EVERY load, on a machine that has a perfectly good
    // bake sitting on disk. Verified by hand: the .pab over HTTP begins `PAB1`
    // and is byte-identical to the file, while the running page was still
    // reporting the cache unusable.
    //
    // So: read the first four bytes and require the format's own magic before
    // believing any response, and on a miss retry once with `cache: 'reload'`
    // to evict a poisoned entry rather than inheriting it for the session.
    const tryBake = async (u) => {
      for (const mode of ['force-cache', 'reload']) {
        let resp;
        try { resp = await fetch(u, { cache: mode }); } catch { return null; }
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        if (buf.byteLength >= 4 && new DataView(buf).getUint32(0, true) === MAGIC) return buf;
        // Not a bake. If that came from the cache, one reload may still find
        // the real file; if it came from the network, the file is genuinely
        // not there and the caller should fall back.
        if (mode === 'reload') return null;
      }
      return null;
    };

    // Same-origin: dev serves public/bakes/ and production ships the same
    // files in dist/, baked during the deploy build. See docs/DEPLOY.md.
    let url = bakeUrl(seed, res);
    let stale = false;
    let buf = await tryBake(url);

    if (!buf) {
      // Exact generator hash missing — most likely someone is mid-edit on
      // TerrainGen.js. Fall back to the newest bake for this (seed, res) so
      // other authors keep fast captures, but flag it loudly.
      const man = await fetch('/bakes/manifest.json', { cache: 'no-store' }).then((x) => x.ok ? x.json() : null).catch(() => null);
      const alt = man?.entries?.find((e) => e.seed === seed && e.res === res);
      if (!alt) return null;
      url = `/bakes/${alt.file}`;
      stale = true;
      buf = await tryBake(url);
      if (!buf) return null;
      console.warn(`[world] STALE BAKE: generator is ${GEN_HASH}, using ${alt.hash}. ` +
                   `Run "node tools/bake.mjs --force" to refresh, or add ?nocache=1 to bake live.`);
    }

    setProgress(0.30, 'Loading the valley');
    const data = decodeBake(buf);
    return { data, ms: performance.now() - t0, cached: true, stale };
  } catch (e) {
    console.warn('[world] cached bake unusable, baking live:', e.message);
    return null;
  }
}

function bakeWorld(seed, res) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world/worldWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(e.data.p * 0.62, e.data.label);
      else if (e.data.type === 'done') { worker.terminate(); resolve(e.data); }
    };
    worker.onerror = reject;
    worker.postMessage({ res, worldSize: WORLD.size, seed, maxAltitude: WORLD.maxAltitude });
  });
}

async function boot() {
  const canvas = document.getElementById('gl');
  const quality = pickQuality();
  const engine = new Engine(canvas, quality);
  const input = new Input();

  const params = new URLSearchParams(location.search);
  const seed = parseInt(params.get('seed') ?? SEED, 10);
  const res = parseInt(params.get('res') ?? WORLD.heightmapRes, 10);

  setProgress(0.02, 'Raising mountains');
  let baked = await loadCachedBake(seed, res);
  if (!baked) {
    baked = await bakeWorld(seed, res);
    // Deliberately not awaited: gzipping 44 MB must not stand between the
    // player and the first frame of a world they have already waited a minute
    // for. It settles during startup and is only read on a later load.
    if (baked.encoded) writeBakeCache(bakeUrl(seed, res), baked.encoded);
  }
  const source = baked.fromDevice ? 'loaded bake cached on this device'
               : baked.cached ? 'loaded cached bake' : 'baked live';
  console.log(`[world] ${source} in ${baked.ms.toFixed(0)} ms (gen ${GEN_HASH})`);
  window.__bakeCached = !!baked.cached;
  window.__bakeFromDevice = !!baked.fromDevice;
  window.__bakeStale = !!baked.stale;
  if (baked.stale) console.warn('[world] rendering a STALE terrain bake');

  setProgress(0.66, 'Reading the water');
  const world = new WorldData(baked.data, seed);
  const poi = new PointsOfInterest(world, seed);

  setProgress(0.70, 'Lighting the valley');
  // Stylize patches Three's lighting chunk, so it must exist before any
  // material is compiled.
  const stylize = new Stylize(engine.scene);
  const atmosphere = new Atmosphere(engine.scene);
  const lighting = new Lighting(engine.scene, quality);
  const sky = new Sky(engine.scene);
  const terrain = new Terrain(world, engine.scene, {
    detailDistance: QUALITY_PRESETS[quality].terrainDetailDistance,
  });
  const postfx = new PostFX(engine, quality);

  const ctx = {
    THREE, engine, input,
    scene: engine.scene, camera: engine.camera, renderer: engine.renderer,
    world, poi, terrain, atmosphere, stylize, lighting, sky, postfx,
    quality, preset: QUALITY_PRESETS[quality],
    systems: {},
  };

  // ── construct + init every system ──────────────────────────────────────────
  const built = [];
  for (let i = 0; i < SYSTEMS.length; i++) {
    const [name, Ctor] = SYSTEMS[i];
    let inst;
    try {
      inst = new Ctor(ctx);
      ctx.systems[name] = inst;
      built.push([name, inst]);
    } catch (e) {
      console.error(`[system:${name}] construct failed`, e);
      continue;
    }
    setProgress(0.72 + 0.22 * (i / SYSTEMS.length), inst.loadLabel ?? `Building ${name}`);
    try {
      await inst.init?.();
    } catch (e) {
      console.error(`[system:${name}] init failed`, e);
      inst.enabled = false;
    }
  }

  // Quality changes propagate to every system that implements onQuality.
  engine.onQuality((preset, name) => {
    for (const [n, s2] of built) {
      if (!s2.enabled || !s2.onQuality) continue;
      try { s2.onQuality(preset, name); }
      catch (e) { console.error(`[system:${n}] onQuality threw`, e); }
    }
    postfx.onQuality?.(preset, name);
    lighting.onQuality?.(preset, name);
    terrain.onQuality?.(preset, name);
  });

  // ── camera: systems may take over via ctx.systems.cameraRig ───────────────
  const cam = engine.camera;
  const startPoi = poi.best('road') ?? poi.best('meadow') ?? { x: 0, z: 0 };
  cam.position.set(startPoi.x, world.getHeight(startPoi.x, startPoi.z) + 14, startPoi.z + 30);
  cam.lookAt(startPoi.x, world.getHeight(startPoi.x, startPoi.z) + 2, startPoi.z);
  const fly = { yaw: Math.PI, pitch: -0.16, speed: 34 };

  setProgress(0.96, 'Warming the shaders');
  for (let i = 0; i < 20; i++) terrain.update(cam, 30);
  atmosphere.harvest();
  // Whether matte surfaces compile without the physical specular lobe — see
  // Stylize.setMatteSpecular. Set BEFORE harvest, so every material is compiled
  // the right way the FIRST time and the change costs no recompile at boot.
  //
  // OFF, and the reason is a measurement rather than taste: switching it on
  // was priced at 0.70 ms +/- 0.75 of a 28.4 ms frame, i.e. inside its own
  // noise (`node tools/ablate.mjs --only fx.physicalSpec`). It is kept and
  // reachable as `?matte=1` because the machinery is what proved the number,
  // and because it is the thing to re-price if the shading budget ever moves.
  stylize.matte = new URLSearchParams(location.search).get('matte') === '1';
  stylize.harvest();
  stylize.update();
  // EffectComposer's scene target is linear while the renderer itself remains
  // configured for an sRGB canvas. A plain renderer.compile() only warms the
  // direct-to-canvas combination, so every material that was invisible during
  // the one warm draw (pooled wildlife, tyre tracks, distant streamed effects)
  // compiled the mixed linear-target/sRGB-renderer variant the first time it
  // appeared in play. On ANGLE/Metal that was a repeatable 200–270 ms hitch.
  // Compile the direct path as before. For the linear-target combination, ask
  // only systems that own invisible or unattached variants to present those
  // materials. Compiling the entire scene twice added dozens of variants and
  // a long loading pause merely to warm surfaces the real post draw below will
  // already touch.
  engine.renderer.compile(engine.scene, cam);
  const previousTarget = engine.renderer.getRenderTarget();
  const linearTarget = new THREE.WebGLRenderTarget(1, 1);
  try {
    engine.renderer.setRenderTarget(linearTarget);
    for (const [, system] of built) system.precompileMaterials?.();
  } finally {
    engine.renderer.setRenderTarget(previousTarget);
    linearTarget.dispose();
  }

  engine.setRenderCallback((dt) => postfx.render(dt));

  // ── internal render scale ───────────────────────────────────────────────
  // The scene and post chain render at this fraction of the canvas and are
  // reconstructed by PostFX's Catmull-Rom + CAS present pass (UpscalePass.js).
  // Start at the policy's preferred effective ratio (1.25 device pixels per
  // CSS pixel), while PRESENTING at the tier's full pixelRatioCap. That is a
  // visibly sharper starting point than the original 1.0 default without
  // paying for the full 1.35–1.5 cap. On a 1x display this clamps to 1.0.
  //
  // `?iscale=` pins it for A/Bs and captures; the adaptive scaler in Engine
  // moves it between the sharpness floor and this preferred ceiling in play.
  engine.onInternalScale = (s) => postfx.setInternalScale(s);
  // `?pixelratio=` is the manual pin the settings panel drives, exposed as a
  // param so a capture or an A/B can ask for the same thing without a click.
  // It is the effective device-pixel ratio; `native` means the display's own.
  const prParam = params.get('pixelratio');
  if (prParam) {
    engine.setResolutionPin(prParam === 'native'
      ? engine.nativePixelRatio() : parseFloat(prParam));
  }
  const iscale = parseFloat(params.get('iscale'));
  if (Number.isFinite(iscale)) {
    // Pinned for a capture or an A/B: bypass the sharpness floor and freeze
    // the scaler, so the frame measured is the frame asked for.
    engine.adaptive = false;
    engine.internalScale = iscale;
    postfx.setInternalScale(iscale);
  } else if (engine.resolutionPin) {
    // Pinned, by `?pixelratio=` above or by a setting the HUD restored during
    // its init. The pin renders the chain at the full canvas, so there is no
    // starting rung to choose — just make sure the post graph agrees.
    postfx.setInternalScale(1);
  } else {
    engine.setInternalScale(
      Math.min(1, engine.preferredEffectiveInternalRatio / engine.basePixelRatio),
    );
  }

  // Compile and allocate the post graph behind the loading screen. A scene-only
  // renderer.compile() does not touch EffectComposer or shadow materials; the
  // first playable frame was therefore paying 200–320 ms program/link spikes.
  // Systems with pooled hidden casters can expose one only for this real draw.
  // Aim the shadow camera at the actual starting frame first, then restore every
  // warm-only object before the engine or loading transition begins.
  lighting.update(0, cam.position);
  const restoreWarmFrame = built.map(([, system]) => system.beginWarmFrame?.())
    .filter((restore) => typeof restore === 'function');
  try {
    postfx.render(0);
  } finally {
    for (let i = restoreWarmFrame.length - 1; i >= 0; i--) restoreWarmFrame[i]();
  }
  engine.renderer.info.reset();

  // ── world pause ───────────────────────────────────────────────────────────
  // Photo mode freezes the world by setting `ctx.worldPaused`. Every world
  // system still gets CALLED — streaming keeps following the camera, so trees
  // and grass exist wherever the free camera goes — but with dt 0 and a world
  // clock that has stopped, so nothing integrates and every shader-time
  // animation holds its frame. `worldT` is that clock: it accumulates exactly
  // the engine's elapsed time while running and stands still while paused, so
  // on resume every animation continues from the pose it froze in instead of
  // snapping to wherever the wall clock went.
  //
  // Four systems are exempt and run on real time: the camera rig (composing
  // the shot is the point of the pause), audio (the music keeps playing), the
  // HUD (it owns the controls doing the pausing) and stats (it only watches).
  const LIVE_WHILE_PAUSED = new Set(['cameraRig', 'audio', 'hud', 'stats']);
  let worldT = 0;

  engine.onUpdate((dt, t) => {
    const wdt = ctx.worldPaused ? 0 : dt;
    worldT += wdt;
    const rig = ctx.systems.cameraRig;
    const rigActive = rig?.enabled && rig.active;

    if (!window.__forceCamera && !rigActive) {
      // Developer fly camera — active until a CameraRig takes over.
      const sp = fly.speed * (input.key('ShiftLeft') ? 4.5 : 1) * dt;
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(cam.rotation);
      const right = new THREE.Vector3(1, 0, 0).applyEuler(cam.rotation);
      if (input.key('KeyW')) cam.position.addScaledVector(fwd, sp);
      if (input.key('KeyS')) cam.position.addScaledVector(fwd, -sp);
      if (input.key('KeyA')) cam.position.addScaledVector(right, -sp);
      if (input.key('KeyD')) cam.position.addScaledVector(right, sp);
      if (input.key('KeyQ')) cam.position.y -= sp;
      if (input.key('KeyE')) cam.position.y += sp;
      if (input.mouse.down) {
        fly.yaw -= input.mouse.dx * 0.0026;
        fly.pitch = THREE.MathUtils.clamp(fly.pitch - input.mouse.dy * 0.0026, -1.45, 1.45);
      }
      cam.rotation.set(fly.pitch, fly.yaw, 0, 'YXZ');
    }

    lighting.update(wdt, cam.position);

    if (lighting.fogNear) {
      atmosphere.params.nearColor.copy(lighting.fogNear);
      atmosphere.params.farColor.copy(lighting.fogFar);
      atmosphere.params.sunColor.copy(lighting.fogSun);
      atmosphere.params.density = lighting.fogDensity;
    }
    if ((engine.frame & 15) === 0) { atmosphere.harvest(); stylize.harvest(); }
    stylize.update();
    atmosphere.update(lighting.sunDir, lighting.sun.color, lighting.sunDir.y);

    sky.update(wdt, worldT, cam, lighting.sunDir);
    terrain.setSunDir(lighting.sunDir);
    terrain.setTime(worldT);
    terrain.update(cam, 3.0);

    for (const [name, s] of built) {
      if (!s.enabled) continue;
      try { s.update(LIVE_WHILE_PAUSED.has(name) ? dt : wdt, worldT); }
      catch (e) { console.error(`[system:${name}] update threw`, e); s.enabled = false; }
    }

    // ── camera occlusion ────────────────────────────────────────────────────
    // Tell the near-camera volume that we are driving. It no longer aims at the
    // camper — nothing in its shape depends on where the camper is — so this is
    // purely the switch that says "this is the chase camera", and it stays here
    // rather than in the helper because it is the one thing in
    // render/Occlusion.js that needs a world system. The fly camera and every
    // landscape capture hand in nothing and the effect switches off.
    // CameraRig would be a tidier owner — see docs/INTEGRATION_REQUESTS.md.
    const veh = ctx.systems.vehicle;
    setOcclusionSubject(cam, veh?.enabled ? veh.position : null);
  });

  engine.onLateUpdate((dt, t) => {
    const wdt = ctx.worldPaused ? 0 : dt;
    for (const [name, s] of built) {
      if (!s.enabled || !s.lateUpdate) continue;
      try { s.lateUpdate(LIVE_WHILE_PAUSED.has(name) ? dt : wdt, worldT); }
      catch (e) { console.error(`[system:${name}] lateUpdate threw`, e); s.enabled = false; }
    }
    input.update(dt);
  });

  // ── capture / debug surface ───────────────────────────────────────────────
  window.__THREE = THREE;
  window.__engine = engine;
  window.__world = world;
  window.__poi = poi;
  window.__terrain = terrain;
  window.__lighting = lighting;
  window.__atmosphere = atmosphere;
  window.__stylize = stylize;
  window.__postfx = postfx;
  window.__sky = sky;
  window.__systems = ctx.systems;
  window.__ctx = ctx;

  // Indexed accessor so the capture harness can pick a different landmark when
  // the top-ranked one turns out to be unusable (buried in vegetation, inside a
  // lake, blocked by a trunk).
  window.__anchorAt = (kind, i = 0) => poi.anchor(kind, i);

  window.__cameraAnchors = {
    vista:     () => poi.anchor('vista'),
    meadow:    () => poi.anchor('meadow'),
    forest:    () => poi.anchor('forest'),
    river:     () => poi.anchor('river'),
    waterfall: () => poi.anchor('waterfall'),
    peak:      () => poi.anchor('peak'),
    road:      () => poi.anchor('road'),
    vehicle:   () => {
      const v = ctx.systems.vehicle;
      const p = v?.position;
      return p ? { x: p.x, z: p.z, yaw: (v.heading ?? 0) + Math.PI * 0.75, lookY: 1.6 }
               : poi.anchor('road');
    },
  };

  // What the renderer is ACTUALLY drawing. Without this a future author can
  // measure a healthy fps without noticing that adaptive resolution quietly
  // halved the pixel count to get it.
  window.__resolution = () => {
    const scale = engine.resolutionScale;
    const internalScale = engine.internalScale;
    const presented = engine.basePixelRatio * scale;
    const presentedMegapixels =
      (engine.renderer.domElement.width * engine.renderer.domElement.height) / 1e6;
    return {
      scale: +scale.toFixed(3),
      internalScale: +internalScale.toFixed(3),
      basePixelRatio: +engine.basePixelRatio.toFixed(3),
      presented: +presented.toFixed(3),
      effective: +(presented * internalScale).toFixed(3),
      megapixels: +(presentedMegapixels * internalScale * internalScale).toFixed(2),
      presentedMegapixels: +presentedMegapixels.toFixed(2),
    };
  };

  window.__settle = (frames = 60) => new Promise((res) => {
    let n = 0;
    const tick = () => { if (++n >= frames) res(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  // A fixed frame count is not a settle, and believing it was has quietly
  // corrupted every contact sheet in review/.
  //
  // Streaming systems — grass rings, ground-cover cells, terrain LOD, tree
  // tiles — rebuild on a per-frame millisecond budget, so the time they need
  // depends on how far the camera just jumped. `shot.mjs --all` teleports ten
  // times in one page load and gave each view 60 frames. Measured by the X2
  // author: the same view captured ALONE comes back with roughly twice the
  // triangles and lumaMean 0.451 against the batch's 0.524. So every sheet in
  // review/ is a less-resolved frame than the game actually renders, and a
  // batch sheet cannot be compared against a single-view capture at all.
  //
  // Settle on a convergence condition instead — hold until the drawn triangle
  // and draw-call counts stop moving, which is what "streaming has caught up"
  // actually means — with a hard cap so a genuinely animated scene still
  // returns rather than hanging the harness.
  window.__settleStable = (maxFrames = 1500, stableFor = 30) => new Promise((res) => {
    let n = 0, stable = 0, lastT = -1, lastC = -1;
    const tick = () => {
      const info = engine.renderer.info.render;
      const t = info.triangles, c = info.calls;
      // Foliage sway and particle systems jitter the count by a handful of
      // triangles per frame. 0.2% sits well under one streaming step and well
      // over that noise.
      const settled = lastT > 0 && c === lastC
                   && Math.abs(t - lastT) <= Math.max(64, lastT * 0.002);
      stable = settled ? stable + 1 : 0;
      lastT = t; lastC = c;
      n++;
      if (stable >= stableFor || n >= maxFrames) {
        res({ frames: n, triangles: t, calls: c, converged: stable >= stableFor });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Perf readout, off by default (F3 or the settings toggle shows it,
  // Shift+F3 cycles detail). Kept out of the HUD deliberately — the HUD hides
  // itself during captures, and this needs to be visible precisely when the
  // player is judging how the game feels.
  const perfOverlay = new PerfOverlay(engine);
  engine.onLateUpdate(() => perfOverlay.update());
  window.__perfOverlay = perfOverlay;

  // On-screen driving controls, only where there are thumbs to use them.
  if (touchCapable()) {
    const touchControls = new TouchControls(input);
    engine.onLateUpdate(() => touchControls.update());
    window.__touchControls = touchControls;
  }

  let fpsAcc = 0, fpsN = 0;
  engine.onLateUpdate((dt) => {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { window.__fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  });

  engine.start();
  setProgress(1, 'Ready');
  setTimeout(() => loaderEl?.classList.add('hidden'), 400);
  window.__ready = true;

  posthog.capture('session_started', {
    quality_tier: quality,
    seed,
    touch_capable: touchCapable(),
    device_memory_gb: navigator.deviceMemory ?? null,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    bake_cached: !!baked.cached,
  });
}

boot().catch((e) => {
  console.error(e);
  if (statusEl) statusEl.textContent = 'Failed: ' + e.message;
  window.__bootError = String(e?.stack || e);
});

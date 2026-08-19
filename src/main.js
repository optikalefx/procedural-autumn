// ─────────────────────────────────────────────────────────────────────────────
//  PROCEDURAL AUTUMN — entry point.
//
//  main.js owns *integration only*. Every world system lives in its own module
//  behind the System interface (src/core/System.js) and is constructed here in
//  a fixed order. System authors never edit this file.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { WORLD, SEED, QUALITY_PRESETS } from './world/WorldConfig.js';
import { WorldData } from './world/WorldData.js';
import { PointsOfInterest } from './world/PointsOfInterest.js';
import { decodeBake, bakeFilename, sourceHash } from './world/bakeFormat.js';
// Raw source of the generator, purely so the bake cache key tracks it.
import terrainGenSource from './world/TerrainGen.js?raw';

const GEN_HASH = sourceHash(terrainGenSource);
import { Terrain } from './world/Terrain.js';
import { Atmosphere } from './render/Atmosphere.js';
import { Stylize } from './render/Stylize.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';
import { Sky } from './sky/Sky.js';
import { PerfOverlay } from './ui/PerfOverlay.js';

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
import { CameraRig }   from './vehicle/CameraRig.js';
import { Audio }       from './audio/Audio.js';
import { HUD }         from './ui/HUD.js';

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
  ['cameraRig',   CameraRig],
  ['audio',       Audio],
  ['hud',         HUD],
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

  // Megapixels this display would ask for at the tier's own cap, using the
  // window rather than the screen — a small window on a big monitor is cheap.
  const cssPx = (window.innerWidth || 1280) * (window.innerHeight || 720);
  const dpr = Math.min(window.devicePixelRatio || 1, QUALITY_PRESETS.ultra.pixelRatioCap);
  const megapixels = (cssPx * dpr * dpr) / 1e6;

  let tier = mem >= 8 && cores >= 8 ? 'ultra'
           : mem >= 6 && cores >= 6 ? 'high'
           : cores >= 4 ? 'medium'
           : 'low';

  // Step down for heavy pixel loads. AdaptiveResolution in Engine will not
  // rescue this on its own: it refuses to draw below one device pixel per CSS
  // pixel, because rendering under native reads as a blurry game rather than a
  // fast one. Below native the honest lever is fewer effects, not less sharpness.
  const ORDER = ['ultra', 'high', 'medium', 'low'];
  let steps = 0;
  if (megapixels > 6.0) steps = 2;
  else if (megapixels > 3.5) steps = 1;
  if (steps) tier = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + steps)];

  console.log(`[quality] ${tier} — ${megapixels.toFixed(2)} MP at dpr ${dpr}, ` +
              `${cores} cores, ${mem} GB` + (steps ? ` (stepped down ${steps} for pixel load)` : ''));
  return tier;
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
    let url = `/${bakeFilename(seed, res, GEN_HASH)}`;
    let stale = false;
    let r = await fetch(url, { cache: 'force-cache' });

    if (!r.ok) {
      // Exact generator hash missing — most likely someone is mid-edit on
      // TerrainGen.js. Fall back to the newest bake for this (seed, res) so
      // other authors keep fast captures, but flag it loudly.
      const man = await fetch('/bakes/manifest.json', { cache: 'no-store' }).then((x) => x.ok ? x.json() : null).catch(() => null);
      const alt = man?.entries?.find((e) => e.seed === seed && e.res === res);
      if (!alt) return null;
      url = `/bakes/${alt.file}`;
      stale = true;
      r = await fetch(url, { cache: 'force-cache' });
      if (!r.ok) return null;
      console.warn(`[world] STALE BAKE: generator is ${GEN_HASH}, using ${alt.hash}. ` +
                   `Run "node tools/bake.mjs --force" to refresh, or add ?nocache=1 to bake live.`);
    }

    setProgress(0.30, 'Loading the valley');
    const buf = await r.arrayBuffer();
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
  const baked = (await loadCachedBake(seed, res)) ?? (await bakeWorld(seed, res));
  console.log(`[world] ${baked.cached ? 'loaded cached bake' : 'baked live'} in ${baked.ms.toFixed(0)} ms (gen ${GEN_HASH})`);
  window.__bakeCached = !!baked.cached;
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
  const terrain = new Terrain(world, engine.scene);
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
  stylize.harvest();
  stylize.update();
  engine.renderer.compile(engine.scene, cam);

  engine.setRenderCallback((dt) => postfx.render(dt));

  engine.onUpdate((dt, t) => {
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

    lighting.update(dt, cam.position);

    if (lighting.fogNear) {
      atmosphere.params.nearColor.copy(lighting.fogNear);
      atmosphere.params.farColor.copy(lighting.fogFar);
      atmosphere.params.sunColor.copy(lighting.fogSun);
      atmosphere.params.density = lighting.fogDensity;
    }
    if ((engine.frame & 15) === 0) { atmosphere.harvest(); stylize.harvest(); }
    stylize.update();
    atmosphere.update(lighting.sunDir, lighting.sun.color, lighting.sunDir.y);

    sky.update(dt, t, cam, lighting.sunDir);
    terrain.setSunDir(lighting.sunDir);
    terrain.setTime(t);
    terrain.update(cam, 3.0);

    for (const [name, s] of built) {
      if (!s.enabled) continue;
      try { s.update(dt, t); }
      catch (e) { console.error(`[system:${name}] update threw`, e); s.enabled = false; }
    }
  });

  engine.onLateUpdate((dt, t) => {
    for (const [name, s] of built) {
      if (!s.enabled || !s.lateUpdate) continue;
      try { s.lateUpdate(dt, t); }
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
  window.__resolution = () => ({
    scale: +engine.resolutionScale.toFixed(3),
    basePixelRatio: +engine.basePixelRatio.toFixed(3),
    effective: +(engine.basePixelRatio * engine.resolutionScale).toFixed(3),
    megapixels: +((engine.renderer.domElement.width * engine.renderer.domElement.height) / 1e6).toFixed(2),
  });

  window.__settle = (frames = 60) => new Promise((res) => {
    let n = 0;
    const tick = () => { if (++n >= frames) res(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  // Always-on perf readout (F3 toggles, Shift+F3 cycles detail). Kept out of
  // the HUD deliberately — the HUD hides itself during captures, and this needs
  // to be visible precisely when the player is judging how the game feels.
  const perfOverlay = new PerfOverlay(engine);
  engine.onLateUpdate(() => perfOverlay.update());
  window.__perfOverlay = perfOverlay;

  let fpsAcc = 0, fpsN = 0;
  engine.onLateUpdate((dt) => {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { window.__fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  });

  engine.start();
  setProgress(1, 'Ready');
  setTimeout(() => loaderEl?.classList.add('hidden'), 400);
  window.__ready = true;
}

boot().catch((e) => {
  console.error(e);
  if (statusEl) statusEl.textContent = 'Failed: ' + e.message;
  window.__bootError = String(e?.stack || e);
});

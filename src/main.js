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
import { Terrain } from './world/Terrain.js';
import { Atmosphere } from './render/Atmosphere.js';
import { Lighting } from './render/Lighting.js';
import { PostFX } from './render/PostFX.js';
import { Sky } from './sky/Sky.js';

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

function pickQuality() {
  const q = new URLSearchParams(location.search).get('quality');
  if (q && QUALITY_PRESETS[q]) return q;
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem >= 8 && cores >= 8) return 'ultra';
  if (mem >= 6 && cores >= 6) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

function bakeWorld() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world/worldWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress(e.data.p * 0.62, e.data.label);
      else if (e.data.type === 'done') { worker.terminate(); resolve(e.data); }
    };
    worker.onerror = reject;
    const params = new URLSearchParams(location.search);
    worker.postMessage({
      res: parseInt(params.get('res') ?? WORLD.heightmapRes, 10),
      worldSize: WORLD.size,
      seed: parseInt(params.get('seed') ?? SEED, 10),
      maxAltitude: WORLD.maxAltitude,
    });
  });
}

async function boot() {
  const canvas = document.getElementById('gl');
  const quality = pickQuality();
  const engine = new Engine(canvas, quality);
  const input = new Input();

  setProgress(0.02, 'Raising mountains');
  const baked = await bakeWorld();
  console.log(`[world] baked in ${baked.ms.toFixed(0)} ms`);

  setProgress(0.66, 'Reading the water');
  const world = new WorldData(baked.data, SEED);
  const poi = new PointsOfInterest(world, SEED);

  setProgress(0.70, 'Lighting the valley');
  const atmosphere = new Atmosphere(engine.scene);
  const lighting = new Lighting(engine.scene, quality);
  const sky = new Sky(engine.scene);
  const terrain = new Terrain(world, engine.scene);
  const postfx = new PostFX(engine, quality);

  const ctx = {
    THREE, engine, input,
    scene: engine.scene, camera: engine.camera, renderer: engine.renderer,
    world, poi, terrain, atmosphere, lighting, sky, postfx,
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

  // ── camera: systems may take over via ctx.systems.cameraRig ───────────────
  const cam = engine.camera;
  const startPoi = poi.best('road') ?? poi.best('meadow') ?? { x: 0, z: 0 };
  cam.position.set(startPoi.x, world.getHeight(startPoi.x, startPoi.z) + 14, startPoi.z + 30);
  cam.lookAt(startPoi.x, world.getHeight(startPoi.x, startPoi.z) + 2, startPoi.z);
  const fly = { yaw: Math.PI, pitch: -0.16, speed: 34 };

  setProgress(0.96, 'Warming the shaders');
  for (let i = 0; i < 20; i++) terrain.update(cam, 30);
  atmosphere.harvest();
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
    if ((engine.frame & 15) === 0) atmosphere.harvest();
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
  window.__postfx = postfx;
  window.__sky = sky;
  window.__systems = ctx.systems;
  window.__ctx = ctx;

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

  window.__settle = (frames = 60) => new Promise((res) => {
    let n = 0;
    const tick = () => { if (++n >= frames) res(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

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

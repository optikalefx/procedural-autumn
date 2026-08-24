#!/usr/bin/env node
/**
 * Record a deterministic, close observation of the camp dog's whole loop.
 *
 *   node tools/dogvideo.mjs
 *   node tools/dogvideo.mjs --out shots/camp/dog.webm --seconds 45
 *   node tools/dogvideo.mjs --view plan --quick
 *   node tools/dogvideo.mjs --trap --seconds 12
 *   AUTUMN_URL=http://127.0.0.1:5188 node tools/dogvideo.mjs
 *
 * The normal camp camera is composed around the fire, not around the dog, so a
 * bad avoidance turn can happen half-hidden behind a tent and be gone before a
 * screenshot is taken. This tool pins the world, car, camp and camera, forces
 * the camp's optional dog to exist, and records one uninterrupted page load.
 * A small overlay and a JSON trace beside the video make stalls, pivots and
 * rest jitter visible without changing the simulation.
 *
 * `--quick` only shortens the idle timers. Locomotion, avoidance, transitions
 * and authored poses still run through the shipping update loop. It is useful
 * for fitting wander -> settle -> rest -> rise into a short review clip.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
};
const has = (name) => argv.includes(`--${name}`);

const OUT = resolve(String(arg('out', 'shots/camp/dog.webm')));
const TRACE = resolve(String(arg('trace', OUT.replace(/\.[^.]+$/, '.json'))));
const SECONDS = Math.max(5, parseFloat(arg('seconds', '45')) || 45);
const SEED = String(arg('seed', '20261018'));
const PARK = String(arg('park', 'meadow'));
const VIEW = String(arg('view', 'observe'));
const CAR = String(arg('car', 'camper'));
const W = Math.max(640, parseInt(arg('w', '1280'), 10) || 1280);
const H = Math.max(360, parseInt(arg('h', '720'), 10) || 720);
const BASE = String(arg('url', process.env.AUTUMN_URL || 'http://localhost:5178'));

if (extname(OUT).toLowerCase() !== '.webm') {
  console.error('dogvideo: --out must end in .webm (Playwright records WebM video)');
  process.exit(2);
}
if (!['observe', 'plan'].includes(VIEW)) {
  console.error('dogvideo: --view must be observe or plan');
  process.exit(2);
}

function assertTreeParses() {
  try {
    execFileSync(process.execPath, ['tools/lint.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    console.error('[dogvideo] refusing to record because the source tree does not parse');
    console.error(out.trim());
    process.exit(2);
  }
}

function summarize(trace) {
  let longestMovementPause = 0;
  let longestUnrecoveredStall = 0;
  let pause = 0;
  let unrecovered = 0;
  let backing = 0;
  let minClearance = Infinity;
  let maxSlowYawRate = 0;
  let maxHeadPitchRate = 0;
  let maxNeckPitchRate = 0;
  let maxMovingPelvisPitch = 0;
  let maxHeadPitch = -Infinity;
  let minHeadPitch = Infinity;
  let maxMovingHeadPitch = -Infinity;
  let minMovingHeadPitch = Infinity;
  let recoveryEpisodes = trace[0]?.recovering ? 1 : 0;
  let recoverySideFlips = 0;
  let restYMin = Infinity, restYMax = -Infinity;
  let maxRestYRange = 0, restSegments = 0;

  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1], b = trace[i];
    const dt = Math.max(1e-3, (b.t - a.t) / 1000);
    const moved = Math.hypot(b.x - a.x, b.z - a.z);
    if (b.moving && moved < 0.008) pause += dt;
    else pause = 0;
    if (b.moving && !b.recovering && moved < 0.008) unrecovered += dt;
    else unrecovered = 0;
    longestMovementPause = Math.max(longestMovementPause, pause);
    longestUnrecoveredStall = Math.max(longestUnrecoveredStall, unrecovered);
    if (b.recovering) backing += dt;
    if (b.recovering && !a.recovering) recoveryEpisodes++;
    if (b.recovering && a.recovering && b.avoidSide !== a.avoidSide) recoverySideFlips++;
    if (Number.isFinite(b.clearance)) minClearance = Math.min(minClearance, b.clearance);

    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    if (Math.abs(b.speed) < 0.12) maxSlowYawRate = Math.max(maxSlowYawRate, Math.abs(dh) / dt);

    maxHeadPitchRate = Math.max(maxHeadPitchRate, Math.abs(b.headPitch - a.headPitch) / dt);
    maxNeckPitchRate = Math.max(maxNeckPitchRate, Math.abs(b.neckPitch - a.neckPitch) / dt);
    if (b.moving) {
      maxMovingPelvisPitch = Math.max(maxMovingPelvisPitch, Math.abs(b.pelvisPitch));
      maxMovingHeadPitch = Math.max(maxMovingHeadPitch, b.headPitch);
      minMovingHeadPitch = Math.min(minMovingHeadPitch, b.headPitch);
    }
    maxHeadPitch = Math.max(maxHeadPitch, b.headPitch);
    minHeadPitch = Math.min(minHeadPitch, b.headPitch);

    if (b.state === 'rest') {
      if (a.state !== 'rest') {
        restYMin = Infinity; restYMax = -Infinity;
        restSegments++;
      }
      restYMin = Math.min(restYMin, b.meshY);
      restYMax = Math.max(restYMax, b.meshY);
      maxRestYRange = Math.max(maxRestYRange, restYMax - restYMin);
    }
  }

  return {
    samples: trace.length,
    longestMovementPauseSeconds: +longestMovementPause.toFixed(3),
    longestUnrecoveredStallSeconds: +longestUnrecoveredStall.toFixed(3),
    backingSeconds: +backing.toFixed(3),
    minimumClearanceMetres: Number.isFinite(minClearance) ? +minClearance.toFixed(4) : null,
    maxSlowYawRateRadiansPerSecond: +maxSlowYawRate.toFixed(3),
    maxHeadPitchRateRadiansPerSecond: +maxHeadPitchRate.toFixed(3),
    maxNeckPitchRateRadiansPerSecond: +maxNeckPitchRate.toFixed(3),
    maxMovingPelvisPitchRadians: +maxMovingPelvisPitch.toFixed(3),
    headPitchRangeRadians: Number.isFinite(maxHeadPitch)
      ? [+minHeadPitch.toFixed(3), +maxHeadPitch.toFixed(3)] : null,
    movingHeadPitchRangeRadians: Number.isFinite(maxMovingHeadPitch)
      ? [+minMovingHeadPitch.toFixed(3), +maxMovingHeadPitch.toFixed(3)] : null,
    recoveryEpisodes,
    recoverySideFlips,
    netMovementMetres: trace.length > 1 ? +Math.hypot(
      trace.at(-1).x - trace[0].x,
      trace.at(-1).z - trace[0].z,
    ).toFixed(3) : 0,
    restVerticalRangeMetres: restSegments ? +maxRestYRange.toFixed(5) : null,
    restSegments,
    statesSeen: [...new Set(trace.map((s) => s.state))],
  };
}

async function main() {
  assertTreeParses();
  const release = await acquire('dogvideo');
  mkdirSync(dirname(OUT), { recursive: true });
  mkdirSync(dirname(TRACE), { recursive: true });

  const browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--disable-frame-rate-limit',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (protocols === 'vite-hmr' || String(protocols).includes('vite')) {
        return {
          readyState: 3, url, protocol: '',
          addEventListener() {}, removeEventListener() {}, send() {}, close() {},
          set onopen(_) {}, set onmessage(_) {}, set onclose(_) {}, set onerror(_) {},
        };
      }
      return new Real(url, protocols);
    };
    window.WebSocket.prototype = Real.prototype;
  });

  const params = new URLSearchParams({ seed: SEED, car: CAR, iscale: '0.74' });
  await page.goto(`${BASE}?${params}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null,
    { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null,
    { timeout: 30000 });

  await page.evaluate((kind) => {
    const p = window.__poi.best(kind) ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  }, PARK);
  await page.waitForTimeout(1400);

  const site = await page.evaluate(() => {
    const campSystem = window.__camp;
    const v = window.__systems.vehicle;
    const camp = campSystem.pitchNear(v.position.x, v.position.z,
      { instant: true, radius: 14 });
    if (!camp) return null;
    // The dog is an 80% roll in the game. An observation harness must never
    // spend a page load recording the other 20%.
    camp.hasDog = true;
    return { x: camp.x, y: camp.y, z: camp.z, radius: camp.radius };
  });
  if (!site) throw new Error(`no valid camp site near ${PARK}; try --park meadow or --park vista`);

  await page.waitForFunction(() => !!window.__camp?.camps?.at(-1)?.dog, null,
    { timeout: 15000, polling: 100 });

  await page.evaluate(({ site, view, quick, trap }) => {
    const THREE = window.__THREE;
    const engine = window.__engine;
    const dog = window.__camp.camps.at(-1).dog;
    window.__forceCamera = true;
    window.__lighting.cycleSpeed = 0;
    document.querySelectorAll('#hud, .pa-camp-prompt, .pa-camp-reticle')
      .forEach((el) => { el.style.display = 'none'; });

    if (trap) {
      // A deterministic version of the reported tent/fire pocket: forward is
      // blocked, straight back meets a second footprint, and the dog has to
      // choose the reverse arc that carries its rump away from both. The old
      // recovery flipped sides every 0.28 s and remained here indefinitely.
      const x = dog.pos.x, z = dog.pos.z;
      dog.obstacles = [
        // Starts 2 cm inside this rounded footprint, which exercises the
        // monotonic de-penetration path as well as the side commitment.
        { x: x + 0.18, z: z + 0.55, r: 0.35 },
        { x: x + 0.18, z: z - 0.65, r: 0.35 },
      ];
      dog.state = 0;
      dog.timer = 999;
      dog.blend = 0;
      dog.pose = null;
      dog.heading = 0;
      dog.speed = 0.68;
      dog.blockedTime = 0;
      dog.recovering = false;
      const fixed = { x, z: z + 3 };
      dog._orbitPoint = (_a, _r, out = {}) => {
        out.x = fixed.x; out.z = fixed.z;
        return out;
      };
      dog.target.set(fixed.x, 0, fixed.z);
    }

    const overlay = document.createElement('pre');
    Object.assign(overlay.style, {
      position: 'fixed', left: '16px', top: '14px', zIndex: '99999', margin: '0',
      padding: '9px 11px', color: '#fff', background: 'rgba(19,24,28,.76)',
      font: '15px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      borderRadius: '5px', pointerEvents: 'none', textShadow: '0 1px #000',
    });
    document.body.appendChild(overlay);

    engine.camera.fov = view === 'plan' ? 42 : 48;
    engine.camera.updateProjectionMatrix();
    const aim = new THREE.Vector3();
    const cameraPos = new THREE.Vector3();
    const desiredPos = new THREE.Vector3();
    const headForward = new THREE.Vector3();
    const headWorldQ = new THREE.Quaternion();
    const trace = window.__dogTrace = [];
    let lastSample = 0;
    let lastFrame = 0;
    let cameraReady = false;
    const wrappedX = (rotation) => rotation
      ? Math.atan2(Math.sin(rotation.x), Math.cos(rotation.x)) : 0;

    const tick = (now) => {
      const state = dog.stateName ?? String(dog.state);
      if (quick) {
        if (state === 'wander') dog.timer = Math.min(dog.timer, 5);
        if (state === 'approach') dog.timer = Math.min(dog.timer, 16);
        if (state === 'rest') dog.timer = Math.min(dog.timer, 8);
      }

      if (view === 'plan') {
        engine.camera.position.set(site.x + 0.01, site.y + 8.8, site.z + 0.01);
        engine.camera.lookAt(site.x, site.y, site.z);
      } else {
        // Follow from just outside the fire ring. Keeping the fire behind the
        // dog preserves the obstacle context, while the close, damped camera
        // makes paw shuffles and sub-centimetre rest jitter readable.
        let rx = dog.pos.x - site.x, rz = dog.pos.z - site.z;
        const rl = Math.max(0.01, Math.hypot(rx, rz));
        rx /= rl; rz /= rl;
        desiredPos.set(
          dog.pos.x + rx * 3.8 + rz * 1.35,
          dog.pos.y + 2.25,
          dog.pos.z + rz * 3.8 - rx * 1.35,
        );
        aim.set(dog.pos.x, dog.pos.y + 0.34, dog.pos.z);
        const frameDt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1;
        const follow = 1 - Math.exp(-frameDt * 3.2);
        if (!cameraReady) { cameraPos.copy(desiredPos); cameraReady = true; }
        else cameraPos.lerp(desiredPos, follow);
        engine.camera.position.copy(cameraPos);
        engine.camera.lookAt(aim);
      }
      lastFrame = now;

      const clearance = dog.nearestClearance ?? null;
      overlay.textContent = [
        `camp dog  ${state}${trap ? '  TRAP TEST' : ''}`,
        `speed ${dog.speed.toFixed(2)} m/s   timer ${Math.max(0, dog.timer).toFixed(1)} s`,
        `clearance ${clearance === null ? '--' : `${clearance.toFixed(2)} m`}   ${dog.recovering ? 'BACKING' : ''}`,
      ].join('\n');

      if (now - lastSample >= 50) {
        const neck1 = dog.byName.neck1?.rotation;
        const neck2 = dog.byName.neck2?.rotation;
        const head = dog.byName.head?.rotation;
        const pelvis = dog.byName.pelvis?.rotation;
        dog.byName.head?.getWorldQuaternion(headWorldQ);
        headForward.set(0, 0, 1).applyQuaternion(headWorldQ);
        trace.push({
          t: now, state,
          x: dog.pos.x, y: dog.pos.y, z: dog.pos.z,
          meshY: dog.mesh.position.y,
          heading: dog.heading, speed: dog.speed,
          clearance, recovering: !!dog.recovering,
          blockedTime: dog.blockedTime,
          recoverTimer: dog.recoverTimer,
          targetX: dog.target.x, targetZ: dog.target.z,
          approachFinal: !!dog.approachFinal,
          avoidSide: dog.avoidSide,
          blend: dog.blend,
          alert: dog.drive.alert,
          neck1: neck1 ? [neck1.x, neck1.y, neck1.z] : null,
          neck2: neck2 ? [neck2.x, neck2.y, neck2.z] : null,
          head: head ? [head.x, head.y, head.z] : null,
          pelvisPitch: wrappedX(pelvis),
          neckPitch: wrappedX(neck1) + wrappedX(neck2),
          headPitch: Math.atan2(headForward.y, Math.hypot(headForward.x, headForward.z)),
          poseNeckX: dog.pose?.bones?.neck1?.[0] ?? null,
          moving: (state === 'wander' || state === 'approach' || state === 'orient') &&
            (Math.abs(dog.speed) > 0.04 || Math.hypot(
              dog.target.x - dog.pos.x,
              dog.target.z - dog.pos.z,
            ) > 0.15),
        });
        lastSample = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { site, view: VIEW, quick: has('quick'), trap: has('trap') });

  // Start after boot, pitch and camera setup. Context-level video starts at
  // navigation and made the first third of every review clip a loading screen.
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__dogTrace.length = 0; });
  await page.screencast.start({ path: OUT, size: { width: W, height: H } });
  console.log(`recording ${SECONDS.toFixed(0)} s: ${OUT}`);
  await page.waitForTimeout(SECONDS * 1000);
  const trace = await page.evaluate(() => window.__dogTrace ?? []);
  const summary = summarize(trace);
  writeFileSync(TRACE, JSON.stringify({
    seed: SEED, park: PARK, view: VIEW, quick: has('quick'), trap: has('trap'), seconds: SECONDS,
    site, summary, trace,
  }, null, 2));

  await page.screencast.stop();
  await page.close();
  await context.close();
  await browser.close();
  release();

  console.log(`trace: ${TRACE}`);
  console.log(`summary: ${JSON.stringify(summary)}`);
  if (errors.length) console.log(`page-errors: ${JSON.stringify(errors.slice(0, 8))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

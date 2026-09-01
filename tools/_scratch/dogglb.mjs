#!/usr/bin/env node
/**
 * The GLB camp dog, in the valley, in each of its four states.
 *
 *   node tools/_scratch/dogglb.mjs --dir shots/dogglb --url http://localhost:5237
 *
 * `campshot.mjs` photographs a camp; this photographs the DOG, which is a
 * different job — the thing under judgement is 0.5 m tall, spends most of its
 * life folded up on the ground, and changes state on a 26-75 s clock nobody
 * wants to wait out four times.
 *
 * So the states are FORCED rather than waited for: the harness reaches into
 * `camp.dog` and puts it in each rest pose with the settle clock already run
 * out. That is a fair picture of what the player sees, because the pose is a
 * clip and `blend` is its weight — there is no hidden solver state that only
 * arrives by living through the transition.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const DIR = arg('dir', 'shots/dogglb');
const URL = `${arg('url', process.env.AUTUMN_URL || 'http://localhost:5178')}?res=1400x900&car=van`;
const HOUR = parseFloat(arg('hour', '16.5'));

// Broadside and close, which is how a gait and a rest pose are both judged.
// `az` is measured off the dog's own heading, so a walking dog is shot from the
// side whichever way it happens to be pointing.
const VIEWS = {
  side: { az: 1.57, dist: 2.6, elev: 0.55, fov: 40, aim: 0.28 },
  fq: { az: 0.85, dist: 2.8, elev: 0.75, fov: 40, aim: 0.28 },
  high: { az: 1.10, dist: 2.2, elev: 1.9, fov: 44, aim: 0.15 },
};

const main = async () => {
  const release = await acquire('dogglb');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // A fresh Playwright profile is a first-ever session, so `HUD.maybeShowIntro`
  // auto-opens the journal 400 ms in and the book fills every frame. This is
  // the third harness to be caught by it.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pa.hud', JSON.stringify({ introSeen: true, seenHint: true }));
    } catch { /* private mode; the book is the least of it */ }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null,
    { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle,
    null, { timeout: 30000 });

  await page.evaluate(() => {
    const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
    window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
  });
  await page.waitForTimeout(1600);

  // The park brake, latched with a real key: `brakeHold` assigned from an
  // evaluate survives one frame, and pitching a camp needs it held.
  await page.keyboard.down('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(2000);

  const ok = await page.evaluate(() => {
    const v = window.__systems.vehicle;
    return !!window.__camp.pitchNear(v.position.x, v.position.z,
      { instant: true, radius: 14 });
  });
  if (!ok) { console.error('no camp site near the camper'); process.exit(2); }

  // The dog is a fetched model and the camp may be pitched before it lands.
  await page.waitForFunction(
    () => !!window.__camp.camps?.find((c) => c.dog)?.dog, null, { timeout: 30000 });

  mkdirSync(resolve(DIR), { recursive: true });

  const STATES = [
    ['stand', null],
    ['walk', null],
    ['curl', 'curl'],
    ['lie', 'lie'],
    ['sit', 'sit'],
  ];

  for (const [label, pose] of STATES) {
    const where = await page.evaluate(async ({ label, pose, hour }) => {
      const camp = window.__camp.camps.find((c) => c.dog);
      const dog = camp.dog;
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;
      // Force the state. `ST` is 0 WANDER / 1 APPROACH / 2 SETTLE / 3 REST /
      // 4 RISE — see `camp_dog.js`.
      if (pose) {
        dog.pose = pose;
        dog.blend = 1;
        dog.state = 3;
        dog.timer = 600;
        dog.speed = 0;
        dog.restGround = dog._surfaceAt(dog.pos.x, dog.pos.z, dog.heading);
      } else {
        dog.pose = null;
        dog.blend = 0;
        dog.state = 0;
        dog.timer = 600;
      }
      // Let the mixer's crossfades finish. They are damped on a 0.22 s clock,
      // so a second of simulated time is several time constants.
      for (let i = 0; i < 90; i++) dog.update(1 / 60, window.__engine.camera.position);
      return {
        x: dog.pos.x, y: dog.pos.y, z: dog.pos.z, heading: dog.heading,
        gait: dog.rig.gaitName, speed: +dog.speed.toFixed(3), state: dog.stateName,
      };
    }, { label, pose, hour: HOUR });

    console.log(`${label}: ${where.state} / clip ${where.gait} / ${where.speed} m/s`);

    for (const [vn, f] of Object.entries(VIEWS)) {
      await page.evaluate(async ({ f, where }) => {
        const THREE = window.__THREE, e = window.__engine;
        const a = where.heading + f.az;
        const centre = new THREE.Vector3(where.x, where.y + f.aim, where.z);
        e.camera.fov = f.fov;
        e.camera.updateProjectionMatrix();
        e.camera.position.set(
          where.x + Math.sin(a) * f.dist, where.y + f.elev, where.z + Math.cos(a) * f.dist);
        e.camera.lookAt(centre);
        window.__forceCamera = true;
        if (window.__settleStable) await window.__settleStable(600, 24);
      }, { f, where });
      await page.waitForTimeout(350);
      const out = resolve(DIR, `${label}-${vn}.png`);
      await page.screenshot({ path: out });
      console.log(`  shot ${out}`);
    }
  }

  if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 8).join('\n  ')}`);
  await browser.close();
  release();
};

main();

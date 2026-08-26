#!/usr/bin/env node
/**
 * Watch how high the rabbits actually get, in the running game.
 *
 * `_hopprobe.mjs` drives a bare rig in node, which proves the arithmetic but
 * not the shipping path. This spawns real animals in the real page, steps the
 * engine by hand at a fixed 60 Hz, and reports the highest any of them ever
 * lifts its root bone off its own feet — the one number the "sky-high for a
 * frame" report is about.
 *
 *   AUTUMN_URL=http://127.0.0.1:5234 node tools/_scratch/_hopwatch.mjs
 *   ... --species squirrel --mode graze --frames 3600
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SPECIES = arg('species', 'rabbit');
const MODE = arg('mode', 'graze');
const FRAMES = parseInt(arg('frames', '2400'), 10);
const URL = `${process.env.AUTUMN_URL || 'http://localhost:5178'}?res=480`;

await acquire('hopwatch');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, W = window.__world;
  const wl = window.__systems.wildlife;
  const ST = { idle: 0, graze: 1, wander: 2, alert: 3, flee: 4 };
  window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const anchor = window.__cameraAnchors.meadow();
  e.camera.position.set(anchor.x, W.getHeight(anchor.x, anchor.z) + 2, anchor.z);

  wl.debugClear();
  wl.debugThreat(null);
  if (!wl.debugSpawn(P.SPECIES, { dist: 14, clear: 9, count: 6 })) return { error: 'no spawn' };

  const all = () => {
    const out = [];
    for (const per of wl.pool[P.SPECIES]) for (const a of per) if (a.active) out.push(a);
    return out;
  };
  for (const a of all()) { if (ST[P.MODE] !== undefined) { a.brain.state = ST[P.MODE]; a.brain.timer = 1e6; } }

  e.stop();
  e.clock.getDelta = () => 1 / 60;

  let peak = 0, peakSpeed = 0, peakFrame = 0, over = 0, overHalf = 0;
  let maxSpeed = 0, moving = 0, hasRig = 0, maxFlight = 0;
  const hist = [];
  for (let f = 0; f < P.FRAMES; f++) {
    e._loop();
    for (const a of all()) {
      const rig = a.rig; if (!rig) continue;
      hasRig++;
      if (a.brain.speed > maxSpeed) maxSpeed = a.brain.speed;
      if (a.brain.speed > 0.04) moving++;
      if ((rig.flightY ?? 0) * a.scale > maxFlight) maxFlight = rig.flightY * a.scale;
      const y = rig.root.position.y * a.scale;
      if (y > 0.1) hist.push(+y.toFixed(3));
      if (y > 0.5) over++;
      if (y > 0.25) overHalf++;
      if (y > peak) { peak = y; peakSpeed = a.brain.speed; peakFrame = f; }
    }
  }
  hist.sort((a, b) => b - a);
  return { peak, peakSpeed, peakFrame, over, overHalf, maxSpeed, moving, hasRig, maxFlight,
    top: hist.slice(0, 12), n: all().length };
}, { SPECIES, MODE, FRAMES });

console.log(`${SPECIES} / ${MODE} / ${FRAMES} frames`, JSON.stringify(out));
await browser.close();
process.exit(0);

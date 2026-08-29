#!/usr/bin/env node
/**
 * What actually happens across a Walk -> Stand transition.
 *
 *   AUTUMN_URL=http://127.0.0.1:5202 node tools/_scratch/blendprobe.mjs
 *
 * Samples the brain's speed and both clip weights every frame while a fox is
 * pushed from walking to standing, so the snap can be attributed to the blend
 * or to whatever is driving it rather than guessed at.
 */
import { chromium } from 'playwright';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper&quality=high';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 180000 });
await page.evaluate(() => window.__settleStable?.() ?? window.__settle?.(60));

const out = await page.evaluate(async () => {
  const S = window.__systems, W = window.__world, e = window.__engine;
  S.hud?.journal?.close();
  const g = S.glbFoxes;
  g.debugCalm(true);
  const v = S.vehicle?.position ?? e.camera.position;
  g.debugWalk(0, v.x + 25, v.z, 0);
  const f = g.foxes[0], B = f.brain;

  const log = [];
  const sample = (tag) => log.push({
    tag,
    t: +performance.now().toFixed(0),
    speed: +B.speed.toFixed(4),
    want: +B.wantSpeed.toFixed(4),
    state: B.state,
    walkW: +f.walk.getEffectiveWeight().toFixed(3),
    standW: +f.stand.getEffectiveWeight().toFixed(3),
    rate: +f.walk.timeScale.toFixed(2),
  });

  // Let it get up to walking speed.
  // Watch it get UP to speed too — the start of the walk is the same
  // transition run backwards, and if it never reaches walking speed the stop
  // measurement is meaningless.
  for (let i = 0; i < 40; i++) { sample('starting'); await new Promise((r) => setTimeout(r, 60)); }
  sample('walking');

  // Now stop it the way the state machine does, and watch every frame.
  B.state = 0;                 // ST.IDLE
  B.wantSpeed = 0;
  B.timer = 1e4;
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    sample('stopping');
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { log, walkSpeed: g.walkSpeed, clipSpeed: g.proto.clipSpeed, moving: g.constructor.name };
});

const L = out.log;
console.log(`walkSpeed=${out.walkSpeed.toFixed(4)} clipSpeed=${out.clipSpeed.toFixed(4)}`);
const st = L.filter((r) => r.tag === 'starting');
console.log('\n-- spin-up --');
for (let i = 0; i < st.length; i += 4) {
  const r = st[i];
  console.log(`  ${String(r.t - st[0].t).padStart(5)}  speed=${r.speed.toFixed(4)}  want=${r.want.toFixed(4)}  state=${r.state}  walkW=${r.walkW.toFixed(3)}`);
}
const w = L.find((r) => r.tag === 'walking');
console.log('at stop:', JSON.stringify(w));
const start = L.find((r) => r.tag === 'stopping');
console.log(`\n  t(ms)   speed    walkW   standW   rate`);
let prev = null, decelMs = null;
for (const r of L.filter((x) => x.tag === 'stopping')) {
  const dt = r.t - start.t;
  if (dt % 1 === 0 && (prev === null || r.t - prev >= 33)) {
    console.log(`  ${String(dt).padStart(5)}  ${r.speed.toFixed(4)}  ${r.walkW.toFixed(3)}  ${r.standW.toFixed(3)}  ${r.rate.toFixed(2)}`);
    prev = r.t;
  }
  if (decelMs === null && r.walkW <= 0.001) decelMs = dt;
}
console.log(`\nwalk weight reached 0 after ${decelMs} ms`);
await browser.close();

import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('bearflee');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178');
const SPECIES = process.argv[2] || 'bear';
const OUT = process.argv[3];
const N = 8, STEP = 4;
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 350 } });
page.on('pageerror', e => console.log('ERR', String(e)));
await page.goto(URL + '?res=640', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
const info = await page.evaluate(async (SPECIES) => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  window.__lighting.hour = 12; window.__lighting.cycleSpeed = 0;
  window.__forceCamera = true;
  const anchor = window.__cameraAnchors.meadow();
  e.camera.position.set(anchor.x, W.getHeight(anchor.x, anchor.z) + 2, anchor.z);
  e.camera.rotation.set(0, anchor.yaw ?? 0, 0, 'YXZ');
  wl.debugClear(); wl.debugThreat(null);
  wl.debugSpawn(SPECIES, { dist: 16, clear: 9, count: 1 });
  let A = null;
  for (const per of wl.pool[SPECIES]) for (const a of per) if (a.active) A = A ?? a;
  window.__A = A;
  e.stop(); e.clock.getDelta = () => 1/60;
  window.__tick = () => {
    A.brain.state = 4; A.brain.timer = 1e6; A.brain.spent = 0;
    const p = A.brain.pos, h = A.rig.proto.height * A.scale, D = 6.5, yaw = A.brain.heading + Math.PI/2;
    e.camera.position.set(p.x + Math.sin(yaw)*D*Math.cos(0.16), p.y + h*0.55 + D*Math.sin(0.16), p.z + Math.cos(yaw)*D*Math.cos(0.16));
    const gy = W.getHeight(e.camera.position.x, e.camera.position.z) + 1.6;
    if (e.camera.position.y < gy) e.camera.position.y = gy;
    e.camera.lookAt(p.x, p.y + h*0.55, p.z);
    window.__postfx?.setFocus?.(D);
    e._loop();
  };
  for (let i=0;i<150;i++) window.__tick();
  return { speed: A.brain.speed, gait: A.rig.gaitName };
}, SPECIES);
console.log(info);
for (let f = 0; f < N; f++) {
  await page.evaluate((STEP) => { for (let i=0;i<STEP;i++) window.__tick(); }, STEP);
  await page.screenshot({ path: `${OUT}-${String(f).padStart(2,'0')}.png` });
}
console.log(await page.evaluate(() => ({ speed: +window.__A.brain.speed.toFixed(2), gait: window.__A.rig.gaitName })));
await browser.close();

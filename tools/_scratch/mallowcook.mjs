/** How fast does a marshmallow actually cook, and does 'S' lower it? */
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 500, height: 400 } });
await p.addInitScript(() => { try { const k='pa.hud'; const s=JSON.parse(localStorage.getItem(k)??'{}')||{};
  s.introSeen=true; s.seenHint=true; s.escSeen=true; localStorage.setItem(k,JSON.stringify(s)); } catch {} });
await p.goto('http://127.0.0.1:5193/?seed=5', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
await p.evaluate(() => window.__vehicleTeleport?.(909.28, -160.15, -1.529));
await p.waitForTimeout(2500);
const ok = await p.evaluate(() => {
  const v = window.__systems.vehicle;
  for (let i = 0; i < 24; i++) {
    const c = window.__camp.pitchNear(v.position.x + Math.cos(i*0.9)*(i%6)*3,
                                      v.position.z + Math.sin(i*0.9)*(i%6)*3, { instant: true, radius: 22 });
    if (c) { const camp = window.__camp.camps[window.__camp.camps.length-1];
      if ((camp?.props??[]).some(pr => pr.obj?.userData?.roast)) return true; }
    window.__camp.strike();
  }
  return false;
});
console.log('camp with stick:', ok, '| entered:', await p.evaluate(() => window.__roast?.enter?.() ?? false));
await p.waitForTimeout(1500);
console.log('state:', JSON.stringify(await p.evaluate(() => window.__roast.state())).slice(0, 400));
for (const hold of [false, true]) {
  if (hold) await p.keyboard.down('KeyS');
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(3000);
    const s = await p.evaluate(() => { const st = window.__roast.state() ?? {}; return st; });
    console.log(`S=${hold} +${(i+1)*3}s  doneness=${s.doneness} height=${s.height ?? s.h} result=${s.result}`);
  }
  if (hold) await p.keyboard.up('KeyS');
}
await b.close();

// Scratch: is `state().fire` the fire? Round 10 was told it reads
// {x:0,y:0,z:0,lightI:0} while the marshmallow is at its real world position.
// Enter the view, read it before any sim step and after one, against the
// truth from V._firePos().
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const URL = `${process.env.AUTUMN_URL || 'http://127.0.0.1:5251'}?res=900&car=camper`;
const release = await acquire('firestate');
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 900, height: 560 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0,300)));
try {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 60000 });
  const at = await page.evaluate(() => { const p = window.__poi.best('meadow') ?? {x:0,z:0}; window.__vehicleTeleport?.(p.x,p.z,p.yaw ?? 0.9); return {x:p.x,z:p.z}; });
  await page.waitForTimeout(1600);
  await page.keyboard.down('Space'); await page.waitForTimeout(1000);
  await page.keyboard.up('Space'); await page.waitForTimeout(2400);
  await page.waitForFunction(() => typeof window.__camp?.pitchNear === 'function', null, { timeout: 60000, polling: 250 });
  await page.evaluate(({at}) => { window.__camp.pitchNear(at.x, at.z, { instant: true, radius: 14 }); }, {at});
  console.log(JSON.stringify(await page.evaluate(() => {
    const R = window.__roast, THREE = window.__THREE ?? window.THREE;
    R.enter(); R.setOverlay(false);
    const V = R.view;
    const truth = () => { const p = V._firePos(new THREE.Vector3()); return {x:p.x,y:p.y,z:p.z}; };
    const mal = () => { const p = V.mallow.getWorldPosition(new THREE.Vector3()); return {x:p.x,y:p.y,z:p.z}; };
    const out = { truth: truth(), mallow: mal(), light: {
      hasFire: !!V.camp?.fire, hasLight: !!V.camp?.fire?.light,
      i: V.camp?.fire?.light?.intensity ?? null } };
    out.beforeStep = R.state().fire;
    out.beforeStep_t = V.t;
    R.setT(1);
    out.afterSetT = R.state().fire;
    R.step(1/60);
    out.afterStep = R.state().fire;
    R.eat();
    R.step(1/60);
    out.duringEat = R.state().fire;
    out.phase = R.state().phase;
    return out;
  }), null, 2));
} finally { await b.close(); release(); }

// Scratch: geometry of the fall the `waterfall` anchor points at, so a framing
// can be computed instead of guessed.
import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?seed=20261018';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const out = await page.evaluate(() => {
  const W = window.__world;
  const a = window.__cameraAnchors.waterfall();
  const wf = W.waterfalls[0];
  const ag = W.getHeight(a.x, a.z);
  const d = (x1, z1, x2, z2) => Math.hypot(x2 - x1, z2 - z1);
  const wfs = W.waterfalls.map((f, i) => ({
    i, h: +f.height.toFixed(1),
    top: f.top.map((v) => +v.toFixed(1)), bot: f.bottom.map((v) => +v.toFixed(1)),
    drop: +(f.top[1] - f.bottom[1]).toFixed(1),
  }));
  // Sample the ground along the sightline from the anchor to the lip.
  const prof = [];
  for (let t = 0; t <= 1.001; t += 0.1) {
    const x = a.x + (wf.top[0] - a.x) * t, z = a.z + (wf.top[2] - a.z) * t;
    prof.push([+(t * d(a.x, a.z, wf.top[0], wf.top[2])).toFixed(0), +W.getHeight(x, z).toFixed(1)]);
  }
  return {
    anchor: { x: +a.x.toFixed(1), z: +a.z.toFixed(1), yaw: +a.yaw.toFixed(4), ground: +ag.toFixed(1) },
    fall0: { top: wf.top.map((v) => +v.toFixed(1)), bot: wf.bottom.map((v) => +v.toFixed(1)),
             h: +wf.height.toFixed(1), w: +wf.width.toFixed(1), q: +wf.discharge.toFixed(2),
             distToLip: +d(a.x, a.z, wf.top[0], wf.top[2]).toFixed(1),
             distToFoot: +d(a.x, a.z, wf.bottom[0], wf.bottom[2]).toFixed(1),
             groundAtFoot: +W.getHeight(wf.bottom[0], wf.bottom[2]).toFixed(1) },
    profile: prof,
    firstSix: wfs.slice(0, 6),
    stillBad: wfs.filter((f) => f.bot[1] < -9000).length,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

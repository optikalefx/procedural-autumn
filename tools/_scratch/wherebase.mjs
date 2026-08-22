// Scratch: where do the fall's lip, its integrated foot, and the burst/mist
// spawn points actually land in the `plunge` framing?
import { chromium } from 'playwright';
import { VIEWS } from '../shot.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { readFileSync } from 'node:fs';

const view = process.argv[2] ?? 'plunge';
const W = 800, H = 450;
const URL = (process.env.AUTUMN_URL || 'http://127.0.0.1:5205') + '/?seed=20261018';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
const frozen = JSON.parse(readFileSync('review/anchors.json', 'utf8'));
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; }, VIEWS[view].hour);
await page.evaluate(new Function('P', POSE_SRC), { v: VIEWS[view], frozen, dynamic: [] });
await page.evaluate(() => window.__settle?.(40));
const out = await page.evaluate((P) => {
  const THREE = window.__THREE, e = window.__engine, W2 = window.__world;
  const cam = e.camera; cam.updateMatrixWorld(true);
  const pr = (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(cam);
    return [Math.round((p.x * 0.5 + 0.5) * P.W), Math.round((-p.y * 0.5 + 0.5) * P.H)];
  };
  const sys = window.__systems.waterfalls;
  const fl = sys.falls.find((f) => f.wf === W2.waterfalls[0]) ?? sys.falls[0];
  const pts = fl.pts, fp = fl.fallPts ?? pts;
  const last = pts[pts.length - 1];
  const rows = [];
  for (const t of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
    const p = fp[Math.round(t * (fp.length - 1))];
    rows.push({ u: +p.u.toFixed(2), y: +p.y.toFixed(1), flight: +p.flight.toFixed(2), px: pr(p.x, p.y, p.z) });
  }
  const crest = pts[0];
  return {
    cam: [+cam.position.x.toFixed(0), +cam.position.y.toFixed(0), +cam.position.z.toFixed(0)],
    wf: { top: W2.waterfalls[0].top.map((v) => +v.toFixed(1)), bot: W2.waterfalls[0].bottom.map((v) => +v.toFixed(1)) },
    crest: { u: +crest.u.toFixed(2), y: +crest.y.toFixed(1), px: pr(crest.x, crest.y, crest.z) },
    rows,
    foot: { xyz: [+last.x.toFixed(1), +last.y.toFixed(1), +last.z.toFixed(1)], px: pr(last.x, last.y, last.z) },
    groundAtFoot: +W2.getHeight(last.x, last.z).toFixed(1),
    tof: +fl.tof.toFixed(2),
    nPts: pts.length,
  };
}, { W, H });
console.log(JSON.stringify(out));
await browser.close();

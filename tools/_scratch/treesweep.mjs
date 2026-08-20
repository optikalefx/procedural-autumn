// Trees author: N views x M variants in ONE page load, using shot.mjs's exact
// framing (frozen anchors + the near-field clearing raycast) so the frames are
// directly comparable with the canonical captures.
//
// Six authors share a 2-slot capture semaphore and the box is at load 25+, so a
// separate boot per variant is not affordable and — worse — is not an isolation
// of my change, because everyone else's edits land between two boots.
//
//   node tools/_scratch/treesweep.mjs --views forest,drive --res 1024 \
//     --dir shots/trees/diag \
//     --variants "base=()=>{}::fogoff=()=>{window.__lighting.fogScale=0;}"
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const RES = arg('res', '1024');
const DIR = arg('dir', 'shots/trees/diag');
const W = parseInt(arg('w', '1024'), 10);
const H = parseInt(arg('h', '576'), 10);
const VIEWNAMES = arg('views', 'forest,backlit').split(',');
const VARIANTS = arg('variants', 'base=()=>{}').split('::').map((x) => {
  const i = x.indexOf('=');
  return { label: x.slice(0, i), on: x.slice(i + 1) };
});

// Copied from tools/shot.mjs. Kept in sync by hand; a divergence here silently
// invalidates every comparison against the canonical sheets.
const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  vehicle:   { anchor: 'vehicle',  height: 2.6, dist: 11,  pitch: -0.10, fov: 44, hour: 17.0, subject: true },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
  dawn:      { anchor: 'vista',    height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
};

const frozen = existsSync('review/anchors.json')
  ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

await acquire('treesweep');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});

await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

for (const va of VARIANTS) mkdirSync(`${DIR}/${va.label}`, { recursive: true });

for (const name of VIEWNAMES) {
  const v = VIEWS[name];
  if (!v) { console.error('unknown view', name); continue; }
  await page.evaluate(async ({ v, frozen }) => {
    const T = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour;
    window.__lighting.cycleSpeed = 0;

    const anchor = frozen[v.anchor] ?? (
      (v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index)
                                     : (api[v.anchor] || api.vista)());
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }

    let pos, look;
    if (v.subject) {
      const gx = anchor.x - Math.sin(yaw) * v.dist, gz = anchor.z - Math.cos(yaw) * v.dist;
      pos = new T.Vector3(gx, wd.getHeight(gx, gz) + v.height, gz);
      look = new T.Vector3(anchor.x, wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4), anchor.z);
    } else {
      const back = v.standOff ?? 0;
      const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
      const gy = wd.getHeight(gx, gz) + v.height;
      pos = new T.Vector3(gx, gy, gz);
      look = new T.Vector3(gx + Math.sin(yaw) * v.dist,
                           gy + Math.tan(v.pitch) * v.dist,
                           gz + Math.cos(yaw) * v.dist);
    }

    // shot.mjs's near-field clear, verbatim in behaviour.
    const ray = new T.Raycaster(); ray.far = 6;
    const dir = new T.Vector3();
    for (let attempt = 0; attempt < 6; attempt++) {
      dir.copy(look).sub(pos).normalize();
      ray.set(pos, dir);
      const hits = ray.intersectObjects(e.scene.children, true)
        .filter((h) => h.distance > 0.05 && h.object.visible &&
                       h.object.name !== 'Sky' && !h.object.isPoints);
      if (!hits.length || hits[0].distance > 3.0) break;
      pos.y += 2.2; pos.addScaledVector(dir, -2.0); look.y += 0.7;
    }
    const g = wd.getHeight(pos.x, pos.z) + 1.4;
    if (pos.y < g) pos.y = g;

    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
    if (window.__settle) await window.__settle(90);
  }, { v, frozen });

  for (const va of VARIANTS) {
    await page.evaluate((src) => eval(src)(), va.on);
    await page.evaluate(async () => { if (window.__settle) await window.__settle(10); });
    await page.waitForTimeout(400);
    writeFileSync(`${DIR}/${va.label}/${name}.png`, await page.screenshot());
  }
  process.stderr.write(`[treesweep] ${name}\n`);
}

await browser.close();
console.log(`wrote ${VIEWNAMES.length} view(s) x ${VARIANTS.length} variant(s) under ${DIR}/`);

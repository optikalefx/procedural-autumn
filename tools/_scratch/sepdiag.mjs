// Sunlit-vs-shaded separation on IDENTICAL albedo.
//
// Captures the same posed view twice — once normally, once with the sun's cast
// shadow switched off (shadow.intensity = 0) — and compares the two frames at
// the pixels that changed. Those pixels are, by construction, the same surface
// with the same albedo under the same camera; the only difference is whether a
// cast shadow lands on them. So mean(lit) - mean(shaded) over that set is the
// separation the reference plates are measured against, with no albedo,
// weather or framing variance mixed in.
//
//   node tools/_scratch/sepdiag.mjs --view drive --w 1600 --h 900
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const VIEWS = {
  hero:      { anchor: 'vista',    height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:     { anchor: 'road',     height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 },
  chase:     { anchor: 'road',     height: 22,  dist: 60,  pitch: -0.42, fov: 45, hour: 16.7, standOff: 43 },
  meadow:    { anchor: 'meadow',   height: 1.6, dist: 6,   pitch: -0.05, fov: 58, hour: 17.2 },
  forest:    { anchor: 'forest',   height: 3.0, dist: 14,  pitch: 0.02,  fov: 60, hour: 16.4 },
  river:     { anchor: 'river',    height: 6.0, dist: 30,  pitch: -0.18, fov: 54, hour: 16.9, yawOffset: 0.42, index: 3 },
  waterfall: { anchor: 'waterfall',height: 11,  dist: 58,  pitch: 0.08,  fov: 50, hour: 16.2, yawOffset: -0.55 },
  peaks:     { anchor: 'peak',     height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  backlit:   { anchor: 'meadow',   height: 2.4, dist: 10,  pitch: 0.04,  fov: 52, hour: 17.9, faceSun: true },
};

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const RES = arg('res', null);
const NAMES = (arg('views', 'drive,meadow,river,forest')).split(',');

await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
// --url, because a worktree runs its own dev server on its own port and this
// tool used to be pinned to 5178.
const URL = arg('url', process.env.AUTUMN_URL || 'http://localhost:5178');
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):\d+\/.*(token|vite)/, () => {});
await page.goto(URL + (RES ? `?res=${RES}` : ''), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const frozen = existsSync('review/anchors.json') ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

const pose = async (v) => {
  await page.evaluate(async ({ v, frozen }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = v.hour;
    window.__lighting.cycleSpeed = 0;
    window.__atmosphere.params.cloudShadow = 0;
    const anchor = frozen[v.anchor] ?? ((v.index && window.__anchorAt) ? window.__anchorAt(v.anchor, v.index) : (api[v.anchor] || api.vista)());
    let yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
    if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
    const back = v.standOff ?? 0;
    const gx = anchor.x - Math.sin(yaw) * back, gz = anchor.z - Math.cos(yaw) * back;
    const gy = wd.getHeight(gx, gz) + v.height;
    const pos = new THREE.Vector3(gx, gy, gz);
    const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
    const g = wd.getHeight(pos.x, pos.z) + 1.4; if (pos.y < g) pos.y = g;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.copy(pos); e.camera.lookAt(look);
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
  }, { v, frozen });
  await page.evaluate(() => window.__settle?.(60));
  await page.waitForTimeout(1000);
};

const grab = async () => {
  const buf = await page.screenshot();
  return buf.toString('base64');
};

const compare = async (a, b) => page.evaluate(async ({ a, b }) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const ia = await load(a), ib = await load(b);
  const c = new OffscreenCanvas(ia.width, ia.height), g = c.getContext('2d');
  g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, ia.width, ia.height).data;
  g.clearRect(0, 0, ia.width, ia.height);
  g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
  const L = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  // deciles of the per-pixel lift, over pixels in the lower 70% of the frame
  const y0 = Math.floor(ia.height * 0.30);
  const lifts = [];
  for (let y = y0; y < ia.height; y++) for (let x = 0; x < ia.width; x++) {
    const i = (y * ia.width + x) * 4;
    lifts.push([L(db, i) - L(da, i), i]);
  }
  lifts.sort((p, q) => q[0] - p[0]);
  // The most-shadowed decile: real cast shadow, not penumbra.
  const n = Math.max(1, Math.floor(lifts.length * 0.10));
  let sumSh = 0, sumLit = 0, cr = 0, cg = 0, cb = 0;
  for (let k = 0; k < n; k++) {
    const i = lifts[k][1];
    sumSh += L(da, i); sumLit += L(db, i);
    cr += da[i]; cg += da[i + 1]; cb += da[i + 2];
  }
  const mx = Math.max(cr, cg, cb) / n, mn = Math.min(cr, cg, cb) / n;
  return {
    px: n,
    shaded: +(sumSh / n).toFixed(3),
    unshadowed: +(sumLit / n).toFixed(3),
    sep: +((sumLit - sumSh) / n).toFixed(3),
    shadedHex: '#' + [cr / n, cg / n, cb / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''),
    shadedChroma: +((mx - mn) / 255).toFixed(3),
    medianLift: +lifts[Math.floor(lifts.length * 0.5)][0].toFixed(3),
  };
}, { a, b });

// --set '[["label","js"],...]' runs the whole view list once per setting, in
// one page load. Settings are applied cumulatively, in order.
const SETS = JSON.parse(arg('set', '[["as-is","1"]]'));

console.log('setting        view        shaded  unshadowed  separation  shaded colour  chroma');
for (const [label, js] of SETS) {
  await page.evaluate((s) => eval(s), js);
  for (const name of NAMES) {
    const v = VIEWS[name]; if (!v) continue;
    await pose(v);
    const a = await grab();
    const keep = await page.evaluate(() => { const s = window.__lighting.sun.shadow; const k = s.intensity; s.intensity = 0; return k; });
    await page.evaluate(() => window.__settle?.(20));
    await page.waitForTimeout(500);
    const b = await grab();
    await page.evaluate((k) => { window.__lighting.sun.shadow.intensity = k; }, keep);
    const r = await compare(a, b);
    console.log(`${label.padEnd(14)} ${name.padEnd(11)} ${String(r.shaded).padEnd(7)} ${String(r.unshadowed).padEnd(11)} ${String(r.sep).padEnd(11)} ${r.shadedHex}        ${r.shadedChroma}`);
  }
}
await browser.close();

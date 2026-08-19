// THE NEUTRAL-POINT PROBE.
//
// The rocks author reported that "the grade renders a *pure grey* terrain
// surface as 1:0.837:0.813" at golden hour, which is a clean isolated
// measurement of the whole pipeline's neutral point. This reproduces it, and
// splits it into its two halves, in one page load:
//
//   basic  — a MeshBasicMaterial patch of known linear grey. Skips lighting
//            entirely, so what comes back is the POST CHAIN's neutral point.
//   lit    — a MeshStandardMaterial patch of the same grey, lying flat like
//            ground, receiving sun + hemi + the stylised response. Light x grade.
//   shade  — the same lit patch under an occluder placed along the sun ray, so
//            it is inside a real cast shadow and the Stylize cool mass applies.
//
// Sampled at several hours in one boot.
//
//   node tools/_scratch/look/neutral.mjs --hours 7.4,12,16.7,18.6
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const HOURS = (arg('hours', '7.4,12,16.7,18.6')).split(',').map(Number);
const RES = arg('res', '768');
const DIR = arg('dir', 'shots/look/neutral');
const VIEW = arg('view', 'meadow');
// label=js :: label=js — evaluated in the page before each hour is posed.
const VARIANTS = (arg('variants', 'ship=()=>{}')).split('::').map((x) => {
  const i = x.indexOf('='); return { label: x.slice(0, i), on: x.slice(i + 1) };
});

const VIEWS = {
  meadow: { anchor: 'meadow', height: 1.6, dist: 6, pitch: -0.05, fov: 58 },
  drive:  { anchor: 'road', height: 4.2, dist: 12, pitch: -0.10, fov: 55, standOff: 16 },
};

const frozen = existsSync('review/anchors.json')
  ? JSON.parse(readFileSync('review/anchors.json', 'utf8')) : {};

mkdirSync(DIR, { recursive: true });
await acquire('neutral');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const rows = [];
for (const va of VARIANTS) {
for (const hour of HOURS) {
  await page.evaluate((src) => eval(src)(), va.on);
  const rects = await page.evaluate(async ({ v, frozen, hour }) => {
    const THREE = window.__THREE, e = window.__engine, wd = window.__world;
    const api = window.__cameraAnchors || {};
    window.__lighting.hour = hour;
    window.__lighting.cycleSpeed = 0;
    window.__atmosphere.params.cloudShadow = 0;

    const anchor = frozen[v.anchor] ?? (api[v.anchor] || api.vista)();
    const yaw = anchor.yaw ?? 0;
    const gx = anchor.x, gz = anchor.z;
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));

    // ── build the chart once ─────────────────────────────────────────────
    let chart = e.scene.getObjectByName('__neutralChart');
    if (!chart) {
      chart = new THREE.Group();
      chart.name = '__neutralChart';
      e.scene.add(chart);
      const geo = new THREE.PlaneGeometry(2.6, 2.6);
      geo.rotateX(-Math.PI / 2);
      const mk = (name, mat, x, z, recv = true) => {
        const m = new THREE.Mesh(geo, mat);
        m.name = name; m.position.set(x, 0, z);
        m.receiveShadow = recv; m.castShadow = false;
        chart.add(m);
        return m;
      };
      const grey = () => new THREE.Color(0.5, 0.5, 0.5);          // linear 0.5
      const C0 = (h) => new THREE.Color().setHex(h, THREE.SRGBColorSpace);
      mk('basic', new THREE.MeshBasicMaterial({ color: grey(), fog: false }), -4.5, 0);
      // receiveShadow off: guaranteed full sun whatever the environment casts,
      // which is the only way to read the lit neutral point at a low sun hour.
      mk('sun', new THREE.MeshStandardMaterial({ color: grey(), roughness: 1, metalness: 0 }), -4.5, 3.2, false);
      mk('sunRock', new THREE.MeshStandardMaterial({ color: C0(0xc3bfcc), roughness: 1, metalness: 0 }), -1.5, 3.2, false);
      mk('sunGold', new THREE.MeshStandardMaterial({ color: C0(0xf0ad46), roughness: 1, metalness: 0 }), 1.5, 3.2, false);
      mk('shdGold', new THREE.MeshStandardMaterial({ color: C0(0xf0ad46), roughness: 1, metalness: 0 }), 4.5, 3.2, true);
      mk('lit', new THREE.MeshStandardMaterial({ color: grey(), roughness: 1, metalness: 0 }), -1.5, 0);
      mk('shade', new THREE.MeshStandardMaterial({ color: grey(), roughness: 1, metalness: 0 }), 1.5, 0);
      mk('rockLit', new THREE.MeshStandardMaterial({ color: C0(0xc3bfcc), roughness: 1, metalness: 0 }), 4.5, 0);
      // occluder — placed along the sun ray from the `shade` patch
      const occ = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.3, 4.0),
        new THREE.MeshStandardMaterial({ color: 0x222222 }));
      occ.name = 'occ'; occ.castShadow = true; occ.receiveShadow = false;
      chart.add(occ);
    }

    // The chart floats clear of the grass (which swallowed it at ground level)
    // and the camera looks down on it from above: what matters for a neutral
    // point is an up-facing surface under the same sun, hemi and grade, not the
    // gameplay framing.
    const cx = gx, cz = gz;
    const cy = wd.getHeight(cx, cz) + 2.2;
    chart.position.set(cx, cy, cz);
    chart.rotation.set(0, yaw, 0);
    chart.updateMatrixWorld(true);
    e.camera.fov = 45; e.camera.updateProjectionMatrix();
    e.camera.position.set(cx - Math.sin(yaw) * 6, cy + 9, cz - Math.cos(yaw) * 6);
    e.camera.lookAt(cx, cy, cz);
    e.camera.updateMatrixWorld(true);

    const sd = window.__lighting.sunDir.clone().normalize();
    const occ = chart.getObjectByName('occ');
    const shade = chart.getObjectByName('shade');
    const sw = shade.getWorldPosition(new THREE.Vector3());
    // far enough along the ray that the box itself is out of the chart's rect
    const t = 6.0 / Math.max(sd.y, 0.12);
    occ.position.copy(chart.worldToLocal(sw.clone().addScaledVector(sd, t)));
    occ.rotation.set(0, 0, 0);
    chart.updateMatrixWorld(true);

    if (window.__settle) await window.__settle(60);

    // Project each patch to screen pixels.
    const out = {};
    const cam = e.camera;
    cam.updateMatrixWorld(true);
    for (const name of ['basic', 'lit', 'shade', 'rockLit', 'sun', 'sunRock', 'sunGold', 'shdGold']) {
      const m = chart.getObjectByName(name);
      m.updateMatrixWorld(true);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const sx of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
        const p = new THREE.Vector3(sx * 2.6, 0, sz * 2.6).applyMatrix4(m.matrixWorld).project(cam);
        const px = (p.x * 0.5 + 0.5) * window.innerWidth;
        const py = (-p.y * 0.5 + 0.5) * window.innerHeight;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      // shrink to the safe interior
      const w = x1 - x0, h = y1 - y0;
      out[name] = [Math.round(x0 + w * 0.3), Math.round(y0 + h * 0.3),
                   Math.max(2, Math.round(w * 0.4)), Math.max(2, Math.round(h * 0.4))];
    }
    return out;
  }, { v: VIEWS[VIEW], frozen, hour });

  await page.waitForTimeout(500);
  const png = await page.screenshot();
  writeFileSync(`${DIR}/${va.label}-h${hour}.png`, png);

  const b64 = png.toString('base64');
  const vals = await page.evaluate(async ({ b64, rects }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const o = {};
    for (const [k, [x, y, w, h]] of Object.entries(rects)) {
      const d = g.getImageData(x, y, w, h).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      o[k] = [r / n, gg / n, b / n];
    }
    return o;
  }, { b64, rects });

  for (const [k, [r, g, b] ] of Object.entries(vals)) {
    rows.push({
      variant: va.label, hour, patch: k,
      srgb: `${Math.round(r)},${Math.round(g)},${Math.round(b)}`,
      ratio: `1:${(g / Math.max(r, 1e-6)).toFixed(3)}:${(b / Math.max(r, 1e-6)).toFixed(3)}`,
      luma: +((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255).toFixed(3),
    });
  }
  process.stderr.write(`[neutral] ${va.label} h${hour}\n`);
}
}
await browser.close();
console.table(rows);

// How much of the visible SKY is cloud, as a number.
//
// "The sky is like 90% clouds" is a measurable claim, and the areal coverage of
// the noise field is not the same number: the view ray crosses the deck at a
// grazing angle, so a pixel near the horizon is the union of every slice along
// several kilometres of deck. This measures the thing the player actually sees.
//
// Three renders per view, in one page load:
//   R1  normal
//   R2  clouds hidden          -> R1 vs R2 is the cloud
//   R3  clouds hidden and the sky dome forced black -> R2 vs R3 is the SKY MASK
// so cloud% is counted only over pixels where sky is actually visible, not over
// the whole frame (which would just measure how much terrain the view has).
//
//   node tools/_scratch/cloudfrac.mjs
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const argvHas = (n) => argv.includes('--' + n);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

// Duplicated from tools/shot.mjs — importing that module runs its capture.
const VIEWS = {
  hero:   { anchor: 'vista', height: 62,  dist: 150, pitch: -0.16, fov: 46, hour: 16.7 },
  drive:  { anchor: 'road',  height: 4.2, dist: 12,  pitch: -0.10, fov: 55, hour: 16.7 },
  peaks:  { anchor: 'peak',  height: 120, dist: 420, pitch: -0.10, fov: 42, hour: 16.0 },
  dawn:   { anchor: 'vista', height: 48,  dist: 130, pitch: -0.13, fov: 46, hour: 7.4 },
  meadow: { anchor: 'meadow', height: 1.6, dist: 6,  pitch: -0.05, fov: 58, hour: 17.2 },
};

const W = parseInt(arg('w', '800'), 10), H = parseInt(arg('h', '450'), 10);
await acquire('cloudfrac');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.goto(`http://localhost:5178/?res=${arg('res', '640')}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const rows = await page.evaluate(async ({ VIEWS, NOCIRRUS }) => {
  const e = window.__engine, wd = window.__world, cam = e.camera;
  window.__forceCamera = true;
  window.__lighting.cycleSpeed = 0;
  if (window.__settle) await window.__settle(600);
  e.stop();
  e.clock.getDelta = () => 0;
  const clouds = window.__systems.clouds;
  clouds.wind.set(0, 0);
  // Clouds.update rewrites uCirrus every frame, so the override has to land
  // after it and before the render — which is what lateUpdate is.
  if (NOCIRRUS) e.onLateUpdate(() => { clouds.uniforms.uCirrus.value = 0; });

  const gl = e.renderer.getContext();
  const grab = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const shot = (n = 1) => { for (let i = 0; i < n; i++) e._loop(); return grab(); };
  const dif = (a, b, i) => (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;

  const out = [];
  for (const [name, v] of Object.entries(VIEWS)) {
    window.__lighting.hour = v.hour;
    const a = (window.__cameraAnchors[v.anchor] || window.__cameraAnchors.vista)();
    const yaw = a.yaw ?? 0;
    const gy = wd.getHeight(a.x, a.z) + v.height;
    cam.fov = v.fov; cam.updateProjectionMatrix();
    cam.position.set(a.x, gy, a.z);
    cam.lookAt(a.x + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, a.z + Math.cos(yaw) * v.dist);
    const q = cam.quaternion.clone(), p = cam.position.clone();
    const hold = () => { cam.position.copy(p); cam.quaternion.copy(q); };
    const rel = e.onLateUpdate(hold);

    const R1 = shot(6);
    clouds.mesh.visible = false;
    const R2 = shot(3);
    const su = window.__sky.uniforms;
    const keep = ['uZenith', 'uHorizon', 'uSunHorizon', 'uGlow', 'uSunColor'].map((k) => su[k].value.clone());
    const kg = su.uGlowIntensity.value, kd = su.uDiscIntensity.value;
    for (const k of ['uZenith', 'uHorizon', 'uSunHorizon', 'uGlow', 'uSunColor']) su[k].value.setScalar(0);
    su.uGlowIntensity.value = 0; su.uDiscIntensity.value = 0;
    // Lighting.update rewrites those uniforms every frame, so render by hand.
    e.renderer.info.reset();
    if (e._render) e._render(0, e.elapsed); else e.renderer.render(e.scene, cam);
    const R3 = grab();
    ['uZenith', 'uHorizon', 'uSunHorizon', 'uGlow', 'uSunColor'].forEach((k, i) => su[k].value.copy(keep[i]));
    su.uGlowIntensity.value = kg; su.uDiscIntensity.value = kd;
    clouds.mesh.visible = true;
    shot(2);

    let sky = 0, any = 0, mid = 0, solid = 0;
    for (let i = 0; i < R1.length; i += 4) {
      if (dif(R2, R3, i) <= 8) continue;      // not a sky pixel
      sky++;
      const d = dif(R1, R2, i);
      if (d > 5) any++;
      if (d > 11) mid++;
      if (d > 20) solid++;
    }
    const total = R1.length / 4;
    out.push({
      view: name, hour: v.hour,
      skyPctOfFrame: +(100 * sky / total).toFixed(1),
      cloudPctOfSky: +(100 * any / Math.max(sky, 1)).toFixed(1),
      midPctOfSky: +(100 * mid / Math.max(sky, 1)).toFixed(1),
      solidPctOfSky: +(100 * solid / Math.max(sky, 1)).toFixed(1),
      cover: +window.__systems.clouds.uniforms.uCover.value.toFixed(3),
    });
    e._lateUpdaters.splice(e._lateUpdaters.indexOf(rel), 1);
  }
  return out;
}, { VIEWS, NOCIRRUS: argvHas('nocirrus') });

for (const r of rows) {
  console.log(`${r.view.padEnd(7)} h${String(r.hour).padEnd(5)} cover ${r.cover}  sky ${String(r.skyPctOfFrame).padStart(5)}% of frame` +
              `   cloud ${String(r.cloudPctOfSky).padStart(5)}% of sky   mid ${String(r.midPctOfSky).padStart(5)}%   solid ${String(r.solidPctOfSky).padStart(5)}%`);
}
if (errs.length) console.log('page-errors:', JSON.stringify(errs.slice(0, 5)));
await browser.close();

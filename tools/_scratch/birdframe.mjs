// Frame one wheeling flock head-on and measure what its birds actually render
// as: distance, on-screen wingspan, and the darkest rendered pixel on the bird
// against the sky immediately beside it.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const HOUR = parseFloat(arg('hour', '16.7'));
const FLOCK = parseInt(arg('flock', '1'), 10);
const FOV = parseFloat(arg('fov', '22'));
const OUT = arg('out', 'shots/fix/crop/birdframe.png');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

const info = await page.evaluate(async ({ HOUR, FLOCK, FOV }) => {
  const THREE = window.__THREE, e = window.__engine, wd = window.__world;
  window.__lighting.hour = HOUR; window.__lighting.cycleSpeed = 0;
  const bd = window.__systems.wildlife.birds;
  window.__forceCamera = true;
  window.__atmosphere.params.cloudShadow = 0;
  if (window.__settle) await window.__settle(900);

  const f = bd.flocks[FLOCK];
  // Stand 170 m from the flock centre, at driving eye height, looking at it.
  const dx = f.cx - e.camera.position.x, dz = f.cz - e.camera.position.z;
  const d = Math.hypot(dx, dz) || 1;
  // Back off only as far as keeps the flock at least 22 degrees above the
  // horizon, so there is sky behind it rather than a hillside.
  let dist = 170, px = 0, pz = 0, py = 0;
  for (let it = 0; it < 3; it++) {
    px = f.cx - dx / d * dist; pz = f.cz - dz / d * dist;
    py = wd.getHeight(px, pz) + 2.2;
    dist = Math.min(200, Math.max(55, (f.cy - py) / Math.tan(22 * Math.PI / 180)));
  }
  e.camera.fov = FOV; e.camera.updateProjectionMatrix();
  e.camera.position.set(px, py, pz);
  e.camera.lookAt(f.cx, f.cy, f.cz);
  window.dispatchEvent(new Event('resize'));
  if (window.__settle) await window.__settle(90);

  // Render twice, once with the flock hidden, and read both back. The diff is
  // the only honest way to know which pixels are bird.
  const gl = e.renderer.getContext();
  const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
  const A = new Uint8Array(w * h * 4), B = new Uint8Array(w * h * 4);
  const grab = (out) => {
    e.renderer.setRenderTarget(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  };
  e.stop(); e.clock.getDelta = () => 0;
  e._loop(); grab(A);
  const vis = bd.flocks.map((x) => x.mesh.visible);
  for (const x of bd.flocks) x.mesh.visible = false;
  e._loop(); grab(B);
  for (let i = 0; i < bd.flocks.length; i++) bd.flocks[i].mesh.visible = vis[i];
  e._loop();

  let changed = 0, darkest = [255, 255, 255], skyAt = [0, 0, 0], sum = [0, 0, 0];
  for (let i = 0; i < A.length; i += 4) {
    const dr = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (dr < 18) continue;
    changed++;
    sum[0] += A[i]; sum[1] += A[i + 1]; sum[2] += A[i + 2];
    const l = A[i] + A[i + 1] + A[i + 2];
    if (l < darkest[0] + darkest[1] + darkest[2]) {
      darkest = [A[i], A[i + 1], A[i + 2]];
      skyAt = [B[i], B[i + 1], B[i + 2]];
    }
  }
  const mean = changed ? sum.map((s) => Math.round(s / changed)) : null;

  const M = new THREE.Matrix4(), v = new THREE.Vector3();
  const rows = [];
  for (let i = 0; i < f.n; i++) {
    f.mesh.getMatrixAt(i, M);
    v.setFromMatrixPosition(M);
    const dist = v.distanceTo(e.camera.position);
    const span = f.birds[i].sc;
    const pxs = span / dist / (2 * Math.tan(e.camera.fov * Math.PI / 360)) * h;
    rows.push({ dist: +dist.toFixed(0), span: +span.toFixed(2), px: +pxs.toFixed(1),
      alt: +(v.y - wd.getHeight(v.x, v.z)).toFixed(0) });
  }
  e.start();
  return {
    flock: FLOCK, n: f.n, centreY: +f.cy.toFixed(0),
    birdPixels: changed, meanBirdSrgb: mean,
    darkestBirdSrgb: darkest, skyBehindThatPixel: skyAt,
    birds: rows,
  };
}, { HOUR, FLOCK, FOV });
await page.waitForTimeout(700);
writeFileSync(OUT, await page.screenshot({ type: 'png' }));
await browser.close();
console.log(JSON.stringify(info, null, 1));
console.log('shot:', OUT);

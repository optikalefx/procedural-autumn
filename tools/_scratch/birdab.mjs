// Which of the dark specks in the sky are BIRDS?
//
// Poses a canonical view, freezes the sim, renders the same frame twice — once
// with the flock and burst meshes visible and once without — and reports every
// connected run of changed pixels: its screen box, its size, its rendered
// colour and the sky colour behind it. Anything it does not list is somebody
// else's particle.
//
//   node tools/_scratch/birdab.mjs --view backlit --res 768
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const RES = arg('res', '768');
const NAMES = (arg('view', 'backlit,forest,vehicle,peaks')).split(',');
const DIR = arg('dir', 'shots/fix/birdab');
const W = +arg('w', '1600'), H = +arg('h', '900');

mkdirSync(resolve(DIR), { recursive: true });
await acquire('shot');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 300)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });

for (const name of NAMES) {
  const v = VIEWS[name];
  const out = await page.evaluate(async ({ v, name, H }) => {
    const e = window.__engine, wd = window.__world;
    window.__lighting.hour = v.hour; window.__lighting.cycleSpeed = 0;
    if (window.__atmosphere) window.__atmosphere.params.cloudShadow = 0;
    window.__forceCamera = true;
    const a = (window.__cameraAnchors[v.anchor] ?? window.__cameraAnchors.vista)(v.index ?? 0);
    const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0) + (v.faceSun ? Math.PI : 0);
    const px = a.x - Math.sin(yaw) * v.dist, pz = a.z - Math.cos(yaw) * v.dist;
    const py = wd.getHeight(px, pz) + v.height;
    e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
    e.camera.position.set(px, py, pz);
    e.camera.lookAt(a.x, wd.getHeight(a.x, a.z) + v.height + Math.tan(v.pitch) * v.dist, a.z);
    if (window.__settle) await window.__settle(600);

    const gl = e.renderer.getContext();
    const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
    const A = new Uint8Array(w * h * 4), B = new Uint8Array(w * h * 4);
    const grab = (o) => {
      e.renderer.setRenderTarget(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, o);
    };
    const bd = window.__systems.wildlife.birds;
    const meshes = [...bd.flocks.map((f) => f.mesh), bd.burstMesh];
    e.stop(); e.clock.getDelta = () => 0;
    e._loop(); grab(A);
    const vis = meshes.map((m) => m.visible);
    for (const m of meshes) m.visible = false;
    e._loop(); grab(B);
    for (let i = 0; i < meshes.length; i++) meshes[i].visible = vis[i];
    e._loop();
    e.start();

    // Flood-fill the changed mask into blobs.
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < A.length; i += 4, p++) {
      const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
      if (d >= 18) mask[p] = 1;
    }
    const blobs = [];
    const stack = new Int32Array(w * h);
    for (let p0 = 0; p0 < mask.length; p0++) {
      if (!mask[p0]) continue;
      let sp = 0; stack[sp++] = p0; mask[p0] = 2;
      let n = 0, minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
      let sr = 0, sg = 0, sb = 0, br = 0, bg = 0, bb = 0, dark = 1e9, darkPx = null;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        n++;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        const i = p * 4;
        sr += A[i]; sg += A[i + 1]; sb += A[i + 2];
        br += B[i]; bg += B[i + 1]; bb += B[i + 2];
        const l = A[i] + A[i + 1] + A[i + 2];
        if (l < dark) { dark = l; darkPx = [A[i], A[i + 1], A[i + 2]]; }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx;
            if (mask[q] === 1) { mask[q] = 2; stack[sp++] = q; }
          }
        }
      }
      if (n < 6) continue;
      blobs.push({
        // readPixels is bottom-up; report top-down screen coords.
        box: [minx, H - 1 - maxy, maxx, H - 1 - miny],
        px: n,
        bird: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
        behind: [Math.round(br / n), Math.round(bg / n), Math.round(bb / n)],
        darkest: darkPx,
      });
    }
    blobs.sort((x, y) => y.px - x.px);
    return { view: name, birdBlobs: blobs.length, blobs: blobs.slice(0, 12) };
  }, { v, name, H });
  writeFileSync(resolve(DIR, name + '.png'), await page.screenshot({ type: 'png' }));
  console.log(JSON.stringify(out));
}
await browser.close();

import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
await acquire('birdcheck');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 420, height: 300 }, deviceScaleFactor: 1 });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
await p.goto('http://localhost:5178?res=512');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
console.log(await p.evaluate(() => {
  const e = window.__engine, T = window.__THREE, wl = window.__systems.wildlife;
  const bd = wl.birds;
  window.__forceCamera = true;
  e.stop(); e.clock.getDelta = () => 1 / 60;
  const c = e.camera;
  const g = window.__world.getHeight(c.position.x, c.position.z);
  const bp = bd.debugBurst(c.position.x, g + 6, c.position.z + 12);
  c.position.set(bp.x, bp.y - 1.5, bp.z - 9);
  c.lookAt(bp.x, bp.y, bp.z);
  c.fov = 50; c.updateProjectionMatrix();
  for (let i = 0; i < 4; i++) e._loop();
  const gl = e.renderer.getContext();
  const w = e.renderer.domElement.width, h = e.renderer.domElement.height;
  const A = new Uint8Array(w * h * 4), B = new Uint8Array(w * h * 4);
  const grab = (out) => {
    e.renderer.setRenderTarget(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  };
  e._loop(); grab(A);
  bd.burstMesh.visible = false;
  e._loop(); grab(B);
  bd.burstMesh.visible = true;
  let diff = 0;
  for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) > 8) diff++;
  // Where should they be on screen?
  const M = new T.Matrix4(), v = new T.Vector3();
  const S = bd.bursts.find((x) => x.life > 0);
  const pts = [];
  for (let i = 0; i < 3; i++) {
    bd.burstMesh.getMatrixAt(S.base + i, M);
    v.setFromMatrixPosition(M).project(c);
    pts.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)]);
  }
  e.start();
  return JSON.stringify({
    diffPixels: diff, w, h, ndc: pts,
    matVisible: bd.burstMesh.visible, count: bd.burstMesh.count,
    prog: !!e.renderer.properties.get(bd.mat).currentProgram,
    drawRange: bd.burstMesh.geometry.drawRange,
    posCount: bd.burstMesh.geometry.attributes.position.count,
    beatCount: bd.burstMesh.geometry.attributes.aBeat.count,
    isInst: !!bd.burstMesh.geometry.attributes.aBeat.isInstancedBufferAttribute,
  });
}));
if (errs.length) console.log('ERRORS', JSON.stringify(errs.slice(0, 6), null, 1));
await b.close();

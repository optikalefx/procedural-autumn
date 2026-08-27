// How far off face-on is the page when the book opens? Measured off the leaf's
// own normal against the view direction, not inferred from the pose constant.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('/tmp/booktilt', { recursive: true });
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} }; }
    return new R(u, p); };
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
// A print has to exist or `study()` has nothing to go to — the first run of
// this harness reported a close-look angle with `seat: null`, i.e. it measured
// the spread twice and called one of them the close look.
await page.evaluate(async () => {
  localStorage.removeItem('pa.hunt');
  const cam = window.__ctx.camera;
  window.__forceCamera = true; window.__hudForce = true;
  const { detectSubjects } = await import('/src/game/hunt_detect.js');
  const falls = window.__ctx.world?.waterfalls ?? [];
  for (let f = 0; f < Math.min(falls.length, 6); f++) {
    const wf = falls[f];
    const mid = [(wf.top[0] + wf.bottom[0]) / 2, (wf.top[1] + wf.bottom[1]) / 2,
                 (wf.top[2] + wf.bottom[2]) / 2];
    for (const r of [50, 90, 150]) for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      cam.position.set(mid[0] + Math.sin(ang) * r, mid[1] + r * 0.25, mid[2] + Math.cos(ang) * r);
      cam.lookAt(mid[0], mid[1], mid[2]); cam.updateMatrixWorld(true);
      if (detectSubjects(window.__ctx).includes('waterfall')) return;
    }
  }
});
await page.waitForTimeout(2500);
await page.evaluate(() => { window.__systems.hud.toast = () => {}; window.__systems.hud.photo.capture(); });
await page.waitForTimeout(5000);
await page.evaluate(() => window.__systems.hud.journal.close());
await page.waitForTimeout(900);
await page.keyboard.press('j');
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/booktilt/spread.png' });
// And the close look, which solves its own framing per frame — it should adapt
// rather than inherit the old angle.
const seat = await page.evaluate(() => {
  const j = window.__systems.hud.journal;
  for (let p = 0; p < j._pages.length; p++)
    for (const [i, r] of (j._pages[p].spec?.rows ?? []).entries())
      if (r?.done && r?.photo) { j.study(p, i); return { p, i }; }
  return null;
});
await page.waitForTimeout(1400);
if (seat) await page.screenshot({ path: '/tmp/booktilt/close.png' });
const closeOff = await page.evaluate(() => {
  const T = window.__THREE, j = window.__systems.hud.journal;
  const m = j._J.pageRight; m.updateWorldMatrix(true, false);
  const n = new T.Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new T.Quaternion())).normalize();
  const v = new T.Vector3(); j.camera.getWorldDirection(v);
  return +(Math.acos(Math.min(1, Math.abs(n.dot(v)))) * 180 / Math.PI).toFixed(1);
});
console.log('seat found:', JSON.stringify(seat), ' close look off face-on:', closeOff, 'deg');
await page.evaluate(() => window.__systems.hud.journal.zoomOut());
await page.waitForTimeout(900);

const out = await page.evaluate(() => {
  const T = window.__THREE, j = window.__systems.hud.journal;
  const mesh = j._J.pageRight;
  mesh.updateWorldMatrix(true, false);
  // The leaf's own +Z in world space, against the direction the camera looks.
  const n = new T.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new T.Quaternion())).normalize();
  const view = new T.Vector3();
  j.camera.getWorldDirection(view);
  const off = Math.acos(Math.min(1, Math.abs(n.dot(view)))) * 180 / Math.PI;
  return {
    pageOffFaceOnDeg: +off.toFixed(1),
    bookRotXDeg: +(j.book.rotation.x * 180 / Math.PI).toFixed(1),
  };
});
console.log(JSON.stringify(out));
await b.close();

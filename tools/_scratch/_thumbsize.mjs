// Should THUMB_MAX go 512 -> 1024? The constraint is localStorage: the store
// keeps up to 15 prints in a ~5 MB origin budget it shares with `pa.stats`.
// Measure real frames rather than assume JPEG scales with pixel count.
import { chromium } from 'playwright';
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

const out = await page.evaluate(async () => {
  const cv = document.querySelector('canvas#gl');
  const fx = window.__postfx;
  const rows = [];
  // Five real frames from five poses, so the numbers are not one lucky picture.
  const poses = [[-654, 113, 59], [-360, 120, -430], [140, 95, -890],
                 [22, 90, -1030], [-90, 130, -300]];
  for (const [x, y, z] of poses) {
    const cam = window.__ctx.camera;
    window.__forceCamera = true;
    cam.position.set(x, y, z);
    cam.lookAt(x + 40, y - 12, z + 40);
    cam.updateMatrixWorld(true);
    await new Promise((r) => requestAnimationFrame(r));
    fx.render(1 / 60);
    const shot = (max, q) => {
      const c = document.createElement('canvas');
      const k = max / Math.max(cv.width, cv.height);
      c.width = Math.round(cv.width * k); c.height = Math.round(cv.height * k);
      c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', q);
      return { px: `${c.width}x${c.height}`, kb: +(url.length / 1024).toFixed(1) };
    };
    rows.push({ at512: shot(512, 0.72), at1024: shot(1024, 0.72), at1024q60: shot(1024, 0.60) });
  }
  return rows;
});

const mean = (k, f) => +(out.reduce((a, r) => a + f(r), 0) / out.length).toFixed(1);
console.log('per print, mean over 5 real frames:');
console.log(`  512  q0.72 : ${mean('a', (r) => r.at512.kb)} KB   (${out[0].at512.px})`);
console.log(`  1024 q0.72 : ${mean('b', (r) => r.at1024.kb)} KB   (${out[0].at1024.px})`);
console.log(`  1024 q0.60 : ${mean('c', (r) => r.at1024q60.kb)} KB`);
const full15 = (v) => +((v * 15) / 1024).toFixed(2);
console.log('\na full sheet of 15:');
console.log(`  512  q0.72 : ${full15(mean('a', (r) => r.at512.kb))} MB`);
console.log(`  1024 q0.72 : ${full15(mean('b', (r) => r.at1024.kb))} MB`);
console.log(`  1024 q0.60 : ${full15(mean('c', (r) => r.at1024q60.kb))} MB`);
console.log('\n(localStorage is ~5 MB for the whole origin, shared with pa.stats)');
await b.close();

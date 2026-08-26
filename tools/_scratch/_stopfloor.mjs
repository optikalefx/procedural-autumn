// How much blur is left at the closed-down end of the ring? Measure acutance
// (sigma of a Laplacian) at each stop against the same frame with the effect
// off. A stop that "removes the bokeh altogether" should read the same as off.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hud = window.__systems.hud, fx = window.__postfx;
  hud.togglePhoto();
  await sleep(2500);
  // What the player sees the instant the mode opens, before touching anything.
  const openingStop = hud.photo.focus.fStop;
  const cv = window.__ctx.renderer.domElement;
  const grab = () => {
    fx.render(1 / 60);
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    c.getContext('2d').drawImage(cv, 0, 0, 480, 270);
    return c.getContext('2d').getImageData(0, 0, 480, 270).data;
  };
  // Acutance over the whole frame: sigma of a 4-neighbour Laplacian on luma.
  const acut = (d, w = 480, h = 270) => {
    const L = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) L[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const v = 4 * L[p] - L[p - 1] - L[p + 1] - L[p - w] - L[p + w];
      s += v; s2 += v * v; n++;
    }
    const m = s / n;
    return Math.sqrt(s2 / n - m * m);
  };
  // Put the plane somewhere near, so a wide stop clearly blurs the distance.
  hud.photo.focus.setDistance(12);
  await sleep(300);
  const rows = [];
  for (const f of [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 28]) {
    hud.photo.focus.setAperture(f);
    await sleep(120);
    rows.push({ f, acutance: +acut(grab()).toFixed(2) });
  }
  // Round trip: the pinhole must not be a one-way door.
  hud.photo.focus.setAperture(28); await sleep(150);
  const atPinhole = +acut(grab()).toFixed(2);
  hud.photo.focus.setAperture(2.8); await sleep(150);
  const backWide = +acut(grab()).toFixed(2);
  hud.photo.focus.setAperture(28); await sleep(150);
  const pinholeAgain = +acut(grab()).toFixed(2);
  fx.setPhotoDOF(false);
  await sleep(250);
  const off = +acut(grab()).toFixed(2);
  return { rows, off, atPinhole, backWide, pinholeAgain, openingStop, openingAcut: +acut(grab()).toFixed(2) };
});
console.log(`opens at f/${out.openingStop}, and the opening frame measures `
  + `${out.openingAcut} against ${out.off} with the effect off `
  + `(${(100 * out.openingAcut / out.off).toFixed(1)}%)`);
console.log(`effect OFF: ${out.off}`);
for (const r of out.rows) {
  const pct = (100 * r.acutance / out.off).toFixed(1);
  console.log(`  f/${String(r.f).padEnd(4)} ${String(r.acutance).padStart(7)}  ${pct}% of off`);
}
console.log(`\nround trip: pinhole ${out.atPinhole} -> f/2.8 ${out.backWide} -> pinhole ${out.pinholeAgain}`);
console.log(out.backWide < out.off * 0.3 && Math.abs(out.pinholeAgain - out.off) < 0.5
  ? '  PASS - blur comes back, and the pinhole is repeatable'
  : '  FAIL - the pinhole is a one-way door');
await b.close();

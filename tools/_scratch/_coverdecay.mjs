// The put-down's cover curve must be a function of TIME, not of frame count.
// Sample it at two different step sizes and compare.
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
// Drive a REAL close on the rAF loop and record (t, cover). Calling update()
// by hand left the journal inactive and every sample read 1.0 — a harness that
// exercises nothing and reports PASS.
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hud = window.__systems.hud, j = hud.journal;
  hud.toggleJournal();
  await sleep(2200);
  const samples = [];
  const real = j.update.bind(j);
  const t0 = performance.now();
  j.update = (dt) => { real(dt);
    // The journal's OWN clock, not wall time: `_t` is gated (it stops while a
    // page seek is outstanding), so a wall-clock fit reads as drift that is not
    // there. That mistake made the first run of this harness report FAIL.
    if (j._closing) samples.push([+j._t.toFixed(4), +j._pose.cover.toFixed(4)]); };
  j.close();
  await sleep(900);
  j.update = real;
  // Fit against the analytic curve the code claims: cover0 * (1 - easeInOut(k)*0.9).
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const c0 = j._closeCover ?? 1;
  let worst = 0;
  for (const [t, c] of samples) {
    const k = Math.max(0, Math.min(1, t / 0.46));
    worst = Math.max(worst, Math.abs(c - c0 * (1 - ease(k) * 0.9)));
  }
  return { n: samples.length, first: samples[0], last: samples[samples.length - 1],
           worstDeviationFromTimeCurve: +worst.toFixed(4) };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.n > 10 && out.worstDeviationFromTimeCurve < 0.05
  ? `PASS - ${out.n} frames, tracks the time curve to ${out.worstDeviationFromTimeCurve}`
  : `FAIL - ${out.n} samples, worst deviation ${out.worstDeviationFromTimeCurve}`);
await b.close();

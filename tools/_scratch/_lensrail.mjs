// The photo rail with a lens fitted: does the preview render, does the ring
// turn, does swapping the body actually change the field of view?
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = '/tmp/lensrail'; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
});
page.on('console', (m) => { if (m.type() === 'error' && !/POSTHOG/i.test(m.text())) console.log('  [err]', m.text()); });
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
await page.waitForTimeout(2500);
const read = () => page.evaluate(() => {
  const p = window.__systems.hud.photo;
  return { label: p.lens.label(), lens: p.lens.lens.id, focal: +p.lens.focal.toFixed(1),
           rigFov: +(window.__systems.cameraRig.fov).toFixed(2),
           camFov: +window.__ctx.camera.fov.toFixed(2) };
});
console.log('fitted   ', JSON.stringify(await read()));
await page.screenshot({ path: `${OUT}/01-wide.png` });

// Walk the ring one detent at a time. The claim USED to be that 70->200 costs a
// detent of resistance and then swaps the body; it is the opposite now — the
// ring parks at the fitted lens's own stop and says so, and `L` is the only way
// across the gap (see docs/LENS_NOTES.md §2). So a LENS SWAP appearing in this
// walk is a FAILURE, not the headline.
let prev = null;
for (let i = 0; i < 26; i++) {
  await page.keyboard.press(']');
  await page.waitForTimeout(120);
  const st = await read();
  const tag = prev && st.lens !== prev.lens ? '  <-- LENS SWAP — REGRESSION'
            : prev && st.focal === prev.focal ? '  <-- parked at the stop' : '';
  console.log(`  ${String(i + 1).padStart(2)}  ${st.label.padEnd(26)} fov ${String(st.rigFov).padStart(6)}${tag}`);
  prev = st;
}
await page.screenshot({ path: `${OUT}/03-tele.png` });
console.log(prev.lens === 'wide' ? 'PASS — 26 presses stayed on the fitted lens'
                                 : 'FAIL — the ring changed the body by itself');
// L is still the way across.
await page.keyboard.press('l');
await page.waitForTimeout(200);
console.log('after L ', JSON.stringify(await read()));

// And out: the rig's own fov has to come back, or the first driving frame is 400mm.
await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
await page.waitForTimeout(900);
console.log('exited   ', JSON.stringify(await page.evaluate(() => ({
  rigFov: +window.__systems.cameraRig.fov.toFixed(2),
  camFov: +window.__ctx.camera.fov.toFixed(2),
  mode: window.__systems.cameraRig.mode,
}))));
await b.close();

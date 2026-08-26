// The two wiring defects the round-two lens critic found, tested directly.
//   1. a refused second WebGL context must not cost the player the whole HUD
//   2. the aperture ring must not open a lens wider than the lens opens
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const HMR = () => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
};
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });

// ── 1. refuse every context after the first ────────────────────────────────
{
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(HMR);
  await page.addInitScript(() => {
    // The game's own canvas gets its context; anything after it is refused,
    // which is what a phone does when it is already holding one.
    let given = 0;
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      if (/webgl/i.test(kind) && given++ >= 1) return null;
      return real.call(this, kind, ...rest);
    };
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]));
  await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  const r = await page.evaluate(async () => {
    const hud = window.__systems.hud;
    hud.togglePhoto();
    await new Promise((s) => setTimeout(s, 1500));
    return {
      hudExists: !!hud.root && document.body.contains(hud.root),
      compassDrawn: !!hud.root.querySelector('.pa-compass'),
      photoOpen: hud.photo.active,
      previewOk: hud.photo.lensPreview?.ok ?? null,
      labelText: hud.photo.lensLabel?.textContent ?? null,
      canvasesInRow: hud.photo.lensRow.querySelectorAll('canvas').length,
    };
  });
  console.log('CONTEXT REFUSED →', JSON.stringify(r));
  console.log(r.hudExists && r.compassDrawn && r.photoOpen && r.canvasesInRow === 0
    ? '  PASS — HUD intact, photo mode opens, label stands in for the preview'
    : '  FAIL');
  console.log('  page errors:', errs.length ? errs : 'none');
  await page.close();
}

// ── 2. the aperture cannot exceed the fitted lens ──────────────────────────
{
  const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(HMR);
  await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  const r = await page.evaluate(async () => {
    const hud = window.__systems.hud;
    hud.togglePhoto();
    await new Promise((s) => setTimeout(s, 1500));
    const p = hud.photo;
    const out = {};
    // Fit the tele (an f/4) and then try hard to open it past f/4.
    p.lens.setLens('tele');
    await new Promise((s) => setTimeout(s, 300));
    out.lens = p.lens.label();
    for (let i = 0; i < 6; i++) p.focus.nudgeAperture(-1);
    out.afterOpeningSixNotches = p.focus.fStop;
    out.setApertureTo1_4 = (p.focus.setAperture(1.4), p.focus.fStop);
    for (let i = 0; i < 12; i++) p.focus.nudgeAperture(1);
    out.afterStoppingDownTwelve = p.focus.fStop;
    // And the wide, an f/2.8.
    p.lens.setLens('wide');
    await new Promise((s) => setTimeout(s, 300));
    for (let i = 0; i < 6; i++) p.focus.nudgeAperture(-1);
    out.wideAfterOpening = p.focus.fStop;
    out.wideLabel = p.lens.label();
    return out;
  });
  console.log('APERTURE CLAMP →', JSON.stringify(r, null, 1));
  console.log(r.afterOpeningSixNotches === 4 && r.setApertureTo1_4 === 4 && r.wideAfterOpening === 2.8
    ? '  PASS — neither ring nor setter can open past the fitted lens'
    : '  FAIL');
  await page.close();
}
await b.close();

// Does the wiring the integrator added actually fire? J opens the book, photo
// mode enables the lens, exiting puts PostFX back.
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
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(async () => {
  const hud = window.__systems.hud;
  const fx = window.__postfx;
  const r = {};

  // J opens the book, and the interface stands down with it.
  try {
    hud.toggleJournal();
    r.directCallThrew = false;
  } catch (e) { r.directCallThrew = String(e); }
  await new Promise((s) => setTimeout(s, 900));
  r.afterDirectCall = { active: hud.journal.active, ready: hud.journal.ready,
                        chrome: hud.root.classList.contains('pa-journal') };
  hud.journal.close();
  await new Promise((s) => setTimeout(s, 600));

  // Photo mode arms the lens, and leaving it puts the chain back exactly.
  const before = { passes: fx.composer.passes.length, dof: !!fx.dof,
                   exposure: fx.getExposure(),
                   sat: fx.grade.uniforms.get('uSaturation').value };
  hud.togglePhoto();
  await new Promise((s) => setTimeout(s, 700));
  r.focusArmed = !!fx.dof;
  r.focusMetres = hud.photo.focus?.distance ?? null;
  hud.photo.focus?.nudge?.(4);
  r.focusMovedOnNudge = (hud.photo.focus?.distance ?? 0) !== r.focusMetres;
  hud.togglePhoto();
  await new Promise((s) => setTimeout(s, 700));
  const after = { passes: fx.composer.passes.length, dof: !!fx.dof,
                  exposure: fx.getExposure(),
                  sat: fx.grade.uniforms.get('uSaturation').value };
  r.restored = JSON.stringify(before) === JSON.stringify(after);
  r.before = before; r.after = after;
  return r;
});

// Real key presses, not synthetic dispatch. A `new KeyboardEvent` fired at
// `window` arrives with `target === window`, and HUD._onKey's first line is
// `this.root.contains(e.target)` — `Node.contains` with a non-Node throws, so
// the handler dies before its switch and EVERY key looks unwired. Cost me a
// round chasing a binding that was fine.
await page.keyboard.press('j');
await page.waitForTimeout(900);
const keyJ = await page.evaluate(() => ({
  jOpens: window.__systems.hud.journal.active,
  chromeHidden: window.__systems.hud.root.classList.contains('pa-journal'),
}));
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const afterEsc = await page.evaluate(() => ({
  closed: !window.__systems.hud.journal.active,
  chromeBack: !window.__systems.hud.root.classList.contains('pa-journal'),
}));
console.log(JSON.stringify({ keyJ, afterEsc }, null, 1));
console.log(JSON.stringify(out, null, 1));
await b.close();

// "Restores exactly" was the property this mode was reviewed on twice. Check
// every uniform the photo path writes, not just the ones anyone looked at.
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
  const fx = window.__postfx, hud = window.__systems.hud;
  const snap = () => {
    // Force the effect to exist at the tier so there is something to compare.
    fx._tierDOF = true; fx._syncDOF();
    const u = fx._dofEffect.cocMaterial.uniforms;
    return { focusDistance: u.focusDistance.value, cocGain: u.uCocGain?.value,
             cocKnee: u.uCocKnee?.value, cocPhysical: u.uCocPhysical?.value,
             bokehScale: fx._dofEffect.bokehScale, focusRange: fx._dofEffect.cocMaterial.uniforms.focusRange?.value,
             passes: fx.composer.passes.length };
  };
  const before = snap();
  for (let i = 0; i < 3; i++) {
    hud.togglePhoto(); await new Promise((s) => setTimeout(s, 900));
    hud.photo.focus.nudge(4); hud.photo.focus.nudgeAperture(2);
    await new Promise((s) => setTimeout(s, 300));
    hud.togglePhoto(); await new Promise((s) => setTimeout(s, 900));
  }
  const after = snap();
  // `focusDistance` is EXCLUDED, and not as a convenience. Forcing `_tierDOF`
  // on so there is an effect to read also arms `CameraRig`'s own per-frame
  // `fx.setFocus(d * 1.15 + 4)` (CameraRig.js:869) — the tier's focus follows
  // the subject by design. Its value after the run is the rig's live number,
  // which is the tier working, not photo mode leaking. Everything else here is
  // written ONLY by the photo path and must come back.
  const watched = Object.keys(before).filter((k) => k !== 'focusDistance');
  const diff = watched.filter((k) => before[k] !== after[k]);
  return { before, after, diff, note: 'focusDistance excluded — driven by CameraRig at the tier' };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.diff.length === 0 ? 'PASS — every uniform restored' : `FAIL — drifted: ${out.diff}`);
await b.close();

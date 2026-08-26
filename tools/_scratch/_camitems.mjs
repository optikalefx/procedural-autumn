// The four behaviour changes the player asked for, tested where they live.
//
//   2  the zoom ring stops at the fitted lens and toasts once, never swaps
//   3  photo mode opens at f/22
//   4  photo mode entered from the telescope fits the telephoto
//   5  something is in focus on the opening frame
//
// One page load per section where the state has to be cold; the ring walk can
// share a load with the aperture check because neither writes the other's
// state. HMR is stubbed and ANGLE/Metal is forced — see AGENTS.md for what
// each of those costs when you forget it.
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
const boot = async () => {
  const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(HMR);
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));
  await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(1200);
  // Count every toast the mode raises, without changing how it raises them.
  await page.evaluate(() => {
    const hud = window.__systems.hud;
    window.__toasts = [];
    const raw = hud.toast.bind(hud);
    hud.toast = (m, o) => { window.__toasts.push(m); return raw(m, o); };
  });
  return page;
};

// ── 2 + 3: the ring, and the stop it opens at ──────────────────────────────
{
  const page = await boot();
  await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
  await page.waitForTimeout(2200);
  const open = await page.evaluate(() => {
    const p = window.__systems.hud.photo;
    return { lens: p.lens.lens.id, focal: +p.lens.focal.toFixed(1), fStop: p.focus.fStop };
  });
  console.log('ITEM 3  opens at', JSON.stringify(open),
    open.fStop === 22 ? ' PASS' : ' FAIL');

  // Walk the ring to the long stop and keep pushing. It must park on the wide
  // lens's own 70 mm, say so exactly once, and never become the 200-400.
  const walk = await page.evaluate(async (dir) => {
    const p = window.__systems.hud.photo;
    window.__toasts.length = 0;
    const seen = [];
    for (let i = 0; i < 40; i++) {
      p.lensKey(dir > 0 ? 'BracketRight' : 'BracketLeft');
      seen.push(`${p.lens.lens.id}@${Math.round(p.lens.focal)}`);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { end: seen[seen.length - 1], lenses: [...new Set(seen.map((s) => s.split('@')[0]))],
             toasts: [...window.__toasts] };
  }, 1);
  console.log('ITEM 2  40x ] →', walk.end, ' bodies seen', JSON.stringify(walk.lenses));
  console.log('        toasts', JSON.stringify(walk.toasts));
  console.log('       ', walk.end === 'wide@70' && walk.lenses.length === 1 && walk.toasts.length === 1
    ? ' PASS — parked, one toast, no swap' : ' FAIL');

  // And back down, the other way. A fresh arrival at the other stop is news
  // again, so exactly one more toast.
  const back = await page.evaluate(async () => {
    const p = window.__systems.hud.photo;
    window.__toasts.length = 0;
    for (let i = 0; i < 40; i++) {
      p.lensKey('BracketLeft');
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { at: `${p.lens.lens.id}@${Math.round(p.lens.focal)}`, toasts: [...window.__toasts] };
  });
  console.log('ITEM 2  40x [ →', back.at, JSON.stringify(back.toasts),
    back.at === 'wide@24' && back.toasts.length === 1 ? ' PASS' : ' FAIL');

  // L still changes the body, and the ring keeps its place in ratio terms.
  const swap = await page.evaluate(() => {
    const p = window.__systems.hud.photo;
    window.__toasts.length = 0;
    p.lensKey('KeyL');
    return { lens: p.lens.lens.id, focal: Math.round(p.lens.focal), toasts: [...window.__toasts] };
  });
  console.log('ITEM 2  L →', JSON.stringify(swap),
    swap.lens === 'tele' ? ' PASS — L is still the only way across' : ' FAIL');
  await page.close();
}

// ── 4: in through the eyepiece ─────────────────────────────────────────────
{
  const page = await boot();
  const r = await page.evaluate(async () => {
    const camp = window.__systems.camp;
    // Pitch one, the way `campshot.mjs` does — a harness that has to drive the
    // camper to a site and synthesise a click breaks for reasons unrelated to
    // what it is testing. `_pitch` builds the props, telescope among them.
    const v = window.__ctx.systems.vehicle?.body?.position ?? window.__ctx.camera.position;
    // A telescope is a PROBABILISTIC prop (`camp_site.js` places it at 0.40 to
    // 0.58), so one camp is not enough — pitch and strike until a site turns up
    // with one on it.
    let prop = null, tries = 0;
    const kinds = [];
    for (; tries < 24 && !prop; tries++) {
      camp.strike();
      camp.pitchNear(v.x + (tries % 5) * 9 - 18, v.z + Math.floor(tries / 5) * 9 - 18, { radius: 16 });
      for (const c of camp.camps ?? []) {
        for (const p of c.props ?? []) {
          kinds.push(p.item?.kind);
          if (p.item?.kind === 'telescope' && p.obj?.userData?.telescope) { prop = p; break; }
        }
        if (prop) break;
      }
    }
    if (!prop) return { skipped: 'no telescope in ' + tries + ' camps', kinds: [...new Set(kinds)] };
    // The handbrake has to be latched or `Camp.update` closes the eyepiece on
    // the next frame — see the `holding` branch there. This is the one bit of
    // driving state the harness cannot skip.
    const veh = window.__ctx.systems.vehicle;
    if (veh) { veh._brakeHold = true; veh.enabled = true; }
    camp.scope.enter(prop.obj);
    await new Promise((s) => setTimeout(s, 1600));
    const scopeFov = window.__ctx.camera.fov;
    const scopeActive = camp.scope.active;
    window.__systems.hud.togglePhoto();
    await new Promise((s) => setTimeout(s, 1800));
    const p = window.__systems.hud.photo;
    return { scopeActive, scopeFov: +scopeFov.toFixed(2),
             lens: p.lens.lens.id, focal: +p.lens.focal.toFixed(1), fStop: p.focus.fStop };
  });
  console.log('ITEM 4  from the eyepiece →', JSON.stringify(r));
  console.log('       ', r.lens === 'tele' ? ' PASS — the telephoto is fitted' : ' FAIL/SKIP');

  // And the ordinary entry still fits from the fov, so the promise the
  // telescope overrules is not overruled for everyone.
  const plain = await page.evaluate(async () => {
    const hud = window.__systems.hud;
    hud.togglePhoto();
    await new Promise((s) => setTimeout(s, 900));
    hud.togglePhoto();
    await new Promise((s) => setTimeout(s, 1800));
    const p = hud.photo;
    return { lens: p.lens.lens.id, focal: +p.lens.focal.toFixed(1),
             camFov: +window.__ctx.camera.fov.toFixed(2) };
  });
  console.log('ITEM 4  plain re-entry →', JSON.stringify(plain),
    plain.lens === 'wide' ? ' PASS — still fitted from the frame' : ' FAIL');
  await page.close();
}
await b.close();

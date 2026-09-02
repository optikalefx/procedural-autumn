// Does a paddling duck still count from twice as far as a settled one?
//
// A ladder of stand-offs, each shot twice — the same bird, the same camera,
// nothing moving but `fold`. Before the fix the two columns diverged past the
// settled cut and a swimming duck was credited to 13.6 m; they must now agree
// at every rung.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

console.log(await page.evaluate(async () => {
  const c = window.__ctx, W = window.__world, e = window.__engine, T = window.__THREE;
  const j = window.__hud?.journal;
  if (j?._visible) { j.close(); for (let i = 0; i < 300 && j._visible; i++) j.update(0.05); }
  window.__lighting.hour = 11.0; window.__lighting.cycleSpeed = 0;
  const tb = c.systems.wildlife.treeBirds;
  const DUCK = tb.slots.findIndex((s) => s[0]?.spec?.key === 'duck');
  for (let i = 0; i < 300 && !tb.slots[DUCK][0].obj; i++) await new Promise((r) => setTimeout(r, 100));
  const S = tb.slots[DUCK][0].spec;
  let A = null;
  for (let i = 1; i <= 12 && !A; i++) {
    let a = null; try { a = window.__anchorAt('river', i); } catch { /* none */ }
    if (!a) continue;
    for (let k = 0; k < 900; k++) {
      const x = a.x + (Math.random() - 0.5) * 200, z = a.z + (Math.random() - 0.5) * 200;
      if (!W.isInBounds(x, z)) continue;
      const h = W.getHydro(x, z, {});
      if (h.sdf < 1.2 || h.wet < 0.5 || h.span < S.minSpan) continue;
      if (W.getWaterDepth(x, z) < S.draft) continue;
      if (!A || h.span > A.span) A = { x, z, span: h.span };
    }
  }
  const wy = W.getWaterHeight(A.x, A.z) ?? 0;
  window.__forceCamera = true;
  e.camera.position.set(A.x + 40, wy + 8, A.z + 40);
  e.camera.lookAt(new T.Vector3(A.x, wy, A.z));
  for (const b of tb.slots[DUCK]) { b.active = false; b.cool = 0; if (b.obj) b.obj.visible = false; }
  for (let s = 0; s < 900 && !tb.slots[DUCK].some((x) => x.active); s++) tb.update(1 / 30, e.camera, null);
  for (let s = 0; s < 120; s++) { const b = tb.slots[DUCK].find((x) => x.active); if (b) b.timer = 999; tb.update(1 / 30, e.camera, null); }
  window.__one = { i: DUCK };
  const b = tb.slots[DUCK].find((x) => x.active);
  return `one settled duck, sc ${b.sc.toFixed(2)} m`;
}));

console.log(await page.evaluate(async () => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  const tb = c.systems.wildlife.treeBirds;
  const b = tb.slots[window.__one.i].find((x) => x.active);
  const G = b.spec.glb;
  const P = new T.Vector3(b.x, b.y + G.unitC * b.sc, b.z);
  e.camera.fov = 50; e.camera.updateProjectionMatrix();
  const out = ['  dist   settled      paddling'];
  for (const d of [5, 6.5, 7.5, 9, 11, 13, 15]) {
    const row = [];
    for (const fold of [1, 0]) {
      b.fold = fold;
      e.camera.position.set(b.x + d * Math.cos(0.7), b.y + 0.9, b.z + d * Math.sin(0.7));
      e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
      row.push(M.detectSubjects(c).includes('duck') ? 'DUCK   ' : 'nothing');
    }
    out.push(`  ${String(d).padStart(4)} m  ${row[0]}      ${row[1]}${row[0] === row[1] ? '' : '   <-- DISAGREE'}`);
  }
  b.fold = 1;
  return out.join('\n');
}));
await browser.close();

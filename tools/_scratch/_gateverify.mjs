// Did the planar rewrite move the sheet?
//
// 1. NEUTRALITY — for a centred subject at fov 50, the distance at which the
//    gate lets go, under the new code and under the old formula+constant.
//    These are the frames every threshold in the file was derived from.
// 2. THE PLAYER'S FRAME — drawn 13.34% of frame height at NDC (0.380, 0.199),
//    at four lenses. Must now count at all of them.
// 3. THE FOLD FIX — same frame, settled vs paddling. Must now agree.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const P_USER = 0.13337, NDC = [0.380, 0.199], DRY_SPANS = 0.5214;
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

// ── 1. neutrality, against the old formula ──────────────────────────────────
console.log(await page.evaluate(async () => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  window.__forceCamera = true;
  e.camera.fov = 50; e.camera.updateProjectionMatrix();
  const P = new T.Vector3(0, 60, 0);
  const cut = (r, test) => {
    let lo = 0.5, hi = 4000;
    for (let i = 0; i < 60; i++) {
      const d = (lo + hi) / 2;
      e.camera.position.set(P.x, P.y, P.z + d);
      e.camera.lookAt(P); e.camera.updateMatrixWorld(true);
      if (test(r, d)) lo = d; else hi = d;
    }
    return lo;
  };
  const vfov = 50 * Math.PI / 180;
  const rows = [];
  // radii the file's own header names: deer half-height, rabbit, the duck,
  // a median waterfall, a camp clearing, and the owl's perched half-height.
  for (const [name, r, oldMin, newMin] of [
    ['deer  (r 0.915)', 0.915, 0.149, I.MIN_SHARE],
    ['rabbit(r 0.21)',  0.21,  0.149, I.MIN_SHARE],
    ['duck  (r 0.442)', 0.442, 0.149, I.MIN_SHARE],   // the OLD shared cut, for neutrality
    ['owl   (r 0.707)', 0.707, 0.149, I.MIN_SHARE],
    ['fall  (r 20.0)',  20.0,  0.12,  I.FALL_SHARE],
    ['camp  (r 12.0)',  12.0,  0.12,  I.CAMP_SHARE],
  ]) {
    const dOld = cut(r, (rr, d) => (2 * Math.atan(rr / d)) / vfov >= oldMin);
    const dNew = cut(r, (rr) => I.share(I.frameOf(c), P, rr, newMin, Infinity) > 0);
    rows.push(`  ${name}  old cut ${dOld.toFixed(3)} m   new cut ${dNew.toFixed(3)} m   `
      + `${((dNew / dOld - 1) * 100).toFixed(3)}%`);
  }
  return 'NEUTRALITY (centred, fov 50 — the derivation frames)\n' + rows.join('\n');
}));

// ── place a duck for 2 and 3 ────────────────────────────────────────────────
await page.evaluate(async () => {
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
});

console.log(await page.evaluate(async ([P_USER, NDC, DRY_SPANS]) => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  const tb = c.systems.wildlife.treeBirds;
  const b = tb.slots[window.__one.i].find((x) => x.active);
  const G = b.spec.glb;
  const P = new T.Vector3(b.x, b.y + G.unitC * b.sc, b.z);
  const h = DRY_SPANS * b.sc, aspect = e.camera.aspect;
  const compose = (fovDeg, nx, ny) => {
    e.camera.fov = fovDeg; e.camera.updateProjectionMatrix();
    const tv = Math.tan(fovDeg * Math.PI / 360);
    const D = h / (2 * P_USER * tv);
    const vx = nx * D * tv * aspect, vy = ny * D * tv;
    const place = (pitch) => {
      const q = new T.Quaternion().setFromEuler(new T.Euler(pitch, 0.7, 0, 'YXZ'));
      return { q, C: P.clone().sub(new T.Vector3(vx, vy, -D).applyQuaternion(q)) };
    };
    let lo = -0.9, hi = 0.9;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (place(m).C.y > b.y + 0.9) lo = m; else hi = m; }
    const { q, C } = place((lo + hi) / 2);
    e.camera.position.copy(C); e.camera.quaternion.copy(q); e.camera.updateMatrixWorld(true);
    return D;
  };
  const out = ['', "THE PLAYER'S FRAME — duck drawn 13.34% of frame height, NDC (0.380, 0.199)"];
  for (const fov of [50, 40, 30, 24]) {
    const D = compose(fov, NDC[0], NDC[1]);
    const r = G.unitR * b.sc * I.FOLD_R;
    const s = I.share(I.frameOf(c), P, r, 0, Infinity);
    out.push(`  fov ${String(fov).padStart(2)} as composed (${D.toFixed(1)} m)  share ${s.toFixed(4)} vs ${I.DUCK_SHARE}  `
      + `${s >= I.DUCK_SHARE ? 'PASS' : 'FAIL'}  detect: ${M.detectSubjects(c).includes('duck') ? 'DUCK' : 'nothing'}`);
  }
  const Dc = compose(50, 0, 0);
  const rc = G.unitR * b.sc * I.FOLD_R;
  out.push(`  fov 50 centred     (${Dc.toFixed(1)} m)  share ${I.share(I.frameOf(c), P, rc, 0, Infinity).toFixed(4)}  `
    + '— composition no longer changes the answer');

  compose(40, NDC[0], NDC[1]);
  out.push('', 'THE FOLD FIX — same camera, same duck, settled vs paddling');
  for (const fold of [1, 0]) {
    b.fold = fold;
    out.push(`  fold ${fold} (${fold ? 'settled ' : 'paddling'})  detect: `
      + `${M.detectSubjects(c).includes('duck') ? 'DUCK' : 'nothing'}`);
  }
  b.fold = 1;
  return out.join('\n');
}, [P_USER, NDC, DRY_SPANS]));
await browser.close();

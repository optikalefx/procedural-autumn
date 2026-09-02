// Does the player's photograph count — yes or no?
//
// The one thing the reconstruction could not pin is where the duck was in its
// idle cycle: a bird with its neck up is drawn taller, so the same 13.34% of
// frame height means it was FURTHER away and the gate reads it smaller. So walk
// the cycle and take the worst case.
//
// The drawn height is measured off the POSED mesh rather than off pixels —
// `SkinnedMesh.getVertexPosition` applies the same skinning the renderer does,
// so this is the silhouette on screen without a screenshot, a colour threshold
// or a background to be fooled by. (Two pixel-based versions of this harness
// were thrown away: scanning down from the top of the frame finds sky and birch
// trunks, and walking up from the waterline never terminates when the bank
// behind the bird is pale.)
import { chromium } from 'playwright';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const P_USER = 0.13337, NDC = [0.380, 0.199], PHASES = 16;

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
  let skinned = 0;
  b.obj.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
  return `one settled duck, sc ${b.sc.toFixed(2)} m, idle ${b.clips.idle.duration.toFixed(2)} s, `
    + `${skinned} skinned mesh(es), getVertexPosition: ${typeof b.obj.children?.[0]?.getVertexPosition}`;
}));

console.log(await page.evaluate(async ([P_USER, NDC, PHASES]) => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  const tb = c.systems.wildlife.treeBirds;
  const b = tb.slots[window.__one.i].find((x) => x.active);
  const G = b.spec.glb;
  const r = G.unitR * b.sc * I.FOLD_R;
  const v = new T.Vector3();
  // the topmost point of the POSED, skinned bird, in world space
  const topY = () => {
    let hi = -Infinity;
    b.obj.updateMatrixWorld(true);
    b.obj.traverse((o) => {
      if (!o.isSkinnedMesh || typeof o.getVertexPosition !== 'function') return;
      const n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) {
        o.getVertexPosition(i, v);
        v.applyMatrix4(o.matrixWorld);
        if (v.y > hi) hi = v.y;
      }
    });
    return hi;
  };
  const MIN = I.DUCK_SHARE;
  const out = ['', `phase   dry (spans)   their stand-off   gate share   vs ${MIN}   VERDICT`];
  let worst = null;
  for (let k = 0; k < PHASES; k++) {
    const ph = k / PHASES;
    b.act.idle.time = ph * b.clips.idle.duration;
    b.act.idle.setEffectiveWeight(1); b.act.move.setEffectiveWeight(0);
    b.mixer.update(0);
    const h = topY() - b.y;                       // drawn head-top over the waterline
    // the stand-off at which THAT bird draws the player's 13.34% of frame height
    const tv = Math.tan(50 * Math.PI / 360);
    const D = h / (2 * P_USER * tv);
    const P = new T.Vector3(b.x, b.y + G.unitC * b.sc, b.z);
    e.camera.fov = 50; e.camera.updateProjectionMatrix();
    const vx = NDC[0] * D * tv * e.camera.aspect, vy = NDC[1] * D * tv;
    const place = (pitch) => {
      const q = new T.Quaternion().setFromEuler(new T.Euler(pitch, 0.7, 0, 'YXZ'));
      return { q, C: P.clone().sub(new T.Vector3(vx, vy, -D).applyQuaternion(q)) };
    };
    let lo = -0.9, hi2 = 0.9;
    for (let i = 0; i < 60; i++) { const m = (lo + hi2) / 2; if (place(m).C.y > b.y + 0.9) lo = m; else hi2 = m; }
    const { q, C } = place((lo + hi2) / 2);
    e.camera.position.copy(C); e.camera.quaternion.copy(q); e.camera.updateMatrixWorld(true);
    const s = I.share(I.frameOf(c), P, r, 0, Infinity);
    const duck = M.detectSubjects(c).includes('duck');
    if (!worst || s < worst.s) worst = { ph, s, duck };
    out.push(`${ph.toFixed(3)}    ${(h / b.sc).toFixed(4)}        ${D.toFixed(2)} m        `
      + `${s.toFixed(4)}      ${s >= MIN ? ' ok ' : 'SHORT'}      ${duck ? 'COUNTS' : 'refused'}`);
  }
  out.push('', `worst phase ${worst.ph.toFixed(3)}: share ${worst.s.toFixed(4)} vs ${MIN} — `
    + `${worst.duck ? 'still counts' : 'REFUSED'}   (margin ${((worst.s / MIN - 1) * 100).toFixed(1)}%)`);
  return out.join('\n');
}, [P_USER, NDC, PHASES]));
await browser.close();

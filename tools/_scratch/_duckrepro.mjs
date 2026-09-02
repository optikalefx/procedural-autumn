// Reproduce the player's frame and ask hunt_detect's gate about it.
//
// Two facts measured off the saved PNG (procedural-autumn-20260902-133237.png,
// 2806x1762) and nothing else:
//   * the nearest duck is drawn 235 px tall head-top to waterline = 0.1334 of
//     the frame height;
//   * its silhouette centre sits at NDC (+0.380, +0.199) — a third of the way
//     right of centre, a fifth up.
// The harness stands a real duck at exactly that apparent size, composes it at
// exactly that place in the frame, and prints what `share()` returns. Then it
// re-composes the same duck dead centre, unchanged in every other way.
import { chromium } from 'playwright';

const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const P_USER = 0.13337;          // drawn height / frame height
const NDC = [0.380, 0.199];
// The drawn dry height, in span units, measured off two renders of the paused
// idle pose (105 px at 6.77 m and 118 px at 6.09 m, fov 50, sc 1.59 m).
const DRY_SPANS = 0.5214;

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
  const L = window.__lighting; L.hour = 11.0; L.cycleSpeed = 0;
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
  const dt = 1 / 30;
  for (const b of tb.slots[DUCK]) { b.active = false; b.cool = 0; if (b.obj) b.obj.visible = false; }
  for (let s = 0; s < 900 && !tb.slots[DUCK].some((x) => x.active); s++) tb.update(dt, e.camera, null);
  for (let s = 0; s < 120; s++) { const b = tb.slots[DUCK].find((x) => x.active); if (b) b.timer = 999; tb.update(dt, e.camera, null); }
  const b = tb.slots[DUCK].find((x) => x.active);
  window.__one = { i: DUCK };
  return `settled duck sc ${b.sc.toFixed(2)} m fold ${b.fold.toFixed(2)}, water ${wy.toFixed(2)}`;
}));

const rows = await page.evaluate(async ([P_USER, NDC, DRY_SPANS]) => {
  const M = await import('/src/game/hunt_detect.js'); const I = M._internals;
  const c = window.__ctx, e = window.__engine, T = window.__THREE;
  const tb = c.systems.wildlife.treeBirds;
  const b = tb.slots[window.__one.i].find((x) => x.active);
  const G = b.spec.glb;
  const P = new T.Vector3(b.x, b.y + G.unitC * b.sc, b.z);
  const r = G.unitR * b.sc * I.FOLD_R;
  const h = DRY_SPANS * b.sc;                       // drawn head-top to waterline, m
  const out = [];
  const aspect = e.camera.aspect;

  // Put the duck at view-space (vx, vy, -D) for a chosen NDC and depth, with the
  // camera at a chosen height over the water: solve the pitch that gets it there.
  const compose = (fovDeg, nx, ny, eyeY) => {
    e.camera.fov = fovDeg; e.camera.updateProjectionMatrix();
    const tv = Math.tan(fovDeg * Math.PI / 360);
    const D = h / (2 * P_USER * tv);                // depth that draws it P_USER tall
    const vx = nx * D * tv * aspect, vy = ny * D * tv;
    const yaw = 0.7;
    const place = (pitch) => {
      const q = new T.Quaternion().setFromEuler(new T.Euler(pitch, yaw, 0, 'YXZ'));
      const off = new T.Vector3(vx, vy, -D).applyQuaternion(q);
      return { q, C: P.clone().sub(off) };
    };
    let lo = -0.9, hi = 0.9;                        // solve C.y == eyeY
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (place(mid).C.y > eyeY) lo = mid; else hi = mid;
    }
    const { q, C } = place((lo + hi) / 2);
    e.camera.position.copy(C); e.camera.quaternion.copy(q);
    e.camera.updateMatrixWorld(true);
    const chk = P.clone().project(e.camera);
    const s = I.share(I.frameOf(c), P, r, 0, Infinity);
    const view = P.clone().applyMatrix4(new T.Matrix4().copy(e.camera.matrixWorld).invert());
    return { fov: fovDeg, ndc: [+chk.x.toFixed(3), +chk.y.toFixed(3)],
      depth: +(-view.z).toFixed(2), slant: +view.length().toFixed(2),
      drawn: +(h / (2 * (-view.z) * tv)).toFixed(4),
      share: +s.toFixed(4), pass: s >= I.MIN_SHARE, duck: M.detectSubjects(c).includes('duck'),
      camY: +e.camera.position.y.toFixed(2), waterY: +b.y.toFixed(2) };
  };

  for (const fov of [50, 40, 30, 24]) {
    out.push({ how: 'as composed', ...compose(fov, NDC[0], NDC[1], b.y + 0.9) });
    out.push({ how: 'centred    ', ...compose(fov, 0, 0, b.y + 0.9) });
  }
  return { min: I.MIN_SHARE, rows: out, sc: b.sc, r, h };
}, [P_USER, NDC, DRY_SPANS]);

console.log(`\nduck sc ${rows.sc.toFixed(2)} m, drawn ${rows.h.toFixed(3)} m above water, `
  + `gate height ${(2 * rows.r).toFixed(3)} m (${(2 * rows.r / rows.h).toFixed(3)}x the drawn bird)`);
console.log(`every row below draws the duck ${(0.13337 * 100).toFixed(2)}% of frame height — the player's own frame\n`);
console.log('how           fov   ndc            depth  slant  drawn   share    vs 0.149   detect');
for (const r of rows.rows) {
  console.log(`${r.how}  ${String(r.fov).padStart(3)}   (${String(r.ndc[0]).padStart(5)},${String(r.ndc[1]).padStart(5)})  `
    + `${String(r.depth).padStart(5)}  ${String(r.slant).padStart(5)}  ${r.drawn.toFixed(4)}  ${r.share.toFixed(4)}  `
    + `${r.pass ? ' PASS   ' : ` short ${((1 - r.share / rows.min) * 100).toFixed(1)}%`}  ${r.duck ? 'YES' : 'no'}`);
}
await browser.close();

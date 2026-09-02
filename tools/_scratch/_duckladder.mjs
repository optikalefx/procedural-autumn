// Where does a duck stop being a photograph of a duck?
//
// The method the deer's 14 m came from: a ladder of stand-offs, rendered at the
// resolution a player's saved PNG actually is, opened and looked at.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5178';
const OUT = process.env.OUT ?? '/private/tmp/claude-502/-Users-sean-htdocs-procedural-fall/ee2de17d-721e-45a0-b861-815a63363298/scratchpad';
const DISTS = [6.8, 8.5, 10, 11.5, 13];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 875 }, deviceScaleFactor: 2 });
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
  window.__lighting.hour = 10.5; window.__lighting.cycleSpeed = 0;
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
  for (let s = 0; s < 900 && tb.slots[DUCK].filter((x) => x.active).length < 3; s++) tb.update(1 / 30, e.camera, null);
  for (let s = 0; s < 120; s++) { for (const b of tb.slots[DUCK]) if (b.active) b.timer = 999; tb.update(1 / 30, e.camera, null); }
  const live = tb.slots[DUCK].filter((x) => x.active);
  window.__one = { i: DUCK };
  return `${live.length} settled duck(s), sc ${live.map((b) => b.sc.toFixed(2)).join(', ')} m`;
}));

for (const d of DISTS) {
  await page.evaluate(async ([d]) => {
    const c = window.__ctx, e = window.__engine, T = window.__THREE;
    const tb = c.systems.wildlife.treeBirds;
    const b = tb.slots[window.__one.i].find((x) => x.active);
    const G = b.spec.glb;
    const P = new T.Vector3(b.x, b.y + G.unitC * b.sc, b.z);
    e.camera.fov = 50; e.camera.updateProjectionMatrix();
    // The player's own low-over-the-water eye, and their off-centre composition.
    // Eye height is measured against the water UNDER THE CAMERA, not under the
    // duck: a river surface slopes, and `b.y + 0.9` put the lens a metre under
    // the surface ten metres upstream — the first run of this ladder is five
    // frames of the underside of a river.
    const cx = b.x + d * Math.cos(0.7), cz = b.z + d * Math.sin(0.7);
    const wcam = window.__world.getWaterHeight(cx, cz);
    const eyeY = (Number.isFinite(wcam) ? Math.max(wcam, b.y) : b.y) + 0.9;
    e.camera.position.set(cx, eyeY, cz);
    e.camera.lookAt(new T.Vector3(b.x - 1.6, b.y - 0.15, b.z));
    window.__forceCamera = true;
    if (window.__settle) await window.__settle(24);
  }, [d]);
  await page.waitForTimeout(1000);
  writeFileSync(`${OUT}/ladder-${d}.png`, await page.screenshot());
  console.log(`  ${OUT}/ladder-${d}.png`);
}
await browser.close();

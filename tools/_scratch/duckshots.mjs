// Staged captures of the duck raft, for the import round.
//
//   AUTUMN_URL=http://127.0.0.1:5248 node tools/_scratch/duckshots.mjs /tmp/ducks
//
// Forms a raft through the species' own `_scan` path (never `debugPerchNear`,
// which spreads them over a 90 m box and would flatter the cohesion rule), then
// frames the group and one bird.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/ducks';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5248';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.error('page:', m.text()); });
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });

console.log(await page.evaluate(async () => {
  const j = window.__hud?.journal;
  if (j?._visible) { j.close(); for (let i = 0; i < 300 && j._visible; i++) j.update(0.05); }
  const L = window.__lighting; L.hour = 9.2; L.cycleSpeed = 0;
  const c = window.__ctx, W = window.__world, e = window.__engine, T = window.__THREE;
  const tb = c.systems.wildlife.treeBirds, DUCK = 3, dt = 1 / 30;
  // `__ready` does not wait for the GLB: `_loadGlb` is deliberately not awaited
  // (see its docstring), and `_scan` declines to place a species with no model
  // yet — which looks exactly like a raft that would not form.
  for (let i = 0; i < 200 && !tb.slots[DUCK][0].obj; i++) await new Promise((r) => setTimeout(r, 100));
  if (!tb.slots[DUCK][0].obj) return 'duck GLB never loaded';
  // Find the most open duck-grade water near a river anchor rather than
  // hard-coding a point: the hydro field moves with the seed and with `res`,
  // and a harness that names a lake is a harness that stops finding one.
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
  if (!A) return 'no duck water anywhere near a river anchor';
  const wy = W.getWaterHeight(A.x, A.z) ?? 0;
  window.__forceCamera = true;
  e.camera.position.set(A.x + 40, wy + 8, A.z + 40);
  e.camera.lookAt(new T.Vector3(A.x, wy, A.z));
  let act = [], mx = 1e9;
  for (let t = 0; t < 40; t++) {
    for (const b of tb.slots[DUCK]) { b.active = false; b.cool = 0; if (b.obj) b.obj.visible = false; }
    for (let s = 0; s < 900 && tb.slots[DUCK].filter((b) => b.active).length < 4; s++) tb.update(dt, e.camera, null);
    act = tb.slots[DUCK].filter((b) => b.active);
    mx = 0; for (const a of act) for (const b of act) mx = Math.max(mx, Math.hypot(a.x - b.x, a.z - b.z));
    if (act.length === 4 && mx < 16) break;
  }
  for (let s = 0; s < 60; s++) tb.update(dt, e.camera, null);
  const cx = act.reduce((s, b) => s + b.x, 0) / 4, cz = act.reduce((s, b) => s + b.z, 0) / 4;
  window.__duck = { cx, cz, y: act[0].y, spread: mx, one: { x: act[0].x, z: act[0].z } };
  return `raft of ${act.length}, spread ${mx.toFixed(0)} m at (${cx.toFixed(0)}, ${cz.toFixed(0)})`;
}));

async function frame(name, fn) {
  await page.evaluate(fn);
  await page.waitForTimeout(2200);
  writeFileSync(`${OUT}/${name}.png`, await page.screenshot());
  console.log(`${OUT}/${name}.png`);
}

await frame('raft', () => {
  const { cx, cz, y, spread } = window.__duck;
  const e = window.__engine, T = window.__THREE;
  const d = Math.max(15, spread * 1.5);
  e.camera.fov = 45; e.camera.updateProjectionMatrix();
  e.camera.position.set(cx + d * 0.72, y + 2.4, cz + d * 0.72);
  e.camera.lookAt(new T.Vector3(cx, y + 0.45, cz));
});

await frame('one', () => {
  const { one, y } = window.__duck;
  const e = window.__engine, T = window.__THREE;
  e.camera.fov = 40; e.camera.updateProjectionMatrix();
  e.camera.position.set(one.x + 3.4, y + 1.1, one.z + 3.4);
  e.camera.lookAt(new T.Vector3(one.x, y + 0.4, one.z));
});

await browser.close();

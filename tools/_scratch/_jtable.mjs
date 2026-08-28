#!/usr/bin/env node
/**
 * The closed journal, sitting on the camp table.
 *
 *   node tools/_scratch/_jtable.mjs --dir /tmp/jtable
 *   node tools/_scratch/_jtable.mjs --dir /tmp/jtable --hour 20.4   # by firelight
 *
 * `tools/campshot.mjs --only table` cannot answer this on its own: its prop
 * framings are quoted against the PROP's own facing, and a table's facing is
 * jittered toward the fire, so on most layouts the camera ends up behind a
 * chair. This poses the lens on the book itself — read out of the table's world
 * matrix, which is the same path `Camp._journalUnderPointer` uses — so the
 * frame is of the thing under judgement whatever the layout did.
 *
 * It also asks the three questions a capture cannot:
 *
 *  · does the PICK work — a real pointer at the book's own screen position,
 *    through `Camp._journalUnderPointer`, with the prompt read off the DOM;
 *  · does the roasting stick steal it — the overlap the ordering in
 *    `_interact` exists for, measured rather than assumed;
 *  · what it costs — draw calls and triangles with the book and without.
 *
 * Traps respected: HMR stubbed before any page script (a peer's save otherwise
 * kills the run), Chromium on ANGLE/Metal, the park brake latched with a REAL
 * keypress before pitching (campshot's note: it dips the headlights, and every
 * dusk frame taken without it was shot under a floodlight).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const DIR = arg('dir', '/tmp/jtable');
const BASE = arg('base', 'http://127.0.0.1:5199');
const SEED = arg('seed', '20261018');
const HOUR = arg('hour', null);
const W = +arg('w', 1600), H = +arg('h', 900);

mkdirSync(resolve(DIR), { recursive: true });
await acquire('jtable');

const errors = [];
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
         '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
      return {
        readyState: 3, url, close() {}, send() {},
        addEventListener() {}, removeEventListener() {},
        set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {},
      };
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
  Object.assign(window.WebSocket, RealWS);
});
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${BASE}/?seed=20261018&car=camper&res=768`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240_000, polling: 250 });
await page.waitForFunction(() => !!window.__camp && !!window.__systems?.vehicle, null, { timeout: 30_000 });

await page.evaluate(() => {
  const p = window.__poi.best('meadow') ?? { x: 0, z: 0 };
  window.__vehicleTeleport?.(p.x, p.z, p.yaw ?? 0.9);
});
await page.waitForTimeout(1600);
// A real keypress: `brakeHold` is driven by the physics and an assignment from
// an evaluate survives one frame. See campshot's note.
await page.keyboard.down('Space');
await page.waitForTimeout(1000);
await page.keyboard.up('Space');
await page.waitForTimeout(2400);

// Pitch camps until one of them has a table (one in five has none).
let site = null;
for (let tries = 0; tries < 8 && !site; tries++) {
  site = await page.evaluate(({ seed, n }) => {
    const v = window.__systems.vehicle;
    window.__camp.__seed = parseInt(seed, 10) + n * 7919;
    const s = window.__camp.pitchNear(v.position.x, v.position.z, { instant: true, radius: 14 });
    if (!s) return null;
    const kinds = window.__camp.props.map((p) => p.item.kind);
    if (!kinds.includes('table')) { window.__camp.strike(); return null; }
    return { x: s.x, y: s.y, z: s.z, kinds };
  }, { seed: SEED, n: tries });
  if (!site) await page.waitForTimeout(400);
}
if (!site) { console.error('no camp with a table after 8 tries'); await browser.close(); process.exit(2); }
console.log(`camp at ${site.x.toFixed(1)}, ${site.z.toFixed(1)} — ${site.kinds.join(', ')}`);

if (HOUR !== null) {
  await page.evaluate((h) => { window.__lighting.hour = parseFloat(h); window.__lighting.cycleSpeed = 0; }, HOUR);
  await page.waitForTimeout(1200);
}

const seat = await page.evaluate(() => {
  const t = window.__camp.props.find((p) => p.item.kind === 'table');
  const holder = t?.obj?.userData?.journalBook;
  if (!holder) {
    return { ok: false, rest: t?.obj?.userData?.journalRest ?? null,
             kids: t ? t.obj.children.map((c) => c.name || c.type) : null };
  }
  t.obj.updateMatrixWorld(true);
  const p = holder.getWorldPosition(new window.__THREE.Vector3());
  let meshes = 0, tris = 0;
  holder.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    meshes++;
    const g = o.geometry;
    const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  const parts = [];
  holder.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry;
    const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
    parts.push(`${o.name || o.material?.name || 'mesh'}:${Math.round((n / 3) * (o.isInstancedMesh ? o.count : 1))}${o.castShadow ? '+s' : ''}`);
  });
  return {
    ok: true, rest: t.obj.userData.journalRest, parts,
    world: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) },
    table: { x: t.item.x, y: t.item.y, z: t.item.z, yaw: +t.item.yaw.toFixed(3) },
    meshes, tris: Math.round(tris),
  };
});
console.log('seat:', JSON.stringify(seat));
if (!seat.ok) { console.error('the table has no journal'); await browser.close(); process.exit(2); }

// ── frames ──────────────────────────────────────────────────────────────────
// Posed on the BOOK, not on the table's origin, and from the side the player
// actually stands on: the table's +Z faces the fire, so the eye goes there.
// `elev` is measured from the GROUND under the table, not from the top — the
// top is at 0.425-0.470, so anything under that photographs the underside of
// the slats and the book from below. First run out of this harness did.
const shots = [
  ['j0_read', 0.75, 1.05, 0.55],     // leaning over the table to read it
  ['j1_stand', 1.90, 1.55, 0.95],    // standing beside the table
  ['j2_far', 5.00, 1.80, 1.30],      // is it still a book from across the camp
  ['j3_plan', 0.42, 0.90, 0.20],     // close plan: is it ON the slats or IN them
];
for (const [name, dist, elev, az] of shots) {
  await page.evaluate(async ({ seat, dist, elev, az }) => {
    const THREE = window.__THREE, e = window.__engine;
    const a = seat.table.yaw + az;
    const c = new THREE.Vector3(seat.world.x, seat.world.y, seat.world.z);
    e.camera.fov = 36;
    e.camera.updateProjectionMatrix();
    e.camera.position.set(c.x + Math.sin(a) * dist, seat.table.y + elev, c.z + Math.cos(a) * dist);
    e.camera.lookAt(c);
    window.__forceCamera = true;
    if (window.__settleStable) await window.__settleStable(600, 24);
  }, { seat, dist, elev, az });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(DIR, `${name}.png`) });
  console.log('shot:', resolve(DIR, `${name}.png`));
}

// ── the pick ────────────────────────────────────────────────────────────────
//
// **The camera cannot be pinned by hand for this test, and that mistake cost a
// run.** `Camp._interact` builds its pointer ray from `e.camera` DURING the
// system update; a harness that copies a pose onto the camera from the render
// callback is writing it after every reader has already run, so `_interact`
// rays from wherever the rig is looking and the pick silently misses — while
// the same call from an `evaluate()`, which lands after the render, hits. The
// symptom is an empty prompt beside a `_journalUnderPointer()` that returns
// true, which reads as a broken prompt and is a broken harness.
//
// So `__forceCamera` comes off, the camp is given the focus that rule 3 of the
// interaction requires, the RIG is allowed to frame it, and the book's screen
// position is read off the live camera afterwards.
await page.evaluate(() => {
  window.__forceCamera = false;
  // `_updateFocus` only re-decides this on a click, and holds it as long as
  // the camper is at the camp — so one assignment sticks.
  window.__camp._focusCamp = window.__camp.camps[window.__camp.camps.length - 1];
});
await page.waitForTimeout(2500);          // the boom walks over to the camp

const pick = await page.evaluate(({ seat, W, H }) => {
  const THREE = window.__THREE, e = window.__engine;
  const c = new THREE.Vector3(seat.world.x, seat.world.y, seat.world.z);
  const p = c.clone().project(e.camera);
  return {
    x: Math.round((p.x * 0.5 + 0.5) * W), y: Math.round((-p.y * 0.5 + 0.5) * H),
    onScreen: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1,
    // How big the book is on screen from where the rig actually put the eye —
    // the number that says whether this is a plausible thing to aim at.
    px: Math.round(0.157 / (2 * Math.tan((e.camera.fov * Math.PI / 180) / 2)
         * e.camera.position.distanceTo(c) / H) * (H / H) * 1),
    dist: +e.camera.position.distanceTo(c).toFixed(2),
  };
}, { seat, W, H });
console.log('the book projects to', JSON.stringify(pick));

await page.mouse.move(pick.x, pick.y);
await page.waitForTimeout(700);
const hover = await page.evaluate(() => {
  const camp = window.__camp;
  const b = camp._journalUnderPointer();
  // **Read through `camp.prompt.el`, never `querySelector('.pa-camp-prompt')`.**
  // There are TWO elements with that class in a booted page and the first one
  // is not the live prompt — this harness read it and got an empty string while
  // the click worked perfectly, which reads as a broken prompt and is a broken
  // query. `tools/campshot.mjs`'s "is any UI in the frame?" check has the same
  // selector and therefore the same blind spot.
  return {
    prompt: camp.prompt.el.textContent.trim(),
    opacity: getComputedStyle(camp.prompt.el).opacity,
    domCopies: document.querySelectorAll('.pa-camp-prompt').length,
    underPointer: !!b,
    // The overlap the ordering in `_interact` exists for. If this is ever true
    // at the same time, the ordering is what decides it.
    stickUnderPointer: !!camp._stickUnderPointer(),
    scopeUnderPointer: !!camp._scopeUnderPointer(),
    brakeHold: !!window.__systems.vehicle?.brakeHold,
  };
});
console.log('pointing at the book:', JSON.stringify(hover));
await page.screenshot({ path: resolve(DIR, 'j4_prompt.png') });

await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2600);
const opened = await page.evaluate(() => {
  const t = window.__camp.props.find((p) => p.item.kind === 'table');
  return {
    journalActive: !!window.__systems.hud?.journal?.active,
    hudClass: document.getElementById('pa-hud')?.className ?? '',
    propHidden: t?.obj?.userData?.journalBook?.visible === false,
  };
});
console.log('after the click:', JSON.stringify(opened));
await page.screenshot({ path: resolve(DIR, 'j5_opened.png') });

await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
console.log('after Escape:', JSON.stringify(await page.evaluate(() => {
  const t = window.__camp.props.find((p) => p.item.kind === 'table');
  return {
    journalActive: !!window.__systems.hud?.journal?.active,
    propVisible: t?.obj?.userData?.journalBook?.visible === true,
  };
})));
await page.screenshot({ path: resolve(DIR, 'j6_back.png') });

// ── what it costs ───────────────────────────────────────────────────────────
// Paired, in ONE page load, the way AGENTS.md insists: hide every book, settle,
// read; show them, settle, read. Draw calls and triangles only — a frame TIME
// on a shared GPU is not worth quoting.
const cost = await page.evaluate(async () => {
  const info = () => ({
    calls: window.__engine.renderer.info.render.calls,
    tris: window.__engine.renderer.info.render.triangles,
  });
  const books = [];
  for (const c of window.__camp.camps) {
    for (const p of c.props) {
      const h = p.obj?.userData?.journalBook;
      if (h) books.push(h);
    }
  }
  const settle = async () => {
    if (window.__settleStable) await window.__settleStable(500, 20);
    else for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
  };
  for (const b of books) b.visible = false;
  await settle();
  const without = info();
  for (const b of books) b.visible = true;
  await settle();
  const withIt = info();
  return { books: books.length, without, withIt,
           dCalls: withIt.calls - without.calls, dTris: withIt.tris - without.tris };
});
console.log('cost:', JSON.stringify(cost));

console.log(errors.length ? 'page-errors:\n  ' + errors.slice(0, 8).join('\n  ') : 'no page errors');
await browser.close();

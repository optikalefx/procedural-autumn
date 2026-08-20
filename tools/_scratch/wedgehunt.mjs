#!/usr/bin/env node
/**
 * Identify the giant flat grey wedge of CRITIC_FINDINGS D3 by bisection.
 *
 * The wedge is in shots/ui/map7/full.png, which tools/hudshot.mjs took at its
 * `drive` view — road anchor, 16 m stand-off, 4.2 m above ground, pitch -0.10,
 * fov 55, hour 16.7. That pose is deterministic, so this reproduces it, then
 * hides one top-level scene child at a time and measures how much of the frame
 * still carries the wedge's flat colour. Whichever child takes the wedge with
 * it is the culprit.
 *
 *   node tools/_scratch/wedgehunt.mjs
 *   node tools/_scratch/wedgehunt.mjs --dir shots/wedge-hunt --shots
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);
const DIR = arg('dir', 'shots/wedge-hunt');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const RES = arg('res', '768');

mkdirSync(DIR, { recursive: true });
await acquire('wedgehunt');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, q) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {},
               set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, q);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
await p.goto(`http://localhost:5178/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(600);

// Same warm-up drive hudshot.mjs does, so the world is in the same state.
await p.keyboard.down('KeyW');
await p.waitForTimeout(4500);
await p.keyboard.up('KeyW');
await p.waitForTimeout(400);

// hudshot.mjs VIEWS.drive, verbatim.
const V = { anchor: 'road', height: 4.2, dist: 12, pitch: -0.10, fov: 55, hour: 16.7, standOff: 16 };
const pose = await p.evaluate(async (v) => {
  const THREE = window.__THREE, e = window.__engine;
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const a = window.__cameraAnchors[v.anchor]();
  const yaw = (a.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = a.x - Math.sin(yaw) * back, gz = a.z - Math.cos(yaw) * back;
  const gy = window.__world.getHeight(gx, gz) + v.height;
  e.camera.fov = v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(gx, gy, gz);
  e.camera.lookAt(new THREE.Vector3(gx + Math.sin(yaw) * v.dist, gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist));
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  await window.__settle(60);
  return { x: +gx.toFixed(1), y: +gy.toFixed(1), z: +gz.toFixed(1), yaw: +yaw.toFixed(3),
           r: +Math.hypot(gx, gz).toFixed(1), ground: +window.__world.getHeight(gx, gz).toFixed(1) };
}, V);
await p.waitForTimeout(900);
console.log('pose', JSON.stringify(pose));

// ── the detector ────────────────────────────────────────────────────────────
// The wedge is a large region of one flat colour with essentially no local
// variance. Count pixels whose 3x3 neighbourhood is constant AND whose colour
// sits in the measured wedge band (srgb ~87,89,105). Reported as a fraction of
// the whole frame.
// The renderer runs without preserveDrawingBuffer, so drawImage(canvas) from
// outside the render callback comes back black. Playwright's screenshot is the
// only honest readback here; decode it back inside the page to measure it.
await p.evaluate(() => {
  window.__flatB64 = async (b64, target) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas');
    c.width = 400; c.height = 225;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 400, 225);
    const d = g.getImageData(0, 0, 400, 225).data;
    const at = (x, y) => { const i = (y * 400 + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    let n = 0, tot = 0;
    const acc = [0, 0, 0]; let an = 0;
    for (let y = 1; y < 224; y++) for (let x = 1; x < 399; x++) {
      tot++;
      const c0 = at(x, y);
      let flat = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const c1 = at(x + dx, y + dy);
        if (Math.abs(c1[0] - c0[0]) + Math.abs(c1[1] - c0[1]) + Math.abs(c1[2] - c0[2]) > 3) { flat = false; break; }
      }
      if (!flat) continue;
      if (target) {
        if (Math.abs(c0[0] - target[0]) + Math.abs(c0[1] - target[1]) + Math.abs(c0[2] - target[2]) > 24) continue;
      }
      n++; acc[0] += c0[0]; acc[1] += c0[1]; acc[2] += c0[2]; an++;
    }
    return { frac: +(n / tot).toFixed(4), mean: an ? acc.map((v) => Math.round(v / an)) : null };
  };
  window.__pixB64 = async (b64, fx, fy) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = 400; c.height = 225;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, 400, 225);
    const d = g.getImageData(Math.round(fx * 400), Math.round(fy * 225), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
});
const flat = async (target) => {
  const b64 = (await p.screenshot()).toString('base64');
  return p.evaluate(({ b64, target }) => window.__flatB64(b64, target), { b64, target });
};

const base = await flat(null);
console.log('baseline flat-region fraction (any colour):', JSON.stringify(base));
// Sample the wedge itself: upper-right, where CRITIC_FINDINGS puts it.
const wedgeCol = await (async () => {
  const b64 = (await p.screenshot()).toString('base64');
  return p.evaluate(({ b64 }) => window.__pixB64(b64, 0.70, 0.20), { b64 });
})();
console.log('pixel at 70%,20% of frame:', JSON.stringify(wedgeCol));
const before = await flat(wedgeCol);
console.log('wedge-coloured flat fraction:', JSON.stringify(before));
if (has('shots')) writeFileSync(`${DIR}/00-base.png`, await p.screenshot());

// ── the scene tree ──────────────────────────────────────────────────────────
const tree = await p.evaluate(() => window.__engine.scene.children.map((o, i) => ({
  i, name: o.name || '(unnamed)', type: o.type, visible: o.visible,
  kids: o.children.length,
})));
console.log('\nscene.children:');
for (const t of tree) console.log(` [${t.i}] ${t.name} <${t.type}> vis=${t.visible} kids=${t.kids}`);

// ── bisect: hide one top-level child at a time ──────────────────────────────
console.log('\nhiding each top-level child in turn:');
const results = [];
for (const t of tree) {
  if (!t.visible) continue;
  await p.evaluate(async (i) => { window.__engine.scene.children[i].visible = false; await window.__settle(4); }, t.i);
  const r = await flat(wedgeCol);
  await p.evaluate((i) => { window.__engine.scene.children[i].visible = true; }, t.i);
  const drop = before.frac - r.frac;
  results.push({ ...t, frac: r.frac, drop: +drop.toFixed(4) });
  console.log(` [${t.i}] ${t.name.padEnd(24)} wedgeFrac ${r.frac.toFixed(4)}  drop ${drop >= 0 ? '+' : ''}${drop.toFixed(4)}`);
}
results.sort((a, b) => b.drop - a.drop);
console.log('\nbiggest drop:', JSON.stringify(results[0]));

// ── second pass: descend into the winner ────────────────────────────────────
const win = results[0];
if (win && win.drop > 0.02) {
  const kids = await p.evaluate((i) => window.__engine.scene.children[i].children.map((o, j) => ({
    j, name: o.name || '(unnamed)', type: o.type, visible: o.visible, kids: o.children.length,
  })), win.i);
  console.log(`\ndescending into [${win.i}] ${win.name} (${kids.length} children):`);
  for (const k of kids) {
    if (!k.visible) continue;
    await p.evaluate(async ({ i, j }) => { window.__engine.scene.children[i].children[j].visible = false; await window.__settle(4); }, { i: win.i, j: k.j });
    const r = await flat(wedgeCol);
    const drop = before.frac - r.frac;
    console.log(`   [${win.i}.${k.j}] ${k.name.padEnd(30)} <${k.type}> wedgeFrac ${r.frac.toFixed(4)}  drop ${drop >= 0 ? '+' : ''}${drop.toFixed(4)}`);
    await p.evaluate(({ i, j }) => { window.__engine.scene.children[i].children[j].visible = true; }, { i: win.i, j: k.j });
    if (has('shots') && drop > 0.02) {
      writeFileSync(`${DIR}/hide-${win.i}-${k.j}.png`, await p.screenshot());
    }
  }
}

await b.close();

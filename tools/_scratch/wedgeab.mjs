#!/usr/bin/env node
/**
 * The road-clearance A/B, both arms inside ONE page load.
 *
 * `wedgeroad.mjs` walks all 40 road anchors, which is the right sweep, but a
 * before/after taken as two separate runs of it is worth nothing on this tree:
 * `poi.anchor()` is not stable across page loads (P3), and two captures of the
 * same scene 34 minutes apart differed in half their pixels. So this poses each
 * anchor once and then rebuilds the rock field twice at that pose — clearance
 * off, clearance on — with the anchor list, the bake, the lighting and the
 * shader programs all identical between the two arms because they are the same
 * page. The arm order alternates by anchor so any residual drift cancels.
 *
 * At each arm it raycasts the same 12x6 grid `wedgeid.mjs` uses and asks the
 * only question that matters: does ONE rock instance own a large block of the
 * frame from close range?
 *
 *   node tools/_scratch/wedgeab.mjs                 # all 40, no screenshots
 *   node tools/_scratch/wedgeab.mjs --shots 12,18   # also photograph these
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/wedge-ab');
const KIND = arg('kind', 'road');
const N = parseInt(arg('n', '40'), 10);
const SHOTS = new Set(String(arg('shots', '')).split(',').filter(Boolean).map(Number));

// A rock instance owning this many of the 72 rays, from inside this range, is
// the D3 read: one flat facet with no scale in it. 24/72 is a third of the
// frame; the filed case took 34 with its nearest point 1.7 m out.
const FULL_RAYS = 24, MILD_RAYS = 12, NEAR_M = 20;

mkdirSync(DIR, { recursive: true });
await acquire('wedgeab');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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
await p.goto('http://localhost:5178/?res=768', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(800);

await p.evaluate(() => {
  const T = window.__THREE;
  const rc = new T.Raycaster(); rc.far = 20000;

  // Rebuild the whole rock field in place, at the current camera, with the
  // placement rule set either way. Everything else in the scene is untouched.
  window.__rockArm = async (clearance) => {
    const rocks = window.__systems.rocks;
    rocks.scatter.roadClearance = clearance;
    rocks.cells.clear();
    rocks.queue.length = 0;
    rocks._lastCell.x = 1e9; rocks._lastCell.z = 1e9;
    rocks._lastPack.set(1e9, 1e9, 1e9);
    rocks._catchup = 60;
    rocks._dirty = true;
    await window.__settle(70);
    return { instances: rocks.stats.instances, cells: rocks.stats.cells, queue: rocks.queue.length };
  };

  // The 12x6 grid from wedgeid.mjs, but scored rather than listed: which single
  // rock instance owns the most of the frame, and how close is it.
  window.__wedgeScore = () => {
    const cam = window.__engine.camera, scene = window.__engine.scene;
    const SKIP = /^(Sky|Clouds|Grass|GroundCover|Weather)/;
    const targets = scene.children.filter((o) => o.visible && !SKIP.test(o.name || ''));
    const tally = {};
    let rockRays = 0;
    for (let j = 0; j < 6; j++) for (let i = 0; i < 12; i++) {
      const x = ((i + 0.5) / 12) * 2 - 1, y = 1 - ((j + 0.5) / 6) * 2;
      rc.setFromCamera(new T.Vector2(x, y), cam);
      const h = rc.intersectObjects(targets, true)[0];
      if (!h) continue;
      let o = h.object, path = [];
      while (o && o !== scene) { path.unshift(o.name || o.type); o = o.parent; }
      const root = path[0];
      if (root !== 'Rocks') continue;
      rockRays++;
      const key = path.join('/') + (h.instanceId !== undefined ? `#${h.instanceId}` : '');
      (tally[key] ||= { n: 0, near: Infinity });
      tally[key].n++;
      tally[key].near = Math.min(tally[key].near, +h.distance.toFixed(1));
    }
    const rows = Object.entries(tally).sort((a, b) => b[1].n - a[1].n);
    const top = rows[0] ? { id: rows[0][0], rays: rows[0][1].n, near: rows[0][1].near } : { id: null, rays: 0, near: null };
    let near = Infinity;
    for (const [, v] of rows) near = Math.min(near, v.near);
    return { rockRays, top, near: isFinite(near) ? near : null };
  };
});

const count = await p.evaluate((k) => (window.__poi.list[k] || []).length, KIND);
console.log(`${KIND} anchors in this page load: ${count}`);
console.log(`idx  OFF rays/near                ON rays/near                 verdict`);

const tot = { off: { full: 0, mild: 0, near: 0 }, on: { full: 0, mild: 0, near: 0 } };
const changed = [];

for (let i = 0; i < Math.min(N, count); i++) {
  await p.evaluate(async ({ kind, i }) => {
    const THREE = window.__THREE, e = window.__engine;
    window.__lighting.hour = 16.7; window.__lighting.cycleSpeed = 0;
    const a = window.__anchorAt(kind, i);
    const yaw = a.yaw ?? 0;
    const gx = a.x - Math.sin(yaw) * 16, gz = a.z - Math.cos(yaw) * 16;
    const gy = window.__world.getHeight(gx, gz) + 4.2;
    e.camera.fov = 55; e.camera.updateProjectionMatrix();
    e.camera.position.set(gx, gy, gz);
    e.camera.lookAt(new THREE.Vector3(gx + Math.sin(yaw) * 12, gy + Math.tan(-0.10) * 12, gz + Math.cos(yaw) * 12));
    window.__forceCamera = true;
    window.dispatchEvent(new Event('resize'));
    await window.__settle(45);
  }, { kind: KIND, i });

  // Alternate which arm runs first, so a slow warm-up or a drifting frame does
  // not always land on the same side of the comparison.
  const order = i % 2 === 0 ? [false, true] : [true, false];
  const res = {};
  for (const clearance of order) {
    await p.evaluate((c) => window.__rockArm(c), clearance);
    await p.waitForTimeout(250);
    res[clearance ? 'on' : 'off'] = await p.evaluate(() => window.__wedgeScore());
    if (SHOTS.has(i)) {
      writeFileSync(`${DIR}/${String(i).padStart(2, '0')}-${clearance ? 'on' : 'off'}.png`, await p.screenshot());
    }
  }

  // Three gradings, because the filing and the fix are about two related but
  // different things. FULL/mild is the D3 read itself — one facet owning the
  // frame from close range. NEAR is the condition that produces it, and the one
  // the chase camera actually has to survive: any rock surface inside 20 m of
  // the lens at the anchor's resting pose.
  const grade = (r) => (r.top.rays >= FULL_RAYS && r.top.near !== null && r.top.near < NEAR_M) ? 'FULL'
    : (r.top.rays >= MILD_RAYS && r.top.near !== null && r.top.near < NEAR_M) ? 'mild'
      : (r.near !== null && r.near < NEAR_M) ? 'near' : '.';
  const go = grade(res.off), gn = grade(res.on);
  for (const [k, g] of [['off', go], ['on', gn]]) {
    if (g === 'FULL') tot[k].full++; else if (g === 'mild') tot[k].mild++;
    if (g !== '.') tot[k].near++;
  }
  if (go !== gn) changed.push({ i, off: go, on: gn });
  const fmt = (r) => `rock ${String(r.rockRays).padStart(2)}/72  top ${String(r.top.rays).padStart(2)} @ ${String(r.top.near ?? '-').padStart(6)} m  nearest ${String(r.near ?? '-').padStart(6)} m ${String(r.top.id ?? '').slice(6, 24).padEnd(18)}`;
  console.log(`${String(i).padStart(3)}  ${fmt(res.off)} ${go.padEnd(4)} | ${fmt(res.on)} ${gn.padEnd(4)}`);
}

console.log(`\nclearance OFF : FULL ${tot.off.full}/40   mild ${tot.off.mild}/40   any rock inside ${NEAR_M} m ${tot.off.near}/40`);
console.log(`clearance ON  : FULL ${tot.on.full}/40   mild ${tot.on.mild}/40   any rock inside ${NEAR_M} m ${tot.on.near}/40`);
console.log(`anchors whose verdict changed: ${JSON.stringify(changed)}`);
await b.close();

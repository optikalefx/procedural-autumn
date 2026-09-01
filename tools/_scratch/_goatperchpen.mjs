#!/usr/bin/env node
/**
 * Does a goat actually get on the rock? — the pen version.
 *
 * `tools/_scratch/goatperch.mjs` asks this of the valley and is the real test;
 * this one asks it of the Habitat Pen, which needs no world bake and so can be
 * run while the game is unbootable for unrelated reasons. It steps the pen
 * until an animal reaches PERCH, then frames that animal and renders.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatperchpen.mjs shots/goatlook goat
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const OUT = process.argv[2] || 'shots/goatlook';
const KEY = process.argv[3] || 'goat';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });

const res = await page.evaluate(async ({ KEY }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.__gallery;
  const built = await g.byId.get('animal:pen')
    .build(20261018, { species: KEY, herds: 3, behaviour: 'climb' });

  const W = 380, H = 300, N = 4;
  const canvas = document.createElement('canvas');
  canvas.width = W * N; canvas.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x8fb6d8, 1);
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff0dd, 2.2); key.position.set(4, 6, 3);
  scene.add(key, new THREE.HemisphereLight(0xbdd7f2, 0x8a7a5c, 1.4));
  scene.add(built.root);
  const cam = new THREE.PerspectiveCamera(38, W / H, 0.1, 200);

  const seq = [];
  let shot = 0;
  const names = ['idle', 'graze', 'wander', 'alert', 'flee', 'patrol', 'watch', 'climb', 'perch'];
  for (let i = 0; i < 400 * 60 && shot < N; i++) {
    built.update(1 / 60);
    if (i % 30) continue;
    // A climbing or perched animal, framed from a low three-quarter so the
    // rock and the animal on it are both in the picture.
    const a = (built._animals ?? []).find((x) => x.brain.state === (shot < 2 ? 7 : 8));
    if (!a) continue;
    const p = a.rig.mesh.position;
    const r = a.brain.rock;
    cam.position.set(p.x + 5.0, (r ? r.top : p.y) + 2.2, p.z + 5.0);
    cam.lookAt(p.x, p.y + 0.5, p.z);
    renderer.setViewport(shot * W, 0, W, H);
    renderer.setScissor(shot * W, 0, W, H);
    renderer.render(scene, cam);
    seq.push({
      t: +(i / 60).toFixed(1), state: names[a.brain.state],
      gait: a.rig.gaitName,
      y: +p.y.toFixed(2), rockTop: r ? +r.top.toFixed(2) : null,
      d: r ? +Math.hypot(r.x - p.x, r.z - p.z).toFixed(2) : null,
      rockR: r ? +r.r.toFixed(2) : null,
    });
    shot++;
    // Space the four frames out so they are not four copies of one instant.
    for (let k = 0; k < 60 * 4; k++) built.update(1 / 60);
  }
  const png = canvas.toDataURL('image/png');
  built.dispose?.();
  return { png, seq };
}, { KEY });

writeFileSync(`${OUT}/pen_perch.png`, Buffer.from(res.png.split(',')[1], 'base64'));
console.log('wrote', `${OUT}/pen_perch.png`);
console.log(JSON.stringify(res.seq, null, 2));
console.log('--- console ---');
for (const l of logs) console.log(l);
await browser.close();

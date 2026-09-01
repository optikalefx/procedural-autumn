#!/usr/bin/env node
/**
 * Judge the goat's gaits BROADSIDE, with a line drawn at the ground.
 *
 * The one image every defect in `import-animal` was visible in and invisible in
 * a 3/4 view: one stride at even phase spacing, side-on, orthographic, with
 * y = 0 marked. Runs inside the gallery page (which imports the app's three and
 * needs no world bake), and renders by hand because requestAnimationFrame does
 * not tick in a headless tab.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatstrip.mjs shots/goatlook goat
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
const page = await browser.newPage({ viewport: { width: 1400, height: 400 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });

const shots = await page.evaluate(async ({ KEY }) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const mod = await import('/src/wildlife/animal_species.js');
  const { GlbRig } = await import('/src/wildlife/glb_rig.js');
  const sp = mod.SPECIES[KEY];
  const protos = await mod.loadSpecies(KEY);
  const FLAT = { getHeight: () => 0, getSlope: () => 0, getWaterDepth: () => 0 };

  const W = 330, H = 270, N = 6;
  const canvas = document.createElement('canvas');
  canvas.width = W * N; canvas.height = H;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x8fb6d8, 1);
  renderer.setScissorTest(true);

  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xfff0dd, 2.4); key.position.set(3, 5, 4);
  scene.add(key, new THREE.HemisphereLight(0xbdd7f2, 0x8a7a5c, 1.5));
  // The ground line: a thin dark slab at y = 0, wide enough to run the strip.
  const line = new THREE.Mesh(new THREE.BoxGeometry(60, 0.006, 60),
    new THREE.MeshBasicMaterial({ color: 0x1a1414 }));
  line.position.y = 0;
  scene.add(line);

  // Symmetric, and sized to ONE panel's aspect — the frustum is in world units
  // and the viewport is a slice of the canvas, so a frustum shaped like the
  // whole canvas draws a stretched animal in every cell.
  const halfH = 1.02, halfW = halfH * (W / H), eyeY = 0.70;
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 40);
  cam.position.set(6, eyeY, 0);
  cam.lookAt(0, eyeY, 0);

  const out = {};
  const stripFor = async (label, protoIdx, poseKey, opts = {}) => {
    const proto = protos[protoIdx];
    const rig = new GlbRig(proto, proto.scale, sp.gait, KEY);
    scene.add(rig.mesh);
    const speed = opts.speed ?? (sp.gait[poseKey] ?? 0);
    const drive = {
      pos: new THREE.Vector3(), heading: 0, speed,
      graze: poseKey === 'graze' ? 1 : 0, alert: poseKey === 'alert' ? 1 : 0,
      flag: 0, look: null, lod: 0,
    };
    // Settle the damped blends, then walk one authored cycle in N even steps.
    for (let i = 0; i < 400; i++) rig.update(1 / 60, drive, FLAT);
    const clip = proto.clips[poseKey === 'stand' ? 'stand' : poseKey];
    const rate = sp.glb.clips[poseKey]?.rate
      ? rig.act[poseKey].timeScale : 1;
    const cycle = clip.duration / Math.max(rate, 1e-3);
    for (let f = 0; f < N; f++) {
      renderer.setViewport(f * W, 0, W, H);
      renderer.setScissor(f * W, 0, W, H);
      renderer.render(scene, cam);
      // advance a fraction of one cycle
      const stepT = cycle / N;
      let left = stepT;
      while (left > 1e-4) { const d = Math.min(1 / 120, left); rig.update(d, drive, FLAT); left -= d; }
    }
    scene.remove(rig.mesh);
    rig.dispose();
    // The ground line, composited rather than modelled: a plane at y = 0 seen
    // from a level camera is under a pixel tall and antialiases away, and the
    // whole point of this image is being able to see whether a hoof meets it.
    const c2 = document.createElement('canvas');
    c2.width = canvas.width; c2.height = canvas.height;
    const g2 = c2.getContext('2d');
    g2.drawImage(canvas, 0, 0);
    const row = (halfH - (0 - eyeY)) / (2 * halfH) * H;
    g2.strokeStyle = 'rgba(190,40,40,0.85)'; g2.lineWidth = 1;
    g2.beginPath(); g2.moveTo(0, row + 0.5); g2.lineTo(c2.width, row + 0.5); g2.stroke();
    out[label] = c2.toDataURL('image/png');
  };

  await stripFor('stand', 0, 'stand');
  await stripFor('walk', 0, 'walk');
  await stripFor('trot', 0, 'trot');
  await stripFor('run', 0, 'run');
  await stripFor('graze', 0, 'graze');
  await stripFor('alert', 0, 'alert');
  await stripFor('coat_smoke', 3, 'stand');
  await stripFor('kid', 2, 'stand');
  return out;
}, { KEY });

for (const [k, v] of Object.entries(shots)) {
  writeFileSync(`${OUT}/${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
  console.log('wrote', `${OUT}/${k}.png`);
}
console.log('--- console ---');
for (const l of logs) console.log(l);
await browser.close();

#!/usr/bin/env node
/**
 * The goat, through the gallery: the load line, the derived ladder, the clip
 * weights at each gait, and a Habitat Pen soak with the real Brain driving the
 * real GlbRig — including the CLIMB/PERCH states, which are the whole species.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatcheck.mjs [species]
 */
import { chromium } from 'playwright';
const KEY = process.argv[2] || 'goat';
const MODES = (process.argv[3] || 'roam,spook').split(',');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/gallery.html';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
await page.exposeBinding && 0;
await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => !!window.__gallery, { timeout: 180000 });

const out = await page.evaluate(async ({ KEY, MODES }) => {
  const mod = await import('/src/wildlife/animal_species.js');
  const { GlbRig } = await import('/src/wildlife/glb_rig.js');
  const THREE = await import('/node_modules/three/build/three.module.js');
  const sp = mod.SPECIES[KEY];
  const protos = await mod.loadSpecies(KEY);
  const r = { gait: { ...sp.gait }, variants: [], weights: {}, pen: {} };
  for (const p of protos) {
    r.variants.push({
      name: p.variant.name, scale: +p.scale.toFixed(4), size: p.size,
      hide: p.hide, boxH: +(p.geoms[0].boundingBox.max.y - p.geoms[0].boundingBox.min.y).toFixed(4),
    });
  }
  r.stride = protos[0].stride;

  // clip weights at each gait's own cruising speed
  const FLAT = { getHeight: () => 0, getSlope: () => 0, getWaterDepth: () => 0 };
  for (const g of ['stand', 'walk', 'trot', 'run', 'graze', 'alert']) {
    const rig = new GlbRig(protos[0], protos[0].scale, sp.gait, KEY);
    const speed = sp.gait[g] ?? 0;
    const drive = {
      pos: new THREE.Vector3(), heading: 0, speed,
      graze: g === 'graze' ? 1 : 0, alert: g === 'alert' ? 1 : 0,
      flag: 0, look: null, lod: 0,
    };
    for (let i = 0; i < 240; i++) rig.update(1 / 60, drive, FLAT);
    const w = {};
    let sum = 0;
    for (const slot of Object.keys(rig.act)) {
      const x = +rig.act[slot].getEffectiveWeight().toFixed(3);
      if (x > 0.001) w[slot] = x;
      sum += x;
    }
    r.weights[g] = { w, sum: +sum.toFixed(4), rates: {
      walk: +rig.act.walk.timeScale.toFixed(3),
      trot: +rig.act.trot.timeScale.toFixed(3),
      run: +rig.act.run.timeScale.toFixed(3),
    }, gaitName: rig.gaitName };
    rig.dispose();
  }

  // ── the pen: real Brain, real rig, rocks to climb ────────────────────────
  for (const behaviour of MODES) {
    const built = await window.__gallery.byId.get('animal:pen')
      .build(20261018, { species: KEY, herds: 3, behaviour });
    const seen = {}; const states = {}; let pinned = 0; let maxStill = 0;
    const still = new Map();
    // "wants to move and isn't": the honest stuck measure. `_pinned` only ever
    // resets on a SUCCESSFUL step, so it accumulates across long stationary
    // states and its maximum is not a duration.
    let wantMove = 0, stuck = 0, maxRun = 0;
    const run = new Map();
    for (let i = 0; i < 240 * 60; i++) {
      built.update(1 / 60);
      if (i % 6 === 0) {
        for (const a of built._animals ?? []) {
          seen[a.rig.gaitName] = (seen[a.rig.gaitName] || 0) + 1;
          const st = a.brain?.state;
          states[st] = (states[st] || 0) + 1;
          pinned = Math.max(pinned, a.brain?._pinned ?? 0);
          const mv = st === 2 || st === 7 || st === 4;
          if (mv) {
            wantMove++;
            const r0 = run.get(a) || 0;
            if (a.brain.speed < 0.02) { stuck++; const r1 = r0 + 0.1; run.set(a, r1); maxRun = Math.max(maxRun, r1); }
            else run.set(a, 0);
          } else run.set(a, 0);
          const p = a.rig.mesh.position;
          const prev = still.get(a) || { x: p.x, z: p.z, t: 0 };
          const moved = Math.hypot(p.x - prev.x, p.z - prev.z) > 0.05;
          const t = moved ? 0 : prev.t + 0.1;
          still.set(a, { x: p.x, z: p.z, t });
          maxStill = Math.max(maxStill, t);
        }
      }
    }
    const gs = new Set();
    for (const a of built._animals ?? []) gs.add(a.g);
    r.pen[behaviour] = {
      rocksPerGroup: [...gs].map((g) => (g.rocks ?? []).map((x) => ({ r: +x.r.toFixed(2), rise: +x.rise.toFixed(2) }))),
      animals: (built._animals ?? []).length,
      gaits: seen, states, maxPinned: +pinned.toFixed(2), maxStill: +maxStill.toFixed(1),
      wantMoveSamples: wantMove, stuckSamples: stuck,
      stuckPct: +(100 * stuck / Math.max(wantMove, 1)).toFixed(1),
      longestStuckRun: +maxRun.toFixed(1),
    };
    built.dispose?.();
  }
  return r;
}, { KEY, MODES });
console.log(JSON.stringify(out, null, 2));
console.log('--- console ---');
for (const l of logs) console.log(l);
await browser.close();

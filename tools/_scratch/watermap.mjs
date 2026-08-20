#!/usr/bin/env node
// Print the water-mask field against the drawn lake surface, texel by texel.
// '#' drawn + data agree, '?' drawn but getWaterHeight() null, '!' drawn but
// data disagrees by >0.5 m, '.' not drawn.
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const CX = parseFloat(arg('x', '-80')), CZ = parseFloat(arg('z', '-608'));
const STEP = parseFloat(arg('step', '2')), NN = parseInt(arg('n', '48'), 10);
await acquire('watermap');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(500);
const out = await p.evaluate(({ CX, CZ, STEP, NN }) => {
  const T = window.__THREE, W = window.__world;
  const water = window.__engine.scene.getObjectByName('Water');
  const rc = new T.Raycaster(); rc.far = 4000;
  const down = new T.Vector3(0, -1, 0);
  const lines = [];
  let heights = new Set();
  for (let j = 0; j < NN; j++) {
    let s = '';
    for (let i = 0; i < NN; i++) {
      const x = CX + (i - NN / 2) * STEP, z = CZ + (j - NN / 2) * STEP;
      rc.set(new T.Vector3(x, 900, z), down);
      const h = rc.intersectObject(water, true)[0];
      const wh = W.getWaterHeight(x, z);
      if (!h) { s += wh === null ? '.' : 'o'; continue; }
      if (wh === null) { s += '?'; continue; }
      heights.add(+wh.toFixed(2));
      s += Math.abs(wh - h.point.y) > 0.5 ? '!' : '#';
    }
    lines.push(s);
  }
  return { lines, heights: [...heights].slice(0, 10), res: W.res, half: W.half,
           texel: (W.half * 2) / W.res };
}, { CX, CZ, STEP, NN });
console.log(`grid ${out.res}, half ${out.half}, texel ${out.texel} m; step ${STEP} m at (${CX},${CZ})`);
console.log('data water heights seen:', JSON.stringify(out.heights));
for (const l of out.lines) console.log(l);
await b.close();

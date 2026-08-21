#!/usr/bin/env node
/**
 * OCCLUDE — the live frame. Drives through wood and shoots only the frames
 * where a trunk is actually inside the near volume, which is the case the whole
 * feature exists for and the one a posed capture cannot prove: the camera is on
 * the boom, the tree is passing, and the question is whether the picture reads.
 *
 *   node tools/_scratch/occdrive.mjs --dir shots/occdrive --want 6
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const DIR = arg('dir', 'shots/occdrive');
const WANT = parseInt(arg('want', '6'), 10);

mkdirSync(DIR, { recursive: true });
await acquire('occdrive');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
await p.goto('http://localhost:5178/?res=1536', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
await p.waitForTimeout(700);

await p.evaluate(() => {
  window.__lighting.hour = 14.0; window.__lighting.cycleSpeed = 0;
  const inp = window.__ctx.input; window.__drive = true; const t0 = performance.now();
  const tick = () => { if (!window.__drive) return; const t = (performance.now() - t0) / 1000;
    inp.axes.throttle = 1; inp.axes.steer = Math.sin(t * 0.37) * 0.45 + Math.sin(t * 0.11) * 0.3;
    requestAnimationFrame(tick); };
  tick();
  // Nearest trunk to the LENS, in the volume's own geometry, sampled every frame
  // so the harness can shoot the moment one is inside it.
  window.__nearTrunk = () => {
    const c = window.__engine.camera.position;
    const sp = window.__occlusion.params;
    let best = 1e9;
    window.__engine.scene.traverse((o) => {
      if (!o.isInstancedMesh || !o.geometry.getAttribute('aBark')) return;
      const m = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const x = m[i * 16 + 12], y = m[i * 16 + 13], z = m[i * 16 + 14];
        const dy = Math.max(y - sp.spanBelow - c.y, c.y - (y + sp.spanAbove), 0);
        const d = Math.hypot(x - c.x, z - c.z, dy);
        if (d < best) best = d;
      }
    });
    return best;
  };
});

let shot = 0;
for (let i = 0; i < 900 && shot < WANT; i++) {
  const d = await p.evaluate(() => window.__nearTrunk());
  if (d < 4.0) {
    await p.evaluate(() => { window.__engine.stop(); });
    writeFileSync(`${DIR}/near${shot}-on.png`, await p.screenshot());
    // The same frozen frame with the volume switched off, for the pair.
    await p.evaluate(() => {
      window.__occlusion.params.enabled = false;
      window.__occlusion.uniforms.uOccAmount.value = 0;
      const e = window.__engine;
      window.__systems.trees.lateUpdate(0, e.elapsed); window.__systems.rocks.lateUpdate(0, e.elapsed);
      e._render ? e._render(0, e.elapsed) : e.renderer.render(e.scene, e.camera);
    });
    writeFileSync(`${DIR}/near${shot}-off.png`, await p.screenshot());
    console.log(`  near${shot}: trunk ${d.toFixed(2)} m from the lens`);
    shot++;
    await p.evaluate(() => { window.__occlusion.params.enabled = true; window.__engine.start(); });
    await p.waitForTimeout(1500);
  }
  await p.waitForTimeout(120);
}
console.log(shot ? `wrote ${shot} pairs` : 'never got within 4 m of a trunk');
await b.close();

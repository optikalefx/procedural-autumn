#!/usr/bin/env node
// Verify the sky ordering optimization against the old order in one frozen
// frame. No animation, camera change, or page reload between the two images.
// node tools/sky-depth-check.mjs --port 5187 --out shots/sky-depth
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquire } from './_lock.mjs';

const args = process.argv.slice(2);
const arg = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? fallback : args[i + 1];
};
const out = resolve(arg('out', 'shots/sky-depth'));
mkdirSync(out, { recursive: true });
const anchors = JSON.parse(readFileSync(new URL('../review/anchors.json', import.meta.url), 'utf8'));
await acquire('sky-depth-check', { exclusive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const errors = [];
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem('pa.hud', JSON.stringify({ introSeen: true, seenHint: true, escSeen: true }));
  });
  await page.goto(`http://127.0.0.1:${arg('port', '5187')}/?seed=20261018&car=camper&quality=ultra`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 300000 });
  for (const [name, anchor, height, hour, quality] of [
    ['river', 'river', 6, 16.7, 'ultra'],
    ['forest', 'forest', 5.5, 16.7, 'ultra'],
    ['vista', 'vista', 62, 16.7, 'ultra'],
    ['night', 'vista', 62, 0, 'ultra'],
    ['high', 'road', 5.5, 16.7, 'high'],
    ['low', 'river', 6, 16.7, 'low'],
  ]) {
    await page.evaluate(({ a, height, hour, quality }) => {
      const e = window.__engine;
      e.setQuality(quality);
      e.adaptive = false;
      e.autoQuality = false;
      window.__forceCamera = true;
      window.__systems.cameraRig.enabled = false;
      window.__systems.vehicle.enabled = false;
      window.__lighting.hour = hour;
      window.__lighting.cycleSpeed = 0;
      const c = e.camera;
      c.position.set(a.x, window.__world.getHeight(a.x, a.z) + height, a.z);
      c.lookAt(a.x + Math.sin(a.yaw) * 50, c.position.y - 8, a.z + Math.cos(a.yaw) * 50);
      e.start();
    }, { a: anchors[anchor], height, hour, quality });
    const settled = await page.evaluate(() => window.__settleStable(600, 20));
    await page.waitForTimeout(2000);
    const result = await page.evaluate(() => {
      const e = window.__engine, r = e.renderer;
      e.stop();
      const objects = ['Sky', 'Clouds'].map(n => e.scene.getObjectByName(n));
      const draw = early => {
        objects.forEach((o, i) => {
          o.renderOrder = early ? -1000 + i : 1000 + i;
          o.material.depthTest = !early;
        });
        r.info.reset();
        e._render(0, e.elapsed);
        const gl = r.getContext();
        const bytes = new Uint8Array(r.domElement.width * r.domElement.height * 4);
        gl.readPixels(0, 0, r.domElement.width, r.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return { bytes, png: r.domElement.toDataURL('image/png').split(',')[1] };
      };
      draw(true); // first render can update lazy resources
      const old = draw(true), next = draw(false), restored = draw(true);
      const compare = (a, b) => {
        let changed = 0, max = 0, sum = 0;
        for (let i = 0; i < a.length; i += 4) {
          let delta = 0;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a[i + c] - b[i + c]);
            delta = Math.max(delta, d); sum += d;
          }
          if (delta) changed++;
          max = Math.max(max, delta);
        }
        return { changedPixels: changed, maxChannelDelta: max, meanChannelDelta: sum / (a.length / 4 * 3) };
      };
      draw(false);
      return { comparison: compare(old.bytes, next.bytes), control: compare(old.bytes, restored.bytes),
        before: old.png, after: next.png, resolution: window.__resolution(),
        brokenPrograms: r.info.programs.filter(p => p.diagnostics?.runnable === false).length };
    });
    const { before, after, ...stats } = result;
    writeFileSync(resolve(out, `${name}-before.png`), Buffer.from(before, 'base64'));
    writeFileSync(resolve(out, `${name}-after.png`), Buffer.from(after, 'base64'));
    results.push({ name, quality, hour, settled, ...stats });
    console.log(name, JSON.stringify(stats));
  }
} finally {
  await browser.close();
}
writeFileSync(resolve(out, 'report.json'), JSON.stringify({ results, errors }, null, 2));
if (errors.length || results.some(r => r.brokenPrograms || r.comparison.changedPixels || r.control.changedPixels)) {
  process.exitCode = 1;
}

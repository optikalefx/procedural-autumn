#!/usr/bin/env node
/**
 * Split the plunge-apron material into its two composited layers and into a
 * no-depth-test control, from one page load, so "which term draws the wedge"
 * is answered instead of argued.
 *
 *   node tools/_scratch/poolprobe.mjs --view fallbase --hour 18.6
 *
 * Variants:
 *   foam    — wetA forced to 0 (white churn only)
 *   wet     — foam alpha forced to 0 (wet-rock margin only)
 *   nodepth — untouched shader, depthTest off: shows the whole disc, so a
 *             boundary that DISAPPEARS here was terrain z-clipping the mesh,
 *             not the shader drawing an edge.
 *   flat    — constant white at alpha 1, depth test on: pure geometry footprint.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';
import { POSE_SRC } from '../_pose.mjs';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); if (i === -1) return d;
  const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true; };

const VIEW = arg('view', 'fallbase');
const DIR = arg('dir', 'shots/r2/poolprobe');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const HOUR = arg('hour', '18.6');
const SEED = arg('seed', '20261018');
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + `/?seed=${SEED}`;

const v = VIEWS[VIEW];
if (!v) { console.error(`no such view: ${VIEW}`); process.exit(1); }

await acquire('poolprobe');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

let frozen = null;
if (existsSync('review/anchors.json')) { try { frozen = JSON.parse(readFileSync('review/anchors.json','utf8')); } catch {} }
await page.evaluate((h) => { window.__lighting.hour = h; window.__lighting.cycleSpeed = 0; window.__forceCamera = true; }, parseFloat(HOUR));
await page.evaluate(new Function('P', POSE_SRC), { v, frozen, dynamic: [] });
await page.evaluate(() => window.__settleStable ? window.__settleStable() : window.__settle?.(60));
await page.waitForTimeout(900);

mkdirSync(resolve(DIR), { recursive: true });

const setup = await page.evaluate(() => {
  let m = null;
  window.__engine.scene.traverse(o => { if (o.name === 'PlungePools') m = o; });
  if (!m) return 'no PlungePools mesh';
  window.__poolMesh = m;
  window.__poolSrc = m.material.fragmentShader;
  return 'ok';
});
if (setup !== 'ok') { console.error(setup); process.exit(1); }

const variants = {
  all:     null,
  foam:    (s) => s.replace('float wetA = clamp(wet, 0.0, 1.0) * 0.34 * vPower;',
                            'float wetA = 0.0;'),
  wet:     (s) => s.replace(/float alpha = clamp\(foam \* 1\.45[^;]*;/,
                            'float alpha = 0.0;'),
  flat:    (s) => s.replace('gl_FragColor = vec4(outC, outA);',
                            'gl_FragColor = vec4(1.0, 0.2, 0.9, 1.0);')
                   .replace('if (!(outA >= 0.02)) discard;', ''),
  // the contact term itself, as a greyscale. If the straight edges are in
  // here, the fade is a new contour generator keyed to the mesh's own
  // tessellation and not a depth clip at all.
  contact: (s) => s.replace('gl_FragColor = vec4(outC, outA);',
                            'gl_FragColor = vec4(vec3(contact), 1.0);')
                   .replace('if (!(outA >= 0.02)) discard;', '')
                   .replace('#include <fog_fragment>', '')
                   .replace('#include <tonemapping_fragment>', '')
                   .replace('#include <colorspace_fragment>', ''),
  // lift, in metres, of the draped mesh above the baked bed, encoded 0..10 m
  // into red and 0..2 m into green so both scales are readable off one frame.
  lift:    (s) => s.replace('gl_FragColor = vec4(outC, outA);',
                            'vec4 _d = wWorldData(vWPos.xz); float _s = (_d.g > -9000.0 && _d.g > _d.r) ? _d.g : _d.r; float _l = vWPos.y - _s - 0.55;'
                          + 'gl_FragColor = vec4(clamp(_l/10.0,0.0,1.0), clamp(_l/2.0,0.0,1.0), _l < 0.0 ? 1.0 : 0.0, 1.0);')
                   .replace('if (!(outA >= 0.02)) discard;', '')
                   // Fog composites a colour over the debug value and tone mapping in
                   // three is a channel-MIXING matrix for
                   // ACES, so a debug value read back through it is not the
                   // value. Strip both post steps or the numbers are fiction.
                   .replace('#include <fog_fragment>', '')
                   .replace('#include <tonemapping_fragment>', '')
                   .replace('#include <colorspace_fragment>', ''),
};

for (const [name, patch] of Object.entries(variants)) {
  await page.evaluate(({ name, patched }) => {
    const m = window.__poolMesh;
    m.visible = true;
    m.material.depthTest = true;
    if (patched) { m.material.fragmentShader = patched; m.material.needsUpdate = true; }
    else { m.material.fragmentShader = window.__poolSrc; m.material.needsUpdate = true; }
  }, { name, patched: patch ? patch(await page.evaluate(() => window.__poolSrc)) : null });
  await page.evaluate(() => window.__settle?.(8));
  await page.waitForTimeout(400);
  const out = resolve(DIR, `${VIEW}-${name}.png`);
  await page.screenshot({ path: out });
  console.log('poolprobe:', out);
}

// no-depth-test control on the untouched shader
await page.evaluate(() => {
  const m = window.__poolMesh;
  m.material.fragmentShader = window.__poolSrc;
  m.material.depthTest = false;
  m.material.needsUpdate = true;
});
await page.evaluate(() => window.__settle?.(8));
await page.waitForTimeout(400);
const out = resolve(DIR, `${VIEW}-nodepth.png`);
await page.screenshot({ path: out });
console.log('poolprobe:', out);

await browser.close();

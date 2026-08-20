#!/usr/bin/env node
/**
 * Interleaved rock-colour A/B — every variant captured inside ONE page load.
 *
 *   node tools/_scratch/rockcast.mjs waterfall hero --out shots/rocks/cast
 *
 * Writes <out>-<view>-<state>[-c0].png. Between shots it changes only uniforms
 * on the rock material (and, for the `-c0` pass, forces the atmosphere's
 * cloudShadowGain to 0 as a control). Nothing else about the page moves: same
 * boot, same wind phase, same tree sway, same cloud offset, same water phase.
 *
 * This exists because a before/after taken as two separate runs is worthless on
 * this repo. Two `river` captures 34 minutes apart with only src/rocks changed
 * differed in 50.1% of pixels — five other authors save in between. It is also
 * why the cloud control is here: the look author is rewriting the cloud-shadow
 * coverage field right now, and rock is one of the surfaces it lands on, so
 * every rock number worth keeping has to be quoted with the shadow off too.
 *
 * `--probe` additionally logs where the biggest near rocks land on screen, so a
 * measurement rect is aimed at a named instance instead of by eye.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const views = argv.filter((a) => !a.startsWith('--') && VIEWS[a]);
if (!views.length) views.push('waterfall');
const outBase = arg('out', 'shots/rocks/cast');
const CLOUD0 = !argv.includes('--no-cloud-control');
const PROBE = argv.includes('--probe');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
// Frames of animation allowed to run between two states. Small on purpose: the
// water, the foliage sway and the cloud offset all move every frame, and they
// move far more pixels than a rock hue change does. 2 is enough for a uniform
// upload to reach the screen; 30 was enough to swamp the measurement.
const SETTLE = parseInt(arg('settle', '2'), 10);

// Uniform states. `base` MUST be a no-op: it sets nothing, so the first frame
// of every run is the shipped build rendered by the shipped shader.
const STATES = JSON.parse(arg('states', 'null')) ?? [
  { tag: 'base', u: {} },
  { tag: 'split0p6', u: { uRockSplit: 0.6 } },
  { tag: 'split1p0', u: { uRockSplit: 1.0 } },
];

mkdirSync(dirname(outBase), { recursive: true });
const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('rock-cast-ab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('ROCK')) console.log(t); });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto(arg('url', 'http://localhost:5178') + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const aimCamera = (v, probe) => page.evaluate(async ({ v, frozen, probe }) => {
  const THREE = window.__THREE;
  const e = window.__engine, wd = window.__world;
  window.__lighting.hour = v.hour;
  window.__lighting.cycleSpeed = 0;
  const anchor = frozen[v.anchor];
  const yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back;
  const gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  const pos = new THREE.Vector3(gx, gy, gz);
  const look = new THREE.Vector3(gx + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist, gz + Math.cos(yaw) * v.dist);
  e.camera.fov = v.fov;
  e.camera.updateProjectionMatrix();
  e.camera.position.copy(pos);
  e.camera.lookAt(look);
  window.__forceCamera = true;
  window.dispatchEvent(new Event('resize'));
  if (window.__settle) await window.__settle(150);
  if (!probe) return;
  const rk = window.__systems.rocks;
  const m = new THREE.Matrix4(), q = new THREE.Vector3();
  const rows = [];
  for (const mesh of rk.meshes) {
    const at = mesh.geometry.attributes.aRockA;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m); q.setFromMatrixPosition(m);
      const d = q.distanceTo(e.camera.position);
      const size = at.array[i * 4 + 3];
      const pr = q.clone().project(e.camera);
      if (Math.abs(pr.x) > 1 || Math.abs(pr.y) > 1 || pr.z > 1) continue;
      rows.push({ a: mesh.userData.arch, size, d, fx: (pr.x + 1) / 2, fy: (1 - pr.y) / 2 });
    }
  }
  rows.sort((x, y) => y.size / y.d - x.size / x.d);
  for (const r of rows.slice(0, 14))
    console.log(`ROCK ${r.a} size ${r.size.toFixed(1)} d ${r.d.toFixed(0)}m  screen ${(r.fx * 100).toFixed(1)}% , ${(r.fy * 100).toFixed(1)}%`);
}, { v, frozen, probe });

const applyState = (u, cloudGain, hide = false) => page.evaluate(async ({ u, cloudGain, hide, settle }) => {
  const rk = window.__systems.rocks;
  // Ownership mask: hiding the system and differencing is the only way to know
  // which pixels this material actually renders. A rect chosen by eye off a
  // screenshot cannot tell rock from the terrain massif behind it, and both of
  // the findings this pass is answering are quoted on rects chosen that way.
  // Hide the whole group. Per-mesh visible=false does not survive: _repack()
  // rewrites mesh.visible from the instance count on the next update, and a
  // masked frame that quietly un-hid itself measured a 0.000 difference and
  // very nearly got written up as 'rocks draw nothing here'.
  rk.group.visible = !hide;
  const un = rk?.material?.userData?.uniforms;
  if (!un) throw new Error('rock uniforms not found');
  if (!window.__rockBase) {
    window.__rockBase = {};
    for (const [k, v] of Object.entries(un)) {
      const val = v.value;
      window.__rockBase[k] = (val && val.isColor) ? val.clone()
        : (val && val.isVector3) ? val.clone()
        : (val && val.isVector4) ? val.clone() : val;
    }
  }
  // Always restore first, so a state is absolute rather than cumulative.
  for (const [k, v] of Object.entries(window.__rockBase)) {
    if (!un[k]) continue;
    if (v && v.copy) un[k].value.copy(v); else un[k].value = v;
  }
  for (const [k, v] of Object.entries(u)) {
    if (!un[k]) throw new Error(`no such rock uniform: ${k}`);
    if (Array.isArray(v)) un[k].value.set(...v); else un[k].value = v;
  }
  if (cloudGain !== null) {
    if (!('__cloudBase' in window)) window.__cloudBase = window.__atmosphere.params.cloudShadowGain;
    window.__atmosphere.params.cloudShadowGain = cloudGain;
  } else if ('__cloudBase' in window) {
    window.__atmosphere.params.cloudShadowGain = window.__cloudBase;
  }
  if (window.__settle) await window.__settle(settle);
}, { u, cloudGain, hide, settle: SETTLE });

for (const view of views) {
  await aimCamera(VIEWS[view], PROBE);
  for (const cloud of CLOUD0 ? [null, 0] : [null]) {
    for (const st of STATES) {
      await applyState(st.u, cloud, !!st.hide);
      const path = `${outBase}-${view}-${st.tag}${cloud === 0 ? '-c0' : ''}.png`;
      await page.screenshot({ path });
      console.log(`wrote ${path}  ${JSON.stringify(st.u)}${cloud === 0 ? '  cloudShadowGain=0' : ''}`);
    }
  }
}
await applyState({}, null);
await browser.close();

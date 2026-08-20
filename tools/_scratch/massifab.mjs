#!/usr/bin/env node
/**
 * Interleaved terrain-massif A/B — every variant captured inside ONE page load.
 *
 *   node tools/_scratch/massifab.mjs waterfall peaks --out shots/terr/ab
 *   node tools/_scratch/massifab.mjs waterfall --states '[{"tag":"base","u":{}},…]'
 *
 * Writes <out>-<view>-<state>[-c0].png. Between shots it changes only uniforms
 * on the TERRAIN material (plus, for a `dbg` state, uDebugMask). Nothing else
 * about the page moves: same boot, same wind phase, same sway, same cloud
 * offset, same water phase.
 *
 * This is the rocks author's rockcast.mjs pointed at src/world/TerrainMaterial
 * instead, and it exists for the same reason: a before/after taken as two
 * separate runs is worthless on this repo. Two `river` captures 34 minutes
 * apart with only src/rocks changed differed in 50.1% of pixels — six authors
 * save in between. The cloud control is here for the same reason too: a
 * lighting author is rewriting the cloud-shadow coverage field right now and
 * the massif is the largest surface it lands on, so every number worth keeping
 * is quoted at the shipped gain AND at gain 0.
 *
 * States are objects: { tag, u: {uniform: value}, dbg: n, hideRocks: true }.
 *  · `u` sets terrain uniforms; every state restores the captured base first,
 *    so a state is absolute rather than cumulative.
 *  · `dbg` sets uDebugMask (see the block at the end of TerrainMaterial.js).
 *    Mask 11 is the ownership paint — terrain rock red, terrain non-rock
 *    green — which is the only honest way to aim a measurement rect at the
 *    massif rather than at the trees and water in front of it.
 *  · `hideRocks` hides src/rocks entirely, so the terrain massif can be
 *    measured without the crag blocks another author is live on.
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
const outBase = arg('out', 'shots/terr/ab');
const CLOUD0 = !argv.includes('--no-cloud-control');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
// Frames of animation allowed to run between two states. Small on purpose: the
// water, the foliage sway and the cloud offset all move every frame and they
// move far more pixels than a terrain uniform does. 2 is enough for an upload
// to reach the screen.
const SETTLE = parseInt(arg('settle', '2'), 10);

const STATES = JSON.parse(arg('states', 'null')) ?? [
  { tag: 'base', u: {} },
];

mkdirSync(dirname(outBase), { recursive: true });
const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('terrain-massif-ab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { const t = m.text(); if (t.startsWith('TERR')) console.log(t); });
page.on('pageerror', (e) => console.error('page error:', String(e)));
await page.goto(arg('url', 'http://localhost:5178') + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const aimCamera = (v) => page.evaluate(async ({ v, frozen }) => {
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
}, { v, frozen });

const applyState = (st, cloudGain) => page.evaluate(async ({ st, cloudGain, settle }) => {
  const un = window.__terrain?.material?.userData?.uniforms;
  if (!un) throw new Error('terrain uniforms not found');
  if (!window.__terrBase) {
    window.__terrBase = {};
    for (const [k, v] of Object.entries(un)) {
      const val = v.value;
      window.__terrBase[k] = (val && val.isColor) ? val.clone()
        : (val && val.isVector3) ? val.clone()
        : (val && val.isVector4) ? val.clone()
        : (val && val.isVector2) ? val.clone() : val;
    }
  }
  // Always restore first, so a state is absolute rather than cumulative.
  for (const [k, v] of Object.entries(window.__terrBase)) {
    if (!un[k]) continue;
    if (v && v.copy && un[k].value && un[k].value.copy) un[k].value.copy(v);
    else un[k].value = v;
  }
  for (const [k, v] of Object.entries(st.u || {})) {
    if (!un[k]) throw new Error(`no such terrain uniform: ${k}`);
    if (Array.isArray(v)) un[k].value.set(...v); else un[k].value = v;
  }
  un.uDebugMask.value = st.dbg ?? 0;
  // Hiding the rocks group is the only way to measure the terrain massif on
  // its own. Rocks _repack() rewrites mesh.visible from the instance count on
  // the next update, so hide the GROUP — per-mesh visible=false does not
  // survive, and a masked frame that quietly un-hid itself has already cost
  // this project a round.
  const rk = window.__systems?.rocks;
  if (rk?.group) rk.group.visible = !st.hideRocks;
  if (cloudGain !== null) {
    if (!('__cloudBase' in window)) window.__cloudBase = window.__atmosphere.params.cloudShadowGain;
    window.__atmosphere.params.cloudShadowGain = cloudGain;
  } else if ('__cloudBase' in window) {
    window.__atmosphere.params.cloudShadowGain = window.__cloudBase;
  }
  if (window.__settle) await window.__settle(settle);
}, { st, cloudGain, settle: SETTLE });

for (const view of views) {
  await aimCamera(VIEWS[view]);
  for (const cloud of CLOUD0 ? [null, 0] : [null]) {
    for (const st of STATES) {
      // A debug mask is a false-colour read-out of the material's own fields;
      // the cloud shadow does not enter it, so capturing it twice is waste.
      if (st.dbg && cloud === 0) continue;
      await applyState(st, cloud);
      const path = `${outBase}-${view}-${st.tag}${cloud === 0 ? '-c0' : ''}.png`;
      await page.screenshot({ path });
      console.log(`wrote ${path}  ${JSON.stringify(st.u || {})}${st.dbg ? ` dbg=${st.dbg}` : ''}${st.hideRocks ? ' rocks-hidden' : ''}${cloud === 0 ? '  cloudShadowGain=0' : ''}`);
    }
  }
}
await applyState({ tag: 'restore', u: {} }, null);
await browser.close();

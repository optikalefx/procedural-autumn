#!/usr/bin/env node
/**
 * Interleaved ground-cover A/B — every variant captured inside ONE page load.
 *
 *   node tools/_scratch/coverab.mjs river --out shots/cover/x1/s
 *
 * Modelled on tools/_scratch/rockcast.mjs, and for the same reason: a
 * before/after taken as two separate runs is worthless on this repo. Two
 * `river` captures 34 minutes apart with only one system changed differed in
 * 50.1% of pixels. Five authors save in between.
 *
 * Each state may carry:
 *   hide: ['groundCover','grass',…]   group.visible = false — the ownership mask
 *   u:    { uAoDepth: 0.9, … }        cover material uniforms
 * and every state is captured twice, once at the shipped cloudShadowGain and
 * once with it forced to 0. That control is mandatory here: the lighting author
 * has moved the cloud-shadow term twice today, and two authors nearly tuned
 * against it.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquire } from '../_lock.mjs';
import { VIEWS } from '../shot.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const views = argv.filter((a) => !a.startsWith('--') && VIEWS[a]);
if (!views.length) views.push('river');
const outBase = arg('out', 'shots/cover/ab');
const CLOUD0 = !argv.includes('--no-cloud-control');
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const SETTLE = parseInt(arg('settle', '3'), 10);

const STATES = JSON.parse(arg('states', 'null')) ?? [
  { tag: 'base', u: {} },
  { tag: 'nocover', hide: ['groundCover'] },
  { tag: 'nograss', hide: ['grass'] },
  { tag: 'norocks', hide: ['rocks'] },
  { tag: 'notrees', hide: ['trees'] },
  { tag: 'bare', hide: ['groundCover', 'grass', 'rocks'] },
];

mkdirSync(dirname(outBase), { recursive: true });
const frozen = JSON.parse(readFileSync(new URL('../../review/anchors.json', import.meta.url), 'utf8'));

await acquire('cover-ab');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
// Kill vite's HMR socket. A save anywhere in the project — including a save to
// this file, and five other authors are saving constantly — triggers a full
// page reload mid-run, which destroys the execution context and, worse, would
// silently re-boot the world between two arms of an A/B that exists precisely
// to hold everything else still.
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {}, removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
  window.WebSocket.prototype = R.prototype; Object.assign(window.WebSocket, R);
});
page.on('console', (m) => { const t = m.text(); if (t.startsWith('COVER')) console.log(t); });
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
  if (window.__settleStable) await window.__settleStable(1500, 30);
  else if (window.__settle) await window.__settle(240);
}, { v, frozen });

const applyState = (st, cloudGain) => page.evaluate(async ({ st, cloudGain, settle }) => {
  const sys = window.__systems;
  // Per-archetype masking. `_repack` rewrites `slot.mesh.visible` from the
  // instance count whenever a cell finishes or the camera moves 12 m, so a
  // one-shot assignment silently un-hides itself — rockcast.mjs lost a
  // measurement to exactly that. Re-assert it every frame from a late updater.
  if (!window.__coverArchHook) {
    window.__coverArchRe = null;
    window.__coverArchHook = window.__engine.onLateUpdate(() => {
      const re = window.__coverArchRe;
      for (const sl of window.__systems.groundCover.slots) {
        // Restore as well as hide. A hook that only ever clears `visible`
        // makes every state cumulative with the ones before it, which is a
        // silent failure: the last state in a run then reads as the whole
        // layer hidden and every attribution in between is a running total.
        sl.mesh.visible = (re && re.test(sl.mesh.name)) ? false : sl.mesh.count > 0;
      }
    });
  }
  window.__coverArchRe = st.archHide ? new RegExp(st.archHide) : null;
  const hide = new Set(st.hide || []);
  for (const k of ['groundCover', 'grass', 'rocks', 'trees', 'water', 'wildlife']) {
    const s = sys[k];
    if (s && s.group) s.group.visible = !hide.has(k);
  }
  const un = sys.groundCover?.uniforms;
  if (!un) throw new Error('cover uniforms not found');
  if (!window.__coverBase) {
    window.__coverBase = {};
    for (const [k, v] of Object.entries(un)) {
      const val = v.value;
      window.__coverBase[k] = (val && val.clone) ? val.clone() : val;
    }
  }
  for (const [k, v] of Object.entries(window.__coverBase)) {
    if (!un[k]) continue;
    if (v && v.copy) un[k].value.copy(v); else un[k].value = v;
  }
  for (const [k, v] of Object.entries(st.u || {})) {
    if (!un[k]) throw new Error(`no such cover uniform: ${k}`);
    if (Array.isArray(v)) un[k].value.set(...v); else un[k].value = v;
  }
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
      await applyState(st, cloud);
      const path = `${outBase}-${view}-${st.tag}${cloud === 0 ? '-c0' : ''}.png`;
      await page.screenshot({ path });
      console.log(`wrote ${path}  ${JSON.stringify(st.u || {})}${st.hide ? ' hide=' + st.hide.join('+') : ''}${st.archHide ? ' archHide=' + st.archHide : ''}${cloud === 0 ? '  cloudShadowGain=0' : ''}`);
    }
  }
}
await applyState({ tag: 'base', u: {} }, null);
await browser.close();

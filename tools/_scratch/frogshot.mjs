#!/usr/bin/env node
/**
 * Frog gallery captures — the model from set angles, and the jump as a strip.
 *
 *   node tools/_scratch/frogshot.mjs [--out shots/frog] [--port 5253] [--variant 0]
 *
 * Writes:
 *   model-<pose>-<view>.png    sit / crouch / launch / flight / descend / land /
 *                              croak, each from front-3/4, side, front, top
 *   strip-<stage>-<u>.png      the jump timeline sampled every 0.1 of each stage,
 *                              from the side, for judging the motion frame by frame
 *
 * Runs against the gallery page on the worktree's own dev server (AGENTS.md:
 * port 5178 serves MAIN). The Browser pane freezes rAF while hidden, so this
 * drives the stage by hand: `stage.update(0.016)` after each pose.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const OUT = arg('out', 'shots/frog');
const PORT = arg('port', '5253');
const VARIANT = arg('variant', '0');
const ONLY = arg('only', null);             // 'model' | 'strip'
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0, null, { timeout: 120000 });
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });

const found = await page.evaluate((id) => {
  const g = window.__gallery;
  const e = g.entries.find((x) => x.id === id);
  if (!e) return null;
  g.select(e.id);
  return e.id;
}, `frog:${VARIANT}`);
if (!found) { console.error('no frog card'); await browser.close(); process.exit(1); }
await page.waitForTimeout(900);

// The gallery caches a PROMISE of the built card; await it, then swap our own
// FrogRig onto its root so the harness can pose it directly (the card's own
// update() re-applies the selected pose every frame, so it is neutralised).
await page.evaluate(async (id) => {
  const g = window.__gallery;
  const built = await g.acquire(id);
  const root = built.root;
  const mod = await import('/src/wildlife/frog_model.js');
  const hideMod = await import('/src/wildlife/mammals/hide.js');
  const vi = parseInt(id.split(':')[1], 10);
  const v = mod.FROG.variants[vi];
  const hide = hideMod.createHideMaterial(v.col); hide.roughness = 0.55;
  const rig = new mod.FrogRig(mod.frogProtos()[vi], hide, v.scale);
  while (root.children.length) root.remove(root.children[0]);
  root.add(rig.mesh);
  window.__frogRig = rig;
  built.update = () => {};
  g.stage.update(0.016);
}, `frog:${VARIANT}`);

const VIEWS = { q34: [0.75, 0.22], side: [1.5708, 0.05], front: [0, 0.12], top: [0.75, 1.25], rear34: [2.4, 0.2] };
const setView = (yaw, pitch) => page.evaluate(({ yaw, pitch }) => {
  const st = window.__gallery.stage;
  st.turntable = false; st.yaw = yaw; st.pitch = pitch;
  st.update(0.016);
}, { yaw, pitch });

const setPose = (stage, u, sac = 0) => page.evaluate(({ stage, u, sac }) => {
  const rig = window.__frogRig;
  if (!rig) return 'no rig';
  rig.setPose(stage, u); rig.sac = sac; rig.update(0);
  window.__gallery.stage.update(0.016);
  return 'ok';
}, { stage, u, sac });

const shot = async (name) => {
  await page.waitForTimeout(60);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/${name}.png` });
};

if (ONLY !== 'strip') {
  const POSES = [['sit', 'sit', 0], ['crouch', 'crouch', 1], ['launch', 'launch', 1], ['flight', 'flight', 0.45],
                 ['descend', 'flight', 0.92], ['land', 'land', 0.35], ['croak', 'sit', 0, 1]];
  for (const [name, stage, u, sac] of POSES) {
    const r = await setPose(stage, u, sac ?? 0);
    if (r !== 'ok') console.log('pose', name, r);
    for (const [view, [yaw, pitch]] of Object.entries(VIEWS)) {
      if (name !== 'sit' && view === 'rear34') continue;
      await setView(yaw, pitch);
      await shot(`model-${name}-${view}`);
    }
  }
}
if (ONLY !== 'model') {
  await setView(1.5708, 0.05);
  for (const stage of ['crouch', 'launch', 'flight', 'land']) {
    for (let i = 0; i <= 10; i += 2) {
      await setPose(stage, i / 10);
      await shot(`strip-${stage}-${String(i).padStart(2, '0')}`);
    }
  }
}
console.log(`wrote ${OUT}`);
if (errs.length) console.log('page errors:', errs.slice(0, 5));
await browser.close();

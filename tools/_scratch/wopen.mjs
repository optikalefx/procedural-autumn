#!/usr/bin/env node
/**
 * Does the stand-off actually put animals in front of the meadow rather than
 * under the canopy? (wildlife author, scratch)
 *
 * Streams sites in across the map and reports the canopy weight at the point
 * each animal actually stands. This measures the one thing the change claims
 * to do; it says nothing about whether the result is prettier, which is what
 * the frames are for.
 */
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';

await acquire('wopen');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5178?res=768');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await page.evaluate(async () => {
  const e = window.__engine, W = window.__world, wl = window.__systems.wildlife;
  window.__forceCamera = true;
  e.stop(); e.clock.getDelta = () => 1 / 30;
  const cam = e.camera;
  const half = (W.half ?? 1024) * 0.8;

  // `brain.cfg` is the very same object as SPECIES[key].brain, so this reaches
  // the live config without needing the module. Sweeping both settings inside
  // one page load is the only fair comparison: it is the same world, the same
  // seeds and the same sites, with one number changed.
  const cfgOf = (key) => wl.pool[key]?.[0]?.[0]?.brain?.cfg ?? null;
  const KEYS = ['deer', 'bear', 'rabbit'];
  const saved = {};
  for (const k of KEYS) { const c = cfgOf(k); if (c) saved[k] = c.standoff ?? 0; }

  const sweep = (setStandoff) => {
    for (const k of KEYS) { const c = cfgOf(k); if (c) c.standoff = setStandoff(k); }
    // Force every site to re-place from scratch rather than recall where its
    // animals were standing last time.
    wl.debugClear();
    for (let i = 0; i < wl.sites.n; i++) wl.sites.memoT[i] = -1e9;

    const per = { deer: [], bear: [], rabbit: [] };
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2 * 3.7;
      const r = half * (0.15 + 0.85 * (i / 60));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      cam.position.set(x, W.getHeight(x, z) + 20, z);
      cam.lookAt(x + Math.cos(a), W.getHeight(x, z) + 18, z + Math.sin(a));
      cam.updateMatrixWorld(true);
      for (let f = 0; f < 14; f++) e._loop();
      for (const key of wl.keys) {
        if (!per[key]) continue;
        for (const pool of wl.pool[key]) {
          for (const A of pool) {
            if (!A.active) continue;
            per[key].push(+wl._canopy(A.brain.pos.x, A.brain.pos.z, 11).toFixed(3));
          }
        }
      }
    }
    const stat = (v) => {
      if (!v.length) return null;
      const s2 = v.slice().sort((p, q) => p - q);
      return {
        n: v.length,
        median: +s2[Math.floor(s2.length / 2)].toFixed(2),
        p25: +s2[Math.floor(s2.length * 0.25)].toFixed(2),
        // How often the animal stands somewhere a dark hide has nothing to
        // contrast against.
        fracHeavy: +(v.filter((q) => q > 2.0).length / v.length).toFixed(3),
        fracOpen: +(v.filter((q) => q < 0.8).length / v.length).toFixed(3),
      };
    };
    return { deer: stat(per.deer), bear: stat(per.bear), rabbit: stat(per.rabbit) };
  };

  const before = sweep(() => 0);
  const after = sweep((k) => saved[k] ?? 0);
  return { standoff: saved, before, after };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.error('page errors:', errs.slice(0, 4));
await browser.close();

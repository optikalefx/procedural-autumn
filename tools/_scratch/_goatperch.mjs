#!/usr/bin/env node
/**
 * End-to-end: does the baked perch field reach a live goat?
 *
 * `goatdome.mjs` proves the ARITHMETIC headlessly, against the real geometry.
 * It cannot prove the WIRING — that `Rocks.perchField` is reachable when
 * `Wildlife._findPerches` runs, that the field survives onto the group's rock
 * record, and that `Brain._groundY` reads it. Three files, and every one of them
 * fails SILENTLY: a null field falls straight back to the old flat top and the
 * goat simply floats again, with no error anywhere.
 *
 *   node tools/_scratch/_goatperch.mjs
 */
import { chromium } from 'playwright';

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?res=768';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 400 });

const out = await page.evaluate(async () => {
  const wl = window.__systems.wildlife;
  const W = window.__world;
  const { SPECIES } = await import('/src/wildlife/animal_species.js');
  const { Brain } = await import('/src/wildlife/animal_brain.js');
  const S = wl.sites, keys = wl.keys;

  const rows = [];
  let withField = 0, total = 0, worstLift = 0;
  for (let i = 0; i < S.n; i++) {
    const key = keys[S.spec[i]];
    if (key !== 'goat' && key !== 'ram') continue;
    const cfg = SPECIES[key].brain.rock;
    if (!cfg) continue;
    // Wake the site the way the streamer does.
    const g = {};
    wl._findPerches(g, S.x[i], S.z[i], cfg);
    if (!g.rocks?.length) continue;

    const brain = new Brain(key, SPECIES[key], (i * 2654435761) >>> 0, g, 0);
    for (const r of g.rocks) {
      total++;
      if (r.field) withField++;
      brain.rock = r;
      // What the animal stands on at the summit, new path vs the old flat top.
      const now = brain._groundY(W, r.x, r.z);
      const wasField = r.field; r.field = null;
      const before = brain._groundY(W, r.x, r.z);
      r.field = wasField;
      const drop = before - now;              // how much float the fix removed
      if (drop > worstLift) worstLift = drop;
      rows.push({
        site: i, key, r: +r.r.toFixed(2), rise: +r.rise.toFixed(2),
        field: !!r.field, n: r.field?.n ?? 0,
        before: +before.toFixed(3), now: +now.toFixed(3), drop: +drop.toFixed(3),
      });
    }
  }
  const drops = rows.filter((r) => r.field).map((r) => r.drop).sort((a, b) => a - b);
  const mean = drops.reduce((t, v) => t + v, 0) / Math.max(1, drops.length);
  return {
    alpineRocks: total, withField,
    meanDropAtSummit: +mean.toFixed(3),
    medianDrop: +(drops[drops.length >> 1] ?? 0).toFixed(3),
    worstDrop: +worstLift.toFixed(3),
    sample: rows.slice(0, 8),
  };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.withField === out.alpineRocks && out.alpineRocks > 0
  ? `\nPASS — every one of ${out.alpineRocks} alpine perches carries a baked field, `
    + `and the summit drops a mean ${out.meanDropAtSummit} m onto the real rock.`
  : `\nFAIL — ${out.alpineRocks - out.withField} of ${out.alpineRocks} perches have NO field; `
    + `those animals are still standing on the bounding box.`);
await browser.close();

#!/usr/bin/env node
/**
 * The goat's path, drawn. "Erratic" is a thing you see, not a scalar, and a
 * reversal counter cannot tell a lap of an outcrop from a pendulum between two.
 *
 * Top-down, one panel per animal that stayed awake long enough to have a path:
 * boulders as rings, the track coloured by state (wander cyan, climb amber,
 * perch white, graze/idle dim), and a tick every ten seconds so the pace is
 * readable. Run it before and after a steering change and put the two side by
 * side; that comparison is the whole point of the tool.
 *
 *   AUTUMN_URL=http://localhost:5178 node tools/_scratch/_goatpath.mjs --out a.png
 */
import { chromium } from 'playwright';
import { writePNG, canvas, text } from '../_png.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SECONDS = parseFloat(arg('seconds', '420'));
const AT = arg('at', 'goat');
const OUT = arg('out', 'tools/_scratch/out/goatpath.png');
const LABEL = arg('label', '');

const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '/?res=768';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(async (P) => {
  const e = window.__engine, wl = window.__systems.wildlife;
  window.__lighting.cycleSpeed = 0;
  wl.debugClear();
  wl.debugThreat(null);

  const S = wl.sites, ki = wl.keys.indexOf(P.AT);
  const cfg = wl.pool[P.AT][0][0].brain.cfg.rock;
  let rock = null;
  for (let i = 0; i < S.n && !rock; i++) {
    if (S.spec[i] !== ki) continue;
    const g = { rocks: null };
    wl._findPerches(g, S.x[i], S.z[i], cfg);
    if (g.rocks.length) rock = g.rocks[0];
  }
  if (!rock) return { error: `no ${P.AT} site with a perch` };
  window.__forceCamera = true;
  const cx = rock.x + 11, cz = rock.z + 11;
  const cy = window.__world.getHeight(cx, cz) + 3.2;
  e.camera.position.set(cx, cy, cz);
  e.camera.lookAt(cx + (cx - rock.x), cy, cz + (cz - rock.z));

  e.stop();
  const DT = 1 / 30;
  e.clock.getDelta = () => DT;
  const steps = Math.round(P.SECONDS / DT);
  const EVERY = 3;                       // 10 Hz is plenty for a 0.9 m/s animal

  const tracks = new Map();
  for (let s = 0; s < steps; s++) {
    e._loop();
    if (s % EVERY) continue;
    for (const per of wl.pool[P.AT]) {
      for (const a of per) {
        if (!a.active) continue;
        const b = a.brain;
        let t = tracks.get(a);
        if (!t) tracks.set(a, t = { x: [], z: [], st: [], t: [], rocks: [] });
        // A pooled animal is reused; a jump means a different individual, and
        // splicing the two into one track would draw a line across the valley.
        const n = t.x.length;
        if (n && Math.hypot(b.pos.x - t.x[n - 1], b.pos.z - t.z[n - 1]) > 12) {
          t.x.length = 0; t.z.length = 0; t.st.length = 0; t.t.length = 0;
        }
        t.x.push(+b.pos.x.toFixed(2)); t.z.push(+b.pos.z.toFixed(2));
        t.st.push(b.state); t.t.push(+(s * DT).toFixed(1));
        if (!t.rocks.length && b.group?.rocks) {
          t.rocks = b.group.rocks.map((r) => ({ x: +r.x.toFixed(1), z: +r.z.toFixed(1), r: +r.r.toFixed(1) }));
        }
      }
    }
  }
  const rows = [...tracks.values()].filter((t) => t.x.length > 120);
  rows.sort((a, b) => b.x.length - a.x.length);
  return { at: P.AT, seconds: P.SECONDS, tracks: rows.slice(0, 6) };
}, { SECONDS, AT });

await browser.close();
if (out.error) { console.log(out.error); process.exit(1); }

// ── draw ─────────────────────────────────────────────────────────────────────
const COL = {
  0: [96, 96, 104], 1: [82, 104, 78], 2: [70, 190, 220], 3: [220, 120, 90],
  4: [230, 90, 80], 5: [140, 140, 160], 6: [200, 170, 90], 7: [245, 170, 60],
  8: [250, 250, 250],
};
const PANEL = 380, PAD = 16, COLS = Math.min(3, out.tracks.length || 1);
const ROWS = Math.ceil(out.tracks.length / COLS);
const img = canvas(PAD + COLS * (PANEL + PAD), PAD + 26 + ROWS * (PANEL + PAD + 18), [18, 18, 22]);
text(img, PAD, PAD - 6, `${out.at.toUpperCase()} PATHS ${out.seconds}S ${LABEL}`.toUpperCase(), [225, 225, 230], 2);

out.tracks.forEach((t, i) => {
  const ox = PAD + (i % COLS) * (PANEL + PAD);
  const oy = PAD + 26 + Math.floor(i / COLS) * (PANEL + PAD + 18);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const ext = (x, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; };
  for (let k = 0; k < t.x.length; k++) ext(t.x[k], t.z[k]);
  for (const r of t.rocks) { ext(r.x - r.r, r.z - r.r); ext(r.x + r.r, r.z + r.r); }
  const span = Math.max(x1 - x0, z1 - z0, 10) * 1.08;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const S = (PANEL - 12) / span;
  const px = (x) => ox + PANEL / 2 + (x - mx) * S;
  const py = (z) => oy + PANEL / 2 + (z - mz) * S;
  // frame
  for (let x = 0; x < PANEL; x++) { img.put(ox + x, oy, 44, 44, 50); img.put(ox + x, oy + PANEL - 1, 44, 44, 50); }
  for (let y = 0; y < PANEL; y++) { img.put(ox, oy + y, 44, 44, 50); img.put(ox + PANEL - 1, oy + y, 44, 44, 50); }
  // boulders
  for (const r of t.rocks) {
    const cxp = px(r.x), cyp = py(r.z), rp = r.r * S;
    for (let a = 0; a < 360; a++) {
      const th = a * Math.PI / 180;
      img.put(Math.round(cxp + Math.cos(th) * rp), Math.round(cyp + Math.sin(th) * rp), 120, 100, 70);
    }
  }
  // track, 2 px wide so it reads over the rings
  for (let k = 1; k < t.x.length; k++) {
    const ax = px(t.x[k - 1]), ay = py(t.z[k - 1]), bx = px(t.x[k]), by = py(t.z[k]);
    const c = COL[t.st[k]] || [200, 200, 200];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let j = 0; j <= n; j++) {
      const x = Math.round(ax + (bx - ax) * j / n), y = Math.round(ay + (by - ay) * j / n);
      img.put(x, y, c[0], c[1], c[2]); img.put(x + 1, y, c[0], c[1], c[2]);
    }
    // a tick every ten seconds
    if (Math.floor(t.t[k] / 10) !== Math.floor(t.t[k - 1] / 10)) {
      for (let d = -2; d <= 2; d++) { img.put(Math.round(bx) + d, Math.round(by), 235, 235, 240); img.put(Math.round(bx), Math.round(by) + d, 235, 235, 240); }
    }
  }
  const mins = (t.x.length / 10 / 60).toFixed(1);
  // The panel autoscales to the track, so the span has to be printed or two
  // pictures of different journeys read as the same journey.
  text(img, ox + 3, oy + PANEL + 4, `${mins} MIN  ${t.rocks.length} ROCKS  ${span.toFixed(0)}M ACROSS`, [170, 170, 180], 1);
});

writePNG(OUT, img);
console.log(JSON.stringify({ out: OUT, tracks: out.tracks.length, samples: out.tracks.map((t) => t.x.length) }));

#!/usr/bin/env node
/**
 * Scratch: contact sheets for the mammal cast.
 *
 *   node tools/_scratch/mammalsheet.mjs --port 5240 --out /tmp/mam/after
 *
 * Per species it writes:
 *   <key>_poses.png  — all six gallery poses in a 3x2 grid, fixed 3/4 yaw
 *   <key>_legs.png   — three close-ups of the standing fore/hind legs
 *
 * Compositing happens inside the same browser (a data-URL grid page that is
 * then screenshotted), because the repo has no image library.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const PORT = arg('port', '5240');
const OUT = arg('out', '/tmp/mam/x');
const IDS = arg('ids',
  'animal:deer:0,animal:bear:0,animal:fox:0,animal:rabbit:0,animal:squirrel:0,animal:raccoon:0,dog:0').split(',');
const POSES = arg('poses', 'stand,graze,alert,walk,trot,run').split(',');

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 760, height: 640 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${PORT}/gallery.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gallery?.entries?.length > 0, null, { timeout: 90000 });
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });
const cap = page.locator('#stagecap');

/** Select a card in a pose and park the turntable. */
async function pose(id, p) {
  await page.evaluate(async ([i, q]) => {
    const g = window.__gallery;
    const s = g.state.get(i) ?? { seed: 0, opts: {} };
    s.opts = { ...s.opts, pose: q };
    g.state.set(i, s);
    await g.select(i);
  }, [id, p]);
  await page.waitForTimeout(1100);
}

/** Home framing chosen by stage.frame(), so zooms are relative to the subject. */
const home = () => page.evaluate(() => {
  const st = window.__gallery.stage;
  return { d: st.dist, y: st.target.y, tz: st.target.z, tx: st.target.x };
});

async function view(o) {
  await page.evaluate((v) => {
    const st = window.__gallery.stage;
    st.turntable = false;
    st.yaw = v.yaw; st.pitch = v.pitch; st.dist = v.dist;
    st.target.set(v.tx, v.ty, v.tz);
  }, o);
  await page.waitForTimeout(300);
  return (await cap.screenshot()).toString('base64');
}

/** Composite tiles into one PNG via a throwaway page in the same browser. */
async function sheet(file, tiles, cols, label) {
  const p2 = await browser.newPage({ viewport: { width: 40, height: 40 }, deviceScaleFactor: 1 });
  await p2.setContent(`<body style="margin:0;background:#120f16;font:12px monospace;color:#e7d9c4">
    <div style="padding:6px 8px;font-size:15px">${label}</div>
    <div id="g" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:2px;width:${cols * 640}px">
    ${tiles.map((t) => `<figure style="margin:0;position:relative">
        <img src="data:image/png;base64,${t.img}" style="width:100%;display:block">
        <figcaption style="position:absolute;left:6px;top:4px;background:#000a;padding:2px 6px">${t.name}</figcaption>
      </figure>`).join('')}
    </div></body>`);
  await p2.waitForTimeout(250);
  const box = await p2.locator('body').boundingBox();
  await p2.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  await p2.waitForTimeout(150);
  writeFileSync(file, await p2.screenshot({ fullPage: true }));
  await p2.close();
  console.log('wrote', file);
}

for (const id of IDS) {
  const key = id.replace(/:/g, '_');

  // ── every pose, one fixed 3/4 view ────────────────────────────────────────
  const tiles = [];
  for (const p of POSES) {
    await pose(id, p);
    const h = await home();
    tiles.push({ name: p, img: await view({ yaw: 0.95, pitch: 0.18, dist: h.d, tx: h.tx, ty: h.y, tz: h.tz }) });
  }
  await sheet(`${OUT}/${key}_poses.png`, tiles, 3, `${id} — poses`);

  // ── legs, standing ────────────────────────────────────────────────────────
  await pose(id, 'stand');
  const h = await home();
  // The stage frames the whole animal; drop the target to the lower third and
  // pull in so the fore and hind legs fill the frame.
  const legY = h.y * 0.45;
  const legs = [
    { name: 'legs side', yaw: 1.57, pitch: 0.02, dist: h.d * 0.42, tx: h.tx, ty: legY, tz: h.tz },
    { name: 'legs 3/4', yaw: 0.85, pitch: 0.05, dist: h.d * 0.42, tx: h.tx, ty: legY, tz: h.tz },
    { name: 'legs front', yaw: 3.05, pitch: 0.05, dist: h.d * 0.42, tx: h.tx, ty: legY, tz: h.tz },
  ];
  const lt = [];
  for (const v of legs) lt.push({ name: v.name, img: await view(v) });
  await sheet(`${OUT}/${key}_legs.png`, lt, 3, `${id} — legs (stand)`);
}

if (errors.length) console.log('errors:', [...new Set(errors)].slice(0, 8).join('\n'));
await browser.close();

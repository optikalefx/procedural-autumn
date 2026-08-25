// Does the wing BEND across the span through the beat, or hinge?
//
// owlfly.mjs answers this in the live world and frames unreliably (its header
// says so). The gallery answers it deterministically: the glide card bakes
// aPose per-vertex with rate 0, and the shader's beat phase is
//   ph = time * rate + phase - w * 1.1
// so with rate pinned at 0 the phase column alone walks the whole downstroke
// and upstroke. Amplitude is pushed to a real flapping value rather than the
// card's glide value, because a hinge is only visible at depth.
//
//   node tools/_scratch/_owlbeat.mjs <outdir> <card-substring> [port]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/owlbeat';
const CARD = process.argv[3] ?? 'GreatHornedOwl:glide';
const PORT = process.argv[4] ?? '5193';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
await page.evaluate(() => { window.__gallery.stage.canvas.id = 'stagecap'; });
const found = await page.evaluate((c) => {
  const g = window.__gallery;
  const e = g.entries.find((x) => x.id.includes(c));
  if (!e) return null;
  g.select(e.id);
  return e.id;
}, CARD);
if (!found) { console.error(`no card matching ${CARD}`); process.exit(1); }
console.log('card:', found);
await page.waitForTimeout(700);

for (let i = 0; i < 8; i++) {
  const ph = (i / 8) * Math.PI * 2;
  await page.evaluate((v) => {
    const st = window.__gallery.stage;
    st.turntable = false; st.yaw = v.yaw; st.pitch = 0.30; st.dist = 3.0;
    st.scene.traverse((o) => {
      const a = o.isMesh && o.geometry && o.geometry.getAttribute('aPose');
      if (!a) return;
      for (let k = 0; k < a.count; k++) {
        a.setX(k, v.ph);        // phase
        a.setY(k, 0);           // rate 0 — the phase column IS the clock
        a.setZ(k, 1.15);        // amplitude, rad at the tip
        a.setW(k, 0);           // spread
      }
      a.needsUpdate = true;
    });
  }, { ph, yaw: 0.35 });
  await page.waitForTimeout(220);
  await page.locator('#stagecap').screenshot({ path: `${OUT}/beat-${i}.png` });
}
console.log(`${OUT}/beat-*.png`);
await browser.close();

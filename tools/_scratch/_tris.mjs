import { chromium } from 'playwright';
const PORT = process.argv[2] ?? '5193';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
await page.goto(`http://127.0.0.1:${PORT}/gallery.html`);
await page.waitForFunction(() => window.__gallery?.entries?.length > 0);
const out = await page.evaluate(async () => {
  const g = window.__gallery;
  const res = [];
  for (const name of ['GreatHornedOwl:perched', 'BaldEagle:perched', 'BlueHeron', 'Flamingo']) {
    const e = g.entries.find((x) => x.id.includes(name));
    if (!e) { res.push([name, 'MISSING']); continue; }
    g.select(e.id);
    await new Promise(r => setTimeout(r, 500));
    let t = 0, v = 0;
    g.stage.scene.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const p = o.geometry.getAttribute('position');
        if (!p) return;
        const n = o.geometry.index ? o.geometry.index.count : p.count;
        t += n / 3; v += p.count;
      }
    });
    res.push([e.id, t, v]);
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:1400,height:900}});
await p.goto('http://127.0.0.1:5199/gallery.html', {waitUntil:'load', timeout:120000});
await p.waitForTimeout(9000);
const r = await p.evaluate(async () => {
  const M = await import('/src/journal/journal_model.js');
  const g = M.buildJournal(() => 0.5, { colorway: 0, open: 0 });
  g.updateMatrixWorld(true);
  const rows = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox.clone().applyMatrix4(o.matrixWorld);
    rows.push([o.material?.name || o.geometry.type, +bb.min.x.toFixed(4), +bb.max.x.toFixed(4),
      +bb.min.y.toFixed(4), +bb.max.y.toFixed(4), o.visible]);
  });
  rows.sort((a, c) => a[1] - c[1]);
  return rows;
});
for (const x of r) console.log(x.join('  '));
await b.close();

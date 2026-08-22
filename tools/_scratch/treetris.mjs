// Triangle budget per prototype per LOD, and what a different mid decimation
// would cost. Read straight off the built geometries in the page.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL || 'http://127.0.0.1:5204';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 320, height: 240 } });
p.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
await p.goto(`${URL}/?res=512`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 300 });
const out = await p.evaluate(() => {
  const t = window.__systems.trees;
  const rows = [];
  for (let si = 0; si < t.protos.length; si++) {
    for (let vi = 0; vi < t.protos[si].length; vi++) {
      const pr = t.protos[si][vi];
      const tri = (g) => (g ? g.index.count / 3 : 0);
      rows.push({
        si, vi,
        nearBark: tri(pr.near.bark), nearLeaf: tri(pr.near.leaf),
        midBark: tri(pr.mid?.bark), midLeaf: tri(pr.mid?.leaf),
        clumps: pr.tree.clusters.length,
        strands: pr.tree.strands.length,
        byLevel: pr.tree.strands.reduce((a, s) => { a[s.level] = (a[s.level] || 0) + 1; return a; }, {}),
      });
    }
  }
  return { rows, stats: t.stats };
});
for (const r of out.rows) {
  console.log(`s${r.si}v${r.vi} nearBark ${String(r.nearBark).padStart(6)} nearLeaf ${String(r.nearLeaf).padStart(5)}` +
    ` | midBark ${String(r.midBark).padStart(5)} midLeaf ${String(r.midLeaf).padStart(5)}` +
    ` | strands ${r.strands} by level ${JSON.stringify(r.byLevel)}`);
}
console.log('stats', JSON.stringify(out.stats));
await b.close();

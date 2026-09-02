import { chromium } from 'playwright';
const URL = (process.env.AUTUMN_URL || 'http://localhost:5178') + '?seed=20261018&car=camper';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => {
  const t = m.text();
  if (/glb_rig|wildlife|moose/i.test(t)) console.log('[page]', t.slice(0, 400));
});
await p.goto(URL, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });
const out = await p.evaluate(async () => {
  const { SPECIES } = await import('/src/wildlife/animal_species.js');
  const wl = window.__systems.wildlife;
  const S = wl.sites;
  const ki = wl.keys.indexOf('moose');
  const sites = [];
  for (let i = 0; i < S.n; i++) if (S.spec[i] === ki) sites.push({ x: +S.x[i].toFixed(1), z: +S.z[i].toFixed(1), line: !!S.lines[i], depth: +window.__world.getWaterDepth(S.x[i], S.z[i]).toFixed(3) });
  const dists = [];
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++)
    dists.push(Math.round(Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z)));
  const proto = wl.protos?.moose?.[0];
  return {
    gait: SPECIES.moose.gait,
    fit: proto?.fit, minY: proto?.minY, size: proto?.size,
    stride: proto?.stride, speed: proto?.speed,
    sites, dists, totalSites: S.n,
    perSpecies: wl.keys.map((k, i) => { let c = 0; for (let q = 0; q < S.n; q++) if (S.spec[q] === i) c++; return `${k}:${c}`; }).join(' '),
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();

// The mystery leaf's own canvas, straight to a PNG — no renderer, no lighting,
// no page curl. The one thing worth looking at here is whether the entry, the
// checkbox, the ring and the paw land where they are supposed to on the paper.
//   AUTUMN_URL=http://127.0.0.1:5245 node tools/_scratch/bfleaf.mjs --out /tmp/leaf.png
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
await acquire('bfleaf');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 500, height: 300 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, pr) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
        removeEventListener() {}, set onopen(_) {}, set onclose(_) {}, set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, pr);
  };
  window.WebSocket.prototype = R.prototype;
  Object.assign(window.WebSocket, R);
});
await p.goto((process.env.AUTUMN_URL || 'http://127.0.0.1:5245') + '/?hunt=18');
await p.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 300 });

const out = await p.evaluate(async ({ want, frames }) => {
  const j = window.__ctx.systems.hud.journal;
  const t0 = Date.now();
  while (!j._ready && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 200));
  window.__dbg.sheet(18);
  if (want === 'ringed') window.__hunt.setTracked('bigfoot');
  if (want === 'won') window.__hunt.award('bigfoot');
  await j._decorate({ force: true });
  // `won` renders the FACING leaf — the stamp's page — instead of the entry.
  const idx = want === 'won' ? j._mysteryPage - 1 : j._mysteryPage;
  const page = j._pages[idx];
  const row = page.spec.rows?.[0];
  // `frames` steps the LANDING: the page is repainted un-stamped so the clean
  // copy has no ink in it, then `stampAt` is run at each t, exactly as the
  // ceremony's beat drives it.
  if (frames?.length) {
    page.spec.stamp = false;
    page.paint();
    const shots = [];
    for (const t of frames) { page.stampAt(t); shots.push([t, page.canvas.toDataURL('image/png')]); }
    return { shots, page: idx };
  }
  return { png: page.canvas.toDataURL('image/png'), page: idx, kind: page.spec.kind,
           stamp: page.spec.stamp ?? null,
           row: row ? { track: row.track, target: row.target } : null,
           open: page.spec.open ?? null };
}, { want: arg('state', 'ringed'),
     frames: (arg('frames', '') || '').split(',').filter(Boolean).map(Number) });

const base = arg('out', '/tmp/leaf.png');
if (out.shots) {
  for (const [t, png] of out.shots) {
    const f = base.replace(/\.png$/, `-t${String(t).replace('.', '')}.png`);
    writeFileSync(f, Buffer.from(png.split(',')[1], 'base64'));
    console.log('wrote', f);
  }
} else {
  console.log(JSON.stringify({ row: out.row, open: out.open }));
  writeFileSync(base, Buffer.from(out.png.split(',')[1], 'base64'));
  console.log('wrote', base);
}
await b.close();

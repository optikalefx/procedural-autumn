#!/usr/bin/env node
// Exact-colour mode + RGB ratio report. Answers the critic's two measurements
// directly: is one hex covering a huge share of the frame, and what is the
// mean R:G:B ratio of the chromatic mass?
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
for (const f of files) {
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async ({ b64, ext }) => {
    const img = new Image(); img.src = `data:image/${ext};base64,${b64}`; await img.decode();
    const W = 480, H = Math.max(1, Math.round((img.height / img.width) * W));
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const counts = new Map();
    let sr = 0, sg = 0, sb = 0, n = 0, cn = 0, cr = 0, cg = 0, cb = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i+1], B = d[i+2];
      const k = (R << 16) | (G << 8) | B;
      counts.set(k, (counts.get(k) || 0) + 1);
      sr += R; sg += G; sb += B; n++;
      const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
      if ((mx - mn) / 255 > 0.10) { cr += R; cg += G; cb += B; cn++; }
    }
    const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([k,v]) => ({ hex: '#' + k.toString(16).padStart(6,'0'), pct: +(100*v/n).toFixed(2) }));
    const ratio = (r,g,b) => `1 : ${(g/r).toFixed(2)} : ${(b/r).toFixed(2)}`;
    return {
      top,
      meanRGB: [sr/n, sg/n, sb/n].map(v=>Math.round(v)),
      meanRatio: ratio(sr, sg, sb),
      chromaticRatio: cn ? ratio(cr, cg, cb) : 'n/a',
      chromaticPct: +(100*cn/n).toFixed(1),
    };
  }, { b64, ext });
  console.log(basename(f).padEnd(28), 'mean', JSON.stringify(r.meanRGB), '| all', r.meanRatio, '| chromatic', r.chromaticRatio, `(${r.chromaticPct}%)`);
  console.log('   modes:', r.top.map(t=>`${t.hex} ${t.pct}%`).join('  '));
}
await browser.close();

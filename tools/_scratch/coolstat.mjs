import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
for (const f of files) {
  const b = readFileSync(f).toString('base64');
  const ext = f.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  const r = await page.evaluate(async ({ b, ext }) => {
    const img = new Image(); img.src = `data:image/${ext};base64,${b}`; await img.decode();
    const W = 800, H = Math.round(img.height / img.width * W);
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let n = 0, sr = 0, sg = 0, sb = 0, sc = 0, tot = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i+1], B = d[i+2]; tot++;
      if (B > R + 6 && B > G + 2) { n++; sr += R; sg += G; sb += B; sc += (Math.max(R,G,B)-Math.min(R,G,B))/255; }
    }
    if (!n) return 'no blue-led pixels';
    const r = sr/n, gg = sg/n, bb = sb/n;
    return `blue-led ${(100*n/tot).toFixed(1)}% mean srgb(${r.toFixed(0)},${gg.toFixed(0)},${bb.toFixed(0)}) luma ${((0.2126*r+0.7152*gg+0.0722*bb)/255).toFixed(3)} chroma ${(sc/n).toFixed(3)}`;
  }, { b, ext });
  console.log(f.padEnd(46), r);
}
await browser.close();

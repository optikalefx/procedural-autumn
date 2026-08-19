import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, cols = '10', rows = '6'] = process.argv.slice(2);
const b = readFileSync(file).toString('base64');
const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const out = await page.evaluate(async ({ b, ext, C, R }) => {
  const img = new Image(); img.src = `data:image/${ext};base64,${b}`; await img.decode();
  const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const lines = [];
  for (let j = 0; j < R; j++) {
    let line = '';
    for (let i = 0; i < C; i++) {
      const d = g.getImageData(Math.round(i * img.width / C), Math.round(j * img.height / R),
        Math.max(1, Math.round(img.width / C)), Math.max(1, Math.round(img.height / R))).data;
      let r = 0, gg = 0, bb = 0, n = 0;
      for (let k = 0; k < d.length; k += 4) { r += d[k]; gg += d[k+1]; bb += d[k+2]; n++; }
      r = Math.round(r/n); gg = Math.round(gg/n); bb = Math.round(bb/n);
      const L = ((0.2126*r + 0.7152*gg + 0.0722*bb) / 255).toFixed(2);
      const lead = bb > r && bb > gg ? 'B' : (gg > r ? 'G' : 'R');
      line += `${lead}${L.slice(1)} ${String(r).padStart(3)},${String(gg).padStart(3)},${String(bb).padStart(3)} | `;
    }
    lines.push(line);
  }
  return lines;
}, { b, ext, C: +cols, R: +rows });
console.log(file); out.forEach((o) => console.log(o));
await browser.close();

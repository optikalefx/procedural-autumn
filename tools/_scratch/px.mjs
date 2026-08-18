// Sample named pixels from an image, in fractional coordinates.
//   node tools/_scratch/px.mjs img.png 0.5,0.3,name 0.2,0.4,other
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, ...pts] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 32, height: 32 } });
const ext = file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
const b64 = readFileSync(file).toString('base64');
const out = await page.evaluate(async ({ b64, ext, pts }) => {
  const img = new Image(); img.src = `data:image/${ext};base64,${b64}`; await img.decode();
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const res = [`${img.width}x${img.height}`];
  for (const s of pts) {
    const [fx, fy, name] = s.split(',');
    const x = Math.round(parseFloat(fx) * img.width), y = Math.round(parseFloat(fy) * img.height);
    const i = (y * img.width + x) * 4;
    res.push(`${(name || '').padEnd(14)} (${x},${y})  ${d[i]} ${d[i+1]} ${d[i+2]}`);
  }
  return res;
}, { b64, ext, pts });
console.log(file); console.log(out.join('\n'));
await browser.close();

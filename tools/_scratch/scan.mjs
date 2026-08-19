// Column scan: print mean colour of a 1-px-wide column strip across a band.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [file, band, x0, x1, step] = process.argv.slice(2);
const [by, bh] = band.split(',').map(Number);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 32, height: 32 } });
const data = 'data:image/' + (file.endsWith('.png')?'png':'jpeg') + ';base64,' + readFileSync(file).toString('base64');
const out = await p.evaluate(async ({ data, by, bh, x0, x1, step }) => {
  const img = new Image(); img.src = data; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const rows = [];
  for (let x = x0; x <= x1; x += step) {
    const d = g.getImageData(x, by, 1, bh).data;
    let R=0,G=0,B=0,n=0; for (let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];n++;}
    rows.push(`x=${x} srgb(${(R/n).toFixed(0)},${(G/n).toFixed(0)},${(B/n).toFixed(0)})`);
  }
  return rows;
}, { data, by, bh, x0: +x0, x1: +x1, step: +step });
console.log(out.join('  |  '));
await b.close();

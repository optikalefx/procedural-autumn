// Stack the before/after strips of one clip into a single comparison image.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const clips = process.argv.slice(2);
const b64 = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
for (const clip of clips) {
  const out = await page.evaluate(async ({ a, b, clip }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height * 2 + 34;
    const g = c.getContext('2d');
    g.fillStyle = '#8fb6d8'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(ia, 0, 26);
    g.drawImage(ib, 0, ia.height + 34);
    g.fillStyle = '#1a1414'; g.font = 'bold 18px sans-serif';
    g.fillText(`${clip} — BEFORE (hand-authored)`, 10, 19);
    g.fillText(`${clip} — AFTER (pack clips retargeted)`, 10, ia.height + 30);
    return c.toDataURL('image/png');
  }, { a: b64(`shots/fox_before/${clip}.png`), b: b64(`shots/fox_after/${clip}.png`), clip });
  writeFileSync(`shots/fox_cmp_${clip}.png`, Buffer.from(out.split(',')[1], 'base64'));
  console.log('wrote', `shots/fox_cmp_${clip}.png`);
}
await browser.close();

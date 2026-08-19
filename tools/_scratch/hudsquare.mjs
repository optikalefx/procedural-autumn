// Composited-frame black-rectangle hunt.
//
// Every existing tool for this defect reads the WebGL drawing buffer with
// gl.readPixels. That buffer is the *scene*; it is not what the player sees.
// The HUD is DOM, composited on top of the canvas by the browser, so a black
// rectangle that comes from the DOM layer is invisible to readPixels by
// construction. This captures the compositor output (CDP screencast) instead.
//
// It also differs from screencast.mjs in the three ways that matter: it can sit
// still (the player was stationary), it can force the HUD visible, and it looks
// for a *rectangle* rather than a mostly-black frame.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);

const PORT = arg('port', '5178');
const SECONDS = parseFloat(arg('seconds', '40'));
const W = parseInt(arg('w', '2000'), 10), H = parseInt(arg('h', '1100'), 10);
const RES = arg('res', '1536');
const OUT = arg('out', '/tmp/hudsquare');
const HUD = !has('nohud');
const DRIVE = has('drive');

await acquire('perf');
const browser = await chromium.launch({ headless: !has('headed'), args: [
  '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const helper = await browser.newPage();
await helper.goto('about:blank');
page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).slice(0, 200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`), () => {});
await page.goto(`http://127.0.0.1:${PORT}/?res=${RES}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.waitForTimeout(1500);

if (!HUD) await page.evaluate(() => { const h = document.getElementById('pa-hud'); if (h) h.style.display = 'none'; });
if (has('noblur')) await page.evaluate(() => { const s = document.createElement('style');
  s.textContent = '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}'; document.head.appendChild(s); });
const pre = arg('eval', null);
if (pre) await page.evaluate((src) => eval(src), pre);

await page.evaluate((drive) => {
  const ctx = window.__ctx, input = ctx.input; const t0 = performance.now();
  window.__hunt = true;
  const tick = () => { if (!window.__hunt) return;
    const t = (performance.now() - t0) / 1000;
    if (drive) { input.axes.throttle = 1; input.axes.brake = 0; input.axes.steer = Math.sin(t * 0.42) * 0.75; }
    else { input.axes.throttle = 0; input.axes.brake = 1; input.axes.steer = 0; }
    requestAnimationFrame(tick); };
  tick();
}, DRIVE);

// The player had a mouse over the canvas; hover state is part of the repro.
let mouseAlive = true;
(async () => { let i = 0;
  while (mouseAlive) { i++;
    try { await page.mouse.move(W * (0.3 + 0.4 * Math.abs(Math.sin(i * 0.3))), H * (0.3 + 0.4 * Math.abs(Math.cos(i * 0.21)))); } catch { break; }
    await new Promise((r) => setTimeout(r, 120)); }
})();

await page.bringToFront();
const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async (p) => { frames.push(p.data);
  try { await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }); } catch { /* closing */ } });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 500, maxHeight: 275, everyNthFrame: 1 });
await page.waitForTimeout(SECONDS * 1000);
await cdp.send('Page.stopScreencast');
mouseAlive = false;
await page.evaluate(() => { window.__hunt = false; });

console.log(`composited frames captured: ${frames.length}  (port ${PORT}, hud=${HUD}, drive=${DRIVE}, ${W}x${H})`);

const res = [];
const CHUNK = 300;
for (let s = 0; s < frames.length; s += CHUNK) {
  const part = await helper.evaluate(async ({ list, off }) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const b = await fetch('data:image/jpeg;base64,' + list[i]).then((r) => r.blob());
      const img = await createImageBitmap(b);
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      const IW = img.width, IH = img.height;
      let dark = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
        const j = (y * IW + x) * 4;
        if ((d[j] + d[j + 1] + d[j + 2]) / 3 < 24) {
          dark++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      const frac = dark / (IW * IH);
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const fill = dark / Math.max(1, bw * bh);
      out.push({ i: i + off, frac: +frac.toFixed(4),
        box: x1 < 0 ? null : [+(x0 / IW).toFixed(3), +(y0 / IH).toFixed(3), +(bw / IW).toFixed(3), +(bh / IH).toFixed(3)],
        fill: +fill.toFixed(2), w: IW, h: IH });
    }
    return out;
  }, { list: frames.slice(s, s + CHUNK), off: s });
  res.push(...part);
}

// A rectangle, not a dark frame: solidly filled, at least 0.5% of the picture,
// and not the whole picture going out.
const bad = res.filter((r) => r.box && r.fill > 0.8 && r.frac > 0.005 && r.frac < 0.85);
mkdirSync(OUT, { recursive: true });
for (const b of bad.slice(0, 8)) writeFileSync(`${OUT}/black-${b.i}.jpg`, Buffer.from(frames[b.i], 'base64'));
const ok = res.find((r) => r.frac < 0.02);
if (ok) writeFileSync(`${OUT}/ok-${ok.i}.jpg`, Buffer.from(frames[ok.i], 'base64'));

console.log(`black rectangles: ${bad.length} / ${res.length} frames  (${(100 * bad.length / Math.max(1, res.length)).toFixed(2)}%)`);
for (const b of bad.slice(0, 10)) console.log('   ', JSON.stringify(b));
const worst = res.slice().sort((a, b2) => b2.frac - a.frac).slice(0, 4);
console.log('darkest frames seen:'); for (const w of worst) console.log('   ', JSON.stringify(w));
await browser.close();

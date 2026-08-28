// Where every box in the photo rail actually is. Eyeballing a scaled capture
// cannot tell an 18 px misalignment from a JPEG-ish artefact; getBoundingClientRect can.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const W = +arg('w', 1600), H = +arg('h', 900);
const HMR = () => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} };
    }
    return new R(u, p);
  };
};
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: W, height: H },
  ...(argv.includes('--touch') ? { hasTouch: true, isMobile: true } : {}) });
await page.addInitScript(HMR);
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).split('\n')[0]));
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
await page.waitForTimeout(1000);
await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
await page.waitForTimeout(2000);
const rows = await page.evaluate(() => {
  const out = [];
  const r = (sel, label) => {
    document.querySelectorAll(sel).forEach((n, i) => {
      const b = n.getBoundingClientRect();
      out.push({ what: `${label}${i ? `#${i}` : ''}`,
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        text: (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) });
    });
  };
  r('.pa-rail', 'rail');
  r('.pa-cam-readout', 'readout');
  r('.pa-cam-desk', 'desk');
  r('.pa-cam-group', 'group');
  r('.pa-cam-title', 'title');
  r('.pa-lens', 'lens');
  r('.pa-lens canvas', 'canvas');
  r('.pa-cam-rings', 'rings');
  r('.pa-cam-verbs', 'verbs');
  r('.pa-cam-gestures', 'gestures');
  // Nothing may hang outside the panel, at any width.
  const rail = document.querySelector('.pa-rail').getBoundingClientRect();
  for (const n of document.querySelectorAll('.pa-rail *')) {
    const b = n.getBoundingClientRect();
    if (b.width && (b.left < rail.left - 0.5 || b.right > rail.right + 0.5
                    || b.top < rail.top - 0.5 || b.bottom > rail.bottom + 0.5)) {
      out.push({ what: 'OVERFLOW', x: Math.round(b.x), y: Math.round(b.y),
                 w: Math.round(b.width), h: Math.round(b.height),
                 text: n.className + ' ' + (n.textContent || '').slice(0, 16) });
    }
  }
  return { rows: out, vw: innerWidth, vh: innerHeight,
    fontPx: getComputedStyle(document.getElementById('pa-hud')).fontSize };
});
console.log(`viewport ${rows.vw}x${rows.vh}   hud font ${rows.fontPx}`);
for (const o of rows.rows) {
  console.log(`  ${o.what.padEnd(12)} x${String(o.x).padStart(5)} y${String(o.y).padStart(5)}` +
              ` ${String(o.w).padStart(4)}x${String(o.h).padStart(4)}  ${o.text}`);
}
await b.close();

// Photo mode's interface, at the three window shapes it has to survive.
//
//   node tools/_scratch/_photoui.mjs --dir /tmp/photoui/before
//
// One page load, three viewports, a screenshot of each — plus the grid on and
// the readout's live text, because the whole point of the redesign is that the
// instrument panel never hides.
//
// The HMR stub is not optional: a peer saving a file mid-run reloads the page
// and the shot lands on the boot screen. `--use-gl=angle --use-angle=metal` is
// not optional either — without it the page runs under 1 fps and screenshots
// the pose it booted at. Both traps are documented in AGENTS.md.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const OUT = arg('dir', '/tmp/photoui');
const TOUCH = argv.includes('--touch');
mkdirSync(OUT, { recursive: true });

const SIZES = [
  ['1600x900', 1600, 900],
  ['1280x720', 1280, 720],
  ['phone-390x844', 390, 844],
];

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
for (const [name, w, h] of SIZES) {
  const page = await b.newPage({
    viewport: { width: w, height: h },
    ...(TOUCH ? { hasTouch: true, isMobile: true } : {}),
  });
  await page.addInitScript(HMR);
  page.on('console', (m) => { if (m.type() === 'error' && !/POSTHOG/i.test(m.text())) console.log(`  [err ${name}]`, m.text()); });
  page.on('pageerror', (e) => console.log(`  [pageerror ${name}]`, String(e).split('\n')[0]));
  await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__systems.hud.togglePhoto(); });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const st = await page.evaluate(() => {
    const p = window.__systems.hud.photo;
    const f = document.querySelector('.pa-focus');
    return {
      lens: p.lens.lens.id, focal: +p.lens.focal.toFixed(1), fStop: p.focus.fStop,
      dist: +p.focus.distance.toFixed(2),
      readoutVisible: !!f && getComputedStyle(f).opacity !== '0',
      readout: f ? f.textContent.replace(/\s+/g, ' ').trim() : null,
    };
  });
  console.log(name, JSON.stringify(st));
  await page.close();
}
await b.close();

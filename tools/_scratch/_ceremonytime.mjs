// "The page turning sound takes over the book opening sound." Measure WHEN each
// cue fires in a real ceremony, and how loud each is when it does.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const R = window.WebSocket;
  window.WebSocket = function (u, p) {
    if (typeof u === 'string' && /[?&]token=|vite-hmr|__vite/.test(u)) {
      return { readyState: 3, url: u, close() {}, send() {}, addEventListener() {},
               removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
               set onerror(_) {}, set onmessage(_) {} }; }
    return new R(u, p); };
});
await page.goto(`${URL}/?seed=20261018&car=camper`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await sleep(500);
  const audio = window.__systems.audio;
  const ja = audio._journal;
  if (!ja) return { err: 'journal voices not built' };
  const t0 = performance.now();
  const fired = [];
  const real = ja.cue.bind(ja);
  ja.cue = (name, opts) => {
    // `c.level` is the crowd ducking applied at fire time; sample it.
    const lvl = ja._crowd ? ja._crowd() : 1;
    fired.push({ name, at: +(performance.now() - t0).toFixed(0), crowdLevel: +lvl.toFixed(3) });
    return real(name, opts);
  };
  const store = await import('/src/game/hunt_store.js');
  localStorage.removeItem('pa.hunt');
  const c = document.createElement('canvas'); c.width = 1024; c.height = 576;
  c.getContext('2d').fillStyle = '#48f'; c.getContext('2d').fillRect(0, 0, 1024, 576);
  store.hunt.award('deer', c);
  await sleep(150);
  window.__systems.hud.openJournal({ id: 'deer', photoDataURL: store.hunt.photoFor('deer') });
  await sleep(5000);
  return { fired, coverDurationS: ja._cover ? +ja._cover.duration.toFixed(2) : null };
});
console.log(JSON.stringify(out, null, 1));
if (out.fired) {
  const cover = out.fired.find((f) => f.name === 'cover');
  const page1 = out.fired.find((f) => f.name === 'page');
  if (cover && page1) {
    const gap = page1.at - cover.at;
    console.log(`\ncover at ${cover.at} ms, first page at ${page1.at} ms -> gap ${gap} ms`);
    console.log(`the cover recording is ${out.coverDurationS} s long, so the page starts`
      + ` ${gap < out.coverDurationS * 1000 ? 'WHILE THE COVER IS STILL SOUNDING' : 'after it'}`);
  }
}
await b.close();

// My verification rendered offline after awaiting loadSamples(). The GAME does
// not await anything. Which path does the FIRST cover cue actually take?
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
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
  const audio = window.__systems.audio;
  // Start the audio system the way a click does.
  // The gate at the top of `Audio.cue` is `if (!this.started) return`, and
  // `started` is set by the gesture handler. Headless there is no gesture, so
  // fire one — without this the harness proves nothing but that the gate works.
  window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await sleep(400);
  try { await audio.actx?.resume?.(); } catch {}
  const log = [];
  const watch = () => {
    const ja = audio._journal;
    if (!ja) return { built: false };
    const real = ja._sampledCover.bind(ja);
    ja._sampledCover = (c) => { log.push('SAMPLE'); return real(c); };
    return { built: true, coverLoaded: !!ja._cover };
  };
  const before = { journalBuiltYet: !!audio._journal };
  // The very first cover cue — exactly what opening the book does.
  audio.cue('cover');
  const justAfter = { journalBuilt: !!audio._journal, coverLoaded: !!audio._journal?._cover };
  watch();
  await sleep(1500);
  const later = { coverLoaded: !!audio._journal?._cover };
  audio.cue('cover');            // a second open, after the fetch has landed
  await sleep(100);
  return { before, justAfter, later, sampledCalls: log.length };
});
console.log(JSON.stringify(out, null, 1));
console.log(out.justAfter.coverLoaded
  ? 'first cue had the buffer'
  : 'FIRST CUE HAD NO BUFFER -> it played the synth');
console.log(`second cue took the sample path: ${out.sampledCalls > 0}`);
await b.close();

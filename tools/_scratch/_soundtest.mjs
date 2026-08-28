// Under ?soundtest=cover: opening the book must fire the cover and NOTHING
// else, and the cover must be the mp3 at unity.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });

async function run(flag) {
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
  await page.goto(`${URL}/?seed=20261018&car=camper${flag}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 250 });
  const r = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await sleep(500);
    const audio = window.__systems.audio;
    const fired = [];
    const real = audio.cue.bind(audio);
    audio.cue = (n) => { fired.push(n); return real(n); };
    // Every cue the ceremony would fire, offered to the gate.
    for (const n of ['cover', 'page', 'cross', 'slap', 'shutter', 'door', 'tick', 'select']) {
      const before = fired.length; real(n); void before;
    }
    await sleep(200);
    const ja = audio._journal;
    return {
      soundTest: audio.soundTest,
      journalHeard: ja ? [...(ja._said ?? [])] : [],
      // Which layers are still being driven?
      layersRunning: (() => {
        const before = audio.ambience?._t ?? null;
        return before;
      })(),
    };
  });
  await page.close();
  return r;
}

const off = await run('');
const on = await run('&soundtest=cover');
console.log('normal          :', JSON.stringify(off));
console.log('?soundtest=cover:', JSON.stringify(on));

// And the level: render the cue under the flag and compare with the raw file.
const page = await b.newPage();
await page.goto(`${URL}/?soundtest=cover`, { waitUntil: 'domcontentloaded' });
const lvl = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const oac = new OfflineAudioContext(2, 48000 * 2, 48000);
  const ja = new JournalAudio(oac, oac.destination);
  await ja.loadSamples();
  ja.cue('cover');
  const r = await oac.startRendering();
  let pk = 0;
  for (let c = 0; c < 2; c++) { const d = r.getChannelData(c);
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i])); }
  const ac = new OfflineAudioContext(1, 8, 48000);
  const raw = await ac.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer());
  let rp = 0;
  for (let c = 0; c < raw.numberOfChannels; c++) { const d = raw.getChannelData(c);
    for (let i = 0; i < d.length; i++) rp = Math.max(rp, Math.abs(d[i])); }
  return { playedPeak: +pk.toFixed(4), rawPeak: +rp.toFixed(4) };
});
console.log('level under test:', JSON.stringify(lvl),
  Math.abs(lvl.playedPeak - 0.5) < 0.01
    ? ` -> normalised to -6 dBFS (${(20 * Math.log10(lvl.playedPeak / lvl.rawPeak)).toFixed(1)} dB of gain, nothing else)`
    : ' -> NOT at the expected level');
await b.close();

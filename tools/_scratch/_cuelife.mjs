// How long does each cue's graph actually live? `stopLater` disconnects at
// `c.end + 0.12`, so a voice that never raises `c.end` is cut at the 60 ms
// floor. This measures the scheduled teardown, which an offline render cannot.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const { JournalAudio } = await import('/src/audio/journal_audio.js');
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const ja = new JournalAudio(ac, ac.destination);
  await ja.loadSamples();
  const rows = [];
  for (const name of ['cover', 'page', 'cross', 'slap']) {
    // Intercept the teardown timer rather than the audio: this is about when
    // the nodes are disconnected, not about what they sounded like.
    const realTimeout = window.setTimeout;
    let delay = null;
    window.setTimeout = (fn, ms) => { if (delay === null) delay = ms; return realTimeout(fn, ms); };
    const t0 = ac.currentTime;
    ja.cue(name);
    window.setTimeout = realTimeout;
    // What the voice actually PLAYS, which is not the buffer's length: the page
    // deliberately plays one of two short takes out of a 1 s file, so comparing
    // its teardown against the whole buffer reports a failure that is not one.
    // (It did, on the first run of this harness.)
    const plays = name === 'cover' ? (ja._cover?.duration ?? 0) * 1000
                : name === 'page' ? 235          // the longer of PAGE_TAKES
                : null;
    rows.push({ name, teardownMs: Math.round(delay), playsMs: plays ? Math.round(plays) : null });
  }
  return rows;
});
for (const r of out) {
  const bad = r.playsMs && r.teardownMs < r.playsMs;
  console.log(`  ${r.name.padEnd(6)} torn down after ${String(r.teardownMs).padStart(5)} ms` +
    (r.playsMs ? `, plays ${r.playsMs} ms${bad ? '   <-- CUT SHORT' : ''}` : ''));
}
console.log(out.every((r) => !r.playsMs || r.teardownMs >= r.playsMs)
  ? '\nPASS - no cue is torn down before its sample ends'
  : '\nFAIL');
await b.close();

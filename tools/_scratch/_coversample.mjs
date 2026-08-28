// What is in journal.mp3? Duration, takes (page.mp3 turned out to be two, with
// room tone between), peak, and what gain puts it where the synthesised cover
// sits in the ladder — including through the 4th-order 200 Hz high-pass, which
// is the check that decides the ordering.
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(await (await fetch('/audio/journal.mp3')).arrayBuffer());
  const sr = buf.sampleRate, n = buf.length;
  const ch = buf.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / ch;
  }
  // 10 ms rms envelope, and the runs of near-silence that separate takes.
  const W = Math.round(sr * 0.01);
  const env = [];
  for (let i = 0; i + W <= n; i += W) {
    let s = 0; for (let k = i; k < i + W; k++) s += mono[k] * mono[k];
    env.push(Math.sqrt(s / W));
  }
  const peak = Math.max(...Array.from(mono, Math.abs));
  const FLOOR = peak * 0.02;
  const takes = [];
  let run = null;
  env.forEach((v, i) => {
    if (v > FLOOR) { run ??= i; }
    else if (run !== null && i - run > 3) { takes.push([run * 0.01, i * 0.01]); run = null; }
    else if (run !== null && i - run <= 3) { run = null; }
  });
  if (run !== null) takes.push([run * 0.01, env.length * 0.01]);
  // Merge takes separated by under 60 ms — that is a gap inside one gesture.
  const merged = [];
  for (const t of takes) {
    const last = merged[merged.length - 1];
    if (last && t[0] - last[1] < 0.06) last[1] = t[1]; else merged.push([...t]);
  }
  // The full envelope, printed — the take detector uses a 2% floor and a floor
  // is exactly the thing that hides a quiet tail. Look at the whole second.
  const bars = env.map((v, i) => {
    const db = v > 0 ? 20 * Math.log10(v / peak) : -99;
    return { t: +(i * 0.01).toFixed(2), rms: +v.toFixed(5), dbFromPeak: +db.toFixed(1) };
  });
  // Noise floor: the quietest tenth of the file.
  const sorted = [...env].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  return {
    sampleRate: sr, channels: ch, duration: +(n / sr).toFixed(3),
    peak: +peak.toFixed(4),
    noiseFloorRms: +floor.toFixed(6),
    peakToFloorDb: +(20 * Math.log10(peak / Math.max(floor, 1e-9))).toFixed(1),
    takes: merged.map(([a, z]) => [+a.toFixed(3), +z.toFixed(3), `${Math.round((z - a) * 1000)}ms`]),
    envPeakAt: +(env.indexOf(Math.max(...env)) * 0.01).toFixed(2),
    // Every 20 ms, so the shape is readable in a terminal.
    shape: bars.filter((_, i) => i % 2 === 0).map((x) => `${x.t}:${x.dbFromPeak}`).join(' '),
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();

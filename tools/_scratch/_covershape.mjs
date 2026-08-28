// Find a chain that gives journal.mp3 the BODY the synthesised cover had,
// without letting its two transients dominate. Targets, from the ladder:
//   rms  ~= 0.0379 (the synth cover's, over the sounding window)
//   peak <= 0.184  (the slap's — the slap must stay the loudest beat)
//   hp200 between the page (0.112) and the slap (0.136)
import { chromium } from 'playwright';
const URL = process.env.AUTUMN_URL ?? 'http://127.0.0.1:5199';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await b.newPage();
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async () => {
  const src = await (await fetch('/audio/journal.mp3')).arrayBuffer();
  const hp = (x, sr, f0, Q = 0.7071) => {
    const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * Q);
    const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = (1 + cs) / 2;
    const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
    const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = (b0/a0)*x[i] + (b1/a0)*x1 + (b2/a0)*x2 - (a1/a0)*y1 - (a2/a0)*y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y;
  };
  const stat = (mono) => {
    const peak = Math.max(...Array.from(mono, Math.abs));
    const gate = peak * 0.01; let s = 0, n = 0;
    for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > gate) { s += mono[i]*mono[i]; n++; }
    const rms = n ? Math.sqrt(s / n) : 0;
    return { peak, rms, crest: 20 * Math.log10(peak / Math.max(rms, 1e-9)) };
  };

  const run = async ({ shelfF, shelfDb, thr, ratio, knee, atk, rel, g }) => {
    const oac = new OfflineAudioContext(2, 48000 * 1.2, 48000);
    const buf = await oac.decodeAudioData(src.slice(0));
    const s = oac.createBufferSource(); s.buffer = buf;
    const sh = oac.createBiquadFilter();
    sh.type = 'highshelf'; sh.frequency.value = shelfF; sh.gain.value = shelfDb;
    const comp = oac.createDynamicsCompressor();
    comp.threshold.value = thr; comp.ratio.value = ratio; comp.knee.value = knee;
    comp.attack.value = atk; comp.release.value = rel;
    // Gain BEFORE the compressor. The file peaks at -28 dBFS, so a compressor
    // downstream of the fader never sees anything above its threshold and the
    // whole chain is a no-op — which is exactly what the first sweep measured
    // (crest 18.4 dB in, 18.4 dB out, at every setting).
    const pre = oac.createGain(); pre.gain.value = g;
    const post = oac.createGain(); post.gain.value = 1;
    s.connect(sh).connect(pre).connect(comp).connect(post).connect(oac.destination);
    s.start(0, 0.020, 0.500);
    const r = await oac.startRendering();
    const n = r.length, mono = new Float32Array(n);
    for (let c = 0; c < 2; c++) { const d = r.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / 2; }
    const m = stat(mono);
    const h = Math.max(...Array.from(hp(hp(mono, 48000, 200), 48000, 200), Math.abs));
    return { peak: +m.peak.toFixed(4), rms: +m.rms.toFixed(4),
             crestDb: +m.crest.toFixed(1), hp200: +h.toFixed(4) };
  };

  const rows = [];
  for (const shelfDb of [0, -5, -9])
    for (const thr of [-24, -18, -12])
      for (const ratio of [6, 12])
        for (const g of [10, 16, 24]) {
          const cfg = { shelfF: 3200, shelfDb, thr, ratio, knee: 26, atk: 0.006, rel: 0.20, g };
          rows.push({ shelfDb, thr, ratio, g, ...(await run(cfg)) });
        }
  return rows;
});

const TARGET_RMS = 0.0379, SLAP_PEAK = 0.184, PAGE_HP = 0.112, SLAP_HP = 0.136;
const scored = out.map((r) => ({ ...r,
  ok: r.peak <= SLAP_PEAK && r.hp200 > PAGE_HP && r.hp200 < SLAP_HP,
  rmsErrDb: +(20 * Math.log10(r.rms / TARGET_RMS)).toFixed(2) }));
scored.sort((a, b) => (b.ok - a.ok) || Math.abs(a.rmsErrDb) - Math.abs(b.rmsErrDb));
for (const r of scored.slice(0, 8)) console.log(JSON.stringify(r));
await b.close();

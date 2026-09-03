#!/usr/bin/env node
/**
 * Put the words and the music on a rendered cut.
 *
 *   node tools/trailer_post.mjs --cut shots/trailer/cut.mp4 --out shots/trailer/trailer.mp4
 *   node tools/trailer_post.mjs --cut shots/trailer/cut.mp4 --cards my_words.json
 *   node tools/trailer_post.mjs --music-scan          # where in the bed to start
 *
 * SEPARATE FROM `trailer.mjs` ON PURPOSE. The render costs about forty-five
 * minutes and this costs about twenty seconds, and the two things you will
 * actually iterate on — what the words say and where the music starts — live
 * entirely in here. Re-cutting copy must never mean re-rendering a valley.
 *
 * ── cards are placed against BEATS, not against seconds ─────────────────────
 *
 * `trailer.mjs` writes a `.json` beside its video listing every beat and how
 * many frames it got. This reads that, so a card says "sit over the camp beat,
 * a fifth of a second in" and stays correct when the camp beat is lengthened by
 * four tenths. Hardcoded timecodes silently slide off their beat the first time
 * anybody retunes the edit, and the failure is invisible until you watch it.
 *
 * ── why the cards are PNGs and not `drawtext` ───────────────────────────────
 *
 * The ffmpeg on this machine is built without libfreetype, so `drawtext` does
 * not exist (`ffmpeg -filters | grep drawtext` comes back empty) and neither
 * does libass for a subtitle track. `overlay` does exist. So each card is
 * rendered as an RGBA PNG in headless Chromium and composited, faded in and out
 * on its ALPHA channel so nothing pops.
 *
 * That is the better answer anyway: rendered in a browser the cards use the
 * GAME'S OWN font stack — `ui-rounded, "SF Pro Rounded", …`, the one in
 * index.html and hud.css — so the type on the trailer is the type in the HUD.
 * Colours are the design brief's palette anchors: cream `#fbe3c8` (the sky
 * horizon) for the words, gold `#f0ad46` (sunlit meadow, the game's dominant
 * colour) for a subtitle.
 *
 * Cream type over a cream sky is the failure case, and a drop shadow alone does
 * not save it — hence the feathered scrim behind each card. Soft ends, so it
 * never reads as a caption bar.
 */
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const has = (n) => argv.includes(`--${n}`);

const CUT   = resolve(String(arg('cut', 'shots/trailer/cut.mp4')));
const OUT   = resolve(String(arg('out', CUT.replace(/\.mp4$/, '-final.mp4'))));
const TRACE = resolve(String(arg('trace', CUT.replace(/\.[^.]+$/, '.json'))));
const MUSIC = resolve(String(arg('music', 'public/audio/Maple Road Loop.mp3')));
const CRF   = String(arg('crf', '19'));
// Size budget for the delivered file, in MB. The posting tool that hands a file
// to YouTube's and TikTok's web uploaders refuses anything over 10 MB, and a
// re-encode after the fact is a second generation nobody asked for — so the
// master itself is made to fit. `--max-mb 0` disables the budget and falls back
// to the old crf/24 Mbit/s encode (visually lossless, ~27 MB for 15 s).
const MAX_MB = parseFloat(arg('max-mb', '9.5')) || 0;
const TMP   = resolve(String(arg('cards-dir', `${dirname(OUT)}/cards`)));

// Where in the bed to start.
//
// `Maple Road Loop.mp3` is 3:39 of deliberately even material — it is a bed you
// drive to, not a piece with an arc — so the excerpt is chosen on its ENVELOPE
// rather than on a structural boundary. Sampled at 1.5 s (`--music-scan`),
// t=94.5 s is a trough at -22.4 dB mean and t=96.0 s is the loudest onset in
// the whole track at -14.4 dB, so starting at 96.0 puts a phrase entry on the
// first frame. Re-run the scan for any other track or length.
const MUSIC_SS = String(arg('music-ss', '96.0'));

// ── fades, and why the picture does not fade in ─────────────────────────────
//
// DEFAULT 0. Opening a social video on black is a self-inflicted wound: TikTok
// and Reels count a view almost immediately and measure retention from frame
// one, feeds autoplay as the viewer scrolls in so they arrive DURING the fade
// and see nothing, and an auto-picked cover frame comes from the first frames —
// a black one can become the cover. A 0.30 s fade-in spends most of the half
// second a short has to hold a thumb on an empty screen. Cut in hot.
//
// The tail is a different question and gets a small default. These clips LOOP,
// so a long fade to black followed by a hard jump back to a bright first frame
// is a visible seam; 0.25 s reads as an ending without opening a hole.
//
// Audio is not symmetrical with the picture. It gets a hair of fade-in to kill
// the click of starting mid-waveform, and a real fade-out, because an abruptly
// truncated music phrase is far more noticeable than a picture cut.
const FADE_IN   = parseFloat(arg('fade-in', '0'));
const FADE_OUT  = parseFloat(arg('fade-out', '0.25'));
const AFADE_IN  = parseFloat(arg('afade-in', '0.12'));
const AFADE_OUT = parseFloat(arg('afade-out', '1.2'));

// ── the words ───────────────────────────────────────────────────────────────
//
// `over` names a beat from the render's own trace; `lead` is how far into that
// beat the card appears and `tail` how far before its end it goes. A card on
// the last beat with tail 0 holds to the final frame and fades out with the
// picture.
const DEFAULT_CARDS = [
  // Cards are placed by BEAT NAME, so renaming a beat orphans its card — the
  // tool warns and skips rather than sliding it somewhere wrong.
  //
  // Two cards where there was one, and they split across the first two beats
  // rather than both landing on the hook: 2.6 s cannot carry two statements,
  // and the pairing is already in the edit — the line about the season belongs
  // over a camp at night, the one about going belongs over the camper pulling
  // out in the morning.
  { over: 'ridge', lead: 0.55, tail: 0.20, y: 27, size: 96,  text: "IT'S<br>CAMPING SEASON" },
  { over: 'drive', lead: 0.25, tail: 0.20, y: 27, size: 114, text: 'GO EXPLORE' },
  { over: 'camp',  lead: 0.20, tail: 0.55, y: 27, size: 114, text: 'FIND A SPOT' },
  { over: 'roast', lead: 0.25, tail: 0.45, y: 27, size: 114, text: 'STAY A WHILE' },
  { over: 'vista', lead: 0.15, tail: 0.00, y: 33, size: 128, text: 'CAMPING<br>SEASON',
    sub: 'a cozy drive through an endless autumn' },
];

const cardHtml = (c, W, H) => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: transparent; }
  .scrim {
    position: absolute; left: 0; right: 0; top: ${c.y ?? 27}%;
    /* A scrim of 0 turns it off. A 470 px band at 34% behind a 46 px URL on a
       night shot is a visible dark stripe protecting type that already had all
       the contrast it needed - the scrim is for cream-on-cream sky, not for
       small text on a dark frame. NB: no backticks in this comment. It sits
       inside a template literal, and a backtick in comment prose closes it -
       the same trap the shader files carry a warning about. */
    height: ${c.scrim ?? (c.sub ? 660 : 470)}px; transform: translateY(-50%);
    display: ${c.scrim === 0 ? 'none' : 'block'};
    background: linear-gradient(to bottom,
      rgba(38, 20, 12, 0) 0%, rgba(38, 20, 12, 0.34) 30%,
      rgba(38, 20, 12, 0.34) 70%, rgba(38, 20, 12, 0) 100%);
  }
  .wrap {
    position: absolute; left: 0; right: 0; top: ${c.y ?? 27}%;
    transform: translateY(-50%); text-align: center;
    font-family: ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  .t {
    font-size: ${c.size ?? 114}px; font-weight: 800; line-height: 1.07;
    letter-spacing: 0.035em; color: #fbe3c8;
    text-shadow: 0 2px 6px rgba(32, 18, 10, 0.66), 0 10px 44px rgba(32, 18, 10, 0.55);
  }
  .s {
    margin-top: 36px; font-size: 38px; font-weight: 600; letter-spacing: 0.115em;
    color: #f0ad46;
    text-shadow: 0 2px 6px rgba(32, 18, 10, 0.75), 0 8px 30px rgba(32, 18, 10, 0.55);
  }
</style><div class="scrim"></div><div class="wrap"><div class="t">${c.text}</div>${
  c.sub ? `<div class="s">${c.sub}</div>` : ''}</div>`;

async function main() {
  if (has('music-scan')) return scan();
  if (!existsSync(CUT))   { console.error(`[post] no cut at ${CUT}`); process.exit(2); }
  if (!existsSync(TRACE)) { console.error(`[post] no trace at ${TRACE} — cards are placed ` +
                                          'against the beats it lists'); process.exit(2); }

  const trace = JSON.parse(readFileSync(TRACE, 'utf8'));
  // Refuse to dress a cut that is missing a beat. The render says so in its
  // trace now; without this check the words and music go cleanly onto a short
  // video and it looks finished.
  const broken = (trace.beats ?? []).filter((b) => b.error);
  if ((trace.incomplete || broken.length) && !has('allow-partial')) {
    console.error(`[post] ${TRACE} reports an INCOMPLETE cut:`);
    for (const b of broken) console.error(`[post]   ${b.beat}: ${b.error}`);
    console.error('[post] re-render, or pass --allow-partial to dress it anyway');
    process.exit(3);
  }
  const fps = trace.fps || 60;
  // Beat start times, in seconds, from the frame counts the render wrote.
  const at = {};
  let acc = 0;
  for (const b of trace.beats) {
    if (!b.frames) continue;
    at[b.beat] = { start: acc / fps, secs: b.frames / fps };
    acc += b.frames;
  }
  const total = acc / fps;

  const spec = arg('cards') ? JSON.parse(readFileSync(resolve(String(arg('cards'))), 'utf8'))
                            : DEFAULT_CARDS;
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', CUT]).toString().trim();
  const [W, H] = probe.split('x').map(Number);

  // Resolve each card onto the timeline, and say so out loud — a card that has
  // slid off its beat is invisible in a filter graph and obvious in a table.
  const cards = [];
  for (const c of spec) {
    const b = at[c.over];
    if (!b) { console.warn(`[post] card "${String(c.text).replace(/<br>/g, ' ')}" names ` +
                           `beat "${c.over}", which this cut does not have — skipped`); continue; }
    const inAt  = b.start + (c.lead ?? 0.25);
    const outAt = b.start + b.secs - (c.tail ?? 0.35);
    cards.push({ ...c, inAt, outAt, holdsToEnd: outAt >= total - 1e-6 });
  }
  console.log(`[post] ${CUT} — ${W}x${H}, ${fps}fps, ${total.toFixed(2)}s, ` +
              `${trace.beats.length} beats`);
  console.log(`[post] picture fade in ${FADE_IN}s / out ${FADE_OUT}s, ` +
              `audio ${AFADE_IN}s / ${AFADE_OUT}s` +
              (FADE_IN > 0 ? '  — NOTE: a social video opening on black loses frame-one retention' : ''));
  for (const c of cards) {
    console.log(`[post]   "${String(c.text).replace(/<br>/g, ' ')}" over ${c.over}: ` +
                `${c.inAt.toFixed(2)}s → ${c.holdsToEnd ? 'end' : c.outAt.toFixed(2) + 's'}`);
  }

  // ── render the cards ──────────────────────────────────────────────────────
  mkdirSync(TMP, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (let i = 0; i < cards.length; i++) {
    await page.setContent(cardHtml(cards[i], W, H));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${TMP}/card${i}.png`, omitBackground: true });
  }
  await browser.close();

  // ── composite ─────────────────────────────────────────────────────────────
  const FADE = 0.32;
  const inputs = ['-i', CUT];
  const chain = [];
  cards.forEach((c, i) => {
    inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(total),
                '-i', `${TMP}/card${i}.png`);
    const fadeOut = c.holdsToEnd ? ''
      : `,fade=t=out:st=${(c.outAt - FADE).toFixed(3)}:d=${FADE}:alpha=1`;
    chain.push(`[${i + 1}:v]format=rgba,` +
               `fade=t=in:st=${c.inAt.toFixed(3)}:d=${FADE}:alpha=1${fadeOut}[c${i}]`);
  });
  let last = '0:v';
  cards.forEach((_, i) => { chain.push(`[${last}][c${i}]overlay=0:0:format=auto[v${i}]`); last = `v${i}`; });
  // Fade the picture at both ends AFTER the cards are on it, so a title that
  // holds to the last frame fades out with the shot rather than before it.
  const vf = [];
  if (FADE_IN > 0) vf.push(`fade=t=in:st=0:d=${FADE_IN}`);
  if (FADE_OUT > 0) vf.push(`fade=t=out:st=${(total - FADE_OUT).toFixed(3)}:d=${FADE_OUT}`);
  vf.push('format=yuv420p');
  chain.push(`[${last}]${vf.join(',')}[v]`);

  const map = ['-map', '[v]'];
  if (!has('no-music')) {
    inputs.push('-ss', MUSIC_SS, '-t', String(total), '-i', MUSIC);
    // loudnorm to -14 LUFS: what TikTok, Reels and Shorts all normalise toward,
    // so a louder master only gets turned down and a quieter one gets turned up
    // with its noise floor.
    chain.push(`[${cards.length + 1}:a]afade=t=in:st=0:d=${AFADE_IN},` +
               `afade=t=out:st=${(total - AFADE_OUT).toFixed(3)}:d=${AFADE_OUT},` +
               'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]');
    map.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const common = ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', chain.join(';'), ...map];
  if (MAX_MB > 0) {
    // Two-pass ABR at whatever bitrate the budget allows, HEVC when this ffmpeg
    // has it (x265 holds roughly twice the detail of x264 at the same size on
    // a picture that is high-frequency everywhere), x264 otherwise. 5% headroom
    // for container overhead; the audio's 192k is taken off the top.
    const budgetBits = MAX_MB * 8 * 1024 * 1024 * 0.95 - (has('no-music') ? 0 : 192_000 * total);
    const vbr = Math.max(1_000_000, Math.floor(budgetBits / total));
    const encs = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const hevc = /\blibx265\b/.test(encs);
    const passlog = `${OUT}.2pass`;
    const codec = hevc
      ? ['-c:v', 'libx265', '-preset', 'medium', '-tag:v', 'hvc1', '-b:v', String(vbr), '-maxrate', String(Math.floor(vbr * 1.2)), '-bufsize', String(vbr * 2)]
      : ['-c:v', 'libx264', '-preset', 'slow', '-b:v', String(vbr), '-maxrate', String(Math.floor(vbr * 1.2)), '-bufsize', String(vbr * 2)];
    const passArg = (n) => hevc ? ['-x265-params', `pass=${n}:stats=${passlog}:log-level=error`] : ['-pass', String(n), '-passlogfile', passlog];
    console.log(`[post] size budget ${MAX_MB} MB over ${total.toFixed(2)} s -> ${(vbr / 1e6).toFixed(2)} Mbit/s video, ${hevc ? 'hevc' : 'h264'}, two-pass`);
    execFileSync('ffmpeg', [...common, ...codec, ...passArg(1), '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'], { stdio: 'inherit' });
    execFileSync('ffmpeg', [...common, ...codec, ...passArg(2), '-movflags', '+faststart', '-shortest', OUT], { stdio: 'inherit' });
    for (const f of readdirSync(dirname(OUT))) if (f.startsWith(`${OUT.split('/').pop()}.2pass`)) rmSync(`${dirname(OUT)}/${f}`, { force: true });
  } else {
    execFileSync('ffmpeg', [
      ...common,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
      '-maxrate', '24M', '-bufsize', '48M',
      '-movflags', '+faststart', '-shortest', OUT,
    ], { stdio: 'inherit' });
  }

  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size', '-of', 'default=nw=1', OUT]).toString().trim().replace(/\n/g, '  ');
  console.log(`[post] wrote ${OUT}  ${info}`);
}

/**
 * Sampled loudness across the bed, so a start time is chosen from the envelope
 * rather than guessed. A trailer wants a phrase ENTRY on frame one; that is a
 * quiet window followed by the loudest one you can find.
 */
function scan() {
  const step = parseFloat(String(arg('scan-step', '1.5')));
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', MUSIC]).toString().trim());
  const rows = [];
  for (let t = 0; t + step <= dur; t += step) {
    // `spawnSync`, not `execFileSync`: volumedetect prints its measurement to
    // STDERR and exits 0, so there is no exception to catch it in and
    // execFileSync only hands back stdout. The first version of this read the
    // number out of a catch block that never ran and printed an empty table.
    const r = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(t), '-t', String(step),
      '-i', MUSIC, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume: (-?[\d.]+)/.exec(r.stderr ?? '');
    rows.push({ t: +t.toFixed(1), mean: m ? parseFloat(m[1]) : NaN });
  }
  const loud = rows.filter((r) => Number.isFinite(r.mean)).sort((a, b) => b.mean - a.mean);
  console.log(`[post] ${MUSIC} — ${dur.toFixed(1)}s, ${rows.length} windows of ${step}s`);
  for (const r of rows) {
    if (!Number.isFinite(r.mean)) continue;
    const bar = '#'.repeat(Math.max(0, Math.round(r.mean + 30)));
    console.log(`  ${String(r.t).padStart(6)}s  ${r.mean.toFixed(1).padStart(6)} dB  ${bar}`);
  }
  if (loud.length) {
    console.log(`\n[post] loudest window starts at ${loud[0].t}s (${loud[0].mean.toFixed(1)} dB) ` +
                '— a phrase entry on frame one usually sits right there, and the window before ' +
                'it should be a trough.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

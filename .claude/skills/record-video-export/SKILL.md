---
name: record-video-export
description: Film a video of the game for posting — a vertical 1080x1920 MP4 rendered offline, frame by frame, with words and the game's own music on it. Use whenever the user wants a video, trailer, clip, reel, short, teaser, or "something to post", and whenever they say record, film, capture, export a video, make a clip, TikTok, Reels, Shorts, YouTube Short, vertical video, or screen record. Two tools: tools/trailer.mjs films an eight-beat cut opening on a night camp on a forested bluff with the dog, then driving, kayaking, biking, wildlife photography, making camp, roasting marshmallows and a vista, and is what a trailer wants; tools/reel.mjs films one longer drive-and-make-camp choreography. tools/trailer_post.mjs puts the words and music on. Also use when a video exists and they want different words, different music, a different length, a different location or time of day, or a different beat order. Not for diagnosing a visual bug (that is debug-visual-video) and not for stills (shot.mjs, campshot.mjs, or in-game photo mode).
---

# Record a Video for Export

Three tools, one clock. Read the header of whichever you use — each carries its
flags and the reasoning behind every default.

| tool | films | length | wall clock |
|---|---|---|---|
| `tools/trailer.mjs` | **eight beats**: night ridge camp (the hook), drive, kayak, bike, wildlife photo, make camp, marshmallow, vista | 15 s | ~40 min at delivery quality |
| `tools/reel.mjs` | **one choreography**: drive, stop, make camp, slow orbit | ≤10 s | ~25 min at delivery quality |
| `tools/trailer_post.mjs` | puts the words and the music on a rendered cut | — | ~20 s |

**For anything promotional, use `trailer.mjs`.** A trailer has to say what is in
the game, and what is in this game is a camper, a kayak, a mountain bike, a
camera, a fire with a marshmallow over it, and a valley full of animals. `reel`
films one shot of it beautifully; that is the right tool when the drive-and-camp
beat *is* the subject, and the wrong one when the question is "what is this
game".

## Do not reach for a screen recorder

It is the obvious idea and it is wrong here, for a reason specific to this
engine: `engine.adaptive` moves the internal render scale to hold ~50 fps, so a
recorder stealing GPU makes the picture go soft *exactly* during the busy
seconds worth posting. The player can pin it (Settings → Picture → Resolution
100%, Auto off) and a screen recording then works acceptably — but it still
bakes in every hitch, cannot repeat a take after a fix, and cannot fly a camera
move no hand can perform.

Offline rendering removes the coupling entirely. Both tools replace
`engine.clock.getDelta` with a budget granted one frame at a time, so a frame
may cost a second of wall clock and still be exactly 1/fps of screen time. Every
system hangs off that one dt (`Engine._loop`) and physics is a 1/120
accumulator, so the motion is exact and reproducible. Slow frames cost wall
clock, never quality.

## The pipeline

Start your own vite server first — **port 5178 serves the MAIN checkout**, so
from a worktree every frame would be of main's code (AGENTS.md). Pin a seed that
has a bake on disk (`node tools/bake.mjs --seed 20261018`); a seed with no bake
bakes a whole world before the first frame.

```bash
npx vite --host 127.0.0.1 --port 5193 --strictPort

# 1. stills — one frame per beat, ~10 min, answers "is anything mis-framed"
node tools/trailer.mjs --url http://127.0.0.1:5193 --stills --fps 30 --out shots/trailer/look.mp4

# 2. look — the whole cut in motion at low quality, ~13 min
node tools/trailer.mjs --url http://127.0.0.1:5193 --fps 24 --ss 1 --out shots/trailer/look.mp4

# 3. ship — 1080x1920 60 fps, 2x supersampled, ~40 min
node tools/trailer.mjs --url http://127.0.0.1:5193 --fps 60 --ss 2 --out shots/trailer/cut.mp4

# 4. words and music, ~20 s — iterate here freely, it does not re-render
node tools/trailer_post.mjs --cut shots/trailer/cut.mp4 --out shots/trailer/trailer.mp4
```

**The setups cost about ten minutes whatever quality you ask for** — the drive
beat rehearses candidate meadows for real, the kayak beat scans the whole world
for a paddleable reach, and every teleport has to let streaming catch up. So the
stills pass is nearly all setup and the delivery is setup plus twenty-two
minutes of capture. Budget accordingly, and run the long ones in the background.

`--only drive,camp` films a subset, which is how you iterate one beat without
paying for all eight. **`roast` needs `camp` in the same run** — it sits down at the
fire the camp beat built (`__roast.enter()` finds the first camp in the world
with a roasting stick in it), so `--only roast` has nothing to sit at.

## One-off shots live in their own file

A clip that is not part of the standard cut — a single joke, a single mechanic —
goes in `tools/clips/<name>.mjs` rather than into `trailer.mjs`, so a later clip
can read how it was done instead of archaeologising a diff. The module exports a
factory taking the harness context (`page`, `arg`, `hold`, `step`, `grant`,
`settle`, `FPS`) and returning `{ beat, setup, camera, driver }`;
`trailer.mjs` registers it **only when `--only` names it**, so adding a shot
never changes the length of the fifteen-second cut. `tools/clips/README.md` has
the contract and the index.

Shipped shots:

| name | what it films | flags |
|---|---|---|
| `cliff` | the camper drives off a bluff, falls, lands, sits there | `--cliff-secs` `--cliff-back` `--cliff-side` `--cliff-eye` `--cliff-step` `--cliff-hour` |

`cliff` finds a LIP (steep drop within 10-30 m) rather than reusing the ridge
beat's bluff finder, which scores for a camp with a view and usually returns a
long grade the camper would trundle down. It then REHEARSES every candidate —
drives it for real and keeps the first that leaves the ground and falls >20 m —
because the trap table's oldest entry is that every proxy for drivability passed
a corridor the camper then failed. If no candidate goes over, the answer is
another `--seed`, not a looser threshold.

## Changing the cut

- **Beats** — the `BEATS` table at the top of `trailer.mjs`: name, seconds,
  hour, fov, and whether this tool poses the camera or the game does. Durations
  need not sum to 15; whatever they sum to is the video's length, and
  `trailer_post.mjs` reads the beat lengths back out of the render's `.json` so
  the words follow.
- **Words** — `DEFAULT_CARDS` in `trailer_post.mjs`, or `--cards words.json`
  with the same shape. A card is placed **against a beat**, not against a
  timecode: `{ over: 'camp', lead: 0.2, tail: 0.55, text: 'FIND A SPOT' }` means
  "over the camp beat, appearing 0.2 s in and leaving 0.55 s before it ends". A
  hardcoded timecode slides off its beat the first time anybody retunes the
  edit, and the failure is invisible until you watch it. The tool prints the
  resolved table — read it.
- **Music** — `--music <file> --music-ss <seconds>`. `--music-scan` prints the
  bed's envelope so a start time is chosen rather than guessed; a trailer wants
  a phrase ENTRY on frame one, which is a quiet window followed by the loudest
  one you can find. On `Maple Road Loop.mp3` that is **t=96.0 s**, the default.
  Output is normalised to −14 LUFS, which is what TikTok, Reels and Shorts all
  normalise toward.
- **Fades** — `--fade-in` defaults to **0 and should stay there**. See the trap
  table: opening a social video on black throws away frame-one retention, the
  moment the feed autoplays into, and the frame an auto-picked cover comes from.
  `--fade-out` defaults to 0.25 s, short because these clips loop and a long
  fade to black followed by a hard jump back to a bright first frame is a
  visible seam. Audio is deliberately not symmetrical (`--afade-in` 0.12 s, just
  enough to kill the click of starting mid-waveform; `--afade-out` 1.2 s,
  because a truncated music phrase is far more noticeable than a picture cut).
- **Where and when** — `--seed` changes the world and costs a bake; `--hour` per
  beat in the table (7.5 dawn, 12 midday, 17.4 golden, 20.4 dusk, 1 night);
  `--vista-index/-height/-pitch/-fov` reframe the closing shot; `--species`
  picks the animal for the photo beat.

**The light.** The shipped hours run 21.6 → 8.2 → 15.0 → 16.0 → 16.8 →
17.6 → 20.4 → 17.6. The hook is a night cold-open — firelight against a dark ridge, which is
the strongest thing this game can put in a first frame — and the six beats after
it run as one afternoon sliding into dusk. Inside that run, keep the hours
moving one way: two beats step back an hour, which is invisible in the same
afternoon light, and a jump to dawn would not be.

**Do not open on a drive-away shot, and do not open on black.** The hook was
originally the drive beat and it was the wrong hook twice over: a camper
receding from a camera that is itself pulling back shrinks the subject from both
ends, and the first frame is a rectangle with two tail lights. It plays well as
beat TWO, where it reads as leaving in the morning and is the only footage of
the game's core verb — a trailer for "a cozy drive" that never shows the camper
moving is arguing with its own subtitle. See the trap table for the black-frame
half of it.

**Beat length changes the camera, not just the duration.** The drive dolly was
5.6 → 9.8 m as a 2.8 s hook; at 1.9 s that same move only reads as the camper
leaving. Shortening it without also widening the lateral offset then put the lens
5.4 m dead astern, and a rear elevation filling half a 9:16 frame reads as
PARKED, because no ground is in shot moving past to say otherwise. Retune the
framing whenever you retime a beat.

**Make the beat table's sum an assertion.** It was allowed to total 15.6 s once;
nothing checks it, and a wrong-length master takes forty-five minutes to
discover.

**Do not open a social video on a drive-away shot, and do not open it on black.**
The hook was originally the drive beat, and it was the wrong hook twice over: a
camper receding from a camera that is itself pulling back shrinks the subject
from both ends, and the first frame is a rectangle with two tail lights. See the
trap table for the black-frame half of it.

## Verifying a take

This is where these tools have actually failed, repeatedly, so spend the effort
here. **Watch it densely and read the numbers.**

```bash
# Dense contact sheet. Sample at 5-10 fps, never 1 — a 1 fps sheet is 15 of 900
# frames and steps straight over a quarter-second collision.
ffmpeg -y -loglevel error -i shots/trailer/cut.mp4 \
  -vf "select='not(mod(n\,10))',scale=124:220,tile=15x6" -frames:v 1 sheet.png

# Then pull FULL-RES frames of anything that looks off. A 124 px thumbnail
# cannot tell you whether the camp is behind a tree or whether the viewfinder
# brackets rendered.
ffmpeg -y -loglevel error -ss 10.2 -i shots/trailer/cut.mp4 -frames:v 1 f.png
```

Read the sheet as an image, and check the beat trace beside the video
(`cut.json`) — it records the site each beat chose, the camp's clearance survey,
and for `reel.mjs` a per-frame speed trace whose one number that matters is
deceleration under throttle (`stall: null` means clean; the test is
deceleration, **not** a speed floor — a take shipped where the camper hit a
boulder at 20.8 m/s and carried on at 14.5).

An `--stills` frame is taken **60% of the way through** each beat, not on frame
one, and that matters: the camp raises over RAISE_TIME with the build queue
draining one prop per frame, so a frame-one still is a correctly composed orbit
around a clearing where nothing has appeared yet.

## Traps

Every row cost a take or a round.

| trap | what happens |
|---|---|
| **the first-run journal eats the keys** | a fresh headless context is a brand-new player, so `HUD.maybeShowIntro()` opens the journal 400 ms after boot on a REAL `setTimeout` — the granted clock cannot hold it off — and the open book takes the keyboard. `reel --scout` reported **0 good sites of 8, every one `drive IMPACT -0`**: not eight collisions, a camper that never moved. Both tools now pre-seed `localStorage['pa.hud']`. **Any new harness that drives with keys must too.** |
| `__forceCamera` left raised | `reel`'s `pitchAndSurvey` raises it and used not to lower it, and it runs during candidate selection — so `CameraRig.update` returned early at its capture check and the whole drive beat was filmed off a camera nobody was driving |
| three.js `fov` is **vertical** | so every authored composition is a narrow crop at 9:16. CameraRig's 52° is 78° horizontal at 16:9 and 31° at 9:16 — a telephoto. World views are pinned to 70. The roast view's `POSE.fov` 24 is 13.6° horizontal at 9:16 and the frame becomes the fire's bloom with the marshmallow in a corner; 34 holds both |
| `wildlife.debugSpawn` spawns off the **camera** | `cam.position + forward*dist`, not the camper — it will happily put a deer next to wherever the previous beat left the lens. Pose the camera first |
| a rideable parked **next to the camper** does not move | the bike beat filmed a stationary bike for three passes. `parkAt(x + 3, z + 3)` puts it three metres diagonally off a vehicle about five long, facing back across it — boxed in, and the camper's rear wheel was in shot the whole beat. Park it 8 m down the run it is meant to ride, pointing away. `bike_physics.state()` publishes **`blocked`**, plus `speed`, `effort` and `wading`: read them and warn, or you will judge this from thumbnails three times |
| `Bike.mount()` succeeds **from the kayak** | it is guarded only by "is there a bike and am I already riding" and takes `controlsHeldBy` unconditionally, so mounting while still aboard a boat works, hands the camera to the saddle, and films a shot that looks right and is not being pedalled. Exit the boat and clear `controlsHeldBy` first |
| `drive()` is not a held key | one call before a beat is one call; anything that runs `dismount()` clears `_script` silently and the shot coasts. Both rideables need a per-frame driver, the way `drivers.kayak` re-asserts every frame |
| a ride camera opens **banked** | a kayak dropped at the head of a reach is not going anywhere yet and the mounted eye rolls with the hull. Paddle ~3 s off camera before the beat starts; granting still frames does not fix it |
| picking a camp site by **slope** | landed a correct 10-prop camp behind a trunk in a wooded clearing. The 72-bearing survey called the arc clear and was right — canopy overhead and a trunk *beside* the camera are on no ray between camera and subject. Pitch on the ground the drive beat already rehearsed |
| `poi.best('road')` ranks by its own score | not by drivability — the top road can be a slope-1.12 switchback. `--park meadow` beats roads badly (6 good sites vs 1 on seed 20261018) |
| `poi.anchor('vista')` index 0 | stands at 356 m on this seed, above the treeline, and films grey rock. `--vista-index 1` looks across a braided river valley |
| `.pa-camp-prompt`, `.pa-roast-tip` | live on `document.body`, not `#pa-hud`, so hiding the HUD root leaves "E pitch a camp here" and "drag or A/D to turn it" in frame |
| `__forceCamera` also hides the HUD | so a beat that wants photo mode's viewfinder brackets must set `window.__hudForce = true` as well |
| PNG frames at `--ss 2` are ~8 MB each | frame encoding, not rendering, sets the capture rate. JPEG q96 is 5× faster and invisible after a 2:1 downsample |
| no bitrate cap | this world is high-frequency detail everywhere; crf 16 uncapped gave 80 MB for 10 s. crf 19 under 24 Mbit/s is still visually lossless as a re-encode source |
| **opening on black** | the first cut shipped with a 0.30 s fade-in, which is ~18 frames of nothing in the only second that matters. TikTok and Reels count a view almost immediately and measure retention from frame one; feeds autoplay as the viewer scrolls in, so they arrive DURING the fade; and an auto-picked cover frame comes from the first frames. Cut in hot — `--fade-in 0`, which is now the default |
| **no `drawtext`** | the ffmpeg here is built without libfreetype, and there is no libass either. `overlay` works, so cards are RGBA PNGs rendered in Chromium — which also gets the game's own `ui-rounded` font stack. Cream type over a cream sky needs the feathered scrim, not just a shadow |
| headless capture has **no audio** | the game's synth would need a separate real-time pass. `trailer_post.mjs` lays the authored bed on instead |
| **rehearse, do not predict** | four rounds went into predicting whether a start was drivable — slope, run-out drop, a downward raycast, a water query — and every proxy passed a corridor the camper then failed. A raycast cannot see a river (a cut in the ground with nothing standing proud of it); a water query cannot see a boulder. Driving it costs two seconds |

## Delivery

1080×1920, 60 fps, yuv420p + AAC, `+faststart`, **under 10 MB** — `trailer_post.mjs` budgets the encode to `--max-mb` (default 9.5) with two-pass HEVC when ffmpeg has libx265, because the posting tool refuses files over 10 MB and a re-encode after the fact is a second generation. `--max-mb 0` restores the ~27 MB crf-19 H.264 master. Output
goes in `shots/` (gitignored). **Hand the user the file with the file-delivery
tool rather than only naming the path**, and tidy the intermediate `look*.mp4`
and `*-frames/` directories — `shots/` is already ~2.8 GB.

### Posting it

The live game is **https://camping-season.pages.dev/** — every description and
caption should link it. There is also an itch.io page at
https://optikalefx.itch.io/camping-season.

Reconnaissance done 2026-09-03, not a completed flow:

- Chrome (Claude in Chrome) is connected locally, and **both `studio.youtube.com`
  and `tiktok.com/tiktokstudio/upload` are already signed in** as `optikalefx`,
  so no credentials are needed — TikTok's uploader loaded with no bot-check.
- **The YouTube channel is a developer channel** (11.1k subscribers; recent
  videos are Node, jQuery, Svelte/Convex deploys), not a gaming channel. Copy
  that leads with "built with three.js, procedurally generated, runs in the
  browser" will land better there than generic cozy-game marketing.
- **`file_upload` caps at 10 MB combined and the delivered trailer is 27 MB.**
  Either re-encode a smaller upload copy — and know that both platforms
  re-encode to 10–20 Mbit/s anyway, so a ~5 Mbit/s source compounds the loss on
  a picture that is high-frequency detail everywhere — or have the user drop the
  file in and do the rest of the form yourself.
- **TikTok captions do not render clickable links.** The URL goes in the caption
  as plain text and the real link belongs in the profile bio.

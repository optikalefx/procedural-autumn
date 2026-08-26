---
name: record-video-export
description: Film a vertical short-form video of the game — a 9:16 1080x1920 MP4 rendered offline, frame by frame, with tools/reel.mjs. Use this whenever the user wants a video, clip, reel, short, trailer, or "something to post" of the game, and whenever they say record, film, capture, export a video, make a clip, TikTok, Reels, Shorts, vertical video, or screen record. Also use it when a clip already exists and they want a different location, time of day, length, or framing. Not for diagnosing a visual bug (that is debug-visual-video) and not for stills (shot.mjs, campshot.mjs, or in-game photo mode).
---

# Record a Video for Export

The tool is `tools/reel.mjs`. Read its header before changing anything — it
carries the flags and the reasoning behind each default.

## Do not reach for a screen recorder

It is the obvious idea and it is wrong here, for a reason specific to this
engine: `engine.adaptive` moves the internal render scale to hold ~50 fps, so a
recorder stealing GPU makes the picture go soft *exactly* during the busy
seconds worth posting. The player can pin it (Settings → Picture → Resolution
100%, Auto off) and a screen recording then works acceptably — but it still
bakes in every hitch, cannot repeat a take after a fix, and cannot fly a camera
move no hand can perform.

Offline rendering removes the coupling entirely. `reel.mjs` replaces
`engine.clock.getDelta` with a budget granted one frame at a time, so a frame
may cost a second of wall clock and still be exactly 1/fps of screen time.
Every system hangs off that one dt (`Engine._loop`) and physics is a 1/120
accumulator, so the motion is exact and reproducible. Slow frames cost wall
clock, never quality.

## The workflow: scout, look, ship

Start your own vite server first — port 5178 serves the **main** checkout, so
from a worktree every frame would be of main's code (AGENTS.md).

```bash
npx vite --host 127.0.0.1 --port 5190 --strictPort
node tools/reel.mjs --url http://127.0.0.1:5190 --scout
node tools/reel.mjs --url http://127.0.0.1:5190 --site 0 --hour 17.4 --fps 24 --ss 1 --out shots/reel/look.mp4
node tools/reel.mjs --url http://127.0.0.1:5190 --site 0 --hour 17.4 --fps 60 --ss 2 --out shots/reel/clip.mp4
```

Roughly 90 s, then 3 min, then 15 min. The order is the whole point: a delivery
render costs fifteen minutes, so anything knowable for less should be known
first.

**`--scout` films nothing** and answers every mechanical question at once:

```
site 0 road[ 4] slope 0.006 y-1m water 0  drive clean  camp 9 props  arc 0.55
site 2 road[ 1] slope 0.009 y-3m water 1  drive clean  camp 8 props  arc 0.01
   —   road[ 3] slope 1.166 y+199m water 0  drive IMPACT -12.5
```

`drive` is a real rehearsal — the camper is driven down the corridor and its
speed trace read. `camp` is the finished prop count (compact sites build 2–4,
full ones 6–9). `arc` is how far the clearest orbit bearing sits, in radians,
from the intended composition; above ~0.6 the camera is looking at the camp
side-on.

**The look pass is not optional, because the scout's gates are mechanical.** On
seed 20261018, site 2 passes every one of them — clean drive, 8-prop camp, an
arc 0.01 rad off ideal — and films a chase camera hanging over a flat blue
lake, because that road runs along a shoreline. Three minutes at 24 fps answers
"does this look like anything"; fifteen answers it far too expensively.

Within one world the free axes are `--site` (which clean candidate) and
`--hour` (7.5 dawn, 12 midday, 17.4 golden, 19.6 dusk, 1 night). `--seed`
changes the world and costs a bake.

`--park` chooses what kind of place the drive starts from, and it matters more
than it sounds. Meadows are the default because they win on measurement: on
seed 20261018 they gave 6 good sites out of 8 candidates with orbit arcs
0–0.04 rad off ideal, against roads' 1 good site and a best arc of 0.55. A
meadow is scored as open, dry, low-slope ground — which is what both a drive
and a full camp want — while roads climb hillsides and ford rivers. Use
`--park road` when the dirt-track look is the point, and expect to scout harder.

**When the scout reports zero good sites**, do not render the least-bad one and
hope — the tool will do that and warn, but the result is a camper hitting
something on camera. Switch `--park` or change `--seed`.

## Verifying a take

This is where the tool has actually failed, twice, so spend the effort here.

**Read the telemetry first.** Every run writes a `.json` beside the video with
a per-frame trace. The one number that matters is deceleration under throttle:

```bash
node -e "const t=require('./shots/reel/clip.json'); console.log(t.stall, t.topSpeed, t.distance)"
```

`stall: null` means clean. The test is deceleration, **not** a speed floor — a
take shipped where the camper hit a boulder at 20.8 m/s and carried on at 14.5,
which any "did it stop" check passes happily.

**Then watch it, densely.** A contact sheet sampled at one frame per second is
10 of 600 frames and steps straight over a quarter-second collision. Sample at
5–10 fps:

```bash
ffmpeg -y -loglevel error -i shots/reel/clip.mp4 \
  -vf "select='not(mod(n\,12))',scale=140:249,tile=10x5" -frames:v 1 sheet.png
```

Read the sheet as an image, then pull one or two full-resolution frames of any
moment that looks off. A thumbnail will not tell you whether the camera is
aimed at the camp or six metres past it.

## Traps

| trap | what happens |
|---|---|
| `poi.best('road')` ranks by its own score, not drivability | the top road can be a slope-1.12 switchback; the tool scores candidates itself and rehearses them |
| three.js `fov` is **vertical** | CameraRig's 52° reads as 78° horizontal at 16:9 and 31° at 9:16 — a telephoto. Pinned to 70° from an `onLateUpdate` registered last |
| `.pa-camp-prompt` lives on `document.body`, not `#pa-hud` | hiding the HUD root leaves "E pitch a camp here" in frame |
| `__forceCamera` hides the HUD **and** takes the camera off the chase rig | no good for a driving beat; hide the HUD root directly instead |
| PNG frames at `--ss 2` are ~8 MB each | frame encoding, not rendering, sets the capture rate. JPEG q96 is 5× faster and invisible after a 2:1 downsample |
| no bitrate cap | this world is high-frequency detail everywhere; crf 16 uncapped gave 80 MB for 10 s. TikTok re-encodes to 10–20 Mbit/s anyway |
| headless capture has no audio | normal practice is a trending sound over silent footage; the game's synth audio would need a separate real-time pass |

## Changing the shot

The choreography is the `SHOT` table near the top of `reel.mjs` — beats in
seconds, with the camera handed to the game's own chase rig for the drive and
to the harness for the orbit. Two rules earned the hard way:

- **Rehearse, do not predict.** Four rounds went into predicting whether a
  start was drivable — slope, run-out drop, a downward raycast for obstacles, a
  water-depth query — and every proxy passed a corridor the camper then failed.
  A raycast cannot see a river (a cut in the ground with nothing standing proud
  of it); a water query cannot see a boulder. Driving it costs two seconds.
- **Normalise the terms in any camera-placement cost.** Adding a raw
  blocked-ray count (0–30) to `radians * 0.9` made the composition term noise
  and sent the orbit 55° off-axis to save two rays. Blockage as a 0..1 fraction
  times ~3, plus angular error in radians, behaves.

Survey clearance once per site, at both ends of a dolly, with several rays —
per-frame raycasting jitters the camera, and stepping the camera outward to
escape an obstacle shrinks the subject.

## Delivery

1080×1920, 60 fps, H.264 yuv420p, `+faststart`, ~23 Mbit/s, under 30 MB for
10 s. Output goes in `shots/` (gitignored). Hand the user the file with the
file-delivery tool rather than only naming the path.

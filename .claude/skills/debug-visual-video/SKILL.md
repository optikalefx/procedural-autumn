---
name: debug-visual-video
description: Diagnose a visual/animation issue by filming it — capture the running game with a subject-chasing camera plus synced telemetry, review the frames as contact sheets, fix, re-film. Use whenever a user reports something that LOOKS wrong (a pose glitch, snapping, popping, jitter, sinking, clipping, "it did something weird") and especially when numeric probes say everything is fine or you have already shipped a fix and the report came back. Works for any in-game subject — wildlife, the camp dog, birds, the vehicle, props, water.
---

# Debug a Visual Issue with Video

Numeric harnesses measure what you thought to measure. A user reporting "it
snapped" or "it looks wrong" is reporting something you probably did NOT think
to measure — and the fastest way to find out what is to film the thing and
look at it, the way they did.

Hard-won rule from the camp-dog head bugs (2026-08): **three numeric probes in
a row said the head was smooth while the user's screenshots kept showing it
wasn't.** Each probe validated the previous fix's failure mode, not the actual
complaint. One 12-second filmstrip found the real bug (a terrain-following
correction diving the nose into every hollow) in a single pass. When a visual
report resists your metrics, stop refining metrics and film.

## The loop

1. **Reproduce on film** — capture the exact scenario the user described
   (usually: the first N seconds after the subject appears, or a specific
   behaviour like settling/rising). Get frames AND telemetry from one run.
2. **Read the frames** as tiled contact sheets around anything suspicious.
   Name what you see in plain words ("nose dives to the ground at constant
   speed") before touching code — that sentence usually falsifies a theory.
3. Fix.
4. **Re-film the same scenario** and read the same moments again. A fix is
   done when the film is clean, not when a number improves.

## Capture: a subject-chasing script, not a screen recorder

Template: `tools/_scratch/dogfilm.mjs`. Adapt the subject; keep the shape:

- Playwright, headless, against **this worktree's own vite server** (port
  5178 serves the main checkout — start your own, see AGENTS.md).
- `window.__forceCamera = true`, then re-aim `window.__engine.camera` at the
  subject **every frame** — a fixed camera leaves the subject dozens of pixels
  tall and the film unreadable. Frame it close (2–3 m for an animal), from a
  bearing where the interesting part (head, feet, waterline) is silhouetted.
- `page.screenshot()` in a loop, ~6–10 fps for 10–15 s, numbered files
  (`f%03d.png`).
- **Log telemetry with every frame** — state machine state, speeds, blend
  weights, whatever drives the subject — so each image pairs with a data row.
  The pairing is the payoff: the film says *something happened at f39*; the
  row says *state was wander, speed constant, blend zero*, which is what
  kills wrong theories.
- To reach a slow behaviour quickly (a rest cycle, a spawn), clamp the
  subject's own timers from inside `page.evaluate` rather than waiting
  wall-clock (`if (dog.stateName === 'wander' && dog.timer > 1.5)
  dog.timer = 1.5`). Sim time ≪ wall time headless; see the headless-capture
  memory.

## Review: contact sheets

```bash
ffmpeg -y -loglevel error -i f%03d.png \
  -vf "select='between(n\,36\,44)',scale=480:270,tile=3x3" -frames:v 1 sheet.png
```

Tile 6–9 frames spanning each suspicious window and read the sheet as an
image. Two or three sheets per run is usually enough. (`montage` needs fonts
configured; ffmpeg's tile filter always works.)

## Traps

- **Coarse-sampled angular-velocity telemetry lies.** Dividing a quaternion
  delta accumulated over ~10 engine frames by one frame's dt inflates smooth
  motion 5–9×; an ordinary body turn reads as a 30 rad/s "spike". If you log
  rates, capture the engine's dt by wrapping the subject's update, and treat
  the numbers as *pointers to which frames to look at*, never as verdicts.
  The frames are the verdict — both directions: the film cleared two "spikes"
  that were artifacts, and showed a dive the rate metric had called smooth.
- **Place the review camera with the terrain in mind** — on steep sites a
  naive offset puts it inside the hillside. Sample the gradient and stand
  uphill, or film from the subject's contour side.
- **Pick the site to match the report.** Flat-ground films hide slope bugs;
  sort candidate spots by `world.getSlope` and pitch the scenario on the
  flattest or steepest deliberately.
- Night/dusk lighting can make a small subject unreadable — if the film comes
  out murky, re-run; the sim clock differs per boot.

## When a plain screenshot is enough

For a static complaint ("it's floating", "it's buried", "wrong colour") one
posed screenshot plus a numeric cross-check (position vs the surface it
should sit on) beats a film. Film is for anything with a time dimension:
snaps, pops, jitters, drift, "it did X then Y".

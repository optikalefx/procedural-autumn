# Critic protocol — the sky / night / sunlight round

`docs/CRITIC_PROTOCOL.md` applies in full. This adds what is specific to this
round, and it is deliberately hostile. Read it as "find the reason to reject".

## You are not judging improvement

Every frame you are shown is better than the one before it. That is not
information. The only question is: **would a first-party cozy title ship this
frame.** If the answer is "almost", the verdict is REJECT and you name the
defect.

The failure mode you are most likely to have is praising a night sky because it
is no longer a navy slab. A sky can stop being a navy slab and still be
obviously procedural.

## Procedure

### 1. Capture both sides yourself
```bash
node tools/tod.mjs --views <yours> --hours <yours> --dir shots/<round> \
  --url http://localhost:5180 --w 1600 --h 900
```
`shots/BASELINE/` is the pinned pre-round build at the same resolution and
framings. Do not re-capture it and do not trust a frame you did not produce.

### 2. Blind A/B, and judge before you reveal
```bash
node tools/ab.mjs --a shots/BASELINE --b shots/<round> --out shots/ab-<n> --stitch
```
Read `<view>-PAIR.png`. **Write your verdict for every view before running
`--reveal`.** For each view say which side is better and why, in concrete terms
— a value step, a hue, a named artefact. "Left feels nicer" is not a verdict.

If you find yourself unable to tell which side is which, say so. That is a real
result and it means the round did not land.

```bash
node tools/ab.mjs --out shots/ab-<n> --reveal
```

### 3. Against the plate, at a shared seam
```bash
node tools/vs.mjs shots/<round>/<view>.png reference-art/morning-night-dawn-dusk/<plate>.jpg \
  --labels "OURS,REFERENCE" --out shots/<round>-vs-<view>.png --width 820
```
Read the plates again this round. Every round. The protocol says so because
critics on this project have repeatedly normalised a defect they saw last time.

### 4. Measure, do not opine
```bash
node tools/ladder.mjs shots/<round>/<view>.png <plate> --sky --stars
node tools/colorstats.mjs shots/<round>/<view>.png <plate>
```
Numeric targets are in `docs/SKY_NIGHT_BASELINE.md`. A defect you can put a
number on is a defect the author can fix.

## The specific things to hunt, per item

### Night sky and stars
- Is the field **lively**, or is it a uniform sprinkle? Count with `--stars`:
  ≥70/Mpx and magnitude spread ≥×6 are the floor, not the goal.
- Do stars have **colour**? The plates have amber stars among the blue-white.
- Do bright stars have **size and a soft halo**, or is everything one pixel?
- Does the field **crawl** when the camera turns? Capture the same view at two
  yaws and check. This is the classic tell.
- Does it **shimmer or alias** at 1600×900 and at 720p? A star that flickers
  between frames reads as a rendering fault, not as twinkling.
- Is there a visible **lattice, grid or banding** anywhere? Squint.
- Does the Milky Way read as a **band of unresolved light**, or as a smear?
- Are there stars where there should not be — over a bright sky, under the
  horizon, through opaque cloud?

### The moon
- Is the terminator an **ellipse**? A straight chord is the cookie-cutter tell
  and it is instantly readable as wrong.
- Is there **earthshine** on the dark limb, so the full disc is just readable?
- Does the halo read as **light**, or as a fogged lens / a hard ring?
- Is the moon **too big**? A moon larger than about 1.5° reads as a fantasy
  moon. Check it against the plates at the same frame width.
- Does the moon's light direction agree with the moon's **position**? A lit
  crescent that disagrees with where the shadows fall is a hard reject.

### Moonlight and night readability
- Can you **navigate**? Can you tell a slope from a flat, a rock from a bush?
- Squint. Are there **three value groups** — near mass, mid, far ridge — or is
  it two, or one?
- Is the ground **cool**? Any warm cast on unlit ground at midnight is a
  reject; the reference is overwhelmingly blue.
- Do **warm accents survive** — a lamp, a headlight, an emissive? Night that
  desaturates globally kills the thing that makes these plates cozy.
- Is there **aerial perspective at night**? `night2.jpg` has full depth
  layering in the dark. Ours historically has none.
- Is the near field a **true black**, or is everything lifted into grey?

### Golden hour, sunrise, sunset
- Is the sun **actually in the frame** and does it read as a source?
- Is there a **blown highlight**? `lumaP95` must approach the plates' 0.93+.
  This is the single number the round is about.
- Does the halo read as **glare**, or as a bloom artefact — a hard ring, a
  visible mip seam, a square, a pumping between frames?
- Is the core **neutral-white** as it approaches the disc? A glow that stays
  orange all the way in does not match either plate.
- Is the **cool half present**? `morning.jpg` is 37% cyan+azure. Check the hue
  histogram. A frame that is 95% red-orange has re-made this project's oldest
  bug regardless of how pretty it looks.
- Is there **magenta** in the distance? Blue above green anywhere in the haze
  is critic pass 3's fourth blocker.
- Do conifers still read **green** and maples **crimson**? If golden hour has
  collapsed four albedo hues into one band, reject.

### Across the arc
- Sweep the hours between the keys. Any hour where the frame **jumps** is a
  defect: `--hours 18,18.6,19,19.4,19.8,20.4,21` and `--hours 4,5,5.6,6.3,7,7.4,8`.
- Does anything work from **only one view**? A sky that is beautiful pitched up
  and broken at eye level is not done.

## Verdict

Per view, one of `SHIP` / `CLOSE` / `REJECT`, then a numbered list of defects
ranked by how much they hurt the frame, each with a number attached where one
exists. Finish with the blind A/B result and whether it agreed with your
measured verdict — when they disagree, say which you trust and why.

# Roasting marshmallows — the critic round

`docs/CRITIC_PROTOCOL.md` is the protocol. This file is the round: what is
under judgement, where the frames live, and the exact loop.

## What is under judgement

Five things, judged separately, because they fail separately:

| # | element | the frames | the question |
|---|---|---|---|
| 1 | **the prop** — stick + marshmallow leaning on the table | `prop-fq`, `prop-side`, `prop-back`, `prop-wide` | does it read as a whittled stick somebody left there, from every side, and can you FIND it in a wide shot? |
| 2 | **the composition** — the first-person frame | `held`, `dusk-held`, `held-enter` | would this be the store-page hero image? |
| 3 | **the marshmallow** — surface, translucency, blisters, char | `ladder-0..5`, `uneven`, `burning` | does raw sugar read as sugar and char read as char, or is it a ramp painted on a pill? |
| 4 | **the fire relationship** — light, contact, heat | `dusk-held`, `burning` | is the marshmallow lit BY this fire, in the same frame as it, at the same value scale? |
| 5 | **the feel** — twirl, arrival, sag, drop | video/step captures | does the verb feel good? A still cannot answer this; capture a step sequence. |

## The loop, per element

1. **Capture** the current round:
   `node tools/roastshot.mjs --dir shots/roast/rN --hour 20.4` (and the default hour).
2. **Read** every frame at full resolution, then the sheet
   (`node tools/sheet.mjs --dir shots/roast/rN --out shots/roast/sheet-rN.png --cols 4 --cell 480`),
   then `reference-art/` again. Every round. Normalising a defect you saw last
   round is the failure mode this step exists to prevent.
3. **Blind A/B against the previous round**:
   ```
   node tools/ab.mjs --a shots/roast/r<N-1> --b shots/roast/rN --out shots/roast/ab-N --stitch
   ```
   Judge every `*-PAIR.png` and write down which side is better **and why, in
   concrete terms**, BEFORE running `node tools/ab.mjs --out shots/roast/ab-N --reveal`.
   A round where the new side does not win on its own merits did not improve
   anything, whatever the author's report says.
4. **Verdict per element**: `SHIP` / `CLOSE` / `REJECT`, with numbered,
   ranked, specific defects. "Improve the marshmallow" is useless.
5. If anything is not `SHIP`, the element's author gets the defect list and the
   round repeats. There is no round budget. The loop ends when the frames win
   blind against the previous round AND every element is `SHIP`.

## Standing rules for this round

- **Dusk is the frame that matters.** Hour 20.4, fire as the only light. A
  marshmallow that reads at noon and goes to mush at dusk is not done.
- **The fire must still own the value range.** If the marshmallow is the
  brightest thing in the dusk frame, that is a REJECT however pretty it is.
  Measure it (`tools/colorstats.mjs`) rather than arguing about it.
- **No UI in an art frame.** `roastshot.mjs` asserts this and prints `!!`.
  Do not work around a shared defect inside your own harness.
- **A still cannot judge motion.** For the twirl, the sag and the drop, capture
  a stepped sequence through `window.__roast.step(dt)` and read it as a strip.
- There are no marshmallow reference plates in `reference-art/`. Judge the
  object against real-world knowledge of what a toasting marshmallow does —
  it swells, it slumps, it blisters, it goes translucent-gold before it goes
  brown, and the char is matte black and cracked, not dark brown — and judge
  the FRAME against plates 3/4/5.

## Amendment — the blind A/B has to be blind, and one reader cannot be

The round-3 critic recorded this against itself, and it is right: the loop above
says *read every frame, then run the blind A/B*. By the time you reach step 3
you have seen both rounds at full resolution and you identify the sides
immediately — that critic called 8 of 8 correctly and said so. What step 3 then
measures is a preference under a hidden key, which is not the same instrument
and is a good deal weaker.

So the comparison is split across **two readers**:

- The **critic** does steps 1, 2, 4 and 5 — look at everything, measure, and
  produce the ranked defect list. It does not run the A/B at all.
- A **blind judge**, a separate reader that has seen neither round, is given
  ONLY the stitched pairs:
  ```
  node tools/ab.mjs --a shots/roast/r<prev> --b shots/roast/r<N> --out shots/roast/ab-<N> --stitch
  ```
  and is told nothing about which round is which, what changed, what is being
  attempted, or even that one side is newer. It answers one question per pair —
  **left or right, and why, in concrete terms** — and it must answer for every
  pair including the ones it thinks are identical.
  Only then does anyone run `node tools/ab.mjs --out shots/roast/ab-<N> --reveal`.

A round is an improvement when the new side wins the blind judge's call on the
frames the round was for — `held-clean`, `dusk-held-clean`, `mallow-backlit`,
`prop-wide` — and not when its author says it is. A round that loses one of
those has regressed that frame, whatever else it fixed, and the loss goes at
the top of the next defect list.

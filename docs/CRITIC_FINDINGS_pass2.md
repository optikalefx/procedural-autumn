# Critic pass — 2026-08-18

`SHIP 0 · CLOSE 3 (meadow, dawn, forest) · REJECT 7`

Blind A/B of round 005 vs 007 picked 007 on **10/10 views** (verdicts recorded
before reveal), so the direction is right — but three regressions came with it:
a floating boulder field, `river` losing ~0.1 luma, and `waterfall` trading
bloom artifacts for crushed blacks.

## The two global findings that explain most of the ten views

**1. Shadowed surfaces clamp to a single flat hueless value `#39342F`.**
Measured: 44.0% of the `waterfall` frame and 11.8% of `backlit` are *exactly*
that hex. Point samples on completely different objects in different views all
return `srgb(57,52,48)` — rock, cliff, bush, understory, terrain. Zero normal
response, zero hue, zero form; a zoom shows the shaded rock as a filled polygon
with a hard aliased edge. This is not crushed blacks — a crush still varies.

Reference: darkest sample in plate 1 is `srgb(76,64,48)` (warm), shaded foliage
in plate 3 is `srgb(56,66,32)` (olive), and the big cast shadow on grass there is
a **high-value violet-blue mass**. Nowhere does a plate put 44% of a frame on one
neutral.

**2. The blue channel is driven to ~0 across the dominant colour masses.**
The two largest colour clusters in `backlit` are `#B05000` and `#C85504` —
both with B ≤ 4/255. Reference meadow averages `srgb(91.1%, 62.1%, 32.7%)`
(ratio 1 : 0.68 : 0.36); ours is `srgb(62.2%, 30.0%, 10.3%)` (1 : 0.48 : 0.17).

Consequence: **0.0% yellow and 0.0% green in all ten views**, against the
reference's ~7.9% yellow-family, and red at 56–80% of chromatic pixels against
37–52%. The `PALETTE` anchor `#f0ad46` is not reaching the screen — we render
`#cb6200`. Everything previously described as "muddy", "beige" or "monochrome
orange" is downstream of this.

**Fix 1 and 2 before touching any per-system asset**, or every author spends
their round compensating for a grade bug inside their own material. The proof is
the midday sweep: the *same* geometry, assets and scatter read dramatically
better at hour 12, where the ambient floor behaves.

## Other ship-blockers

3. **Bare untextured ground substrate at every range** (groundcover + terrain) —
   65% of the 2 m road close-up and 40% of `vehicle` are smooth clay slabs, with
   grass terminating on hard straight mask edges.
4. **No cast shadows at golden hour** (look+grade) — the vehicle casts none at
   hour 17.0 but does at 7.4 and 18.6, so it is outside the caster set or the
   cascade at the shipping hour. Plate 1 gets its entire sense of form from long
   soft shadows crossing a third of the frame. This is the biggest reason our
   meadows read flat despite correct chroma.
5. **Floating, uniform, cuboid boulder field** (rocks) — regression in 007.
6. **Mountain bodies have no structure** (terrain) + vertical texture smear on
   steep faces (a triplanar / stretched-UV failure).
7. **Water is off-palette, flat, and outside the lighting** — grey `#8a99a3`
   against the `#9dc4d8`→`#2f5f86` spec, no depth ramp, no foam, no reflection
   anywhere, and it ignores sun colour entirely (stays blue at dawn 7.4 while the
   world goes sepia).
8. **Foliage silhouettes are per-pixel dissolve noise** rather than brush marks —
   the canopy edge resolves to thousands of single-pixel islands. Possibly new
   from the stylised-diffuse adoption.
9. **Waterfall is broken** — a detached floating X of crossed quads with no
   source, a flat streaked sheet with no spray or plunge foam, two bloom orbs.

## Polish (10–19)

Leaf particles wrong in colour/scale/form (white in `river`, **green** in
`vehicle`); tree repetition and uniform scatter; uniform non-organic grass blade
form; grade fails outside golden hour (violet skies at dusk, sepia veil at dawn);
hard straight object/terrain intersections with no skirt, plus z-fighting;
scrub reads as a pile of almonds; ~25 identical bird glyphs read as flies on the
lens; birch trunks muddy tan instead of the near-white `#e9e6dd` signature;
triangle budget breached in 4 of 6 measurements (up to 6.37 M against a 4.5 M
cap) with 36–42 fps in heavy views; no near-field framing element in the vistas,
so there is no depth ladder.

## Two things that are genuinely good — do not trade them away

The `dawn` sky and haze, and the camper asset itself.

## Harness defects the critic hit

- The pruner deleted the critic's evidence directory mid-review. Fixed:
  `shots/critic`, `shots/perf` and `shots/_scratch` are now protected, and
  nothing modified in the last two hours is pruned.
- `shot.mjs --all` aborted partway in 2 of 5 runs.
- The `forest` anchor puts the camera in a lake, so the forest system is never
  actually judged.
- **Motion cannot be verified at all**: two captures both start from page load at
  the same elapsed time, so wind and water phase are identical every run. The
  protocol's motion check has no working path through this harness.

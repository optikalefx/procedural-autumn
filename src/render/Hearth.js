// ─────────────────────────────────────────────────────────────────────────────
//  Hearth — where the fire is, and how much of the night it is allowed to own.
//
//  ── why the grade has to know about a camp fire at all ──────────────────────
//
//  The night grade ends in a scotopic shift (see the rod block in PostFX): warm
//  pixels below a highlight knee are rotated toward a blue-violet axis, because
//  that is what dark-adapted vision does to a khaki meadow and it is what the
//  night plates show. It is the right operator for the ninety-nine percent of a
//  night frame that is moonlit ground, and it is exactly wrong for the one
//  percent that is a camp fire's pool, which came out lavender — the fire's own
//  flame kept its ember, and everything the fire LIT went violet.
//
//  That defect has a long paper trail in this codebase. camp_fire.js's light
//  block reads as a note about falloff, but read it again and it is really a
//  note about this: three separate sweeps found that any intensity which
//  actually lit the tent "put the whole clearing in pale lavender out to six
//  metres", so the fire was held at an intensity that lit almost nothing rather
//  than one that lit the camp the wrong colour. The falloff was tightened, the
//  distance was cut, and the warmth was handed to the emissive flame and ember
//  bed, which cannot light a chair. The fire was quietly turned down to hide a
//  grading bug.
//
//  The rod block already has the right idea and a knee that cannot reach it:
//  "above uRodKnee a pixel is a real light source — a campfire, a headlight
//  pool, a lit window — bright enough for cones, and it keeps its own colour".
//  That gate is a per-pixel BRIGHTNESS test, and it works for the camper's
//  headlights, which are a floodlight. A camp fire is not bright enough to pass
//  it and never will be; its pool sits an order of magnitude under the knee.
//
//  So the gate this needs is spatial rather than photometric, and the physical
//  story is the same one the rod block is built on. Purkinje is about the state
//  of the eye, not the value of a pixel: somebody sitting inside a fire's light
//  is not dark-adapted at all. Their cones are working, the fire is orange to
//  them, and it is the trees BEYOND the firelight that go blue. Publishing the
//  fire's position lets the grade draw that line where it actually falls.
//
//  ── the shape of it ─────────────────────────────────────────────────────────
//
//  One hearth, not a list. Camp.js already carries exactly one PointLight to
//  whichever fire is nearest — a second light relinks every lit material in the
//  valley — and the grade's mask has the same argument available to it: two
//  camps stand at least ten metres apart, a fire's warmth reaches about five,
//  and the second-nearest fire could not have reached the viewer anyway.
//
//  `strength` is not a separate knob to tune. It rides on the fire's own
//  intensity, which is already driven by the time of day, the build-in and the
//  flicker — so the mask fades up as the camp is pitched, dies with the fire,
//  and is zero all day without anything having to remember to switch it off.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live record, read once per frame by PostFX.
 *
 * `radius` is the metre distance at which the fire has stopped mattering to the
 * grade, not the point light's own cutoff — the two are related but not equal,
 * because the pool of light a fire throws is smaller than the region a person
 * sitting at it would describe as "by the fire".
 */
export const HEARTH = { x: 0, y: 0, z: 0, radius: 0, strength: 0 };

/**
 * Publish the fire the grade should protect.
 *
 * Call every frame while a fire is lit; call `clearHearth()` when there is not
 * one. Nothing here allocates, so the per-frame call is free.
 */
export function setHearth(x, y, z, radius, strength) {
  HEARTH.x = x; HEARTH.y = y; HEARTH.z = z;
  HEARTH.radius = radius;
  HEARTH.strength = strength;
}

export function clearHearth() {
  HEARTH.radius = 0;
  HEARTH.strength = 0;
}

"""Build the game's duck .blend from the bought pack, and SAVE it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_duck_blend.py

Writes `assets/models/duck_pack.blend`: the pack's duck, isolated, turned to
face +Y, with the two clips the game drives renamed to its slots.

Same two-stage split as the flamingo, the raccoon and the bear — this is the
slow half and runs when the animal changes; `export_pack_glb.py` reads what it
writes. **The 108 MB pack is never written to.** It is licensed third-party
source kept out of the repo, so it stays exactly as downloaded.

## Why this one has no gait solver either

The flamingo's file says it: `tree_birds.js` owns its birds' positions in both
of their states, so nothing ever asks the rig how fast its own feet move. The
duck is the same deal with one word changed — it floats instead of standing,
and it paddles instead of flying — and its feet are under the water where
nothing could measure them anyway. There is no `measureGround` in the playback
path and nothing here to solve.

## What the pack ships and what the game takes

    Duck_Swim_Idle  51f  -> idle    floating still, an exact loop
    Duck_Swim       51f  -> move    trimmed to ONE 25-frame paddle cycle
    Duck_Idle       71f          dropped: standing, and this duck never stands
    Duck_Walk       35f          dropped
    Duck_Run        17f          dropped
    Duck_Gesture    71f          dropped: see below

**There is no `Duck_Fly` in the pack.** Flamingo, Swan and Pigeon all ship one;
the duck does not. That is a finding about the asset and not something to work
around here — a flying duck needs a wingbeat authored onto this rig, or the
swan's retargeted onto it (`tools/retarget_fox_from_pack.py` is the worked
example). Until one exists the duck travels the way the user asked for it,
which is the way the asset can honestly carry: it paddles.

**`Duck_Gesture` is dropped, and it is the one loss worth naming.** The
flamingo's `Gesture` became `preen` and earns its place — six birds frozen in
one identical idle is a poor thing to have travelled to. The duck's is authored
STANDING: its lowest body vertex sits +0.091 above the origin where the swim
clips put the keel at -0.097. Blending it onto a floating duck would lift the
bird 0.19 spans out of the water, which is 0.35 m of daylight under a duck at
the size this game draws one. A pose clip has to be authored in the pose it
blends onto, and this one is not, so `tree_birds.js` makes `preen` optional and
the duck simply has two clips.

## Measured off this asset, and used by the species table

Every number below is printed by this script and none can be recovered
downstream:

* **span** is the bill-to-tail LENGTH of the floating body, not a wingspan.
  This model has no measurable wingspan at all: 0.25 m folded, and no clip in
  the pack ever opens the wings — the widest frame of all six is 0.289 m
  against a body 0.62 m long. So the duck's row states `length` where the
  flamingo's states `wingspan`, and `birdSize` in `tree_birds.js` reads
  whichever is there. Fitting this bird by span would have drawn it 6x too big.

* **the waterline is the model's own origin.** The swim clips straddle z=0 —
  keel below it, back above — where every standing clip in the pack sits its
  feet on it. So a floating duck's y IS the water surface and the fit node has
  no lift to apply (`minY: 0`). That is the swimmer's version of the rule the
  flamingo taught: state it about the ANATOMY, and let each pose say where that
  anatomy is relative to the origin. `draftY` is the number, in span units, and
  the duck's `draft` — how much water it needs under it — is derived from it
  rather than guessed.

* **the photo silhouette is measured ABOVE the waterline only.** `hunt_detect`
  reads `unitR`/`unitC` as half a bird's height and where that height's middle
  sits over the object's origin. For a duck the submerged third is not in the
  photograph, so including it would claim a bird a third taller than the one on
  the water.

## The three traps this pack sets

All three are `open_animal`'s and all three are live on the duck: every
armature ships in REST position, `Duck_Swim`'s NLA track ships SOLOED, and an
action does nothing until its slot is bound. See `pack_rig_kit.py`.
"""

import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, play, purge, frame_view,
)

RIG = "Skeleton_Duck"
MESH = ["Duck_01"]
HEAD = "scull"

# The pack authors at 24 fps — the same rate `build_flamingo_blend.py` derives
# its 1.2 Hz wingbeat from (20 frames).
FPS = 24.0

# The pack's names on the left, the game's slots on the right. `tree_birds.js`
# reads these two off the GLB and nothing else. `preen` is absent on purpose;
# see the header.
RENAME = {
    "Duck_Swim_Idle": "idle",
    "Duck_Swim": "move",
}

# One paddle cycle. Frames 1..51 of the pack's swim clip are two bit-identical
# repeats of a 25-frame cycle: the pose at frame 26 differs from frame 1 by 0.0
# across every vertex, so this trim is lossless and not a judgement. Frame 26
# is kept as the closing duplicate that lets the mixer wrap without a hitch —
# the same closing sample `export_fox_glb.py` checks for.
MOVE_CYCLE = (1, 26)

# Legs, so the body can be found without them. A floating duck's draft and its
# bill-to-tail length are both properties of the BODY: the feet paddle a long
# way behind and below it and would inflate every one of these numbers.
LEG = {"thigh.L", "thigh.R", "shin.L", "shin.R",
       "foot.L", "foot.R", "toe.L", "toe.R"}


def measure(rig, mesh_name):
    """Every number the species table needs, off the evaluated mesh.

    `matrix_basis` is the input channel, not the result — see the import-animal
    skill — so all of this is read from the deformed mesh on every frame of the
    clip it belongs to, which is what the player actually sees.
    """
    scn = bpy.context.scene
    ob = bpy.data.objects[mesh_name]

    def points(frame):
        scn.frame_set(frame)
        bpy.context.view_layer.update()
        ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get())
        me = ev.to_mesh()
        pts = [(ev.matrix_world @ v.co).copy() for v in me.vertices]
        ev.to_mesh_clear()
        return pts

    def frames(name):
        a = play(rig, name)
        return [(f, points(f)) for f
                in range(int(a.frame_start), int(a.frame_end) + 1)]

    gi = {g.index: g.name for g in ob.vertex_groups}
    body_idx = [i for i, v in enumerate(ob.data.vertices)
                if v.groups
                and gi[max(v.groups, key=lambda g: g.weight).group] not in LEG]

    # Both float clips together: the pose a duck is in is one or the other and
    # the silhouette has to cover both.
    float_frames = frames("idle") + frames("move")
    body = [[ps[i] for i in body_idx] for _, ps in float_frames]
    flat = [p for ps in body for p in ps]

    span = max(p.y for p in flat) - min(p.y for p in flat)   # bill to tail
    keel = min(p.z for p in flat)                            # under the waterline
    back = max(p.z for p in flat)
    wing = max(max(p.x for p in ps) - min(p.x for p in ps) for _, ps in float_frames)

    # The photo silhouette, above the waterline only — see the header. Centre on
    # the mid of the dry body's Z range, then take the radius that reaches every
    # dry vertex of both clips.
    dry = [p for p in flat if p.z >= 0.0]
    cz = (0.0 + back) * 0.5
    centre = Vector((0.0, 0.0, cz))
    r_dry = max((p - centre).length for p in dry)

    return {"span": span, "keel": keel, "back": back, "wing": wing,
            "centre": cz, "r": r_dry, "dry_n": len(dry), "wet_n": len(flat) - len(dry)}


def main():
    rig = open_animal(RIG, MESH, "Duck_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in RENAME:
            act.name = RENAME[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    # Trim the travel clip to one paddle cycle. Set the manual range rather
    # than deleting keys: the export reads `use_frame_range` and the file stays
    # scrubbable over both cycles if anyone wants to check the trim.
    move = bpy.data.actions["move"]
    move.frame_start, move.frame_end = MOVE_CYCLE

    m = measure(rig, MESH[0])
    span, keel, back = m["span"], m["keel"], m["back"]
    cycle = MOVE_CYCLE[1] - MOVE_CYCLE[0]
    hz = FPS / cycle
    print(f"[build] duck body {span:.4f} m bill to tail; keel {keel:+.4f} m, "
          f"back {back:+.4f} m about the waterline; widest folded wing "
          f"{m['wing']:.4f} m ({m['wing'] / span:.2f} of the length — there is "
          f"no wingspan on this model)")
    print(f"[build] {m['dry_n']} body vertices above the waterline, "
          f"{m['wet_n']} below: the duck floats {keel / (back - keel) * -100:.0f}% "
          f"submerged")
    # The five the species table takes verbatim. Printed as the `glb` block so
    # the copy across is mechanical and cannot be mistranscribed.
    print(f"[build] glb: span: {span:.3f}, minY: 0, "
          f"draftY: {-keel / span:.3f}, cycleHz: {hz:.2f}, "
          f"unitC: {m['centre'] / span:.3f}, unitR: {m['r'] / span:.3f}")
    print(f"[build] a duck drawn {span * 3:.2f} m long draws "
          f"{-keel * 3:.3f} m of water")

    assert abs(keel) > 0.02, (
        f"the swim pose does not sit in the water (keel {keel:+.4f}); this is "
        f"the standing pose and the waterline rule does not hold")
    assert back > 0, f"the whole duck is under the waterline (back {back:+.4f})"
    assert m["wing"] < span * 0.6, (
        f"the wings open to {m['wing']:.3f} m — measure a span and fit by it")

    # Lay every clip out as a soloable NLA track, the way the pack lays itself
    # out, so the saved file is consistent with the source and can be scrubbed.
    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        track = rig.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_start), act)
        track.is_solo = False

    # Opens framed on the duck with the paddle cycle soloed — the clip this
    # file exists to let you judge.
    frame_view(rig, MESH, clip="move", clip_range=MOVE_CYCLE)

    mats, imgs = purge(MESH)
    print(f"[build] kept materials {mats} and images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "duck_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips: "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()

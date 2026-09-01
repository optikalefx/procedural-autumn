"""Build the game's flamingo .blend from the bought pack, and SAVE it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_flamingo_blend.py

Writes `assets/models/flamingo_pack.blend`: the pack's flamingo, isolated,
turned to face +Y, with the three clips the game drives renamed to its slots.

The same two-stage split as the raccoon and the bear — this is the slow half and
runs when the animal changes; `export_pack_glb.py` reads what it writes.
**The 108 MB pack is never written to.** It is licensed third-party source kept
out of the repo, so it stays exactly as downloaded.

## Why this one has no gait solver

Every other pack animal in here needed `build_gait`, because a mammal's speed is
derived from the ground its paws cover and the pack's locomotion could not carry
it. A flamingo in this valley has no locomotion to derive: `tree_birds.js` gives
its birds exactly two states — standing on a perch or in the shallows, and
flying between them — and owns the position itself in both. Nothing ever asks
this rig how fast its own feet move, so there is nothing here to solve and no
`measureGround` in the playback path either.

That is why the flamingo is the cheapest pack import so far: isolate, face,
rename, trim one clip to a single wingbeat, save.

## What the pack ships and what the game takes

    Flamingo_Idle     61f  -> idle     standing, feet on z=0, an exact loop
    Flamingo_Fly      81f  -> fly      trimmed to ONE 20-frame wingbeat
    Flamingo_Gesture 121f  -> preen    head down along the flank and back up
    Flamingo_Walk     31f             dropped: nothing walks
    Flamingo_Run      15f             dropped: nothing runs

`Gesture` becoming `preen` is the one remapping, and it earns its place rather
than padding the file. `tree_birds.js` argues that a flamingo colony "is the
payoff at the end of a boat trip" and holds the birds a full five seconds after
you crowd them so the payoff does not evaporate on arrival. Six birds frozen in
one identical idle is a poor thing to have travelled to; the same six with the
occasional bird working its bill down a flank is a colony.

## Measured off this asset, and used by the species table

Both numbers are printed by this script and neither can be recovered downstream:

* **span 2.128 m** at the widest frame of the wingbeat. It is the ONLY honest
  wingspan the model has — the rest pose folds the wings to 0.598 m, and a
  scale fitted to that would put a 4.35 m "wingspan" on a bird 3.6x too big.
  This is exactly the case `BIRD_GLB_CONTRACT.md` refuses a model for, and the
  refusal is right for a model authored wings-out; the pack's is not, so the
  span is measured from the fly clip instead of the bind pose.
* **height 1.607 m** standing. Span:height is 1.32 here against the procedural
  bird's 1.61, so at a matched wingspan this flamingo stands visibly taller.
  A real American flamingo is 1.25, so the pack is the more honest of the two
  and `tree_birds.js` takes the height down rather than the span (see the
  wingspan note there).

## The three traps this pack sets, all live on the flamingo

1. **The armature ships in REST position.** Every clip evaluates to the bind
   pose and looks broken. `open_animal` sets `pose_position = 'POSE'`.
2. **`Flamingo_Idle`'s NLA track ships SOLOED.** Whatever you assign, the idle
   is what plays. `open_animal` strips the tracks entirely.
3. **An action does nothing until its SLOT is bound** (Blender 4.4+). Assigning
   `animation_data.action` alone evaluates to nothing, and the symptom is a clip
   whose every frame measures identical — which reads as a dead clip, not as a
   missing binding. `pack_rig_kit.play` binds both; this file measures through
   it for exactly that reason.
"""

import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, play, purge, frame_view,
)

RIG = "Skeleton_Flamingo"
MESH = ["Flamingo_01"]
HEAD = "scull"

# The pack's names on the left, the game's slots on the right. `tree_birds.js`
# reads these three off the GLB and nothing else.
RENAME = {
    "Flamingo_Idle": "idle",
    "Flamingo_Fly": "fly",
    "Flamingo_Gesture": "preen",
}

# One wingbeat. Frames 1..81 of the pack's fly clip are four bit-identical
# repeats of a 20-frame cycle: the pose at frame 21 differs from frame 1 by
# 0.0 across every bone matrix, so this trim is lossless and not a judgement.
# Frame 21 is kept as the closing duplicate that lets the mixer wrap without a
# hitch — the same closing sample `export_fox_glb.py` checks for.
FLY_CYCLE = (1, 21)


def measure(rig, mesh_name):
    """Every number the species table needs, off the evaluated mesh.

    `matrix_basis` is the input channel, not the result — see the import-animal
    skill — so all of this is read from the deformed mesh on every frame of the
    clip it belongs to, which is what the player actually sees.

    The photo sphere is the fiddly one. `hunt_detect` sizes a bird's silhouette
    from a sphere in unit space, where span is 1.0 and scale IS wingspan, and it
    centres that sphere on the bird's own origin. That works for the lofted
    birds because their origin sits in the body: the procedural flamingo's
    sphere is r=0.488 centred 0.014 off its origin. This model's origin is
    between the SOLES, so a radius about it would have to span the whole bird
    and would read 60% too generous. So the centre height comes back too, and
    `tree_birds` hands both to the detector.
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
        out = []
        for f in range(int(a.frame_start), int(a.frame_end) + 1):
            out.append((f, points(f)))
        return out

    # Which vertices are LEG, so the belly can be found. A wader's standing
    # height is set by `_wadeY`'s promise to keep the body out of the water, and
    # the body is the part that is not leg.
    gi = {g.index: g.name for g in ob.vertex_groups}
    LEG = {"thigh.L", "thigh.R", "shin.L", "shin.R",
           "foot.L", "foot.R", "toe.L", "toe.R"}
    body_idx = [i for i, v in enumerate(ob.data.vertices)
                if v.groups and gi[max(v.groups, key=lambda g: g.weight).group] not in LEG]

    stand = frames("idle")
    flat = [p for _, ps in stand for p in ps]
    foot_z, top_z = min(p.z for p in flat), max(p.z for p in flat)
    belly_z = min(ps[i].z for _, ps in stand for i in body_idx)
    # The standing bounding box's centre, which is where a photographed
    # flamingo's mass actually is: this species is a wading colony, so the pose
    # the detector meets is overwhelmingly this one.
    cz = (foot_z + top_z) / 2
    centre = Vector((0.0, 0.0, cz))

    span, at, r_fly = 0.0, 0, 0.0
    for f, ps in frames("fly"):
        w = max(p.x for p in ps) - min(p.x for p in ps)
        if w > span:
            span, at = w, f
        r_fly = max(r_fly, max((p - centre).length for p in ps))
    r_stand = max((p - centre).length for p in flat)

    return {
        "span": span, "at": at, "height": top_z - foot_z, "foot_z": foot_z,
        "centre": cz, "r_fly": r_fly, "r_stand": r_stand, "belly": belly_z,
    }


def main():
    rig = open_animal(RIG, MESH, "Flamingo_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in RENAME:
            act.name = RENAME[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    # Trim the fly clip to one wingbeat. Set the manual range rather than
    # deleting keys: the export reads `use_frame_range` and the file stays
    # scrubbable over the full four cycles if anyone wants to check the trim.
    fly = bpy.data.actions["fly"]
    fly.frame_start, fly.frame_end = FLY_CYCLE

    m = measure(rig, MESH[0])
    span, height, foot_z = m["span"], m["height"], m["foot_z"]
    print(f"[build] flamingo span {span:.4f} m at fly frame {m['at']}; "
          f"standing height {height:.4f} m; feet at z {foot_z:+.4f}; "
          f"span:height {span / height:.3f}")
    # The four the species table takes verbatim. Printed as the `glb` block so
    # the copy across is mechanical and cannot be mistranscribed.
    print(f"[build] glb: span: {span:.3f}, minY: {foot_z:.3f}, "
          f"bellyY: {m['belly'] / span:.3f}, "
          f"unitC: {m['centre'] / span:.3f}, unitR: {m['r_fly'] / span:.3f}"
          f"   (standing radius {m['r_stand'] / span:.3f} for reference)")
    print(f"[build] belly {m['belly']:.4f} m above the soles = "
          f"{m['belly'] / m['height'] * 100:.0f}% of standing height")
    assert span > 2.0, f"fly clip never spreads the wings (span {span:.3f})"
    assert abs(foot_z) < 0.01, f"idle feet are not on z=0 ({foot_z:+.4f})"

    # Lay every clip out as a soloable NLA track, the way the pack lays itself
    # out, so the saved file is consistent with the source and can be scrubbed.
    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        track = rig.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_start), act)
        track.is_solo = False

    # Opens framed on the bird with the wingbeat soloed — the clip this file
    # exists to let you judge.
    frame_view(rig, MESH, clip="fly", clip_range=FLY_CYCLE)

    mats, imgs = purge(MESH)
    print(f"[build] kept materials {mats} and images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "flamingo_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips: "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()

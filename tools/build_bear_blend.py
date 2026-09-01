"""Build the game's bear .blend from the bought pack, and save it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_bear_blend.py

Writes `assets/models/bear_pack.blend`. Third animal on this path; read
`pack_rig_kit.py` and the `add-new-animation-to-glb` skill first.

## Two variants, free

`Bear_01` and `Bear_02` are both already parented to `Skeleton_Bear` — the pack
did the work the deer needed re-parenting for — so `hide` picks between them
with no rig surgery at all.

`Bear_Cub_01` is excluded for the reason the fawn was: its skeleton is a
different animal, 32 bones against 40 and 0.423 of the total length, and the
names do not even match. A cub needs its own build.

## What the pack gives, and what is built over it

    Bear_Idle     301f  -> idle    kept
    Bear_Gesture  115f  -> alert   kept, and it is a genuinely good fit: the
                                   bear REARS, muzzle 0.516 -> 2.203 with the
                                   fore paws lifting to 0.613. Standing up to
                                   look is what a bear's alarm actually is, so
                                   this is better than a solved stiff-and-stare.
    Bear_Walk      31f  -> DROPPED, and it hurt: duty 0.61/0.61/0.64/0.61, the
                                   best-planted walk in the whole pack.
    Bear_Run       19f  -> DROPPED, duty 0.42/0.36/0.33/0.08.

The walk goes because `measure: 'contact'` is a claim about EVERY moving clip.
One inherited gait beside two solved ones forces the species back onto
excursion, which divides a paw's swing by the CYCLE when the paw covers that
ground during its STANCE — underreporting every gait by its duty factor. Losing
a good walk to keep the measurement honest is the trade, and it is the same one
the raccoon made.

## The graze is phased, and that is not decoration

`bear.js` declares `grazeIn` and `grazeOut`, which is what turns `GlbRig`'s
sequencer on. The Brain holds a graze for a variable 10-26 s, so a single
looping clip would raise the head every time it repeated. `build_phased_graze`
authors the three so they meet pose-exactly and `graze_out` ends on the rest
pose, which the sequencer parks on as its idle carrier.
"""

import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, clear, purge, frame_view, gait_rest, build_gait,
    build_phased_graze, LATERAL_WALK, DIAGONAL_TROT, BOUND,
)

RIG = "Skeleton_Bear"
MESHES = ["Bear_01", "Bear_02"]
HEAD = "scull"

KEEP = {"Bear_Idle": "idle", "Bear_Gesture": "alert"}

# The fore legs hang off `spine.004` and the hind off `spine.002`, so the neck
# may start at `spine.005` and the graze's chest pitch must stop at `spine.004`
# or lower. Surveyed, not assumed — this differs per animal in the same pack.
LEGS = {
    ("hind", "L"): dict(scap="shoulder.L", a="thigh.L", b="shin.L",
                        target="foot.L", below=["foot.L", "toe.L"], contact="toe.L"),
    ("hind", "R"): dict(scap="shoulder.R", a="thigh.R", b="shin.R",
                        target="foot.R", below=["foot.R", "toe.R"], contact="toe.R"),
    ("fore", "L"): dict(scap="front_shoulder.L", a="front_thigh.L", b="front_shin.L",
                        target="front_foot.L", below=["front_foot.L", "front_toe.L"],
                        contact="front_toe.L"),
    ("fore", "R"): dict(scap="front_shoulder.R", a="front_thigh.R", b="front_shin.R",
                        target="front_foot.R", below=["front_foot.R", "front_toe.R"],
                        contact="front_toe.R"),
}

# A bear's walk is a heavy roll at the bottom of the 1.0-1.8 Hz band; its run is
# a lumbering bound. Duty is what separates them, not rate.
# Cadence and crouch are set against the SHIPPED size, not the model's. The
# bear ships at height 1.18 to stand where the animal it replaces stood, so the
# fit is 0.755 and every solved speed is multiplied by it. A first pass tuned to
# the model's own units looked right in the build log and landed 25% low in the
# game. Tune against the number the game prints.
WALK = dict(frames=16, duty=0.64, lift=0.075, bob=0.012, crouch=0.075,
            scapula=12.0, phase=LATERAL_WALK)
TROT = dict(frames=11, duty=0.48, lift=0.110, bob=0.018, crouch=0.100,
            scapula=15.0, phase=DIAGONAL_TROT)
RUN = dict(frames=9, duty=0.26, lift=0.180, bob=0.026, crouch=0.130,
           scapula=19.0, phase=BOUND)

GRAZE = dict(
    chest=[("spine.003", 0.35), ("spine.004", 0.65)],
    neck=["spine.005", "spine.006", "scull"],
    tip="scull",
    chest_max=52.0,
    # A bear forages nose-down close in front of its own forefeet. z is not 0:
    # a muzzle driven to the soil reads as a nose buried in it.
    target=(0.0, -0.55, 0.16),
    in_frames=36, hold_frames=96, out_frames=36,
    crop=0.030, glance=0.10,
)


def main():
    rig = open_animal(RIG, MESHES, "Bear_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in KEEP:
            act.name = KEEP[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    bb = [bpy.data.objects[MESHES[0]].matrix_world @ Vector(c)
          for c in bpy.data.objects[MESHES[0]].bound_box]
    print(f"[build] bear {max(p.z for p in bb) - min(p.z for p in bb):.3f} units tall, "
          f"{max(p.y for p in bb) - min(p.y for p in bb):.3f} long")

    rest = gait_rest(rig, LEGS)
    for name, spec in (("walk", WALK), ("trot", TROT), ("run", RUN)):
        build_gait(rig, LEGS, rest, name, spec)
    build_phased_graze(rig, LEGS, rest, GRAZE)

    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        t = rig.animation_data.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, int(act.frame_start), act)
        t.is_solo = False

    trot = bpy.data.actions["trot"]
    frame_view(rig, [MESHES[0]], clip="trot",
               clip_range=(int(trot.frame_start), int(trot.frame_end)))
    mats, imgs = purge(MESHES)
    print(f"[build] kept materials {mats} images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "bear_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()
